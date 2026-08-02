import type {
  ConductorGateway,
  ConductorHandle,
  RunnerUiContext,
} from "../conductor/gateway.js";
import type { ProjectConfig } from "../config/config.js";
import type { NewRemoteMutationIntent } from "../persistence/contracts.js";
import type {
  PreparedWorktree,
  PublishResult,
  RepositoryManager,
  Verification,
} from "../repositories/git.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import { startPiCommentMonitor } from "./control.js";
import { reportManualOverride } from "./idempotency.js";
import type { Job, JobStore, TerminalErrorCode } from "./jobs.js";
import { buildConductorGoal } from "./prompt.js";
import {
  type BucketId,
  bucketId,
  type CodingTask,
  type CommentId,
  type ProjectLayout,
  type UserId,
} from "./types.js";

export interface StartClaimedJobInput {
  readonly job: Job;
  readonly task: CodingTask;
  readonly project: ProjectConfig;
  readonly layout: ProjectLayout;
  readonly ownerUserId: UserId;
  readonly runnerUserId: UserId;
  readonly store: JobStore;
  readonly gateway: Pick<VikunjaGateway, "listComments">;
  readonly repository: RepositoryManager;
  readonly conductor: ConductorGateway;
  readonly ui: RunnerUiContext;
  readonly maxInputChars?: number;
  readonly maxCommentChars?: number;
  readonly includeRunnerComments?: boolean;
  /** Abort the live conductor when the daemon is shutting down. */
  readonly signal?: AbortSignal;
}

export type StartClaimedJobResult = {
  readonly job: Job;
  readonly handle: ConductorHandle;
  readonly goal: string;
  readonly worktree: PreparedWorktree;
  readonly initialCommentId: CommentId | null;
};

export interface ResumeRecoverableJobInput {
  readonly job: Job;
  readonly store: JobStore;
  readonly conductor: ConductorGateway;
  readonly ui: RunnerUiContext;
}

export type ResumedJobResult = {
  readonly job: Job;
  readonly handle: ConductorHandle;
};

export interface CompleteConductorJobInput {
  readonly job: Job;
  readonly handle: ConductorHandle;
  readonly worktree: PreparedWorktree;
  readonly project: ProjectConfig;
  readonly layout: ProjectLayout;
  readonly store: JobStore;
  readonly repository: RepositoryManager;
  readonly gateway: Pick<
    VikunjaGateway,
    "getTask" | "moveTask" | "postComment"
  >;
  readonly maxCommentChars?: number;
}

export interface CompletedConductorJobResult {
  readonly job: Job;
  readonly verification: Verification;
  readonly publish: PublishResult;
}

/**
 * Resume one durable running job after a process restart. Waiting jobs are
 * intentionally excluded: startup reconciliation must fail an unresolved
 * ask_user dialog rather than fabricate or replay an in-memory answer.
 */
export const resumeRecoverableJob = async (
  input: ResumeRecoverableJobInput,
): Promise<ResumedJobResult> => {
  if (input.job.state !== "running") {
    throw new Error("only a running job can resume a conductor session");
  }
  if (
    input.job.conductorRunId === null ||
    input.job.conductorRunId.trim() === ""
  ) {
    throw new Error("recoverable job has no conductor run ID");
  }

  let handle: ConductorHandle | undefined;
  try {
    handle = await input.conductor.resume(input.job, input.ui);
    if (handle.runId.trim() === "") {
      throw new Error("conductor returned an empty run ID");
    }
    if (handle.runId !== input.job.conductorRunId) {
      throw new Error("conductor resumed a different run ID");
    }
    const persisted = await input.store.getJob(input.job.id);
    if (persisted === null) {
      throw new Error("resumed conductor job could not be reloaded");
    }
    return { job: persisted, handle };
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.abort("runner could not recover conductor start");
      } catch {
        // Preserve the durable failure; a later reconciliation can inspect it.
      }
    }
    const failed = await input.store.transition(input.job.id, {
      state: "failed",
      terminalErrorCode: "CONDUCTOR_START_FAILED",
    });
    throw new JobStartError("conductor resume failed", failed, error);
  }
};

