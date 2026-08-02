import { join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AnalyticsBridge } from "../conductor/analytics.js";
import { startAnalyticsBridge } from "../conductor/analytics.js";
import type { RunnerUiContext } from "../conductor/gateway.js";
import type { ProjectConfig, RunnerConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { startPiCommentMonitor } from "../domain/control.js";
import type { Job } from "../domain/jobs.js";
import {
  attachShutdownAbort,
  completeConductorJob,
  JobCompletionError,
  JobStartError,
  reportTerminalJobFailure,
  resumeRecoverableJob,
} from "../domain/orchestration.js";
import {
  reconcileStartup,
  type StartupReconciliationReport,
} from "../domain/reconciliation.js";
import type { RunnerCycleInput } from "../domain/runner.js";
import { runPollCycle } from "../domain/runner.js";
import type { ProjectId, ProjectLayout } from "../domain/types.js";
import { createVikunjaQuestionUi } from "../vikunja/interaction-ui.js";
import { runnerLogger } from "./logging.js";
import {
  type OnceDependencies,
  type OnceRuntime,
  productionOnceRuntime,
} from "./once.js";
import {
  readProtectedCredential,
  validateConfiguredProjects,
} from "./validate.js";

export interface AnalyticsLifecycle {
  shutdown(): Promise<void>;
}

export interface DaemonRunReport {
  readonly cycles: number;
  readonly reconciliation: StartupReconciliationReport;
  readonly resumedJobs: number;
}

export interface ResumeJobsInput {
  readonly config: RunnerConfig;
  readonly runtime: OnceRuntime;
  readonly layouts: ReadonlyMap<ProjectId, ProjectLayout>;
  readonly logError: (error: Error) => void;
  readonly signal?: AbortSignal;
}

export interface DaemonDependencies extends OnceDependencies {
  readonly startAnalytics: (
    config: RunnerConfig,
  ) => Promise<AnalyticsLifecycle>;
  readonly validateLayouts: (
    gateway: OnceRuntime["gateway"],
    projects: Readonly<Record<string, ProjectConfig>>,
  ) => Promise<ReadonlyMap<ProjectId, ProjectLayout>>;
  readonly reconcile: typeof reconcileStartup;
  readonly resumeJobs: (input: ResumeJobsInput) => Promise<number>;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Return a bounded positive delay to avoid synchronized polling. */
  readonly pollJitterMilliseconds: () => number;
  /** Maximum time to drain an active cycle and analytics after shutdown. */
  readonly shutdownTimeoutMilliseconds: number;
  readonly logError: (error: Error) => void;
}

const noOpUi = (): ExtensionUIContext => {
  const ui = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => undefined,
  };
  return ui as unknown as ExtensionUIContext;
};

const validateLayouts = async (
  gateway: OnceRuntime["gateway"],
  projects: Readonly<Record<string, ProjectConfig>>,
): Promise<ReadonlyMap<ProjectId, ProjectLayout>> => {
  const layouts = new Map<ProjectId, ProjectLayout>();
  for (const project of Object.values(projects).sort(
    (left, right) => left.id - right.id,
  )) {
    const layout = await gateway.validateProjectLayout(project);
    layouts.set(project.id, layout);
  }
  return layouts;
};

const startAnalytics = async (config: RunnerConfig): Promise<AnalyticsBridge> =>
  startAnalyticsBridge({
    dataDir: config.runner.dataDir,
    runsDir: join(config.runner.dataDir, "conductor-runs"),
    configPath: config.runner.analyticsConfigPath,
    logger: runnerLogger,
  });

