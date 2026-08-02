import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { parse } from "yaml";
import {
  type ProjectId,
  projectId,
  type ViewId,
  viewId,
} from "../domain/types.js";

export interface PublishConfig {
  readonly mode: "local" | "push_branch";
  readonly remote: string;
}

export interface ProjectConfig {
  readonly id: ProjectId;
  readonly displayIdentifier: string;
  readonly kanbanViewId: ViewId;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly conductorManifest: string;
  readonly publish: PublishConfig;
  readonly verifyCommands: readonly (readonly string[])[];
}

export interface RunnerConfig {
  readonly version: 1;
  readonly vikunja: {
    readonly baseUrl: string;
    readonly tokenFile: string;
    readonly ownerUserId: number;
    readonly runnerUserId: number;
    readonly pollIntervalSeconds: number;
    readonly waitingPollIntervalSeconds: number;
    readonly requestTimeoutSeconds: number;
    readonly allowInsecureHttp: boolean;
  };
  readonly runner: {
    readonly dataDir: string;
    readonly agentDir: string;
    readonly analyticsConfigPath: string;
    readonly maxCommentChars: number;
    readonly globalConcurrency: 1;
  };
  readonly projects: Readonly<Record<string, ProjectConfig>>;
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const hasOnly = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path}.${key} is not recognized`);
    }
  }
};

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
};

const integer = (value: unknown, path: string, minimum = 0): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum
  ) {
    throw new ConfigError(`${path} must be an integer >= ${minimum}`);
  }
  return value;
};

const boolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${path} must be a boolean`);
  }
  return value;
};

const absolutePath = (value: unknown, path: string): string => {
  const result = string(value, path);
  if (!result.startsWith("/")) {
    throw new ConfigError(`${path} must be an absolute path`);
  }
  return result;
};

const validateBaseUrl = (
  value: unknown,
  allowInsecureHttp: boolean,
): string => {
  const baseUrl = string(value, "vikunja.base_url");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError("vikunja.base_url must be a valid URL");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ConfigError(
      "vikunja.base_url must contain only scheme, host, and optional port",
    );
  }
  if (url.protocol === "https:") return url.origin;
  if (
    url.protocol !== "http:" ||
    !allowInsecureHttp ||
    !isPrivateHost(url.hostname)
  ) {
    throw new ConfigError(
      "plain HTTP requires allow_insecure_http and a private host",
    );
  }
  return url.origin;
};

const isPrivateHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  const octets = normalized.split(".").map(Number);
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    first === 127
  );
};

const parseProject = (key: string, value: unknown): ProjectConfig => {
  const source = object(value, `projects.${key}`);
  hasOnly(
    source,
    [
      "display_identifier",
      "kanban_view_id",
      "repository",
      "default_branch",
      "conductor_manifest",
      "publish",
      "verify_commands",
    ],
    `projects.${key}`,
  );
  const numericId = Number(key);
  if (!Number.isSafeInteger(numericId) || numericId < 1) {
    throw new ConfigError(
      `projects.${key} must use a positive numeric project ID`,
    );
  }
  const publish = object(source.publish, `projects.${key}.publish`);
  hasOnly(publish, ["mode", "remote"], `projects.${key}.publish`);
  const mode = string(publish.mode, `projects.${key}.publish.mode`);
  if (mode !== "local" && mode !== "push_branch") {
    throw new ConfigError(
      `projects.${key}.publish.mode must be local or push_branch`,
    );
  }
  if (
    !Array.isArray(source.verify_commands) ||
    source.verify_commands.length === 0
  ) {
    throw new ConfigError(
      `projects.${key}.verify_commands must be a non-empty array`,
    );
  }
  const verifyCommands = source.verify_commands.map(
    (command, index): readonly string[] => {
      if (!Array.isArray(command) || command.length === 0) {
        throw new ConfigError(
          `projects.${key}.verify_commands[${index}] must be a non-empty argument array`,
        );
      }
      return command.map((argument, argumentIndex) =>
        string(
          argument,
          `projects.${key}.verify_commands[${index}][${argumentIndex}]`,
        ),
      );
    },
  );
  return {
    id: projectId(numericId),
    displayIdentifier: string(
      source.display_identifier,
      `projects.${key}.display_identifier`,
    ),
    kanbanViewId: viewId(
      integer(source.kanban_view_id, `projects.${key}.kanban_view_id`, 1),
    ),
    repository: string(source.repository, `projects.${key}.repository`),
    defaultBranch: string(
      source.default_branch,
      `projects.${key}.default_branch`,
    ),
    conductorManifest: string(
      source.conductor_manifest,
      `projects.${key}.conductor_manifest`,
    ),
    publish: {
      mode,
      remote: string(publish.remote, `projects.${key}.publish.remote`),
    },
    verifyCommands,
  };
};