const truncateComment = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = "\n[truncated]";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
};

type TerminalMutationInput = Pick<
  CompleteConductorJobInput,
  "job" | "store" | "gateway"
>;

const mutation = async (
  input: TerminalMutationInput,
  operation: "move_task" | "post_comment",
  key: string,
  request: Record<string, unknown>,
): Promise<string | null> => {
  const intent = await input.store.recordMutationIntent({
    jobId: input.job.id,
    taskId: input.job.taskId,
    operation,
    idempotencyKey: key,
    request,
  });
  if (intent.state === "succeeded") return intent.remoteId;
  if (intent.state === "failed") {
    throw new Error(`remote mutation ${key} is permanently failed`);
  }

  let remoteId: string | null = null;
  if (operation === "move_task") {
    const bucket = request.bucketId;
    const expectedBucket = request.expectedBucketId;
    if (typeof bucket !== "number") throw new Error("invalid move bucket");
    if (typeof expectedBucket !== "number") {
      throw new Error("move mutation requires an expected bucket");
    }
    const current = await input.gateway.getTask(input.job.taskId);
    if (
      current.projectId !== input.job.projectId ||
      current.done ||
      current.bucketId !== expectedBucket
    ) {
      await input.store.failMutation(
        key,
        `task state superseded move (project ${current.projectId}, bucket ${current.bucketId}, done=${current.done})`,
      );
      throw new Error(`remote mutation ${key} was superseded`);
    }
    try {
      await input.gateway.moveTask(input.job.taskId, bucketId(bucket));
    } catch (error) {
      // A lost or malformed response is ambiguous: Vikunja may have applied
      // the move. Confirm the target state before allowing the caller to make
      // the local job terminal and suppress this intent during reconciliation.
      let observed: CodingTask;
      try {
        observed = await input.gateway.getTask(input.job.taskId);
      } catch {
        throw error;
      }
      if (
        observed.projectId === input.job.projectId &&
        !observed.done &&
        observed.bucketId === bucket
      ) {
        await input.store.completeMutation(key, null);
        return null;
      }
      if (
        observed.projectId !== input.job.projectId ||
        observed.done ||
        observed.bucketId !== expectedBucket
      ) {
        await input.store.failMutation(
          key,
          `task state superseded move (project ${observed.projectId}, bucket ${observed.bucketId}, done=${observed.done})`,
        );
      }
      throw error;
    }
  } else {
    const body = request.body;
    if (typeof body !== "string") throw new Error("invalid comment body");
    remoteId = String(await input.gateway.postComment(input.job.taskId, body));
  }
  await input.store.completeMutation(key, remoteId);
  return remoteId;
};

const failureComment = (
  input: Pick<CompleteConductorJobInput, "job" | "maxCommentChars">,
  code: string,
  detail: string,
): string => {
  const key = `job:${input.job.id}:completion:${code.toLowerCase()}`;
  return truncateComment(
    `[pi-runner][idempotency:${key}] ${code}: ${detail} Move this task to Ready to retry; the branch, worktree, and conductor records were preserved.`,
    input.maxCommentChars ?? 12000,
  );
};

const existingManualOverride = async (
  input: Pick<CompleteConductorJobInput, "job" | "store">,
): Promise<Job | null> => {
  if (typeof input.store.getJob !== "function") return null;
  const current = await input.store.getJob(input.job.id);
  return current?.terminalErrorCode === "MANUAL_STATE_OVERRIDE" &&
    current.state === "failed"
    ? current
    : null;
};

