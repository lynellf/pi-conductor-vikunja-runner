import { describe, expect, it } from "vitest";
import type { ConductorHandle } from "../src/conductor/gateway.js";
import {
  executePiComment,
  startPiCommentMonitor,
} from "../src/domain/control.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import { commentId, taskId, userId } from "../src/domain/types.js";
import type { Milestone } from "../src/persistence/contracts.js";
import type { VikunjaGateway } from "../src/vikunja/gateway.js";

const job: Job = {
  id: "job-1" as Job["id"],
  taskId: taskId(12),
  projectId: 42 as Job["projectId"],
  attempt: 1,
  state: "running",
  branch: "pi/vikunja-12-task",
  worktree: "/tmp/worktree",
  conductorRunId: "run-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  terminalErrorCode: null,
};

const handle = (calls: string[]): ConductorHandle =>
  ({
    runId: "run-1",
    async completion() {
      return {} as never;
    },
    async abort(reason?: string) {
      calls.push(`abort:${reason ?? ""}`);
    },
    async steer(message: string) {
      calls.push(`steer:${message}`);
    },
    async followUp() {
      return undefined;
    },
    latestResponse() {
      return "";
    },
    runStats() {
      return {} as never;
    },
  }) as ConductorHandle;

const makeDeps = () => {
  const calls: string[] = [];
  const comments: string[] = [];
  const milestones = new Map<string, Milestone>();
  const store = {
    async getMilestone(_jobId: Job["id"], key: string) {
      return milestones.get(key) ?? null;
    },
    async recordMilestone(input: {
      jobId: Job["id"];
      type: Milestone["type"];
      idempotencyKey: string;
    }) {
      const existing = milestones.get(input.idempotencyKey);
      if (existing) return existing;
      const value = {
        id: `milestone-${milestones.size}` as Milestone["id"],
        ...input,
        commentId: null,
        deliveryState: "pending",
        error: null,
        createdAt: "",
        updatedAt: "",
      } as Milestone;
      milestones.set(input.idempotencyKey, value);
      return value;
    },
    async recordMilestoneComment(
      id: Milestone["id"],
      remoteId: ReturnType<typeof commentId>,
    ) {
      for (const [key, milestone] of milestones) {
        if (milestone.id !== id) continue;
        if (milestone.deliveryState !== "pending") {
          throw new Error(`milestone ${id} is no longer pending`);
        }
        milestones.set(key, {
          ...milestone,
          commentId: remoteId,
          deliveryState: "delivered",
        });
      }
      return [...milestones.values()].find(
        (milestone) => milestone.id === id,
      ) as Milestone;
    },
    async failMilestone(id: Milestone["id"], error: string) {
      for (const [key, milestone] of milestones) {
        if (milestone.id === id) {
          milestones.set(key, {
            ...milestone,
            deliveryState: "failed",
            error,
          });
        }
      }
      return [...milestones.values()].find(
        (milestone) => milestone.id === id,
      ) as Milestone;
    },
    async recordMutationIntent(input: { idempotencyKey: string }) {
      return {
        id: "mutation-1",
        ...input,
        state: "pending",
        remoteId: null,
        error: null,
        request: {},
        operation: "post_comment",
        jobId: job.id,
        taskId: job.taskId,
        createdAt: "",
        updatedAt: "",
      } as never;
    },
    async completeMutation() {
      return {} as never;
    },
  } as unknown as JobStore;
  const gateway = {
    async postComment(_taskId: ReturnType<typeof taskId>, body: string) {
      comments.push(body);
      return commentId(101);
    },
  } as unknown as VikunjaGateway;
  return { calls, comments, milestones, store, gateway };
};

