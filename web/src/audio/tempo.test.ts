import { describe, expect, it } from "vitest";
import { TEMPO_BEATS_PER_FRAME, TEMPO_STYLES, lightningBpm, tempoIndex, tempoStep } from "./tempo";

describe("tempo marks", () => {
  it("has no layer marks configured", () => {
    expect(Object.keys(TEMPO_BEATS_PER_FRAME)).toEqual([]);
    expect(Object.keys(TEMPO_STYLES)).toEqual([]);
  });

  it("maps the lightning value to a 90..120 bpm regional tempo", () => {
    expect(lightningBpm(0)).toBe(90);
    expect(lightningBpm(0.5)).toBe(105);
    expect(lightningBpm(1)).toBe(120);
  });

  it("spaces marks across the timeline by frame and unit", () => {
    expect(tempoStep(488, 3)).toBeCloseTo(1 / (487 * 3), 12);
    expect(tempoStep(366, 1)).toBeCloseTo(1 / 365, 12);
    expect(tempoStep(1, 1)).toBeNull();
    expect(tempoStep(10, undefined)).toBeNull();
    expect(tempoIndex(0.5, 1 / 10)).toBe(5);
    expect(tempoIndex(1, 1 / 10)).toBe(10);
  });

});
