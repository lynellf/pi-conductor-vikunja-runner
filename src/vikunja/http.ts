import type { ProjectConfig } from "../config/config.js";
import { validateProjectLayout } from "../domain/layout.js";
import type { ProjectLayout } from "../domain/types.js";
import {
  type BucketId,
  bucketId,
  type CodingTask,
  type CommentId,
  type ProjectId,
  projectId,
  type TaskComment,
  type TaskId,
  viewId,
} from "../domain/types.js";
import { VikunjaHttpError, VikunjaResponseError } from "./errors.js";
import type { VikunjaGateway } from "./gateway.js";
import {
  array,
  isObject,
  object,
  pageCount,
  parseAssignee,
  parseBucket,
  parseComment,
  parseTask,
  parseTaskBucket,
  parseView,
  positiveInteger,
  required,
  responseError,
  validateKanbanView,
} from "./validation.js";

export { VikunjaHttpError, VikunjaResponseError } from "./errors.js";

export interface VikunjaRetryOptions {
  /** Maximum number of attempts for one transient GET request, including the first. */
  readonly maxAttempts?: number;
  /** Base delay before the second attempt. */
  readonly initialDelayMs?: number;
  /** Upper bound for one retry delay. */
  readonly maxDelayMs?: number;
  /** Returns a value in [0, 1] used to add bounded jitter to the delay. */
  readonly jitter?: () => number;
  /** Injectable delay for deterministic tests and shutdown-aware callers. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface VikunjaHttpOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly requestTimeoutMs: number;
  readonly runnerUserId: number;
  readonly fetch?: typeof fetch;
  readonly retry?: VikunjaRetryOptions;
}

type RequestOptions = Readonly<{
  method?: "GET" | "POST" | "PUT";
  query?: Readonly<Record<string, string>>;
  body?: Record<string, unknown>;
}>;

/** Typed native-fetch Vikunja adapter with response validation and header pagination. Spec §§6, 17. */
export class VikunjaHttpGateway implements VikunjaGateway {
  private readonly requestFetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly retry: Required<
    Pick<
      VikunjaRetryOptions,
      "maxAttempts" | "initialDelayMs" | "maxDelayMs" | "jitter" | "sleep"
    >
  >;
  private readonly projects = new Map<ProjectId, ProjectConfig>();
  private readonly layouts = new Map<ProjectId, ProjectLayout>();
  private readonly taskLocations = new Map<
    TaskId,
    { project: ProjectConfig; layout: ProjectLayout }
  >();

  public constructor(options: VikunjaHttpOptions) {
    this.requestFetch = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.runnerId = options.runnerUserId;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new RangeError("requestTimeoutMs must be a positive integer");
    }
    const retry = options.retry ?? {};
    const maxAttempts = retry.maxAttempts ?? 3;
    const initialDelayMs = retry.initialDelayMs ?? 100;
    const maxDelayMs = retry.maxDelayMs ?? 2000;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("retry.maxAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 1) {
      throw new RangeError("retry.initialDelayMs must be a positive integer");
    }
    if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
      throw new RangeError(
        "retry.maxDelayMs must be an integer at least initialDelayMs",
      );
    }
    this.retry = {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      jitter: retry.jitter ?? Math.random,
      sleep:
        retry.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
    if (!Number.isSafeInteger(this.runnerId) || this.runnerId < 1) {
      throw new RangeError("runnerUserId must be a positive integer");
    }
  }

  public async validateProjectLayout(
    project: ProjectConfig,
  ): Promise<ProjectLayout> {
    const views = array(
      await this.request(`/projects/${project.id}/views`),
      "projects.views",
    );
    const configured = views
      .map((view, index) => ({
        view: parseView(view, `projects.views[${index}]`),
        index,
      }))
      .find(({ view }) => view.id === project.kanbanViewId);
    if (configured === undefined) {
      throw responseError(
        "projects.views",
        `view ${project.kanbanViewId} was not found`,
      );
    }
    const view = validateKanbanView(
      configured.view,
      `projects.views[${configured.index}]`,
    );
    const viewProjectId = positiveInteger(
      required(view.project_id, "view.project_id"),
      "view.project_id",
    );
    if (viewProjectId !== project.id) {
      throw responseError("view.project_id", "view belongs to another project");
    }
    const buckets = array(
      await this.request(
        `/projects/${project.id}/views/${project.kanbanViewId}/buckets`,
      ),
      "projects.buckets",
    ).map((bucket, index) =>
      parseBucket(bucket, `projects.buckets[${index}]`, project.kanbanViewId),
    );
    const layout = validateProjectLayout(
      viewId(project.kanbanViewId),
      buckets,
      bucketId(
        positiveInteger(
          required(view.default_bucket_id, "view.default_bucket_id"),
          "view.default_bucket_id",
        ),
      ),
      bucketId(
        positiveInteger(
          required(view.done_bucket_id, "view.done_bucket_id"),
          "view.done_bucket_id",
        ),
      ),
    );
    this.projects.set(project.id, project);
    this.layouts.set(project.id, layout);
    return layout;
  }

  public async listReadyTasks(
    layout: ProjectLayout,
  ): Promise<readonly CodingTask[]> {
    const projectEntry = [...this.layouts.entries()].find(
      ([, known]) => known === layout,
    );
    if (projectEntry === undefined) {
      throw new VikunjaResponseError(
        "layout was not validated by this gateway",
      );
    }
    const project = this.projects.get(projectEntry[0]);
    if (project === undefined)
      throw new VikunjaResponseError("project is unavailable");
    const tasks = await this.listPaged(
      `/projects/${project.id}/views/${layout.viewId}/tasks`,
      "tasks",
    );
    const parsedTasks = tasks.map((task, index) =>
      parseTask(task, `tasks[${index}]`),
    );
    for (const task of parsedTasks) {
      if (task.projectId !== project.id) {
        throw responseError(
          `tasks.${task.id}.project_id`,
          "task belongs to another project",
        );
      }
    }
    return parsedTasks.filter((task) => {
      if (task.bucketId !== layout.buckets.Ready.id) return false;
      this.taskLocations.set(task.id, { project, layout });
      return true;
    });
  }

