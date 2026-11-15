import { describe, expect, it } from "vitest";
import { createSoundEngine } from "./engine";
import { OVERVIEW_COLUMNS, OVERVIEW_ROWS } from "./overview";
import type { OverviewColumn } from "./overview";
import { FakeAudioContext, type FakeParam } from "./testing/fakeAudioContext";

function scheduled(parameter: FakeParam): number {
  parameter.scheduledTarget ??= parameter.value;
  return parameter.scheduledTarget;
}

function columns(): OverviewColumn[] {
  return Array.from({ length: OVERVIEW_COLUMNS }, (_, column) => ({
    pan: column === 0 ? -0.8 : column === OVERVIEW_COLUMNS - 1 ? 0.8 : 0,
    cells: Array.from({ length: OVERVIEW_ROWS }, (_, row) => ({ pitchHz: 110 * (row + 1), gain: 0.5 + column * 0.01 })),
  }));
}

describe("overview sound engine", () => {
  it("builds one panned column per screen column, all sounding at once", async () => {
    const context = new FakeAudioContext();
    const engine = createSoundEngine({ context: context.asAudioContext(), lightningSampleUrl: null });
    await engine.start();
    engine.setOverview("smoke", columns());
    engine.setOverviewEnabled(true);

    // 6 point-mode oscillators + 12 columns x 12 rows.
    expect(context.oscillators).toHaveLength(6 + OVERVIEW_COLUMNS * OVERVIEW_ROWS);
    expect(context.panners).toHaveLength(4 + OVERVIEW_COLUMNS);
    expect(context.oscillators[6]!.type).toBe("sawtooth");
    expect(scheduled(context.panners[4]!.pan)).toBeLessThan(0);
    expect(scheduled(context.panners.at(-1)!.pan)).toBeGreaterThan(0);
    engine.dispose();
  });

  it("keeps every column sounding without a scan timer", async () => {
    const context = new FakeAudioContext();
    const engine = createSoundEngine({ context: context.asAudioContext(), lightningSampleUrl: null });
    engine.setOverview("forest", columns());
    engine.setOverviewEnabled(true);
    await engine.start();

    expect(context.oscillators).toHaveLength(6 + OVERVIEW_COLUMNS * OVERVIEW_ROWS);
    expect(context.filters).toHaveLength(3 + OVERVIEW_COLUMNS);
    const firstOverviewFilter = context.filters[3]!;
    const overviewRowGains = context.gains.filter((gain) => gain.connections.includes(firstOverviewFilter));
    expect(overviewRowGains.some((gain) => scheduled(gain.gain) > 0)).toBe(true);
    engine.dispose();
  });

  it("fades the field out when disabled", async () => {
    const context = new FakeAudioContext();
    const engine = createSoundEngine({ context: context.asAudioContext(), lightningSampleUrl: null });
    await engine.start();
    engine.setOverview("co2", columns());
    engine.setOverviewEnabled(true);
    engine.setOverviewEnabled(false);
    const overviewBus = context.gains.find((gain) =>
      gain.gain.events.some((event) => event.method === "setTargetAtTime" && event.target === 0),
    );
    expect(overviewBus).toBeDefined();
    engine.dispose();
  });
});
