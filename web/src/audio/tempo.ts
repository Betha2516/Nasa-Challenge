// Data-time tempo marks for the overview.
//
// No layer currently has a timed mark. The helpers stay for adding marks to
// other layers later; the overview's data-time clock remains the shared
// timeline.

import type { LayerId } from "../data/types";
import { clampUnit } from "./mapping";

export interface TempoStyle {
  wave: OscillatorType;
  frequencyHz: number;
  gain: number;
  durationSeconds: number;
  attackSeconds: number;
}

/** Marks per prepared frame. Empty while no layer has a timed mark. */
export const TEMPO_BEATS_PER_FRAME: Partial<Record<LayerId, number>> = {};

/** Editable character of each timed layer's mark. Empty for now. */
export const TEMPO_STYLES: Partial<Record<LayerId, TempoStyle>> = {};

/** Lightning regional tempo: 90 bpm at value 0, 120 bpm at value 1. */
export function lightningBpm(value: number): number {
  return 90 + clampUnit(value) * 30;
}

/** Timeline fraction between two marks, or null for a layer with no timed marks. */
export function tempoStep(frames: number, beatsPerFrame: number | undefined): number | null {
  if (!beatsPerFrame || beatsPerFrame <= 0 || frames <= 1) return null;
  return 1 / ((frames - 1) * beatsPerFrame);
}

/** Mark index containing a timeline position. */
export function tempoIndex(position: number, step: number): number {
  if (!(step > 0)) return 0;
  return Math.floor(Math.max(0, Math.min(1, position)) / step);
}
