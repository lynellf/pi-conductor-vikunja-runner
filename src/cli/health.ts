import type { RunnerConfig } from "../config/config.js";
import type { DaemonHeartbeatStore } from "../domain/jobs.js";
import type { ProjectId } from "../domain/types.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import { validateConfiguredProjects } from "./validate.js";

export interface HealthReport {
  readonly projectIds: readonly ProjectId[];
  readonly heartbeatAt: string;
}

export interface RunnerHealthInput {
  readonly config: RunnerConfig;
  readonly gateway: Pick<VikunjaGateway, "validateProjectLayout">;
  readonly store: DaemonHeartbeatStore;
  readonly now?: () => number;
  readonly maxHeartbeatAgeMs?: number;
}

/**
 * Check the read-only operational dependencies without polling or claiming.
 * The heartbeat is written by the daemon loop; health only verifies it.
 * Spec §§19 and 21.
 */
export const checkRunnerHealth = async (
  input: RunnerHealthInput,
): Promise<HealthReport> => {
  validateConfiguredProjects(input.config.projects);
  const projects = Object.values(input.config.projects).sort(
    (left, right) => left.id - right.id,
  );
  for (const project of projects) {
    await input.gateway.validateProjectLayout(project);
  }

  const heartbeatAt = await input.store.getHeartbeat();
  if (heartbeatAt === null) {
    throw new Error("daemon heartbeat is unavailable");
  }
  const heartbeatTime = Date.parse(heartbeatAt);
  if (Number.isNaN(heartbeatTime)) {
    throw new Error("daemon heartbeat is invalid");
  }
  const now = input.now ?? Date.now;
  const maxAgeMs =
    input.maxHeartbeatAgeMs ??
    Math.max(60_000, input.config.vikunja.pollIntervalSeconds * 4_000);
  if (now() - heartbeatTime > maxAgeMs) {
    throw new Error("daemon heartbeat is stale");
  }
  return { projectIds: projects.map((project) => project.id), heartbeatAt };
};
