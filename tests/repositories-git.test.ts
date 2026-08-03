import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { Job } from "../src/domain/jobs.js";
import { projectId, taskId } from "../src/domain/types.js";
import {
  GitRepositoryManager,
  type ProcessCommandRunner,
} from "../src/repositories/git.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Runner",
  GIT_AUTHOR_EMAIL: "runner@example.test",
  GIT_COMMITTER_NAME: "Test Runner",
  GIT_COMMITTER_EMAIL: "runner@example.test",
};

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await execFile("git", args, { cwd, env: gitEnv });
  return result.stdout.trim();
};

const project = (repository: string): ProjectConfig => ({
  id: projectId(42),
  displayIdentifier: "PC",
  kanbanViewId: 8 as ProjectConfig["kanbanViewId"],
  repository,
  defaultBranch: "main",
  publish: { mode: "local", remote: "origin" },
  verifyCommands: [["pnpm", "test"]],
});

const job = (
  worktree: string | null = null,
  branch: string | null = null,
): Job => ({
  id: "job-1" as Job["id"],
  taskId: taskId(12),
  projectId: projectId(42),
  attempt: 1,
  state: "claiming",
  branch,
  worktree,
  conductorRunId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  terminalErrorCode: null,
});

const createOrigin = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "runner-git-origin-"));
  roots.push(root);
  const bare = join(root, "origin.git");
  const source = join(root, "source");
  await git(root, "init", "--bare", bare);
  await git(root, "init", "-b", "main", source);
  await writeFile(join(source, "README.md"), "initial\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "initial");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "-u", "origin", "main");
  return bare;
};

afterEach(async () => {
  for (const root of roots.splice(0)) await execFile("rm", ["-rf", root]);
});

