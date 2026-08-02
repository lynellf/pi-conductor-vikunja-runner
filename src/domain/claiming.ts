import type { VikunjaGateway } from "../vikunja/gateway.js";
import { taskBranchName } from "./branch.js";
import type { Job, JobStore } from "./jobs.js";
import type { CodingTask, ProjectLayout, TaskId } from "./types.js";
import { bucketId, commentId } from "./types.js";

export interface ClaimTaskInput {
  readonly task: CodingTask;
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
  remoteRunning: boolean,
): Promise<ClaimResult> => {
  let shouldCompensate = remoteRunning;
  let overrideMessage: string | null = null;
  // A failure can happen after the Ready -> Running move has reached Vikunja
  // but before assignment or the start milestone completes. Re-read before
  // compensating: the owner may have selected another bucket while the claim
  // was failing. A known human override must never be overwritten.
  if (shouldCompensate) {
    try {
      const current = await input.gateway.getTask(job.taskId);
      shouldCompensate =
        current.projectId === job.projectId &&
        !current.done &&
        current.bucketId === input.layout.buckets.Running.id;
      if (!shouldCompensate) {
        overrideMessage = `task state changed during claim (observed project ${current.projectId}, bucket ${current.bucketId}, done=${current.done}); the runner preserved the selected state.`;
      }
    } catch {
      // An unreadable remote state is ambiguous; leave the intent absent
      // rather than risking a destructive bucket overwrite.
      shouldCompensate = false;
    }
  }

  const failureCode =
    overrideMessage === null ? "VIKUNJA_UNAVAILABLE" : "MANUAL_STATE_OVERRIDE";
  const failed = await input.store.transition(job.id, {
    state: "failed",
    terminalErrorCode: failureCode,
  });
  try {
    if (shouldCompensate) {
      await deliverMutation(
        input.store,
        input.gateway,
        job,
        job.taskId,
        "move_task",
        `job:${job.id}:claim:move-failed`,
        moveRequest(
          input.layout.buckets.Failed.id,
          input.layout.buckets.Running.id,
        ),
      );
    }
  } catch {
    // Keep the move intent pending so startup reconciliation can retry it.
  }
  try {
    const idempotencyKey = `job:${job.id}:claim:failure`;
    const detail =
      overrideMessage ??
      "claim could not be completed. Check the runner logs, then move the task back to Ready to retry.";
    await deliverCommentMilestone(
      input,
      job,
      "failure",
      idempotencyKey,
      `[pi-runner][idempotency:${idempotencyKey}] ${failureCode}: ${detail}`,
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

  const job = await input.store.tryClaim(input.task);
  if (job === null) return { status: "skipped" };

  let current: CodingTask;
  try {
    current = await input.gateway.getTask(input.task.id);
  } catch (error) {
    return failClaim(input, job, error, false);
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

  let remoteRunning = false;
  try {
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
    return failClaim(input, job, error, remoteRunning);
  }
};
