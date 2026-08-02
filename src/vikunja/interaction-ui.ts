import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import {
  reportManualOverride,
  withIdempotencyLock,
} from "../domain/idempotency.js";
import { validateQuestionResponse } from "../domain/interaction.js";
import type { Job, JobStore } from "../domain/jobs.js";
import {
  type BucketId,
  commentId,
  type ProjectLayout,
  type UserId,
} from "../domain/types.js";
import type { VikunjaGateway } from "./gateway.js";

/** Dependencies for the durable Vikunja-backed ask_user bridge. Spec §11.1. */
export interface VikunjaQuestionUiOptions {
  readonly gateway: VikunjaGateway;
  readonly store: JobStore;
  readonly job: Job;
  readonly layout: ProjectLayout;
  readonly ownerUserId: UserId;
  readonly maxCommentChars?: number;
  readonly pollIntervalMs?: number;
  /** Delay between comment polls; receives the dialog signal for prompt abort. */
  readonly sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

const defaultSleep = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Record every remote question mutation before delivery. The runtime guard is
 * intentional: small test doubles and older embedders may implement only the
 * interaction subset, while the production SqliteJobStore always supplies the
 * durable intent methods.
 */
const deliverMutation = async (
  options: VikunjaQuestionUiOptions,
  operation: "move_task" | "post_comment",
  idempotencyKey: string,
  request: Record<string, unknown>,
  deliver: () => Promise<string | null>,
): Promise<string | null> => {
  const recordIntent = options.store.recordMutationIntent;
  if (typeof recordIntent !== "function") return deliver();

  const intent = await recordIntent.call(options.store, {
    jobId: options.job.id,
    taskId: options.job.taskId,
    operation,
    idempotencyKey,
    request,
  });
  if (intent.state === "succeeded") return intent.remoteId;
  if (intent.state === "failed") {
    throw new Error(intent.error ?? `mutation ${idempotencyKey} failed`);
  }
  const remoteId = await deliver();
  await options.store.completeMutation(idempotencyKey, remoteId);
  return remoteId;
};

const deliverComment = async (
  options: VikunjaQuestionUiOptions,
  idempotencyKey: string,
  body: string,
): Promise<ReturnType<typeof commentId>> =>
  withIdempotencyLock(idempotencyKey, async () => {
    const remoteId = await deliverMutation(
      options,
      "post_comment",
      idempotencyKey,
      { body },
      async () =>
        String(await options.gateway.postComment(options.job.taskId, body)),
    );
    const numericId = Number(remoteId);
    if (!Number.isSafeInteger(numericId) || numericId < 1) {
      throw new Error(
        "question comment mutation returned an invalid remote ID",
      );
    }
    return commentId(numericId);
  });

class RetryableQuestionMoveError extends Error {
  public constructor(cause: unknown) {
    super("question bucket move could not be confirmed", { cause });
    this.name = "RetryableQuestionMoveError";
  }
}

const manualOverrideError = (task: {
  readonly projectId: number;
  readonly bucketId: number;
  readonly done: boolean;
}): Error => {
  const error = new Error(
    `task state changed while waiting (observed project ${task.projectId}, bucket ${task.bucketId}, done=${task.done})`,
  );
  error.name = "ManualStateOverrideError";
  return error;
};

const moveTask = async (
  options: VikunjaQuestionUiOptions,
  bucket: BucketId,
  expectedBucket: BucketId,
  idempotencyKey: string,
): Promise<void> => {
  await deliverMutation(
    options,
    "move_task",
    idempotencyKey,
    { bucketId: bucket, expectedBucketId: expectedBucket },
    async () => {
      let current: Awaited<ReturnType<VikunjaGateway["getTask"]>>;
      try {
        current = await options.gateway.getTask(options.job.taskId);
      } catch (error) {
        throw new RetryableQuestionMoveError(error);
      }
      const sameProject = current.projectId === options.job.projectId;
      if (sameProject && !current.done && current.bucketId === bucket) {
        return null;
      }
      if (!sameProject || current.done || current.bucketId !== expectedBucket) {
        if (typeof options.store.failMutation === "function") {
          await options.store.failMutation(
            idempotencyKey,
            `task state superseded move (project ${current.projectId}, bucket ${current.bucketId}, done=${current.done})`,
          );
        }
        throw manualOverrideError(current);
      }
      try {
        await options.gateway.moveTask(options.job.taskId, bucket);
      } catch (error) {
        throw new RetryableQuestionMoveError(error);
      }
      return null;
    },
  );
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = "\n[truncated]";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
};

const abortError = (reason: unknown): Error => {
  const message =
    reason instanceof Error ? reason.message : String(reason ?? "aborted");
  const error = new Error(`Vikunja question aborted: ${message}`);
  error.name = "AbortError";
  return error;
};

/**
 * Control comments are consumed by the live command monitor, not by the
 * waiting question. In particular, `/pi abort` must not become an input answer
 * while that monitor is asking the conductor to stop (Spec §11.2).
 */
const isPiControlComment = (body: string): boolean =>
  /^\/pi(?:\s|$)/i.test(body.trim());

/** Build a durable ExtensionUIContext backed by Vikunja comments. Spec §11.1. */
export const createVikunjaQuestionUi = (
  base: ExtensionUIContext,
  options: VikunjaQuestionUiOptions,
): ExtensionUIContext => {
  const maxCommentChars = options.maxCommentChars ?? 12000;
  const pollIntervalMs = options.pollIntervalMs ?? 15000;
  const sleep = options.sleep ?? defaultSleep;
  const moveTaskUntilConfirmed = async (
    bucket: BucketId,
    expectedBucket: BucketId,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw abortError(signal.reason);
      try {
        await moveTask(options, bucket, expectedBucket, idempotencyKey);
        return;
      } catch (error) {
        if (!(error instanceof RetryableQuestionMoveError)) {
          throw error;
        }
        if (signal?.aborted) throw abortError(signal.reason);
        await sleep(pollIntervalMs, signal);
      }
    }
  };

