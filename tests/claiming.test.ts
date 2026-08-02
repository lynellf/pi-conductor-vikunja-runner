import { describe, expect, it } from "vitest";
import { claimReadyTask } from "../src/domain/claiming.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import type { ProjectLayout } from "../src/domain/types.js";
import {
  bucketId,
  type CodingTask,
  projectId,
  taskId,
} from "../src/domain/types.js";
import type { VikunjaGateway } from "../src/vikunja/gateway.js";

const layout: ProjectLayout = {
  viewId: 8 as ProjectLayout["viewId"],
  buckets: {
    Backlog: { id: bucketId(1), title: "Backlog", position: 0 },
    Ready: { id: bucketId(2), title: "Ready", position: 1 },
    Running: { id: bucketId(3), title: "Running", position: 2 },
    Waiting: { id: bucketId(4), title: "Waiting", position: 3 },
    Review: { id: bucketId(5), title: "Review", position: 4 },
    Failed: { id: bucketId(6), title: "Failed", position: 5 },
    Done: { id: bucketId(7), title: "Done", position: 6 },
  },
  defaultBucketId: bucketId(1),
  doneBucketId: bucketId(7),
};

const task: CodingTask = {
  id: taskId(12),
  projectId: projectId(42),
  title: "Fix API auth",
  description: "Do the work",
  priority: 5,
  position: 1,
  bucketId: bucketId(2),
  done: false,
};

const job: Job = {
  id: "job-1" as Job["id"],
  taskId: task.id,
  projectId: task.projectId,
  attempt: 1,
  state: "claiming",
  branch: "pi/vikunja-12-fix-api-auth",
  worktree: null,
  conductorRunId: null,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  terminalErrorCode: null,
};

const makeStore = (
  remoteJob: Job | null = job,
  options: {
    readonly mutationStates?: Record<
      string,
      "pending" | "succeeded" | "failed"
    >;
    readonly milestoneDelivered?: boolean;
  } = {},
) => {
  const transitions: Array<Parameters<JobStore["transition"]>[1]> = [];
  const mutationCalls: string[] = [];
  const milestones = new Map<
    string,
    { id: string; commentId: null | ReturnType<typeof taskId> }
  >();
  const store = {
    transitions,
    mutationCalls,
    async tryClaim() {
      return remoteJob;
    },
    async transition(
      _id: Job["id"],
      transition: Parameters<JobStore["transition"]>[1],
    ) {
      transitions.push(transition);
      return {
        ...job,
        state: transition.state,
        terminalErrorCode:
          transition.state === "failed" ? transition.terminalErrorCode : null,
      } as Job;
    },
    async recordMutationIntent(input: { idempotencyKey: string }) {
      mutationCalls.push(input.idempotencyKey);
      const state = options.mutationStates?.[input.idempotencyKey] ?? "pending";
      return {
        id: "mutation" as never,
        ...input,
        state,
        remoteId: state === "succeeded" ? "101" : null,
        error: state === "failed" ? "already failed" : null,
        createdAt: "",
        updatedAt: "",
      };
    },
    async completeMutation() {
      return {} as never;
    },
    async recordMilestone(input: { idempotencyKey: string }) {
      const existing = milestones.get(input.idempotencyKey);
      if (existing) return existing as never;
      const value = {
        id: "milestone",
        commentId: options.milestoneDelivered ? taskId(101) : null,
        deliveryState: options.milestoneDelivered ? "delivered" : "pending",
      };
      milestones.set(input.idempotencyKey, value);
      return value as never;
    },
    async recordMilestoneComment() {
      return {} as never;
    },
  } as unknown as JobStore;
  return store;
};

const makeGateway = (current: CodingTask = task, failMove = false) => {
  const events: string[] = [];
  const comments: string[] = [];
  const gateway = {
    events,
    comments,
    async getTask() {
      return current;
    },
    async moveTask() {
      events.push("move");
      if (failMove) throw new Error("network unavailable");
    },
    async assignRunner() {
      events.push("assign");
    },
    async postComment(_taskId: unknown, body: string) {
      events.push("comment");
      comments.push(body);
      return 100 as ReturnType<typeof taskId>;
    },
  } as unknown as VikunjaGateway;
  return gateway;
};

