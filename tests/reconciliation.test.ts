import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/config.js";
import { claimReadyTask } from "../src/domain/claiming.js";
import { validateProjectLayout } from "../src/domain/layout.js";
import { reconcileStartup } from "../src/domain/reconciliation.js";
import type { CodingTask, ProjectLayout } from "../src/domain/types.js";
import {
  bucketId,
  commentId,
  projectId,
  taskId,
  userId,
  viewId,
} from "../src/domain/types.js";
import { SqliteJobStore } from "../src/persistence/sqlite.js";
import type { VikunjaGateway } from "../src/vikunja/gateway.js";
import { VikunjaHttpGateway } from "../src/vikunja/http.js";

const stores: SqliteJobStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const layout = (): ProjectLayout =>
  validateProjectLayout(
    viewId(8),
    ["Backlog", "Ready", "Running", "Waiting", "Review", "Failed", "Done"].map(
      (title, index) => ({
        id: bucketId(index + 1),
        title,
        position: index,
      }),
    ),
    bucketId(1),
    bucketId(7),
  );

const task = (bucket: number): CodingTask => ({
  id: taskId(20),
  projectId: projectId(42),
  title: "Recover me",
  priority: 1,
  position: 1,
  bucketId: bucketId(bucket),
  done: false,
});

const openStore = async (): Promise<SqliteJobStore> => {
  const directory = await mkdtemp(join(tmpdir(), "vikunja-reconcile-"));
  const store = await SqliteJobStore.open(join(directory, "state.sqlite"));
  stores.push(store);
  return store;
};

