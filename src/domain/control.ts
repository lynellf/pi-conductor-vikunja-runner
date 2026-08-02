import type { ConductorHandle } from "../conductor/gateway.js";
import type { Milestone } from "../persistence/contracts.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import { type PiCommentAction, parsePiComment } from "./commands.js";
import { reportManualOverride, withIdempotencyLock } from "./idempotency.js";
import type { Job, JobStore } from "./jobs.js";
import type { CommentId, ProjectLayout, TaskComment, UserId } from "./types.js";

export interface ExecutePiCommentInput {
  readonly job: Job;
  readonly commentId: CommentId;
  readonly action: PiCommentAction;
  readonly handle: ConductorHandle;
  readonly store: JobStore;
  readonly gateway: Pick<VikunjaGateway, "postComment">;
  readonly maxCommentChars?: number;
  /** Stop completion side effects after an owner requests cancellation. */
  readonly onAbortRequested?: () => void;
}

export type ExecutePiCommentResult =
  | { readonly status: "ignored" }
  | { readonly status: "handled" };

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = "\n[truncated]";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
};

const mutationRequest = (body: string): Record<string, string> => ({ body });

const commentIdFromRemote = (remoteId: string): CommentId => {
  const numericId = Number(remoteId);
  if (!Number.isSafeInteger(numericId) || numericId < 1) {
    throw new Error("comment mutation returned an invalid remote comment ID");
  }
  return numericId as CommentId;
};

type CommentMutationInput = Pick<
  ExecutePiCommentInput,
  "job" | "store" | "gateway" | "maxCommentChars"
>;

const postIdempotentComment = async (
  input: CommentMutationInput,
  idempotencyKey: string,
  body: string,
): Promise<CommentId> =>
  withIdempotencyLock(idempotencyKey, async () => {
    const intent = await input.store.recordMutationIntent({
      jobId: input.job.id,
      taskId: input.job.taskId,
      operation: "post_comment",
      idempotencyKey,
      request: mutationRequest(body),
    });
    if (intent.state === "succeeded") {
      if (intent.remoteId === null) {
        throw new Error("completed comment mutation has no remote comment ID");
      }
      return commentIdFromRemote(intent.remoteId);
    }
    if (intent.state === "failed") {
      throw new Error(intent.error ?? `comment ${idempotencyKey} failed`);
    }
    const remoteCommentId = await input.gateway.postComment(
      input.job.taskId,
      body,
    );
    await input.store.completeMutation(idempotencyKey, String(remoteCommentId));
    return remoteCommentId;
  });

const postMilestone = async (
  input: ExecutePiCommentInput,
  type: Extract<Milestone["type"], "steering" | "abort">,
  idempotencyKey: string,
  body: string,
): Promise<void> => {
  const existing = await input.store.getMilestone(input.job.id, idempotencyKey);
  if (existing !== null && existing.commentId !== null) return;

  const milestone =
    existing ??
    (await input.store.recordMilestone({
      jobId: input.job.id,
      type,
      idempotencyKey,
    }));
  if (milestone.commentId !== null || milestone.deliveryState === "delivered") {
    return;
  }
  const remoteCommentId = await postIdempotentComment(
    input,
    idempotencyKey,
    body,
  );
  await input.store.recordMilestoneComment(milestone.id, remoteCommentId);
};

const acknowledge = (
  input: ExecutePiCommentInput,
  key: string,
  message: string,
): string =>
  truncate(
    `[pi-runner][idempotency:${key}] ${message}`,
    input.maxCommentChars ?? 12000,
  );

