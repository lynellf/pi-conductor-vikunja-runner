import type {
  Milestone,
  MilestoneId,
  NewMilestone,
  NewQuestion,
  NewRemoteMutationIntent,
  Question,
  QuestionId,
  RemoteMutationIntent,
} from "../persistence/contracts.js";
import type { CodingTask, CommentId, ProjectId, TaskId } from "./types.js";

/** Durable job identifiers are separate from Vikunja task identifiers. */
export type JobId = string & { readonly __brand: "JobId" };

export const jobId = (value: string): JobId => value as JobId;

export type JobState = "claiming" | "running" | "waiting" | "review" | "failed";

export type TerminalErrorCode =
  | "CONFIG_INVALID"
  | "VIKUNJA_UNAVAILABLE"
  | "PROJECT_LAYOUT_INVALID"
  | "CLAIM_CONFLICT"
  | "REPOSITORY_PREPARE_FAILED"
  | "CONDUCTOR_START_FAILED"
  | "CONDUCTOR_SESSION_FAILED"
  | "WAIT_INTERRUPTED"
  | "VERIFY_FAILED"
  | "PUBLISH_FAILED"
  | "MANUAL_STATE_OVERRIDE";

export interface Job {
  readonly id: JobId;
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly attempt: number;
  readonly state: JobState;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly conductorRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalErrorCode: TerminalErrorCode | null;
}

export type JobTransition =
  | { readonly state: "running" }
  | { readonly state: "waiting" }
  | { readonly state: "review" }
  | { readonly state: "failed"; readonly terminalErrorCode: TerminalErrorCode };

export interface DaemonHeartbeatStore {
  recordHeartbeat(at?: string): Promise<void>;
  getHeartbeat(): Promise<string | null>;
}

export interface JobStore extends DaemonHeartbeatStore {
  tryClaim(task: CodingTask, repository?: string): Promise<Job | null>;
  getJob(jobId: JobId): Promise<Job | null>;
  recordRunId(jobId: JobId, runId: string): Promise<void>;
  recordWorktree(jobId: JobId, branch: string, worktree: string): Promise<Job>;
  transition(jobId: JobId, transition: JobTransition): Promise<Job>;
  /** Atomically release an active job and persist every remote failure action. */
  recordTerminalFailure(
    jobId: JobId,
    terminalErrorCode: TerminalErrorCode,
    intents: readonly NewRemoteMutationIntent[],
  ): Promise<Job>;
  recoverableJobs(): Promise<readonly Job[]>;
  pendingQuestions(): Promise<readonly Question[]>;
  createQuestion(input: NewQuestion): Promise<Question>;
  getQuestion(questionId: QuestionId): Promise<Question | null>;
  getActiveQuestion(jobId: JobId): Promise<Question | null>;
  recordQuestionComment(
    questionId: QuestionId,
    commentId: CommentId,
  ): Promise<Question>;
  resolveQuestion(
    questionId: QuestionId,
    responseCommentId: CommentId,
    answer: string,
  ): Promise<Question>;
  /** Atomically resolve an accepted answer and resume its Waiting job. */
  resolveQuestionAndResume(
    questionId: QuestionId,
    responseCommentId: CommentId,
    answer: string,
  ): Promise<{ readonly question: Question; readonly job: Job }>;
  abortQuestion(questionId: QuestionId, reason?: string): Promise<Question>;
  getCommentWatermark(taskId: TaskId): Promise<CommentId | null>;
  recordCommentWatermark(taskId: TaskId, commentId: CommentId): Promise<void>;
  recordMilestone(input: NewMilestone): Promise<Milestone>;
  getMilestone(jobId: JobId, idempotencyKey: string): Promise<Milestone | null>;
  recordMilestoneComment(
    milestoneId: MilestoneId,
    commentId: CommentId,
  ): Promise<Milestone>;
  failMilestone(milestoneId: MilestoneId, error: string): Promise<Milestone>;
  recordMutationIntent(
    input: NewRemoteMutationIntent,
  ): Promise<RemoteMutationIntent>;
  getMutationIntent(
    idempotencyKey: string,
  ): Promise<RemoteMutationIntent | null>;
  pendingMutationIntents(): Promise<readonly RemoteMutationIntent[]>;
  completeMutation(
    idempotencyKey: string,
    remoteId: string | null,
  ): Promise<RemoteMutationIntent>;
  failMutation(
    idempotencyKey: string,
    error: string,
  ): Promise<RemoteMutationIntent>;
}

export const ACTIVE_JOB_STATES: readonly JobState[] = [
  "claiming",
  "running",
  "waiting",
];

export const isActiveJobState = (state: JobState): boolean =>
  ACTIVE_JOB_STATES.includes(state);

export const legalJobTransition = (
  current: JobState,
  next: JobState,
): boolean => {
  if (next === "failed")
    return (
      current === "claiming" || current === "running" || current === "waiting"
    );
  if (current === "claiming") return next === "running";
  if (current === "running") return next === "waiting" || next === "review";
  if (current === "waiting") return next === "running";
  return false;
};