export const defaultResumeJobs = async (
  input: ResumeJobsInput,
): Promise<number> => {
  const jobs = (await input.runtime.store.recoverableJobs()).filter(
    (job) => job.state === "running",
  );
  let resumed = 0;
  for (const job of jobs) {
    const project = input.config.projects[String(job.projectId)];
    const layout = input.layouts.get(job.projectId);
    if (project === undefined || layout === undefined) {
      input.logError(
        new Error(`cannot resume job ${job.id}: project is unknown`),
      );
      continue;
    }
    try {
      let worktree: Awaited<ReturnType<OnceRuntime["repository"]["prepare"]>>;
      try {
        // Verify the preserved worktree before reopening the conductor. A
        // running job already has a deterministic persisted branch, so no
        // task-content refresh is needed for recovery.
        worktree = await input.runtime.repository.prepare(job, project);
      } catch (error) {
        const failed = await input.runtime.store.transition(job.id, {
          state: "failed",
          terminalErrorCode: "REPOSITORY_PREPARE_FAILED",
        });
        throw new JobStartError("repository recovery failed", failed, error);
      }
      const ui = uiForJob(input.runtime, input.config, job, layout);
      const recovered = await resumeRecoverableJob({
        job,
        store: input.runtime.store,
        conductor: input.runtime.conductor,
        ui,
      });
      const monitor = startPiCommentMonitor({
        job: recovered.job,
        handle: recovered.handle,
        ownerUserId: input.config.vikunja
          .ownerUserId as RunnerCycleInput["ownerUserId"],
        store: input.runtime.store,
        gateway: input.runtime.gateway,
        layout,
        maxCommentChars: input.config.runner.maxCommentChars,
        logError: input.logError,
      });
      const detachShutdownAbort = attachShutdownAbort(
        recovered.handle,
        input.signal,
      );
      try {
        await completeConductorJob({
          job: recovered.job,
          handle: recovered.handle,
          worktree,
          project,
          layout,
          store: input.runtime.store,
          repository: input.runtime.repository,
          gateway: input.runtime.gateway,
        });
        resumed += 1;
      } finally {
        detachShutdownAbort();
        monitor.stop();
        await monitor.done;
      }
    } catch (error) {
      if (error instanceof JobStartError) {
        try {
          await reportTerminalJobFailure({
            job: error.job,
            layout,
            store: input.runtime.store,
            gateway: input.runtime.gateway,
            expectedBucketId: layout.buckets.Running.id,
            detail: error.message,
            maxCommentChars: input.config.runner.maxCommentChars,
          });
        } catch {
          // The reporter records durable intents before delivery. Preserve the
          // original recovery error; startup replay will retry pending work.
        }
      }
      input.logError(
        error instanceof Error
          ? error
          : new Error(`job ${job.id} resume failed`),
      );
    }
  }
  return resumed;
};

export const sleepWithShutdown = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const logRunnerError = (error: Error): void => {
  const job =
    error instanceof JobStartError || error instanceof JobCompletionError
      ? error.job
      : null;
  runnerLogger.error("runner_cycle_failed", error, {
    ...(job === null
      ? {}
      : {
          jobId: job.id,
          taskId: job.taskId,
          projectId: job.projectId,
          attempt: job.attempt,
          runId: job.conductorRunId,
          errorCode: job.terminalErrorCode,
        }),
  });
};

const defaultDependencies: DaemonDependencies = {
  loadConfig,
  readCredential: readProtectedCredential,
  createRuntime: productionOnceRuntime,
  runCycle: runPollCycle,
  startOnceAnalytics: startAnalytics,
  startAnalytics,
  validateLayouts,
  reconcile: reconcileStartup,
  resumeJobs: defaultResumeJobs,
  sleep: sleepWithShutdown,
  pollJitterMilliseconds: () => Math.floor(Math.random() * 1000),
  shutdownTimeoutMilliseconds: 25_000,
  logError: logRunnerError,
};

const SHUTDOWN_TIMED_OUT = Symbol("shutdown-timed-out");

