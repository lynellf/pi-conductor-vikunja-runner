import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type {
  ConductorGateway,
  ConductorHandle,
} from "../src/conductor/gateway.js";
import type { ProjectConfig } from "../src/config/config.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import {
  resumeRecoverableJob,
  startClaimedJob,
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

const job: Job = {
  id: "job-1" as Job["id"],
  taskId: taskId(12),
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

const task: CodingTask = {
  id: taskId(12),
  projectId: project.id,
  title: "Fix API auth",
  description: "Use the configured worktree.",
  priority: 3,
  position: 1,
  bucketId: bucketId(2),
  done: false,
};

const handle = { runId: "run-1" } as unknown as ConductorHandle;
const ui = {} as ExtensionUIContext;

const makeInput = (overrides: Record<string, unknown> = {}) => {
  const events: string[] = [];
  let persisted: Job = job;
  const store = {
    async recordWorktree(id: Job["id"], branch: string, worktree: string) {
      events.push(`worktree:${id}:${branch}:${worktree}`);
      persisted = { ...persisted, branch, worktree };
      return persisted;
    },
    async recordRunId(id: Job["id"], runId: string) {
      events.push(`run:${id}:${runId}`);
      persisted = { ...persisted, conductorRunId: runId };
    },
    async getJob() {
      return persisted;
    },
    async transition(
      _id: Job["id"],
      transition: Parameters<JobStore["transition"]>[1],
    ) {
      events.push(`transition:${transition.state}`);
      persisted = {
        ...persisted,
        state: transition.state,
        terminalErrorCode:
          transition.state === "failed" ? transition.terminalErrorCode : null,
      };
      return persisted;
    },
  } as unknown as JobStore;
  const repository = {
    async prepare() {
      events.push("prepare");
      return {
        repository: "/data/repo",
        branch: "pi/vikunja-12-fix-api-auth",
        worktree: "/data/jobs/12/worktree",
      };
    },
  } as unknown as RepositoryManager;
  const conductor = {
    async start(startedJob: Job, goal: string, receivedUi: unknown) {
      events.push(
        `start:${startedJob.branch}:${goal.includes("Fix API auth")}:${receivedUi === ui}`,
      );
      return handle;
    },
  } as unknown as ConductorGateway;
  const gateway = {
    async listComments() {
      events.push("comments");
      return [];
    },
  };
  return {
    input: {
      job,
      task,
      project,
      layout,
      ownerUserId: userId(1),
      runnerUserId: userId(2),
      store,
      gateway,
      repository,
      conductor,
      ui,
      ...overrides,
    },
    events,
    store,
  };
};

describe("resumeRecoverableJob", () => {
  it("resumes the persisted run without changing its run mapping", async () => {
    const dependencies = makeInput();
    const recoverableJob = {
      ...job,
      branch: "pi/vikunja-12-fix-api-auth",
      worktree: "/data/jobs/12/worktree",
      conductorRunId: "run-1",
    };
    dependencies.input.job = recoverableJob;
    dependencies.input.store = {
      ...dependencies.input.store,
      async getJob() {
        return recoverableJob;
      },
    } as unknown as JobStore;
    dependencies.input.conductor = {
      async resume(resumedJob: Job, receivedUi: unknown) {
        dependencies.events.push(
          `resume:${resumedJob.conductorRunId}:${receivedUi === ui}`,
        );
        return handle;
      },
    } as unknown as ConductorGateway;

    const result = await resumeRecoverableJob(dependencies.input);

    expect(result.job.conductorRunId).toBe("run-1");
    expect(result.handle).toBe(handle);
    expect(dependencies.events).toEqual(["resume:run-1:true"]);
  });

  it("fails safely when resuming does not return the recorded run", async () => {
    const dependencies = makeInput();
    dependencies.input.job = {
      ...job,
      conductorRunId: "run-1",
      branch: "pi/vikunja-12-fix-api-auth",
      worktree: "/data/jobs/12/worktree",
    };
    dependencies.input.conductor = {
      async resume() {
        return { ...handle, runId: "different-run" };
      },
    } as unknown as ConductorGateway;

    await expect(
      resumeRecoverableJob(dependencies.input),
    ).rejects.toMatchObject({
      name: "JobStartError",
      job: expect.objectContaining({
        state: "failed",
        terminalErrorCode: "CONDUCTOR_START_FAILED",
      }),
    });
    expect(dependencies.events).toContain("transition:failed");
  });

  it("fails when the resumed job cannot be reloaded", async () => {
    const dependencies = makeInput();
    dependencies.input.job = {
      ...job,
      conductorRunId: "run-1",
      branch: "pi/vikunja-12-fix-api-auth",
      worktree: "/data/jobs/12/worktree",
    };
    dependencies.input.store = {
      ...dependencies.input.store,
      async getJob() {
        return null;
      },
    } as unknown as JobStore;
    dependencies.input.conductor = {
      async resume() {
        return handle;
      },
    } as unknown as ConductorGateway;

    await expect(
      resumeRecoverableJob(dependencies.input),
    ).rejects.toMatchObject({
      name: "JobStartError",
      job: expect.objectContaining({
        state: "failed",
        terminalErrorCode: "CONDUCTOR_START_FAILED",
      }),
    });
    expect(dependencies.events).toContain("transition:failed");
  });

  it("does not resume a waiting job without replaying its dialog", async () => {
    const dependencies = makeInput();
    dependencies.input.job = { ...job, state: "waiting" };

    await expect(resumeRecoverableJob(dependencies.input)).rejects.toThrow(
      "only a running job can resume",
    );
    expect(dependencies.events).toEqual([]);
  });
});

describe("startClaimedJob", () => {
  it("prepares the worktree, starts conductor, and persists its run ID", async () => {
    const dependencies = makeInput();

    const result = await startClaimedJob(dependencies.input);

    expect(result.job.conductorRunId).toBe("run-1");
    expect(result.job.branch).toBe("pi/vikunja-12-fix-api-auth");
    expect(result.goal).toContain("PC-12");
    expect(dependencies.events).toEqual([
      "prepare",
      "worktree:job-1:pi/vikunja-12-fix-api-auth:/data/jobs/12/worktree",
      "comments",
      "start:pi/vikunja-12-fix-api-auth:true:true",
      "run:job-1:run-1",
    ]);
  });

  it("fails the job with a stable preparation code when repository setup fails", async () => {
    const dependencies = makeInput();
    dependencies.input.repository = {
      async prepare() {
        throw new Error("git unavailable");
      },
    } as unknown as RepositoryManager;

    await expect(startClaimedJob(dependencies.input)).rejects.toMatchObject({
      name: "JobStartError",
      job: expect.objectContaining({
        state: "failed",
        terminalErrorCode: "REPOSITORY_PREPARE_FAILED",
      }),
    });
    expect(dependencies.events).toEqual(["transition:failed"]);
  });

  it("fails the job when the conductor cannot start", async () => {
    const dependencies = makeInput();
    dependencies.input.conductor = {
      async start() {
        throw new Error("model provider unavailable");
      },
    } as unknown as ConductorGateway;

    await expect(startClaimedJob(dependencies.input)).rejects.toMatchObject({
      name: "JobStartError",
      job: expect.objectContaining({
        state: "failed",
        terminalErrorCode: "CONDUCTOR_START_FAILED",
      }),
    });
    expect(dependencies.events).toEqual([
      "prepare",
      "worktree:job-1:pi/vikunja-12-fix-api-auth:/data/jobs/12/worktree",
      "comments",
      "transition:failed",
    ]);
  });

  it("fails the job when run ID persistence fails after conductor start", async () => {
    const dependencies = makeInput();
    dependencies.input.store = {
      ...dependencies.input.store,
      async recordRunId() {
        throw new Error("database unavailable");
      },
    } as unknown as JobStore;

    await expect(startClaimedJob(dependencies.input)).rejects.toMatchObject({
      name: "JobStartError",
      job: expect.objectContaining({
        state: "failed",
        terminalErrorCode: "CONDUCTOR_START_FAILED",
      }),
    });
    expect(dependencies.events).toEqual([
      "prepare",
      "worktree:job-1:pi/vikunja-12-fix-api-auth:/data/jobs/12/worktree",
      "comments",
      "start:pi/vikunja-12-fix-api-auth:true:true",
      "transition:failed",
    ]);
  });
});
