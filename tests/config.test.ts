import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config/config.js";

const validConfig = () => ({
  version: 1,
  vikunja: {
    base_url: "http://100.80.73.65:30111",
    token_file: "/run/credentials/vikunja_api_token",
    owner_user_id: 1,
    runner_user_id: 2,
    poll_interval_seconds: 30,
    waiting_poll_interval_seconds: 15,
    request_timeout_seconds: 10,
    allow_insecure_http: true,
  },
  runner: {
    data_dir: "/var/lib/pi-conductor-vikunja-runner",
    global_concurrency: 1,
    agent_dir: "/var/lib/pi-conductor-vikunja-runner/pi-agent",
    analytics_config_path: "/run/credentials/conductor-analytics.json",
    max_comment_chars: 12000,
  },
  projects: {
    "42": {
      display_identifier: "PC",
      kanban_view_id: 8,
      repository: "git@github.com:lynellf/pi-conductor.git",
      default_branch: "main",
      conductor_manifest: ".pi/conductor.yaml",
      publish: { mode: "push_branch", remote: "origin" },
      verify_commands: [
        ["pnpm", "typecheck"],
        ["pnpm", "test"],
      ],
    },
  },
});

describe("parseConfig", () => {
  it("parses a valid private HTTP configuration with numeric project IDs", () => {
    const config = parseConfig(validConfig());
    expect(config.vikunja.baseUrl).toBe("http://100.80.73.65:30111");
    expect(config.projects["42"]?.id).toBe(42);
    expect(config.projects["42"]?.verifyCommands[0]).toEqual([
      "pnpm",
      "typecheck",
    ]);
  });

  it("rejects insecure HTTP outside the explicit private-network exception", () => {
    const input = validConfig();
    input.vikunja.base_url = "http://example.com";
    expect(() => parseConfig(input)).toThrow(
      "plain HTTP requires allow_insecure_http and a private host",
    );
  });

  it("rejects unknown fields instead of silently ignoring misspellings", () => {
    const input = validConfig() as ReturnType<typeof validConfig> & {
      typo?: string;
    };
    input.typo = "bad";
    expect(() => parseConfig(input)).toThrow("config.typo is not recognized");
  });

  it("rejects concurrency greater than one", () => {
    const input = validConfig();
    input.runner.global_concurrency = 2;
    expect(() => parseConfig(input)).toThrow(
      "runner.global_concurrency must equal 1 in version 1",
    );
  });

  it("rejects non-numeric project keys", () => {
    const input = validConfig();
    const project = input.projects["42"];
    if (project === undefined)
      throw new Error("test fixture is missing project 42");
    input.projects = { PC: project };
    expect(() => parseConfig(input)).toThrow(
      new ConfigError("projects.PC must use a positive numeric project ID"),
    );
  });
});
