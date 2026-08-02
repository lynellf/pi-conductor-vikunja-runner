import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AuthStorage,
  type ExtensionUIContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  createProductionHost,
  type HostFactoryContext,
  type ResumeRunOptions,
  type RunHandle,
  resumeRun,
  type StartRunOptions,
  startRun,
} from "pi-conductor";
import type { ProjectConfig } from "../config/config.js";
import type { Job } from "../domain/jobs.js";

/** The UI bridge supplied by the Vikunja interaction adapter. */
export type RunnerUiContext = ExtensionUIContext;

/** Stable control surface exposed to the runner orchestration layer. */
export type ConductorHandle = Pick<
  RunHandle,
  | "runId"
  | "completion"
  | "abort"
  | "steer"
  | "followUp"
  | "latestResponse"
  | "runStats"
>;

export interface ConductorGateway {
  start(job: Job, goal: string, ui: RunnerUiContext): Promise<ConductorHandle>;
  resume(job: Job, ui: RunnerUiContext): Promise<ConductorHandle>;
}

export interface ConductorApi {
  readonly startRun: typeof startRun;
  readonly resumeRun: typeof resumeRun;
}

export interface PiConductorGatewayOptions {
  readonly dataDir: string;
  readonly agentDir: string;
  readonly projects: Readonly<Record<string, ProjectConfig>>;
  readonly modelRegistry?: ModelRegistry;
}

export class ConductorIntegrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConductorIntegrationError";
  }
}

const defaultApi: ConductorApi = { startRun, resumeRun };

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

/**
 * Production pi-conductor library adapter. The runner owns one shared model
 * registry, while each run gets a worktree cwd and an isolated session log.
 * Spec §10 and acceptance criterion 7.
 */
export class PiConductorGateway implements ConductorGateway {
  private readonly dataDir: string;
  private readonly agentDir: string;
  private readonly projects: Readonly<Record<string, ProjectConfig>>;
  private readonly modelRegistry: ModelRegistry;
  private readonly api: ConductorApi;

  public constructor(
    options: PiConductorGatewayOptions,
    api: ConductorApi = defaultApi,
  ) {
    if (!isAbsolute(options.dataDir) || !isAbsolute(options.agentDir)) {
      throw new ConductorIntegrationError(
        "dataDir and agentDir must be absolute paths",
      );
    }
    this.dataDir = resolve(options.dataDir);
    this.agentDir = resolve(options.agentDir);
    this.projects = options.projects;
    this.modelRegistry =
      options.modelRegistry ??
      ModelRegistry.create(
        AuthStorage.create(join(this.agentDir, "auth.json")),
        join(this.agentDir, "models.json"),
      );
    this.api = api;
  }

  public async start(
    job: Job,
    goal: string,
    ui: RunnerUiContext,
  ): Promise<RunHandle> {
    const context = await this.contextFor(job);
    const options: StartRunOptions = {
      goal,
      baseDir: this.runsDir(),
      modelRegistry: this.modelRegistry,
      hostFactory: (factoryContext) =>
        this.createHost(factoryContext, context.worktree, ui),
    };
    return this.api.startRun(context.manifestPath, options);
  }

  public async resume(job: Job, ui: RunnerUiContext): Promise<RunHandle> {
    if (job.conductorRunId === null || job.conductorRunId.trim() === "") {
      throw new ConductorIntegrationError("job has no conductor run ID");
    }
    const context = await this.contextFor(job);
    const options: ResumeRunOptions = {
      // resumeRun restores the original goal from the durable conductor log.
      goal: "",
      baseDir: this.runsDir(),
      modelRegistry: this.modelRegistry,
      hostFactory: (factoryContext) =>
        this.createHost(factoryContext, context.worktree, ui),
    };
    return this.api.resumeRun(
      context.manifestPath,
      job.conductorRunId,
      options,
    );
  }

  private async contextFor(
    job: Job,
  ): Promise<{ worktree: string; manifestPath: string }> {
    if (job.worktree === null || job.worktree.trim() === "") {
      throw new ConductorIntegrationError("job has no prepared worktree");
    }
    const project = this.projects[String(job.projectId)];
    if (project === undefined) {
      throw new ConductorIntegrationError(
        `project ${job.projectId} is not configured`,
      );
    }
    let dataRoot: string;
    let realWorktree: string;
    try {
      dataRoot = await realpath(this.dataDir);
      realWorktree = await realpath(resolve(job.worktree));
    } catch (error) {
      throw new ConductorIntegrationError(
        `task worktree is not available: ${String(error)}`,
      );
    }
    const taskRoot = join(dataRoot, "jobs", String(job.taskId));
    if (!inside(taskRoot, realWorktree)) {
      throw new ConductorIntegrationError(
        "worktree escapes configured task data directory",
      );
    }
    const manifestPath = resolve(realWorktree, project.conductorManifest);
    if (!inside(realWorktree, manifestPath)) {
      throw new ConductorIntegrationError(
        "conductor manifest escapes the task worktree",
      );
    }
    // A lexical path can still escape through a symlink in the checked-out
    // worktree. Resolve an existing manifest before handing it to pi-conductor;
    // a missing manifest is left for pi-conductor's normal manifest error so
    // lightweight adapters can still validate path composition independently.
    try {
      const realManifest = await realpath(manifestPath);
      if (!inside(realWorktree, realManifest)) {
        throw new ConductorIntegrationError(
          "conductor manifest escapes the task worktree",
        );
      }
      return { worktree: realWorktree, manifestPath: realManifest };
    } catch (error) {
      if (error instanceof ConductorIntegrationError) throw error;
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT") {
        throw new ConductorIntegrationError(
          "conductor manifest could not be inspected",
        );
      }
    }
    return { worktree: realWorktree, manifestPath };
  }

  private runsDir(): string {
    return join(this.dataDir, "conductor-runs");
  }

  private createHost(
    context: HostFactoryContext,
    worktree: string,
    ui: RunnerUiContext,
  ) {
    return createProductionHost({
      extension: {
        modelRegistry: this.modelRegistry,
        cwd: worktree,
        uiContext: ui,
      },
      run: {
        log: context.log,
        loadedManifest: context.loadedManifest,
        runId: context.runId,
        agentDir: this.agentDir,
        sessionDir: join(this.runsDir(), context.runId, "sessions"),
      },
    });
  }
}
