import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type RunHandle, StubHost } from "pi-conductor";
import { describe, expect, it } from "vitest";
import {
  type ConductorApi,
  ConductorIntegrationError,
  PiConductorGateway,
} from "../src/conductor/gateway.js";
import type { ProjectConfig } from "../src/config/config.js";
import type { Job } from "../src/domain/jobs.js";
import { projectId, taskId } from "../src/domain/types.js";

const project = (): ProjectConfig => ({
  id: projectId(42),
  displayIdentifier: "PC",
  kanbanViewId: 8 as ProjectConfig["kanbanViewId"],
  repository: "git@example.test:owner/repo.git",
  defaultBranch: "main",
  conductorManifest: ".pi/conductor.yaml",
  publish: { mode: "local", remote: "origin" },
  verifyCommands: [["pnpm", "test"]],
});

const job = (worktree: string, runId: string | null = null): Job => ({
  id: "job-1" as Job["id"],
  taskId: taskId(12),
  projectId: projectId(42),
  attempt: 1,
  state: "running",
  branch: "pi/vikunja-12-task",
  worktree,
  conductorRunId: runId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  terminalErrorCode: null,
});

const handle = {} as RunHandle;

const fakeApi = (
  calls: Array<{ manifest: string; options: unknown }>,
): ConductorApi => ({
  async startRun(manifest, options) {
    calls.push({ manifest, options });
    return handle;
  },
  async resumeRun(manifest, runId, options) {
    calls.push({ manifest: `${manifest}#${runId}`, options });
    return handle;
  },
});

