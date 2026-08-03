import { readFile, stat } from "node:fs/promises";
import type { ProjectConfig, RunnerConfig } from "../config/config.js";
import type { ProjectId } from "../domain/types.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import {
  validateAnalyticsConfiguration,
  validateConductorRuntime,
  validateRepositoryRuntime,
} from "./runtime-validation.js";

export type ReadTextFile = (path: string) => Promise<string>;
export type StatFile = (path: string) => Promise<{ readonly mode: number }>;

export interface ValidationReport {
  readonly projectIds: readonly ProjectId[];
  readonly checkedCredentials: readonly [string, string];
}

export interface ValidateRunnerInput {
  readonly config: RunnerConfig;
  readonly gateway: Pick<VikunjaGateway, "validateProjectLayout">;
  readonly readTextFile?: ReadTextFile;
  readonly statFile?: StatFile;
  readonly validateAnalytics?: (config: RunnerConfig) => Promise<void>;
  readonly validateConductor?: (config: RunnerConfig) => Promise<void>;
  readonly validateProjectRuntime?: (project: ProjectConfig) => Promise<void>;
}

const validateBranchName = (value: string, field: string): void => {
  const components = value.split("/");
  if (
    value === "HEAD" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    components.some(
      (component) =>
        component === "" ||
        component.startsWith(".") ||
        component.endsWith(".") ||
        component.endsWith(".lock"),
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  ) {
    throw new Error(`${field} is not a safe Git branch name`);
  }
};

/** Validate trusted repository-side paths and Git arguments without mutating a checkout. */
export const validateProjectConfiguration = (project: ProjectConfig): void => {
  if (project.repository.startsWith("-")) {
    throw new Error(`projects.${project.id}.repository cannot start with '-'`);
  }
  validateBranchName(
    project.defaultBranch,
    `projects.${project.id}.default_branch`,
  );
  if (project.publish.remote.startsWith("-")) {
    throw new Error(
      `projects.${project.id}.publish.remote cannot start with '-'`,
    );
  }
};

/** Validate all trusted project-side Git and worktree values before any runtime action. */
export const validateConfiguredProjects = (
  projects: Readonly<Record<string, ProjectConfig>>,
): void => {
  for (const project of Object.values(projects).sort(
    (left, right) => left.id - right.id,
  )) {
    validateProjectConfiguration(project);
  }
};

const readText: ReadTextFile = async (path) => readFile(path, "utf8");
const statPath: StatFile = async (path) => stat(path);

/** Read a protected, non-empty credential without exposing its contents. Spec §§16 and 19. */
export const readProtectedCredential = async (
  path: string,
  label: string,
  readTextFile: ReadTextFile = readText,
  statFile: StatFile = statPath,
): Promise<string> => {
  let metadata: { readonly mode: number };
  try {
    metadata = await statFile(path);
  } catch {
    throw new Error(`${label} file is unavailable`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} file must be readable only by its owner`);
  }
  let value: string;
  try {
    value = await readTextFile(path);
  } catch {
    throw new Error(`${label} file is unavailable`);
  }
  const credential = value.trim();
  if (credential === "") throw new Error(`${label} file is empty`);
  return credential;
};

/** Validate credentials and every configured remote workflow layout read-only. Spec §§7, 16, 19. */
export const validateRunner = async (
  input: ValidateRunnerInput,
): Promise<ValidationReport> => {
  const readTextFile = input.readTextFile ?? readText;
  const statFile = input.statFile ?? statPath;
  const projects = Object.values(input.config.projects).sort(
    (left, right) => left.id - right.id,
  );
  validateConfiguredProjects(input.config.projects);

  await readProtectedCredential(
    input.config.vikunja.tokenFile,
    "Vikunja token",
    readTextFile,
    statFile,
  );
  await readProtectedCredential(
    input.config.runner.analyticsConfigPath,
    "Analytics configuration",
    readTextFile,
    statFile,
  );

  await (input.validateAnalytics ?? validateAnalyticsConfiguration)(
    input.config,
  );
  await (input.validateConductor ?? validateConductorRuntime)(input.config);
  for (const project of projects) {
    await (input.validateProjectRuntime ?? validateRepositoryRuntime)(project);
    await input.gateway.validateProjectLayout(project);
  }
  return {
    projectIds: projects.map((project) => project.id),
    checkedCredentials: [
      input.config.vikunja.tokenFile,
      input.config.runner.analyticsConfigPath,
    ],
  };
};
