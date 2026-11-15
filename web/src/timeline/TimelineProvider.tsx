// Shared timeline state for the app (FR7): one position that the audio, the
// scene and the timeline line under the planet read.
//
// Decisions recorded here (full rationale in docs/TIMELINE-HANDOFF.md):
// - Shared normalized position, loop forever.
// - In the app the timeline plays on its own clock at the planet's pace: it calls
//   `step` (about 30 times a second), scaled by `speed` (4x or 8x on the line),
//   and the person can `seek` on the line. The play/pause clock below stays for
//   the dev harness.
// - The provider owns no UI. Controls (TimelineTrack) call the actions.

import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { createPlayback, playbackReducer, type PlaybackState } from "../lib/playback";
import { DEFAULT_TIMELINE_SPEED } from "../lib/timelineTrack";

/** How often the provider publishes a new position while playing. */
export const TIMELINE_UPDATE_HZ = 30;

/** What changes the timeline. Stable for the life of the provider. */
export interface TimelineActions {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(position: number): void;
  /** Moves the position by `delta` (0..1 scale) times the speed, starting again after the end; the timeline clock calls it. */
  step(delta: number): void;
  setSpeed(speed: number): void;
  setLoop(loop: boolean): void;
  setDuration(durationSeconds: number): void;
}

export interface TimelineValue extends PlaybackState, TimelineActions {}

const TimelineContext = createContext<TimelineValue | null>(null);
// The actions alone: components that only change the timeline (the turning
// planet) read this one, so they are not re-rendered each time it moves.
const TimelineActionsContext = createContext<TimelineActions | null>(null);

export function TimelineProvider({ children }: { children: ReactNode }) {
  // The line offers 4x and 8x only, so the timeline starts at 4x.
  const [state, dispatch] = useReducer(playbackReducer, undefined, () =>
    createPlayback({ speed: DEFAULT_TIMELINE_SPEED }),
  );

  useEffect(() => {
    if (!state.playing) return;
    let frame = 0;
    let last = performance.now();
    let pending = 0;
    const intervalMs = 1000 / TIMELINE_UPDATE_HZ;

    const tick = (now: number): void => {
      // Cap the step so a backgrounded tab does not jump when it comes back.
      const delta = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      pending += delta;
      if (pending * 1000 >= intervalMs) {
        dispatch({ type: "advance", deltaSeconds: pending });
        pending = 0;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state.playing]);

  const actions = useMemo<TimelineActions>(
    () => ({
      play: () => dispatch({ type: "play" }),
      pause: () => dispatch({ type: "pause" }),
      toggle: () => dispatch({ type: "toggle" }),
      seek: (position: number) => dispatch({ type: "seek", position }),
      step: (delta: number) => dispatch({ type: "step", delta }),
      setSpeed: (speed: number) => dispatch({ type: "set-speed", speed }),
      setLoop: (loop: boolean) => dispatch({ type: "set-loop", loop }),
      setDuration: (durationSeconds: number) => dispatch({ type: "set-duration", durationSeconds }),
    }),
    [],
  );
  const value = useMemo<TimelineValue>(() => ({ ...state, ...actions }), [state, actions]);

  return (
    <TimelineActionsContext.Provider value={actions}>
      <TimelineContext.Provider value={value}>{children}</TimelineContext.Provider>
    </TimelineActionsContext.Provider>
  );
}

/** The timeline's actions only; never re-renders the caller when the position moves. */
export function useTimelineActions(): TimelineActions {
  const actions = useContext(TimelineActionsContext);
  if (!actions) {
    throw new Error("useTimelineActions must be used inside <TimelineProvider>.");
  }
  return actions;
}

/** Current timeline state and actions. Throws when used outside the provider. */
export function useTimeline(): TimelineValue {
  const value = useContext(TimelineContext);
  if (!value) {
    throw new Error("useTimeline must be used inside <TimelineProvider>.");
  }
  return value;
}
