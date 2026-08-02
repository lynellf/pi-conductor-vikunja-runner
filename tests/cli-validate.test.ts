import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArguments } from "../src/cli/main.js";
import {
  readProtectedCredential,
  validateProjectConfiguration,
  validateRunner,
} from "../src/cli/validate.js";
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

describe("runner CLI validation", () => {
  it("parses validate and health with explicit config paths", () => {
    expect(
      parseCliArguments(["validate", "--config", "/etc/runner.yaml"]),
    ).toEqual({
      command: "validate",
      configPath: "/etc/runner.yaml",
    });
    expect(
      parseCliArguments(["health", "--config", "/etc/runner.yaml"]),
    ).toEqual({
      command: "health",
      configPath: "/etc/runner.yaml",
    });
  });

  it("rejects missing config paths and unknown options", () => {
    expect(() => parseCliArguments(["validate"])).toThrow(CliUsageError);
    expect(() => parseCliArguments(["validate", "--bad", "x"])).toThrow(
      "unknown option: --bad",
    );
  });

  it("checks credentials, analytics, repository manifests, models, and project layouts read-only", async () => {
    const checked: string[] = [];
    const result = await validateRunner({
      config: config(),
      gateway: {
        validateProjectLayout: async (project) => {
          checked.push(String(project.id));
          return layout;
        },
      },
      statFile: async () => ({ mode: 0o600 }),
      readTextFile: async () => "secret-value",
      validateAnalytics: async () => checked.push("analytics"),
      validateProjectRuntime: async (project) =>
        checked.push(`runtime:${project.id}`),
    });
    expect(checked).toEqual(["analytics", "runtime:42", "42"]);
    expect(result.projectIds).toEqual([42]);
    expect(result.checkedCredentials).toEqual([
      "/run/vikunja-token",
      "/run/analytics.json",
    ]);
  });

  it("rejects group/world-readable credentials without exposing their contents", async () => {
    await expect(
      readProtectedCredential(
        "/run/vikunja-token",
        "Vikunja token",
        async () => "super-secret",
        async () => ({ mode: 0o640 }),
      ),
    ).rejects.toThrow("owner");
    await expect(
      readProtectedCredential(
        "/run/vikunja-token",
        "Vikunja token",
        async () => "super-secret",
        async () => ({ mode: 0o640 }),
      ),
    ).rejects.not.toThrow("super-secret");
  });

  it("rejects repository and manifest values that could escape trusted boundaries", () => {
    const project = config().projects["42"];
    if (project === undefined) throw new Error("project config missing");
    expect(() =>
      validateProjectConfiguration({ ...project, repository: "-unsafe" }),
    ).toThrow("repository cannot start");
    expect(() =>
      validateProjectConfiguration({
        ...project,
        conductorManifest: "../outside/conductor.yaml",
      }),
    ).toThrow("must remain inside the worktree");
    expect(() =>
      validateProjectConfiguration({
        ...project,
        conductorManifest: "/absolute/conductor.yaml",
      }),
    ).toThrow("must remain inside the worktree");
    expect(() =>
      validateProjectConfiguration({ ...project, defaultBranch: "main..tmp" }),
    ).toThrow("safe Git branch name");
    expect(() =>
      validateProjectConfiguration({ ...project, defaultBranch: "HEAD" }),
    ).toThrow("safe Git branch name");
    expect(() =>
      validateProjectConfiguration({
        ...project,
        publish: { mode: "push_branch", remote: "--upload-pack=evil" },
      }),
    ).toThrow("publish.remote cannot start");
  });

  it("surfaces a remote layout rejection without claiming validation succeeded", async () => {
    await expect(
      validateRunner({
        config: config(),
        gateway: {
          validateProjectLayout: async () => {
            throw new Error("workflow buckets are invalid");
          },
        },
        statFile: async () => ({ mode: 0o600 }),
        readTextFile: async () => "secret-value",
        validateAnalytics: async () => undefined,
        validateProjectRuntime: async () => undefined,
      }),
    ).rejects.toThrow("workflow buckets are invalid");
  });
});
