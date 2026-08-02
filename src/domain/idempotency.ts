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

/**
 * Mark a job as manually overridden without turning a concurrent transition
 * into a second failure. SqliteJobStore uses a compare-and-swap update, so a
 * monitor and ask_user bridge can race between their read and transition.
 */
export const markManualOverride = async (
  store: Pick<JobStore, "getJob" | "transition">,
  jobId: JobId,
): Promise<Job> => {
  const current = await store.getJob(jobId);
  if (current === null) throw new Error(`job ${jobId} was not found`);
  if (
    current.state === "failed" &&
    current.terminalErrorCode === "MANUAL_STATE_OVERRIDE"
  ) {
    return current;
  }
  try {
    return await store.transition(jobId, {
      state: "failed",
      terminalErrorCode: "MANUAL_STATE_OVERRIDE",
    });
  } catch (error) {
    // Another live path may have won the CAS transition. Re-read before
    // surfacing an error; only suppress the race when it produced the exact
    // terminal state this helper owns.
    const observed = await store.getJob(jobId);
    if (
      observed !== null &&
      observed.state === "failed" &&
      observed.terminalErrorCode === "MANUAL_STATE_OVERRIDE"
    ) {
      return observed;
    }
    throw error;
  }
};

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
    "getJob" | "transition" | "recordMutationIntent" | "completeMutation"
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
    const failed = await markManualOverride(input.store, input.job.id);
    const body = manualOverrideComment(failed.id, input.maxCommentChars);
    const intent = await input.store.recordMutationIntent({
      jobId: failed.id,
      taskId: failed.taskId,
      operation: "post_comment",
      idempotencyKey: key,
      request: { body },
    });
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
