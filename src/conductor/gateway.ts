import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AuthStorage,
  type ExtensionUIContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  createProductionHost,
  type Host,
  type HostFactoryContext,
  type ResumeRunOptions,
  type RunHandle,
  resumeRun,
  type StartRunOptions,
  startRun,
} from "pi-conductor";
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
  readonly conductorManifest: string;
  readonly modelRegistry?: ModelRegistry;
  /** Test seam for exercising the real pi-conductor API without a model key. */
  readonly hostFactory?: PiConductorHostFactory;
}

export type PiConductorHostFactory = (
  context: HostFactoryContext,
  worktree: string,
  ui: RunnerUiContext,
) => Host;

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
  private readonly conductorManifest: string;
  private readonly modelRegistry: ModelRegistry;
  private readonly api: ConductorApi;
  private readonly hostFactory: PiConductorHostFactory | undefined;

  public constructor(
    options: PiConductorGatewayOptions,
    api: ConductorApi = defaultApi,
  ) {
    if (
      !isAbsolute(options.dataDir) ||
      !isAbsolute(options.agentDir) ||
      !isAbsolute(options.conductorManifest)
    ) {
      throw new ConductorIntegrationError(
        "dataDir, agentDir, and conductorManifest must be absolute paths",
      );
    }
    this.dataDir = resolve(options.dataDir);
    this.agentDir = resolve(options.agentDir);
    this.conductorManifest = resolve(options.conductorManifest);
    this.modelRegistry =
      options.modelRegistry ??
      ModelRegistry.create(
        AuthStorage.create(join(this.agentDir, "auth.json")),
        join(this.agentDir, "models.json"),
      );
    this.api = api;
    this.hostFactory = options.hostFactory;
  }

  public async start(
    job: Job,
    goal: string,
    ui: RunnerUiContext,
  ): Promise<RunHandle> {
    const context = await this.contextFor(job);
    const runsDir = this.runsDir(job);
    const options: StartRunOptions = {
      goal,
      baseDir: runsDir,
      modelRegistry: this.modelRegistry,
      hostFactory: (factoryContext) =>
        this.createHost(factoryContext, context.worktree, runsDir, ui),
    };
    return this.api.startRun(context.manifestPath, options);
  }

  public async resume(job: Job, ui: RunnerUiContext): Promise<RunHandle> {
    if (job.conductorRunId === null || job.conductorRunId.trim() === "") {
      throw new ConductorIntegrationError("job has no conductor run ID");
    }
    const context = await this.contextFor(job);
    const runsDir = this.runsDir(job);
    const options: ResumeRunOptions = {
      // resumeRun restores the original goal from the durable conductor log.
      goal: "",
      baseDir: runsDir,
      modelRegistry: this.modelRegistry,
      hostFactory: (factoryContext) =>
        this.createHost(factoryContext, context.worktree, runsDir, ui),
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
    let manifestPath: string;
    try {
      manifestPath = await realpath(this.conductorManifest);
    } catch (error) {
      throw new ConductorIntegrationError(
        `configured conductor manifest is unavailable: ${String(error)}`,
      );
    }
    return { worktree: realWorktree, manifestPath };
  }

  private runsDir(job: Job): string {
    return join(this.dataDir, "conductor-runs", String(job.projectId));
  }

  private createHost(
    context: HostFactoryContext,
    worktree: string,
    runsDir: string,
    ui: RunnerUiContext,
  ): Host {
    if (this.hostFactory !== undefined) {
      return this.hostFactory(context, worktree, ui);
    }
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
        sessionDir: join(runsDir, context.runId, "sessions"),
      },
    });
  }
}
