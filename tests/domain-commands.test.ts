import { describe, expect, it } from "vitest";
import { parsePiComment } from "../src/domain/commands.js";
import { userId } from "../src/domain/types.js";

describe("parsePiComment", () => {
  const owner = userId(1);

  it("accepts owner steering text without changing its content", () => {
    expect(
      parsePiComment(" /pi steer  please inspect the API  ", owner, owner),
    ).toEqual({
      kind: "steer",
      message: "please inspect the API",
    });
  });

  it("accepts abort with an optional trimmed reason", () => {
    expect(
      parsePiComment("/pi abort  stop after the failed check ", owner, owner),
    ).toEqual({
      kind: "abort",
      reason: "stop after the failed check",
    });
    expect(parsePiComment("/pi abort", owner, owner)).toEqual({
      kind: "abort",
      reason: null,
    });
  });

  it("routes malformed and unknown commands to help while retaining plain comments", () => {
    expect(parsePiComment("/pi steer", owner, owner).kind).toBe("help");
    expect(parsePiComment("/pi pause now", owner, owner).kind).toBe("help");
    expect(parsePiComment(" owner context ", owner, owner)).toEqual({
      kind: "plain",
      body: " owner context ",
    });
  });

  it("ignores every comment authored by someone other than the owner", () => {
    expect(parsePiComment("/pi abort", userId(2), owner)).toEqual({
      kind: "ignore",
      reason: "not-owner",
    });
  });
});