const failCompletedJob = async (
  input: CompleteConductorJobInput,
  code:
    | "CONDUCTOR_SESSION_FAILED"
    | "VERIFY_FAILED"
    | "PUBLISH_FAILED"
    | "VIKUNJA_UNAVAILABLE",
  detail: string,
  cause?: unknown,
): Promise<never> => {
  const overridden = await existingManualOverride(input);
  if (overridden !== null) {
    throw new JobCompletionError(
      "job completion preserved a manual state override",
      overridden,
      cause,
    );
  }
  const durableJob = (await input.store.getJob(input.job.id)) ?? input.job;
  const expectedBucketId =
    durableJob.state === "waiting"
      ? input.layout.buckets.Waiting.id
      : input.layout.buckets.Running.id;
  const moveKey = `job:${input.job.id}:completion:move-failed:${code.toLowerCase()}`;
  const moveRequest = {
    bucketId: input.layout.buckets.Failed.id,
    expectedBucketId,
  };
  const commentKey = `job:${input.job.id}:completion:${code.toLowerCase()}`;
  const commentRequest = { body: failureComment(input, code, detail) };
  // Releasing the active slot and recording its remote consequences is one
  // local transaction. A crash can leave delivery pending, but can never
  // leave a terminal job with no action for startup reconciliation to replay.
  const failed = await input.store.recordTerminalFailure(input.job.id, code, [
    {
      jobId: input.job.id,
      taskId: input.job.taskId,
      operation: "move_task",
      idempotencyKey: moveKey,
      request: moveRequest,
    },
    {
      jobId: input.job.id,
      taskId: input.job.taskId,
      operation: "post_comment",
      idempotencyKey: commentKey,
      request: commentRequest,
    },
  ]);
  try {
    await mutation(input, "move_task", moveKey, moveRequest);
  } catch {
    // Keep the move intent pending so startup reconciliation can retry it.
  }
  try {
    await mutation(input, "post_comment", commentKey, commentRequest);
  } catch {
    // Keep the completed failure durable; pending intents are replayed later.
  }
  throw new JobCompletionError(`job completion failed: ${code}`, failed, cause);
};

type TerminalFailureActionsInput = {
  readonly job: Job;
  readonly layout: ProjectLayout;
  readonly expectedBucketId: BucketId;
  readonly terminalErrorCode: TerminalErrorCode;
  readonly detail: string;
  readonly maxCommentChars?: number;
};

const terminalFailureActions = (
  input: TerminalFailureActionsInput,
): readonly NewRemoteMutationIntent[] => {
  const code = input.terminalErrorCode;
  const keyBase = `job:${input.job.id}:terminal:${code.toLowerCase()}`;
  return [
    {
      jobId: input.job.id,
      taskId: input.job.taskId,
      operation: "move_task",
      idempotencyKey: `${keyBase}:move`,
      request: {
        bucketId: input.layout.buckets.Failed.id,
        expectedBucketId: input.expectedBucketId,
      },
    },
    {
      jobId: input.job.id,
      taskId: input.job.taskId,
      operation: "post_comment",
      idempotencyKey: `${keyBase}:comment`,
      request: {
        body: truncateComment(
          `[pi-runner][idempotency:${keyBase}:comment] ${code}: ${input.detail} Move this task to Ready to retry; preserved artifacts were not deleted.`,
          input.maxCommentChars ?? 12000,
        ),
      },
    },
  ];
};

const recordStartFailure = async (
  input: Pick<StartClaimedJobInput, "layout" | "store" | "maxCommentChars">,
  job: Job,
  terminalErrorCode: Extract<
    TerminalErrorCode,
    "REPOSITORY_PREPARE_FAILED" | "CONDUCTOR_START_FAILED"
  >,
  detail: string,
  cause?: unknown,
): Promise<never> => {
  const failed = await input.store.recordTerminalFailure(
    job.id,
    terminalErrorCode,
    terminalFailureActions({
      job,
      layout: input.layout,
      expectedBucketId: input.layout.buckets.Running.id,
      terminalErrorCode,
      detail,
      ...(input.maxCommentChars === undefined
        ? {}
        : { maxCommentChars: input.maxCommentChars }),
    }),
  );
  throw new JobStartError(detail, failed, cause);
};

