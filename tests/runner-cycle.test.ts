import { describe, expect, it, vi } from "vitest";
import type {
  ConductorGateway,
  RunnerUiContext,
} from "../src/conductor/gateway.js";
import type { ProjectConfig } from "../src/config/config.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import { runPollCycle } from "../src/domain/runner.js";
import {
  bucketId,
  type CodingTask,
  commentId,
  type ProjectLayout,
  projectId,
  taskId,
  viewId,
} from "../src/domain/types.js";
import type { RepositoryManager } from "../src/repositories/git.js";
import type { VikunjaGateway } from "../src/vikunja/gateway.js";

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
  title: "Implement cycle",
  description: "",
  priority: 1,
  position: 1,
  bucketId: layout.buckets.Ready.id,
  done: false,
};

const job: Job = {
  id: "job-12" as Job["id"],
  taskId: task.id,
  projectId: project.id,
  attempt: 1,
  state: "claiming",
  branch: "pi/vikunja-12-implement-cycle",
  worktree: null,
  conductorRunId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  terminalErrorCode: null,
};

const dependencies = (ready = true) => {
  const claimed = { ...job, state: "running" as const };
  const getTask = vi
    .fn<() => Promise<CodingTask>>()
    .mockResolvedValueOnce(task)
    .mockResolvedValue({ ...task, bucketId: layout.buckets.Running.id });
  const validateProjectLayout = vi.fn(async () => layout);
  const store = {
    recordHeartbeat: vi.fn(async () => undefined),
    recoverableJobs: vi.fn(async () => []),
    tryClaim: vi.fn(async () => (ready ? job : null)),
    transition: vi.fn(async () => claimed),
    getTask,
    recordMutationIntent: vi.fn(async (input: { idempotencyKey: string }) => ({
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
    })),
    completeMutation: vi.fn(async () => undefined),
    recordMilestone: vi.fn(async (input: { idempotencyKey: string }) => ({
      id: "milestone-1",
      ...input,
      jobId: job.id,
      type: "claimed",
      commentId: null,
      deliveryState: "pending",
      error: null,
      createdAt: "",
      updatedAt: "",
    })),
    recordMilestoneComment: vi.fn(async () => undefined),
  } as unknown as JobStore;
  const gateway = {
    validateProjectLayout,
    listReadyTasks: vi.fn(async () => (ready ? [task] : [])),
    getTask,
    moveTask: vi.fn(async () => undefined),
    assignRunner: vi.fn(async () => undefined),
    postComment: vi.fn(async () => commentId(101)),
    listComments: vi.fn(async () => []),
  } as unknown as VikunjaGateway;
  return { store, gateway, getTask, validateProjectLayout };
};

const noopRepository = {} as RepositoryManager;
const noopConductor = {} as ConductorGateway;
const noopUi = {} as RunnerUiContext;

describe("runPollCycle", () => {
  it("executes the claimed job after re-reading its task and validated layout", async () => {
    const { store, gateway, getTask, validateProjectLayout } = dependencies();
    const execute = vi.fn(async () => ({
      job: { ...job, state: "review" as const },
      goal: "goal",
      handle: {} as never,
      verification: {} as never,
      publish: {} as never,
    }));

    const report = await runPollCycle({
      projects: { "42": project },
      store,
      gateway,
      ownerUserId: 1 as never,
      runnerUserId: 2 as never,
      repository: noopRepository,
      conductor: noopConductor as never,
      uiForJob: () => noopUi,
      execute,
    });

    expect(report.poll.claim?.status).toBe("claimed");
    expect(store.recordHeartbeat).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      job: { ...job, state: "running" },
      task: { ...task, bucketId: layout.buckets.Running.id },
      project,
      layout,
    });
    expect(getTask).toHaveBeenCalledWith(task.id);
    expect(validateProjectLayout).toHaveBeenCalledTimes(2);
  });

  it("fails and reports a claimed job when its post-claim task refresh fails", async () => {
    const { store, gateway, getTask } = dependencies();
    getTask
      .mockReset()
      .mockResolvedValueOnce(task)
      .mockRejectedValueOnce(new Error("Vikunja unavailable"))
      .mockRejectedValueOnce(new Error("Vikunja unavailable"));
    vi.mocked(store.transition).mockImplementation(async (_id, transition) => ({
      ...job,
      state: transition.state,
      terminalErrorCode:
        transition.state === "failed" ? transition.terminalErrorCode : null,
    }));
    const execute = vi.fn();

    await expect(
      runPollCycle({
        projects: { "42": project },
        store,
        gateway,
        ownerUserId: 1 as never,
        runnerUserId: 2 as never,
        repository: noopRepository,
        conductor: noopConductor as never,
        uiForJob: () => noopUi,
        execute,
      }),
    ).rejects.toThrow("Vikunja unavailable");

    expect(store.transition).toHaveBeenLastCalledWith(job.id, {
      state: "failed",
      terminalErrorCode: "VIKUNJA_UNAVAILABLE",
    });
    expect(gateway.postComment).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("VIKUNJA_UNAVAILABLE"),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute when no Ready task is claimed", async () => {
    const { store, gateway } = dependencies(false);
    const execute = vi.fn();

    const report = await runPollCycle({
      projects: { "42": project },
      store,
      gateway,
      ownerUserId: 1 as never,
      runnerUserId: 2 as never,
      repository: noopRepository,
      conductor: noopConductor as never,
      uiForJob: () => noopUi,
      execute,
    });

    expect(report.execution).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
