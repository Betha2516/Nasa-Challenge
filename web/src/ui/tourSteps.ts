// Content of the welcome window and the guided tour (driver.js), kept free of
// the library so it can be tested in Node. tour.ts turns it into a driver.
//
// Each step points at a control by its data-testid, so the tour follows the
// controls if they move and simply skips one that is not on screen.

/** One window of the tour. Without `testId` it is centred on the screen. */
export interface TourStep {
  testId?: string;
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

/** Where the tour remembers that this browser has already seen it. */
export const TOUR_SEEN_KEY = "earth-jukebox:tour-seen";

/** data-testid of the "?" button that shows the tour again. */
export const TOUR_BUTTON_TEST_ID = "planet-hud-tour-button";

export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: "Welcome to Earth Jukebox",
    description:
      "Listen to NASA Earth data about the Amazon, the lungs of the world. Every layer has its own voice: move over the planet and hear how it changes from place to place.",
  },
  {
    testId: "audio-controls",
    title: "Start the sound",
    description: "Browsers keep sound off until you ask. Press Start sound; the bar shows how loud the output is.",
    side: "left",
    align: "end",
  },
  {
    testId: "planet-hud-layer-select",
    title: "Choose what you hear",
    description:
      "Pick a layer: it is drawn on the planet and it is the only one you hear. Earth (no layer) is silent.",
    side: "right",
    align: "start",
  },
  {
    testId: "planet-canvas",
    title: "Explore the planet",
    description:
      "The overview plays the visible planet all at once: low notes near the poles, high notes near the equator. Drag to turn it; double-click a region to fly there.",
  },
  {
    testId: "planet-hud-amazon-button",
    title: "Fly to a region",
    description:
      "The world is divided into regions, with the Amazon on its own. Double-click (or tap twice) one, or press Amazon, to open its map; double-click the map or press Back to Earth to return.",
    side: "left",
    align: "end",
  },
  {
    testId: TOUR_BUTTON_TEST_ID,
    title: "See this again",
    description: "Press ? at any time to repeat this tour.",
    side: "bottom",
    align: "start",
  },
];

/** The CSS selector of a step's control, or undefined for a centred window. */
export function stepSelector(step: TourStep): string | undefined {
  return step.testId ? `[data-testid="${step.testId}"]` : undefined;
}

/** Minimal storage, so tests can pass a fake and private windows can pass null. */
export interface FlagStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** True when this browser already saw the tour. Unreadable storage counts as not seen. */
export function hasSeenTour(store: FlagStore | null): boolean {
  if (!store) return false;
  try {
    return store.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers that the tour was seen; does nothing when storage is unavailable. */
export function markTourSeen(store: FlagStore | null): void {
  if (!store) return;
  try {
    store.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    // Private window or blocked storage: the tour will simply show again next time.
  }
}

/** window.localStorage, or null where reading it throws (blocked site data). */
export function browserFlagStore(): FlagStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
