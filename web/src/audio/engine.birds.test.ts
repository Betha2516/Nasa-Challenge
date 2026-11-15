import { afterEach, describe, expect, it, vi } from "vitest";
import { createSoundEngine } from "./engine";
import { FakeAudioContext } from "./testing/fakeAudioContext";

afterEach(() => {
  vi.useRealTimers();
});

const BIRD_SAMPLE = { duration: 112.438 } as AudioBuffer;

describe("forest bird ambience", () => {
  it("spaces bird excerpts over the forest overview and stops them when disabled", async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const engine = createSoundEngine({
      context: context.asAudioContext(),
      birdSample: BIRD_SAMPLE,
      birdSampleUrl: null,
      lightningSampleUrl: null,
      random: () => 0,
    });

    engine.setForestBirds(true);
    await engine.start();
    await Promise.resolve();

    expect(context.bufferSources).toHaveLength(1); // shared noise only
    vi.advanceTimersByTime(1000);
    expect(context.bufferSources).toHaveLength(2);

    const bird = context.bufferSources.at(-1)!;
    expect(bird.buffer).toBe(BIRD_SAMPLE);
    expect(bird.start.mock.calls[0]?.[1]).toBeCloseTo(0, 6);
    expect(bird.start.mock.calls[0]?.[2]).toBeCloseTo(2, 6);
    expect(context.panners.length).toBe(5); // four point voices + one bird

    engine.setForestBirds(false);
    expect(bird.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not load or schedule birds outside the forest overview", async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const engine = createSoundEngine({
      context: context.asAudioContext(),
      birdSample: BIRD_SAMPLE,
      birdSampleUrl: null,
      lightningSampleUrl: null,
      random: () => 0,
    });
    await engine.start();
    expect(vi.getTimerCount()).toBe(0);
    engine.dispose();
  });
});
