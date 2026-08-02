import { describe, expect, it } from "vitest";
import {
  ACTIVE_JOB_STATES,
  isActiveJobState,
  type JobState,
  legalJobTransition,
} from "../src/domain/jobs.js";

const states: readonly JobState[] = [
  "claiming",
  "running",
  "waiting",
  "review",
  "failed",
];

const legal = new Set([
  "claiming:running",
  "claiming:failed",
  "running:waiting",
  "running:review",
  "running:failed",
  "waiting:running",
  "waiting:failed",
]);

describe("job lifecycle domain", () => {
  it("identifies exactly the version-one active states", () => {
    expect(ACTIVE_JOB_STATES).toEqual(["claiming", "running", "waiting"]);
    expect(states.filter(isActiveJobState)).toEqual(ACTIVE_JOB_STATES);
  });

  it("accepts every declared transition and rejects every other state pair", () => {
    for (const current of states) {
      for (const next of states) {
        expect(legalJobTransition(current, next), `${current} -> ${next}`).toBe(
          legal.has(`${current}:${next}`),
        );
      }
    }
  });
});
