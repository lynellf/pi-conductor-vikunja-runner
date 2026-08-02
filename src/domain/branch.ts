import type { TaskId } from "./types.js";

const taskSlug = (title: string | undefined): string => {
  const value = (title ?? "task")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return value === "" ? "task" : value;
};

/** Deterministic branch shared by claiming reports and Git preparation. */
export const taskBranchName = (
  taskId: TaskId,
  title: string | undefined,
): string => `pi/vikunja-${taskId}-${taskSlug(title)}`;
