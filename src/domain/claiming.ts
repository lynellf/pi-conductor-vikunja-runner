import type { VikunjaGateway } from "../vikunja/gateway.js";
import { taskBranchName } from "./branch.js";
import type { Job, JobStore } from "./jobs.js";
import type { CodingTask, ProjectLayout, TaskId } from "./types.js";
import { bucketId, commentId } from "./types.js";

export interface ClaimTaskInput {
  readonly task: CodingTask;
  /** Configured repository identity used to isolate retry artifacts. */
  readonly repository?: string;
  readonly layout: ProjectLayout;
  readonly store: JobStore;
  readonly gateway: Pick<
    VikunjaGateway,
    "getTask" | "moveTask" | "assignRunner" | "postComment"
  >;
  readonly maxCommentChars?: number;
}

export type ClaimResult =
  | { readonly status: "skipped" }
  | { readonly status: "conflict"; readonly job: Job }
  | { readonly status: "claimed"; readonly job: Job }
  | { readonly status: "failed"; readonly job: Job; readonly error: unknown };

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = "\n[truncated]";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
};

const request = (bucketId?: number, body?: string): Record<string, unknown> =>
  bucketId === undefined ? { body } : { bucketId };

const moveRequest = (
  targetBucketId: number,
  expectedBucketId: number,
): Record<string, unknown> => ({
  bucketId: targetBucketId,
  expectedBucketId,
});

const deliverMutation = async (
  store: JobStore,
  gateway: ClaimTaskInput["gateway"],
  job: Job,
  taskId: TaskId,
  operation: string,
  idempotencyKey: string,
  mutationRequest: Record<string, unknown>,
): Promise<string | null> => {
  const intent = await store.recordMutationIntent({
    jobId: job.id,
    taskId,
    operation,
    idempotencyKey,
    request: mutationRequest,
  });
  if (intent.state === "succeeded") return intent.remoteId;
  if (intent.state === "failed") {
    throw new Error(intent.error ?? `mutation ${idempotencyKey} failed`);
  }

  let remoteId: string | null = null;
  if (operation === "move_task") {
    const bucket = mutationRequest.bucketId;
    if (typeof bucket !== "number")
      throw new Error("move mutation has no bucket");
    await gateway.moveTask(taskId, bucketId(bucket));
  } else if (operation === "assign_runner") {
    await gateway.assignRunner(taskId);
  } else if (operation === "post_comment") {
    const body = mutationRequest.body;
    if (typeof body !== "string")
      throw new Error("comment mutation has no body");
    remoteId = String(await gateway.postComment(taskId, body));
  } else {
    throw new Error(`unsupported claim mutation: ${operation}`);
  }
  await store.completeMutation(idempotencyKey, remoteId);
  return remoteId;
};

const deliverCommentMilestone = async (
  input: ClaimTaskInput,
  job: Job,
  type: "claimed" | "failure",
  idempotencyKey: string,
  body: string,
): Promise<void> => {
  const milestone = await input.store.recordMilestone({
    jobId: job.id,
    type,
    idempotencyKey,
  });
  if (milestone.deliveryState === "delivered" || milestone.commentId !== null) {
    return;
  }
  const remoteCommentId = await deliverMutation(
    input.store,
    input.gateway,
    job,
    job.taskId,
    "post_comment",
    idempotencyKey,
    request(undefined, truncate(body, input.maxCommentChars ?? 12000)),
  );
  if (remoteCommentId === null) {
    throw new Error("comment mutation did not return a remote comment ID");
  }
  await input.store.recordMilestoneComment(
    milestone.id,
    commentId(Number(remoteCommentId)),
  );
};