/** Route one already-authorized owner command to the live conductor handle. */
export const executePiComment = async (
  input: ExecutePiCommentInput,
): Promise<ExecutePiCommentResult> => {
  const { action } = input;
  if (action.kind === "ignore") return { status: "ignored" };

  const keyBase = `job:${input.job.id}:comment:${input.commentId}`;
  if (action.kind === "steer") {
    // The monitor retains its startup snapshot while ask_user transitions the
    // durable row to Waiting. Dispatch only from the current persisted state.
    const currentJob = await input.store.getJob(input.job.id);
    if (currentJob?.state !== "running") return { status: "ignored" };
    const key = `${keyBase}:steer`;
    const existing = await input.store.getMilestone(input.job.id, key);
    if (existing === null) {
      // Persist the at-most-once dispatch boundary before invoking the
      // non-idempotent conductor handle. Recovery may retry acknowledgement
      // delivery, but must never apply the same steering command twice.
      await input.store.recordMilestone({
        jobId: input.job.id,
        type: "steering",
        idempotencyKey: key,
      });
      await input.handle.steer(action.message);
      await postMilestone(
        input,
        "steering",
        key,
        acknowledge(input, key, `Steering delivered: ${action.message}`),
      );
    } else {
      await postMilestone(
        input,
        "steering",
        key,
        acknowledge(input, key, "Steering delivered."),
      );
    }
    return { status: "handled" };
  }

  if (action.kind === "abort") {
    if (input.job.state !== "running" && input.job.state !== "waiting") {
      return { status: "ignored" };
    }
    const key = `${keyBase}:abort`;
    input.onAbortRequested?.();
    const existing = await input.store.getMilestone(input.job.id, key);
    if (existing === null) {
      await input.handle.abort(action.reason ?? "owner requested abort");
      await postMilestone(
        input,
        "abort",
        key,
        acknowledge(
          input,
          key,
          `Abort requested${action.reason === null ? "." : `: ${action.reason}`}`,
        ),
      );
    } else {
      await postMilestone(
        input,
        "abort",
        key,
        acknowledge(input, key, "Abort requested."),
      );
    }
    return { status: "handled" };
  }

  if (action.kind === "help") {
    const key = `${keyBase}:help`;
    await postIdempotentComment(
      input,
      key,
      acknowledge(input, key, action.message),
    );
    return { status: "handled" };
  }

  return { status: "ignored" };
};

export interface PiCommentMonitorInput {
  readonly job: Job;
  readonly handle: ConductorHandle;
  readonly ownerUserId: UserId;
  readonly store: JobStore;
  readonly gateway: Pick<VikunjaGateway, "listComments" | "postComment"> &
    Partial<Pick<VikunjaGateway, "getTask">>;
  readonly layout?: ProjectLayout;
  readonly pollIntervalMs?: number;
  readonly maxCommentChars?: number;
  /** The last comment already consumed while constructing the conductor goal. */
  readonly initialCommentId?: CommentId | null;
  readonly logError?: (error: Error) => void;
  /** Propagate owner abort commands to the completion pipeline. */
  readonly onAbortRequested?: () => void;
}

export interface PiCommentMonitor {
  readonly done: Promise<void>;
  readonly stop: () => void;
}

const sleepUntil = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

const latestCommentId = (
  comments: readonly TaskComment[],
): CommentId | null => {
  const latest = comments.reduce<CommentId | null>(
    (current, comment) =>
      current === null || comment.id > current ? comment.id : current,
    null,
  );
  return latest;
};

const isExpectedQuestionTransition = async (
  input: PiCommentMonitorInput,
  currentJob: Job,
  task: {
    readonly projectId: number;
    readonly bucketId: number;
    readonly done: boolean;
  },
): Promise<boolean> => {
  if (
    input.layout === undefined ||
    task.projectId !== currentJob.projectId ||
    task.done
  ) {
    return false;
  }
  const getActiveQuestion = input.store.getActiveQuestion;
  const getMutationIntent = input.store.getMutationIntent;
  if (
    typeof getActiveQuestion !== "function" ||
    typeof getMutationIntent !== "function"
  ) {
    return false;
  }

  const transition =
    currentJob.state === "running" &&
    task.bucketId === input.layout.buckets.Waiting.id
      ? {
          suffix: "waiting",
          bucketId: input.layout.buckets.Waiting.id,
          expectedBucketId: input.layout.buckets.Running.id,
        }
      : currentJob.state === "waiting" &&
          task.bucketId === input.layout.buckets.Running.id
        ? {
            suffix: "running",
            bucketId: input.layout.buckets.Running.id,
            expectedBucketId: input.layout.buckets.Waiting.id,
          }
        : null;
  if (transition === null) return false;

  const question = await getActiveQuestion.call(input.store, currentJob.id);
  if (question === null) return false;
  const key = `job:${currentJob.id}:question:${question.id}:${transition.suffix}`;
  const intent = await getMutationIntent.call(input.store, key);
  if (
    intent === null ||
    intent.jobId !== currentJob.id ||
    intent.taskId !== currentJob.taskId ||
    intent.operation !== "move_task" ||
    intent.state === "failed" ||
    typeof intent.request !== "object" ||
    intent.request === null ||
    Array.isArray(intent.request)
  ) {
    return false;
  }
  const request = intent.request as Record<string, unknown>;
  return (
    request.bucketId === transition.bucketId &&
    request.expectedBucketId === transition.expectedBucketId
  );
};

const jobMatchesTask = (
  job: Job,
  task: {
    readonly projectId: number;
    readonly bucketId: number;
    readonly done: boolean;
  },
  layout: ProjectLayout,
): boolean => {
  const expectedBucket =
    job.state === "waiting"
      ? layout.buckets.Waiting.id
      : layout.buckets.Running.id;
  return (
    task.projectId === job.projectId &&
    !task.done &&
    task.bucketId === expectedBucket
  );
};

