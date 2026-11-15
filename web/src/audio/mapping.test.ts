import { describe, expect, it } from "vitest";
import {
  BREATH_FAST_HZ,
  BREATH_SLOW_HZ,
  FOREST_BASE_HZ,
  MIN_ACTIVE_GAIN,
  MAJOR_PENTATONIC_SEMITONES,
  SMOKE_FILTER_CLOSED_HZ,
  SMOKE_FILTER_OPEN_HZ,
  co2ToBreath,
  forestToVoice,
  intensityToGain,
  lightningToPercussion,
  positionToPan,
  smokeToTimbre,
} from "./mapping";

/** Semitones above the base note, folded into one octave (0..12). */
function pitchClass(frequency: number): number {
  const semitones = 12 * Math.log2(frequency / FOREST_BASE_HZ);
  return ((semitones % 12) + 12) % 12;
}

function isOnScale(frequency: number): boolean {
  const pitch = pitchClass(frequency);
  return MAJOR_PENTATONIC_SEMITONES.some(
    (note) =>
      Math.abs(pitch - note) < 1e-6 || Math.abs(pitch - 12 - note) < 1e-6,
  );
}

describe("mapping", () => {
  it("always places the forest note and its harmony on the five-note scale", () => {
    let previous = 0;
    for (let index = 0; index <= 100; index += 1) {
      const voice = forestToVoice(index / 100);
      expect(isOnScale(voice.frequency), `note for value ${index / 100}`).toBe(
        true,
      );
      expect(
        isOnScale(voice.harmonyFrequency),
        `harmony for value ${index / 100}`,
      ).toBe(true);
      // Taller forest never sounds lower.
      expect(voice.frequency).toBeGreaterThanOrEqual(previous);
      previous = voice.frequency;
    }
    expect(forestToVoice(0).frequency).toBeCloseTo(FOREST_BASE_HZ, 6);
    expect(forestToVoice(1).frequency).toBeCloseTo(FOREST_BASE_HZ * 4, 6); // two octaves up
  });

  it("makes breathing faster and heavier as CO2 rises, and smoke rougher and darker", () => {
    const calm = co2ToBreath(0.1);
    const laboured = co2ToBreath(0.9);
    expect(laboured.rateHz).toBeGreaterThan(calm.rateHz);
    expect(laboured.depth).toBeGreaterThan(calm.depth);
    expect(co2ToBreath(0).rateHz).toBeCloseTo(BREATH_SLOW_HZ, 6);
    expect(co2ToBreath(1).rateHz).toBeCloseTo(BREATH_FAST_HZ, 6);

    const clear = smokeToTimbre(0.1);
    const smoky = smokeToTimbre(0.9);
    expect(smoky.roughness).toBeGreaterThan(clear.roughness);
    expect(smoky.filterCutoffHz).toBeLessThan(clear.filterCutoffHz);
    expect(smokeToTimbre(0).filterCutoffHz).toBeCloseTo(
      SMOKE_FILTER_OPEN_HZ,
      6,
    );
    expect(smokeToTimbre(1).filterCutoffHz).toBeCloseTo(
      SMOKE_FILTER_CLOSED_HZ,
      6,
    );
  });

  it("limits values outside 0..1 instead of producing wild sounds", () => {
    expect(forestToVoice(-4)).toEqual(forestToVoice(0));
    expect(forestToVoice(9)).toEqual(forestToVoice(1));
    expect(forestToVoice(Number.NaN)).toEqual(forestToVoice(0));
    expect(co2ToBreath(-1)).toEqual(co2ToBreath(0));
    expect(co2ToBreath(3)).toEqual(co2ToBreath(1));
    expect(smokeToTimbre(-1)).toEqual(smokeToTimbre(0));
    expect(smokeToTimbre(3)).toEqual(smokeToTimbre(1));

    // Pan stays inside the stereo field; the centre of the view is the centre of the sound.
    expect(positionToPan(0.5)).toBeCloseTo(0, 6);
    expect(positionToPan(-2)).toBe(positionToPan(0));
    expect(positionToPan(5)).toBe(positionToPan(1));
    expect(positionToPan(0)).toBeLessThan(0);
    expect(Math.abs(positionToPan(1))).toBeLessThanOrEqual(1);

    // Volume: silent where there is no data, audible but never above 1 where there is.
    expect(intensityToGain(null)).toBe(0);
    expect(intensityToGain(0)).toBeCloseTo(MIN_ACTIVE_GAIN, 6);
    expect(intensityToGain(7)).toBe(1);
    expect(intensityToGain(0.8)).toBeGreaterThan(intensityToGain(0.2));
  });

  it("maps the lightning relative frequency to an exact percussion rate and pitch", () => {
    // 0 is silence; 0.5 is three hits per second; 1 is six.
    expect(lightningToPercussion(0).rateHz).toBe(0);
    expect(lightningToPercussion(0.5).rateHz).toBeCloseTo(3, 6);
    expect(lightningToPercussion(1).rateHz).toBeCloseTo(6, 6);

    // The body pitch rises linearly from 90 Hz to 330 Hz.
    expect(lightningToPercussion(0).pitchHz).toBeCloseTo(90, 6);
    expect(lightningToPercussion(0.5).pitchHz).toBeCloseTo(210, 6);
    expect(lightningToPercussion(1).pitchHz).toBeCloseTo(330, 6);

    // Out-of-range and non-finite input follows the usual clamp rules.
    expect(lightningToPercussion(-1)).toEqual(lightningToPercussion(0));
    expect(lightningToPercussion(9)).toEqual(lightningToPercussion(1));
    expect(lightningToPercussion(Number.NaN)).toEqual(lightningToPercussion(0));
  });
});
