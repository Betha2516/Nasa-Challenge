import { afterEach, describe, expect, it, vi } from "vitest";
import { createSoundEngine } from "./engine";
import { OVERVIEW_INSTRUMENTS, pitchForValue } from "./overview";
import { positionToPan } from "./mapping";
import { FakeAudioContext, type FakeParam } from "./testing/fakeAudioContext";

function scheduled(parameter: FakeParam): number {
  parameter.scheduledTarget ??= parameter.value;
  return parameter.scheduledTarget;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("regional point instrument", () => {
  it("uses the overview instrument, value -> pitch and screen x -> pan", async () => {
    const context = new FakeAudioContext();
    const engine = createSoundEngine({ context: context.asAudioContext(), lightningSampleUrl: null });
    await engine.start();
    expect(context.oscillators).toHaveLength(6);

    engine.setRegionalPoint("co2", 0.5, 0.2);
    // Base voices + three regional oscillators + the chorus LFO.
    expect(context.oscillators).toHaveLength(10);
    const oscillator = context.oscillators[6]!;
    const instrument = OVERVIEW_INSTRUMENTS.co2;
    const expectedPitch =
      pitchForValue(0.5, instrument.scale, 0, 1) *
      2 ** (instrument.detuneCents / 1200) *
      2 ** instrument.octave;
    expect(oscillator.type).toBe("sawtooth");
    expect(scheduled(oscillator.frequency)).toBeCloseTo(expectedPitch, 5);
    const regionalPanner = context.panners[4]!;
    const regionalGain = context.gains.find((gain) => gain.connections.includes(regionalPanner))!;
    expect(scheduled(regionalPanner.pan)).toBeCloseTo(positionToPan(0.2), 6);
    expect(regionalGain.gain.scheduledTarget ?? 0).toBeGreaterThan(0);

    engine.setRegionalPoint(null, null, 0);
    expect(scheduled(regionalGain.gain)).toBe(0);
    engine.dispose();
  });

  it("normalises the visible value range across one octave of the layer scale", async () => {
    const context = new FakeAudioContext();
    const engine = createSoundEngine({ context: context.asAudioContext(), lightningSampleUrl: null });
    await engine.start();

    engine.setRegionalPoint("forest", 0.4, 0.5, { min: 0.4, max: 0.6 });
    const oscillator = context.oscillators[6]!;
    expect(scheduled(oscillator.frequency)).toBeCloseTo(
      pitchForValue(0, OVERVIEW_INSTRUMENTS.forest.scale, 0, 1),
      5,
    );

    engine.setRegionalPoint("forest", 0.6, 0.5, { min: 0.4, max: 0.6 });
    expect(scheduled(oscillator.frequency)).toBeCloseTo(
      pitchForValue(1, OVERVIEW_INSTRUMENTS.forest.scale, 0, 1),
      5,
    );

    engine.setRegionalPoint("forest", 0.5, 0.5, { min: 0.4, max: 0.6 });
    expect(scheduled(oscillator.frequency)).toBeCloseTo(
      pitchForValue(0.5, OVERVIEW_INSTRUMENTS.forest.scale, 0, 1),
      5,
    );
    engine.dispose();
  });

  it("retriggers lightning at the lowest note and 90 bpm for value 0", async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const engine = createSoundEngine({ context: context.asAudioContext(), lightningSampleUrl: null });
    await engine.start();
    expect(context.oscillators).toHaveLength(6);

    engine.setRegionalPoint("lightning", 0, 0.5);
    expect(context.oscillators).toHaveLength(7);
    vi.advanceTimersByTime(600);
    expect(context.oscillators).toHaveLength(7);
    vi.advanceTimersByTime(100);
    expect(context.oscillators).toHaveLength(8);

    engine.setRegionalPoint("lightning", null, 0.5);
    vi.advanceTimersByTime(2000);
    expect(context.oscillators).toHaveLength(8);
    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the regional note that arrived before start", async () => {
    const context = new FakeAudioContext();
    const engine = createSoundEngine({ context: context.asAudioContext(), lightningSampleUrl: null });
    engine.setRegionalPoint("forest", 0.8, 0.8);
    await engine.start();
    // Base voices + three regional oscillators + the chorus LFO.
    expect(context.oscillators).toHaveLength(10);
    expect(context.oscillators[6]!.type).toBe("triangle");
    engine.dispose();
  });
});