const settleDuringShutdown = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<T | typeof SHUTDOWN_TIMED_OUT> => {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<typeof SHUTDOWN_TIMED_OUT>((resolve) => {
    const startTimer = (): void => {
      timer = setTimeout(
        () => resolve(SHUTDOWN_TIMED_OUT),
        timeoutMilliseconds,
      );
    };
    if (signal.aborted) startTimer();
    else {
      onAbort = startTimer;
      signal.addEventListener("abort", startTimer, { once: true });
    }
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
};

const settleWithin = async (
  operation: Promise<void>,
  timeoutMilliseconds: number,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMilliseconds);
  });
  try {
    return await Promise.race([operation.then(() => true), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const waitForShutdownOrSleep = async (
  milliseconds: number,
  signal: AbortSignal,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds, signal).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const uiForJob = (
  runtime: OnceRuntime,
  config: RunnerConfig,
  job: Job,
  layout: ProjectLayout,
): RunnerUiContext =>
  createVikunjaQuestionUi(noOpUi(), {
    gateway: runtime.gateway,
    store: runtime.store,
    job,
    layout,
    ownerUserId: config.vikunja.ownerUserId as RunnerCycleInput["ownerUserId"],
    maxCommentChars: config.runner.maxCommentChars,
    pollIntervalMs: config.vikunja.waitingPollIntervalSeconds * 1000,
  });

/**
 * Run the supervised daemon loop until its signal is aborted. Startup performs
 * layout validation, durable mutation reconciliation, and crashed-run resume
 * before any new claim. Spec §§10, 13, 19, and 21.
 */
export const runDaemon = async (
  configPath: string,
  overrides: Partial<DaemonDependencies> = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<DaemonRunReport> => {
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
    dependencies.logError(
      error instanceof Error
        ? error
        : new Error("analytics configuration is unavailable"),
    );
  }
  const runtime = await dependencies.createRuntime(config, token);
  let analytics: AnalyticsLifecycle | undefined;
  let cycles = 0;
  try {
    try {
      analytics = analyticsConfigured
        ? await dependencies.startAnalytics(config)
        : { shutdown: async () => undefined };
    } catch (error) {
      dependencies.logError(
        error instanceof Error ? error : new Error("analytics startup failed"),
      );
      analytics = { shutdown: async () => undefined };
    }
    const layouts = await dependencies.validateLayouts(
      runtime.gateway,
      config.projects,
    );
    const reconciliation = await dependencies.reconcile({
      store: runtime.store,
      gateway: runtime.gateway,
      layouts,
    });
    const resumedJobs = await dependencies.resumeJobs({
      config,
      runtime,
      layouts,
      logError: dependencies.logError,
      signal,
    });

    while (!signal.aborted) {
      cycles += 1;
      try {
        const cycle = dependencies.runCycle({
          projects: config.projects,
          store: runtime.store,
          gateway: runtime.gateway,
          ownerUserId: config.vikunja
            .ownerUserId as RunnerCycleInput["ownerUserId"],
          runnerUserId: config.vikunja
            .runnerUserId as RunnerCycleInput["runnerUserId"],
          repository: runtime.repository,
          conductor: runtime.conductor,
          uiForJob: (job, layout) => uiForJob(runtime, config, job, layout),
          maxCommentChars: config.runner.maxCommentChars,
          signal,
        });
        const outcome = await settleDuringShutdown(
          cycle,
          signal,
          dependencies.shutdownTimeoutMilliseconds,
        );
        if (outcome === SHUTDOWN_TIMED_OUT) {
          dependencies.logError(
            new Error("runner shutdown timeout expired while draining a cycle"),
          );
          break;
        }
      } catch (error) {
        dependencies.logError(
          error instanceof Error ? error : new Error("unknown runner failure"),
        );
      }
      if (!signal.aborted) {
        const basePollDelay = config.vikunja.pollIntervalSeconds * 1000;
        // Jitter is additive, so transient errors never cause a faster retry
        // than the configured poll interval. Keep the production spread small
        // and protect injected clocks from invalid values.
        const jitter = dependencies.pollJitterMilliseconds();
        const boundedJitter = Number.isFinite(jitter)
          ? Math.min(5000, Math.max(0, Math.floor(jitter)))
          : 0;
        await waitForShutdownOrSleep(
          basePollDelay + boundedJitter,
          signal,
          dependencies.sleep,
        );
      }
    }
    return { cycles, reconciliation, resumedJobs };
  } finally {
    try {
      if (analytics !== undefined) {
        try {
          const stopped = await settleWithin(
            analytics.shutdown(),
            Math.min(2_000, dependencies.shutdownTimeoutMilliseconds),
          );
          if (!stopped) {
            dependencies.logError(
              new Error(
                "runner shutdown timeout expired while flushing analytics",
              ),
            );
          }
        } catch (error) {
          dependencies.logError(
            error instanceof Error
              ? error
              : new Error("analytics shutdown failed"),
          );
        }
      }
    } finally {
      runtime.close();
    }
  }
};
