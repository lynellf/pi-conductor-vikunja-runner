import { describe, expect, it, vi } from "vitest";
import type { Job, JobStore } from "../src/domain/jobs.js";
import type { ProjectLayout, TaskComment } from "../src/domain/types.js";
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
  id: "job-1" as Job["id"],
  taskId: taskId(12),
  projectId: projectId(42),
  attempt: 1,
  state: "running",
  branch: "pi/vikunja-12-task",
  worktree: "/tmp/worktree",
  conductorRunId: null,
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

const question = (
  kind: Question["kind"],
  options: readonly string[] = [],
): Question => ({
  id: "question-1" as Question["id"],
  jobId: job.id,
  taskId: job.taskId,
  kind,
  prompt: "Choose",
  options,
  commentWatermark: null,
  commentId: null,
  responseCommentId: null,
  answer: null,
  abortReason: null,
  state: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

interface FakeState {
  readonly moves: number[];
  readonly comments: string[];
  readonly transitions: string[];
  readonly watermarks: number[];
  readonly mutationKeys: string[];
  readonly completedMutations: Array<{
    key: string;
    remoteId: string | null;
  }>;
  readonly failedMutationKeys: string[];
  atomicResolutions: number;
  currentJob: Job;
  activeQuestion: Question;
  remoteBucket: ReturnType<typeof bucketId>;
}

const makeDependencies = (
  responses: readonly (readonly TaskComment[])[],
  kind: Question["kind"] = "input",
  options: readonly string[] = [],
) => {
  const state: FakeState = {
    moves: [],
    comments: [],
    transitions: [],
    watermarks: [],
    mutationKeys: [],
    completedMutations: [],
    failedMutationKeys: [],
    atomicResolutions: 0,
    currentJob: job,
    activeQuestion: question(kind, options),
    remoteBucket: layout.buckets.Running.id,
  };
  let poll = 0;
  const store = {
    async getCommentWatermark() {
      return null;
    },
    async recordMutationIntent(input: { idempotencyKey: string }) {
      state.mutationKeys.push(input.idempotencyKey);
      return {
        id: "mutation-1",
        ...input,
        state: "pending",
        remoteId: null,
        error: null,
        createdAt: "",
        updatedAt: "",
      } as never;
    },
    async completeMutation(key: string, remoteId: string | null) {
      state.completedMutations.push({ key, remoteId });
      return {} as never;
    },
    async failMutation(key: string) {
      state.failedMutationKeys.push(key);
      return {} as never;
    },
    async createQuestion() {
      return state.activeQuestion;
    },
    async recordQuestionComment(
      _id: Question["id"],
      id: ReturnType<typeof commentId>,
    ) {
      state.activeQuestion = { ...state.activeQuestion, commentId: id };
      return state.activeQuestion;
    },
    async recordCommentWatermark(
      _task: ReturnType<typeof taskId>,
      id: ReturnType<typeof commentId>,
    ) {
      state.watermarks.push(id);
    },
    async resolveQuestion(
      _id: Question["id"],
      responseId: ReturnType<typeof commentId>,
      answer: string,
    ) {
      state.activeQuestion = {
        ...state.activeQuestion,
        responseCommentId: responseId,
        answer,
        state: "resolved",
      };
      return state.activeQuestion;
    },
    async resolveQuestionAndResume(
      _id: Question["id"],
      responseId: ReturnType<typeof commentId>,
      answer: string,
    ) {
      state.atomicResolutions += 1;
      state.activeQuestion = {
        ...state.activeQuestion,
        responseCommentId: responseId,
        answer,
        state: "resolved",
      };
      state.transitions.push("running");
      state.currentJob = { ...state.currentJob, state: "running" };
      return { question: state.activeQuestion, job: state.currentJob };
    },
    async abortQuestion(_id: Question["id"], reason?: string) {
      state.activeQuestion = {
        ...state.activeQuestion,
        abortReason: reason ?? null,
        state: "aborted",
      };
      return state.activeQuestion;
    },
    async getJob() {
      return state.currentJob;
    },
    async recordTerminalFailure(
      _id: Job["id"],
      terminalErrorCode: NonNullable<Job["terminalErrorCode"]>,
      intents: readonly { idempotencyKey: string }[],
    ) {
      state.mutationKeys.push(
        ...intents.map((intent) => intent.idempotencyKey),
      );
      state.transitions.push("failed");
      state.currentJob = {
        ...state.currentJob,
        state: "failed",
        terminalErrorCode,
      };
      return state.currentJob;
    },
    async transition(
      _id: Job["id"],
      transition: { state: string; terminalErrorCode?: string },
    ) {
      state.transitions.push(transition.state);
      state.currentJob = {
        ...state.currentJob,
        state: transition.state as Job["state"],
        terminalErrorCode:
          (transition.terminalErrorCode as Job["terminalErrorCode"]) ?? null,
      };
      return state.currentJob;
    },
  } as unknown as JobStore;
  const gateway = {
    async getTask() {
      return {
        id: job.taskId,
        projectId: job.projectId,
        title: "Task",
        priority: 1,
        position: 1,
        bucketId: state.remoteBucket,
        done: false,
      };
    },
    async postComment(_taskId: ReturnType<typeof taskId>, body: string) {
      state.comments.push(body);
      return commentId(100 + state.comments.length);
    },
    async moveTask(
      _taskId: ReturnType<typeof taskId>,
      bucket: ReturnType<typeof bucketId>,
    ) {
      state.moves.push(bucket);
      state.remoteBucket = bucket;
    },
    async listComments() {
      const result = responses[Math.min(poll++, responses.length - 1)];
      return result ?? [];
    },
  } as unknown as VikunjaGateway;
  return { state, store, gateway };
};

describe("createVikunjaQuestionUi", () => {
  it("persists a question, waits in Vikunja, and returns the first valid owner reply", async () => {
    const reply: TaskComment = {
      id: commentId(2),
      taskId: job.taskId,
      authorId: userId(1),
      body: "  ship it  ",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const dependencies = makeDependencies([[], [reply]]);
    const ui = createVikunjaQuestionUi({} as never, {
      ...dependencies,
      job,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(ui.input("Need a decision", undefined, {})).resolves.toBe(
      "ship it",
    );
    expect(dependencies.state.moves).toEqual([4, 3]);
    expect(dependencies.state.transitions).toEqual(["waiting", "running"]);
    expect(dependencies.state.activeQuestion.state).toBe("resolved");
    expect(dependencies.state.atomicResolutions).toBe(1);
    expect(dependencies.state.watermarks).toEqual([2]);
    expect(dependencies.state.comments[0]).toContain(
      "pi-runner:question:question-1",
    );
    expect(dependencies.state.comments[0]).toContain(
      "[pi-runner][idempotency:job:job-1:question:question-1:comment]",
    );
    expect(dependencies.state.mutationKeys).toEqual([
      "job:job-1:question:question-1:comment",
      "job:job-1:question:question-1:waiting",
      "job:job-1:question:question-1:running",
    ]);
  });

  it("reconciles an ambiguously delivered question comment", async () => {
    const dependencies = makeDependencies([[]]);
    let deliveredBody = "";
    let commentRead = 0;
    const ownerReply: TaskComment = {
      id: commentId(105),
      taskId: job.taskId,
      authorId: userId(1),
      body: "ship it",
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const gateway = {
      ...dependencies.gateway,
      async postComment(_taskId: ReturnType<typeof taskId>, body: string) {
        deliveredBody = body;
        dependencies.state.comments.push(body);
        throw new Error("response lost after comment creation");
      },
      async listComments() {
        commentRead += 1;
        if (commentRead === 1) {
          return [
            {
              id: commentId(104),
              taskId: job.taskId,
              authorId: userId(2),
              body: deliveredBody,
              createdAt: "2026-01-01T00:00:01.000Z",
            },
          ];
        }
        return [ownerReply];
      },
    } as unknown as VikunjaGateway;
    const ui = createVikunjaQuestionUi({} as never, {
      gateway,
      store: dependencies.store,
      job,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(ui.input("Need a decision", undefined, {})).resolves.toBe(
      "ship it",
    );
    expect(dependencies.state.completedMutations).toContainEqual({
      key: "job:job-1:question:question-1:comment",
      remoteId: "104",
    });
    expect(dependencies.state.comments).toHaveLength(1);
  });

  it("does not move a question to Waiting after an owner bucket override", async () => {
    const controller = new AbortController();
    const dependencies = makeDependencies([[]]);
    const ui = createVikunjaQuestionUi({} as never, {
      ...dependencies,
      gateway: {
        ...dependencies.gateway,
        async getTask() {
          return {
            id: job.taskId,
            projectId: job.projectId,
            title: "Task",
            priority: 1,
            position: 1,
            bucketId: layout.buckets.Done.id,
            done: true,
          };
        },
      },
      job,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 0,
      sleep: async () => controller.abort("test safety stop"),
    });

    await expect(
      ui.input("Need a decision", undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "ManualStateOverrideError" });
    expect(dependencies.state.moves).toEqual([]);
    expect(dependencies.state.failedMutationKeys).toEqual([
      "job:job-1:question:question-1:waiting",
    ]);
  });

  it("keeps an accepted answer pending until Running is confirmed", async () => {
    const reply: TaskComment = {
      id: commentId(2),
      taskId: job.taskId,
      authorId: userId(1),
      body: "ship it",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const dependencies = makeDependencies([[reply]]);
    let runningAttempts = 0;
    let stateDuringFailure: Question["state"] | null = null;
    const gateway = {
      ...dependencies.gateway,
      async moveTask(
        _taskId: ReturnType<typeof taskId>,
        bucket: ReturnType<typeof bucketId>,
      ) {
        if (bucket === layout.buckets.Running.id) {
          runningAttempts += 1;
          if (runningAttempts === 1) {
            stateDuringFailure = dependencies.state.activeQuestion.state;
            throw new Error("temporary move failure");
          }
        }
        dependencies.state.moves.push(bucket);
        dependencies.state.remoteBucket = bucket;
      },
    };
    const ui = createVikunjaQuestionUi({} as never, {
      gateway,
      store: dependencies.store,
      job,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(ui.input("Need a decision", undefined, {})).resolves.toBe(
      "ship it",
    );
    expect(stateDuringFailure).toBe("pending");
    expect(runningAttempts).toBe(2);
    expect(dependencies.state.activeQuestion.state).toBe("resolved");
    expect(dependencies.state.remoteBucket).toBe(layout.buckets.Running.id);
  });

  it("does not consume /pi control comments as question answers", async () => {
    const abortCommand: TaskComment = {
      id: commentId(2),
      taskId: job.taskId,
      authorId: userId(1),
      body: "/pi abort stop now",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const reply: TaskComment = {
      id: commentId(3),
      taskId: job.taskId,
      authorId: userId(1),
      body: "the actual answer",
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const dependencies = makeDependencies([[abortCommand], [reply]]);
    const ui = createVikunjaQuestionUi({} as never, {
      ...dependencies,
      job,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(ui.input("Need a decision", undefined, {})).resolves.toBe(
      "the actual answer",
    );
    expect(dependencies.state.watermarks).toEqual([2, 3]);
  });

  it("posts one bounded correction for an invalid confirmation before accepting yes", async () => {
    const invalid: TaskComment = {
      id: commentId(2),
      taskId: job.taskId,
      authorId: userId(1),
      body: "maybe",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const valid: TaskComment = { ...invalid, id: commentId(3), body: "YES" };
    const dependencies = makeDependencies([[invalid], [valid]], "confirm");
    const ui = createVikunjaQuestionUi({} as never, {
      ...dependencies,
      job,
      layout,
      ownerUserId: userId(1),
      maxCommentChars: 200,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(ui.confirm("Proceed?", "Reply yes or no", {})).resolves.toBe(
      true,
    );
    expect(dependencies.state.comments).toHaveLength(2);
    expect(dependencies.state.comments[1]).toContain("reply with yes or no");
    expect(dependencies.state.comments[1]).toContain(
      "[pi-runner][idempotency:job:job-1:question:question-1:correction:2]",
    );
  });

  it("returns the configured option for a numeric select reply", async () => {
    const reply: TaskComment = {
      id: commentId(2),
      taskId: job.taskId,
      authorId: userId(1),
      body: "2",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const dependencies = makeDependencies([[], [reply]], "select", [
      "red",
      "blue",
    ]);
    const ui = createVikunjaQuestionUi({} as never, {
      ...dependencies,
      job,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(ui.select("Pick a color", ["red", "blue"], {})).resolves.toBe(
      "blue",
    );
  });

  it("fails safely when a waiting task is moved to another bucket", async () => {
    const deps = makeDependencies([[]]);
    let reads = 0;
    const gateway = {
      ...deps.gateway,
      async getTask() {
        reads += 1;
        return {
          id: job.taskId,
          projectId: job.projectId,
          title: "Task",
          priority: 1,
          position: 1,
          bucketId:
            reads === 1 ? layout.buckets.Running.id : layout.buckets.Failed.id,
          done: false,
        };
      },
    } as unknown as VikunjaGateway;
    const ui = createVikunjaQuestionUi({} as never, {
      gateway,
      store: deps.store,
      job,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 1,
    });

    await expect(ui.input("Question", undefined, {})).rejects.toMatchObject({
      name: "ManualStateOverrideError",
    });
    expect(deps.state.moves).toEqual([layout.buckets.Waiting.id]);
    expect(deps.state.currentJob.terminalErrorCode).toBe(
      "MANUAL_STATE_OVERRIDE",
    );
    expect(deps.state.comments.at(-1)).toContain("MANUAL_STATE_OVERRIDE");
  });

  it("cancels the default polling delay when the dialog signal is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const dependencies = makeDependencies([[]]);
      const ui = createVikunjaQuestionUi({} as never, {
        ...dependencies,
        job,
        layout,
        ownerUserId: userId(1),
        pollIntervalMs: 60_000,
      });
      const pending = ui.input("Question", undefined, {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      controller.abort("shutdown");
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the durable question but leaves terminal reporting to conductor completion", async () => {
    const controller = new AbortController();
    const dependencies = makeDependencies([[]]);
    const ui = createVikunjaQuestionUi({} as never, {
      ...dependencies,
      job,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 0,
      sleep: async () => controller.abort("shutdown"),
    });

    await expect(
      ui.input("Question", undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "Vikunja question aborted: shutdown",
    });
    expect(dependencies.state.activeQuestion.state).toBe("aborted");
    expect(dependencies.state.activeQuestion.abortReason).toBe("shutdown");
    expect(dependencies.state.transitions).toEqual(["waiting"]);
    expect(dependencies.state.currentJob.state).toBe("waiting");
    expect(dependencies.state.currentJob.terminalErrorCode).toBeNull();
  });
});
