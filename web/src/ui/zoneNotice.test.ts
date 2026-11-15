import { describe, expect, it } from "vitest";
import { AMAZON_REGION_ID } from "../scene/regions";
import { zoneNoticeRegion } from "./zoneNotice";

describe("zoneNoticeRegion", () => {
  it("names a region other than the Amazon once its map is shown", () => {
    expect(zoneNoticeRegion("map", "central-africa")).toBe("central-africa");
  });

  it("shows nothing on the Amazon map, which has zones of interest", () => {
    expect(zoneNoticeRegion("map", AMAZON_REGION_ID)).toBeNull();
  });

  it("shows nothing while flying or on the planet", () => {
    expect(zoneNoticeRegion("to-map", "central-africa")).toBeNull();
    expect(zoneNoticeRegion("to-globe", "central-africa")).toBeNull();
    expect(zoneNoticeRegion("globe", "central-africa")).toBeNull();
  });
});
