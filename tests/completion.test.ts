import { describe, expect, it } from "vitest";
import type { ConductorHandle } from "../src/conductor/gateway.js";
import type { ProjectConfig } from "../src/config/config.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import type { CompleteConductorJobInput } from "../src/domain/orchestration.js";
import {
  completeConductorJob,
  JobCompletionError,
} from "../src/domain/orchestration.js";
import type { ProjectLayout } from "../src/domain/types.js";
import {
  bucketId,
  commentId,
  projectId,
  taskId,
  viewId,
} from "../src/domain/types.js";
import type {
  PreparedWorktree,
  PublishResult,
  RepositoryManager,
  Verification,
} from "../src/repositories/git.js";

const project: ProjectConfig = {
  id: projectId(42),
  displayIdentifier: "PC",
  kanbanViewId: viewId(8),
  repository: "git@example.test:owner/repo.git",
  defaultBranch: "main",
  publish: { mode: "local", remote: "origin" },
  verifyCommands: [["pnpm", "test"]],
};

const layout: ProjectLayout = {
  viewId: viewId(8),
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

const job: Job = {
  id: "job-1" as Job["id"],
  taskId: taskId(12),
  projectId: project.id,
  attempt: 2,
  state: "running",
  branch: "pi/vikunja-12-fix-auth",
  worktree: "/data/jobs/12/worktree",
  conductorRunId: "run-2",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  terminalErrorCode: null,
};

const worktree: PreparedWorktree = {
  repository: "/data/repositories/42/repo",
  branch: job.branch as string,
  worktree: job.worktree as string,
};

const passingVerification: Verification = {
  passed: true,
  latestCommit: "abc123def456",
  commands: [
    {
      command: ["pnpm", "test"],
      exitCode: 0,
      durationMs: 4,
      outputTail: "",
      passed: true,
    },
  ],
  worktreeClean: true,
  uncommittedFiles: [],
};

const localPublish: PublishResult = {
  pushed: false,
  remote: null,
  branch: worktree.branch,
};

const makeInput = (overrides: Record<string, unknown> = {}) => {
  let current = job;
  const events: string[] = [];
  let reportBody = "";
  const mutations = new Map<
    string,
    { state: string; remoteId: string | null }
  >();
  const store = {
    async recordMutationIntent(input: { idempotencyKey: string }) {
      const existing = mutations.get(input.idempotencyKey);
      if (existing !== undefined) return { ...input, ...existing };
      const intent = { ...input, state: "pending", remoteId: null };
      mutations.set(input.idempotencyKey, intent);
      return intent;
    },
    async completeMutation(key: string, remoteId: string | null) {
      const intent = mutations.get(key);
      if (intent !== undefined) {
        intent.state = "succeeded";
        intent.remoteId = remoteId;
      }
      return intent;
    },
    async failMutation(key: string) {
      const intent = mutations.get(key);
      if (intent !== undefined) intent.state = "failed";
      return intent;
    },
    async getJob() {
      return current;
    },
    async recordTerminalFailure(
      _id: Job["id"],
      terminalErrorCode: NonNullable<Job["terminalErrorCode"]>,
      intents: Parameters<JobStore["recordMutationIntent"]>[0][],
    ) {
      for (const intent of intents) {
        await store.recordMutationIntent(intent);
      }
      events.push("transition:failed");
      current = {
        ...current,
        state: "failed",
        terminalErrorCode,
      };
      return current;
    },
    async transition(
      _id: Job["id"],
      transition: Parameters<JobStore["transition"]>[1],
    ) {
      events.push(`transition:${transition.state}`);
      current = {
        ...current,
        state: transition.state,
        terminalErrorCode:
          transition.state === "failed" ? transition.terminalErrorCode : null,
      };
      return current;
    },
  } as unknown as JobStore;
  const repository = {
    async verify() {
      events.push("verify");
      return passingVerification;
    },
    async publish() {
      events.push("publish");
      return localPublish;
    },
  } as unknown as RepositoryManager;
  const gateway = {
    async getTask() {
      return {
        id: job.taskId,
        projectId: job.projectId,
        title: "Task",
        priority: 1,
        position: 1,
        bucketId: layout.buckets.Running.id,
        done: false,
      };
    },
    async moveTask(_taskId: unknown, bucket: unknown) {
      events.push(`move:${bucket}`);
    },
    async listComments() {
      return [];
    },
    async postComment(_taskId: unknown, body: string) {
      events.push(`comment:${body.includes("Review ready")}`);
      if (body.includes("Review ready")) reportBody = body;
      return 101;
    },
  };
  const handle = {
    async completion() {
      events.push("completion");
      return { finalCheckpoint: {}, exitReason: "done" as const };
    },
    latestResponse() {
      return {
        runId: "run-2",
        role: "orchestrator",
        sessionId: "session-2",
        text: "Implemented the requested change.",
        completedAt: 1,
      };
    },
    runStats() {
      return {
        runId: "run-2",
        manifestVersion: "1",
        state: "done",
        exitReason: "done",
        transitionHistory: [],
        costRollup: {},
        latestCheckpoint: null,
        recordsCount: 12,
      };
    },
  } as unknown as ConductorHandle;
  return {
    input: {
      job,
      handle,
      worktree,
      project,
      layout,
      store,
      repository,
      gateway,
      ...overrides,
    },
    events,
    get current() {
      return current;
    },
    get reportBody() {
      return reportBody;
    },
    mutations,
    setCurrent(next: Job) {
      current = next;
    },
  };
};

describe("completeConductorJob", () => {
  it("verifies, publishes, moves to Review, and posts one final report", async () => {
    const dependencies = makeInput();

    const result = await completeConductorJob(dependencies.input);

    expect(result.job.state).toBe("review");
    expect(result.publish).toEqual(localPublish);
    expect(dependencies.events).toEqual([
      "completion",
      "verify",
      "publish",
      "comment:true",
      "move:5",
      "transition:review",
    ]);
    expect(dependencies.reportBody).toContain("Latest commit: abc123def456");
    expect(dependencies.reportBody).toContain(
      "1. pnpm test — passed (exit 0, 4ms)",
    );
    expect(dependencies.reportBody).toContain(
      "Implemented the requested change.",
    );
    expect(dependencies.reportBody).toContain("records=12");
    expect(dependencies.reportBody).toContain("Publish: kept local");
    expect(dependencies.reportBody).toContain("move the task to Done");
    expect(dependencies.reportBody).toContain("move it to Ready");
  });

  it("preserves a human bucket override before publishing a completed task", async () => {
    const dependencies = makeInput();
    dependencies.input.gateway = {
      async getTask() {
        return {
          id: job.taskId,
          projectId: job.projectId,
          title: "Task",
          priority: 1,
          position: 1,
          bucketId: layout.buckets.Ready.id,
          done: false,
        };
      },
      async moveTask(_taskId: unknown, bucket: unknown) {
        dependencies.events.push(`move:${bucket}`);
      },
      async postComment(_taskId: unknown, body: string) {
        dependencies.events.push(`comment:${body.includes("Review ready")}`);
        return 101;
      },
    } as CompleteConductorJobInput["gateway"];

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toMatchObject({
      name: "JobCompletionError",
      job: { state: "failed", terminalErrorCode: "MANUAL_STATE_OVERRIDE" },
    });
    expect(dependencies.events).toEqual([
      "completion",
      "verify",
      "transition:failed",
      "comment:false",
    ]);
    expect(dependencies.mutations.get("job:job-1:completion:move-review")).toBe(
      undefined,
    );
    expect(
      dependencies.mutations.get("job:job-1:manual-state-override"),
    ).toMatchObject({ state: "succeeded" });
  });

  it("keeps the stable override error when its report cannot be delivered", async () => {
    const dependencies = makeInput();
    dependencies.input.gateway = {
      async getTask() {
        return {
          id: job.taskId,
          projectId: job.projectId,
          title: "Task",
          priority: 1,
          position: 1,
          bucketId: layout.buckets.Ready.id,
          done: false,
        };
      },
      async postComment() {
        throw new Error("Vikunja unavailable");
      },
    } as CompleteConductorJobInput["gateway"];

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toMatchObject({
      name: "JobCompletionError",
      job: { state: "failed", terminalErrorCode: "MANUAL_STATE_OVERRIDE" },
    });
    expect(
      dependencies.mutations.get("job:job-1:manual-state-override"),
    ).toMatchObject({ state: "pending" });
  });

  it("preserves the override when another live path wins the terminal transition race", async () => {
    const dependencies = makeInput();
    const originalTerminalFailure =
      dependencies.input.store.recordTerminalFailure.bind(
        dependencies.input.store,
      );
    let raced = false;
    dependencies.input.store.recordTerminalFailure = async (
      id,
      terminalErrorCode,
      intents,
      questionAbortReason,
    ) => {
      if (terminalErrorCode === "MANUAL_STATE_OVERRIDE" && !raced) {
        raced = true;
        for (const intent of intents) {
          await dependencies.input.store.recordMutationIntent(intent);
        }
        dependencies.setCurrent({
          ...job,
          state: "failed",
          terminalErrorCode: "MANUAL_STATE_OVERRIDE",
        });
        throw new Error("job transition compare-and-swap lost");
      }
      return originalTerminalFailure(
        id,
        terminalErrorCode,
        intents,
        questionAbortReason,
      );
    };
    dependencies.input.gateway = {
      async getTask() {
        return {
          id: job.taskId,
          projectId: job.projectId,
          title: "Task",
          priority: 1,
          position: 1,
          bucketId: layout.buckets.Ready.id,
          done: false,
        };
      },
      async postComment(_taskId: unknown, body: string) {
        dependencies.events.push(`comment:${body.includes("Review ready")}`);
        return 101;
      },
    } as CompleteConductorJobInput["gateway"];

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toMatchObject({
      name: "JobCompletionError",
      job: { state: "failed", terminalErrorCode: "MANUAL_STATE_OVERRIDE" },
    });
    expect(dependencies.events).toEqual([
      "completion",
      "verify",
      "comment:false",
    ]);
    expect(
      dependencies.mutations.get("job:job-1:manual-state-override"),
    ).toMatchObject({ state: "succeeded" });
  });

  it.each([
    ["aborted", "CONDUCTOR_SESSION_FAILED"],
    ["session_failed", "CONDUCTOR_SESSION_FAILED"],
  ] as const)("fails a non-done conductor result (%s)", async (exitReason, code) => {
    const dependencies = makeInput();
    dependencies.input.handle = {
      async completion() {
        return { finalCheckpoint: {}, exitReason };
      },
    } as unknown as ConductorHandle;

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toMatchObject({
      name: "JobCompletionError",
      job: { state: "failed", terminalErrorCode: code },
    });
    expect(dependencies.events).toEqual([
      "transition:failed",
      "move:6",
      "comment:false",
    ]);
  });

  it("compensates a conductor failure from the durable Waiting bucket", async () => {
    const dependencies = makeInput();
    dependencies.setCurrent({ ...job, state: "waiting" });
    dependencies.input.handle = {
      async completion() {
        return { finalCheckpoint: {}, exitReason: "aborted" as const };
      },
    } as unknown as ConductorHandle;
    dependencies.input.gateway = {
      async getTask() {
        return {
          id: job.taskId,
          projectId: job.projectId,
          title: "Task",
          priority: 1,
          position: 1,
          bucketId: layout.buckets.Waiting.id,
          done: false,
        };
      },
      async moveTask(_taskId: unknown, bucket: unknown) {
        dependencies.events.push(`move:${bucket}`);
      },
      async postComment() {
        return 101;
      },
    } as CompleteConductorJobInput["gateway"];

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toBeInstanceOf(JobCompletionError);

    expect(
      dependencies.mutations.get(
        "job:job-1:completion:move-failed:conductor_session_failed",
      ),
    ).toMatchObject({
      state: "succeeded",
      request: { bucketId: 6, expectedBucketId: 4 },
    });
    expect(dependencies.events).toContain("move:6");
  });

  it("does not overwrite an owner terminal move while reporting conductor failure", async () => {
    const dependencies = makeInput();
    dependencies.input.handle = {
      async completion() {
        return { finalCheckpoint: {}, exitReason: "session_failed" as const };
      },
    } as unknown as ConductorHandle;
    dependencies.input.gateway = {
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
      async moveTask(_taskId: unknown, bucket: unknown) {
        dependencies.events.push(`move:${bucket}`);
      },
      async postComment(_taskId: unknown, body: string) {
        dependencies.events.push(`comment:${body.includes("Review ready")}`);
        return 101;
      },
    } as CompleteConductorJobInput["gateway"];

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toBeInstanceOf(JobCompletionError);

    expect(dependencies.events).toEqual(["transition:failed", "comment:false"]);
    expect(
      dependencies.mutations.get(
        "job:job-1:completion:move-failed:conductor_session_failed",
      ),
    ).toMatchObject({ state: "failed" });
  });

  it("stops before publishing when an owner abort arrives during verification", async () => {
    const dependencies = makeInput();
    const cancellation = new AbortController();
    dependencies.input.repository = {
      async verify() {
        dependencies.events.push("verify");
        cancellation.abort();
        return passingVerification;
      },
      async publish() {
        dependencies.events.push("publish");
        return localPublish;
      },
    } as unknown as RepositoryManager;

    await expect(
      completeConductorJob({
        ...dependencies.input,
        cancellationSignal: cancellation.signal,
      }),
    ).rejects.toMatchObject({
      name: "JobCompletionError",
      job: { state: "failed", terminalErrorCode: "CONDUCTOR_SESSION_FAILED" },
    });

    expect(dependencies.events).not.toContain("publish");
  });

  it("fails before publishing when verification fails or leaves files dirty", async () => {
    const dependencies = makeInput();
    dependencies.input.repository = {
      async verify() {
        return { ...passingVerification, passed: false, worktreeClean: false };
      },
      async publish() {
        throw new Error("must not publish");
      },
    } as unknown as RepositoryManager;

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toBeInstanceOf(JobCompletionError);
    expect(dependencies.events).toContain("transition:failed");
    expect(dependencies.events).not.toContain("publish");
  });

  it("atomically persists failure intents before exposing a terminal job", async () => {
    const dependencies = makeInput();
    let recordedAtomically = false;
    const original = dependencies.input.store.recordTerminalFailure.bind(
      dependencies.input.store,
    );
    dependencies.input.store.recordTerminalFailure = async (
      id,
      terminalErrorCode,
      intents,
    ) => {
      expect(intents.map((intent) => intent.idempotencyKey)).toEqual([
        "job:job-1:completion:move-failed:verify_failed",
        "job:job-1:completion:verify_failed",
      ]);
      recordedAtomically = true;
      return original(id, terminalErrorCode, intents);
    };
    dependencies.input.repository = {
      async verify() {
        return { ...passingVerification, passed: false };
      },
      async publish() {
        return localPublish;
      },
    } as unknown as RepositoryManager;

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toBeInstanceOf(JobCompletionError);

    expect(recordedAtomically).toBe(true);
    expect(dependencies.current).toMatchObject({
      state: "failed",
      terminalErrorCode: "VERIFY_FAILED",
    });
    expect(
      dependencies.mutations.get(
        "job:job-1:completion:move-failed:verify_failed",
      ),
    ).toBeDefined();
    expect(
      dependencies.mutations.get("job:job-1:completion:verify_failed"),
    ).toBeDefined();
  });

  it("does not make a job terminal when failure intent persistence fails", async () => {
    const dependencies = makeInput();
    dependencies.input.store.recordTerminalFailure = async () => {
      throw new Error("database unavailable");
    };
    dependencies.input.repository = {
      async verify() {
        return { ...passingVerification, passed: false };
      },
      async publish() {
        return localPublish;
      },
    } as unknown as RepositoryManager;

    await expect(completeConductorJob(dependencies.input)).rejects.toThrow(
      "database unavailable",
    );

    expect(dependencies.current.state).toBe("running");
    expect(dependencies.events).toEqual(["completion"]);
    expect(dependencies.mutations.size).toBe(0);
  });

  it("retains a pending Failed-bucket intent when the remote move is unavailable", async () => {
    const dependencies = makeInput();
    dependencies.input.gateway = {
      async getTask() {
        return {
          id: job.taskId,
          projectId: job.projectId,
          title: "Task",
          priority: 1,
          position: 1,
          bucketId: layout.buckets.Running.id,
          done: false,
        };
      },
      async moveTask(_taskId: unknown, bucket: unknown) {
        if (bucket === 6) throw new Error("Vikunja unavailable");
      },
      async postComment() {
        return 101;
      },
    } as CompleteConductorJobInput["gateway"];
    dependencies.input.repository = {
      async verify() {
        return { ...passingVerification, passed: false };
      },
      async publish() {
        return localPublish;
      },
    } as unknown as RepositoryManager;

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toBeInstanceOf(JobCompletionError);
    expect(
      dependencies.mutations.get(
        "job:job-1:completion:move-failed:verify_failed",
      ),
    ).toMatchObject({ state: "pending", request: { bucketId: 6 } });
  });

  it("completes the Failed-bucket intent when reporting a failure succeeds", async () => {
    const dependencies = makeInput();
    dependencies.input.repository = {
      async verify() {
        return { ...passingVerification, passed: false };
      },
      async publish() {
        return localPublish;
      },
    } as unknown as RepositoryManager;

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toBeInstanceOf(JobCompletionError);

    expect(
      dependencies.mutations.get(
        "job:job-1:completion:move-failed:verify_failed",
      ),
    ).toMatchObject({
      state: "succeeded",
      remoteId: null,
      request: { bucketId: 6 },
    });
    expect(dependencies.events).toEqual([
      "completion",
      "transition:failed",
      "move:6",
      "comment:false",
    ]);
  });

  it("fails without exposing Review when the final report cannot be posted", async () => {
    const dependencies = makeInput();
    let remoteBucket = layout.buckets.Running.id;
    dependencies.input.gateway = {
      async getTask() {
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
      async moveTask(_taskId: unknown, bucket: unknown) {
        dependencies.events.push(`move:${bucket}`);
        remoteBucket = bucketId(bucket as number);
      },
      async postComment() {
        throw new Error("Vikunja unavailable");
      },
    } as CompleteConductorJobInput["gateway"];

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toMatchObject({
      name: "JobCompletionError",
      job: { state: "failed", terminalErrorCode: "VIKUNJA_UNAVAILABLE" },
    });
    expect(dependencies.events).toEqual([
      "completion",
      "verify",
      "publish",
      "transition:failed",
      "move:6",
    ]);
    expect(remoteBucket).toBe(layout.buckets.Failed.id);
    expect(
      dependencies.mutations.get(
        "job:job-1:completion:move-failed:vikunja_unavailable",
      ),
    ).toMatchObject({ state: "succeeded" });
    expect(
      dependencies.mutations.get("job:job-1:completion:review-comment"),
    ).toMatchObject({ state: "failed" });
    expect(dependencies.mutations.get("job:job-1:completion:move-review")).toBe(
      undefined,
    );
  });

  it("reconciles an ambiguously delivered Review report before moving the task", async () => {
    const dependencies = makeInput();
    const deliveredComments: Array<{
      id: ReturnType<typeof commentId>;
      body: string;
    }> = [];
    dependencies.input.gateway = {
      async getTask() {
        return {
          id: job.taskId,
          projectId: job.projectId,
          title: "Task",
          priority: 1,
          position: 1,
          bucketId: layout.buckets.Running.id,
          done: false,
        };
      },
      async listComments() {
        return deliveredComments.map((comment) => ({
          ...comment,
          authorId: 2 as never,
          createdAt: "2026-08-02T00:00:00.000Z",
        }));
      },
      async moveTask(_taskId: unknown, bucket: unknown) {
        dependencies.events.push(`move:${bucket}`);
      },
      async postComment(_taskId: unknown, body: string) {
        dependencies.events.push(`comment:${body.includes("Review ready")}`);
        deliveredComments.push({ id: commentId(101), body });
        throw new Error("response lost after comment");
      },
    } as CompleteConductorJobInput["gateway"];

    const result = await completeConductorJob(dependencies.input);

    expect(result.job.state).toBe("review");
    expect(deliveredComments).toHaveLength(1);
    expect(
      dependencies.mutations.get("job:job-1:completion:review-comment"),
    ).toMatchObject({ state: "succeeded", remoteId: "101" });
    expect(dependencies.events).toEqual([
      "completion",
      "verify",
      "publish",
      "comment:true",
      "move:5",
      "transition:review",
    ]);
  });

  it("treats an ambiguously applied Review move as successful", async () => {
    const dependencies = makeInput();
    let remoteBucket = layout.buckets.Running.id;
    dependencies.input.gateway = {
      async getTask() {
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
      async moveTask(_taskId: unknown, bucket: unknown) {
        remoteBucket = bucketId(bucket as number);
        dependencies.events.push(`move:${bucket}`);
        throw new Error("response lost after move");
      },
      async postComment(_taskId: unknown, body: string) {
        dependencies.events.push(`comment:${body.includes("Review ready")}`);
        return 101;
      },
    } as CompleteConductorJobInput["gateway"];

    const result = await completeConductorJob(dependencies.input);

    expect(result.job.state).toBe("review");
    expect(remoteBucket).toBe(layout.buckets.Review.id);
    expect(
      dependencies.mutations.get("job:job-1:completion:move-review"),
    ).toMatchObject({ state: "succeeded" });
    expect(dependencies.events).toEqual([
      "completion",
      "verify",
      "publish",
      "comment:true",
      "move:5",
      "transition:review",
    ]);
  });

  it("uses PUBLISH_FAILED when the configured push fails", async () => {
    const dependencies = makeInput();
    dependencies.input.repository = {
      async verify() {
        return passingVerification;
      },
      async publish() {
        throw new Error("push rejected");
      },
    } as unknown as RepositoryManager;

    await expect(
      completeConductorJob(dependencies.input),
    ).rejects.toMatchObject({
      name: "JobCompletionError",
      job: { state: "failed", terminalErrorCode: "PUBLISH_FAILED" },
    });
    expect(dependencies.events).toEqual([
      "completion",
      "transition:failed",
      "move:6",
      "comment:false",
    ]);
  });
});
