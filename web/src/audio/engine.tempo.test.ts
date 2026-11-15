import { describe, expect, it } from "vitest";
import { createSoundEngine } from "./engine";
import { FakeAudioContext } from "./testing/fakeAudioContext";

describe("tempo marks", () => {
  it("does not play a tempo mark when no layer is configured", async () => {
    const context = new FakeAudioContext();
    const engine = createSoundEngine({ context: context.asAudioContext(), lightningSampleUrl: null });
    await engine.start();
    expect(context.oscillators).toHaveLength(6);

    engine.playTempoBeat("lightning");
    engine.playTempoBeat("smoke");
    engine.playTempoBeat("co2");
    engine.playTempoBeat("forest");
    expect(context.oscillators).toHaveLength(6);
    engine.dispose();
  });
});