const observeManualOverride = async (
  input: PiCommentMonitorInput,
  controller: AbortController,
): Promise<boolean> => {
  if (input.layout === undefined) return true;
  const getTask = input.gateway.getTask;
  if (typeof getTask !== "function") return true;
  if (typeof input.store.getJob !== "function") return true;
  let currentJob = await input.store.getJob(input.job.id);
  if (currentJob === null) return false;
  if (currentJob.state !== "running" && currentJob.state !== "waiting") {
    return false;
  }
  const task = await getTask(input.job.taskId);
  if (
    jobMatchesTask(currentJob, task, input.layout) ||
    (await isExpectedQuestionTransition(input, currentJob, task))
  ) {
    return true;
  }

  // The question bridge can atomically update the question and job between
  // the reads above. Re-read before treating a stale job snapshot as human
  // input; the remote task may already match the newly persisted state.
  const latestJob = await input.store.getJob(input.job.id);
  if (
    latestJob === null ||
    (latestJob.state !== "running" && latestJob.state !== "waiting")
  ) {
    return false;
  }
  currentJob = latestJob;
  if (
    jobMatchesTask(currentJob, task, input.layout) ||
    (await isExpectedQuestionTransition(input, currentJob, task))
  ) {
    return true;
  }

  try {
    await input.handle.abort("owner selected another task bucket");
  } catch {
    // The local terminal state and durable report are still authoritative.
  }
  try {
    await reportManualOverride({
      job: currentJob,
      store: input.store,
      gateway: input.gateway,
      maxCommentChars: input.maxCommentChars ?? 12000,
    });
  } catch (error) {
    (input.logError ?? (() => undefined))(
      error instanceof Error
        ? error
        : new Error("manual override comment delivery failed"),
    );
  }
  controller.abort();
  return false;
};

/**
 * Watch owner comments while a live conductor run is active. Plain comments
 * are intentionally ignored here because they are retry context, not live
 * steering. Remote failures are logged and retried without failing the run.
 * Spec §11.2.
 */
export const startPiCommentMonitor = (
  input: PiCommentMonitorInput,
): PiCommentMonitor => {
  const controller = new AbortController();
  const interval = input.pollIntervalMs ?? 15000;
  const logError = input.logError ?? (() => undefined);
  const done = (async (): Promise<void> => {
    let cursor =
      input.initialCommentId !== undefined
        ? input.initialCommentId
        : await input.store.getCommentWatermark(input.job.taskId);
    try {
      // A resumed job may have no watermark from its previous process. Skip
      // historical comments once, then only inspect comments added live.
      if (cursor === null && input.initialCommentId === undefined) {
        const existing = await input.gateway.listComments(
          input.job.taskId,
          null,
        );
        cursor = latestCommentId(existing);
        if (cursor !== null) {
          await input.store.recordCommentWatermark(input.job.taskId, cursor);
        }
      }
      await sleepUntil(interval, controller.signal);
      while (!controller.signal.aborted) {
        try {
          const comments = [
            ...(await input.gateway.listComments(input.job.taskId, cursor)),
          ].sort((left, right) => left.id - right.id);
          // A queued command may have arrived alongside an owner-selected
          // bucket change. Observe remote state after reading the batch but
          // before dispatching any non-idempotent conductor command.
          if (!(await observeManualOverride(input, controller))) break;
          for (const comment of comments) {
            if (controller.signal.aborted) break;
            try {
              const action = parsePiComment(
                comment.body,
                comment.authorId,
                input.ownerUserId,
              );
              if (action.kind !== "ignore" && action.kind !== "plain") {
                await executePiComment({
                  job: input.job,
                  commentId: comment.id,
                  action,
                  handle: input.handle,
                  store: input.store,
                  gateway: input.gateway,
                  ...(input.maxCommentChars === undefined
                    ? {}
                    : { maxCommentChars: input.maxCommentChars }),
                  ...(input.onAbortRequested === undefined
                    ? {}
                    : { onAbortRequested: input.onAbortRequested }),
                });
              }
              // Advance only after the command and its acknowledgement have
              // completed. A failed delivery must be retried on the next poll.
              await input.store.recordCommentWatermark(
                input.job.taskId,
                comment.id,
              );
              cursor = comment.id;
            } catch (error) {
              logError(
                error instanceof Error ? error : new Error(String(error)),
              );
              break;
            }
          }
        } catch (error) {
          logError(error instanceof Error ? error : new Error(String(error)));
        }
        await sleepUntil(interval, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();
  return {
    done,
    stop: () => controller.abort(),
  };
};
