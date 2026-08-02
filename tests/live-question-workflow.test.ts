import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { ConductorHandle } from "../src/conductor/gateway.js";
import type { ProjectConfig } from "../src/config/config.js";
import { executeClaimedJob } from "../src/domain/orchestration.js";
import type {
  CodingTask,
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
import { SqliteJobStore } from "../src/persistence/sqlite.js";
import type { RepositoryManager } from "../src/repositories/git.js";
import { createVikunjaQuestionUi } from "../src/vikunja/interaction-ui.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

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

const project: ProjectConfig = {
  id: projectId(42),
  displayIdentifier: "PC",
  kanbanViewId: viewId(8),
  repository: "git@example.test:owner/repo.git",
  defaultBranch: "main",
  conductorManifest: ".pi/conductor.yaml",
  publish: { mode: "local", remote: "origin" },
  verifyCommands: [["pnpm", "test"]],
};

describe("live Vikunja question workflow", () => {
  it("returns an owner reply to the same live conductor call before Review", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-live-question-"));
    temporaryDirectories.push(root);
    const store = await SqliteJobStore.open(join(root, "state.sqlite"));
    const task: CodingTask = {
      id: taskId(12),
      projectId: project.id,
      title: "Choose the implementation",
      priority: 1,
      position: 1,
      bucketId: layout.buckets.Ready.id,
      done: false,
    };
    const claimed = await store.tryClaim(task);
    if (claimed === null) throw new Error("claim fixture failed");
    const running = await store.transition(claimed.id, { state: "running" });
    let remoteTask = { ...task, bucketId: layout.buckets.Running.id };
    const comments: TaskComment[] = [];
    let nextCommentId = 1;
    let answerReceivedByConductor: string | undefined;
    const gateway = {
      async getTask() {
        return remoteTask;
      },
      async moveTask(_taskId: typeof task.id, target: typeof task.bucketId) {
        remoteTask = { ...remoteTask, bucketId: target };
      },
      async assignRunner() {},
      async listComments(_taskId: typeof task.id, after: number | null) {
        return comments.filter(
          (comment) => after === null || comment.id > after,
        );
      },
      async postComment(_taskId: typeof task.id, body: string) {
        const id = commentId(nextCommentId++);
        comments.push({
          id,
          taskId: task.id,
          authorId: userId(2),
          body,
          createdAt: new Date().toISOString(),
        });
        if (body.includes("**Question**")) {
          queueMicrotask(() => {
            comments.push({
              id: commentId(nextCommentId++),
              taskId: task.id,
              authorId: userId(1),
              body: "Use the safer option",
              createdAt: new Date().toISOString(),
            });
          });
        }
        return id;
      },
    };
    const ui = createVikunjaQuestionUi({} as ExtensionUIContext, {
      gateway: gateway as never,
      store,
      job: running,
      layout,
      ownerUserId: userId(1),
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const handle = {
      runId: "run-live-question",
      async completion() {
        answerReceivedByConductor = await ui.input(
          "Which option?",
          undefined,
          {},
        );
        return { finalCheckpoint: {}, exitReason: "done" as const };
      },
      latestResponse() {
        return {
          runId: "run-live-question",
          role: "orchestrator",
          sessionId: "session-1",
          text: `Implemented: ${answerReceivedByConductor}`,
          completedAt: Date.now(),
        };
      },
      runStats() {
        return {
          state: "done",
          exitReason: "done",
          recordsCount: 4,
          transitionHistory: [],
        } as never;
      },
      async abort() {},
      async steer() {},
      async followUp() {},
    } as unknown as ConductorHandle;
    const repository = {
      async prepare() {
        return {
          repository: join(root, "repository"),
          branch: "pi/vikunja-12-choose-the-implementation",
          worktree: join(root, "jobs", "12", "worktree"),
        };
      },
      async verify() {
        return {
          passed: true,
          latestCommit: "abc123",
          commands: [],
          worktreeClean: true,
          uncommittedFiles: [],
        };
      },
      async publish() {
        return {
          pushed: false,
          remote: null,
          branch: "pi/vikunja-12-choose-the-implementation",
        };
      },
    } as unknown as RepositoryManager;

    try {
      const result = await executeClaimedJob({
        job: running,
        task,
        project,
        layout,
        ownerUserId: userId(1),
        runnerUserId: userId(2),
        store,
        gateway: gateway as never,
        repository,
        conductor: { start: async () => handle, resume: async () => handle },
        ui,
      });

      expect(answerReceivedByConductor).toBe("Use the safer option");
      expect(result.job.state).toBe("review");
      expect(remoteTask.bucketId).toBe(layout.buckets.Review.id);
      expect(
        comments.filter((comment) => comment.body.includes("**Question**")),
      ).toHaveLength(1);
      expect(
        comments.filter((comment) => comment.body.includes("Review ready")),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