export interface ReportTerminalJobFailureInput {
  readonly job: Job;
  readonly layout: ProjectLayout;
  readonly store: JobStore;
  readonly gateway: Pick<
    VikunjaGateway,
    "getTask" | "moveTask" | "postComment"
  >;
  readonly expectedBucketId: BucketId;
  readonly detail: string;
  readonly maxCommentChars?: number;
}

/**
 * Synchronize a locally failed start/resume job with Vikunja. The expected
 * bucket guard prevents a delayed retry from overwriting an owner-selected
 * state, while durable intents keep transport failures recoverable.
 */
export const reportTerminalJobFailure = async (
  input: ReportTerminalJobFailureInput,
): Promise<void> => {
  const code = input.job.terminalErrorCode ?? "CONDUCTOR_START_FAILED";
  const [moveAction, commentAction] = terminalFailureActions({
    job: input.job,
    layout: input.layout,
    expectedBucketId: input.expectedBucketId,
    terminalErrorCode: code,
    detail: input.detail,
    ...(input.maxCommentChars === undefined
      ? {}
      : { maxCommentChars: input.maxCommentChars }),
  });
  if (moveAction === undefined || commentAction === undefined) {
    throw new Error("terminal failure actions are incomplete");
  }
  const moveKey = moveAction.idempotencyKey;
  let current: CodingTask | null = null;
  try {
    current = await input.gateway.getTask(input.job.taskId);
  } catch {
    // Record a guarded move for startup replay. Reconciliation re-reads the
    // task and suppresses the move if the expected runner-owned bucket changed.
    await input.store.recordMutationIntent(moveAction);
  }

  const runnerStillOwnsBucket =
    current !== null &&
    current.projectId === input.job.projectId &&
    !current.done &&
    current.bucketId === input.expectedBucketId;
  if (runnerStillOwnsBucket) {
    await mutation(
      input,
      "move_task",
      moveKey,
      moveAction.request as Record<string, unknown>,
    );
  }

  await mutation(
    input,
    "post_comment",
    commentAction.idempotencyKey,
    commentAction.request as Record<string, unknown>,
  );
};

/**
 * Verify, optionally publish, and report one terminal conductor completion.
 * Every remote mutation is durable and idempotent, so a restart cannot create
 * duplicate terminal comments or bucket moves. Spec §§12-15.
 */
