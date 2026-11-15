// Whole-visible-area sonification for the planet view.
//
// Every column of a 12 x 12 screen grid sounds at the same time. Each column is
// panned by its screen position, every row gets a pitch from its latitude, and
// the layer value at the cell sets the row gain. The shared timeline chooses the
// data frame; there is no second scan clock.
//
// Pure functions and constants only, so the mapping and instrument table can be
// tested without Web Audio.

import type { LayerId } from "../data/types";
import {
  MAJOR_PENTATONIC_SEMITONES,
  MINOR_PENTATONIC_SEMITONES,
  SUSPENDED_PENTATONIC_SEMITONES,
  clampUnit,
  positionToPan,
} from "./mapping";

/** Screen grid sampled over the visible globe: 12 columns x 12 rows = 144 cells. */
export const OVERVIEW_COLUMNS = 12;
export const OVERVIEW_ROWS = 12;

/** Lowest overview note and number of scale steps from pole to equator. */
export const OVERVIEW_BASE_HZ = 110;
export const OVERVIEW_PITCH_STEPS = 10;

/** Global gain applied on top of every layer's instrument gain. */
export const OVERVIEW_LAYER_GAIN = 1.5;

/**
 * A cell sounds only when its value reaches this fraction of the average of the
 * visible field. 1 means "at or above the visible average"; lower values let
 * more of the field through. This is a relative threshold, never an absolute
 * intensity level.
 */
export const OVERVIEW_TRIGGER_RATIO = 0.2;

/**
 * The instrument of each layer in the overview. Everything that shapes the
 * timbre lives here so the team can tune a layer without touching the audio
 * graph. `octave` shifts the latitude scale for that layer's register.
 */
export interface OverviewInstrument {
  wave: OscillatorType;
  filterHz: number;
  filterQ: number;
  attackSeconds: number;
  releaseSeconds: number;
  gain: number;
  detuneCents: number;
  octave: number;
  /** Semitone offsets of the scale this layer sings on. */
  scale: readonly number[];
}

export const OVERVIEW_INSTRUMENTS: Record<LayerId, OverviewInstrument> = {
  forest: {
    wave: "triangle",
    filterHz: 3200,
    filterQ: 0.7,
    attackSeconds: 0.08,
    releaseSeconds: 0.3,
    gain: 0.8,
    detuneCents: 0,
    octave: 0,
    scale: MAJOR_PENTATONIC_SEMITONES,
  },
  smoke: {
    wave: "sawtooth",
    filterHz: 1600,
    filterQ: 1.1,
    attackSeconds: 0.05,
    releaseSeconds: 0.3,
    gain: 0.65,
    detuneCents: -5,
    octave: 2,
    scale: SUSPENDED_PENTATONIC_SEMITONES,
  },
  co2: {
    wave: "sawtooth",
    filterHz: 900,
    filterQ: 1.2,
    attackSeconds: 0.1,
    releaseSeconds: 0.4,
    gain: 0.4,
    detuneCents: 5,
    octave: 1,
    scale: MINOR_PENTATONIC_SEMITONES,
  },
  lightning: {
    wave: "square",
    filterHz: 2400,
    filterQ: 0.8,
    attackSeconds: 0.01,
    releaseSeconds: 0.8,
    gain: 0.4,
    detuneCents: 12,
    octave: 1,
    scale: MAJOR_PENTATONIC_SEMITONES,
  },
};


/** Extra detail layered under the regional point voice. */
export interface RegionalSample {
  url: string;
  gain: number;
  filterHz: number;
  filterQ: number;
}

export interface RegionalEnrichment {
  /** Detuned companion oscillator, in cents. */
  detuneCents: number;
  /** Sub oscillator octave offset; 0 disables it. */
  subOctave: number;
  /** Level of the sub oscillator relative to the main one. */
  subGain: number;
  /** Sends to the shared regional chorus and reverb. */
  chorusSend: number;
  reverbSend: number;
  /** A sustained sample bed under the synth, when one exists. */
  sample?: RegionalSample;
}

/** Per-layer regional detail; the base waveform/scale still comes from OVERVIEW_INSTRUMENTS. */
export const REGIONAL_ENRICHMENT: Record<LayerId, RegionalEnrichment> = {
  forest: {
    detuneCents: 7,
    subOctave: -12,
    subGain: 0.18,
    chorusSend: 0.18,
    reverbSend: 0.18,
  },
  smoke: {
    detuneCents: -6,
    subOctave: -12,
    subGain: 0.14,
    chorusSend: 0.2,
    reverbSend: 0.26,
    sample: {
      url: "./audio/samples/aire-denso.ogg",
      gain: 0.11,
      filterHz: 1200,
      filterQ: 0.7,
    },
  },
  co2: {
    detuneCents: 6,
    subOctave: -12,
    subGain: 0.2,
    chorusSend: 0.2,
    reverbSend: 0.3,
    sample: {
      url: "./audio/samples/aire-largo.ogg",
      gain: 0.09,
      filterHz: 850,
      filterQ: 0.8,
    },
  },
  lightning: {
    detuneCents: 12,
    subOctave: 0,
    subGain: 0,
    chorusSend: 0.08,
    reverbSend: 0.16,
  },
};