const failClaim = async (
  input: ClaimTaskInput,
  job: Job,
  error: unknown,
  moveAttempted: boolean,
  remoteRunning: boolean,
): Promise<ClaimResult> => {
  let shouldCompensate = false;
  let remoteStateUnknown = false;
  let overrideMessage: string | null = null;
  // A move response can be lost after Vikunja has applied the Ready -> Running
  // mutation, so remoteRunning is only a lower bound. Re-read before finalizing
  // every failed claim; the owner may also have selected another bucket while
  // the claim was failing. A known human override must never be overwritten.
  try {
    const current = await input.gateway.getTask(job.taskId);
    shouldCompensate =
      current.projectId === job.projectId &&
      !current.done &&
      current.bucketId === input.layout.buckets.Running.id;
    if (
      !shouldCompensate &&
      (remoteRunning ||
        current.projectId !== job.projectId ||
        current.done ||
        current.bucketId !== input.layout.buckets.Ready.id)
    ) {
      overrideMessage = `task state changed during claim (observed project ${current.projectId}, bucket ${current.bucketId}, done=${current.done}); the runner preserved the selected state.`;
    }
  } catch {
    // An unreadable remote state is ambiguous. The original Ready -> Running
    // intent must still be superseded before the failed job is finalized; a
    // separate expected-Running recovery intent below can safely retry after a
    // later startup observation.
    remoteStateUnknown = true;
  }

  if (moveAttempted) {
    // Never leave the original Ready -> Running intent pending after this job
    // becomes terminally failed: startup replay could resurrect the claim.
    try {
      await input.store.failMutation(
        `job:${job.id}:claim:move`,
        "claim finalized before remote move could be replayed",
      );
    } catch {
      // A completed intent is already safe; a missing intent can only occur if
      // durable intent creation failed before the remote call was attempted.
    }
  }

  const failureCode =
    overrideMessage === null ? "VIKUNJA_UNAVAILABLE" : "MANUAL_STATE_OVERRIDE";
  const detail =
    overrideMessage ??
    "claim could not be completed. Check the runner logs, then move the task back to Ready to retry.";
  const failureKey = `job:${job.id}:claim:failure`;
  const failureBody = truncate(
    `[pi-runner][idempotency:${failureKey}] ${failureCode}: ${detail}`,
    input.maxCommentChars ?? 12000,
  );
  const recoveryKey = `job:${job.id}:claim:move-failed`;
  const recoveryRequest = moveRequest(
    input.layout.buckets.Failed.id,
    input.layout.buckets.Running.id,
  );
  const terminalIntents: Parameters<JobStore["recordMutationIntent"]>[0][] = [];
  if (moveAttempted && (shouldCompensate || remoteStateUnknown)) {
    terminalIntents.push({
      jobId: job.id,
      taskId: job.taskId,
      operation: "move_task",
      idempotencyKey: recoveryKey,
      request: recoveryRequest,
    });
  }
  terminalIntents.push({
    jobId: job.id,
    taskId: job.taskId,
    operation: "post_comment",
    idempotencyKey: failureKey,
    request: { body: failureBody },
  });
  // Release the claim and persist every compensating action in one local
  // transaction. A crash can delay delivery, but cannot strand Running work
  // without a guarded Failed move to replay.
  const failed = await input.store.recordTerminalFailure(
    job.id,
    failureCode,
    terminalIntents,
  );
  if (moveAttempted && shouldCompensate) {
    try {
      await deliverMutation(
        input.store,
        input.gateway,
        job,
        job.taskId,
        "move_task",
        recoveryKey,
        recoveryRequest,
      );
    } catch {
      // Keep the pending recovery intent for startup reconciliation.
    }
  }
  try {
    await deliverCommentMilestone(
      input,
      job,
      "failure",
      failureKey,
      failureBody,
    );
  } catch {
    // The failed job and pending mutation intent remain durable for reconciliation.
  }
  return { status: "failed", job: failed, error };
};

const deliverStartMilestone = async (
  input: ClaimTaskInput,
  job: Job,
): Promise<void> => {
  const idempotencyKey = `job:${job.id}:claim:comment`;
  const branch = job.branch ?? taskBranchName(job.taskId, input.task.title);
  await deliverCommentMilestone(
    input,
    job,
    "claimed",
    idempotencyKey,
    `[pi-runner][idempotency:${idempotencyKey}] Claimed task ${job.taskId}.\nJob: ${job.id}\nBranch: ${branch}`,
  );
};

const reportClaimConflict = async (
  input: ClaimTaskInput,
  job: Job,
  current: CodingTask,
): Promise<void> => {
  const idempotencyKey = `job:${job.id}:claim:conflict`;
  try {
    await deliverCommentMilestone(
      input,
      job,
      "failure",
      idempotencyKey,
      `[pi-runner][idempotency:${idempotencyKey}] CLAIM_CONFLICT: task state changed before the claim could start (observed project ${current.projectId}, bucket ${current.bucketId}, done=${current.done}). The runner preserved the selected state; move the task to Ready to retry.`,
    );
  } catch {
    // Keep the durable milestone/mutation pending for startup reconciliation.
  }
};

/** Claim one Ready task using the short local claim then remote verification sequence. */
export const claimReadyTask = async (
  input: ClaimTaskInput,
): Promise<ClaimResult> => {
  if (
    input.task.done ||
    input.task.bucketId !== input.layout.buckets.Ready.id
  ) {
    return { status: "skipped" };
  }

  const job = await input.store.tryClaim(input.task, input.repository);
  if (job === null) return { status: "skipped" };

  let current: CodingTask;
  try {
    current = await input.gateway.getTask(input.task.id);
  } catch (error) {
    return failClaim(input, job, error, false, false);
  }
  if (
    current.projectId !== input.task.projectId ||
    current.done ||
    current.bucketId !== input.layout.buckets.Ready.id
  ) {
    const conflicted = await input.store.transition(job.id, {
      state: "failed",
      terminalErrorCode: "CLAIM_CONFLICT",
    });
    await reportClaimConflict(input, conflicted, current);
    return { status: "conflict", job: conflicted };
  }

  let moveAttempted = false;
  let remoteRunning = false;
  try {
    moveAttempted = true;
    await deliverMutation(
      input.store,
      input.gateway,
      job,
      job.taskId,
      "move_task",
      `job:${job.id}:claim:move`,
      moveRequest(
        input.layout.buckets.Running.id,
        input.layout.buckets.Ready.id,
      ),
    );
    remoteRunning = true;
    await deliverMutation(
      input.store,
      input.gateway,
      job,
      job.taskId,
      "assign_runner",
      `job:${job.id}:claim:assign`,
      {},
    );
    await deliverStartMilestone(input, job);
    const running = await input.store.transition(job.id, { state: "running" });
    return { status: "claimed", job: running };
  } catch (error) {
    return failClaim(input, job, error, moveAttempted, remoteRunning);
  }
};
