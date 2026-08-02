import type { RemoteMutationIntent } from "../persistence/contracts.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import type { JobId, JobStore } from "./jobs.js";
import type { ProjectId, ProjectLayout, TaskId } from "./types.js";
import { bucketId } from "./types.js";

export interface StartupReconciliationInput {
  readonly store: JobStore;
  readonly gateway: Pick<
    VikunjaGateway,
    "getTask" | "moveTask" | "assignRunner" | "listComments" | "postComment"
  >;
  readonly layouts: ReadonlyMap<ProjectId, ProjectLayout>;
}

export interface StartupReconciliationReport {
  readonly jobsChecked: number;
  readonly jobsFailed: number;
  readonly questionsInterrupted: number;
  readonly manualOverrides: number;
  readonly mutationsReplayed: number;
  readonly mutationsPending: number;
  readonly mutationFailures: number;
  /** Recoverable jobs whose remote state was not confirmed during startup. */
  readonly deferredJobIds?: readonly JobId[];
}

interface ReconciliationRequest {
  readonly [key: string]: unknown;
}

const record = (value: unknown, field: string): ReconciliationRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReconciliationRequestError(`${field} must be an object`);
  }
  return value as ReconciliationRequest;
};

const stringValue = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReconciliationRequestError(`${field} must be a non-empty string`);
  }
  return value;
};

const positiveId = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ReconciliationRequestError(`${field} must be a positive integer`);
  }
  return value;
};

const runnerComment = (idempotencyKey: string, message: string): string =>
  `[pi-runner][idempotency:${idempotencyKey}] ${message}`;