/** Parse and validate immutable runner configuration. Spec §7. */
export function parseConfig(input: unknown): RunnerConfig {
  const source = object(input, "config");
  hasOnly(source, ["version", "vikunja", "runner", "projects"], "config");
  if (source.version !== 1) throw new ConfigError("version must be 1");
  const vikunja = object(source.vikunja, "vikunja");
  hasOnly(
    vikunja,
    [
      "base_url",
      "token_file",
      "owner_user_id",
      "runner_user_id",
      "poll_interval_seconds",
      "waiting_poll_interval_seconds",
      "request_timeout_seconds",
      "allow_insecure_http",
    ],
    "vikunja",
  );
  const runner = object(source.runner, "runner");
  hasOnly(
    runner,
    [
      "data_dir",
      "global_concurrency",
      "agent_dir",
      "analytics_config_path",
      "max_comment_chars",
    ],
    "runner",
  );
  if (runner.global_concurrency !== 1)
    throw new ConfigError(
      "runner.global_concurrency must equal 1 in version 1",
    );
  const allowInsecureHttp = boolean(
    vikunja.allow_insecure_http,
    "vikunja.allow_insecure_http",
  );
  const projectsValue = object(source.projects, "projects");
  const projectEntries = Object.entries(projectsValue);
  if (projectEntries.length === 0)
    throw new ConfigError("projects must contain at least one project");
  const projects: Record<string, ProjectConfig> = {};
  for (const [key, value] of projectEntries)
    projects[key] = parseProject(key, value);
  return {
    version: 1,
    vikunja: {
      baseUrl: validateBaseUrl(vikunja.base_url, allowInsecureHttp),
      tokenFile: absolutePath(vikunja.token_file, "vikunja.token_file"),
      ownerUserId: integer(vikunja.owner_user_id, "vikunja.owner_user_id", 1),
      runnerUserId: integer(
        vikunja.runner_user_id,
        "vikunja.runner_user_id",
        1,
      ),
      pollIntervalSeconds: integer(
        vikunja.poll_interval_seconds,
        "vikunja.poll_interval_seconds",
        1,
      ),
      waitingPollIntervalSeconds: integer(
        vikunja.waiting_poll_interval_seconds,
        "vikunja.waiting_poll_interval_seconds",
        1,
      ),
      requestTimeoutSeconds: integer(
        vikunja.request_timeout_seconds,
        "vikunja.request_timeout_seconds",
        1,
      ),
      allowInsecureHttp,
    },
    runner: {
      dataDir: absolutePath(runner.data_dir, "runner.data_dir"),
      agentDir: absolutePath(runner.agent_dir, "runner.agent_dir"),
      analyticsConfigPath: absolutePath(
        runner.analytics_config_path,
        "runner.analytics_config_path",
      ),
      maxCommentChars: integer(
        runner.max_comment_chars,
        "runner.max_comment_chars",
        1,
      ),
      globalConcurrency: 1,
    },
    projects,
  };
}

/** Load YAML configuration from disk and apply the same strict validation. */
export async function loadConfig(path: string): Promise<RunnerConfig> {
  const document = await readFile(path, "utf8");
  return parseConfig(parse(document));
}
