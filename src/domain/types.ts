/** Numeric Vikunja identifiers are kept distinct from ordinary numbers. */
export type ProjectId = number & { readonly __brand: "ProjectId" };
export type ViewId = number & { readonly __brand: "ViewId" };
export type BucketId = number & { readonly __brand: "BucketId" };
export type TaskId = number & { readonly __brand: "TaskId" };

export const projectId = (value: number): ProjectId => value as ProjectId;
export const viewId = (value: number): ViewId => value as ViewId;
export const bucketId = (value: number): BucketId => value as BucketId;
export const taskId = (value: number): TaskId => value as TaskId;

export const WORKFLOW_BUCKET_NAMES = [
  "Backlog",
  "Ready",
  "Running",
  "Waiting",
  "Review",
  "Failed",
  "Done",
] as const;

export type WorkflowBucketName = (typeof WORKFLOW_BUCKET_NAMES)[number];

export interface Bucket {
  readonly id: BucketId;
  readonly title: string;
  readonly position: number;
}

export interface ProjectLayout {
  readonly viewId: ViewId;
  readonly buckets: Readonly<Record<WorkflowBucketName, Bucket>>;
  readonly defaultBucketId: BucketId;
  readonly doneBucketId: BucketId;
}

export interface CodingTask {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly priority: number;
  readonly position: number;
  readonly bucketId: BucketId;
  readonly done: boolean;
}
