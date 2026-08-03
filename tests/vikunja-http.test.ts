import { describe, expect, it } from "vitest";
import { type ProjectConfig, parseConfig } from "../src/config/config.js";
import { bucketId, commentId, taskId } from "../src/domain/types.js";
import {
  type VikunjaHttpError,
  VikunjaHttpGateway,
  VikunjaResponseError,
} from "../src/vikunja/http.js";

const project = (): ProjectConfig =>
  parseConfig({
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
      conductor_manifest: "/operator/.pi/conductor.yaml",
      analytics_config_path: "/run/analytics.json",
      max_comment_chars: 12000,
    },
    projects: {
      "42": {
        display_identifier: "PC",
        kanban_view_id: 8,
        repository: "git@example/repo",
        default_branch: "main",
        publish: { mode: "local", remote: "origin" },
        verify_commands: [["pnpm", "test"]],
      },
    },
  }).projects["42"] as ProjectConfig;

const view = {
  id: 8,
  project_id: 42,
  view_kind: "kanban",
  bucket_configuration_mode: "manual",
  default_bucket_id: 1,
  done_bucket_id: 7,
};
const buckets = [
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
}));

const task = (id: number, bucketIdValue: number) => ({
  id,
  project_id: 42,
  title: `Task ${id}`,
  priority: id,
  position: id,
  bucket_id: bucketIdValue,
  done: false,
});

