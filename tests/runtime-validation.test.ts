import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateAnalyticsConfiguration,
  validateConductorRuntime,
  validateRepositoryRuntime,
} from "../src/cli/runtime-validation.js";
import { parseConfig } from "../src/config/config.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "runner-runtime-validation-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const runnerConfig = (root: string, repository: string) =>
  parseConfig({
    version: 1,
    vikunja: {
      base_url: "https://vikunja.example",
      token_file: join(root, "vikunja-token"),
      owner_user_id: 1,
      runner_user_id: 2,
      poll_interval_seconds: 30,
      waiting_poll_interval_seconds: 15,
      request_timeout_seconds: 10,
      allow_insecure_http: false,
    },
    runner: {
      data_dir: join(root, "data"),
      global_concurrency: 1,
      agent_dir: join(root, "agent"),
      conductor_manifest: join(root, ".pi", "conductor.yaml"),
      analytics_config_path: join(root, "analytics.json"),
      max_comment_chars: 12000,
    },
    projects: {
      "42": {
        display_identifier: "PC",
        kanban_view_id: 8,
        repository,
        default_branch: "main",
        publish: { mode: "local", remote: "origin" },
        verify_commands: [["pnpm", "test"]],
      },
    },
  });

const initializeRepository = async (root: string): Promise<string> => {
  const repository = join(root, "source");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "README.md"), "Repository fixture.\n");
  await execFile("git", ["init", "--initial-branch=main", repository]);
  await execFile("git", ["config", "user.name", "Runner Test"], {
    cwd: repository,
  });
  await execFile("git", ["config", "user.email", "runner@example.test"], {
    cwd: repository,
  });
  await execFile("git", ["add", "."], { cwd: repository });
  await execFile("git", ["commit", "-m", "fixture"], { cwd: repository });
  return repository;
};

const initializeConductor = async (
  root: string,
  version = 2,
): Promise<void> => {
  const manifestDir = join(root, ".pi");
  await mkdir(join(manifestDir, "roles"), { recursive: true });
  await writeFile(
    join(manifestDir, "conductor.yaml"),
    [
      `version: ${version}`,
      "roles:",
      "  - name: orchestrator",
      "    is_orchestrator: true",
      "    system_prompt: roles/orchestrator.md",
      "    tools: [read, handoff, end]",
      "  - name: worker",
      "    max_visits: 1",
      "    system_prompt: roles/worker.md",
      "    tools: [read, edit, handoff, end]",
      "",
    ].join("\n"),
  );
  await writeFile(join(manifestDir, "roles", "orchestrator.md"), "Coordinate.");
  await writeFile(join(manifestDir, "roles", "worker.md"), "Implement.");
};

describe("runtime validation", () => {
  it("validates an enabled analytics configuration without contacting its endpoint", async () => {
    const root = await temporaryDirectory();
    const config = runnerConfig(root, join(root, "repository"));
    await writeFile(
      config.runner.analyticsConfigPath,
      JSON.stringify({
        enabled: true,
        endpoint: "https://analytics.example.test/events",
      }),
    );

    await expect(
      validateAnalyticsConfiguration(config),
    ).resolves.toBeUndefined();

    await writeFile(
      config.runner.analyticsConfigPath,
      JSON.stringify({ enabled: false }),
    );
    await expect(validateAnalyticsConfiguration(config)).rejects.toThrow(
      "disabled or invalid",
    );
  });

  it("validates one central version 2 manifest and repository independently", async () => {
    const root = await temporaryDirectory();
    const repository = await initializeRepository(root);
    await initializeConductor(root);
    const config = runnerConfig(root, repository);
    const project = config.projects["42"];
    if (project === undefined) throw new Error("project fixture missing");

    await expect(validateRepositoryRuntime(project)).resolves.toBeUndefined();
    await expect(validateConductorRuntime(config)).resolves.toBeUndefined();

    expect(
      await stat(join(repository, ".pi/conductor.yaml")).catch(() => null),
    ).toBeNull();
  });

  it("rejects version 1 relative prompts because they would resolve from a worktree", async () => {
    const root = await temporaryDirectory();
    const repository = await initializeRepository(root);
    await initializeConductor(root, 1);
    const config = runnerConfig(root, repository);
    await writeFile(
      config.runner.conductorManifest,
      [
        "version: 1",
        "roles:",
        "  - name: orchestrator",
        "    is_orchestrator: true",
        "    system_prompt: roles/orchestrator.md",
        "    tools: [read, handoff, end]",
        "  - name: worker",
        "    max_visits: 1",
        "    tools: [read, handoff, end]",
        "",
      ].join("\n"),
    );
    await expect(validateConductorRuntime(config)).rejects.toThrow(
      "relative system prompts require manifest version 2",
    );
  });

  it("accepts absolute prompt paths in a shared version 1 manifest", async () => {
    const root = await temporaryDirectory();
    const repository = await initializeRepository(root);
    await initializeConductor(root, 1);
    const config = runnerConfig(root, repository);
    await writeFile(
      config.runner.conductorManifest,
      [
        "version: 1",
        "roles:",
        "  - name: orchestrator",
        "    is_orchestrator: true",
        `    system_prompt: ${join(root, ".pi", "roles", "orchestrator.md")}`,
        "    tools: [read, handoff, end]",
        "",
      ].join("\n"),
    );

    await expect(validateConductorRuntime(config)).resolves.toBeUndefined();
  });

  it("rejects an unavailable prompt referenced by the shared manifest", async () => {
    const root = await temporaryDirectory();
    const repository = await initializeRepository(root);
    await initializeConductor(root);
    const config = runnerConfig(root, repository);
    await writeFile(
      config.runner.conductorManifest,
      [
        "version: 2",
        "roles:",
        "  - name: orchestrator",
        "    is_orchestrator: true",
        "    system_prompt: roles/missing.md",
        "    tools: [read, handoff, end]",
        "",
      ].join("\n"),
    );

    await expect(validateConductorRuntime(config)).rejects.toThrow(
      "conductor system prompt is unavailable",
    );
  });
});
