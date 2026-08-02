import type { CodingTask, ProjectId, ProjectLayout, TaskId } from "./types.js";

export interface TaskSelectionContext {
  readonly layouts: ReadonlyMap<ProjectId, ProjectLayout>;
  readonly activeTaskIds: ReadonlySet<TaskId>;
  readonly availableSlots: number;
}

/**
 * Select new work using the workflow bucket as the authority.
 * Spec §§5.1, 6 and acceptance criteria 3–4.
 */
export function selectEligibleTasks(
  tasks: readonly CodingTask[],
  context: TaskSelectionContext,
): readonly CodingTask[] {
  if (context.availableSlots <= 0) return [];

  const eligible = tasks.filter((task) => {
    const layout = context.layouts.get(task.projectId);
    return (
      layout !== undefined &&
      task.bucketId === layout.buckets.Ready.id &&
      !task.done &&
      !context.activeTaskIds.has(task.id)
    );
  });

  eligible.sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.position !== right.position) {
      return left.position - right.position;
    }
    return left.id - right.id;
  });

  return eligible.slice(0, context.availableSlots);
}
