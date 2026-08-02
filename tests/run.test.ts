import { describe, expect, it, vi } from "vitest";
import type { OnceRuntime } from "../src/cli/once.js";
import {
  type DaemonDependencies,
  defaultResumeJobs,
  runDaemon,
  sleepWithShutdown,
} from "../src/cli/run.js";
import { parseConfig, type RunnerConfig } from "../src/config/config.js";
import type { Job, JobStore } from "../src/domain/jobs.js";
import type { RunnerCycleReport } from "../src/domain/runner.js";
import {
  bucketId,
  type ProjectLayout,
  projectId,
  taskId,
} from "../src/domain/types.js";

const config = (): RunnerConfig =>
  parseConfig({
    version: 1,
    vikunja: {
      base_url: "https://vikunja.example",
      token_file: "/run/vikunja-token",
      owner_user_id: 1,
      runner_user_id: 2,
      poll_interval_seconds: 30,
      waiting_poll_interval_seconds: 15,
      request_timeout_seconds: 10,
      allow_insecure_http: false,
    },
    runner: {
      data_dir: "/var/lib/runner",
      global_concurrency: 1,
      agent_dir: "/var/lib/runner/pi-agent",
      analytics_config_path: "/run/analytics.json",
      max_comment_chars: 12000,
    },
    projects: {
      "42": {
        display_identifier: "PC",
        kanban_view_id: 8,
        repository: "git@example/repo",
        default_branch: "main",
        conductor_manifest: ".pi/conductor.yaml",
        publish: { mode: "local", remote: "origin" },
        verify_commands: [["pnpm", "test"]],
      },
    },
  });

const report: RunnerCycleReport = {
  poll: {
    validatedProjects: [],
    listedTasks: 0,
    eligibleTaskIds: [],
    claim: null,
  },
  execution: null,
};

const runtime = (): OnceRuntime => ({
  store: {} as JobStore,
  gateway: {} as OnceRuntime["gateway"],
  repository: {} as OnceRuntime["repository"],
  conductor: {} as OnceRuntime["conductor"],
  close: () => undefined,
});

const layout = {} as ProjectLayout;

