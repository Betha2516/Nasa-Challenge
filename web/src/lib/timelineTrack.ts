// The timeline line under the planet (TimelineTrack.tsx): where each instant sits
// on the line by its real time, where the playhead is, and how far the timeline
// moves when the planet turns. Pure, so it is tested without React.
//
// Decisions (docs/TIMELINE-HANDOFF.md):
// - The timeline plays on its own clock, at the pace of the planet's turn, and
//   only the person pauses it: a zoom into a region, a drag or Auto-rotate off
//   do not stop it. One turn's time covers a fixed stretch of real time per
//   cadence: one day for hourly data (smoke), 30 days for daily data (CO2), one
//   year for monthly data (lightning).
// - Marks are placed by each instant's real time, so a gap in the data shows as
//   a gap on the line. Layers without times (sample data) are evenly spaced.

import type { Cadence, LayerManifest } from "../data/types";
import { SPIN_SPEED } from "../scene/spin";
import { clampPosition } from "./timeline";

type Timed = Pick<LayerManifest, "dates" | "times" | "cadence">;

/** Real time one turn of the planet covers, as a count of instants of the cadence. */
export function framesPerTurn(cadence: Cadence | undefined, frames: number): number {
  const whole = Math.max(1, frames - 1);
  if (!cadence) return whole;
  switch (cadence.unit) {
    case "hour":
      return 24 / cadence.count;
    case "day":
      return 30 / cadence.count;
    case "month":
      return 12 / cadence.count;
  }
}

/** Seconds one turn of the planet takes; the timeline keeps this pace even when the planet stops. */
export const SECONDS_PER_TURN = (2 * Math.PI) / SPIN_SPEED;

/** Longest clock step counted, so a tab that was in the background does not jump the timeline. */
const MAX_PLAY_STEP_S = 0.1;

/** How much of the timeline `seconds` of playing moves (before the speed), given `perTurn` from positionPerTurn. */
export function playDelta(seconds: number, perTurn: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(perTurn)) return 0;
  return (Math.min(seconds, MAX_PLAY_STEP_S) / SECONDS_PER_TURN) * perTurn;
}

/** How much of the 0..1 timeline one full turn of the planet moves; 0 for a layer with one instant. */
export function positionPerTurn(layer: Timed): number {
  const frames = layer.dates.length;
  if (frames <= 1) return 0;
  return framesPerTurn(layer.cadence, frames) / (frames - 1);
}

