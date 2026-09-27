import { describe, expect, test } from "bun:test";

import {
  applyAdjustment,
  parseQueuePosition,
  parseSeekPosition,
  parseVolumeLevel,
} from "./playback-input";

describe("parseSeekPosition", () => {
  test("reads absolute seconds and clock times", () => {
    expect(parseSeekPosition("90")).toEqual({ kind: "set", value: 90 });
    expect(parseSeekPosition("1:30")).toEqual({ kind: "set", value: 90 });
    expect(parseSeekPosition("1:02:03")).toEqual({ kind: "set", value: 3723 });
    expect(parseSeekPosition("0")).toEqual({ kind: "set", value: 0 });
  });

  test("reads signed values as relative offsets", () => {
    expect(parseSeekPosition("+10")).toEqual({ kind: "adjust", delta: 10 });
    expect(parseSeekPosition("-0:15")).toEqual({ kind: "adjust", delta: -15 });
  });

  test("rejects malformed times", () => {
    for (const value of [
      "",
      "abc",
      "1.5",
      "1:60",
      "1:5",
      ":30",
      "1::30",
      "+",
    ]) {
      expect(() => parseSeekPosition(value)).toThrow(
        "Position must be seconds or [h:]m:ss",
      );
    }
  });
});

describe("parseVolumeLevel", () => {
  test("reads absolute levels and signed adjustments", () => {
    expect(parseVolumeLevel("0")).toEqual({ kind: "set", value: 0 });
    expect(parseVolumeLevel("100")).toEqual({ kind: "set", value: 100 });
    expect(parseVolumeLevel("+5")).toEqual({ kind: "adjust", delta: 5 });
    expect(parseVolumeLevel("-10")).toEqual({ kind: "adjust", delta: -10 });
  });

  test("rejects malformed and out-of-range levels", () => {
    for (const value of ["", "loud", "101", "1.5", "+", "+101"]) {
      expect(() => parseVolumeLevel(value)).toThrow(
        "Volume must be 0-100, or +N/-N to adjust",
      );
    }
  });
});

describe("parseQueuePosition", () => {
  test("converts a displayed 1-based position to a queue index", () => {
    expect(parseQueuePosition("1")).toBe(0);
    expect(parseQueuePosition("12")).toBe(11);
  });

  test("rejects positions that are not positive integers", () => {
    for (const value of ["", "0", "-1", "1.5", "two"]) {
      expect(() => parseQueuePosition(value)).toThrow(
        "Position must be a positive integer",
      );
    }
  });
});

describe("applyAdjustment", () => {
  test("replaces the current value when setting", () => {
    expect(applyAdjustment({ kind: "set", value: 40 }, 80, 100)).toBe(40);
  });

  test("offsets the current value within bounds when adjusting", () => {
    expect(applyAdjustment({ kind: "adjust", delta: 10 }, 50, 100)).toBe(60);
    expect(applyAdjustment({ kind: "adjust", delta: -30 }, 20, 100)).toBe(0);
    expect(applyAdjustment({ kind: "adjust", delta: 30 }, 90, 100)).toBe(100);
  });

  test("leaves the upper bound open when none is given", () => {
    expect(applyAdjustment({ kind: "adjust", delta: 30 }, 90)).toBe(120);
  });
});