describe("runner daemon", () => {
  it("validates layouts, reconciles startup, polls until stopped, and closes resources", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    let cycleCount = 0;
    const dependencies: Partial<DaemonDependencies> = {
      loadConfig: async () => config(),
      readCredential: async (_path, label) => {
        calls.push(`credential:${label}`);
        return "credential";
      },
      createRuntime: async () => runtime(),
      startAnalytics: async () => {
        calls.push("analytics:start");
        return {
          shutdown: async () => calls.push("analytics:shutdown"),
        };
      },
      validateLayouts: async () => {
        calls.push("layouts");
        const project = config().projects["42"];
        if (project === undefined) throw new Error("test project missing");
        return new Map([[project.id, layout]]);
      },
      reconcile: async () => {
        calls.push("reconcile");
        return {
          jobsChecked: 0,
          jobsFailed: 0,
          questionsInterrupted: 0,
          manualOverrides: 0,
          mutationsReplayed: 0,
          mutationsPending: 0,
          mutationFailures: 0,
        };
      },
      resumeJobs: async () => {
        calls.push("resume");
        return 0;
      },
      runCycle: async () => {
        cycleCount += 1;
        calls.push(`cycle:${cycleCount}`);
        controller.abort();
        return report;
      },
      sleep: async () => calls.push("sleep"),
    };

    const result = await runDaemon(
      "/etc/runner.yaml",
      dependencies,
      controller.signal,
    );

    expect(result.cycles).toBe(1);
    expect(calls).toEqual([
      "credential:Vikunja token",
      "credential:Analytics configuration",
      "analytics:start",
      "layouts",
      "reconcile",
      "resume",
      "cycle:1",
      "analytics:shutdown",
    ]);
  });

  it("retries deferred recovery after a poll interval without requiring restart", async () => {
    const controller = new AbortController();
    const deferredJobId = "job-deferred" as Job["id"];
    const calls: string[] = [];
    let reconciliations = 0;
    let cycles = 0;
    const result = await runDaemon(
      "/etc/runner.yaml",
      {
        loadConfig: async () => config(),
        readCredential: async () => "credential",
        createRuntime: async () => runtime(),
        startAnalytics: async () => ({ shutdown: async () => undefined }),
        validateLayouts: async () => new Map(),
        reconcile: async () => {
          reconciliations += 1;
          calls.push(`reconcile:${reconciliations}`);
          return {
            jobsChecked: 1,
            jobsFailed: 0,
            questionsInterrupted: 0,
            manualOverrides: 0,
            mutationsReplayed: 0,
            mutationsPending: 0,
            mutationFailures: 0,
            deferredJobIds:
              reconciliations === 1 ? [deferredJobId] : ([] as Job["id"][]),
          };
        },
        resumeJobs: async (input) => {
          calls.push(
            `resume:${input.deferredJobIds?.includes(deferredJobId) ?? false}`,
          );
          return input.deferredJobIds?.includes(deferredJobId) ? 0 : 1;
        },
        runCycle: async () => {
          cycles += 1;
          calls.push(`cycle:${cycles}`);
          if (cycles === 2) controller.abort("recovered");
          return report;
        },
        sleep: async () => calls.push("sleep"),
      },
      controller.signal,
    );

    expect(result).toMatchObject({ cycles: 2, resumedJobs: 1 });
    expect(calls).toEqual([
      "reconcile:1",
      "resume:true",
      "cycle:1",
      "sleep",
      "reconcile:2",
      "resume:false",
      "cycle:2",
    ]);
  });

  it("continues coding when the analytics credential is unavailable", async () => {
    const controller = new AbortController();
    const errors: Error[] = [];
    const result = await runDaemon(
      "/etc/runner.yaml",
      {
        loadConfig: async () => config(),
        readCredential: async (_path, label) => {
          if (label === "Analytics configuration") {
            throw new Error("analytics unavailable");
          }
          return "token";
        },
        createRuntime: async () => runtime(),
        startAnalytics: async () => {
          throw new Error("must not start analytics without configuration");
        },
        validateLayouts: async () => new Map(),
        reconcile: async () => ({
          jobsChecked: 0,
          jobsFailed: 0,
          questionsInterrupted: 0,
          manualOverrides: 0,
          mutationsReplayed: 0,
          mutationsPending: 0,
          mutationFailures: 0,
        }),
        resumeJobs: async () => 0,
        runCycle: async () => {
          controller.abort();
          return report;
        },
        logError: (error) => errors.push(error),
      },
      controller.signal,
    );

    expect(result.cycles).toBe(1);
    expect(errors[0]?.message).toContain("analytics unavailable");
  });

  it("keeps runtime resources open after a cycle drain timeout until the cycle settles", async () => {
    const controller = new AbortController();
    let closed = false;
    let analyticsStopped = false;
    let finishCycle: (() => void) | undefined;
    const errors: Error[] = [];
    const dependencies: Partial<DaemonDependencies> = {
      loadConfig: async () => config(),
      readCredential: async () => "credential",
      createRuntime: async () => ({
        ...runtime(),
        close: () => {
          closed = true;
        },
      }),
      startAnalytics: async () => ({
        shutdown: async () => {
          analyticsStopped = true;
        },
      }),
      validateLayouts: async () => new Map(),
      reconcile: async () => ({
        jobsChecked: 0,
        jobsFailed: 0,
        questionsInterrupted: 0,
        manualOverrides: 0,
        mutationsReplayed: 0,
        mutationsPending: 0,
        mutationFailures: 0,
      }),
      resumeJobs: async () => 0,
      runCycle: () =>
        new Promise<RunnerCycleReport>((resolve) => {
          finishCycle = () => resolve(report);
        }),
      shutdownTimeoutMilliseconds: 1,
      logError: (error) => errors.push(error),
    };

    const running = runDaemon(
      "/etc/runner.yaml",
      dependencies,
      controller.signal,
    );
    while (finishCycle === undefined) await Promise.resolve();
    controller.abort("shutdown");
    while (errors.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(closed).toBe(false);
    expect(analyticsStopped).toBe(false);
    expect(errors[0]?.message).toContain("shutdown timeout");

    finishCycle();
    const result = await running;
    expect(result.cycles).toBe(1);
    expect(closed).toBe(true);
    expect(analyticsStopped).toBe(true);
  });

  it("rejects unsafe project Git values before reading credentials", async () => {
    const project = config().projects["42"];
    if (project === undefined) throw new Error("test project missing");
    const unsafe = {
      ...config(),
      projects: { "42": { ...project, defaultBranch: "main..unsafe" } },
    };
    const calls: string[] = [];

    await expect(
      runDaemon("/etc/runner.yaml", {
        loadConfig: async () => unsafe,
        readCredential: async () => {
          calls.push("credential");
          return "credential";
        },
        createRuntime: async () => {
          calls.push("runtime");
          return runtime();
        },
      }),
    ).rejects.toThrow("safe Git branch name");
    expect(calls).toEqual([]);
  });

  it("adds bounded positive jitter to the configured poll interval", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    const dependencies: Partial<DaemonDependencies> = {
      loadConfig: async () => config(),
      readCredential: async () => "credential",
      createRuntime: async () => runtime(),
      startAnalytics: async () => ({ shutdown: async () => undefined }),
      validateLayouts: async () => new Map(),
      reconcile: async () => ({
        jobsChecked: 0,
        jobsFailed: 0,
        questionsInterrupted: 0,
        manualOverrides: 0,
        mutationsReplayed: 0,
        mutationsPending: 0,
        mutationFailures: 0,
      }),
      resumeJobs: async () => 0,
      runCycle: async () => report,
      pollJitterMilliseconds: () => 250,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        controller.abort("test stop");
      },
    };

    const result = await runDaemon(
      "/etc/runner.yaml",
      dependencies,
      controller.signal,
    );

    expect(result.cycles).toBe(1);
    expect(delays).toEqual([30_250]);
  });

  it("clamps invalid or excessive poll jitter without shortening the interval", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    const dependencies: Partial<DaemonDependencies> = {
      loadConfig: async () => config(),
      readCredential: async () => "credential",
      createRuntime: async () => runtime(),
      startAnalytics: async () => ({ shutdown: async () => undefined }),
      validateLayouts: async () => new Map(),
      reconcile: async () => ({
        jobsChecked: 0,
        jobsFailed: 0,
        questionsInterrupted: 0,
        manualOverrides: 0,
        mutationsReplayed: 0,
        mutationsPending: 0,
        mutationFailures: 0,
      }),
      resumeJobs: async () => 0,
      runCycle: async () => report,
      pollJitterMilliseconds: () => Number.POSITIVE_INFINITY,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        controller.abort("test stop");
      },
    };

    await runDaemon("/etc/runner.yaml", dependencies, controller.signal);

    expect(delays).toEqual([30_000]);
  });

  it("keeps polling after a cycle error and reports the error", async () => {
    const controller = new AbortController();
    const errors: string[] = [];
    let sleeps = 0;
    const dependencies: Partial<DaemonDependencies> = {
      loadConfig: async () => config(),
      readCredential: async () => "credential",
      createRuntime: async () => runtime(),
      startAnalytics: async () => ({ shutdown: async () => undefined }),
      validateLayouts: async () => new Map(),
      reconcile: async () => ({
        jobsChecked: 0,
        jobsFailed: 0,
        questionsInterrupted: 0,
        manualOverrides: 0,
        mutationsReplayed: 0,
        mutationsPending: 0,
        mutationFailures: 0,
      }),
      resumeJobs: async () => 0,
      runCycle: async () => {
        controller.abort();
        throw new Error("poll failed");
      },
      sleep: async () => {
        sleeps += 1;
      },
      logError: (error) => errors.push(error.message),
    };

    const result = await runDaemon(
      "/etc/runner.yaml",
      dependencies,
      controller.signal,
    );

    expect(result.cycles).toBe(1);
    expect(sleeps).toBe(0);
    expect(errors).toEqual(["poll failed"]);
  });

  it("cancels the default polling timer when shutdown is signalled", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = sleepWithShutdown(60_000, controller.signal);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort("shutdown");
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts the polling delay when shutdown is signalled", async () => {
    const controller = new AbortController();
    let resolveSleep: (() => void) | undefined;
    const dependencies: Partial<DaemonDependencies> = {
      loadConfig: async () => config(),
      readCredential: async () => "credential",
      createRuntime: async () => runtime(),
      startAnalytics: async () => ({ shutdown: async () => undefined }),
      validateLayouts: async () => new Map(),
      reconcile: async () => ({
        jobsChecked: 0,
        jobsFailed: 0,
        questionsInterrupted: 0,
        manualOverrides: 0,
        mutationsReplayed: 0,
        mutationsPending: 0,
        mutationFailures: 0,
      }),
      resumeJobs: async () => 0,
      runCycle: async (input) => {
        expect(input.signal).toBe(controller.signal);
        return report;
      },
      sleep: () =>
        new Promise<void>((resolve) => {
          resolveSleep = resolve;
        }),
    };

    const running = runDaemon(
      "/etc/runner.yaml",
      dependencies,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort("shutdown");
    await running;
    resolveSleep?.();
  });

  it.each([
    {
      stage: "repository",
      terminalErrorCode: "REPOSITORY_PREPARE_FAILED",
    },
    { stage: "conductor", terminalErrorCode: "CONDUCTOR_START_FAILED" },
  ] as const)("atomically persists and reports a recovered $stage failure", async ({
    stage,
    terminalErrorCode,
  }) => {
    const project = config().projects["42"];
    if (project === undefined) throw new Error("test project missing");
    const recoveredJob: Job = {
      id: "job-resume-failed" as Job["id"],
      taskId: taskId(12),
      projectId: projectId(42),
      attempt: 1,
      state: "running",
      branch: "pi/vikunja-12-resumed",
      worktree: "/var/lib/runner/jobs/12/worktree",
      conductorRunId: "run-resumed",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      terminalErrorCode: null,
    };
    const resumedLayout: ProjectLayout = {
      viewId: project.kanbanViewId,
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
    let persisted = recoveredJob;
    const mutations = new Map<
      string,
      { state: string; remoteId: string | null }
    >();
    const moves: number[] = [];
    const comments: string[] = [];
    const errors: Error[] = [];
    const store = {
      async recoverableJobs() {
        return [recoveredJob];
      },
      async transition() {
        throw new Error("standalone terminal transition is not crash-safe");
      },
      async recordTerminalFailure(
        _id: Job["id"],
        terminalErrorCode: NonNullable<Job["terminalErrorCode"]>,
        intents: readonly { idempotencyKey: string }[],
      ) {
        persisted = {
          ...persisted,
          state: "failed",
          terminalErrorCode,
        };
        for (const intent of intents) {
          mutations.set(intent.idempotencyKey, {
            state: "pending",
            remoteId: null,
          });
        }
        return persisted;
      },
      async recordMutationIntent(input: { idempotencyKey: string }) {
        const existing = mutations.get(input.idempotencyKey);
        if (existing !== undefined) return { ...input, ...existing };
        const value = { state: "pending", remoteId: null };
        mutations.set(input.idempotencyKey, value);
        return { ...input, ...value };
      },
      async completeMutation(key: string, remoteId: string | null) {
        const value = { state: "succeeded", remoteId };
        mutations.set(key, value);
        return { idempotencyKey: key, ...value };
      },
    } as unknown as JobStore;
    const gateway = {
      async getTask() {
        return {
          id: recoveredJob.taskId,
          projectId: recoveredJob.projectId,
          title: "Resume me",
          priority: 1,
          position: 1,
          bucketId: resumedLayout.buckets.Running.id,
          done: false,
        };
      },
      async moveTask(_taskId: unknown, bucket: number) {
        moves.push(bucket);
      },
      async postComment(_taskId: unknown, body: string) {
        comments.push(body);
        return 501 as never;
      },
    } as OnceRuntime["gateway"];
    const resumed = await defaultResumeJobs({
      config: config(),
      runtime: {
        store,
        gateway,
        repository: {
          async prepare() {
            if (stage === "repository") throw new Error("git unavailable");
            return {
              repository: "/var/lib/runner/repositories/42/repo",
              branch: recoveredJob.branch ?? "",
              worktree: recoveredJob.worktree ?? "",
            };
          },
        } as OnceRuntime["repository"],
        conductor: {
          async resume() {
            throw new Error("provider unavailable");
          },
        },
        close: () => undefined,
      },
      layouts: new Map([[project.id, resumedLayout]]),
      logError: (error) => errors.push(error),
    });

    expect(resumed).toBe(0);
    expect(persisted.terminalErrorCode).toBe(terminalErrorCode);
    expect(moves).toEqual([6]);
    expect(comments[0]).toContain(terminalErrorCode);
    expect(errors).toHaveLength(1);
  });

  it("refreshes the heartbeat while a recovered conductor run is active", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const project = config().projects["42"];
      if (project === undefined) throw new Error("test project missing");
      const recoveredJob: Job = {
        id: "job-resumed-heartbeat" as Job["id"],
        taskId: taskId(12),
        projectId: projectId(42),
        attempt: 1,
        state: "running",
        branch: "pi/vikunja-12-resumed",
        worktree: "/var/lib/runner/jobs/12/worktree",
        conductorRunId: "run-resumed",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        terminalErrorCode: null,
      };
      const resumedLayout: ProjectLayout = {
        viewId: project.kanbanViewId,
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
      let finishCompletion: (() => void) | undefined;
      const completion = new Promise<{ exitReason: "aborted" }>((resolve) => {
        finishCompletion = () => resolve({ exitReason: "aborted" });
      });
      const recordHeartbeat = vi.fn(async () => undefined);
      const store = {
        async recoverableJobs() {
          return [recoveredJob];
        },
        async getJob() {
          return recoveredJob;
        },
        async transition() {
          return { ...recoveredJob, state: "failed" as const };
        },
        recordHeartbeat,
        async recordMutationIntent(input: { idempotencyKey: string }) {
          return { ...input, state: "pending" as const, remoteId: null };
        },
        async completeMutation(key: string, remoteId: string | null) {
          return { idempotencyKey: key, state: "succeeded" as const, remoteId };
        },
        async getCommentWatermark() {
          return null;
        },
        async recordCommentWatermark() {},
      } as unknown as JobStore;
      const gateway = {
        async getTask() {
          return {
            id: recoveredJob.taskId,
            projectId: recoveredJob.projectId,
            title: "Resumed task",
            description: "",
            priority: 1,
            position: 1,
            bucketId: bucketId(3),
            done: false,
          };
        },
        async listComments() {
          return [];
        },
        async moveTask() {},
        async postComment() {
          return 1 as never;
        },
      } as OnceRuntime["gateway"];
      const runtime: OnceRuntime = {
        store,
        gateway,
        repository: {
          async prepare() {
            return {
              repository: "/var/lib/runner/repositories/42/repo",
              branch: recoveredJob.branch ?? "",
              worktree: recoveredJob.worktree ?? "",
            };
          },
        } as OnceRuntime["repository"],
        conductor: {
          async resume() {
            return {
              runId: "run-resumed",
              completion: () => completion,
              async abort() {
                finishCompletion?.();
              },
            } as never;
          },
        } as OnceRuntime["conductor"],
        close: () => undefined,
      };
      const running = defaultResumeJobs({
        config: config(),
        runtime,
        layouts: new Map([[project.id, resumedLayout]]),
        logError: () => undefined,
        signal: controller.signal,
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recordHeartbeat).toHaveBeenCalledTimes(1);
      controller.abort("shutdown");
      await expect(running).resolves.toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a recovered conductor run on daemon shutdown", async () => {
    const controller = new AbortController();
    const project = config().projects["42"];
    if (project === undefined) throw new Error("test project missing");
    const recoveredJob: Job = {
      id: "job-resumed" as Job["id"],
      taskId: taskId(12),
      projectId: projectId(42),
      attempt: 1,
      state: "running",
      branch: "pi/vikunja-12-resumed",
      worktree: "/var/lib/runner/jobs/12/worktree",
      conductorRunId: "run-resumed",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      terminalErrorCode: null,
    };
    const resumedLayout: ProjectLayout = {
      viewId: project.kanbanViewId,
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
    let handle:
      | {
          runId: string;
          abort: (reason?: string) => Promise<void>;
          completion: () => Promise<{ exitReason: "aborted" }>;
        }
      | undefined;
    const abortReasons: string[] = [];
    let finishCompletion: (() => void) | undefined;
    const completion = new Promise<{ exitReason: "aborted" }>((resolve) => {
      finishCompletion = () => resolve({ exitReason: "aborted" });
    });
    const store = {
      async recoverableJobs() {
        return [recoveredJob];
      },
      async getJob() {
        return recoveredJob;
      },
      async transition() {
        return { ...recoveredJob, state: "failed" as const };
      },
      async recordMutationIntent(input: { idempotencyKey: string }) {
        return { ...input, state: "pending" as const, remoteId: null };
      },
      async completeMutation(key: string, remoteId: string | null) {
        return { idempotencyKey: key, state: "succeeded" as const, remoteId };
      },
      async getCommentWatermark() {
        return null;
      },
      async recordCommentWatermark() {},
    } as unknown as JobStore;
    const gateway = {
      async getTask() {
        return {
          id: recoveredJob.taskId,
          projectId: recoveredJob.projectId,
          title: "Resumed task",
          description: "",
          priority: 1,
          position: 1,
          bucketId: bucketId(3),
          done: false,
        };
      },
      async listComments() {
        return [];
      },
      async moveTask() {},
      async postComment() {
        return 1 as never;
      },
    } as OnceRuntime["gateway"];
    const runtime: OnceRuntime = {
      store,
      gateway,
      repository: {
        async prepare() {
          return {
            repository: "/var/lib/runner/repositories/42/repo",
            branch: recoveredJob.branch ?? "",
            worktree: recoveredJob.worktree ?? "",
          };
        },
      } as OnceRuntime["repository"],
      conductor: {
        async resume() {
          handle = {
            runId: "run-resumed",
            completion: () => completion,
            async abort(reason?: string) {
              abortReasons.push(reason ?? "");
              finishCompletion?.();
            },
          };
          return handle as never;
        },
      } as OnceRuntime["conductor"],
      close: () => undefined,
    };
    const running = defaultResumeJobs({
      config: config(),
      runtime,
      layouts: new Map([[project.id, resumedLayout]]),
      logError: () => undefined,
      signal: controller.signal,
    });
    while (handle === undefined) await Promise.resolve();
    controller.abort("shutdown");

    await expect(running).resolves.toBe(0);
    expect(abortReasons).toEqual(["runner shutting down"]);
  });
});
