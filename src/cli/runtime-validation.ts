import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { loadManifest } from "pi-conductor";
import { loadConfigFromPath } from "pi-conductor-analytics-plugin";
import type { ProjectConfig, RunnerConfig } from "../config/config.js";

const execFile = promisify(execFileCallback);

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const validatePromptPath = async (
  checkout: string,
  manifestDir: string,
  manifestVersion: number,
  promptPath: string,
): Promise<void> => {
  if (isAbsolute(promptPath)) {
    throw new Error("conductor system prompts must be repository-relative");
  }
  const base = manifestVersion === 1 ? checkout : manifestDir;
  const candidate = resolve(base, promptPath);
  if (!inside(checkout, candidate)) {
    throw new Error("conductor system prompt escapes the repository checkout");
  }
  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch {
    throw new Error("conductor system prompt is unavailable");
  }
  if (!inside(checkout, actual)) {
    throw new Error("conductor system prompt escapes the repository checkout");
  }
};

/** Validate the configured analytics file without sending any telemetry. */
export const validateAnalyticsConfiguration = async (
  config: RunnerConfig,
): Promise<void> => {
  const [analytics, , warnings] = loadConfigFromPath(
    config.runner.analyticsConfigPath,
    config.runner.dataDir,
  );
  if (!analytics.enabled || analytics.endpoint === undefined) {
    throw new Error("analytics configuration is disabled or invalid");
  }
  if (warnings.length > 0) {
    throw new Error("analytics configuration contains validation warnings");
  }
  if (Object.values(analytics.headers).some((value) => value.includes("${"))) {
    throw new Error(
      "analytics configuration references an unset environment variable",
    );
  }
};

/**
 * Read-only remote validation for one configured repository. A shallow clone
 * is created only under the OS temporary directory and removed afterward.
 */
export const validateRepositoryRuntime = async (
  project: ProjectConfig,
  config: RunnerConfig,
): Promise<void> => {
  const checkout = await realpath(
    await mkdtemp(join(tmpdir(), `pi-vikunja-validate-${project.id}-`)),
  );
  try {
    const repository = join(checkout, "repository");
    try {
      await execFile(
        "git",
        [
          "clone",
          "--depth=1",
          "--single-branch",
          "--no-tags",
          "--branch",
          project.defaultBranch,
          "--",
          project.repository,
          repository,
        ],
        {
          cwd: checkout,
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
    } catch {
      throw new Error("configured repository or default branch is unavailable");
    }

    const realRepository = await realpath(repository);
    const manifestCandidate = resolve(
      realRepository,
      project.conductorManifest,
    );
    if (!inside(realRepository, manifestCandidate)) {
      throw new Error("conductor manifest escapes the repository checkout");
    }
    let manifestPath: string;
    try {
      manifestPath = await realpath(manifestCandidate);
    } catch {
      throw new Error("configured conductor manifest is unavailable");
    }
    if (!inside(realRepository, manifestPath)) {
      throw new Error("conductor manifest escapes the repository checkout");
    }

    const registry = ModelRegistry.create(
      AuthStorage.create(join(config.runner.agentDir, "auth.json")),
      join(config.runner.agentDir, "models.json"),
    );
    const loaded = await loadManifest(manifestPath, {
      modelRegistry: registry,
    });
    if (
      loaded.warnings.some(
        (warning) => warning.code === "unregistered-provider",
      )
    ) {
      throw new Error(
        "conductor manifest references an unavailable model provider",
      );
    }

    const manifestDir = loaded.manifestDir ?? realRepository;
    const promptPaths = [
      ...loaded.manifest.roles.flatMap((role) =>
        role.system_prompt === undefined ? [] : [role.system_prompt],
      ),
      ...(loaded.manifest.subagents ?? []).map(
        (subagent) => subagent.system_prompt,
      ),
    ];
    for (const promptPath of promptPaths) {
      await validatePromptPath(
        realRepository,
        manifestDir,
        loaded.manifestVersion,
        promptPath,
      );
    }
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
};