describe("GitRepositoryManager", () => {
  it("clones, fetches, and creates a deterministic confined task worktree", async () => {
    const origin = await createOrigin();
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const manager = new GitRepositoryManager(dataDir);

    const prepared = await manager.prepare(job(), project(origin), {
      taskTitle: "Fix API / auth injection!",
    });

    expect(prepared.branch).toBe("pi/vikunja-12-fix-api-auth-injection");
    expect(prepared.worktree).toBe(
      await realpath(join(dataDir, "jobs", "12", "projects", "42", "worktree")),
    );
    expect(await readFile(join(prepared.worktree, "README.md"), "utf8")).toBe(
      "initial\n",
    );
    expect(await git(prepared.worktree, "branch", "--show-current")).toBe(
      prepared.branch,
    );
    expect(
      prepared.worktree.startsWith(await realpath(join(dataDir, "jobs", "12"))),
    ).toBe(true);
  });

  it("reuses repositories when dataDir is a symlink", async () => {
    const origin = await createOrigin();
    const root = await mkdtemp(join(tmpdir(), "runner-git-data-link-"));
    roots.push(root);
    const canonicalDataDir = join(root, "canonical");
    const linkedDataDir = join(root, "linked");
    await mkdir(canonicalDataDir);
    await symlink(canonicalDataDir, linkedDataDir);
    const manager = new GitRepositoryManager(linkedDataDir);

    const first = await manager.prepare(job(), project(origin), {
      taskTitle: "Linked data root",
    });
    const retry = await manager.prepare(
      { ...job(first.worktree, first.branch), attempt: 2 },
      project(origin),
    );

    expect(retry).toEqual(first);
    expect(retry.worktree.startsWith(await realpath(canonicalDataDir))).toBe(
      true,
    );
  });

  it("rejects a task directory symlink that escapes the data directory", async () => {
    const origin = await createOrigin();
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    const outside = await mkdtemp(join(tmpdir(), "runner-git-outside-"));
    roots.push(dataDir, outside);
    await mkdir(join(dataDir, "jobs"), { recursive: true });
    await symlink(outside, join(dataDir, "jobs", "12"));

    await expect(
      new GitRepositoryManager(dataDir).prepare(job(), project(origin)),
    ).rejects.toThrow("job directory escapes configured data directory");
  });

  it("runs configured verification commands in order and reports bounded output", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
    }> = [];
    const process: ProcessCommandRunner = {
      async run(command, args, cwd) {
        calls.push({ command, args, cwd });
        return {
          exitCode: command === "failing-check" ? 2 : 0,
          stdout:
            command === "failing-check"
              ? `${"x".repeat(5000)}\\n`
              : "passed\\n",
          stderr: command === "failing-check" ? "failure\\n" : "",
        };
      },
    };
    const fakeGit = {
      async run(_args: readonly string[], _cwd: string): Promise<string> {
        return "";
      },
    };
    const manager = new GitRepositoryManager(dataDir, fakeGit, process);
    const worktree = join(dataDir, "jobs", "12", "worktree");
    await mkdir(worktree, { recursive: true });
    const result = await manager.verify(
      {
        repository: join(dataDir, "repositories", "42", "repo"),
        branch: "pi/vikunja-12-check",
        worktree,
      },
      [["passing-check", "--strict"], ["failing-check"]],
    );

    expect(result.passed).toBe(false);
    expect(result.commands.map((command) => command.exitCode)).toEqual([0, 2]);
    expect(result.worktreeClean).toBe(true);
    expect(result.uncommittedFiles).toEqual([]);
    expect(result.commands[1]?.outputTail.length).toBe(4000);
    const canonicalWorktree = await realpath(worktree);
    expect(calls).toEqual([
      {
        command: "passing-check",
        args: ["--strict"],
        cwd: canonicalWorktree,
      },
      { command: "failing-check", args: [], cwd: canonicalWorktree },
    ]);
  });

  it("does not fail a successful verification command with output over 1 MiB", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const fakeGit = {
      async run(): Promise<string> {
        return "";
      },
    };
    const manager = new GitRepositoryManager(dataDir, fakeGit);
    const worktree = join(dataDir, "jobs", "12", "worktree");
    await mkdir(worktree, { recursive: true });

    const result = await manager.verify(
      {
        repository: join(dataDir, "repositories", "42", "repo"),
        branch: "pi/vikunja-12-check",
        worktree,
      },
      [
        [
          process.execPath,
          "-e",
          "process.stdout.write('x'.repeat(1024 * 1024 + 1))",
        ],
      ],
    );

    expect(result.passed).toBe(true);
    expect(result.commands[0]).toMatchObject({
      exitCode: 0,
      passed: true,
    });
    expect(result.commands[0]?.outputTail).toBe("x".repeat(4000));
  });

  it("reports every uncommitted worktree path from Git status", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const fakeGit = {
      async run(args: readonly string[], _cwd: string): Promise<string> {
        if (args[0] === "status") return " M changed.ts\n?? new.txt\n";
        return "";
      },
    };
    const manager = new GitRepositoryManager(dataDir, fakeGit, {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const worktree = join(dataDir, "jobs", "12", "worktree");
    await mkdir(worktree, { recursive: true });

    const result = await manager.verify(
      {
        repository: join(dataDir, "repositories", "42", "repo"),
        branch: "pi/vikunja-12-check",
        worktree,
      },
      [],
    );

    expect(result.worktreeClean).toBe(false);
    expect(result.uncommittedFiles).toEqual(["changed.ts", "new.txt"]);
  });

  it("rejects escaped worktrees and invalid persisted branches before Git commands", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    const outside = await mkdtemp(join(tmpdir(), "runner-git-outside-"));
    roots.push(dataDir, outside);
    const worktree = join(dataDir, "jobs", "12", "worktree");
    const escaped = join(dataDir, "jobs", "12", "escaped");
    await mkdir(worktree, { recursive: true });
    await symlink(outside, escaped);
    const manager = new GitRepositoryManager(dataDir, {
      async run(): Promise<string> {
        return "";
      },
    });
    const prepared = {
      repository: join(dataDir, "repositories", "42", "repo"),
      branch: "pi/vikunja-12-check",
      worktree,
    };

    await expect(
      manager.verify({ ...prepared, branch: "pi/vikunja-12-bad/name" }, []),
    ).rejects.toThrow("persisted task branch has an invalid name");
    await expect(
      manager.publish(
        { ...prepared, branch: "not-a-task-branch" },
        { mode: "local", remote: "origin" },
      ),
    ).rejects.toThrow("persisted task branch has an invalid name");
    await expect(
      manager.verify({ ...prepared, worktree: escaped }, []),
    ).rejects.toThrow("worktree escapes configured data directory");
  });

  it("does not invoke Git for local publishing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const calls: string[][] = [];
    const fakeGit = {
      async run(args: readonly string[], _cwd: string): Promise<string> {
        calls.push([...args]);
        return "pi/vikunja-12-check";
      },
    };
    const manager = new GitRepositoryManager(dataDir, fakeGit);
    const worktree = join(dataDir, "jobs", "12", "worktree");
    await mkdir(worktree, { recursive: true });
    const result = await manager.publish(
      {
        repository: join(dataDir, "repositories", "42", "repo"),
        branch: "pi/vikunja-12-check",
        worktree,
      },
      { mode: "local", remote: "origin" },
    );

    expect(result).toEqual({
      pushed: false,
      remote: null,
      branch: "pi/vikunja-12-check",
    });
    expect(calls).toEqual([["rev-parse", "--abbrev-ref", "HEAD"]]);
  });

  it("pushes only the configured branch in push mode", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const calls: string[][] = [];
    const fakeGit = {
      async run(args: readonly string[], _cwd: string): Promise<string> {
        calls.push([...args]);
        return args[0] === "rev-parse" ? "pi/vikunja-12-check" : "";
      },
    };
    const manager = new GitRepositoryManager(dataDir, fakeGit);
    const worktree = join(dataDir, "jobs", "12", "worktree");
    await mkdir(worktree, { recursive: true });
    const result = await manager.publish(
      {
        repository: join(dataDir, "repositories", "42", "repo"),
        branch: "pi/vikunja-12-check",
        worktree,
      },
      { mode: "push_branch", remote: "origin" },
    );

    expect(result).toEqual({
      pushed: true,
      remote: "origin",
      branch: "pi/vikunja-12-check",
    });
    expect(calls).toEqual([
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["push", "origin", "pi/vikunja-12-check"],
    ]);
  });

  it("reuses a persisted branch and worktree on retry without replacing files", async () => {
    const origin = await createOrigin();
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const manager = new GitRepositoryManager(dataDir);
    const first = await manager.prepare(job(), project(origin), {
      taskTitle: "Retry me",
    });
    await writeFile(join(first.worktree, "local.txt"), "preserve\n");
    const retry = await manager.prepare(
      { ...job(first.worktree, first.branch), attempt: 2, state: "running" },
      project(origin),
      { taskTitle: "Different title must not rename branch" },
    );

    expect(retry).toEqual(first);
    expect(await readFile(join(retry.worktree, "local.txt"), "utf8")).toBe(
      "preserve\n",
    );
  });

  it("isolates fallback worktrees when the same task changes projects", async () => {
    const firstOrigin = await createOrigin();
    const secondOrigin = await createOrigin();
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const manager = new GitRepositoryManager(dataDir);
    const first = await manager.prepare(job(), project(firstOrigin), {
      taskTitle: "Same title",
    });
    await writeFile(join(first.worktree, "project-a.txt"), "project A\n");
    const secondProject = {
      ...project(secondOrigin),
      id: projectId(43),
    };

    const second = await manager.prepare(
      {
        ...job(),
        id: "job-2" as Job["id"],
        projectId: secondProject.id,
        attempt: 2,
        state: "running",
      },
      secondProject,
      { taskTitle: "Same title" },
    );

    expect(second.worktree).toBe(
      await realpath(join(dataDir, "jobs", "12", "projects", "43", "worktree")),
    );
    expect(second.worktree).not.toBe(first.worktree);
    await expect(
      readFile(join(second.worktree, "project-a.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects an existing clone whose origin no longer matches configuration", async () => {
    const origin = await createOrigin();
    const replacement = await createOrigin();
    const dataDir = await mkdtemp(join(tmpdir(), "runner-git-data-"));
    roots.push(dataDir);
    const manager = new GitRepositoryManager(dataDir);
    await manager.prepare(job(), project(origin), { taskTitle: "First" });

    await expect(
      manager.prepare(job(), project(replacement), { taskTitle: "Second" }),
    ).rejects.toThrow(
      "existing repository origin does not match configured repository",
    );
  });
});
