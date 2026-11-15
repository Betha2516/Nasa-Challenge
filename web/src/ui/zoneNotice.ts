// When to show the "zone in progress" notice: only the Amazon has zones of
// interest so far, so the notice names any other region once the zoom into it
// has finished.

import type { ViewMode } from "../scene/FocusTransition";
import { AMAZON_REGION_ID } from "../scene/regions";

/** Region the notice names, or null when no notice should be shown. */
export function zoneNoticeRegion(mode: ViewMode, focusRegionId: string): string | null {
  return mode === "map" && focusRegionId !== AMAZON_REGION_ID ? focusRegionId : null;
}
