import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ConductorHandle } from "../src/conductor/gateway.js";
import type { ProjectConfig } from "../src/config/config.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import {
  type ExecuteClaimedJobInput,
  executeClaimedJob,
} from "../src/domain/orchestration.js";
import type { CodingTask, ProjectLayout } from "../src/domain/types.js";
import {
  bucketId,
  projectId,
  taskId,
  userId,
  viewId,
} from "../src/domain/types.js";
import type { RepositoryManager } from "../src/repositories/git.js";

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

const task: CodingTask = {
  id: taskId(12),
  projectId: project.id,
  title: "Fix API auth",
  description: "Use the configured worktree.",
  priority: 3,
  position: 1,
  bucketId: layout.buckets.Ready.id,
  done: false,
};

const initialJob: Job = {
  id: "job-1" as Job["id"],
  taskId: task.id,
  projectId: project.id,
  attempt: 1,
  state: "running",
  branch: null,
  worktree: null,
  conductorRunId: null,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  terminalErrorCode: null,
};

const makeInput = (): {
  input: ExecuteClaimedJobInput;
  events: string[];
  get verifiedWorktree(): string | undefined;
} => {
  let current = initialJob;
  let verifiedWorktree: string | undefined;
  const events: string[] = [];
  const mutations = new Map<
    string,
    { state: string; remoteId: string | null }
  >();
  const store = {
    async recordWorktree(_id: Job["id"], branch: string, worktree: string) {
      current = { ...current, branch, worktree };
      events.push("record-worktree");
      return current;
    },
    async recordRunId(_id: Job["id"], runId: string) {
      current = { ...current, conductorRunId: runId };
      events.push("record-run");
    },
    async getJob() {
      return current;
    },
    async getCommentWatermark() {
      return null;
    },
    async recordCommentWatermark() {},
    async recordTerminalFailure(
      _id: Job["id"],
      terminalErrorCode: NonNullable<Job["terminalErrorCode"]>,
      intents: Parameters<JobStore["recordMutationIntent"]>[0][],
    ) {
      for (const intent of intents) {
        await store.recordMutationIntent(intent);
      }
      current = { ...current, state: "failed", terminalErrorCode };
      events.push("transition:failed");
      return current;
    },
    async transition(
      _id: Job["id"],
      transition: Parameters<JobStore["transition"]>[1],
    ) {
      current = {
        ...current,
        state: transition.state,
        terminalErrorCode:
          transition.state === "failed" ? transition.terminalErrorCode : null,
      };
      events.push(`transition:${transition.state}`);
      return current;
    },
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
  } as unknown as JobStore;
  const repository = {
    async prepare() {
      events.push("prepare");
      return {
        repository: "/data/repositories/42/repo",
        branch: "pi/vikunja-12-fix-api-auth",
        worktree: "/data/jobs/12/worktree",
      };
    },
    async verify(worktree: { worktree: string }) {
      verifiedWorktree = worktree.worktree;
      events.push("verify");
      return {
        passed: true,
        latestCommit: "abc123",
        commands: [
          {
            command: ["pnpm", "test"],
            exitCode: 0,
            durationMs: 1,
            outputTail: "",
            passed: true,
          },
        ],
        worktreeClean: true,
        uncommittedFiles: [],
      };
    },
    async publish() {
      events.push("publish");
      return {
        pushed: false,
        remote: null,
        branch: "pi/vikunja-12-fix-api-auth",
      };
    },
  } as unknown as RepositoryManager;
  const handle = {
    runId: "run-1",
    async completion() {
      events.push("completion");
      return { finalCheckpoint: {}, exitReason: "done" as const };
    },
    latestResponse() {
      return {
        runId: "run-1",
        role: "orchestrator",
        sessionId: "session-1",
        text: "Done",
        completedAt: 1,
      };
    },
    runStats() {
      return {
        runId: "run-1",
        manifestVersion: "1",
        state: "done",
        exitReason: "done",
        transitionHistory: [],
        costRollup: {},
        latestCheckpoint: null,
        recordsCount: 1,
      };
    },
  } as unknown as ConductorHandle;
  const input: ExecuteClaimedJobInput = {
    job: initialJob,
    task,
    project,
    layout,
    ownerUserId: userId(1),
    runnerUserId: userId(2),
    store,
    gateway: {
      async getTask() {
        return { ...task, bucketId: layout.buckets.Running.id };
      },
      async listComments() {
        events.push("comments");
        return [];
      },
      async moveTask(_taskId, bucket) {
        events.push(`move:${bucket}`);
      },
      async postComment(_taskId, body) {
        events.push(
          body.includes("Review ready") ? "review-comment" : "other-comment",
        );
        return 101 as never;
      },
    },
    repository,
    conductor: {
      async start() {
        events.push("start");
        return handle;
      },
    },
    ui: {} as ExtensionUIContext,
  };
  return {
    input,
    events,
    get verifiedWorktree() {
      return verifiedWorktree;
    },
  };
};

