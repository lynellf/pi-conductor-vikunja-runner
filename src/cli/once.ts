import { join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { startAnalyticsBridge } from "../conductor/analytics.js";
import type { ConductorGateway } from "../conductor/gateway.js";
import {
  PiConductorGateway,
  type RunnerUiContext,
} from "../conductor/gateway.js";
import type { RunnerConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { Job, JobStore } from "../domain/jobs.js";
import {
  type RunnerCycleInput,
  type RunnerCycleReport,
  runPollCycle,
} from "../domain/runner.js";
import type { ProjectLayout } from "../domain/types.js";
import { SqliteJobStore } from "../persistence/sqlite.js";
import type { RepositoryManager } from "../repositories/git.js";
import { GitRepositoryManager } from "../repositories/git.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import { VikunjaHttpGateway } from "../vikunja/http.js";
import { createVikunjaQuestionUi } from "../vikunja/interaction-ui.js";
import { runnerLogger } from "./logging.js";
import {
  readProtectedCredential,
  validateConfiguredProjects,
} from "./validate.js";

export interface OnceRuntime {
  readonly store: JobStore;
  readonly gateway: VikunjaGateway;
  readonly repository: RepositoryManager;
  readonly conductor: ConductorGateway;
  readonly close: () => void;
}

export type OnceRuntimeFactory = (
  config: RunnerConfig,
  token: string,
) => Promise<OnceRuntime>;

export interface OnceAnalyticsLifecycle {
  shutdown(): Promise<void>;
}

export interface OnceDependencies {
  readonly loadConfig: (path: string) => Promise<RunnerConfig>;
  readonly readCredential: (path: string, label: string) => Promise<string>;
  readonly createRuntime: OnceRuntimeFactory;
  readonly startOnceAnalytics: (
    config: RunnerConfig,
  ) => Promise<OnceAnalyticsLifecycle>;
  readonly runCycle: (input: RunnerCycleInput) => Promise<RunnerCycleReport>;
}

const noOpUi = (): ExtensionUIContext => {
  // The question adapter replaces the three dialog methods. Other UI methods
  // are deliberately inert in CLI mode; pi-conductor only needs the dialog
  // surface and notifications for this runner integration.
  const ui = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => undefined,
  };
  return ui as unknown as ExtensionUIContext;
};

const createRuntime: OnceRuntimeFactory = async (config, token) => {
  const store = await SqliteJobStore.open(
    join(config.runner.dataDir, "state.sqlite"),
  );
  try {
    const gateway = new VikunjaHttpGateway({
      baseUrl: `${config.vikunja.baseUrl}/api/v1`,
      token,
      requestTimeoutMs: config.vikunja.requestTimeoutSeconds * 1000,
      runnerUserId: config.vikunja.runnerUserId,
    });
    return {
      store,
      gateway,
      repository: new GitRepositoryManager(config.runner.dataDir),
      conductor: new PiConductorGateway({
        dataDir: config.runner.dataDir,
        agentDir: config.runner.agentDir,
        projects: config.projects,
      }),
      close: () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
};

const runCycleDefault: OnceDependencies["runCycle"] = runPollCycle;

const defaultDependencies: OnceDependencies = {
  loadConfig,
  readCredential: readProtectedCredential,
  createRuntime,
  startOnceAnalytics: async (config) =>
    startAnalyticsBridge({
      dataDir: config.runner.dataDir,
      runsDir: join(config.runner.dataDir, "conductor-runs"),
      configPath: config.runner.analyticsConfigPath,
      logger: runnerLogger,
    }),
  runCycle: runCycleDefault,
};

const uiForJob = (
  base: ExtensionUIContext,
  runtime: OnceRuntime,
  config: RunnerConfig,
  job: Job,
  layout: ProjectLayout,
): RunnerUiContext =>
  createVikunjaQuestionUi(base, {
    gateway: runtime.gateway,
    store: runtime.store,
    job,
    layout,
    ownerUserId: config.vikunja.ownerUserId as RunnerCycleInput["ownerUserId"],
    maxCommentChars: config.runner.maxCommentChars,
    pollIntervalMs: config.vikunja.waitingPollIntervalSeconds * 1000,
  });

/** Run exactly one poll/claim/execution cycle and close durable resources. Spec §§19 and 21. */
export const runOnce = async (
  configPath: string,
  overrides: Partial<OnceDependencies> = {},
): Promise<RunnerCycleReport> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  const config = await dependencies.loadConfig(configPath);
  validateConfiguredProjects(config.projects);
  const token = await dependencies.readCredential(
    config.vikunja.tokenFile,
    "Vikunja token",
  );
  let analyticsConfigured = true;
  try {
    await dependencies.readCredential(
      config.runner.analyticsConfigPath,
      "Analytics configuration",
    );
  } catch (error) {
    analyticsConfigured = false;
    runnerLogger.error("runner_once_analytics_config_unavailable", error);
  }
  const runtime = await dependencies.createRuntime(config, token);
  let analytics: OnceAnalyticsLifecycle;
  try {
    analytics = analyticsConfigured
      ? await dependencies.startOnceAnalytics(config)
      : { shutdown: async () => undefined };
  } catch (error) {
    runnerLogger.error("runner_once_analytics_start_failed", error);
    analytics = { shutdown: async () => undefined };
  }
  try {
    return await dependencies.runCycle({
      projects: config.projects,
      store: runtime.store,
      gateway: runtime.gateway,
      ownerUserId: config.vikunja
        .ownerUserId as RunnerCycleInput["ownerUserId"],
      runnerUserId: config.vikunja
        .runnerUserId as RunnerCycleInput["runnerUserId"],
      repository: runtime.repository,
      conductor: runtime.conductor,
      uiForJob: (job, layout) =>
        uiForJob(noOpUi(), runtime, config, job, layout),
      maxCommentChars: config.runner.maxCommentChars,
    });
  } finally {
    try {
      await analytics.shutdown();
    } catch (error) {
      runnerLogger.error("runner_once_analytics_shutdown_failed", error);
    } finally {
      runtime.close();
    }
  }
};

/** Build the production runtime used by the CLI once command. */
export const productionOnceRuntime = createRuntime;