describe("PiConductorGateway", () => {
  it("completes a real library run through the deterministic stub host", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-conductor-stub-"));
    const agentDir = join(dataDir, "agent");
    const worktree = join(dataDir, "jobs", "12", "worktree");
    await mkdir(join(worktree, ".pi", "roles"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(worktree, ".pi", "conductor.yaml"),
      [
        "version: 1",
        "roles:",
        "  - name: orchestrator",
        "    is_orchestrator: true",
        "    system_prompt: .pi/roles/orchestrator.md",
        "    tools: [end]",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(worktree, ".pi", "roles", "orchestrator.md"),
      "Finish the deterministic test run.",
    );
    const gateway = new PiConductorGateway({
      dataDir,
      agentDir,
      projects: { "42": project() },
      hostFactory: (context, cwd) =>
        new StubHost({
          runId: context.runId,
          log: context.log,
          loadedManifest: context.loadedManifest,
          cwd,
          steps: [{ kind: "emit_end", reason: "completed" }],
        }),
    });

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const run = await gateway.start(job(worktree), "Ship the fix", undefined);

      await expect(run.completion()).resolves.toMatchObject({
        exitReason: "done",
      });
      expect(run.runStats().exitReason).toBe("done");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("starts a library run in the task worktree with isolated run storage", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-conductor-data-"));
    const worktree = join(dataDir, "jobs", "12", "worktree");
    await mkdir(worktree, { recursive: true });
    const calls: Array<{ manifest: string; options: unknown }> = [];
    const gateway = new PiConductorGateway(
      {
        dataDir,
        agentDir: join(dataDir, "agent"),
        projects: { "42": project() },
        modelRegistry: {} as ModelRegistry,
      },
      fakeApi(calls),
    );

    await gateway.start(job(worktree), "Ship the fix", undefined);

    expect(calls).toHaveLength(1);
    const canonicalWorktree = await realpath(worktree);
    expect(calls[0]?.manifest).toBe(
      join(canonicalWorktree, ".pi/conductor.yaml"),
    );
    const options = calls[0]?.options as {
      goal: string;
      baseDir: string;
      modelRegistry: unknown;
      hostFactory: (context: unknown) => unknown;
    };
    expect(options.goal).toBe("Ship the fix");
    expect(options.baseDir).toBe(join(dataDir, "conductor-runs"));
    expect(options.modelRegistry).toBeDefined();
    expect(options.hostFactory).toBeTypeOf("function");
  });

  it("resumes a recorded run and rejects missing durable run identity", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-conductor-data-"));
    const worktree = join(dataDir, "jobs", "12", "worktree");
    await mkdir(worktree, { recursive: true });
    const calls: Array<{ manifest: string; options: unknown }> = [];
    const gateway = new PiConductorGateway(
      {
        dataDir,
        agentDir: join(dataDir, "agent"),
        projects: { "42": project() },
        modelRegistry: {} as ModelRegistry,
      },
      fakeApi(calls),
    );

    await gateway.resume(job(worktree, "run-123"), undefined);
    const canonicalWorktree = await realpath(worktree);
    expect(calls[0]?.manifest).toBe(
      `${join(canonicalWorktree, ".pi/conductor.yaml")}#run-123`,
    );

    await expect(gateway.resume(job(worktree), undefined)).rejects.toThrow(
      "job has no conductor run ID",
    );
  });

  it("accepts a canonical persisted worktree when dataDir is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-conductor-data-"));
    const canonicalDataDir = join(root, "canonical");
    const linkedDataDir = join(root, "linked");
    const worktree = join(canonicalDataDir, "jobs", "12", "worktree");
    await mkdir(worktree, { recursive: true });
    await symlink(canonicalDataDir, linkedDataDir);
    const canonicalWorktree = await realpath(worktree);
    const calls: Array<{ manifest: string; options: unknown }> = [];
    const gateway = new PiConductorGateway(
      {
        dataDir: linkedDataDir,
        agentDir: join(canonicalDataDir, "agent"),
        projects: { "42": project() },
        modelRegistry: {} as ModelRegistry,
      },
      fakeApi(calls),
    );

    await gateway.start(job(canonicalWorktree), "goal", undefined);

    expect(calls[0]?.manifest).toBe(
      join(canonicalWorktree, ".pi/conductor.yaml"),
    );
  });

  it("rejects a manifest path that escapes the worktree", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-conductor-data-"));
    await mkdir(join(dataDir, "jobs", "12", "worktree"), { recursive: true });
    const gateway = new PiConductorGateway(
      {
        dataDir,
        agentDir: join(dataDir, "agent"),
        projects: {
          "42": { ...project(), conductorManifest: "../outside.yaml" },
        },
        modelRegistry: {} as ModelRegistry,
      },
      fakeApi([]),
    );

    await expect(
      gateway.start(
        job(join(dataDir, "jobs", "12", "worktree")),
        "goal",
        undefined,
      ),
    ).rejects.toBeInstanceOf(ConductorIntegrationError);
  });

  it("rejects an existing manifest symlink that escapes the worktree", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-conductor-data-"));
    const worktree = join(dataDir, "jobs", "12", "worktree");
    const outside = await mkdtemp(join(tmpdir(), "runner-conductor-outside-"));
    await mkdir(join(worktree, ".pi"), { recursive: true });
    const { symlink, writeFile } = await import("node:fs/promises");
    await writeFile(join(outside, "conductor.yaml"), "manifest");
    await symlink(
      join(outside, "conductor.yaml"),
      join(worktree, ".pi/conductor.yaml"),
    );
    const calls: Array<{ manifest: string; options: unknown }> = [];
    const gateway = new PiConductorGateway(
      {
        dataDir,
        agentDir: join(dataDir, "agent"),
        projects: { "42": project() },
        modelRegistry: {} as ModelRegistry,
      },
      fakeApi(calls),
    );

    await expect(
      gateway.start(job(worktree), "goal", undefined),
    ).rejects.toThrow("conductor manifest escapes the task worktree");
    expect(calls).toHaveLength(0);
  });

  it("rejects a persisted worktree outside the configured task-data root", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-conductor-data-"));
    const outside = await mkdtemp(join(tmpdir(), "runner-conductor-outside-"));
    const gateway = new PiConductorGateway(
      {
        dataDir,
        agentDir: join(dataDir, "agent"),
        projects: { "42": project() },
        modelRegistry: {} as ModelRegistry,
      },
      fakeApi([]),
    );

    await expect(
      gateway.start(job(outside), "goal", undefined),
    ).rejects.toThrow("worktree escapes configured task data directory");
  });
});