describe("executeClaimedJob", () => {
  it("runs a claimed task through completion using the prepared worktree", async () => {
    const dependencies = makeInput();
    const result = await executeClaimedJob(dependencies.input);

    expect(result.job.state).toBe("review");
    expect(result.job.conductorRunId).toBe("run-1");
    expect(result.verification.passed).toBe(true);
    expect(dependencies.verifiedWorktree).toBe("/data/jobs/12/worktree");
    expect(dependencies.events).toEqual([
      "prepare",
      "record-worktree",
      "comments",
      "start",
      "record-run",
      "completion",
      "verify",
      "publish",
      "review-comment",
      "move:5",
      "transition:review",
    ]);
  });

  it("moves a claimed task to Failed and reports a repository start failure", async () => {
    const dependencies = makeInput();
    dependencies.input.repository = {
      async prepare() {
        dependencies.events.push("prepare-failed");
        throw new Error("git unavailable");
      },
    } as unknown as RepositoryManager;
    dependencies.input.gateway = {
      ...dependencies.input.gateway,
      async getTask() {
        dependencies.events.push("get-task");
        return { ...task, bucketId: layout.buckets.Running.id };
      },
      async moveTask(_taskId, bucket) {
        dependencies.events.push(`move:${bucket}`);
      },
      async postComment(_taskId, body) {
        dependencies.events.push(
          body.includes("REPOSITORY_PREPARE_FAILED")
            ? "start-failure-comment"
            : "other-comment",
        );
        return 102 as never;
      },
    };

    await expect(executeClaimedJob(dependencies.input)).rejects.toMatchObject({
      name: "JobStartError",
      job: expect.objectContaining({
        state: "failed",
        terminalErrorCode: "REPOSITORY_PREPARE_FAILED",
      }),
    });
    expect(dependencies.events).toEqual([
      "prepare-failed",
      "transition:failed",
      "get-task",
      "get-task",
      "move:6",
      "start-failure-comment",
    ]);
  });

  it("requests a graceful abort from an active conductor when shutdown is signalled", async () => {
    const dependencies = makeInput();
    const controller = new AbortController();
    let finishCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      finishCompletion = resolve;
    });
    const shutdownHandle = {
      runId: "run-1",
      async completion() {
        await completion;
        return { finalCheckpoint: {}, exitReason: "aborted" as const };
      },
      async abort(reason?: string) {
        dependencies.events.push(`abort:${reason ?? ""}`);
        finishCompletion?.();
      },
      async steer() {},
      async followUp() {},
      latestResponse() {
        return null;
      },
      runStats() {
        return {
          state: "aborted",
          exitReason: "aborted",
          recordsCount: 0,
          transitionHistory: [],
        } as never;
      },
    } as unknown as ConductorHandle;
    const execution = executeClaimedJob({
      ...dependencies.input,
      signal: controller.signal,
      conductor: {
        async start() {
          dependencies.events.push("start");
          return shutdownHandle;
        },
      },
    });

    while (!dependencies.events.includes("record-run")) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      name: "JobCompletionError",
    });
    expect(dependencies.events).toContain("abort:runner shutting down");
  });
});