describe("VikunjaHttpGateway", () => {
  it("validates the configured manual kanban and paginates view tasks", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      calls.push({ url, init: init ?? {} });
      if (url.pathname === "/api/v1/projects/42/views") {
        return new Response(
          JSON.stringify([
            {
              ...view,
              id: 9,
              view_kind: "list",
              bucket_configuration_mode: "none",
            },
            view,
          ]),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/views/8/buckets")) {
        return new Response(JSON.stringify(buckets), { status: 200 });
      }
      if (
        url.pathname.endsWith("/views/8/tasks") &&
        url.searchParams.get("page") === "1"
      ) {
        return new Response(
          JSON.stringify([
            {
              ...buckets[1],
              tasks: [{ ...task(10, 2), bucket_id: undefined }],
            },
            { ...buckets[0], tasks: [task(11, 1)] },
          ]),
          {
            status: 200,
            headers: { "x-pagination-total-pages": "2" },
          },
        );
      }
      if (
        url.pathname.endsWith("/views/8/tasks") &&
        url.searchParams.get("page") === "2"
      ) {
        return new Response(
          JSON.stringify([{ ...buckets[1], tasks: [task(12, 2)] }]),
          {
            status: 200,
            headers: { "x-pagination-total-pages": "2" },
          },
        );
      }
      throw new Error(`unexpected request ${url}`);
    };
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "secret-token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });

    const layout = await gateway.validateProjectLayout(project());
    const ready = await gateway.listReadyTasks(layout);

    expect(ready.map((candidate) => candidate.id)).toEqual([
      taskId(10),
      taskId(12),
    ]);
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
    expect(
      calls.map(({ url }) => url.searchParams.get("page")).filter(Boolean),
    ).toEqual(["1", "2"]);
  });

  it("retries transient reads with bounded exponential jitter before succeeding", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      attempts += 1;
      if (url.pathname.endsWith("/projects/42/views") && attempts < 3) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      if (url.pathname.endsWith("/projects/42/views")) {
        return new Response(JSON.stringify([view]), { status: 200 });
      }
      if (url.pathname.endsWith("/views/8/buckets")) {
        return new Response(JSON.stringify(buckets), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
      retry: {
        initialDelayMs: 10,
        maxDelayMs: 100,
        jitter: () => 0,
        sleep: async (milliseconds) => delays.push(milliseconds),
      },
    });

    await expect(
      gateway.validateProjectLayout(project()),
    ).resolves.toBeDefined();
    expect(attempts).toBe(4);
    expect(delays).toEqual([5, 10]);
  });

  it("preserves the typed error after transient read retries are exhausted", async () => {
    let attempts = 0;
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: async () => {
        attempts += 1;
        throw new TypeError("network unavailable");
      },
      retry: {
        maxAttempts: 2,
        sleep: async () => undefined,
      },
    });

    await expect(gateway.getTask(taskId(10))).rejects.toMatchObject({
      status: null,
      retryable: true,
    } satisfies Partial<VikunjaHttpError>);
    expect(attempts).toBe(2);
  });

  it("does not retry non-read mutations after a transient failure", async () => {
    let moveAttempts = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/projects/42/views"))
        return new Response(JSON.stringify([view]), { status: 200 });
      if (url.pathname.endsWith("/views/8/buckets"))
        return new Response(JSON.stringify(buckets), { status: 200 });
      if (url.pathname.endsWith("/views/8/tasks"))
        return new Response(
          JSON.stringify([{ ...buckets[1], tasks: [task(10, 2)] }]),
          {
            status: 200,
            headers: { "x-pagination-total-pages": "1" },
          },
        );
      if (url.pathname.includes("/buckets/3/tasks")) {
        moveAttempts += 1;
        return new Response("temporarily unavailable", { status: 503 });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
      retry: { sleep: async () => undefined },
    });
    const layout = await gateway.validateProjectLayout(project());
    await gateway.listReadyTasks(layout);

    await expect(
      gateway.moveTask(taskId(10), bucketId(3)),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(moveAttempts).toBe(1);
  });

  it("rejects a configured view that is not a manual kanban", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify([{ ...view, view_kind: "list" }]), {
        status: 200,
      });
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });

    await expect(
      gateway.validateProjectLayout(project()),
    ).rejects.toBeInstanceOf(VikunjaResponseError);
  });

  it("hydrates a task bucket from the validated layout after a restart", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/projects/42/views"))
        return new Response(JSON.stringify([view]), { status: 200 });
      if (url.pathname.endsWith("/views/8/buckets"))
        return new Response(JSON.stringify(buckets), { status: 200 });
      if (url.pathname.endsWith("/tasks/10"))
        return new Response(
          JSON.stringify({
            id: 10,
            project_id: 42,
            title: "after restart",
            priority: 1,
            position: 1,
            done: false,
            buckets: [{ id: 3, project_view_id: 8 }],
          }),
          { status: 200 },
        );
      throw new Error(`unexpected request ${url}`);
    };
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });

    await gateway.validateProjectLayout(project());
    await expect(gateway.getTask(taskId(10))).resolves.toMatchObject({
      id: taskId(10),
      bucketId: bucketId(3),
    });
  });

  it("rejects a task response for a different requested ID", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 11,
          project_id: 42,
          title: "wrong task",
          priority: 1,
          position: 1,
          bucket_id: 2,
          done: false,
        }),
        { status: 200 },
      );
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });

    await expect(gateway.getTask(taskId(10))).rejects.toBeInstanceOf(
      VikunjaResponseError,
    );
  });

  it("rejects malformed task responses instead of using untrusted fields", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 10,
          project_id: 42,
          title: "bad",
          priority: 1,
          position: 1,
          bucket_id: 2,
        }),
        { status: 200 },
      );
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });

    await expect(gateway.getTask(taskId(10))).rejects.toBeInstanceOf(
      VikunjaResponseError,
    );
  });

  it("uses configured project/view routes for move, assignment, and comments", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      requests.push({ url: url.toString(), init: init ?? {} });
      if (url.pathname.endsWith("/views/8/tasks")) {
        return new Response(
          JSON.stringify([{ ...buckets[1], tasks: [task(10, 2)] }]),
          {
            status: 200,
            headers: { "x-pagination-total-pages": "1" },
          },
        );
      }
      if (url.pathname.endsWith("/views"))
        return new Response(JSON.stringify([view]), { status: 200 });
      if (url.pathname.endsWith("/buckets"))
        return new Response(JSON.stringify(buckets), { status: 200 });
      if (url.pathname.includes("/buckets/3/tasks"))
        return new Response(
          JSON.stringify({
            task_id: 10,
            project_view_id: 8,
            bucket_id: 3,
          }),
          { status: 200 },
        );
      if (url.pathname.endsWith("/assignees"))
        return new Response(JSON.stringify({ user_id: 2 }), { status: 201 });
      if (url.pathname.endsWith("/comments"))
        return new Response(
          JSON.stringify({
            id: 77,
            author: { id: 2 },
            comment: "hello",
            created: "2026-01-01",
          }),
          { status: 201 },
        );
      return new Response("{}", { status: 200 });
    };
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });
    const layout = await gateway.validateProjectLayout(project());
    await gateway.listReadyTasks(layout);
    await gateway.moveTask(taskId(10), bucketId(3));
    await gateway.assignRunner(taskId(10));
    const commentId = await gateway.postComment(taskId(10), "hello");

    expect(commentId).toBe(77);
    const move = requests.find(({ url }) =>
      url.includes("/views/8/buckets/3/tasks"),
    );
    expect(move).toBeDefined();
    expect(move?.init.method).toBe("PUT");
    const assignment = requests.find(({ url }) =>
      url.endsWith("/tasks/10/assignees"),
    );
    expect(JSON.parse(String(assignment?.init.body))).toEqual({ user_id: 2 });
  });

  it("filters comments by the durable watermark", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          { id: 1, author: { id: 1 }, comment: "old", created: "2026-01-01" },
          { id: 2, author: { id: 1 }, comment: "new", created: "2026-01-02" },
        ]),
        { status: 200 },
      );
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });
    const comments = await gateway.listComments(taskId(10), commentId(1));
    expect(comments.map((comment) => comment.id)).toEqual([2]);
  });

  it("paginates comments until the final page is consumed", async () => {
    const pages: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      pages.push(url.searchParams.get("page") ?? "");
      const page = Number(url.searchParams.get("page"));
      if (page === 1) {
        return new Response(
          JSON.stringify([
            { id: 1, author: { id: 1 }, comment: "one", created: "2026-01-01" },
          ]),
          { status: 200, headers: { "x-pagination-total-pages": "2" } },
        );
      }
      if (page === 2) {
        return new Response(
          JSON.stringify([
            { id: 2, author: { id: 2 }, comment: "two", created: "2026-01-02" },
          ]),
          { status: 200, headers: { "x-pagination-total-pages": "2" } },
        );
      }
      throw new Error(`unexpected comment page ${page}`);
    };
    const gateway = new VikunjaHttpGateway({
      baseUrl: "https://vikunja.example/api/v1",
      token: "token",
      runnerUserId: 2,
      requestTimeoutMs: 1000,
      fetch: fetcher,
    });
    const comments = await gateway.listComments(taskId(10), null);
    expect(comments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(pages).toEqual(["1", "2"]);
  });
});