/** One sampled screen cell: where it is on screen and where it is on the globe. */
export interface VisibleCell {
  lon: number;
  lat: number;
  /** Fraction across the canvas, 0 (left) .. 1 (right). */
  screenX: number;
  /** Fraction down the canvas, 0 (top) .. 1 (bottom). */
  screenY: number;
}

export interface VisibleColumn {
  screenX: number;
  /** One entry per row; null where that screen row misses the globe. */
  cells: (VisibleCell | null)[];
}

export type VisibleField = VisibleColumn[];

/** One sounding row of a visible column. */
export interface OverviewCell {
  pitchHz: number;
  gain: number;
}

export interface OverviewColumn {
  pan: number;
  cells: OverviewCell[];
}

/**
 * Pitch of a normalized 0..1 value on an overview scale. `octaves` controls
 * how many octaves the 0..1 range spans (the overview uses two, the regional
 * point uses one).
 */
export function pitchForValue(
  value: number,
  scale: readonly number[] = MAJOR_PENTATONIC_SEMITONES,
  octave = 0,
  octaves = 2,
): number {
  const notes = scale.length > 0 ? scale : MAJOR_PENTATONIC_SEMITONES;
  const steps = Math.max(1, Math.round(notes.length * octaves));
  const step = Math.round(clampUnit(value) * steps);
  const note = notes[step % notes.length] ?? 0;
  const scaleOctave = Math.floor(step / notes.length);
  return OVERVIEW_BASE_HZ * 2 ** ((scaleOctave * 12 + note) / 12 + octave);
}

/** Pitch of an absolute latitude on an overview scale: poles low, equator high. */
export function overviewPitchHz(
  latitude: number,
  scale: readonly number[] = MAJOR_PENTATONIC_SEMITONES,
  octave = 0,
): number {
  return pitchForValue(Math.abs(latitude) / 90, scale, octave, 2);
}

/**
 * Value 0..1 to a row gain with a quadratic curve, so low values stay quiet and
 * the higher end of the layer has useful level control. `threshold` is relative
 * to the visible field: values below it are silent. Null, NaN and non-positive
 * values are always silent.
 */
export function overviewGain(value: number | null, threshold = 0): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  const amount = clampUnit(value);
  if (amount < clampUnit(threshold)) return 0;
  return amount ** 2;
}

/** Lowest and highest valid values in the visible field, or null when empty. */
export interface VisibleRange {
  min: number;
  max: number;
}

/** Lowest and highest valid values in the visible field, or null when empty. */
export function visibleValueRange(
  field: VisibleField,
  sample: (lon: number, lat: number) => number | null,
): VisibleRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const column of field) {
    for (const cell of column.cells) {
      if (!cell) continue;
      const value = sample(cell.lon, cell.lat);
      if (value === null || !Number.isFinite(value)) continue;
      min = Math.min(min, clampUnit(value));
      max = Math.max(max, clampUnit(value));
    }
  }
  return min <= max ? { min, max } : null;
}

/** Average of the valid cells in the visible field; 0 when nothing is visible. */
export function visibleAverage(values: readonly (number | null)[]): number {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    sum += clampUnit(value);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Turn the visible screen field into sounding columns. `sample` reads the active
 * layer at a place; it returns null where the layer has no data.
 */
export function buildOverviewColumns(
  field: VisibleField,
  sample: (lon: number, lat: number) => number | null,
  scale: readonly number[] = MAJOR_PENTATONIC_SEMITONES,
): OverviewColumn[] {
  const values = field.map((column) =>
    column.cells.map((cell) => {
      if (!cell) return null;
      const value = sample(cell.lon, cell.lat);
      return value === null || !Number.isFinite(value)
        ? null
        : clampUnit(value);
    }),
  );
  const threshold = visibleAverage(values.flat()) * OVERVIEW_TRIGGER_RATIO;

  return field.map((column, columnIndex) => ({
    pan: positionToPan(column.screenX),
    cells: column.cells.map((cell, rowIndex) => {
      const value = values[columnIndex]?.[rowIndex] ?? null;
      return {
        pitchHz: cell ? overviewPitchHz(cell.lat, scale) : OVERVIEW_BASE_HZ,
        gain: overviewGain(value, threshold),
      };
    }),
  }));
}
