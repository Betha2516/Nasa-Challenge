import { describe, expect, it } from "vitest";
import type { Grid, LayerManifest, LoadedLayer } from "../data/types";
import timelineTrackSource from "./TimelineTrack.tsx?raw";
import { EARTH_VIEW_ID } from "./layerChoice";
import { isTimed, trackLayer, trackValueText } from "./timelineFormat";

function layer(id: LayerManifest["id"], isStatic: boolean, dates: string[]): LoadedLayer {
  const grid: Grid = { width: 1, height: 1, frames: dates.length, data: new Uint8Array(dates.length) };
  const info = { width: 1, height: 1, frames: dates.length, file: "x.bin", texture: "x.png" };
  const manifest: LayerManifest = {
    id,
    title: id,
    description: "Test layer",
    source: { title: "Test", url: "https://example.com" },
    static: isStatic,
    sample: false,
    dates,
    global: info,
    region: info,
  };
  return { manifest, global: grid, region: grid };
}

describe("timeline line text", () => {
  const layers = [
    layer("forest", true, ["Apr 2019 - Jul 2025"]),
    layer("smoke", false, ["00:30", "01:30", "02:30"]),
    layer("lightning", false, ["Jan 2017", "Feb 2017"]),
  ];

  it("is for the picked layer, static or not, and absent on the plain Earth view", () => {
    expect(trackLayer(layers, "smoke")?.manifest.id).toBe("smoke");
    expect(trackLayer(layers, "lightning")?.manifest.id).toBe("lightning");
    expect(trackLayer(layers, "forest")?.manifest.id).toBe("forest");
    expect(trackLayer(layers, EARTH_VIEW_ID)).toBeNull();
    expect(trackLayer(layers, "unknown")).toBeNull();
  });

  it("counts only layers with more than one date as changing over time", () => {
    expect(isTimed(layers[1]!)).toBe(true);
    expect(isTimed(layers[0]!)).toBe(false);
    expect(isTimed(layer("smoke", false, ["only one"]))).toBe(false);
  });

  it("tells a screen reader the date and which instant it is", () => {
    expect(trackValueText(layers[1]!, 0.5)).toBe("01:30, instant 2 of 3");
    expect(trackValueText(layers[1]!, 1)).toBe("02:30, instant 3 of 3");
    expect(trackValueText(layers[0]!, 0.7)).toBe("Apr 2019 - Jul 2025, fixed layer");
  });

  it("keeps its test ids", () => {
    for (const id of ["timeline-track", "timeline-scrub", "timeline-playing", "timeline-turn"]) {
      expect(timelineTrackSource).toContain(`data-testid="${id}"`);
    }
    expect(timelineTrackSource).toContain("data-testid={`timeline-date-${manifest.id}`}");
    expect(timelineTrackSource).toContain("data-testid={`timeline-speed-${value}`}");
  });

  it("has a pause button, so only the person stops the timeline", () => {
    expect(timelineTrackSource).toContain(`data-testid="timeline-play"`);
    expect(timelineTrackSource).toContain("onClick={onTogglePlay}");
  });
});
