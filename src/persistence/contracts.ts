import type { JobId } from "../domain/jobs.js";
import type { CommentId, TaskId } from "../domain/types.js";

/** Durable IDs for interactions and externally visible milestone records. */
export type QuestionId = string & { readonly __brand: "QuestionId" };
export type MilestoneId = string & { readonly __brand: "MilestoneId" };
export type MutationIntentId = string & {
  readonly __brand: "MutationIntentId";
};

export const questionId = (value: string): QuestionId => value as QuestionId;
export const milestoneId = (value: string): MilestoneId => value as MilestoneId;
export const mutationIntentId = (value: string): MutationIntentId =>
  value as MutationIntentId;

export type QuestionKind = "input" | "confirm" | "select";
export type QuestionState = "pending" | "resolved" | "aborted";

export interface Question {
  readonly id: QuestionId;
  readonly jobId: JobId;
  readonly taskId: TaskId;
  readonly kind: QuestionKind;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly commentWatermark: CommentId | null;
  readonly commentId: CommentId | null;
  readonly responseCommentId: CommentId | null;
  readonly answer: string | null;
  readonly abortReason: string | null;
  readonly state: QuestionState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewQuestion {
  readonly jobId: JobId;
  readonly taskId: TaskId;
  readonly kind: QuestionKind;
  readonly prompt: string;
  readonly options?: readonly string[];
  readonly commentWatermark: CommentId | null;
}

export type MilestoneType =
  | "claimed"
  | "question"
  | "steering"
  | "abort"
  | "review"
  | "failure";
export type DeliveryState = "pending" | "delivered" | "failed";

export interface Milestone {
  readonly id: MilestoneId;
  readonly jobId: JobId;
  readonly type: MilestoneType;
  readonly idempotencyKey: string;
  readonly commentId: CommentId | null;
  readonly deliveryState: DeliveryState;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewMilestone {
  readonly jobId: JobId;
  readonly type: MilestoneType;
  readonly idempotencyKey: string;
}

export type MutationState = "pending" | "succeeded" | "failed";

export interface RemoteMutationIntent {
  readonly id: MutationIntentId;
  readonly jobId: JobId | null;
  readonly taskId: TaskId | null;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly request: unknown;
  readonly state: MutationState;
  readonly remoteId: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewRemoteMutationIntent {
  readonly jobId: JobId | null;
  readonly taskId: TaskId | null;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly request: unknown;
}