describe("claimReadyTask", () => {
  it("claims only after the task is re-read in Ready and publishes one durable start milestone", async () => {
    const store = makeStore();
    const gateway = makeGateway();

    const result = await claimReadyTask({
      task,
      layout,
      store,
      gateway,
    });

    expect(result.status).toBe("claimed");
    expect(result.job.id).toBe(job.id);
    expect(gateway.events).toEqual(["move", "assign", "comment"]);
    expect(store.transitions).toEqual([{ state: "running" }]);
    expect(store.mutationCalls).toEqual([
      "job:job-1:claim:move",
      "job:job-1:claim:assign",
      "job:job-1:claim:comment",
    ]);
    expect(gateway.comments).toEqual([
      "[pi-runner][idempotency:job:job-1:claim:comment] Claimed task 12.\nJob: job-1\nBranch: pi/vikunja-12-fix-api-auth",
    ]);
  });

  it("surfaces a remote claim failure as one durable failure milestone", async () => {
    const store = makeStore();
    const gateway = makeGateway(task, true);

    const result = await claimReadyTask({ task, layout, store, gateway });

    expect(result.status).toBe("failed");
    expect(store.transitions).toEqual([
      { state: "failed", terminalErrorCode: "VIKUNJA_UNAVAILABLE" },
    ]);
    expect(store.mutationCalls).toEqual([
      "job:job-1:claim:move",
      "job:job-1:claim:failure",
    ]);
    expect(gateway.events).toEqual(["move", "comment"]);
  });

  it("records a claim conflict and performs no remote mutation when the task moved away", async () => {
    const store = makeStore();
    const gateway = makeGateway({ ...task, bucketId: bucketId(3) });

    const result = await claimReadyTask({
      task,
      layout,
      store,
      gateway,
    });

    expect(result.status).toBe("conflict");
    expect(store.transitions).toEqual([
      { state: "failed", terminalErrorCode: "CLAIM_CONFLICT" },
    ]);
    expect(gateway.events).toEqual(["comment"]);
    expect(store.mutationCalls).toContain("job:job-1:claim:conflict");
    expect(gateway.comments[0]).toContain(
      "[pi-runner][idempotency:job:job-1:claim:conflict] CLAIM_CONFLICT",
    );
  });

  it("reuses a delivered conflict milestone without posting another comment", async () => {
    const store = makeStore(job, {
      milestoneDelivered: true,
      mutationStates: { "job:job-1:claim:conflict": "succeeded" },
    });
    const gateway = makeGateway({ ...task, bucketId: bucketId(3) });

    const result = await claimReadyTask({ task, layout, store, gateway });

    expect(result.status).toBe("conflict");
    expect(gateway.events).toEqual([]);
  });

  it("bounds a conflict report while preserving its stable error marker", async () => {
    const store = makeStore();
    const gateway = makeGateway({ ...task, bucketId: bucketId(3) });

    const result = await claimReadyTask({
      task,
      layout,
      store,
      gateway,
      maxCommentChars: 80,
    });

    expect(result.status).toBe("conflict");
    expect(gateway.comments[0]).toHaveLength(80);
    expect(gateway.comments[0]).toContain("CLAIM_CONFLICT");
    expect(gateway.comments[0]).toContain("[truncated]");
  });

  it("compensates a task to Failed when assignment fails after the Running move", async () => {
    const store = makeStore();
    const events: string[] = [];
    let reads = 0;
    const gateway = {
      async getTask() {
        reads += 1;
        return reads === 1
          ? task
          : { ...task, bucketId: layout.buckets.Running.id };
      },
      async moveTask() {
        events.push("move");
      },
      async assignRunner() {
        events.push("assign");
        throw new Error("assignment unavailable");
      },
      async postComment() {
        events.push("comment");
        return 100 as ReturnType<typeof taskId>;
      },
    } as unknown as VikunjaGateway;

    const result = await claimReadyTask({ task, layout, store, gateway });

    expect(result.status).toBe("failed");
    expect(events).toEqual(["move", "assign", "move", "comment"]);
    expect(store.mutationCalls).toContain("job:job-1:claim:move-failed");
  });

  it("skips done or non-Ready tasks before creating a local claim", async () => {
    const store = makeStore(null);
    const gateway = makeGateway();

    expect(
      await claimReadyTask({
        task: { ...task, done: true },
        layout,
        store,
        gateway,
      }),
    ).toEqual({ status: "skipped" });
    expect(
      await claimReadyTask({
        task: { ...task, bucketId: layout.buckets.Backlog.id },
        layout,
        store,
        gateway,
      }),
    ).toEqual({ status: "skipped" });
    expect(await claimReadyTask({ task, layout, store, gateway })).toEqual({
      status: "skipped",
    });
    expect(store.transitions).toEqual([]);
  });

  it("fails safely when the post-claim task read is unavailable", async () => {
    const store = makeStore();
    const gateway = makeGateway();
    gateway.getTask = async () => {
      throw new Error("offline");
    };

    const result = await claimReadyTask({ task, layout, store, gateway });

    expect(result.status).toBe("failed");
    expect(result.error).toEqual(new Error("offline"));
    expect(store.transitions).toEqual([
      { state: "failed", terminalErrorCode: "VIKUNJA_UNAVAILABLE" },
    ]);
    expect(gateway.events).toEqual(["comment"]);
  });

  it("uses the deterministic future branch and truncation marker for bounded start comments", async () => {
    const store = makeStore({ ...job, branch: null });
    const gateway = makeGateway();
    const result = await claimReadyTask({
      task,
      layout,
      store,
      gateway,
      maxCommentChars: 24,
    });

    expect(result.status).toBe("claimed");
    expect(gateway.comments[0]).toHaveLength(24);
    expect(gateway.comments[0]).toContain("[truncated]");

    const namedStore = makeStore({ ...job, branch: null });
    const namedGateway = makeGateway();
    await claimReadyTask({
      task,
      layout,
      store: namedStore,
      gateway: namedGateway,
    });
    expect(namedGateway.comments[0]).toContain(
      "Branch: pi/vikunja-12-fix-api-auth",
    );

    const shortStore = makeStore({ ...job, branch: null });
    const shortGateway = makeGateway();
    await claimReadyTask({
      task,
      layout,
      store: shortStore,
      gateway: shortGateway,
      maxCommentChars: 5,
    });
    expect(shortGateway.comments[0]).toHaveLength(5);
    expect(shortGateway.comments[0]).not.toContain("[truncated]");
  });

  it("records a bounded failure when a durable mutation is already failed", async () => {
    const store = makeStore(job, {
      mutationStates: { "job:job-1:claim:move": "failed" },
    });
    const gateway = makeGateway();

    const result = await claimReadyTask({ task, layout, store, gateway });

    expect(result.status).toBe("failed");
    expect(gateway.events).toEqual(["comment"]);
    expect(store.transitions).toEqual([
      { state: "failed", terminalErrorCode: "VIKUNJA_UNAVAILABLE" },
    ]);
  });

  it("reuses delivered milestones and mutation results without repeating remote calls", async () => {
    const store = makeStore(job, {
      milestoneDelivered: true,
      mutationStates: {
        "job:job-1:claim:move": "succeeded",
        "job:job-1:claim:assign": "succeeded",
        "job:job-1:claim:comment": "succeeded",
      },
    });
    const gateway = makeGateway();

    const result = await claimReadyTask({ task, layout, store, gateway });

    expect(result.status).toBe("claimed");
    expect(gateway.events).toEqual([]);
  });

  it("preserves an ambiguous remote state without compensating it", async () => {
    const overrideStore = makeStore();
    const overrideGateway = makeGateway();
    let reads = 0;
    overrideGateway.getTask = async () => {
      reads += 1;
      if (reads === 1) return task;
      throw new Error("state unavailable");
    };
    overrideGateway.assignRunner = async () => {
      overrideGateway.events.push("assign");
      throw new Error("assignment unavailable");
    };
    const overrideResult = await claimReadyTask({
      task,
      layout,
      store: overrideStore,
      gateway: overrideGateway,
    });
    expect(overrideResult.status).toBe("failed");
    expect(overrideGateway.events).toEqual(["move", "assign", "comment"]);
  });

  it("preserves a human bucket override before compensating a failed claim", async () => {
    const store = makeStore();
    const events: string[] = [];
    let commentBody = "";
    let reads = 0;
    const gateway = {
      async getTask() {
        reads += 1;
        return reads === 1
          ? task
          : { ...task, bucketId: layout.buckets.Review.id };
      },
      async moveTask() {
        events.push("move");
      },
      async assignRunner() {
        events.push("assign");
        throw new Error("assignment unavailable");
      },
      async postComment(_taskId: unknown, body: string) {
        events.push("comment");
        commentBody = body;
        return 100 as ReturnType<typeof taskId>;
      },
    } as unknown as VikunjaGateway;

    const result = await claimReadyTask({ task, layout, store, gateway });

    expect(result.status).toBe("failed");
    expect(result.job.terminalErrorCode).toBe("MANUAL_STATE_OVERRIDE");
    expect(commentBody).toContain("MANUAL_STATE_OVERRIDE");
    expect(events).toEqual(["move", "assign", "comment"]);
    expect(store.mutationCalls).not.toContain("job:job-1:claim:move-failed");
  });
});