  const ask = async (
    kind: "input" | "confirm" | "select",
    prompt: string,
    choices: readonly string[],
    dialog: ExtensionUIDialogOptions | undefined,
  ): Promise<string> => {
    const signal = dialog?.signal;
    if (signal?.aborted) throw abortError(signal.reason);

    const question = await options.store.createQuestion({
      jobId: options.job.id,
      taskId: options.job.taskId,
      kind,
      prompt,
      options: choices,
      commentWatermark: await options.store.getCommentWatermark(
        options.job.taskId,
      ),
    });
    const questionCommentKey = `job:${options.job.id}:question:${question.id}:comment`;
    const questionMarker = `<!-- pi-runner:question:${question.id} -->`;
    const choicesText =
      choices.length === 0 ? "" : `\nOptions: ${choices.join(", ")}`;
    const questionBody = truncate(
      `[pi-runner][idempotency:${questionCommentKey}]\n${questionMarker}\n**Question**\n${prompt}${choicesText}`,
      maxCommentChars,
    );
    const questionCommentId = await deliverComment(
      options,
      questionCommentKey,
      questionBody,
    );
    await options.store.recordQuestionComment(question.id, questionCommentId);

    try {
      await moveTaskUntilConfirmed(
        options.layout.buckets.Waiting.id,
        options.layout.buckets.Running.id,
        `job:${options.job.id}:question:${question.id}:waiting`,
        signal,
      );
      await options.store.transition(options.job.id, { state: "waiting" });

      let cursor = questionCommentId;
      for (;;) {
        if (signal?.aborted) throw abortError(signal.reason);
        const currentTask =
          typeof options.gateway.getTask === "function"
            ? await options.gateway.getTask(options.job.taskId)
            : null;
        if (
          currentTask !== null &&
          (currentTask.projectId !== options.job.projectId ||
            currentTask.done ||
            currentTask.bucketId !== options.layout.buckets.Waiting.id)
        ) {
          await options.store.abortQuestion(
            question.id,
            "task moved while waiting for an answer",
          );
          try {
            await reportManualOverride({
              job: options.job,
              store: options.store,
              gateway: options.gateway,
              maxCommentChars,
            });
          } catch {
            // Preserve the failed local question; startup reconciliation can retry the report.
          }
          throw manualOverrideError(currentTask);
        }
        const comments = [
          ...(await options.gateway.listComments(options.job.taskId, cursor)),
        ].sort((left, right) => left.id - right.id);
        const correctionMarkers = new Set(
          comments
            .filter((comment) => comment.authorId !== options.ownerUserId)
            .flatMap((comment) => {
              const match = comment.body.match(
                /<!-- pi-runner:question-response:([^:]+):([0-9]+) -->/,
              );
              return match?.[1] === question.id ? [match[2]] : [];
            }),
        );
        for (const comment of comments) {
          cursor = comment.id;
          await options.store.recordCommentWatermark(
            options.job.taskId,
            comment.id,
          );
          if (comment.authorId !== options.ownerUserId) continue;
          // `/pi` commands belong to the concurrent live command monitor.
          // Skipping them here keeps an abort/steer/help command from being
          // interpreted as a plain answer (especially for `input`).
          if (isPiControlComment(comment.body)) continue;
          const result = validateQuestionResponse(
            question,
            { authorId: comment.authorId, body: comment.body },
            options.ownerUserId,
          );
          if (result.ok) {
            await moveTaskUntilConfirmed(
              options.layout.buckets.Running.id,
              options.layout.buckets.Waiting.id,
              `job:${options.job.id}:question:${question.id}:running`,
              signal,
            );
            await options.store.resolveQuestionAndResume(
              question.id,
              comment.id,
              result.answer,
            );
            return result.answer;
          }
          const correctionKey = `job:${options.job.id}:question:${question.id}:correction:${comment.id}`;
          const correctionMarker = `<!-- pi-runner:question-response:${question.id}:${comment.id} -->`;
          if (correctionMarkers.has(String(comment.id))) continue;
          await deliverComment(
            options,
            correctionKey,
            truncate(
              `[pi-runner][idempotency:${correctionKey}]\n${correctionMarker}\nQuestion response not accepted: ${result.reason}.`,
              maxCommentChars,
            ),
          );
        }
        await sleep(pollIntervalMs, signal);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "ManualStateOverrideError") {
        await options.store.abortQuestion(
          question.id,
          "task moved while entering or leaving Waiting",
        );
        try {
          await reportManualOverride({
            job: options.job,
            store: options.store,
            gateway: options.gateway,
            maxCommentChars,
          });
        } catch {
          // The terminal override is durable; reconciliation can retry its report.
        }
      }
      if (error instanceof Error && error.name === "AbortError") {
        const reason = signal?.reason;
        const reasonText =
          reason instanceof Error
            ? reason.message
            : typeof reason === "string"
              ? reason
              : "dialog aborted";
        await options.store.abortQuestion(
          question.id,
          reasonText.trim() === "" ? "dialog aborted" : reasonText,
        );
        // Keep the job Waiting until the conductor completion path records
        // the terminal bucket move and failure comment. If the process exits
        // first, startup reconciliation treats every stranded Waiting job as
        // WAIT_INTERRUPTED because the exact live tool call cannot be rebuilt.
      }
      throw error;
    }
  };

  return {
    ...base,
    input: (title, placeholder, dialog) =>
      ask(
        "input",
        `${title}${placeholder === undefined ? "" : `\n${placeholder}`}`,
        [],
        dialog,
      ),
    confirm: async (title, message, dialog) =>
      (await ask("confirm", `${title}\n${message}`, [], dialog)) === "yes",
    select: (title, choices, dialog) => ask("select", title, choices, dialog),
  };
};
