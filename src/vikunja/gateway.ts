import type { ProjectConfig } from "../config/config.js";
import type {
  BucketId,
  CodingTask,
  CommentId,
  ProjectLayout,
  TaskComment,
  TaskId,
} from "../domain/types.js";

/** Boundary used by jobs so Vikunja I/O can be replaced in unit tests. Spec §17. */
export interface VikunjaGateway {
  validateProjectLayout(project: ProjectConfig): Promise<ProjectLayout>;
  listReadyTasks(layout: ProjectLayout): Promise<readonly CodingTask[]>;
  getTask(taskId: TaskId): Promise<CodingTask>;
  moveTask(taskId: TaskId, bucketId: BucketId): Promise<void>;
  assignRunner(taskId: TaskId): Promise<void>;
  listComments(
    taskId: TaskId,
    after: CommentId | null,
  ): Promise<readonly TaskComment[]>;
  postComment(taskId: TaskId, body: string): Promise<CommentId>;
}