  public async getTask(id: TaskId): Promise<CodingTask> {
    const location = this.taskLocations.get(id);
    const raw = await this.request(`/tasks/${id}?expand=buckets`);
    const source = object(raw, `tasks.${id}`);
    // After a restart there is no in-memory task location yet. Use the
    // validated project layout as the fallback for Vikunja's expanded bucket
    // response so reconciliation can still determine the current bucket.
    const rawProjectId = positiveInteger(
      required(source.project_id, `tasks.${id}.project_id`),
      `tasks.${id}.project_id`,
    );
    const knownLayout = this.layouts.get(projectId(rawProjectId));
    const expectedViewId = location?.layout.viewId ?? knownLayout?.viewId;
    let fallbackBucket: number | undefined;
    const expanded = source.buckets;
    if (Array.isArray(expanded) && expectedViewId !== undefined) {
      const matching = expanded.find((bucket) => {
        if (!isObject(bucket)) return false;
        return bucket.project_view_id === expectedViewId;
      });
      if (matching !== undefined && isObject(matching))
        fallbackBucket = positiveInteger(matching.id, `tasks.${id}.buckets.id`);
    }
    const task = parseTask(source, `tasks.${id}`, fallbackBucket);
    if (task.id !== id) {
      throw responseError(
        `tasks.${id}.id`,
        "response task ID does not match the requested task",
      );
    }
    const project = this.projects.get(task.projectId);
    const layout = this.layouts.get(task.projectId);
    if (project === undefined || layout === undefined) {
      throw new VikunjaResponseError(
        `task ${id} belongs to an unvalidated project`,
      );
    }
    this.taskLocations.set(task.id, { project, layout });
    return task;
  }

  public async moveTask(id: TaskId, targetBucketId: BucketId): Promise<void> {
    const location = this.taskLocations.get(id);
    if (location === undefined)
      throw new VikunjaResponseError(`task ${id} has no known project view`);
    const response = await this.request(
      `/projects/${location.project.id}/views/${location.layout.viewId}/buckets/${targetBucketId}/tasks`,
      { method: "PUT", body: { task_id: id } },
    );
    parseTaskBucket(
      response,
      `tasks.${id}.bucket`,
      id,
      location.layout.viewId,
      targetBucketId,
    );
  }

  public async assignRunner(id: TaskId): Promise<void> {
    if (!this.taskLocations.has(id)) {
      throw new VikunjaResponseError(`task ${id} has no known project view`);
    }
    const response = await this.request(`/tasks/${id}/assignees`, {
      method: "PUT",
      body: { user_id: this.runnerId },
    });
    parseAssignee(response, `tasks.${id}.assignee`, this.runnerId);
  }

  public async listComments(
    id: TaskId,
    after: CommentId | null,
  ): Promise<readonly TaskComment[]> {
    const values = await this.listPaged(
      `/tasks/${id}/comments`,
      `tasks.${id}.comments`,
      { order_by: "created" },
    );
    return values
      .map((comment, index) =>
        parseComment(comment, `tasks.${id}.comments[${index}]`, id),
      )
      .filter((comment) => after === null || comment.id > after);
  }

  public async postComment(id: TaskId, body: string): Promise<CommentId> {
    const response = await this.request(`/tasks/${id}/comments`, {
      method: "PUT",
      body: { comment: body },
    });
    const comment = parseComment(response, `tasks.${id}.comment`, id);
    return comment.id;
  }

  private readonly runnerId: number;

  private async listPaged(
    path: string,
    label: string,
    extraQuery: Readonly<Record<string, string>> = {},
  ): Promise<readonly unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.requestResponse(path, {
        query: { ...extraQuery, page: String(page), per_page: "50" },
      });
      const values = array(await this.readJson(response, path), label);
      result.push(...values);
      const total = pageCount(response, path);
      if (total === null || page >= total) return result;
    }
  }

  private async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const response = await this.requestResponse(path, options);
    if (response.status === 204) return undefined;
    return this.readJson(response, path);
  }

  private async requestResponse(
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const url = new URL(
      `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
    );
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);

    const method = options.method ?? "GET";
    const retryableRead = method === "GET";
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.requestTimeoutMs,
      );
      try {
        const response = await this.requestFetch(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.token}`,
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new VikunjaHttpError(
            `Vikunja request failed: ${method} ${path} (${response.status})`,
            response.status,
            response.status >= 500 || response.status === 429,
          );
        }
        return response;
      } catch (error) {
        const mapped =
          error instanceof VikunjaHttpError
            ? error
            : new VikunjaHttpError(
                `Vikunja request unavailable: ${method} ${path}`,
                null,
                true,
              );
        if (
          !retryableRead ||
          !mapped.retryable ||
          attempt + 1 >= this.retry.maxAttempts
        ) {
          throw mapped;
        }
        const exponential = Math.min(
          this.retry.maxDelayMs,
          this.retry.initialDelayMs * 2 ** attempt,
        );
        const jitterValue = this.retry.jitter();
        const jitter = Number.isFinite(jitterValue)
          ? Math.min(1, Math.max(0, jitterValue))
          : 0;
        const delay = Math.max(1, Math.floor(exponential * (0.5 + jitter / 2)));
        await this.retry.sleep(delay);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private async readJson(response: Response, path: string): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw responseError(path, "expected JSON");
    }
  }
}
