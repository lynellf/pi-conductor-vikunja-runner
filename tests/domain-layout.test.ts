import { describe, expect, it } from "vitest";
import {
  ProjectLayoutError,
  validateProjectLayout,
} from "../src/domain/layout.js";
import { type Bucket, bucketId, viewId } from "../src/domain/types.js";

const names = [
  "Backlog",
  "Ready",
  "Running",
  "Waiting",
  "Review",
  "Failed",
  "Done",
] as const;
const makeBuckets = (): Bucket[] =>
  names.map((title, index) => ({
    id: bucketId(index + 1),
    title,
    position: index,
  }));

describe("validateProjectLayout", () => {
  it("returns named buckets and identifies Backlog and Done", () => {
    const result = validateProjectLayout(
      viewId(8),
      makeBuckets(),
      bucketId(1),
      bucketId(7),
    );
    expect(result.buckets.Ready.id).toBe(bucketId(2));
    expect(result.defaultBucketId).toBe(bucketId(1));
    expect(result.doneBucketId).toBe(bucketId(7));
  });

  it("rejects a missing workflow bucket", () => {
    const buckets = makeBuckets().filter(
      (bucket) => bucket.title !== "Waiting",
    );
    expect(() =>
      validateProjectLayout(viewId(8), buckets, bucketId(1), bucketId(7)),
    ).toThrowError(new ProjectLayoutError("missing workflow buckets: Waiting"));
  });

  it("rejects duplicate workflow names", () => {
    const buckets = [
      ...makeBuckets(),
      { id: bucketId(20), title: "Ready", position: 8 },
    ];
    expect(() =>
      validateProjectLayout(viewId(8), buckets, bucketId(1), bucketId(7)),
    ).toThrow("duplicate workflow bucket: Ready");
  });

  it("rejects buckets outside the required workflow", () => {
    const buckets = [
      ...makeBuckets(),
      { id: bucketId(20), title: "Extra", position: 8 },
    ];
    expect(() =>
      validateProjectLayout(viewId(8), buckets, bucketId(1), bucketId(7)),
    ).toThrow("unexpected workflow buckets: Extra");
  });

  it("requires the configured default and done buckets", () => {
    expect(() =>
      validateProjectLayout(viewId(8), makeBuckets(), bucketId(2), bucketId(7)),
    ).toThrow("Backlog must be the default bucket");
    expect(() =>
      validateProjectLayout(viewId(8), makeBuckets(), bucketId(1), bucketId(6)),
    ).toThrow("Done must be the done bucket");
  });
});
