import type { RemoteMutationIntent } from "../persistence/contracts.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import type { JobStore } from "./jobs.js";
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

  for (const job of jobs) {
    let remoteTask: Awaited<ReturnType<typeof input.gateway.getTask>>;
    try {
      remoteTask = await input.gateway.getTask(job.taskId);
    } catch {
      // A transient Vikunja read must not prevent the daemon from starting.
      // Preserve the recoverable job and let the next poll/startup retry the
      // observation before taking any bucket or terminal-state action.
      continue;
    }
    const layout = input.layouts.get(remoteTask.projectId);
    const question = questionsByJob.get(job.id);
    if (question !== undefined) {
      await input.store.abortQuestion(
        question.id,
        "runner restarted while waiting for an answer",
      );
      const isWaiting =
        layout !== undefined &&
        remoteTask.projectId === job.projectId &&
        remoteTask.bucketId === layout.buckets.Waiting.id;
      const terminalErrorCode = isWaiting
        ? "WAIT_INTERRUPTED"
        : "MANUAL_STATE_OVERRIDE";
      await input.store.transition(job.id, {
        state: "failed",
        terminalErrorCode,
      });
      jobsFailed += 1;
      if (isWaiting) {
        questionsInterrupted += 1;
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "move_task",
          `job:${job.id}:startup-wait-failed:move`,
          { bucketId: layout.buckets.Failed.id },
        );
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "post_comment",
          `job:${job.id}:startup-wait-failed:comment`,
          {
            body: runnerComment(
              `job:${job.id}:startup-wait-failed:comment`,
              `WAIT_INTERRUPTED: the daemon restarted while waiting for question ${question.id}. Move this task to Ready to retry.`,
            ),
          },
        );
      } else {
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
              `MANUAL_STATE_OVERRIDE: task state changed while question ${question.id} was pending; observed bucket ${remoteTask.bucketId}. The runner preserved the selected bucket.`,
            ),
          },
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

    if (job.state === "claiming") {
      // A process can exit after the short local claim transaction but before
      // the claim reaches a conductor run. It is not safe to resume that
      // partial claim: doing so could duplicate assignment/start milestones.
      // Release the local active slot and preserve any owner-selected bucket.
      await input.store.transition(job.id, {
        state: "failed",
        terminalErrorCode: "CLAIM_CONFLICT",
      });
      jobsFailed += 1;
      const stillRunnerOwned =
        !remoteTask.done && remoteTask.bucketId === layout.buckets.Running.id;
      if (stillRunnerOwned) {
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "move_task",
          `job:${job.id}:startup-claim-interrupted:move-failed`,
          { bucketId: layout.buckets.Failed.id },
        );
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "post_comment",
          `job:${job.id}:startup-claim-interrupted:comment`,
          {
            body: runnerComment(
              `job:${job.id}:startup-claim-interrupted:comment`,
              "CLAIM_CONFLICT: the daemon restarted during task claiming; the task was moved to Failed without starting a conductor run. Move it to Ready to retry.",
            ),
          },
        );
      } else {
        if (
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
          `job:${job.id}:startup-claim-interrupted:comment`,
          {
            body: runnerComment(
              `job:${job.id}:startup-claim-interrupted:comment`,
              "CLAIM_CONFLICT: the daemon restarted during task claiming; the runner preserved the task's current bucket. Move it to Ready to retry.",
            ),
          },
        );
      }
      continue;
    }

    if (job.state === "waiting") {
      // A Waiting job always depended on an in-memory ask_user call. Even if
      // its question was resolved or aborted immediately before the crash,
      // the daemon cannot return that result to the original tool call after
      // restart, so fail safely rather than leaving the global slot stranded.
      await input.store.transition(job.id, {
        state: "failed",
        terminalErrorCode: "WAIT_INTERRUPTED",
      });
      jobsFailed += 1;
      const stillWaiting =
        !remoteTask.done && remoteTask.bucketId === layout.buckets.Waiting.id;
      if (stillWaiting) {
        questionsInterrupted += 1;
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "move_task",
          `job:${job.id}:startup-wait-failed:move`,
          { bucketId: layout.buckets.Failed.id },
        );
        await deliverMutation(
          input,
          job.id,
          remoteTask.id,
          "post_comment",
          `job:${job.id}:startup-wait-failed:comment`,
          {
            body: runnerComment(
              `job:${job.id}:startup-wait-failed:comment`,
              "WAIT_INTERRUPTED: the daemon restarted after the live question dialog was interrupted. No answer was fabricated; move this task to Ready to retry.",
            ),
          },
        );
      } else {
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
              `MANUAL_STATE_OVERRIDE: the live question dialog was interrupted and bucket ${remoteTask.bucketId} was preserved.`,
            ),
          },
        );
      }
      continue;
    }

    const expectedBucket = layout.buckets.Running.id;
    if (remoteTask.bucketId !== expectedBucket) {
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
            `MANUAL_STATE_OVERRIDE: expected bucket ${expectedBucket} for ${job.state} job but observed ${remoteTask.bucketId}. The runner preserved the selected bucket.`,
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
      if (expectedBucket !== undefined) {
        const expected = positiveId(
          expectedBucket,
          `${intent.idempotencyKey}.expectedBucketId`,
        );
        const current = await gateway.getTask(intent.taskId);
        if (current.done || current.bucketId !== expected) return null;
      }
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
