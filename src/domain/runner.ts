import type { RunnerUiContext } from "../conductor/gateway.js";
import type { ProjectConfig } from "../config/config.js";
import type { RepositoryManager } from "../repositories/git.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import type { JobStore } from "./jobs.js";
import {
  type ExecuteClaimedJobInput,
  type ExecuteClaimedJobResult,
  executeClaimedJob,
  recordTerminalJobFailure,
  reportTerminalJobFailure,
} from "./orchestration.js";
import {
  type PollCycleInput,
  type PollCycleReport,
  pollOnce,
} from "./polling.js";
import type { UserId } from "./types.js";

/** Dependencies for one complete poll, claim, and execution cycle. Spec §§6, 10, 19. */
export interface RunnerCycleInput
  extends Omit<PollCycleInput, "maxCommentChars"> {
  readonly ownerUserId: UserId;
  readonly runnerUserId: UserId;
  readonly repository: RepositoryManager;
  readonly conductor: ExecuteClaimedJobInput["conductor"];
  readonly uiForJob: (
    job: ExecuteClaimedJobInput["job"],
    layout: ExecuteClaimedJobInput["layout"],
  ) => RunnerUiContext;
  readonly maxCommentChars?: number;
  /** Propagates daemon shutdown to a claimed conductor run. */
  readonly signal?: AbortSignal;
  readonly execute?: ClaimedJobExecutor;
}

export interface ClaimedJobExecutionInput {
  readonly job: ExecuteClaimedJobInput["job"];
  readonly task: ExecuteClaimedJobInput["task"];
  readonly project: ProjectConfig;
  readonly layout: ExecuteClaimedJobInput["layout"];
  readonly ownerUserId: UserId;
  readonly runnerUserId: UserId;
  readonly store: JobStore;
  readonly gateway: VikunjaGateway;
  readonly repository: RepositoryManager;
  readonly conductor: ExecuteClaimedJobInput["conductor"];
  readonly ui: RunnerUiContext;
  readonly maxCommentChars?: number;
  readonly signal?: AbortSignal;
}

export type ClaimedJobExecutor = (
  input: ClaimedJobExecutionInput,
) => Promise<ExecuteClaimedJobResult>;

export interface RunnerCycleReport {
  readonly poll: PollCycleReport;
  readonly execution: ExecuteClaimedJobResult | null;
}

const HEARTBEAT_REFRESH_INTERVAL_MS = 30_000;

/** Keep the durable liveness marker fresh while a conductor run is active. */
export const startHeartbeatRefresh = (store: JobStore): (() => void) => {
  const timer = setInterval(() => {
    void store.recordHeartbeat().catch(() => {
      // The next poll will retry the liveness write; never interrupt a live job.
    });
  }, HEARTBEAT_REFRESH_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
};

const execute: ClaimedJobExecutor = async (input) =>
  executeClaimedJob({
    job: input.job,
    task: input.task,
    project: input.project,
    layout: input.layout,
    ownerUserId: input.ownerUserId,
    runnerUserId: input.runnerUserId,
    store: input.store,
    gateway: input.gateway,
    repository: input.repository,
    conductor: input.conductor,
    ui: input.ui,
    ...(input.maxCommentChars === undefined
      ? {}
      : { maxCommentChars: input.maxCommentChars }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

/**
 * Run exactly one polling cycle and, when a claim succeeds, keep the claimed
 * job attached to its live conductor until terminal reporting completes.
 * Re-reading the task and layout after claiming prevents stale polling data
 * from becoming conductor input. Spec §§6, 8-13 and 19.
 */
const runPollCycleWithoutHeartbeat = async (
  input: RunnerCycleInput,
): Promise<RunnerCycleReport> => {
  const poll = await pollOnce({
    projects: input.projects,
    store: input.store,
    gateway: input.gateway,
    ...(input.maxCommentChars === undefined
      ? {}
      : { maxCommentChars: input.maxCommentChars }),
  });
  if (poll.claim === null || poll.claim.status !== "claimed") {
    return { poll, execution: null };
  }

  const job = poll.claim.job;
  const project = input.projects[String(job.projectId)];
  if (project === undefined) {
    throw new Error(`claimed project ${job.projectId} is not configured`);
  }
  const failBeforeExecution = async (
    code: "VIKUNJA_UNAVAILABLE" | "PROJECT_LAYOUT_INVALID",
    detail: string,
    cause: unknown,
  ): Promise<never> => {
    const pollingLayout = poll.claimLayout;
    if (pollingLayout === undefined) throw cause;
    const failureInput = {
      job,
      layout: pollingLayout,
      store: input.store,
      expectedBucketId: pollingLayout.buckets.Running.id,
      detail,
      ...(input.maxCommentChars === undefined
        ? {}
        : { maxCommentChars: input.maxCommentChars }),
    };
    const failed = await recordTerminalJobFailure({
      ...failureInput,
      terminalErrorCode: code,
    });
    try {
      await reportTerminalJobFailure({
        ...failureInput,
        job: failed,
        gateway: input.gateway,
      });
    } catch {
      // Durable reporting intents are retried during startup reconciliation.
    }
    throw cause;
  };

  let task: Awaited<ReturnType<VikunjaGateway["getTask"]>>;
  try {
    task = await input.gateway.getTask(job.taskId);
  } catch (error) {
    return failBeforeExecution(
      "VIKUNJA_UNAVAILABLE",
      "the claimed task could not be refreshed before conductor start",
      error,
    );
  }
  let layout: Awaited<ReturnType<VikunjaGateway["validateProjectLayout"]>>;
  try {
    layout = await input.gateway.validateProjectLayout(project);
  } catch (error) {
    return failBeforeExecution(
      "PROJECT_LAYOUT_INVALID",
      "the project layout changed before conductor start",
      error,
    );
  }
  const execution = await (input.execute ?? execute)({
    job,
    task,
    project,
    layout,
    ownerUserId: input.ownerUserId,
    runnerUserId: input.runnerUserId,
    store: input.store,
    gateway: input.gateway,
    repository: input.repository,
    conductor: input.conductor,
    ui: input.uiForJob(job, layout),
    ...(input.maxCommentChars === undefined
      ? {}
      : { maxCommentChars: input.maxCommentChars }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return { poll, execution };
};

/** Run one cycle while keeping the durable liveness marker fresh during execution. */
export const runPollCycle = async (
  input: RunnerCycleInput,
): Promise<RunnerCycleReport> => {
  // Keep the operational liveness marker in the same durable store as claims.
  // The guard preserves compatibility with lightweight boundary fakes.
  if (typeof input.store.recordHeartbeat === "function") {
    await input.store.recordHeartbeat();
  }
  const stopHeartbeatRefresh = startHeartbeatRefresh(input.store);
  try {
    return await runPollCycleWithoutHeartbeat(input);
  } finally {
    stopHeartbeatRefresh();
  }
};
