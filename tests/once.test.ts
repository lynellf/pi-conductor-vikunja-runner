import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { type OnceRuntime, runOnce } from "../src/cli/once.js";
import { parseConfig, type RunnerConfig } from "../src/config/config.js";
import type { JobStore } from "../src/domain/jobs.js";
import type { RunnerCycleReport } from "../src/domain/runner.js";

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

const runtime = (close: () => void): OnceRuntime => ({
  store: {} as JobStore,
  gateway: {} as OnceRuntime["gateway"],
  repository: {} as OnceRuntime["repository"],
  conductor: {} as OnceRuntime["conductor"],
  close,
});

describe("runner once command", () => {
  it("loads credentials, runs one cycle, and closes the store", async () => {
    const calls: string[] = [];
    const result = await runOnce("/etc/runner.yaml", {
      loadConfig: async () => config(),
      readCredential: async (path, label) => {
        calls.push(`${label}:${path}`);
        return "token";
      },
      createRuntime: async (_config, token) => {
        calls.push(`runtime:${token}`);
        return runtime(() => calls.push("closed"));
      },
      startOnceAnalytics: async () => {
        calls.push("analytics:start");
        return { shutdown: async () => calls.push("analytics:shutdown") };
      },
      recoverStartup: async () => {
        calls.push("recover");
      },
      runCycle: async (input) => {
        calls.push(`cycle:${input.ownerUserId}:${input.runnerUserId}`);
        return report;
      },
    });

    expect(result).toBe(report);
    expect(calls).toEqual([
      "Vikunja token:/run/vikunja-token",
      "Analytics configuration:/run/analytics.json",
      "runtime:token",
      "analytics:start",
      "recover",
      "cycle:1:2",
      "analytics:shutdown",
      "closed",
    ]);
  });

  it("runs the coding cycle when analytics configuration is unavailable", async () => {
    let cycled = false;
    const result = await runOnce("/etc/runner.yaml", {
      loadConfig: async () => config(),
      readCredential: async (_path, label) => {
        if (label === "Analytics configuration") {
          throw new Error("analytics unavailable");
        }
        return "token";
      },
      createRuntime: async () => runtime(() => undefined),
      startOnceAnalytics: async () => {
        throw new Error("must not start analytics without configuration");
      },
      recoverStartup: async () => undefined,
      runCycle: async () => {
        cycled = true;
        return report;
      },
    });

    expect(result).toBe(report);
    expect(cycled).toBe(true);
  });

  it("rejects unsafe project Git values before loading credentials or starting runtime", async () => {
    const project = config().projects["42"];
    if (project === undefined) throw new Error("test project missing");
    const unsafe = {
      ...config(),
      projects: { "42": { ...project, repository: "-unsafe" } },
    };
    const calls: string[] = [];

    await expect(
      runOnce("/etc/runner.yaml", {
        loadConfig: async () => unsafe,
        readCredential: async () => {
          calls.push("credential");
          return "token";
        },
        createRuntime: async () => {
          calls.push("runtime");
          return runtime(() => undefined);
        },
        recoverStartup: async () => undefined,
      }),
    ).rejects.toThrow("repository cannot start");
    expect(calls).toEqual([]);
  });

  it("closes the store when the cycle fails", async () => {
    let closed = false;
    await expect(
      runOnce("/etc/runner.yaml", {
        loadConfig: async () => config(),
        readCredential: async () => "token",
        createRuntime: async () => runtime(() => (closed = true)),
        startOnceAnalytics: async () => ({ shutdown: async () => undefined }),
        recoverStartup: async () => undefined,
        runCycle: async () => {
          throw new Error("cycle failed");
        },
      }),
    ).rejects.toThrow("cycle failed");
    expect(closed).toBe(true);
  });

  it("dispatches the once command through the same lifecycle", async () => {
    const code = await runCli(["once", "--config", "/etc/runner.yaml"], {
      loadConfig: async () => config(),
      readCredential: async () => "token",
      createRuntime: async () => runtime(() => undefined),
      startOnceAnalytics: async () => ({ shutdown: async () => undefined }),
      recoverStartup: async () => undefined,
      runCycle: async () => report,
    });
    expect(code).toBe(0);
  });
});
