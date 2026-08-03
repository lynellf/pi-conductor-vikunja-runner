import type { Bucket } from "../domain/types.js";
import {
  type BucketId,
  bucketId,
  type CodingTask,
  commentId,
  projectId,
  type TaskComment,
  type TaskId,
  taskId,
  userId,
} from "../domain/types.js";
import { VikunjaResponseError } from "./errors.js";

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const responseError = (
  path: string,
  detail: string,
): VikunjaResponseError =>
  new VikunjaResponseError(`invalid Vikunja response at ${path}: ${detail}`);

export const required = (value: unknown, path: string): unknown => {
  if (value === undefined || value === null)
    throw responseError(path, "missing");
  return value;
};

export const positiveInteger = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw responseError(path, "expected a positive integer");
  }
  return value;
};

const finiteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw responseError(path, "expected a finite number");
  }
  return value;
};

const text = (value: unknown, path: string): string => {
  if (typeof value !== "string") throw responseError(path, "expected a string");
  return value;
};

const bool = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean")
    throw responseError(path, "expected a boolean");
  return value;
};

export const object = (value: unknown, path: string): JsonObject => {
  if (!isObject(value)) throw responseError(path, "expected an object");
  return value;
};

export const array = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw responseError(path, "expected an array");
  return value;
};

export const parseBucket = (
  value: unknown,
  path: string,
  expectedViewId: number,
): Bucket => {
  const source = object(value, path);
  const bucketViewId = positiveInteger(
    required(source.project_view_id, `${path}.project_view_id`),
    `${path}.project_view_id`,
  );
  if (bucketViewId !== expectedViewId) {
    throw responseError(path, "bucket belongs to another project view");
  }
  return {
    id: bucketId(
      positiveInteger(required(source.id, `${path}.id`), `${path}.id`),
    ),
    title: text(required(source.title, `${path}.title`), `${path}.title`),
    position: finiteNumber(
      required(source.position, `${path}.position`),
      `${path}.position`,
    ),
  };
};

export const parseView = (value: unknown, path: string): JsonObject =>
  object(value, path);

export const validateKanbanView = (
  source: JsonObject,
  path: string,
): JsonObject => {
  if (
    text(
      required(source.view_kind, `${path}.view_kind`),
      `${path}.view_kind`,
    ) !== "kanban"
  ) {
    throw responseError(path, "configured view is not kanban");
  }
  if (
    text(
      required(
        source.bucket_configuration_mode,
        `${path}.bucket_configuration_mode`,
      ),
      `${path}.bucket_configuration_mode`,
    ) !== "manual"
  ) {
    throw responseError(path, "configured view is not manual");
  }
  return source;
};

export const parseTask = (
  value: unknown,
  path: string,
  fallbackBucketId?: number,
): CodingTask => {
  const source = object(value, path);
  const rawBucketId = fallbackBucketId ?? source.bucket_id;
  const description =
    source.description === undefined || source.description === null
      ? undefined
      : text(source.description, `${path}.description`);
  return {
    id: taskId(
      positiveInteger(required(source.id, `${path}.id`), `${path}.id`),
    ),
    projectId: projectId(
      positiveInteger(
        required(source.project_id, `${path}.project_id`),
        `${path}.project_id`,
      ),
    ),
    title: text(required(source.title, `${path}.title`), `${path}.title`),
    ...(description === undefined ? {} : { description }),
    priority: finiteNumber(
      required(source.priority, `${path}.priority`),
      `${path}.priority`,
    ),
    position: finiteNumber(
      required(source.position, `${path}.position`),
      `${path}.position`,
    ),
    bucketId: bucketId(
      positiveInteger(
        required(rawBucketId, `${path}.bucket_id`),
        `${path}.bucket_id`,
      ),
    ),
    done: bool(required(source.done, `${path}.done`), `${path}.done`),
  };
};

export const parseKanbanBucketTasks = (
  value: unknown,
  path: string,
  expectedViewId: number,
): readonly CodingTask[] => {
  const source = object(value, path);
  const bucket = parseBucket(source, path, expectedViewId);
  const tasks = array(required(source.tasks, `${path}.tasks`), `${path}.tasks`);
  return tasks.map((value, index) => {
    const taskPath = `${path}.tasks[${index}]`;
    const taskSource = object(value, taskPath);
    if (taskSource.bucket_id !== undefined && taskSource.bucket_id !== null) {
      const returnedBucketId = positiveInteger(
        taskSource.bucket_id,
        `${taskPath}.bucket_id`,
      );
      if (returnedBucketId !== bucket.id) {
        throw responseError(taskPath, "task belongs to another bucket");
      }
    }
    return parseTask(taskSource, taskPath, bucket.id);
  });
};

export const parseComment = (
  value: unknown,
  path: string,
  task: TaskId,
): TaskComment => {
  const source = object(value, path);
  const author = object(
    required(source.author, `${path}.author`),
    `${path}.author`,
  );
  return {
    id: commentId(
      positiveInteger(required(source.id, `${path}.id`), `${path}.id`),
    ),
    taskId: task,
    authorId: userId(
      positiveInteger(
        required(author.id, `${path}.author.id`),
        `${path}.author.id`,
      ),
    ),
    body: text(required(source.comment, `${path}.comment`), `${path}.comment`),
    createdAt: text(
      required(source.created, `${path}.created`),
      `${path}.created`,
    ),
  };
};

export const parseTaskBucket = (
  value: unknown,
  path: string,
  expectedTaskId: TaskId,
  expectedViewId: number,
  expectedBucketId: BucketId,
): void => {
  const source = object(value, path);
  const returnedTaskId = positiveInteger(
    required(source.task_id, `${path}.task_id`),
    `${path}.task_id`,
  );
  const returnedViewId = positiveInteger(
    required(source.project_view_id, `${path}.project_view_id`),
    `${path}.project_view_id`,
  );
  const returnedBucketId = positiveInteger(
    required(source.bucket_id, `${path}.bucket_id`),
    `${path}.bucket_id`,
  );
  if (
    returnedTaskId !== expectedTaskId ||
    returnedViewId !== expectedViewId ||
    returnedBucketId !== expectedBucketId
  ) {
    throw responseError(
      path,
      "move response does not match the requested task bucket",
    );
  }
};

export const parseAssignee = (
  value: unknown,
  path: string,
  expectedUserId: number,
): void => {
  const source = object(value, path);
  const returnedUserId = positiveInteger(
    required(source.user_id, `${path}.user_id`),
    `${path}.user_id`,
  );
  if (returnedUserId !== expectedUserId) {
    throw responseError(
      path,
      "assignment response does not match the runner user",
    );
  }
};

export const pageCount = (response: Response, path: string): number | null => {
  const header = response.headers.get("x-pagination-total-pages");
  if (header === null) return null;
  const count = Number(header);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw responseError(path, "invalid x-pagination-total-pages header");
  }
  return count;
};
