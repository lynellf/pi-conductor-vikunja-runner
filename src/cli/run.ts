import { join } from "node:path";
import type { AnalyticsBridge } from "../conductor/analytics.js";
import { startAnalyticsBridge } from "../conductor/analytics.js";
import type { ProjectConfig, RunnerConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { JobCompletionError, JobStartError } from "../domain/orchestration.js";
import {
  reconcileStartup,
  type StartupReconciliationReport,
} from "../domain/reconciliation.js";
import type { RunnerCycleInput } from "../domain/runner.js";
import { runPollCycle } from "../domain/runner.js";
import type { ProjectId, ProjectLayout } from "../domain/types.js";
import { runnerLogger } from "./logging.js";
import {
  type OnceDependencies,
  type OnceRuntime,
  productionOnceRuntime,
} from "./once.js";
import {
  defaultResumeJobs,
  type ResumeJobsInput,
  uiForJob,
  validateProjectLayouts,
} from "./recovery.js";
import {
  readProtectedCredential,
  validateConfiguredProjects,
} from "./validate.js";

export type { ResumeJobsInput } from "./recovery.js";
export { defaultResumeJobs } from "./recovery.js";

export interface AnalyticsLifecycle {
  shutdown(): Promise<void>;
}

export interface DaemonRunReport {
  readonly cycles: number;
  readonly reconciliation: StartupReconciliationReport;
  readonly resumedJobs: number;
}

export interface DaemonDependencies
  extends Omit<OnceDependencies, "recoverStartup"> {
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
  /** Time before warning that active-cycle or analytics shutdown is slow. */
  readonly shutdownTimeoutMilliseconds: number;
  readonly logError: (error: Error) => void;
}

const startAnalytics = async (config: RunnerConfig): Promise<AnalyticsBridge> =>
  startAnalyticsBridge({
    dataDir: config.runner.dataDir,
    runsDir: join(config.runner.dataDir, "conductor-runs"),
    configPath: config.runner.analyticsConfigPath,
    logger: runnerLogger,
  });

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
  validateLayouts: validateProjectLayouts,
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
    let reconciliation = await dependencies.reconcile({
      store: runtime.store,
      gateway: runtime.gateway,
      layouts,
    });
    let resumedJobs = await dependencies.resumeJobs({
      config,
      runtime,
      layouts,
      ...(reconciliation.deferredJobIds === undefined
        ? {}
        : { deferredJobIds: reconciliation.deferredJobIds }),
      logError: dependencies.logError,
      signal,
    });

    while (!signal.aborted) {
      // Reconcile after every completed poll interval, not only after startup
      // deferrals. A normal cycle can leave a durable remote mutation pending
      // after a transport failure; waiting for a process restart would strand
      // the task and violate the outbox contract.
      if (cycles > 0) {
        try {
          const retriedReconciliation = await dependencies.reconcile({
            store: runtime.store,
            gateway: runtime.gateway,
            layouts,
          });
          const retriedResumes = await dependencies.resumeJobs({
            config,
            runtime,
            layouts,
            ...(retriedReconciliation.deferredJobIds === undefined
              ? {}
              : { deferredJobIds: retriedReconciliation.deferredJobIds }),
            logError: dependencies.logError,
            signal,
          });
          reconciliation = retriedReconciliation;
          resumedJobs += retriedResumes;
        } catch (error) {
          dependencies.logError(
            error instanceof Error
              ? error
              : new Error("deferred runner recovery failed"),
          );
        }
      }
      if (signal.aborted) break;
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
          // Promise.race does not cancel the cycle. Keep its runtime resources
          // alive until shutdown propagation actually stops and settles it.
          await cycle;
          break;
        }
        if (outcome.poll.claim?.status === "failed") {
          dependencies.logError(
            outcome.poll.claim.error instanceof Error
              ? outcome.poll.claim.error
              : new Error("claim failed with an unknown error"),
          );
          // A terminal claim releases its local uniqueness constraint while
          // the task may still be in Ready. Stop this process so systemd's
          // on-failure policy does not create a new job and comment each poll.
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