export const completeConductorJob = async (
  input: CompleteConductorJobInput,
): Promise<CompletedConductorJobResult> => {
  if (input.job.state !== "running") {
    throw new Error("only a running job can be completed");
  }
  if (input.worktree.branch !== input.job.branch) {
    return failCompletedJob(
      input,
      "VERIFY_FAILED",
      "the prepared branch does not match the durable job branch",
    );
  }

  let completion: Awaited<ReturnType<ConductorHandle["completion"]>>;
  try {
    completion = await input.handle.completion();
  } catch (error) {
    return failCompletedJob(
      input,
      "CONDUCTOR_SESSION_FAILED",
      "the conductor session did not produce a terminal result",
      error,
    );
  }
  if (completion.exitReason !== "done") {
    return failCompletedJob(
      input,
      "CONDUCTOR_SESSION_FAILED",
      `the conductor exited with ${completion.exitReason}`,
    );
  }
  const overridden = await existingManualOverride(input);
  if (overridden !== null) {
    throw new JobCompletionError(
      "job completion preserved a manual state override",
      overridden,
    );
  }

  let latestResponse: ReturnType<ConductorHandle["latestResponse"]>;
  let runStats: ReturnType<ConductorHandle["runStats"]>;
  try {
    latestResponse = input.handle.latestResponse();
    runStats = input.handle.runStats();
  } catch (error) {
    return failCompletedJob(
      input,
      "CONDUCTOR_SESSION_FAILED",
      "the conductor final response and run statistics could not be captured",
      error,
    );
  }

  let verification: Verification;
  try {
    verification = await input.repository.verify(
      input.worktree,
      input.project.verifyCommands,
    );
  } catch (error) {
    return failCompletedJob(
      input,
      "VERIFY_FAILED",
      "configured verification could not be completed",
      error,
    );
  }
  if (!verification.passed || !verification.worktreeClean) {
    return failCompletedJob(
      input,
      "VERIFY_FAILED",
      verification.worktreeClean
        ? "one or more configured verification commands failed"
        : "verification passed but the worktree is not clean",
    );
  }

  let publish: PublishResult;
  try {
    publish = await input.repository.publish(
      input.worktree,
      input.project.publish,
    );
  } catch (error) {
    return failCompletedJob(
      input,
      "PUBLISH_FAILED",
      "the configured branch publish operation failed",
      error,
    );
  }

  // Re-read immediately before the terminal bucket move. A human may have
  // moved an active task while verification or publishing was running; never
  // overwrite that choice with Review.
  let currentTask: CodingTask;
  try {
    currentTask = await input.gateway.getTask(input.job.taskId);
  } catch (error) {
    return failCompletedJob(
      input,
      "VIKUNJA_UNAVAILABLE",
      "the task state could not be confirmed before the Review transition",
      error,
    );
  }
  if (
    currentTask.projectId !== input.job.projectId ||
    currentTask.done ||
    currentTask.bucketId !== input.layout.buckets.Running.id
  ) {
    let failed: Job;
    try {
      failed = await reportManualOverride({
        job: input.job,
        store: input.store,
        gateway: input.gateway,
        maxCommentChars: input.maxCommentChars ?? 12000,
      });
    } catch (error) {
      // The terminal override is durable even when comment delivery is
      // unavailable; preserve the stable job error for the caller while
      // leaving the mutation intent pending for startup replay.
      const observed = await input.store.getJob(input.job.id);
      if (
        observed === null ||
        observed.state !== "failed" ||
        observed.terminalErrorCode !== "MANUAL_STATE_OVERRIDE"
      ) {
        throw error;
      }
      throw new JobCompletionError(
        "job completion detected a manual state override",
        observed,
        error,
      );
    }
    throw new JobCompletionError(
      "job completion detected a manual state override",
      failed,
    );
  }

  const commentKey = `job:${input.job.id}:completion:review-comment`;
  const maxCommentChars = input.maxCommentChars ?? 12000;
  const publishDetail = publish.pushed
    ? `published to ${publish.remote}`
    : "kept local per repository configuration";
  const verificationDetails = verification.commands
    .map(
      (result, index) =>
        `${index + 1}. ${result.command.join(" ")} — ${result.passed ? "passed" : "failed"} (exit ${result.exitCode}, ${result.durationMs}ms)`,
    )
    .join("\n");
  const responseText = truncateComment(
    latestResponse?.text ?? "(no final response recorded)",
    Math.min(4000, Math.max(1, Math.floor(maxCommentChars / 3))),
  );
  const statsSummary = `state=${runStats.state}; exit=${runStats.exitReason}; records=${runStats.recordsCount}; transitions=${runStats.transitionHistory.length}`;
  const report = [
    `[pi-runner][idempotency:${commentKey}] Review ready.`,
    `Branch: ${publish.branch}. Latest commit: ${verification.latestCommit ?? "unknown"}. Attempt: ${input.job.attempt}.`,
    `Conductor run: ${input.job.conductorRunId ?? "unknown"}. Run stats: ${statsSummary}.`,
    `Verification results:\n${verificationDetails || "(no configured checks)"}\nWorktree: clean.`,
    `Final response:\n${responseText}`,
    `Publish: ${publishDetail}.`,
    "To accept this attempt, move the task to Done. To request another attempt, comment with feedback and move it to Ready.",
  ].join("\n");
  try {
    await mutation(input, "post_comment", commentKey, {
      body: truncateComment(report, maxCommentChars),
    });
  } catch (error) {
    try {
      await input.store.failMutation(
        commentKey,
        "review report delivery failed before the Review transition",
      );
    } catch {
      // The terminal failure path remains authoritative if intent finalization races.
    }
    return failCompletedJob(
      input,
      "VIKUNJA_UNAVAILABLE",
      "the final Review report could not be posted",
      error,
    );
  }

  const moveKey = `job:${input.job.id}:completion:move-review`;
  try {
    await mutation(input, "move_task", moveKey, {
      bucketId: input.layout.buckets.Review.id,
      expectedBucketId: input.layout.buckets.Running.id,
    });
  } catch (error) {
    return failCompletedJob(
      input,
      "VIKUNJA_UNAVAILABLE",
      "the completed task could not be moved to Review",
      error,
    );
  }

  let reviewed: Job;
  try {
    reviewed = await input.store.transition(input.job.id, {
      state: "review",
    });
  } catch (error) {
    return failCompletedJob(
      input,
      "PUBLISH_FAILED",
      "the completed task state could not be persisted",
      error,
    );
  }
  return { job: reviewed, verification, publish };
};

