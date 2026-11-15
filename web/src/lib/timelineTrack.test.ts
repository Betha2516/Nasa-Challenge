import { describe, expect, it, vi } from "vitest";
import type { Cadence, LayerManifest } from "../data/types";
import {
  SECONDS_PER_TURN,
  SpinAccumulator,
  playDelta,
  DEFAULT_TIMELINE_SPEED,
  TIMELINE_SPEEDS,
  cadenceText,
  turnText,
  fractionAtPosition,
  framesPerTurn,
  instantFractions,
  positionAtFraction,
  positionOfFrame,
  positionPerTurn,
  stepPosition,
  timelineTicks,
} from "./timelineTrack";

type Timed = Pick<LayerManifest, "dates" | "times" | "cadence">;

const HOUR = 3_600_000;
const hourly: Cadence = { unit: "hour", count: 1 };
const monthly: Cadence = { unit: "month", count: 1 };

/** `count` hourly instants from 1 Sep 2026 00:30 UTC. */
function smoke(count: number): Timed {
  const first = Date.UTC(2026, 8, 1, 0, 30);
  const times = Array.from({ length: count }, (_, index) => first + index * HOUR);
  return { dates: times.map((time) => new Date(time).toISOString()), times, cadence: hourly };
}

/** Monthly instants from January 2017. */
function lightning(count: number): Timed {
  const times = Array.from({ length: count }, (_, index) => Date.UTC(2017, index, 1));
  return { dates: times.map((time) => new Date(time).toISOString()), times, cadence: monthly };
}

