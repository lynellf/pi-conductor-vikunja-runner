import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import { pollOnce } from "../src/domain/polling.js";
import {
  bucketId,
  type CodingTask,
  commentId,
  type ProjectLayout,
  projectId,
  taskId,
  viewId,
} from "../src/domain/types.js";
import type { Milestone } from "../src/persistence/contracts.js";
import type { VikunjaGateway } from "../src/vikunja/gateway.js";

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

const task = (id: number, priority: number): CodingTask => ({
  id: taskId(id),
  projectId: project.id,
  title: `Task ${id}`,
  description: "",
  priority,
  position: id,
  bucketId: layout.buckets.Ready.id,
  done: false,
});

const makeDependencies = (readyTasks: readonly CodingTask[]) => {
  let active: Job | null = null;
  const claimedTaskIds: number[] = [];
  const transitions: string[] = [];
  const job: Job = {
    id: "job-1" as Job["id"],
    taskId: task(1, 1).id,
    projectId: project.id,
    attempt: 1,
    state: "claiming",
    branch: "pi/vikunja-1-task-1",
    worktree: null,
    conductorRunId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    terminalErrorCode: null,
  };
  const store = {
    async recoverableJobs() {
      return active === null ? [] : [active];
    },
    async tryClaim(candidate: CodingTask) {
      if (active !== null) return null;
      active = { ...job, taskId: candidate.id };
      claimedTaskIds.push(candidate.id);
      return active;
    },
    async transition(
      _id: Job["id"],
      transition: Parameters<JobStore["transition"]>[1],
    ) {
      transitions.push(transition.state);
      active = { ...(active as Job), state: transition.state };
      return active;
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
      };
    },
    async completeMutation() {
      return {};
    },
    async recordMilestone(input: {
      jobId: Job["id"];
      type: Milestone["type"];
      idempotencyKey: string;
    }) {
      return {
        id: "milestone-1",
        ...input,
        commentId: null,
        deliveryState: "pending",
        error: null,
        createdAt: "",
        updatedAt: "",
      };
    },
    async recordMilestoneComment() {
      return {};
    },
    async recordCommentWatermark() {},
  } as unknown as JobStore;
  const gateway = {
    async validateProjectLayout() {
      return layout;
    },
    async listReadyTasks() {
      return readyTasks;
    },
    async getTask(id: ReturnType<typeof taskId>) {
      return readyTasks.find((candidate) => candidate.id === id) ?? task(id, 1);
    },
    async moveTask() {},
    async assignRunner() {},
    async postComment() {
      return commentId(100);
    },
    async listComments() {
      return [];
    },
  } as unknown as VikunjaGateway;
  return { store, gateway, claimedTaskIds, transitions };
};

describe("pollOnce", () => {
  it("validates layouts and claims the highest-priority Ready task once", async () => {
    const dependencies = makeDependencies([task(1, 2), task(2, 9)]);

    const first = await pollOnce({
      projects: { "42": project },
      store: dependencies.store,
      gateway: dependencies.gateway,
    });
    const second = await pollOnce({
      projects: { "42": project },
      store: dependencies.store,
      gateway: dependencies.gateway,
    });

    expect(first.validatedProjects).toEqual([project.id]);
    expect(first.listedTasks).toBe(2);
    expect(first.eligibleTaskIds).toEqual([taskId(2)]);
    expect(first.claim?.status).toBe("claimed");
    expect(second.eligibleTaskIds).toEqual([]);
    expect(second.claim).toBeNull();
    expect(dependencies.claimedTaskIds).toEqual([2]);
    expect(dependencies.transitions).toEqual(["running"]);
  });

  it("does not claim when a recoverable job already occupies the global slot", async () => {
    const dependencies = makeDependencies([task(1, 2)]);
    await pollOnce({
      projects: { "42": project },
      store: dependencies.store,
      gateway: dependencies.gateway,
    });

    const report = await pollOnce({
      projects: { "42": project },
      store: dependencies.store,
      gateway: dependencies.gateway,
    });
    expect(report.claim).toBeNull();
    expect(report.eligibleTaskIds).toEqual([]);
  });
});