/** The timeline after moving `delta` along it; past the end it starts again from the beginning. */
export function stepPosition(position: number, delta: number): number {
  const start = clampPosition(position);
  if (!Number.isFinite(delta) || delta === 0) return start;
  const next = start + delta;
  if (next >= 0 && next <= 1) return next;
  const wrapped = next % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

/** Where each instant sits on the line, 0 (first) to 1 (last), by real time when known. */
export function instantFractions(layer: Timed): number[] {
  const count = layer.dates.length;
  if (count <= 1) return count === 1 ? [0] : [];
  const times = layer.times;
  if (times && times.length === count) {
    const first = times[0]!;
    const span = times[count - 1]! - first;
    if (span > 0) return times.map((time) => (time - first) / span);
  }
  return Array.from({ length: count }, (_, index) => index / (count - 1));
}

/** Playhead place on the line (0..1) for a timeline position, between the two instants around it. */
export function fractionAtPosition(layer: Timed, position: number): number {
  const fractions = instantFractions(layer);
  if (fractions.length <= 1) return 0;
  const exact = clampPosition(position) * (fractions.length - 1);
  const from = Math.min(fractions.length - 2, Math.floor(exact));
  const mix = exact - from;
  return fractions[from]! + (fractions[from + 1]! - fractions[from]!) * mix;
}

/** Timeline position for a place on the line (0..1): the inverse of fractionAtPosition. */
export function positionAtFraction(layer: Timed, fraction: number): number {
  const fractions = instantFractions(layer);
  if (fractions.length <= 1) return 0;
  const x = clampPosition(fraction);
  let to = fractions.findIndex((value) => value >= x);
  if (to <= 0) return 0;
  const from = to - 1;
  const width = fractions[to]! - fractions[from]!;
  const mix = width > 0 ? (x - fractions[from]!) / width : 0;
  return (from + mix) / (fractions.length - 1);
}

/** Timeline position of an instant; used by the arrow keys to land exactly on one. */
export function positionOfFrame(frame: number, frames: number): number {
  if (frames <= 1) return 0;
  return clampPosition(Math.round(frame) / (frames - 1));
}

export interface Tick {
  /** Place on the line, 0..1. */
  fraction: number;
  /** A major mark starts a new day (hourly data), month (daily) or year (monthly). */
  major: boolean;
  /** Text under a major mark ("Sep 2", "2018"); empty for minor marks. */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Text of a major mark for an instant that starts a new day, month or year. */
function majorLabel(time: Date, cadence: Cadence): string {
  switch (cadence.unit) {
    case "hour":
      return `${MONTHS[time.getUTCMonth()]} ${time.getUTCDate()}`;
    case "day":
      // Short, so twelve months fit on the line; the year only where it starts.
      return time.getUTCMonth() === 0 ? `${MONTHS[0]} ${time.getUTCFullYear()}` : MONTHS[time.getUTCMonth()]!;
    case "month":
      return String(time.getUTCFullYear());
  }
}

/** True when `time` starts a new period compared with `before`, by the cadence. */
function startsPeriod(time: Date, before: Date, cadence: Cadence): boolean {
  switch (cadence.unit) {
    case "hour":
      return time.getUTCDate() !== before.getUTCDate() || time.getUTCMonth() !== before.getUTCMonth();
    case "day":
      return time.getUTCMonth() !== before.getUTCMonth();
    case "month":
      return time.getUTCFullYear() !== before.getUTCFullYear();
  }
}

/** Most labels that fit on the line; with more periods, the labels move up to months. */
export const MAX_LABELS = 14;
/** Most marks drawn one per instant; with more, only the marks that start a period are drawn. */
export const MAX_MARKS = 200;

/** Month label used when there are too many days to label each one: "Aug 2026", then "Sep". */
function monthLabel(time: Date, first: boolean): string {
  const month = MONTHS[time.getUTCMonth()]!;
  return first || time.getUTCMonth() === 0 ? `${month} ${time.getUTCFullYear()}` : month;
}

/**
 * Marks of the line. The first instant and each instant that starts a new day /
 * month / year (by the cadence) are major marks with a label. When that would be
 * more than MAX_LABELS labels for hourly data (weeks of it), the labelled marks
 * are the months instead and each day is an unlabelled mark. Every instant gets
 * a small mark unless there are more than MAX_MARKS of them; then only the marks
 * that start a period are drawn. Without times or cadence only the first and
 * last marks are major, labelled with their dates.
 */
export function timelineTicks(layer: Timed): Tick[] {
  const fractions = instantFractions(layer);
  const { times, cadence, dates } = layer;
  if (!times || !cadence || times.length !== fractions.length) {
    return fractions.map((fraction, index) => {
      const edge = index === 0 || index === fractions.length - 1;
      return { fraction, major: edge, label: edge ? (dates[index] ?? "") : "" };
    });
  }
  const moments = times.map((time) => new Date(time));
  const starts = moments.map((time, index) => index === 0 || startsPeriod(time, moments[index - 1]!, cadence));
  const byMonth = cadence.unit === "hour" && starts.filter(Boolean).length > MAX_LABELS;
  const dense = fractions.length > MAX_MARKS;
  const ticks: Tick[] = [];
  fractions.forEach((fraction, index) => {
    const time = moments[index]!;
    if (byMonth) {
      const monthStart = index === 0 || time.getUTCMonth() !== moments[index - 1]!.getUTCMonth();
      if (monthStart) ticks.push({ fraction, major: true, label: monthLabel(time, index === 0) });
      else if (starts[index] || !dense) ticks.push({ fraction, major: false, label: "" });
      return;
    }
    if (starts[index]) ticks.push({ fraction, major: true, label: majorLabel(time, cadence) });
    else if (!dense) ticks.push({ fraction, major: false, label: "" });
  });
  return ticks;
}

/** Short words for how far apart the instants are: "every hour", "every month". */
export function cadenceText(cadence: Cadence | undefined): string {
  if (!cadence) return "";
  const unit = cadence.unit;
  return cadence.count === 1 ? `every ${unit}` : `every ${cadence.count} ${unit}s`;
}

/** Speeds the person can pick for the timeline; the planet itself keeps turning at the same pace. */
export const TIMELINE_SPEEDS = [4, 8] as const;
/** Speed the timeline starts at. */
export const DEFAULT_TIMELINE_SPEED = TIMELINE_SPEEDS[0];

/** How much real time one turn of the planet covers at `speed`: "1 day", "120 days", "2 years". */
export function turnText(cadence: Cadence | undefined, speed: number): string {
  if (!cadence) return "";
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  const times = Math.round(speed * 100) / 100;
  switch (cadence.unit) {
    case "hour":
      return plural(times, "day");
    case "day":
      return plural(times * 30, "day");
    case "month":
      return plural(times, "year");
  }
}

/**
 * Collects the timeline's movement frame by frame and hands it on at most once
 * every `intervalMs`, so the timeline state (and what reads it) changes about 30
 * times a second, not on every animation frame.
 */
export class SpinAccumulator {
  private pending = 0;
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    private readonly flush: (delta: number) => void,
  ) {}

  /** Adds `delta` of timeline at time `now` (ms); flushes when the interval has passed. */
  add(delta: number, now: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.pending += delta;
    if (now - this.last >= this.intervalMs) {
      this.last = now;
      const out = this.pending;
      this.pending = 0;
      this.flush(out);
    }
  }

  /** Drops what has not been handed on yet (the layer changed). */
  reset(): void {
    this.pending = 0;
  }
}