describe("executePiComment", () => {
  it("steers a running handle and emits one durable acknowledgement", async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    const input = {
      job,
      commentId: commentId(20),
      action: { kind: "steer", message: "focus on the failing test" } as const,
      handle: handle(calls),
      store: deps.store,
      gateway: deps.gateway,
    };

    await expect(executePiComment(input)).resolves.toEqual({
      status: "handled",
    });
    await expect(executePiComment(input)).resolves.toEqual({
      status: "handled",
    });
    expect(calls).toEqual(["steer:focus on the failing test"]);
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain(
      "idempotency:job:job-1:comment:20:steer",
    );
  });

  it("keeps a failed steering acknowledgement retryable", async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    let attempts = 0;
    const input = {
      job,
      commentId: commentId(25),
      action: { kind: "steer", message: "retry acknowledgement" } as const,
      handle: handle(calls),
      store: deps.store,
      gateway: {
        async postComment(_taskId: ReturnType<typeof taskId>, body: string) {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary comment failure");
          deps.comments.push(body);
          return commentId(103);
        },
      },
    };

    await expect(executePiComment(input)).rejects.toThrow(
      "temporary comment failure",
    );
    expect([...deps.milestones.values()][0]?.deliveryState).toBe("pending");

    await expect(executePiComment(input)).resolves.toEqual({
      status: "handled",
    });
    expect(calls).toEqual(["steer:retry acknowledgement"]);
    expect(attempts).toBe(2);
    expect([...deps.milestones.values()][0]).toMatchObject({
      deliveryState: "delivered",
      commentId: commentId(103),
    });
  });

  it("aborts while waiting and includes the owner reason in one acknowledgement", async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    const waitingJob = { ...job, state: "waiting" as const };

    await executePiComment({
      job: waitingJob,
      commentId: commentId(21),
      action: { kind: "abort", reason: "stop this attempt" },
      handle: handle(calls),
      store: deps.store,
      gateway: deps.gateway,
    });

    expect(calls).toEqual(["abort:stop this attempt"]);
    expect(deps.comments[0]).toContain("stop this attempt");
  });

  it("monitors new owner commands and ignores historical comments", async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    const seenWatermarks: number[] = [];
    const comments = [
      {
        id: commentId(20),
        taskId: job.taskId,
        authorId: userId(1),
        body: "/pi steer historical",
        createdAt: "",
      },
      {
        id: commentId(21),
        taskId: job.taskId,
        authorId: userId(1),
        body: "/pi steer focus tests",
        createdAt: "",
      },
    ];
    const monitorStore = {
      ...deps.store,
      async getCommentWatermark() {
        return null;
      },
      async recordCommentWatermark(_taskId: unknown, id: number) {
        seenWatermarks.push(id);
      },
    } as unknown as JobStore;
    const gateway = {
      ...deps.gateway,
      async listComments(_taskId: unknown, after: number | null) {
        return comments.filter(
          (comment) => after === null || comment.id > after,
        );
      },
    } as unknown as VikunjaGateway;
    const monitor = startPiCommentMonitor({
      job,
      handle: handle(calls),
      ownerUserId: userId(1),
      store: monitorStore,
      gateway,
      initialCommentId: commentId(20),
      pollIntervalMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    monitor.stop();
    await monitor.done;

    expect(calls).toEqual(["steer:focus tests"]);
    expect(seenWatermarks).toContain(21);
    expect(deps.comments).toHaveLength(1);
  });

  it("retries a command when acknowledgement delivery fails before advancing the watermark", async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    let attempts = 0;
    const comment = {
      id: commentId(24),
      taskId: job.taskId,
      authorId: userId(1),
      body: "/pi unknown",
      createdAt: "",
    };
    const gateway = {
      ...deps.gateway,
      async listComments(_taskId: unknown, after: number | null) {
        return after === null || comment.id > after ? [comment] : [];
      },
      async postComment(_taskId: unknown, body: string) {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary comment failure");
        deps.comments.push(body);
        return commentId(102);
      },
    } as unknown as VikunjaGateway;
    const monitorStore = {
      ...deps.store,
      async recordCommentWatermark() {
        return undefined;
      },
    } as unknown as JobStore;
    const monitor = startPiCommentMonitor({
      job,
      handle: handle(calls),
      ownerUserId: userId(1),
      store: monitorStore,
      gateway,
      initialCommentId: null,
      pollIntervalMs: 10,
      logError: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    monitor.stop();
    await monitor.done;

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(deps.comments).toHaveLength(1);
  });

  it("aborts and reports a human bucket override without moving it back", async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    let current = job;
    const monitorStore = {
      ...deps.store,
      async getJob() {
        return current;
      },
      async transition(
        _jobId: Job["id"],
        transition: Parameters<JobStore["transition"]>[1],
      ) {
        current = {
          ...current,
          state: transition.state,
          terminalErrorCode: "MANUAL_STATE_OVERRIDE",
        };
        return current;
      },
    } as unknown as JobStore;
    const gateway = {
      ...deps.gateway,
      async listComments() {
        return [];
      },
      async getTask() {
        return {
          id: job.taskId,
          projectId: job.projectId,
          title: "Task",
          priority: 1,
          position: 1,
          bucketId: 2 as Job["projectId"],
          done: false,
        };
      },
    } as unknown as VikunjaGateway;
    const monitor = startPiCommentMonitor({
      job,
      handle: handle(calls),
      ownerUserId: userId(1),
      store: monitorStore,
      gateway,
      layout: {
        viewId: 8 as never,
        buckets: {
          Backlog: { id: 1 as never, title: "Backlog", position: 0 },
          Ready: { id: 2 as never, title: "Ready", position: 1 },
          Running: { id: 3 as never, title: "Running", position: 2 },
          Waiting: { id: 4 as never, title: "Waiting", position: 3 },
          Review: { id: 5 as never, title: "Review", position: 4 },
          Failed: { id: 6 as never, title: "Failed", position: 5 },
          Done: { id: 7 as never, title: "Done", position: 6 },
        },
        defaultBucketId: 1 as never,
        doneBucketId: 7 as never,
      },
      initialCommentId: null,
      pollIntervalMs: 10,
      logError: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    monitor.stop();
    await monitor.done;

    expect(calls).toEqual(["abort:owner selected another task bucket"]);
    expect(current.terminalErrorCode).toBe("MANUAL_STATE_OVERRIDE");
    expect(deps.comments[0]).toContain("MANUAL_STATE_OVERRIDE");
  });

  it("does not steer a non-running job and answers unknown owner commands with help", async () => {
    const deps = makeDeps();
    const calls: string[] = [];

    await expect(
      executePiComment({
        job: { ...job, state: "waiting" },
        commentId: commentId(22),
        action: { kind: "steer", message: "not now" },
        handle: handle(calls),
        store: deps.store,
        gateway: deps.gateway,
      }),
    ).resolves.toEqual({ status: "ignored" });
    await expect(
      executePiComment({
        job,
        commentId: commentId(23),
        action: { kind: "help", message: "Supported commands" },
        handle: handle(calls),
        store: deps.store,
        gateway: deps.gateway,
      }),
    ).resolves.toEqual({ status: "handled" });
    expect(calls).toEqual([]);
    expect(deps.comments[0]).toContain("Supported commands");
  });
});
