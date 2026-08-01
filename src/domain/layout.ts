import {
  type Bucket,
  type ProjectLayout,
  type ViewId,
  WORKFLOW_BUCKET_NAMES,
} from "./types.js";

export class ProjectLayoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectLayoutError";
  }
}

/** Validate the configured seven-bucket workflow and identify its authority buckets. Spec §§2, 5.1. */
export function validateProjectLayout(
  viewId: ViewId,
  buckets: readonly Bucket[],
  defaultBucketId: Bucket["id"],
  doneBucketId: Bucket["id"],
): ProjectLayout {
  const byName = new Map<string, Bucket>();
  for (const bucket of buckets) {
    if (byName.has(bucket.title)) {
      throw new ProjectLayoutError(
        `duplicate workflow bucket: ${bucket.title}`,
      );
    }
    byName.set(bucket.title, bucket);
  }

  const missing = WORKFLOW_BUCKET_NAMES.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new ProjectLayoutError(
      `missing workflow buckets: ${missing.join(", ")}`,
    );
  }
  const unexpected = [...byName.keys()].filter(
    (name) =>
      !WORKFLOW_BUCKET_NAMES.includes(
        name as (typeof WORKFLOW_BUCKET_NAMES)[number],
      ),
  );
  if (unexpected.length > 0) {
    throw new ProjectLayoutError(
      `unexpected workflow buckets: ${unexpected.join(", ")}`,
    );
  }

  const workflowBuckets = Object.fromEntries(
    WORKFLOW_BUCKET_NAMES.map((name) => [name, byName.get(name)]),
  ) as Record<(typeof WORKFLOW_BUCKET_NAMES)[number], Bucket>;

  if (workflowBuckets.Backlog.id !== defaultBucketId) {
    throw new ProjectLayoutError("Backlog must be the default bucket");
  }
  if (workflowBuckets.Done.id !== doneBucketId) {
    throw new ProjectLayoutError("Done must be the done bucket");
  }

  return {
    viewId,
    buckets: workflowBuckets,
    defaultBucketId,
    doneBucketId,
  };
}
