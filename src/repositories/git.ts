import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectConfig } from "../config/config.js";
import { taskBranchName } from "../domain/branch.js";
import type { Job } from "../domain/jobs.js";

const execFile = promisify(execFileCallback);

const PROCESS_OUTPUT_TAIL_CHARS = 4000;

const appendOutputTail = (current: string, chunk: string): string =>
  `${current}${chunk}`.slice(-PROCESS_OUTPUT_TAIL_CHARS);

const runProcess: ProcessCommandRunner = {
  run(command, args, cwd) {
    return new Promise((resolveResult) => {
      const child = spawn(command, [...args], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendOutputTail(stdout, chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendOutputTail(stderr, chunk);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        resolveResult({
          exitCode: 1,
          stdout,
          stderr: appendOutputTail(stderr, String(error)),
        });
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        resolveResult({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  },
};

export interface PreparedWorktree {
  readonly repository: string;
  readonly branch: string;
  readonly worktree: string;
}

export interface RepositoryPrepareOptions {
  readonly taskTitle?: string;
}

/** A trusted, argument-array command from immutable repository configuration. */
export type CommandSpec = readonly string[];

export interface VerificationCommandResult {
  readonly command: CommandSpec;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outputTail: string;
  readonly passed: boolean;
}

export interface Verification {
  readonly passed: boolean;
  readonly latestCommit?: string;
  readonly commands: readonly VerificationCommandResult[];
  readonly worktreeClean: boolean;
  readonly uncommittedFiles: readonly string[];
}

export interface PublishResult {
  readonly pushed: boolean;
  readonly remote: string | null;
  readonly branch: string;
}

export interface RepositoryManager {
  prepare(
    job: Job,
    project: ProjectConfig,
    options?: RepositoryPrepareOptions,
  ): Promise<PreparedWorktree>;
  verify(
    worktree: PreparedWorktree,
    commands: readonly CommandSpec[],
  ): Promise<Verification>;
  publish(
    worktree: PreparedWorktree,
    publish: ProjectConfig["publish"],
  ): Promise<PublishResult>;
}

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): Promise<string>;
}

export interface ProcessCommandRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

export class RepositoryPrepareError extends Error {
  public constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RepositoryPrepareError";
  }
}

const runGit: GitCommandRunner = {
  async run(args, cwd): Promise<string> {
    const result = await execFile("git", [...args], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  },
};

const isInside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const validateBranch = (branch: string): void => {
  if (!/^pi\/vikunja-[0-9]+-[a-z0-9-]+$/.test(branch)) {
    throw new RepositoryPrepareError(
      "persisted task branch has an invalid name",
    );
  }
};

/** Prepare a persistent clone and one confined worktree per Vikunja task. Spec §8. */
export class GitRepositoryManager {
  private readonly dataDir: string;
  private readonly git: GitCommandRunner;
  private readonly process: ProcessCommandRunner;

  public constructor(
    dataDir: string,
    git: GitCommandRunner = runGit,
    process: ProcessCommandRunner = runProcess,
  ) {
    if (!isAbsolute(dataDir) || dataDir.trim() === "") {
      throw new RepositoryPrepareError("dataDir must be an absolute path");
    }
    this.dataDir = resolve(dataDir);
    this.git = git;
    this.process = process;
  }

  public async prepare(
    job: Job,
    project: ProjectConfig,
    options: RepositoryPrepareOptions = {},
  ): Promise<PreparedWorktree> {
    if (job.projectId !== project.id) {
      throw new RepositoryPrepareError("job and project IDs do not match");
    }
    const dataRoot = await this.confinedDataRoot();
    const repository = join(
      dataRoot,
      "repositories",
      String(project.id),
      "repo",
    );
    const jobRoot = join(dataRoot, "jobs", String(job.taskId));
    const projectJobRoot = join(jobRoot, "projects", String(project.id));
    this.assertLexicallyConfined(dataRoot, repository);
    this.assertLexicallyConfined(dataRoot, jobRoot);
    this.assertLexicallyConfined(jobRoot, projectJobRoot);

    try {
      await this.prepareClone(dataRoot, repository, project);
      await this.git.run(
        [
          "rev-parse",
          "--verify",
          `refs/remotes/origin/${project.defaultBranch}`,
        ],
        repository,
      );
      await mkdir(jobRoot, { recursive: true });
      const realJobRoot = await realpath(jobRoot);
      this.assertConfined(dataRoot, realJobRoot, "job directory");
      await mkdir(projectJobRoot, { recursive: true });
      const realProjectJobRoot = await realpath(projectJobRoot);
      this.assertConfined(
        realJobRoot,
        realProjectJobRoot,
        "project job directory",
      );
      const worktree = job.worktree ?? join(realProjectJobRoot, "worktree");
      this.assertLexicallyConfined(realJobRoot, worktree);
      const branch =
        job.branch ?? taskBranchName(job.taskId, options.taskTitle);
      validateBranch(branch);
      if (job.branch === null && job.worktree !== null) {
        throw new RepositoryPrepareError(
          "worktree cannot be persisted without a branch",
        );
      }

      if (await exists(worktree)) {
        const realWorktree = await realpath(worktree);
        this.assertConfined(realJobRoot, realWorktree, "worktree");
        const currentBranch = await this.git.run(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          realWorktree,
        );
        if (currentBranch !== branch) {
          throw new RepositoryPrepareError(
            `worktree is on ${currentBranch}, expected persisted branch ${branch}`,
          );
        }
        return { repository, branch, worktree: realWorktree };
      }

      const base = `origin/${project.defaultBranch}`;
      const worktreeBranch =
        job.branch === null ? ["-b", branch, base] : [branch];
      await this.git.run(
        ["worktree", "add", worktree, ...worktreeBranch],
        repository,
      );
      const realWorktree = await realpath(worktree);
      this.assertConfined(realJobRoot, realWorktree, "worktree");
      const currentBranch = await this.git.run(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        realWorktree,
      );
      if (currentBranch !== branch) {
        throw new RepositoryPrepareError(
          "created worktree did not check out the requested branch",
        );
      }
      return { repository, branch, worktree: realWorktree };
    } catch (error) {
      if (error instanceof RepositoryPrepareError) throw error;
      throw new RepositoryPrepareError(
        "repository or worktree preparation failed",
        error,
      );
    }
  }

  /** Run all configured checks in order without invoking a shell. Spec §12. */
  public async verify(
    worktree: PreparedWorktree,
    commands: readonly CommandSpec[],
  ): Promise<Verification> {
    const confinedWorktree = await this.confinedWorktree(worktree);
    const results: VerificationCommandResult[] = [];
    for (const command of commands) {
      const [executable, ...args] = command;
      if (executable === undefined || executable.trim() === "") {
        throw new RepositoryPrepareError("verification command is empty");
      }
      const started = Date.now();
      const result = await this.process.run(executable, args, confinedWorktree);
      const output = `${result.stdout}${result.stderr}`;
      results.push({
        command: [...command],
        exitCode: result.exitCode,
        durationMs: Math.max(0, Date.now() - started),
        outputTail: output.slice(-4000),
        passed: result.exitCode === 0,
      });
    }
    const latestCommit = await this.git.run(
      ["rev-parse", "HEAD"],
      confinedWorktree,
    );
    const status = await this.git.run(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      confinedWorktree,
    );
    const uncommittedFiles = status
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== "");
    return {
      passed: results.every((result) => result.passed),
      ...(latestCommit === "" ? {} : { latestCommit }),
      commands: results,
      worktreeClean: uncommittedFiles.length === 0,
      uncommittedFiles,
    };
  }

  /** Push only the configured task branch; local mode performs no mutation. Spec §12. */
  public async publish(
    worktree: PreparedWorktree,
    publish: ProjectConfig["publish"],
  ): Promise<PublishResult> {
    const confinedWorktree = await this.confinedWorktree(worktree);
    const currentBranch = await this.git.run(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      confinedWorktree,
    );
    if (currentBranch !== worktree.branch) {
      throw new RepositoryPrepareError(
        `worktree is on ${currentBranch}, expected ${worktree.branch}`,
      );
    }
    if (publish.mode === "local") {
      return { pushed: false, remote: null, branch: worktree.branch };
    }
    if (publish.remote.startsWith("-")) {
      throw new RepositoryPrepareError("publish remote cannot be a Git option");
    }
    await this.git.run(
      ["push", publish.remote, worktree.branch],
      confinedWorktree,
    );
    return {
      pushed: true,
      remote: publish.remote,
      branch: worktree.branch,
    };
  }

  private async confinedWorktree(worktree: PreparedWorktree): Promise<string> {
    validateBranch(worktree.branch);
    const dataRoot = await this.confinedDataRoot();
    const candidate = resolve(worktree.worktree);
    this.assertLexicallyConfined(dataRoot, candidate);
    const realWorktree = await realpath(candidate);
    this.assertConfined(dataRoot, realWorktree, "worktree");
    return realWorktree;
  }

  private async prepareClone(
    dataRoot: string,
    repository: string,
    project: ProjectConfig,
  ): Promise<void> {
    if (!(await exists(repository))) {
      await mkdir(dirname(repository), { recursive: true });
      await this.git.run(
        ["clone", "--origin", "origin", project.repository, repository],
        dataRoot,
      );
      return;
    }
    const realRepository = await realpath(repository);
    this.assertConfined(dataRoot, realRepository, "repository");
    await this.git.run(["rev-parse", "--git-dir"], realRepository);
    const configuredRemote = await this.git.run(
      ["remote", "get-url", "origin"],
      realRepository,
    );
    if (configuredRemote !== project.repository) {
      throw new RepositoryPrepareError(
        `existing repository origin does not match configured repository ${project.repository}`,
      );
    }
    await this.git.run(["fetch", "--prune", "origin"], realRepository);
  }

  private async confinedDataRoot(): Promise<string> {
    await mkdir(this.dataDir, { recursive: true });
    return realpath(this.dataDir);
  }

  private assertLexicallyConfined(root: string, candidate: string): void {
    if (!isInside(resolve(root), resolve(candidate))) {
      throw new RepositoryPrepareError(
        `${candidate} escapes configured data directory`,
      );
    }
  }

  private assertConfined(root: string, candidate: string, label: string): void {
    if (!isInside(resolve(root), resolve(candidate))) {
      throw new RepositoryPrepareError(
        `${label} escapes configured data directory`,
      );
    }
  }
}
