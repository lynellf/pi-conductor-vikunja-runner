/**
 * Serialize delivery for one idempotency key within this single runner
 * process. SQLite makes the intent durable across restarts, while this
 * in-process gate prevents two live paths from both delivering a pending
 * intent before either can mark it succeeded.
 */
import type { Job, JobId, JobStore } from "./jobs.js";
import type { CommentId, TaskId } from "./types.js";

const inFlight = new Map<string, Promise<unknown>>();

/** Stable key shared by every live path reporting one bucket override. */
export const manualOverrideKey = (jobId: JobId): string =>
  `job:${jobId}:manual-state-override`;

export const manualOverrideComment = (
  jobId: JobId,
  maxChars: number,
): string => {
  const key = manualOverrideKey(jobId);
  const body =
    `[pi-runner][idempotency:${key}] MANUAL_STATE_OVERRIDE: ` +
    "the task state changed while the runner was active. The runner preserved " +
    "the selected bucket; move the task to Ready to retry if needed.";
  if (body.length <= maxChars) return body;
  const marker = "\n[truncated]";
  if (maxChars <= marker.length) return body.slice(0, maxChars);
  return `${body.slice(0, maxChars - marker.length)}${marker}`;
};

/**
 * Atomically coordinate the local terminal transition and its one report.
 * Both the live comment monitor and the durable ask_user bridge call this
 * helper, so they cannot independently win the same override and emit two
 * reports. The mutation intent remains durable for restart replay.
 */
export const reportManualOverride = async (input: {
  readonly job: Pick<Job, "id" | "taskId">;
  readonly store: Pick<
    JobStore,
    | "getJob"
    | "recordTerminalFailure"
    | "recordMutationIntent"
    | "completeMutation"
  >;
  readonly gateway: {
    postComment(taskId: TaskId, body: string): Promise<CommentId>;
    listComments?: (
      taskId: TaskId,
      after: CommentId | null,
    ) => Promise<readonly { readonly id: CommentId; readonly body: string }[]>;
  };
  readonly maxCommentChars: number;
}): Promise<Job> => {
  const key = manualOverrideKey(input.job.id);
  return withIdempotencyLock(key, async () => {
    let failed = await input.store.getJob(input.job.id);
    if (failed === null) throw new Error(`job ${input.job.id} was not found`);
    const body = manualOverrideComment(failed.id, input.maxCommentChars);
    const mutation = {
      jobId: failed.id,
      taskId: failed.taskId,
      operation: "post_comment",
      idempotencyKey: key,
      request: { body },
    } as const;
    if (
      failed.state !== "failed" ||
      failed.terminalErrorCode !== "MANUAL_STATE_OVERRIDE"
    ) {
      try {
        // Make terminal state and its owner-facing explanation visible in one
        // SQLite transaction. Restart replay can therefore never observe the
        // failed job without the durable report intent.
        failed = await input.store.recordTerminalFailure(
          failed.id,
          "MANUAL_STATE_OVERRIDE",
          [mutation],
          "task state changed while the runner was active",
        );
      } catch (error) {
        // The monitor and ask_user bridge can race. Suppress only a competing
        // transition that produced this exact terminal state; its atomic
        // transaction also persisted the same idempotency key.
        const observed = await input.store.getJob(input.job.id);
        if (
          observed === null ||
          observed.state !== "failed" ||
          observed.terminalErrorCode !== "MANUAL_STATE_OVERRIDE"
        ) {
          throw error;
        }
        failed = observed;
      }
    }
    const intent = await input.store.recordMutationIntent(mutation);
    if (intent.state === "succeeded") return failed;
    if (intent.state === "failed") {
      throw new Error(intent.error ?? `comment ${key} failed`);
    }
    // A transport error can happen after Vikunja accepted the comment but
    // before SQLite records success. Re-read the task comments before retrying
    // so durable replay and a concurrent live path cannot post a duplicate.
    if (input.gateway.listComments !== undefined) {
      const existing = await input.gateway.listComments(failed.taskId, null);
      const delivered = existing.find((comment) => comment.body === body);
      if (delivered !== undefined) {
        await input.store.completeMutation(key, String(delivered.id));
        return failed;
      }
    }
    const remoteCommentId = await input.gateway.postComment(
      failed.taskId,
      body,
    );
    await input.store.completeMutation(key, String(remoteCommentId));
    return failed;
  });
};

export const withIdempotencyLock = async <T>(
  key: string,
  deliver: () => Promise<T>,
): Promise<T> => {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing !== undefined) return existing;

  const current = deliver();
  inFlight.set(key, current);
  try {
    return await current;
  } finally {
    if (inFlight.get(key) === current) inFlight.delete(key);
  }
};