describe("reconcileStartup", () => {
  it("does not replay an ambiguous failed claim move onto a task still in Ready", async () => {
    const store = await openStore();
    const ready = task(2);
    let remote = ready;
    let reads = 0;
    let moves = 0;
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "assignRunner" | "listComments" | "postComment"
    > = {
      getTask: async () => {
        reads += 1;
        if (reads === 2) throw new Error("remote read unavailable");
        return remote;
      },
      moveTask: async (_taskId, bucket) => {
        moves += 1;
        if (moves === 1) throw new Error("move response lost");
        remote = { ...remote, bucketId: bucket };
      },
      assignRunner: async () => undefined,
      listComments: async () => [],
      postComment: async () => commentId(100),
    };

    const claim = await claimReadyTask({
      task: ready,
      layout: layout(),
      store,
      gateway,
    });
    expect(claim.status).toBe("failed");
    if (claim.status !== "failed")
      throw new Error("claim unexpectedly succeeded");
    const moveKey = `job:${claim.job.id}:claim:move`;
    const recoveryKey = `job:${claim.job.id}:claim:move-failed`;
    expect(await store.getMutationIntent(moveKey)).toMatchObject({
      state: "failed",
    });
    expect(await store.getMutationIntent(recoveryKey)).toMatchObject({
      state: "pending",
    });

    const report = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(report.mutationsReplayed).toBe(1);
    expect(moves).toBe(1);
    expect(remote.bucketId).toBe(bucketId(2));
    expect(await store.getMutationIntent(recoveryKey)).toMatchObject({
      state: "succeeded",
    });
  });

  it("suppresses a stale pending claim move for an already-failed job", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, {
      state: "failed",
      terminalErrorCode: "VIKUNJA_UNAVAILABLE",
    });
    const key = `job:${claimed.id}:claim:move`;
    await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: claimed.taskId,
      operation: "move_task",
      idempotencyKey: key,
      request: { bucketId: 3, expectedBucketId: 2 },
    });
    let moves = 0;
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "assignRunner" | "listComments" | "postComment"
    > = {
      getTask: async () => task(2),
      moveTask: async () => {
        moves += 1;
      },
      assignRunner: async () => undefined,
      listComments: async () => [],
      postComment: async () => commentId(100),
    };

    const report = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(report.mutationsReplayed).toBe(0);
    expect(report.mutationFailures).toBe(1);
    expect(moves).toBe(0);
    expect(await store.getMutationIntent(key)).toMatchObject({
      state: "failed",
    });
  });

  it("replays a guarded recovery when startup later confirms Running", async () => {
    const store = await openStore();
    const ready = task(2);
    let remote = ready;
    let reads = 0;
    let moves = 0;
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "assignRunner" | "listComments" | "postComment"
    > = {
      getTask: async () => {
        reads += 1;
        if (reads === 2) throw new Error("remote read unavailable");
        return remote;
      },
      moveTask: async (_taskId, bucket) => {
        moves += 1;
        if (moves === 1) throw new Error("move response lost");
        remote = { ...remote, bucketId: bucket };
      },
      assignRunner: async () => undefined,
      listComments: async () => [],
      postComment: async () => commentId(100),
    };

    const claim = await claimReadyTask({
      task: ready,
      layout: layout(),
      store,
      gateway,
    });
    if (claim.status !== "failed")
      throw new Error("claim unexpectedly succeeded");
    const recoveryKey = `job:${claim.job.id}:claim:move-failed`;
    remote = { ...ready, bucketId: layout().buckets.Running.id };

    await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(moves).toBe(2);
    expect(remote.bucketId).toBe(bucketId(6));
    expect(await store.getMutationIntent(recoveryKey)).toMatchObject({
      state: "succeeded",
    });
  });

  it("fails an unresolved waiting question safely and records one failure comment", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    await store.transition(claimed.id, { state: "waiting" });
    const question = await store.createQuestion({
      jobId: claimed.id,
      taskId: taskId(20),
      kind: "input",
      prompt: "Which approach?",
      commentWatermark: null,
    });
    let remote = task(4);
    const comments: string[] = [];
    let moves = 0;
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => remote,
      listComments: async () => [],
      moveTask: async (_taskId, bucket) => {
        moves += 1;
        remote = { ...remote, bucketId: bucket };
      },
      postComment: async (_taskId, body) => {
        comments.push(body);
        return commentId(100 + comments.length);
      },
    };

    const first = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(first).toMatchObject({ jobsFailed: 1, questionsInterrupted: 1 });
    expect(await store.getActiveQuestion(claimed.id)).toBeNull();
    expect((await store.getJob(claimed.id))?.terminalErrorCode).toBe(
      "WAIT_INTERRUPTED",
    );
    expect(remote.bucketId).toBe(bucketId(6));
    expect(moves).toBe(1);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("WAIT_INTERRUPTED");
    expect(comments[0]).toContain(
      `[idempotency:job:${claimed.id}:startup-wait-failed:comment]`,
    );

    await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });
    expect(moves).toBe(1);
    expect(comments).toHaveLength(1);
    expect(question.state).toBe("pending");
  });

  it("preserves a manual bucket when a restart finds an unresolved question there", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    await store.transition(claimed.id, { state: "waiting" });
    const question = await store.createQuestion({
      jobId: claimed.id,
      taskId: taskId(20),
      kind: "input",
      prompt: "Which approach?",
      commentWatermark: null,
    });
    const comments: string[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => task(5),
      listComments: async () => [],
      moveTask: async () => {
        throw new Error("manual bucket must not be overwritten");
      },
      postComment: async (_taskId, body) => {
        comments.push(body);
        return commentId(200);
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({
      jobsFailed: 1,
      questionsInterrupted: 0,
      manualOverrides: 1,
    });
    expect((await store.getJob(claimed.id))?.terminalErrorCode).toBe(
      "MANUAL_STATE_OVERRIDE",
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("MANUAL_STATE_OVERRIDE");
    expect(comments[0]).toContain(
      `[idempotency:job:${claimed.id}:startup-manual-override:comment]`,
    );
    expect((await store.getQuestion(question.id))?.state).toBe("aborted");
  });

  it("preserves a manually selected bucket instead of overwriting it", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    const remote = task(5);
    let moves = 0;
    const comments: string[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => remote,
      listComments: async () => [],
      moveTask: async () => {
        moves += 1;
      },
      postComment: async (_taskId, body) => {
        comments.push(body);
        return commentId(101);
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result.manualOverrides).toBe(1);
    expect(moves).toBe(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("MANUAL_STATE_OVERRIDE");
    expect((await store.getJob(claimed.id))?.terminalErrorCode).toBe(
      "MANUAL_STATE_OVERRIDE",
    );

    await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });
    expect(comments).toHaveLength(1);
  });

  it("preserves jobs whose remote project has no configured layout", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    const comments: string[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => ({ ...task(3), projectId: projectId(99) }),
      listComments: async () => [],
      moveTask: async () => {
        throw new Error("must preserve remote state");
      },
      postComment: async (_taskId, body) => {
        comments.push(body);
        return commentId(301);
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({ jobsFailed: 1, manualOverrides: 1 });
    expect(comments[0]).toContain("project 99");
    expect((await store.getJob(claimed.id))?.terminalErrorCode).toBe(
      "MANUAL_STATE_OVERRIDE",
    );
  });

  it("keeps a remote mutation pending when startup cannot reach Vikunja", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    const intent = await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: taskId(20),
      operation: "post_comment",
      idempotencyKey: "job:comment:offline",
      request: { body: "retry me" },
    });
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => task(3),
      listComments: async () => {
        throw new Error("Vikunja unavailable");
      },
      moveTask: async () => undefined,
      postComment: async () => commentId(78),
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result.mutationsPending).toBe(1);
    expect(result.mutationFailures).toBe(0);
    expect((await store.getMutationIntent(intent.idempotencyKey))?.state).toBe(
      "pending",
    );
  });

  it("preserves a recoverable job when startup cannot read its remote task", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });

    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => {
        throw new Error("Vikunja temporarily unavailable");
      },
      moveTask: async () => {
        throw new Error("must not mutate without a remote read");
      },
      postComment: async () => {
        throw new Error("must not report without a remote read");
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({
      jobsChecked: 1,
      jobsFailed: 0,
      questionsInterrupted: 0,
      manualOverrides: 0,
      deferredJobIds: [claimed.id],
    });
    expect((await store.getJob(claimed.id))?.state).toBe("running");
    expect(await store.recoverableJobs()).toHaveLength(1);
  });

  it("fails a stranded waiting job even when its question was already aborted", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    await store.transition(claimed.id, { state: "waiting" });
    const moves: number[] = [];
    const comments: string[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "listComments" | "postComment"
    > = {
      getTask: async () => task(4),
      moveTask: async (_taskId, bucket) => {
        moves.push(bucket);
      },
      listComments: async () => [],
      postComment: async (_taskId, body) => {
        comments.push(body);
        return commentId(402);
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({
      jobsChecked: 1,
      jobsFailed: 1,
      questionsInterrupted: 1,
      manualOverrides: 0,
    });
    expect((await store.getJob(claimed.id))?.terminalErrorCode).toBe(
      "WAIT_INTERRUPTED",
    );
    expect(moves).toEqual([6]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("WAIT_INTERRUPTED");
  });

  it("terminates an interrupted claiming job without leaving an active slot", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    let remote = task(3);
    let moves = 0;
    const comments: string[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => remote,
      listComments: async () => [],
      moveTask: async (_taskId, bucket) => {
        moves += 1;
        remote = { ...remote, bucketId: bucket };
      },
      postComment: async (_taskId, body) => {
        comments.push(body);
        return commentId(401);
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({
      jobsChecked: 1,
      jobsFailed: 1,
      manualOverrides: 0,
    });
    expect((await store.getJob(claimed.id))?.state).toBe("failed");
    expect((await store.getJob(claimed.id))?.terminalErrorCode).toBe(
      "CLAIM_CONFLICT",
    );
    expect(remote.bucketId).toBe(bucketId(6));
    expect(moves).toBe(1);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(
      `[idempotency:job:${claimed.id}:startup-claim-interrupted:comment]`,
    );
    expect(await store.recoverableJobs()).toHaveLength(0);
  });

  it("preserves Ready when claiming was interrupted before the remote move", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    const comments: string[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => task(2),
      listComments: async () => [],
      moveTask: async () => {
        throw new Error("must preserve Ready");
      },
      postComment: async (_taskId, body) => {
        comments.push(body);
        return commentId(402);
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({
      jobsChecked: 1,
      jobsFailed: 1,
      manualOverrides: 0,
    });
    expect((await store.getJob(claimed.id))?.terminalErrorCode).toBe(
      "CLAIM_CONFLICT",
    );
    expect(comments[0]).toContain("preserved the task's current bucket");
  });

  it("hydrates the real HTTP adapter before replaying route-dependent intents", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: taskId(20),
      operation: "move_task",
      idempotencyKey: "job:move:20",
      request: { bucketId: 5, expectedBucketId: 3 },
    });
    await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: taskId(20),
      operation: "assign_runner",
      idempotencyKey: "job:assign:20",
      request: {},
    });

    const project = parseConfig({
      version: 1,
      vikunja: {
        base_url: "https://vikunja.example",
        token_file: "/run/token",
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
    }).projects["42"];
    if (project === undefined) throw new Error("project config missing");

    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      requests.push(url.pathname);
      if (url.pathname.endsWith("/projects/42/views")) {
        return new Response(
          JSON.stringify([
            {
              id: 8,
              project_id: 42,
              view_kind: "kanban",
              bucket_configuration_mode: "manual",
              default_bucket_id: 1,
              done_bucket_id: 7,
            },
          ]),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/projects/42/views/8/buckets")) {
        return new Response(
          JSON.stringify(
            [
              "Backlog",
              "Ready",
              "Running",
              "Waiting",
              "Review",
              "Failed",
              "Done",
            ].map((title, index) => ({
              id: index + 1,
              title,
              position: index,
              project_view_id: 8,
            })),
          ),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/tasks/20")) {
        return new Response(
          JSON.stringify({
            id: 20,
            project_id: 42,
            title: "Recover me",
            priority: 1,
            position: 1,
            bucket_id: 3,
            done: false,
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/buckets/5/tasks")) {
        return new Response(
          JSON.stringify({ task_id: 20, project_view_id: 8, bucket_id: 5 }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/assignees")) {
        return new Response(JSON.stringify({ user_id: 2 }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });
    const configured = await gateway.validateProjectLayout(project);

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), configured]]),
    });

    expect(result).toMatchObject({
      mutationsReplayed: 2,
      mutationsPending: 0,
      mutationFailures: 0,
    });
    const firstTaskRead = requests.indexOf("/api/v1/tasks/20");
    const moveRequest = requests.indexOf(
      "/api/v1/projects/42/views/8/buckets/5/tasks",
    );
    expect(firstTaskRead).toBeGreaterThan(-1);
    expect(moveRequest).toBeGreaterThan(firstTaskRead);
    expect((await store.getMutationIntent("job:move:20"))?.state).toBe(
      "succeeded",
    );
    expect((await store.getMutationIntent("job:assign:20"))?.state).toBe(
      "succeeded",
    );
  });

  it("finalizes a runner-owned Review transition after a restart", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    const commentKey = `job:${claimed.id}:completion:review-comment`;
    await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: claimed.taskId,
      operation: "post_comment",
      idempotencyKey: commentKey,
      request: { body: "Review ready." },
    });
    await store.completeMutation(commentKey, String(commentId(700)));
    const moveKey = `job:${claimed.id}:completion:move-review`;
    await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: claimed.taskId,
      operation: "move_task",
      idempotencyKey: moveKey,
      request: { bucketId: 5, expectedBucketId: 3 },
    });
    const moves: number[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "assignRunner" | "listComments" | "postComment"
    > = {
      getTask: async () => task(5),
      moveTask: async (_taskId, bucket) => moves.push(bucket),
      assignRunner: async () => undefined,
      listComments: async () => [],
      postComment: async () => commentId(701),
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({
      jobsFailed: 0,
      manualOverrides: 0,
      mutationsReplayed: 1,
    });
    expect(moves).toEqual([]);
    expect(await store.getMutationIntent(moveKey)).toMatchObject({
      state: "succeeded",
    });
    expect(await store.getJob(claimed.id)).toMatchObject({ state: "review" });
  });

  it("suppresses a pending Review report after its job has failed", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    await store.transition(claimed.id, {
      state: "failed",
      terminalErrorCode: "VIKUNJA_UNAVAILABLE",
    });
    const commentKey = `job:${claimed.id}:completion:review-comment`;
    await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: claimed.taskId,
      operation: "post_comment",
      idempotencyKey: commentKey,
      request: { body: "Review ready." },
    });
    let posts = 0;
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "assignRunner" | "listComments" | "postComment"
    > = {
      getTask: async () => task(3),
      moveTask: async () => undefined,
      assignRunner: async () => undefined,
      listComments: async () => [],
      postComment: async () => {
        posts += 1;
        return commentId(702);
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({
      mutationsReplayed: 0,
      mutationFailures: 1,
    });
    expect(posts).toBe(0);
    expect(await store.getMutationIntent(commentKey)).toMatchObject({
      state: "failed",
    });
  });

  it("suppresses a stale Review move after a job has failed", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: claimed.taskId,
      operation: "move_task",
      idempotencyKey: `job:${claimed.id}:completion:move-review`,
      request: { bucketId: 5, expectedBucketId: 3 },
    });
    await store.transition(claimed.id, {
      state: "failed",
      terminalErrorCode: "VERIFY_FAILED",
    });
    const moves: number[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "assignRunner" | "listComments" | "postComment"
    > = {
      getTask: async () => task(3),
      moveTask: async (_taskId, bucket) => moves.push(bucket),
      assignRunner: async () => undefined,
      listComments: async () => [],
      postComment: async () => commentId(590),
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result.mutationsReplayed).toBe(0);
    expect(result.mutationFailures).toBe(1);
    expect(moves).toEqual([]);
    expect(
      await store.getMutationIntent(`job:${claimed.id}:completion:move-review`),
    ).toMatchObject({ state: "failed" });
  });

  it("suppresses a delayed guarded failure move after an owner bucket override", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, {
      state: "failed",
      terminalErrorCode: "CONDUCTOR_START_FAILED",
    });
    await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: claimed.taskId,
      operation: "move_task",
      idempotencyKey: `job:${claimed.id}:guarded-failure-move`,
      request: { bucketId: 6, expectedBucketId: 3 },
    });
    const moves: number[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "assignRunner" | "listComments" | "postComment"
    > = {
      getTask: async () => task(5),
      moveTask: async (_taskId, bucket) => moves.push(bucket),
      assignRunner: async () => undefined,
      listComments: async () => [],
      postComment: async () => commentId(600),
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result.mutationsReplayed).toBe(1);
    expect(moves).toEqual([]);
    expect(
      await store.getMutationIntent(`job:${claimed.id}:guarded-failure-move`),
    ).toMatchObject({ state: "succeeded" });
  });

  it("rejects malformed durable mutation requests without replaying them", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    const invalidIntents = [
      {
        idempotencyKey: "bad:no-task",
        taskId: null,
        operation: "move_task",
        request: { bucketId: 1 },
      },
      {
        idempotencyKey: "bad:array",
        taskId: taskId(20),
        operation: "move_task",
        request: [] as unknown as Record<string, unknown>,
      },
      {
        idempotencyKey: "bad:bucket",
        taskId: taskId(20),
        operation: "move_task",
        request: { bucketId: 0 },
      },
      {
        idempotencyKey: "bad:comment",
        taskId: taskId(20),
        operation: "post_comment",
        request: { body: "" },
      },
      {
        idempotencyKey: "bad:operation",
        taskId: taskId(20),
        operation: "remove_task",
        request: {},
      },
    ];
    for (const intent of invalidIntents) {
      await store.recordMutationIntent({
        jobId: claimed.id,
        taskId: intent.taskId,
        operation: intent.operation,
        idempotencyKey: intent.idempotencyKey,
        request: intent.request,
      });
    }
    const calls: string[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment" | "listComments"
    > = {
      getTask: async () => task(3),
      listComments: async () => [],
      moveTask: async () => {
        calls.push("move");
      },
      postComment: async () => {
        calls.push("comment");
        return commentId(1);
      },
    };

    const result = await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });

    expect(result).toMatchObject({
      mutationFailures: invalidIntents.length,
      mutationsReplayed: 0,
    });
    expect(calls).toEqual([]);
    for (const intent of invalidIntents) {
      expect(
        (await store.getMutationIntent(intent.idempotencyKey))?.state,
      ).toBe("failed");
    }
  });

  it("replays pending remote mutation intents exactly once", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(2));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    const intent = await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: taskId(20),
      operation: "post_comment",
      idempotencyKey: "job:comment:20",
      request: { body: "recovered" },
    });
    const existing = await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: taskId(20),
      operation: "post_comment",
      idempotencyKey: "job:comment:existing",
      request: { body: "already" },
    });
    const calls: string[] = [];
    const gateway: Pick<
      VikunjaGateway,
      "getTask" | "moveTask" | "postComment"
    > = {
      getTask: async () => task(3),
      listComments: async () => [
        {
          id: commentId(76),
          taskId: taskId(20),
          authorId: userId(2),
          body: "already",
          createdAt: "2026-01-01",
        },
      ],
      moveTask: async () => undefined,
      postComment: async (_taskId, body) => {
        calls.push(body);
        return commentId(77);
      },
    };

    await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });
    expect(calls).toEqual(["recovered"]);
    expect((await store.getMutationIntent(intent.idempotencyKey))?.state).toBe(
      "succeeded",
    );
    expect(
      (await store.getMutationIntent(existing.idempotencyKey))?.state,
    ).toBe("succeeded");

    await reconcileStartup({
      store,
      gateway,
      layouts: new Map([[projectId(42), layout()]]),
    });
    expect(calls).toEqual(["recovered"]);
  });
});