/**
 * Prepare and start one already-claimed task. The run ID is persisted before
 * the caller can await the live conductor handle, making restart recovery
 * possible even when the session exits immediately. Spec §§8-10.
 */
export const startClaimedJob = async (
  input: StartClaimedJobInput,
): Promise<StartClaimedJobResult> => {
  if (input.job.state !== "running") {
    throw new Error("only a running job can start a conductor session");
  }
  if (input.task.projectId !== input.project.id) {
    throw new Error("task and project IDs do not match");
  }
  // The layout is part of the orchestration contract so callers cannot start
  // a task they failed to validate, even though prompt construction does not
  // otherwise need bucket details.
  if (input.layout.viewId !== input.project.kanbanViewId) {
    throw new Error("project layout does not match configured view");
  }

  let preparedJob: Job;
  let preparedWorktree: PreparedWorktree;
  try {
    preparedWorktree = await input.repository.prepare(
      input.job,
      input.project,
      {
        taskTitle: input.task.title,
      },
    );
    preparedJob = await input.store.recordWorktree(
      input.job.id,
      preparedWorktree.branch,
      preparedWorktree.worktree,
    );
  } catch (error) {
    return recordStartFailure(
      input,
      input.job,
      "REPOSITORY_PREPARE_FAILED",
      "repository preparation failed",
      error,
    );
  }

  if (preparedJob.branch === null) {
    return recordStartFailure(
      input,
      preparedJob,
      "REPOSITORY_PREPARE_FAILED",
      "repository preparation returned no branch",
    );
  }

  let handle: ConductorHandle | undefined;
  try {
    const comments = await input.gateway.listComments(input.task.id, null);
    const initialCommentId = comments.reduce<CommentId | null>(
      (latest, comment) =>
        latest === null || comment.id > latest ? comment.id : latest,
      null,
    );
    const goal = buildConductorGoal({
      task: input.task,
      project: input.project,
      branch: preparedJob.branch,
      comments,
      ownerUserId: input.ownerUserId,
      runnerUserId: input.runnerUserId,
      ...(input.maxInputChars === undefined
        ? {}
        : { maxInputChars: input.maxInputChars }),
      ...(input.includeRunnerComments === undefined
        ? {}
        : { includeRunnerComments: input.includeRunnerComments }),
    });
    // Persist the exact goal snapshot before conductor startup. Recovery can
    // then process owner commands posted after this cursor instead of treating
    // every comment observed after a crash as historical.
    if (initialCommentId !== null) {
      await input.store.recordCommentWatermark(input.task.id, initialCommentId);
    }
    handle = await input.conductor.start(preparedJob, goal, input.ui);
    if (handle.runId.trim() === "") {
      throw new Error("conductor returned an empty run ID");
    }
    await input.store.recordRunId(preparedJob.id, handle.runId);
    const persisted = await input.store.getJob(input.job.id);
    if (persisted === null) {
      throw new Error(
        "conductor run was started but the job could not be reloaded",
      );
    }
    return {
      job: persisted,
      handle,
      goal,
      worktree: preparedWorktree,
      initialCommentId,
    };
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.abort("runner could not persist conductor start");
      } catch {
        // Preserve the durable failure; startup reconciliation handles a live
        // conductor session that could not be aborted synchronously.
      }
    }
    return recordStartFailure(
      input,
      preparedJob,
      "CONDUCTOR_START_FAILED",
      "conductor start failed",
      error,
    );
  }
};

