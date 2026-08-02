import { describe, expect, it } from "vitest";
import type { ConductorHandle } from "../src/conductor/gateway.js";
import { startPiCommentMonitor } from "../src/domain/control.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import type {
  BucketId,
  ProjectLayout,
  TaskComment,
} from "../src/domain/types.js";
import {
  bucketId,
  commentId,
  projectId,
  taskId,
  userId,
  viewId,
} from "../src/domain/types.js";
import type { Question } from "../src/persistence/contracts.js";
import type { VikunjaGateway } from "../src/vikunja/gateway.js";
import { createVikunjaQuestionUi } from "../src/vikunja/interaction-ui.js";

const job: Job = {
  id: "job-concurrent" as Job["id"],
  taskId: taskId(12),
  projectId: projectId(42),
  attempt: 1,
  state: "running",
  branch: "pi/vikunja-12-task",
  worktree: "/tmp/worktree",
  conductorRunId: "run-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  terminalErrorCode: null,
};

const layout: ProjectLayout = {
  viewId: viewId(8),
  buckets: {
    Backlog: { id: bucketId(1), title: "Backlog", position: 1 },
    Ready: { id: bucketId(2), title: "Ready", position: 2 },
    Running: { id: bucketId(3), title: "Running", position: 3 },
    Waiting: { id: bucketId(4), title: "Waiting", position: 4 },
    Review: { id: bucketId(5), title: "Review", position: 5 },
    Failed: { id: bucketId(6), title: "Failed", position: 6 },
    Done: { id: bucketId(7), title: "Done", position: 7 },
  },
  defaultBucketId: bucketId(1),
  doneBucketId: bucketId(7),
};

