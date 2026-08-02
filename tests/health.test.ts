import { describe, expect, it } from "vitest";
import { checkRunnerHealth } from "../src/cli/health.js";
import { parseConfig, type RunnerConfig } from "../src/config/config.js";
import type { ProjectLayout } from "../src/domain/types.js";

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

const layout = {} as ProjectLayout;

describe("checkRunnerHealth", () => {
  it("checks every configured layout and accepts a fresh heartbeat", async () => {
    const checked: number[] = [];
    const heartbeat = "2026-08-02T03:00:00.000Z";
    const report = await checkRunnerHealth({
      config: config(),
      gateway: {
        validateProjectLayout: async (project) => {
          checked.push(project.id);
          return layout;
        },
      },
      store: {
        getHeartbeat: async () => heartbeat,
        recordHeartbeat: async () => undefined,
      },
      now: () => Date.parse("2026-08-02T03:00:30.000Z"),
      maxHeartbeatAgeMs: 60_000,
    });
    expect(checked).toEqual([42]);
    expect(report).toEqual({ projectIds: [42], heartbeatAt: heartbeat });
  });

  it("rejects missing and stale heartbeats", async () => {
    const input = {
      config: config(),
      gateway: { validateProjectLayout: async () => layout },
      store: {
        getHeartbeat: async () => null,
        recordHeartbeat: async () => undefined,
      },
      now: () => Date.parse("2026-08-02T03:02:00.000Z"),
      maxHeartbeatAgeMs: 60_000,
    };
    await expect(checkRunnerHealth(input)).rejects.toThrow(
      "daemon heartbeat is unavailable",
    );
    await expect(
      checkRunnerHealth({
        ...input,
        store: {
          getHeartbeat: async () => "2026-08-02T03:00:00.000Z",
          recordHeartbeat: async () => undefined,
        },
      }),
    ).rejects.toThrow("daemon heartbeat is stale");
  });
});
