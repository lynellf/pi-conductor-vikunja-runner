import type { ProjectConfig } from "../config/config.js";
import type { VikunjaGateway } from "../vikunja/gateway.js";
import { type ClaimResult, claimReadyTask } from "./claiming.js";
import { selectEligibleTasks } from "./eligibility.js";
import type { JobStore } from "./jobs.js";
import type { CodingTask, ProjectId, ProjectLayout, TaskId } from "./types.js";

export interface PollCycleInput {
  readonly projects: Readonly<Record<string, ProjectConfig>>;
  readonly store: JobStore;
  readonly gateway: VikunjaGateway;
  readonly maxCommentChars?: number;
}

export interface PollCycleReport {
  readonly validatedProjects: readonly ProjectId[];
  readonly listedTasks: number;
  readonly eligibleTaskIds: readonly TaskId[];
  readonly claim: ClaimResult | null;
  /** Validated polling layout retained for safe post-claim failure reporting. */
  readonly claimLayout?: ProjectLayout;
}

/**
 * Validate configured layouts, read Ready tasks, and claim at most one task.
 * The local job store remains the source of concurrency truth. Spec §§6, 7.
 */
export const pollOnce = async (
  input: PollCycleInput,
): Promise<PollCycleReport> => {
  const projects = Object.values(input.projects).sort(
    (left, right) => left.id - right.id,
  );
  const layouts = new Map<ProjectId, ProjectLayout>();
  const tasks: CodingTask[] = [];

  for (const project of projects) {
    const layout = await input.gateway.validateProjectLayout(project);
    layouts.set(project.id, layout);
    tasks.push(...(await input.gateway.listReadyTasks(layout)));
  }

  const activeJobs = await input.store.recoverableJobs();
  const activeTaskIds = new Set(activeJobs.map((job) => job.taskId));
  const availableSlots = Math.max(0, 1 - activeJobs.length);
  const eligible = selectEligibleTasks(tasks, {
    layouts,
    activeTaskIds,
    availableSlots,
  });
  const task = eligible[0];
  const projectForTask =
    task === undefined
      ? undefined
      : projects.find((project) => project.id === task.projectId);
  const claim =
    task === undefined
      ? null
      : await claimReadyTask({
          task,
          ...(projectForTask === undefined
            ? {}
            : { repository: projectForTask.repository }),
          layout: layouts.get(task.projectId) as ProjectLayout,
          store: input.store,
          gateway: input.gateway,
          ...(input.maxCommentChars === undefined
            ? {}
            : { maxCommentChars: input.maxCommentChars }),
        });

  return {
    validatedProjects: projects.map((project) => project.id),
    listedTasks: tasks.length,
    eligibleTaskIds: eligible.map((eligibleTask) => eligibleTask.id),
    claim,
    ...(task === undefined
      ? {}
      : { claimLayout: layouts.get(task.projectId) as ProjectLayout }),
  };
};