export interface ExecuteClaimedJobInput
  extends Omit<StartClaimedJobInput, "gateway"> {
  readonly maxCommentChars?: number;
  /** Abort the live conductor when the daemon is shutting down. */
  readonly signal?: AbortSignal;
  readonly gateway: Pick<
    VikunjaGateway,
    "getTask" | "listComments" | "moveTask" | "postComment"
  >;
}

export interface ExecuteClaimedJobResult {
  readonly job: Job;
  readonly goal: string;
  readonly handle: ConductorHandle;
  readonly verification: Verification;
  readonly publish: PublishResult;
}

export const attachShutdownAbort = (
  handle: ConductorHandle,
  signal: AbortSignal | undefined,
): (() => void) => {
  if (signal === undefined) return () => undefined;
  let requested = false;
  const requestAbort = (): void => {
    if (requested) return;
    requested = true;
    void handle.abort("runner shutting down").catch(() => undefined);
  };
  if (signal.aborted) {
    requestAbort();
    return () => undefined;
  }
  signal.addEventListener("abort", requestAbort, { once: true });
  return () => signal.removeEventListener("abort", requestAbort);
};

/**
 * Execute one claimed task from repository preparation through terminal
 * verification/reporting. The start result carries the exact prepared
 * worktree into completion so the runner never reconstructs paths from task
 * content. Spec §§8-13.
 */
export const executeClaimedJob = async (
  input: ExecuteClaimedJobInput,
): Promise<ExecuteClaimedJobResult> => {
  let started: StartClaimedJobResult;
  try {
    started = await startClaimedJob(input);
  } catch (error) {
    if (error instanceof JobStartError && input.gateway.getTask !== undefined) {
      try {
        await reportTerminalJobFailure({
          job: error.job,
          layout: input.layout,
          store: input.store,
          gateway: {
            getTask: input.gateway.getTask,
            moveTask: input.gateway.moveTask,
            postComment: input.gateway.postComment,
          },
          expectedBucketId: input.layout.buckets.Running.id,
          detail: error.message,
          ...(input.maxCommentChars === undefined
            ? {}
            : { maxCommentChars: input.maxCommentChars }),
        });
      } catch {
        // Durable mutation intents preserve reporting work for reconciliation;
        // never replace the stable start failure with a reporting exception.
      }
    }
    throw error;
  }
  const monitor = startPiCommentMonitor({
    job: started.job,
    handle: started.handle,
    ownerUserId: input.ownerUserId,
    store: input.store,
    gateway: input.gateway,
    layout: input.layout,
    initialCommentId: started.initialCommentId,
    ...(input.maxCommentChars === undefined
      ? {}
      : { maxCommentChars: input.maxCommentChars }),
  });
  const detachShutdownAbort = attachShutdownAbort(started.handle, input.signal);
  try {
    const completed = await completeConductorJob({
      job: started.job,
      handle: started.handle,
      worktree: started.worktree,
      project: input.project,
      layout: input.layout,
      store: input.store,
      repository: input.repository,
      gateway: input.gateway,
      ...(input.maxCommentChars === undefined
        ? {}
        : { maxCommentChars: input.maxCommentChars }),
    });
    return {
      ...completed,
      goal: started.goal,
      handle: started.handle,
    };
  } finally {
    detachShutdownAbort();
    monitor.stop();
    await monitor.done;
  }
};

export class JobCompletionError extends Error {
  public constructor(
    message: string,
    public readonly job: Job,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JobCompletionError";
  }
}

export class JobStartError extends Error {
  public constructor(
    message: string,
    public readonly job: Job,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JobStartError";
  }
}