describe("turning the planet plays the timeline", () => {
  it("covers one day of hourly data and one year of monthly data per turn", () => {
    expect(framesPerTurn(hourly, 168)).toBe(24);
    expect(framesPerTurn({ unit: "hour", count: 6 }, 12)).toBe(4);
    expect(framesPerTurn({ unit: "day", count: 1 }, 366)).toBe(30);
    expect(framesPerTurn(monthly, 79)).toBe(12);
    // Without a cadence (sample data), one turn plays the whole sequence.
    expect(framesPerTurn(undefined, 6)).toBe(5);

    // Seven days of hourly smoke: 167 steps between instants, 24 of them per turn.
    expect(positionPerTurn(smoke(168))).toBeCloseTo(24 / 167);
    expect(positionPerTurn(lightning(79))).toBeCloseTo(12 / 78);
    expect(positionPerTurn({ dates: ["Apr 2019 - Jul 2025"] })).toBe(0);
  });

  it("starts again from the beginning after the last instant", () => {
    expect(stepPosition(0.2, 0.3)).toBeCloseTo(0.5);
    expect(stepPosition(0.9, 0.25)).toBeCloseTo(0.15);
    expect(stepPosition(1, 0)).toBe(1);
    expect(stepPosition(0.1, -0.25)).toBeCloseTo(0.85);
    expect(stepPosition(0.5, Number.NaN)).toBe(0.5);
  });

  it("hands the turn on about 30 times a second, never losing any of it", () => {
    const flush = vi.fn();
    const spin = new SpinAccumulator(33, flush);
    spin.add(0.01, 0);
    spin.add(0.01, 16);
    spin.add(0.01, 32);
    expect(flush).toHaveBeenCalledTimes(1);
    spin.add(0.01, 40);
    expect(flush).toHaveBeenCalledTimes(2);
    const total = flush.mock.calls.reduce((sum, [delta]) => sum + (delta as number), 0);
    expect(total).toBeCloseTo(0.04);
    spin.add(0.01, 50);
    spin.reset();
    spin.add(0, 100);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});

describe("marks on the line", () => {
  it("places instants by their real time, so a gap in the data shows as a gap", () => {
    const even = smoke(3);
    expect(instantFractions(even)).toEqual([0, 0.5, 1]);
    const gap: Timed = { ...even, times: [0, HOUR, 4 * HOUR] };
    expect(instantFractions(gap)).toEqual([0, 0.25, 1]);
    // Without times the instants are evenly spaced.
    expect(instantFractions({ dates: ["a", "b", "c", "d", "e"] })).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(instantFractions({ dates: ["fixed"] })).toEqual([0]);
  });

  it("keeps the playhead and the place picked on the line in step, gaps included", () => {
    const gap: Timed = { ...smoke(3), times: [0, HOUR, 4 * HOUR] };
    // Half-way between instants 1 and 2 (position 0.75) is half-way along the gap on the line.
    expect(fractionAtPosition(gap, 0.75)).toBeCloseTo(0.625);
    expect(positionAtFraction(gap, 0.625)).toBeCloseTo(0.75);
    for (const position of [0, 0.1, 0.5, 0.9, 1]) {
      expect(positionAtFraction(gap, fractionAtPosition(gap, position))).toBeCloseTo(position);
    }
    expect(positionAtFraction(gap, -1)).toBe(0);
    expect(positionAtFraction(gap, 2)).toBe(1);
    expect(fractionAtPosition({ dates: ["fixed"] }, 0.5)).toBe(0);
  });

  it("lands the arrow keys exactly on an instant", () => {
    expect(positionOfFrame(0, 168)).toBe(0);
    expect(positionOfFrame(167, 168)).toBe(1);
    expect(positionOfFrame(10, 11)).toBe(1);
    expect(positionOfFrame(5, 1)).toBe(0);
  });

  it("labels a new day for hourly data and a new year for monthly data", () => {
    const ticks = timelineTicks(smoke(48));
    expect(ticks).toHaveLength(48);
    const majors = ticks.filter((tick) => tick.major);
    expect(majors.map((tick) => tick.label)).toEqual(["Sep 1", "Sep 2"]);
    expect(majors[1]!.fraction).toBeCloseTo(24 / 47);
    expect(ticks[5]).toEqual({ fraction: 5 / 47, major: false, label: "" });

    const years = timelineTicks(lightning(79)).filter((tick) => tick.major).map((tick) => tick.label);
    expect(years).toEqual(["2017", "2018", "2019", "2020", "2021", "2022", "2023"]);
  });

  it("labels months, not days, for weeks of three-hourly data and drops the marks in between", () => {
    const first = Date.UTC(2026, 7, 1, 0, 30);
    const times = Array.from({ length: 488 }, (_, index) => first + index * 3 * HOUR);
    const season: Timed = { dates: times.map(String), times, cadence: { unit: "hour", count: 3 } };
    const ticks = timelineTicks(season);
    expect(ticks.filter((tick) => tick.major).map((tick) => tick.label)).toEqual(["Aug 2026", "Sep"]);
    // One unlabelled mark per day start (61 days, two of them month starts), no mark per instant.
    expect(ticks).toHaveLength(61);
  });

  it("labels each month of daily data briefly, with the year only in January", () => {
    const times = Array.from({ length: 366 }, (_, day) => Date.UTC(2020, 0, 1 + day));
    const daily: Timed = { dates: times.map(String), times, cadence: { unit: "day", count: 1 } };
    const labels = timelineTicks(daily).filter((tick) => tick.major).map((tick) => tick.label);
    expect(labels).toEqual(["Jan 2020", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  });

  it("labels only the ends when the layer has no times", () => {
    const ticks = timelineTicks({ dates: ["Sample 1 of 3", "Sample 2 of 3", "Sample 3 of 3"] });
    expect(ticks.map((tick) => tick.label)).toEqual(["Sample 1 of 3", "", "Sample 3 of 3"]);
  });

  it("offers only 4x and 8x and starts at 4x", () => {
    expect(TIMELINE_SPEEDS).toEqual([4, 8]);
    expect(DEFAULT_TIMELINE_SPEED).toBe(4);
  });

  it("says how much real time one turn covers at the picked speed", () => {
    expect(turnText(hourly, 1)).toBe("1 day");
    expect(turnText(hourly, 4)).toBe("4 days");
    expect(turnText({ unit: "day", count: 1 }, 1)).toBe("30 days");
    expect(turnText({ unit: "day", count: 1 }, 4)).toBe("120 days");
    expect(turnText(monthly, 1)).toBe("1 year");
    expect(turnText(monthly, 8)).toBe("8 years");
    expect(turnText(undefined, 2)).toBe("");
  });

  it("says how often the data comes", () => {
    expect(cadenceText(hourly)).toBe("every hour");
    expect(cadenceText({ unit: "hour", count: 6 })).toBe("every 6 hours");
    expect(cadenceText(monthly)).toBe("every month");
    expect(cadenceText(undefined)).toBe("");
  });
});

describe("the timeline's own clock", () => {
  it("moves one turn's worth of timeline in the time the planet takes to turn once", () => {
    const perTurn = 0.25;
    let moved = 0;
    for (let t = 0; t < SECONDS_PER_TURN; t += 0.05) moved += playDelta(Math.min(0.05, SECONDS_PER_TURN - t), perTurn);
    expect(moved).toBeCloseTo(perTurn, 6);
  });

  it("does not jump when a background tab comes back after a long pause", () => {
    expect(playDelta(30, 1)).toBe(playDelta(0.1, 1));
  });

  it("does not move for no time, negative time or a broken pace", () => {
    expect(playDelta(0, 1)).toBe(0);
    expect(playDelta(-1, 1)).toBe(0);
    expect(playDelta(Number.NaN, 1)).toBe(0);
    expect(playDelta(0.05, Number.NaN)).toBe(0);
  });
});
