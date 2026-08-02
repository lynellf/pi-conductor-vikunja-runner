import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Job,
  JobId,
  JobState,
  JobStore,
  JobTransition,
  TerminalErrorCode,
} from "../domain/jobs.js";
import { jobId, legalJobTransition } from "../domain/jobs.js";
import type { CodingTask, CommentId, TaskId } from "../domain/types.js";
import { commentId, projectId, taskId } from "../domain/types.js";
import type {
  DeliveryState,
  Milestone,
  MilestoneId,
  MilestoneType,
  MutationState,
  NewMilestone,
  NewQuestion,
  NewRemoteMutationIntent,
  Question,
  QuestionId,
  QuestionKind,
  QuestionState,
  RemoteMutationIntent,
} from "./contracts.js";
import { milestoneId, mutationIntentId, questionId } from "./contracts.js";

const SCHEMA_VERSION = 4;

interface JobRow {
  readonly id: string;
  readonly task_id: number;
  readonly project_id: number;
  readonly attempt: number;
  readonly state: string;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly conductor_run_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_error_code: string | null;
}

interface QuestionRow {
  readonly id: string;
  readonly job_id: string;
  readonly task_id: number;
  readonly kind: string;
  readonly prompt: string;
  readonly options_json: string;
  readonly comment_watermark_id: number | null;
  readonly comment_id: number | null;
  readonly response_comment_id: number | null;
  readonly answer: string | null;
  readonly abort_reason: string | null;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MilestoneRow {
  readonly id: string;
  readonly job_id: string;
  readonly type: string;
  readonly idempotency_key: string;
  readonly comment_id: number | null;
  readonly delivery_state: string;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MutationRow {
  readonly id: string;
  readonly job_id: string | null;
  readonly task_id: number | null;
  readonly operation: string;
  readonly idempotency_key: string;
  readonly request_json: string;
  readonly state: string;
  readonly remote_id: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY NOT NULL,
      task_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      state TEXT NOT NULL CHECK (state IN ('claiming', 'running', 'waiting', 'review', 'failed')),
      branch TEXT,
      worktree TEXT,
      conductor_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_error_code TEXT
    );
    CREATE UNIQUE INDEX jobs_one_active_task
      ON jobs (task_id)
      WHERE state IN ('claiming', 'running', 'waiting');
    CREATE UNIQUE INDEX jobs_one_active_globally
      ON jobs ((1))
      WHERE state IN ('claiming', 'running', 'waiting');
    CREATE UNIQUE INDEX jobs_task_attempt ON jobs (task_id, attempt);
  `,
  `
    CREATE TABLE questions (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      task_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('input', 'confirm', 'select')),
      prompt TEXT NOT NULL,
      options_json TEXT NOT NULL,
      comment_watermark_id INTEGER,
      comment_id INTEGER,
      response_comment_id INTEGER,
      answer TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'aborted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX questions_one_pending_job
      ON questions (job_id) WHERE state = 'pending';
    CREATE TABLE comment_watermarks (
      task_id INTEGER PRIMARY KEY NOT NULL,
      last_comment_id INTEGER NOT NULL
    );
    CREATE TABLE milestones (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      type TEXT NOT NULL CHECK (type IN ('claimed', 'question', 'steering', 'abort', 'review', 'failure')),
      idempotency_key TEXT NOT NULL UNIQUE,
      comment_id INTEGER,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivered', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE remote_mutation_intents (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT REFERENCES jobs(id),
      task_id INTEGER,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
      remote_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE runner_heartbeat (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      updated_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE questions ADD COLUMN abort_reason TEXT;
  `,
];

const now = (): string => new Date().toISOString();

const isJobState = (value: string): value is JobState =>
  value === "claiming" ||
  value === "running" ||
  value === "waiting" ||
  value === "review" ||
  value === "failed";

const isTerminalErrorCode = (value: string): value is TerminalErrorCode =>
  [
    "CONFIG_INVALID",
    "VIKUNJA_UNAVAILABLE",
    "PROJECT_LAYOUT_INVALID",
    "CLAIM_CONFLICT",
    "REPOSITORY_PREPARE_FAILED",
    "CONDUCTOR_START_FAILED",
    "CONDUCTOR_SESSION_FAILED",
    "WAIT_INTERRUPTED",
    "VERIFY_FAILED",
    "PUBLISH_FAILED",
    "MANUAL_STATE_OVERRIDE",
  ].includes(value);

const isQuestionKind = (value: string): value is QuestionKind =>
  value === "input" || value === "confirm" || value === "select";
const isQuestionState = (value: string): value is QuestionState =>
  value === "pending" || value === "resolved" || value === "aborted";
const isMilestoneType = (value: string): value is MilestoneType =>
  ["claimed", "question", "steering", "abort", "review", "failure"].includes(
    value,
  );
const isDeliveryState = (value: string): value is DeliveryState =>
  value === "pending" || value === "delivered" || value === "failed";
const isMutationState = (value: string): value is MutationState =>
  value === "pending" || value === "succeeded" || value === "failed";

const nonEmpty = (value: string, field: string): string => {
  if (value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
};

const positiveComment = (value: CommentId, field: string): CommentId => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
};

const jsonStringArray = (value: string): readonly string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid persisted question options");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((option) => typeof option !== "string")
  ) {
    throw new Error("invalid persisted question options");
  }
  return parsed;
};

const jsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("invalid persisted mutation request");
  }
};

const asInteger = (value: string | number | bigint, field: string): number => {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new Error(`invalid persisted ${field}`);
  }
  return numberValue;
};

const asString = (value: string | number | bigint, field: string): string => {
  if (typeof value !== "string") throw new Error(`invalid persisted ${field}`);
  return value;
};

const fromRow = (row: JobRow): Job => {
  if (!isJobState(row.state)) throw new Error("invalid persisted job state");
  const terminalErrorCode =
    row.terminal_error_code === null
      ? null
      : isTerminalErrorCode(row.terminal_error_code)
        ? row.terminal_error_code
        : (() => {
            throw new Error("invalid persisted terminal error code");
          })();
  return {
    id: jobId(asString(row.id, "job id")),
    taskId: taskId(asInteger(row.task_id, "task id")),
    projectId: projectId(asInteger(row.project_id, "project id")),
    attempt: asInteger(row.attempt, "attempt"),
    state: row.state,
    branch: row.branch,
    worktree: row.worktree,
    conductorRunId: row.conductor_run_id,
    createdAt: asString(row.created_at, "created_at"),
    updatedAt: asString(row.updated_at, "updated_at"),
    terminalErrorCode,
  };
};

const nullableCommentId = (
  value: number | null,
  field: string,
): CommentId | null =>
  value === null ? null : commentId(asInteger(value, field));

const fromQuestionRow = (row: QuestionRow): Question => {
  if (!isQuestionKind(row.kind))
    throw new Error("invalid persisted question kind");
  if (!isQuestionState(row.state))
    throw new Error("invalid persisted question state");
  return {
    id: questionId(asString(row.id, "question id")),
    jobId: jobId(asString(row.job_id, "question job id")),
    taskId: taskId(asInteger(row.task_id, "question task id")),
    kind: row.kind,
    prompt: asString(row.prompt, "question prompt"),
    options: jsonStringArray(row.options_json),
    commentWatermark: nullableCommentId(
      row.comment_watermark_id,
      "question comment watermark",
    ),
    commentId: nullableCommentId(row.comment_id, "question comment id"),
    responseCommentId: nullableCommentId(
      row.response_comment_id,
      "question response comment id",
    ),
    answer: row.answer,
    abortReason: row.abort_reason,
    state: row.state,
    createdAt: asString(row.created_at, "question created_at"),
    updatedAt: asString(row.updated_at, "question updated_at"),
  };
};

const fromMilestoneRow = (row: MilestoneRow): Milestone => {
  if (!isMilestoneType(row.type))
    throw new Error("invalid persisted milestone type");
  if (!isDeliveryState(row.delivery_state))
    throw new Error("invalid persisted milestone state");
  return {
    id: milestoneId(asString(row.id, "milestone id")),
    jobId: jobId(asString(row.job_id, "milestone job id")),
    type: row.type,
    idempotencyKey: asString(row.idempotency_key, "milestone idempotency key"),
    commentId: nullableCommentId(row.comment_id, "milestone comment id"),
    deliveryState: row.delivery_state,
    error: row.error,
    createdAt: asString(row.created_at, "milestone created_at"),
    updatedAt: asString(row.updated_at, "milestone updated_at"),
  };
};

const fromMutationRow = (row: MutationRow): RemoteMutationIntent => {
  if (!isMutationState(row.state))
    throw new Error("invalid persisted mutation state");
  return {
    id: mutationIntentId(asString(row.id, "mutation id")),
    jobId:
      row.job_id === null
        ? null
        : jobId(asString(row.job_id, "mutation job id")),
    taskId:
      row.task_id === null
        ? null
        : taskId(asInteger(row.task_id, "mutation task id")),
    operation: asString(row.operation, "mutation operation"),
    idempotencyKey: asString(row.idempotency_key, "mutation idempotency key"),
    request: jsonValue(row.request_json),
    state: row.state,
    remoteId: row.remote_id,
    error: row.error,
    createdAt: asString(row.created_at, "mutation created_at"),
    updatedAt: asString(row.updated_at, "mutation updated_at"),
  };
};

const rollback = (database: DatabaseSync): void => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
};

/** SQLite-backed durable job store. Schema and claim constraints follow spec §§6 and 14. */
export class SqliteJobStore implements JobStore {
  private constructor(private readonly database: DatabaseSync) {}

  /** Open a database, enable WAL, and apply all schema migrations transactionally. */
  public static async open(path: string): Promise<SqliteJobStore> {
    await mkdir(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    try {
      database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
      );
      database.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);",
      );
      const row = database
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
        )
        .get() as { version: number };
      if (row.version < SCHEMA_VERSION) {
        database.exec("BEGIN IMMEDIATE");
        try {
          for (
            let version = row.version + 1;
            version <= SCHEMA_VERSION;
            version += 1
          ) {
            const migration = MIGRATIONS[version - 1];
            if (migration === undefined)
              throw new Error(`missing migration ${version}`);
            database.exec(migration);
            database
              .prepare(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
              )
              .run(version, now());
          }
          database.exec("COMMIT");
        } catch (error) {
          rollback(database);
          throw error;
        }
      }
      return new SqliteJobStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Close the SQLite connection after callers have stopped all work. */
  public close(): void {
    this.database.close();
  }

  public async recordHeartbeat(at = now()): Promise<void> {
    if (Number.isNaN(Date.parse(at))) {
      throw new Error("heartbeat timestamp must be an ISO date");
    }
    this.database
      .prepare(
        `INSERT INTO runner_heartbeat (id, updated_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(at);
  }

  public async getHeartbeat(): Promise<string | null> {
    const row = this.database
      .prepare("SELECT updated_at FROM runner_heartbeat WHERE id = 1")
      .get() as { updated_at: string } | undefined;
    return row?.updated_at ?? null;
  }

  public async tryClaim(task: CodingTask): Promise<Job | null> {
    const timestamp = now();
    const id = jobId(randomUUID());
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.database
        .prepare(
          "SELECT COALESCE(MAX(attempt), 0) AS attempt FROM jobs WHERE task_id = ?",
        )
        .get(task.id) as { attempt: number };
      const attempt = asInteger(previous.attempt, "attempt") + 1;
      this.database
        .prepare(
          `INSERT INTO jobs
           (id, task_id, project_id, attempt, state, branch, worktree, conductor_run_id, created_at, updated_at, terminal_error_code)
           VALUES (?, ?, ?, ?, 'claiming', NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(id, task.id, task.projectId, attempt, timestamp, timestamp);
      this.database.exec("COMMIT");
      return this.getJobSync(id);
    } catch (error) {
      rollback(this.database);
      if (this.isConstraintError(error)) return null;
      throw error;
    }
  }

  public async getJob(id: JobId): Promise<Job | null> {
    const row = this.database
      .prepare(
        "SELECT id, task_id, project_id, attempt, state, branch, worktree, conductor_run_id, created_at, updated_at, terminal_error_code FROM jobs WHERE id = ?",
      )
      .get(id) as unknown as JobRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  public async recordRunId(id: JobId, runId: string): Promise<void> {
    if (runId.trim() === "") throw new Error("runId must be non-empty");
    const result = this.database
      .prepare(
        "UPDATE jobs SET conductor_run_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(runId, now(), id);
    if (result.changes !== 1) throw new Error(`job ${id} was not found`);
  }

  public async recordWorktree(
    id: JobId,
    branch: string,
    worktree: string,
  ): Promise<Job> {
    if (branch.trim() === "" || worktree.trim() === "") {
      throw new Error("branch and worktree must be non-empty");
    }
    const result = this.database
      .prepare(
        "UPDATE jobs SET branch = ?, worktree = ?, updated_at = ? WHERE id = ?",
      )
      .run(branch, worktree, now(), id);
    if (result.changes !== 1) throw new Error(`job ${id} was not found`);
    return this.getJobSync(id);
  }

  public async transition(id: JobId, transition: JobTransition): Promise<Job> {
    const current = this.getJobSync(id);
    if (!legalJobTransition(current.state, transition.state)) {
      throw new Error(
        `illegal job transition ${current.state} -> ${transition.state}`,
      );
    }
    const errorCode =
      transition.state === "failed" ? transition.terminalErrorCode : null;
    const result = this.database
      .prepare(
        "UPDATE jobs SET state = ?, terminal_error_code = ?, updated_at = ? WHERE id = ? AND state = ?",
      )
      .run(transition.state, errorCode, now(), id, current.state);
    if (result.changes !== 1) throw new Error(`job ${id} changed concurrently`);
    return this.getJobSync(id);
  }

  public async recoverableJobs(): Promise<readonly Job[]> {
    const rows = this.database
      .prepare(
        "SELECT id, task_id, project_id, attempt, state, branch, worktree, conductor_run_id, created_at, updated_at, terminal_error_code FROM jobs WHERE state IN ('claiming', 'running', 'waiting') ORDER BY created_at, id",
      )
      .all() as unknown as JobRow[];
    return rows.map(fromRow);
  }

  public async pendingQuestions(): Promise<readonly Question[]> {
    const rows = this.database
      .prepare(
        `SELECT id, job_id, task_id, kind, prompt, options_json, comment_watermark_id,
                comment_id, response_comment_id, answer, abort_reason, state, created_at, updated_at
         FROM questions WHERE state = 'pending' ORDER BY created_at, id`,
      )
      .all() as unknown as QuestionRow[];
    return rows.map(fromQuestionRow);
  }

  public async createQuestion(input: NewQuestion): Promise<Question> {
    const prompt = nonEmpty(input.prompt, "question prompt");
    const options = input.options === undefined ? [] : [...input.options];
    if (input.commentWatermark !== null) {
      positiveComment(input.commentWatermark, "question comment watermark");
    }
    if (
      options.some((option) => option.trim() === "") ||
      new Set(options).size !== options.length
    ) {
      throw new Error("question options must be non-empty and unique");
    }
    if (input.kind === "select" && options.length === 0) {
      throw new Error("select question requires options");
    }
    if (input.kind !== "select" && options.length !== 0) {
      throw new Error("only select questions may have options");
    }
    const job = this.getJobSync(input.jobId);
    if (job.taskId !== input.taskId) {
      throw new Error("question task does not match job task");
    }
    const timestamp = now();
    const id = questionId(randomUUID());
    try {
      this.database
        .prepare(
          `INSERT INTO questions
           (id, job_id, task_id, kind, prompt, options_json, comment_watermark_id,
            comment_id, response_comment_id, answer, abort_reason, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending', ?, ?)`,
        )
        .run(
          id,
          input.jobId,
          input.taskId,
          input.kind,
          prompt,
          JSON.stringify(options),
          input.commentWatermark,
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (this.isConstraintError(error)) {
        throw new Error(`job ${input.jobId} already has a pending question`);
      }
      throw error;
    }
    return this.getQuestionSync(id);
  }

  public async getQuestion(questionId: QuestionId): Promise<Question | null> {
    const row = this.database
      .prepare(
        `SELECT id, job_id, task_id, kind, prompt, options_json, comment_watermark_id,
                comment_id, response_comment_id, answer, abort_reason, state, created_at, updated_at
         FROM questions WHERE id = ?`,
      )
      .get(questionId) as unknown as QuestionRow | undefined;
    return row === undefined ? null : fromQuestionRow(row);
  }

  public async getActiveQuestion(jobId: JobId): Promise<Question | null> {
    const row = this.database
      .prepare(
        `SELECT id, job_id, task_id, kind, prompt, options_json, comment_watermark_id,
                comment_id, response_comment_id, answer, abort_reason, state, created_at, updated_at
         FROM questions WHERE job_id = ? AND state = 'pending'`,
      )
      .get(jobId) as unknown as QuestionRow | undefined;
    return row === undefined ? null : fromQuestionRow(row);
  }

  public async recordQuestionComment(
    id: QuestionId,
    comment: CommentId,
  ): Promise<Question> {
    positiveComment(comment, "question comment id");
    const current = this.getQuestionSync(id);
    if (current.state !== "pending") {
      if (current.commentId === comment) return current;
      throw new Error(`question ${id} is no longer pending`);
    }
    if (current.commentId !== null && current.commentId !== comment) {
      throw new Error(`question ${id} already has a comment`);
    }
    this.database
      .prepare(
        "UPDATE questions SET comment_id = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(comment, now(), id);
    return this.getQuestionSync(id);
  }

  public async resolveQuestion(
    id: QuestionId,
    responseComment: CommentId,
    answer: string,
  ): Promise<Question> {
    positiveComment(responseComment, "question response comment id");
    const current = this.getQuestionSync(id);
    if (current.state !== "pending") {
      if (
        current.state === "resolved" &&
        current.responseCommentId === responseComment &&
        current.answer === answer
      )
        return current;
      throw new Error(`question ${id} is no longer pending`);
    }
    nonEmpty(answer, "question answer");
    this.database
      .prepare(
        `UPDATE questions
         SET response_comment_id = ?, answer = ?, state = 'resolved', updated_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(responseComment, answer, now(), id);
    return this.getQuestionSync(id);
  }

  public async abortQuestion(
    id: QuestionId,
    reason = "dialog aborted",
  ): Promise<Question> {
    const current = this.getQuestionSync(id);
    if (current.state === "aborted") return current;
    if (current.state !== "pending")
      throw new Error(`question ${id} is no longer pending`);
    const boundedReason = reason.trim().slice(0, 2000);
    if (boundedReason === "") throw new Error("question abort reason is empty");
    this.database
      .prepare(
        "UPDATE questions SET state = 'aborted', abort_reason = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(boundedReason, now(), id);
    return this.getQuestionSync(id);
  }

  public async getCommentWatermark(task: TaskId): Promise<CommentId | null> {
    const row = this.database
      .prepare(
        "SELECT last_comment_id FROM comment_watermarks WHERE task_id = ?",
      )
      .get(task) as { last_comment_id: number } | undefined;
    return row === undefined
      ? null
      : commentId(asInteger(row.last_comment_id, "comment watermark"));
  }

  public async recordCommentWatermark(
    task: TaskId,
    comment: CommentId,
  ): Promise<void> {
    if (!Number.isSafeInteger(comment) || comment < 1) {
      throw new Error("comment watermark must be a positive integer");
    }
    this.database
      .prepare(
        `INSERT INTO comment_watermarks (task_id, last_comment_id) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET last_comment_id = excluded.last_comment_id
         WHERE excluded.last_comment_id > comment_watermarks.last_comment_id`,
      )
      .run(task, comment);
  }

  public async recordMilestone(input: NewMilestone): Promise<Milestone> {
    nonEmpty(input.idempotencyKey, "milestone idempotency key");
    if (!isMilestoneType(input.type)) throw new Error("invalid milestone type");
    this.getJobSync(input.jobId);
    const existing = this.getMilestoneByKeySync(input.idempotencyKey);
    if (existing !== null) {
      if (existing.jobId !== input.jobId || existing.type !== input.type) {
        throw new Error(
          `milestone idempotency key ${input.idempotencyKey} is already used`,
        );
      }
      return existing;
    }
    const timestamp = now();
    const id = milestoneId(randomUUID());
    try {
      this.database
        .prepare(
          `INSERT INTO milestones
           (id, job_id, type, idempotency_key, comment_id, delivery_state, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)`,
        )
        .run(
          id,
          input.jobId,
          input.type,
          input.idempotencyKey,
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (this.isConstraintError(error)) {
        const raced = this.getMilestoneByKeySync(input.idempotencyKey);
        if (raced !== null) {
          if (raced.jobId !== input.jobId || raced.type !== input.type) {
            throw new Error(
              `milestone idempotency key ${input.idempotencyKey} is already used`,
            );
          }
          return raced;
        }
      }
      throw error;
    }
    return this.getMilestoneSync(
      input.jobId,
      input.idempotencyKey,
    ) as Milestone;
  }

  public async getMilestone(
    jobId: JobId,
    idempotencyKey: string,
  ): Promise<Milestone | null> {
    return this.getMilestoneSync(jobId, idempotencyKey);
  }

  public async recordMilestoneComment(
    id: MilestoneId,
    comment: CommentId,
  ): Promise<Milestone> {
    positiveComment(comment, "milestone comment id");
    const current = this.getMilestoneByIdSync(id);
    if (current.deliveryState === "delivered" && current.commentId === comment)
      return current;
    if (current.deliveryState !== "pending") {
      throw new Error(`milestone ${id} is no longer pending`);
    }
    this.database
      .prepare(
        "UPDATE milestones SET comment_id = ?, delivery_state = 'delivered', updated_at = ? WHERE id = ? AND delivery_state = 'pending'",
      )
      .run(comment, now(), id);
    return this.getMilestoneByIdSync(id);
  }

  public async failMilestone(
    id: MilestoneId,
    error: string,
  ): Promise<Milestone> {
    nonEmpty(error, "milestone error");
    const current = this.getMilestoneByIdSync(id);
    if (current.deliveryState === "failed" && current.error === error)
      return current;
    if (current.deliveryState !== "pending") {
      throw new Error(`milestone ${id} is no longer pending`);
    }
    this.database
      .prepare(
        "UPDATE milestones SET delivery_state = 'failed', error = ?, updated_at = ? WHERE id = ? AND delivery_state = 'pending'",
      )
      .run(error, now(), id);
    return this.getMilestoneByIdSync(id);
  }

  public async recordMutationIntent(
    input: NewRemoteMutationIntent,
  ): Promise<RemoteMutationIntent> {
    nonEmpty(input.operation, "mutation operation");
    nonEmpty(input.idempotencyKey, "mutation idempotency key");
    const request = JSON.stringify(input.request) ?? "null";
    const existing = this.getMutationIntentSync(input.idempotencyKey);
    if (existing !== null) {
      if (
        existing.operation !== input.operation ||
        existing.jobId !== input.jobId ||
        existing.taskId !== input.taskId ||
        JSON.stringify(existing.request) !== request
      ) {
        throw new Error(
          `mutation idempotency key ${input.idempotencyKey} is already used`,
        );
      }
      return existing;
    }
    const timestamp = now();
    const id = mutationIntentId(randomUUID());
    try {
      this.database
        .prepare(
          `INSERT INTO remote_mutation_intents
           (id, job_id, task_id, operation, idempotency_key, request_json, state, remote_id, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          input.jobId,
          input.taskId,
          input.operation,
          input.idempotencyKey,
          request,
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (this.isConstraintError(error)) {
        const raced = this.getMutationIntentSync(input.idempotencyKey);
        if (raced !== null) {
          if (
            raced.operation !== input.operation ||
            raced.jobId !== input.jobId ||
            raced.taskId !== input.taskId ||
            JSON.stringify(raced.request) !== request
          ) {
            throw new Error(
              `mutation idempotency key ${input.idempotencyKey} is already used`,
            );
          }
          return raced;
        }
      }
      throw error;
    }
    return this.getMutationIntentSync(
      input.idempotencyKey,
    ) as RemoteMutationIntent;
  }

  public async getMutationIntent(
    idempotencyKey: string,
  ): Promise<RemoteMutationIntent | null> {
    return this.getMutationIntentSync(idempotencyKey);
  }

  public async pendingMutationIntents(): Promise<
    readonly RemoteMutationIntent[]
  > {
    const rows = this.database
      .prepare(
        `SELECT id, job_id, task_id, operation, idempotency_key, request_json,
                state, remote_id, error, created_at, updated_at
         FROM remote_mutation_intents WHERE state = 'pending'
         ORDER BY created_at, id`,
      )
      .all() as unknown as MutationRow[];
    return rows.map(fromMutationRow);
  }

  public async completeMutation(
    idempotencyKey: string,
    remoteId: string | null,
  ): Promise<RemoteMutationIntent> {
    const current = this.getMutationIntentSync(idempotencyKey);
    if (current === null)
      throw new Error(`mutation ${idempotencyKey} was not found`);
    if (current.state === "succeeded") {
      if (current.remoteId === remoteId) return current;
      throw new Error(`mutation ${idempotencyKey} already completed`);
    }
    if (current.state === "failed")
      throw new Error(`mutation ${idempotencyKey} already failed`);
    this.database
      .prepare(
        "UPDATE remote_mutation_intents SET state = 'succeeded', remote_id = ?, error = NULL, updated_at = ? WHERE idempotency_key = ? AND state = 'pending'",
      )
      .run(remoteId, now(), idempotencyKey);
    return this.getMutationIntentSync(idempotencyKey) as RemoteMutationIntent;
  }

  public async failMutation(
    idempotencyKey: string,
    error: string,
  ): Promise<RemoteMutationIntent> {
    nonEmpty(error, "mutation error");
    const current = this.getMutationIntentSync(idempotencyKey);
    if (current === null)
      throw new Error(`mutation ${idempotencyKey} was not found`);
    if (current.state === "failed" && current.error === error) return current;
    if (current.state !== "pending")
      throw new Error(`mutation ${idempotencyKey} is not pending`);
    this.database
      .prepare(
        "UPDATE remote_mutation_intents SET state = 'failed', error = ?, updated_at = ? WHERE idempotency_key = ? AND state = 'pending'",
      )
      .run(error, now(), idempotencyKey);
    return this.getMutationIntentSync(idempotencyKey) as RemoteMutationIntent;
  }

  private getQuestionSync(id: QuestionId): Question {
    const row = this.database
      .prepare(
        `SELECT id, job_id, task_id, kind, prompt, options_json, comment_watermark_id,
                comment_id, response_comment_id, answer, abort_reason, state, created_at, updated_at
         FROM questions WHERE id = ?`,
      )
      .get(id) as unknown as QuestionRow | undefined;
    if (row === undefined) throw new Error(`question ${id} was not found`);
    return fromQuestionRow(row);
  }

  private getMilestoneSync(
    jobId: JobId,
    idempotencyKey: string,
  ): Milestone | null {
    const row = this.database
      .prepare(
        `SELECT id, job_id, type, idempotency_key, comment_id, delivery_state,
                error, created_at, updated_at
         FROM milestones WHERE job_id = ? AND idempotency_key = ?`,
      )
      .get(jobId, idempotencyKey) as unknown as MilestoneRow | undefined;
    return row === undefined ? null : fromMilestoneRow(row);
  }

  private getMilestoneByKeySync(idempotencyKey: string): Milestone | null {
    const row = this.database
      .prepare(
        `SELECT id, job_id, type, idempotency_key, comment_id, delivery_state,
                error, created_at, updated_at
         FROM milestones WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as unknown as MilestoneRow | undefined;
    return row === undefined ? null : fromMilestoneRow(row);
  }

  private getMilestoneByIdSync(id: MilestoneId): Milestone {
    const row = this.database
      .prepare(
        `SELECT id, job_id, type, idempotency_key, comment_id, delivery_state,
                error, created_at, updated_at
         FROM milestones WHERE id = ?`,
      )
      .get(id) as unknown as MilestoneRow | undefined;
    if (row === undefined) throw new Error(`milestone ${id} was not found`);
    return fromMilestoneRow(row);
  }

  private getMutationIntentSync(
    idempotencyKey: string,
  ): RemoteMutationIntent | null {
    const row = this.database
      .prepare(
        `SELECT id, job_id, task_id, operation, idempotency_key, request_json,
                state, remote_id, error, created_at, updated_at
         FROM remote_mutation_intents WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as unknown as MutationRow | undefined;
    return row === undefined ? null : fromMutationRow(row);
  }

  private getJobSync(id: JobId): Job {
    const row = this.database
      .prepare(
        "SELECT id, task_id, project_id, attempt, state, branch, worktree, conductor_run_id, created_at, updated_at, terminal_error_code FROM jobs WHERE id = ?",
      )
      .get(id) as unknown as JobRow | undefined;
    if (row === undefined) throw new Error(`job ${id} was not found`);
    return fromRow(row);
  }

  private isConstraintError(error: unknown): boolean {
    return error instanceof Error && /constraint/i.test(error.message);
  }
}
