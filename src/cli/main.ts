import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/config.js";
import { SqliteJobStore } from "../persistence/sqlite.js";
import { VikunjaHttpGateway } from "../vikunja/http.js";
import { checkRunnerHealth } from "./health.js";
import { runnerLogger } from "./logging.js";
import { type OnceDependencies, runOnce } from "./once.js";
import { type DaemonDependencies, runDaemon } from "./run.js";
import {
  readProtectedCredential,
  validateConfiguredProjects,
  validateRunner,
} from "./validate.js";

export type CliCommand = "run" | "validate" | "once" | "health";

export interface CliArguments {
  readonly command: CliCommand;
  readonly configPath: string;
}

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Parse the small operational CLI contract without accepting task-controlled values. Spec §19. */
export const parseCliArguments = (argv: readonly string[]): CliArguments => {
  let command: CliCommand = "run";
  let index = 0;
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-")) {
    if (
      first !== "run" &&
      first !== "validate" &&
      first !== "once" &&
      first !== "health"
    ) {
      throw new CliUsageError(`unknown command: ${first}`);
    }
    command = first;
    index = 1;
  }

  let configPath: string | undefined;
  while (index < argv.length) {
    const argument = argv[index];
    if (argument !== "--config") {
      throw new CliUsageError(`unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new CliUsageError("--config requires a path");
    }
    if (configPath !== undefined) {
      throw new CliUsageError("--config may be supplied only once");
    }
    configPath = value;
    index += 2;
  }
  if (configPath === undefined) {
    throw new CliUsageError("--config is required");
  }
  return { command, configPath };
};

/** Execute the read-only configuration and remote-layout validation command. Spec §§7, 16, 19. */
const gatewayFor = (
  config: Awaited<ReturnType<typeof loadConfig>>,
  token: string,
) =>
  new VikunjaHttpGateway({
    baseUrl: `${config.vikunja.baseUrl}/api/v1`,
    token,
    requestTimeoutMs: config.vikunja.requestTimeoutSeconds * 1000,
    runnerUserId: config.vikunja.runnerUserId,
  });

export const runValidate = async (configPath: string): Promise<void> => {
  const config = await loadConfig(configPath);
  validateConfiguredProjects(config.projects);
  const token = await readProtectedCredential(
    config.vikunja.tokenFile,
    "Vikunja token",
  );
  const report = await validateRunner({
    config,
    gateway: gatewayFor(config, token),
  });
  runnerLogger.info("runner_validation_succeeded", {
    projectCount: report.projectIds.length,
    projectIds: report.projectIds,
    credentialsChecked: report.checkedCredentials.length,
  });
};

/** Run read-only dependency and heartbeat checks without claiming work. Spec §§19 and 21. */
export const runHealth = async (configPath: string): Promise<void> => {
  const config = await loadConfig(configPath);
  validateConfiguredProjects(config.projects);
  const token = await readProtectedCredential(
    config.vikunja.tokenFile,
    "Vikunja token",
  );
  const store = await SqliteJobStore.open(
    join(config.runner.dataDir, "state.sqlite"),
  );
  try {
    const report = await checkRunnerHealth({
      config,
      gateway: gatewayFor(config, token),
      store,
    });
    runnerLogger.info("runner_health_succeeded", {
      projectCount: report.projectIds.length,
      projectIds: report.projectIds,
      heartbeatAt: report.heartbeatAt,
    });
  } finally {
    store.close();
  }
};

/** Dispatch one CLI invocation and return a process exit code. */
export const runCli = async (
  argv: readonly string[],
  dependencies: Partial<OnceDependencies> & Partial<DaemonDependencies> = {},
): Promise<number> => {
  const parsed = parseCliArguments(argv);
  if (parsed.command === "run") {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const report = await runDaemon(
        parsed.configPath,
        dependencies,
        controller.signal,
      );
      runnerLogger.info("runner_stopped", {
        cycles: report.cycles,
        resumedJobs: report.resumedJobs,
      });
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
  if (parsed.command === "validate") {
    await runValidate(parsed.configPath);
    return 0;
  }
  if (parsed.command === "health") {
    await runHealth(parsed.configPath);
    return 0;
  }
  if (parsed.command === "once") {
    const report = await runOnce(parsed.configPath, dependencies);
    runnerLogger.info("runner_once_completed", {
      validatedProjects: report.poll.validatedProjects,
      claimStatus: report.poll.claim?.status ?? "none",
    });
    return 0;
  }
  const unsupported: never = parsed.command;
  throw new CliUsageError(`unsupported command: ${unsupported}`);
};

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "runner failed";
    runnerLogger.error("runner_command_failed", error, { message });
    process.exitCode = 1;
  });
}