/** Reconcile durable work before the daemon resumes any conductor session. Spec §§11.1 and 14. */
export async function reconcileStartup(
  input: StartupReconciliationInput,
): Promise<StartupReconciliationReport> {
  let mutationsReplayed = 0;
  let mutationsPending = 0;
  let mutationFailures = 0;
  for (const intent of await input.store.pendingMutationIntents()) {
    try {
      // Once a job is terminally failed, only a guarded move into its Failed
      // bucket remains applicable. Any other pending move belongs to an
      // earlier lifecycle stage (for example Ready -> Running or Running ->
      // Review) and could resurrect or overwrite the failed task on restart.
      // Mark it terminal without touching Vikunja; the explicit failure move
      // remains eligible for guarded replay.
      if (intent.jobId !== null) {
        const job = await input.store.getJob(intent.jobId);
        if (job?.state === "failed") {
          const reviewCommentKey = `job:${job.id}:completion:review-comment`;
          const staleClaimIntent =
            (intent.operation === "assign_runner" &&
              intent.idempotencyKey === `job:${job.id}:claim:assign`) ||
            (intent.operation === "post_comment" &&
              intent.idempotencyKey === `job:${job.id}:claim:comment`);
          if (staleClaimIntent) {
            await input.store.failMutation(
              intent.idempotencyKey,
              "claim mutation belongs to a terminally failed job",
            );
            mutationFailures += 1;
            continue;
          }
          if (
            intent.operation === "post_comment" &&
            intent.idempotencyKey === reviewCommentKey
          ) {
            await input.store.failMutation(
              intent.idempotencyKey,
              "review report belongs to a terminally failed job",
            );
            mutationFailures += 1;
            continue;
          }
          if (intent.operation === "move_task") {
            const layout = input.layouts.get(job.projectId);
            const request =
              typeof intent.request === "object" &&
              intent.request !== null &&
              !Array.isArray(intent.request)
                ? (intent.request as ReconciliationRequest)
                : null;
            const targetBucket =
              request === null ? undefined : request.bucketId;
            if (
              layout === undefined ||
              targetBucket !== layout.buckets.Failed.id
            ) {
              await input.store.failMutation(
                intent.idempotencyKey,
                "move belongs to a terminally failed job",
              );
              mutationFailures += 1;
              continue;
            }
          }
        }
      }
      // VikunjaHttpGateway resolves project/view routes from a prior task read.
      // Hydrate that location before replaying route-dependent mutations so a
      // fresh process can recover durable moves and assignments.
      if (
        intent.taskId !== null &&
        (intent.operation === "move_task" ||
          intent.operation === "assign_runner")
      ) {
        await input.gateway.getTask(intent.taskId);
      }
      const remoteId = await replayMutation(input.gateway, intent);
      await input.store.completeMutation(intent.idempotencyKey, remoteId);
      mutationsReplayed += 1;
    } catch (error) {
      if (error instanceof ReconciliationRequestError) {
        await input.store.failMutation(intent.idempotencyKey, error.message);
        mutationFailures += 1;
      } else {
        // A transport failure leaves the idempotent intent pending for the next startup.
        mutationsPending += 1;
      }
    }
  }

  const jobs = await input.store.recoverableJobs();
  const questions = await input.store.pendingQuestions();
  const questionsByJob = new Map(
    questions.map((question) => [question.jobId, question]),
  );
  let jobsFailed = 0;
  let questionsInterrupted = 0;
  let manualOverrides = 0;
  const deferredJobIds: JobId[] = [];

  for (const job of jobs) {
    let remoteTask: Awaited<ReturnType<typeof input.gateway.getTask>>;
    try {
      remoteTask = await input.gateway.getTask(job.taskId);
    } catch {
      // A transient Vikunja read must not prevent the daemon from starting.
      // Preserve the recoverable job and let the next startup retry the
      // observation before taking any bucket or terminal-state action. The
      // caller must not resume this job from the same unconfirmed snapshot.
      deferredJobIds.push(job.id);
      continue;
    }
    const layout = input.layouts.get(remoteTask.projectId);
    const question = questionsByJob.get(job.id);
    if (question !== undefined) {
      const sameActiveProject =
        layout !== undefined &&
        remoteTask.projectId === job.projectId &&
        !remoteTask.done;
      const isWaiting =
        sameActiveProject && remoteTask.bucketId === layout.buckets.Waiting.id;
      const acceptedAnswerMove = await input.store.getMutationIntent(
        `job:${job.id}:question:${question.id}:running`,
      );
      // The Waiting -> Running move is durable and may have succeeded just
      // before the process exited. The original in-memory tool call still
      // cannot be resumed, but this is a runner-owned interruption rather than
      // a human override and must be compensated from Running to Failed.
      const acceptedAnswerInterrupted =
        job.state === "waiting" &&
        sameActiveProject &&
        remoteTask.bucketId === layout.buckets.Running.id &&
        acceptedAnswerMove?.state === "succeeded";
      // A question is persisted before its Running -> Waiting move. A restart
      // in that window observes both local and remote Running state, but the
      // pending question proves the interruption was created by the runner.
      const preWaitingInterrupted =
        job.state === "running" &&
        sameActiveProject &&
        remoteTask.bucketId === layout.buckets.Running.id;
      const runnerOwnedInterruption =
        isWaiting || acceptedAnswerInterrupted || preWaitingInterrupted;
      const terminalErrorCode = runnerOwnedInterruption
        ? "WAIT_INTERRUPTED"
        : "MANUAL_STATE_OVERRIDE";
      const abortReason = "runner restarted while waiting for an answer";
      if (runnerOwnedInterruption) {
        const expectedBucketId =
          acceptedAnswerInterrupted || preWaitingInterrupted
            ? layout.buckets.Running.id
            : layout.buckets.Waiting.id;
        const moveKey = `job:${job.id}:startup-wait-failed:move`;
        const moveRequest = {
          bucketId: layout.buckets.Failed.id,
          expectedBucketId,
        };
        const commentKey = `job:${job.id}:startup-wait-failed:comment`;
        const commentRequest = {
          body: runnerComment(
            commentKey,
            `WAIT_INTERRUPTED: the daemon restarted while question ${question.id} was active. Move this task to Ready to retry.`,
          ),
        };
        await input.store.recordTerminalFailure(
          job.id,
          terminalErrorCode,
          [
            {
              jobId: job.id,
              taskId: remoteTask.id,
              operation: "move_task",
              idempotencyKey: moveKey,
              request: moveRequest,
            },
            {
              jobId: job.id,
              taskId: remoteTask.id,
              operation: "post_comment",
              idempotencyKey: commentKey,
              request: commentRequest,
            },
          ],
          abortReason,
        );
        jobsFailed += 1;
        questionsInterrupted += 1;
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "move_task",
          moveKey,
          moveRequest,
        );
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "post_comment",
          commentKey,
          commentRequest,
        );
      } else {
        const commentKey = `job:${job.id}:startup-manual-override:comment`;
        const commentRequest = {
          body: runnerComment(
            commentKey,
            `MANUAL_STATE_OVERRIDE: task state changed while question ${question.id} was pending; observed bucket ${remoteTask.bucketId}. The runner preserved the selected bucket.`,
          ),
        };
        await input.store.recordTerminalFailure(
          job.id,
          terminalErrorCode,
          [
            {
              jobId: job.id,
              taskId: remoteTask.id,
              operation: "post_comment",
              idempotencyKey: commentKey,
              request: commentRequest,
            },
          ],
          abortReason,
        );
        jobsFailed += 1;
        manualOverrides += 1;
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "post_comment",
          commentKey,
          commentRequest,
        );
      }
      continue;
    }

    if (layout === undefined || remoteTask.projectId !== job.projectId) {
      await input.store.transition(job.id, {
        state: "failed",
        terminalErrorCode: "MANUAL_STATE_OVERRIDE",
      });
      jobsFailed += 1;
      manualOverrides += 1;
      await deliverMutation(
        input,
        job.id,
        remoteTask.id,
        "post_comment",
        `job:${job.id}:startup-manual-override:comment`,
        {
          body: runnerComment(
            `job:${job.id}:startup-manual-override:comment`,
            `MANUAL_STATE_OVERRIDE: task was observed in project ${remoteTask.projectId}, which does not match the persisted project ${job.projectId}. The runner preserved the selected bucket.`,
          ),
        },
      );
      continue;
    }

    if (
      job.state === "running" &&
      !remoteTask.done &&
      remoteTask.bucketId === layout.buckets.Review.id
    ) {
      const reviewComment = await input.store.getMutationIntent(
        `job:${job.id}:completion:review-comment`,
      );
      const reviewMove = await input.store.getMutationIntent(
        `job:${job.id}:completion:move-review`,
      );
      if (
        reviewComment?.state === "succeeded" &&
        reviewMove?.state === "succeeded"
      ) {
        await input.store.transition(job.id, { state: "review" });
        continue;
      }
    }

    if (job.state === "claiming") {
      // A process can exit after the short local claim transaction but before
      // the claim reaches a conductor run. It is not safe to resume that
      // partial claim: doing so could duplicate assignment/start milestones.
      const stillRunnerOwned =
        !remoteTask.done && remoteTask.bucketId === layout.buckets.Running.id;
      const moveKey = `job:${job.id}:startup-claim-interrupted:move-failed`;
      const moveRequest = {
        bucketId: layout.buckets.Failed.id,
        expectedBucketId: layout.buckets.Running.id,
      };
      const commentKey = `job:${job.id}:startup-claim-interrupted:comment`;
      const commentRequest = {
        body: runnerComment(
          commentKey,
          stillRunnerOwned
            ? "CLAIM_CONFLICT: the daemon restarted during task claiming; the task was moved to Failed without starting a conductor run. Move it to Ready to retry."
            : "CLAIM_CONFLICT: the daemon restarted during task claiming; the runner preserved the task's current bucket. Move it to Ready to retry.",
        ),
      };
      const intents: Parameters<JobStore["recordMutationIntent"]>[0][] = [];
      if (stillRunnerOwned) {
        intents.push({
          jobId: job.id,
          taskId: remoteTask.id,
          operation: "move_task",
          idempotencyKey: moveKey,
          request: moveRequest,
        });
      }
      intents.push({
        jobId: job.id,
        taskId: remoteTask.id,
        operation: "post_comment",
        idempotencyKey: commentKey,
        request: commentRequest,
      });
      // Persist compensation before releasing the active slot. Delivery may
      // be interrupted, but startup will always have replayable actions.
      await input.store.recordTerminalFailure(
        job.id,
        "CLAIM_CONFLICT",
        intents,
      );
      jobsFailed += 1;
      if (stillRunnerOwned) {
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "move_task",
          moveKey,
          moveRequest,
        );
      } else if (
        remoteTask.bucketId !== layout.buckets.Ready.id ||
        remoteTask.done
      ) {
        manualOverrides += 1;
      }
      await deliverMutation(
        input,
        job.id,
        remoteTask.id,
        "post_comment",
        commentKey,
        commentRequest,
      );
      continue;
    }

    if (job.state === "waiting") {
      // A Waiting job always depended on an in-memory ask_user call. Even if
      // its question was resolved or aborted immediately before the crash,
      // the daemon cannot return that result to the original tool call after
      // restart, so fail safely rather than leaving the global slot stranded.
      const stillWaiting =
        !remoteTask.done && remoteTask.bucketId === layout.buckets.Waiting.id;
      if (stillWaiting) {
        const moveKey = `job:${job.id}:startup-wait-failed:move`;
        const moveRequest = {
          bucketId: layout.buckets.Failed.id,
          expectedBucketId: layout.buckets.Waiting.id,
        };
        const commentKey = `job:${job.id}:startup-wait-failed:comment`;
        const commentRequest = {
          body: runnerComment(
            commentKey,
            "WAIT_INTERRUPTED: the daemon restarted after the live question dialog was interrupted. No answer was fabricated; move this task to Ready to retry.",
          ),
        };
        await input.store.recordTerminalFailure(job.id, "WAIT_INTERRUPTED", [
          {
            jobId: job.id,
            taskId: remoteTask.id,
            operation: "move_task",
            idempotencyKey: moveKey,
            request: moveRequest,
          },
          {
            jobId: job.id,
            taskId: remoteTask.id,
            operation: "post_comment",
            idempotencyKey: commentKey,
            request: commentRequest,
          },
        ]);
        jobsFailed += 1;
        questionsInterrupted += 1;
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "move_task",
          moveKey,
          moveRequest,
        );
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "post_comment",
          commentKey,
          commentRequest,
        );
      } else {
        const commentKey = `job:${job.id}:startup-manual-override:comment`;
        const commentRequest = {
          body: runnerComment(
            commentKey,
            `MANUAL_STATE_OVERRIDE: the live question dialog was interrupted and bucket ${remoteTask.bucketId} was preserved.`,
          ),
        };
        await input.store.recordTerminalFailure(
          job.id,
          "MANUAL_STATE_OVERRIDE",
          [
            {
              jobId: job.id,
              taskId: remoteTask.id,
              operation: "post_comment",
              idempotencyKey: commentKey,
              request: commentRequest,
            },
          ],
        );
        jobsFailed += 1;
        manualOverrides += 1;
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "post_comment",
          commentKey,
          commentRequest,
        );
      }
      continue;
    }

    const expectedBucket = layout.buckets.Running.id;
    if (remoteTask.done || remoteTask.bucketId !== expectedBucket) {
      await input.store.transition(job.id, {
        state: "failed",
        terminalErrorCode: "MANUAL_STATE_OVERRIDE",
      });
      jobsFailed += 1;
      manualOverrides += 1;
      await deliverMutation(
        input,
        job.id,
        remoteTask.id,
        "post_comment",
        `job:${job.id}:startup-manual-override:comment`,
        {
          body: runnerComment(
            `job:${job.id}:startup-manual-override:comment`,
            `MANUAL_STATE_OVERRIDE: expected bucket ${expectedBucket} and done=false for ${job.state} job but observed bucket ${remoteTask.bucketId}, done=${remoteTask.done}. The runner preserved the selected state.`,
          ),
        },
      );
    }
  }

  return {
    jobsChecked: jobs.length,
    jobsFailed,
    questionsInterrupted,
    manualOverrides,
    mutationsReplayed,
    mutationsPending,
    mutationFailures,
    deferredJobIds,
  };
}

class ReconciliationRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReconciliationRequestError";
  }
}

const replayMutation = async (
  gateway: StartupReconciliationInput["gateway"],
  intent: RemoteMutationIntent,
): Promise<string | null> => {
  if (intent.taskId === null) {
    throw new ReconciliationRequestError(
      `mutation ${intent.idempotencyKey} has no task ID`,
    );
  }
  const request = record(intent.request, `mutation ${intent.idempotencyKey}`);
  switch (intent.operation) {
    case "move_task": {
      const expectedBucket = request.expectedBucketId;
      if (expectedBucket === undefined) {
        throw new ReconciliationRequestError(
          `mutation ${intent.idempotencyKey} is missing expectedBucketId`,
        );
      }
      const expected = positiveId(
        expectedBucket,
        `${intent.idempotencyKey}.expectedBucketId`,
      );
      const current = await gateway.getTask(intent.taskId);
      if (current.done || current.bucketId !== expected) return null;
      await gateway.moveTask(
        intent.taskId,
        bucketId(
          positiveId(request.bucketId, `${intent.idempotencyKey}.bucketId`),
        ),
      );
      return null;
    }
    case "assign_runner":
      await gateway.assignRunner(intent.taskId);
      return null;
    case "post_comment": {
      const body = stringValue(request.body, `${intent.idempotencyKey}.body`);
      const existing = await gateway.listComments(intent.taskId, null);
      const delivered = existing.find((comment) => comment.body === body);
      if (delivered !== undefined) return String(delivered.id);
      return String(await gateway.postComment(intent.taskId, body));
    }
    default:
      throw new ReconciliationRequestError(
        `unsupported remote mutation operation: ${intent.operation}`,
      );
  }
};

const deliverMutation = async (
  input: StartupReconciliationInput,
  jobId: Parameters<JobStore["recordMutationIntent"]>[0]["jobId"],
  taskId: TaskId,
  operation: string,
  idempotencyKey: string,
  request: ReconciliationRequest,
): Promise<void> => {
  const intent = await input.store.recordMutationIntent({
    jobId,
    taskId,
    operation,
    idempotencyKey,
    request,
  });
  if (intent.state !== "pending") return;
  try {
    const remoteId = await replayMutation(input.gateway, intent);
    await input.store.completeMutation(idempotencyKey, remoteId);
  } catch {
    // Keep the intent pending. A later startup can retry without losing the action.
  }
};
