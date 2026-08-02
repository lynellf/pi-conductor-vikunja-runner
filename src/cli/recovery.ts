import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RunnerUiContext } from "../conductor/gateway.js";
import type { ProjectConfig, RunnerConfig } from "../config/config.js";
import { startPiCommentMonitor } from "../domain/control.js";
import type { Job } from "../domain/jobs.js";
import {
  attachShutdownAbort,
  completeConductorJob,
  JobStartError,
  recordTerminalJobFailure,
  reportTerminalJobFailure,
  resumeRecoverableJob,
} from "../domain/orchestration.js";
import {
  reconcileStartup,
  type StartupReconciliationReport,
} from "../domain/reconciliation.js";
import type { RunnerCycleInput } from "../domain/runner.js";
import { startHeartbeatRefresh } from "../domain/runner.js";
import type { ProjectId, ProjectLayout } from "../domain/types.js";
import { createVikunjaQuestionUi } from "../vikunja/interaction-ui.js";
import type { OnceRuntime } from "./once.js";

export interface ResumeJobsInput {
  readonly config: RunnerConfig;
  readonly runtime: OnceRuntime;
  readonly layouts: ReadonlyMap<ProjectId, ProjectLayout>;
  /** Jobs whose remote state was unavailable during startup reconciliation. */
  readonly deferredJobIds?: readonly Job["id"][];
  readonly logError: (error: Error) => void;
  readonly signal?: AbortSignal;
}

export interface RuntimeRecoveryReport {
  readonly reconciliation: StartupReconciliationReport;
  readonly resumedJobs: number;
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

export const validateProjectLayouts = async (
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

export const uiForJob = (
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

export const defaultResumeJobs = async (
  input: ResumeJobsInput,
): Promise<number> => {
  const deferred = new Set(input.deferredJobIds ?? []);
  const jobs = (await input.runtime.store.recoverableJobs()).filter(
    (job) => job.state === "running" && !deferred.has(job.id),
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
        worktree = await input.runtime.repository.prepare(job, project);
      } catch (error) {
        const failed = await recordTerminalJobFailure({
          job,
          layout,
          store: input.runtime.store,
          expectedBucketId: layout.buckets.Running.id,
          terminalErrorCode: "REPOSITORY_PREPARE_FAILED",
          detail: "repository recovery failed",
          maxCommentChars: input.config.runner.maxCommentChars,
        });
        throw new JobStartError("repository recovery failed", failed, error);
      }
      const ui = uiForJob(input.runtime, input.config, job, layout);
      const recovered = await resumeRecoverableJob({
        job,
        layout,
        store: input.runtime.store,
        conductor: input.runtime.conductor,
        ui,
        maxCommentChars: input.config.runner.maxCommentChars,
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
      const stopHeartbeatRefresh = startHeartbeatRefresh(input.runtime.store);
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
        stopHeartbeatRefresh();
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
          // Durable intents preserve reporting work for startup replay.
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

/** Reconcile durable state and resume confirmed jobs before accepting new work. */
export const recoverRuntime = async (
  config: RunnerConfig,
  runtime: OnceRuntime,
  logError: (error: Error) => void,
  signal?: AbortSignal,
): Promise<RuntimeRecoveryReport> => {
  const layouts = await validateProjectLayouts(
    runtime.gateway,
    config.projects,
  );
  const reconciliation = await reconcileStartup({
    store: runtime.store,
    gateway: runtime.gateway,
    layouts,
  });
  const resumedJobs = await defaultResumeJobs({
    config,
    runtime,
    layouts,
    ...(reconciliation.deferredJobIds === undefined
      ? {}
      : { deferredJobIds: reconciliation.deferredJobIds }),
    logError,
    ...(signal === undefined ? {} : { signal }),
  });
  return { reconciliation, resumedJobs };
};