const question: Question = {
  id: "question-concurrent" as Question["id"],
  jobId: job.id,
  taskId: job.taskId,
  kind: "input",
  prompt: "Choose",
  options: [],
  commentWatermark: null,
  commentId: null,
  responseCommentId: null,
  answer: null,
  abortReason: null,
  state: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

type OverrideOrder = "monitor-first" | "question-first";

const runConcurrentOverride = async (order: OverrideOrder) => {
  let currentJob = job;
  let currentQuestion = question;
  let remoteBucket = layout.buckets.Waiting.id;
  let taskReads = 0;
  let releaseTaskReads: (() => void) | undefined;
  const taskReadsReleased = new Promise<void>((resolve) => {
    releaseTaskReads = resolve;
  });
  let releaseMonitorAbort: (() => void) | undefined;
  const monitorAbortReleased = new Promise<void>((resolve) => {
    releaseMonitorAbort = resolve;
  });
  let injectedTransitionRace = false;
  const comments: string[] = [];
  const moves: number[] = [];
  const mutations = new Map<
    string,
    { state: "pending" | "succeeded"; remoteId: string | null; body: string }
  >();
  const store = {
    async getCommentWatermark() {
      return null;
    },
    async recordMutationIntent(input: {
      idempotencyKey: string;
      request: { body?: string };
    }) {
      const existing = mutations.get(input.idempotencyKey);
      if (existing !== undefined) return { ...input, ...existing } as never;
      const intent = {
        ...input,
        state: "pending" as const,
        remoteId: null,
        body: input.request.body ?? "",
      };
      mutations.set(input.idempotencyKey, intent);
      return intent as never;
    },
    async completeMutation(key: string, remoteId: string | null) {
      const intent = mutations.get(key);
      if (intent !== undefined) {
        intent.state = "succeeded";
        intent.remoteId = remoteId;
      }
      return intent as never;
    },
    async createQuestion() {
      return currentQuestion;
    },
    async recordQuestionComment(
      _id: Question["id"],
      id: ReturnType<typeof commentId>,
    ) {
      currentQuestion = { ...currentQuestion, commentId: id };
      return currentQuestion;
    },
    async recordCommentWatermark() {},
    async abortQuestion() {
      if (order === "monitor-first") await taskReadsReleased;
      currentQuestion = {
        ...currentQuestion,
        state: "aborted",
        abortReason: "task moved while waiting for an answer",
      };
      return currentQuestion;
    },
    async getJob() {
      return currentJob;
    },
    async recordTerminalFailure(
      _id: Job["id"],
      terminalErrorCode: NonNullable<Job["terminalErrorCode"]>,
      intents: readonly {
        idempotencyKey: string;
        request: { body?: string };
      }[],
    ) {
      for (const intent of intents) {
        if (!mutations.has(intent.idempotencyKey)) {
          mutations.set(intent.idempotencyKey, {
            state: "pending",
            remoteId: null,
            body: intent.request.body ?? "",
          });
        }
      }
      currentJob = {
        ...currentJob,
        state: "failed",
        terminalErrorCode,
      };
      if (!injectedTransitionRace) {
        injectedTransitionRace = true;
        throw new Error("job changed concurrently");
      }
      return currentJob;
    },
    async transition(
      _id: Job["id"],
      transition: Parameters<JobStore["transition"]>[1],
    ) {
      currentJob = {
        ...currentJob,
        state: transition.state,
        terminalErrorCode:
          transition.state === "failed" ? transition.terminalErrorCode : null,
      };
      return currentJob;
    },
  } as unknown as JobStore;

  const gateway = {
    async getTask() {
      taskReads += 1;
      if (taskReads === 2) {
        remoteBucket = layout.buckets.Failed.id;
        releaseTaskReads?.();
      }
      await taskReadsReleased;
      return {
        id: job.taskId,
        projectId: job.projectId,
        title: "Task",
        priority: 1,
        position: 1,
        bucketId: remoteBucket,
        done: false,
      };
    },
    async listComments() {
      return [] as readonly TaskComment[];
    },
    async postComment(_taskId: typeof job.taskId, body: string) {
      comments.push(body);
      if (body.includes("MANUAL_STATE_OVERRIDE")) {
        releaseMonitorAbort?.();
      }
      return commentId(100 + comments.length);
    },
    async moveTask(_taskId: typeof job.taskId, bucket: BucketId) {
      moves.push(bucket);
      remoteBucket = bucket;
    },
  } as unknown as VikunjaGateway;

  const handle = {
    runId: "run-1",
    async completion() {
      return {} as never;
    },
    async abort() {
      if (order === "question-first") await monitorAbortReleased;
    },
    async steer() {},
    async followUp() {},
    latestResponse() {
      return "";
    },
    runStats() {
      return {} as never;
    },
  } as unknown as ConductorHandle;

  const ui = createVikunjaQuestionUi({} as never, {
    gateway,
    store,
    job,
    layout,
    ownerUserId: userId(1),
    pollIntervalMs: 0,
    maxCommentChars: 240,
    sleep: async () => undefined,
  });
  const monitor = startPiCommentMonitor({
    job,
    handle,
    ownerUserId: userId(1),
    store,
    gateway,
    layout,
    initialCommentId: commentId(100),
    pollIntervalMs: 0,
    maxCommentChars: 240,
    logError: () => undefined,
  });
  const questionResult = ui.input("Question", undefined, {});
  await expect(questionResult).rejects.toMatchObject({
    name: "ManualStateOverrideError",
  });
  await monitor.done;

  return { comments, moves, mutations, currentJob };
};

describe("concurrent manual bucket override reporting", () => {
  it.each([
    "monitor-first",
    "question-first",
  ] as const)("posts exactly one bounded report when %s wins the race", async (order) => {
    const result = await runConcurrentOverride(order);
    expect(
      result.comments.filter((body) => body.includes("MANUAL_STATE_OVERRIDE")),
    ).toHaveLength(1);
    expect(result.comments.at(-1)).toContain(
      "idempotency:job:job-concurrent:manual-state-override",
    );
    expect(result.comments.at(-1)?.length).toBeLessThanOrEqual(240);
    expect(result.moves).toEqual([]);
    expect(result.currentJob.terminalErrorCode).toBe("MANUAL_STATE_OVERRIDE");
    expect(
      result.mutations.get("job:job-concurrent:manual-state-override")?.state,
    ).toBe("succeeded");
  });
});
