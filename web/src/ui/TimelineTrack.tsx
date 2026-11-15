// The timeline line under the planet. One mark per instant of the picked layer,
// placed by its real time (an hour of smoke, a month of lightning), with the day
// or year written under the marks that start one. The playhead shows the instant
// on screen and heard; it moves by itself at the pace of the planet's turn and
// keeps going on the map view, during a drag and with Auto-rotate off. Only the
// pause button stops it.
//
// The person can drag along the line or click it to pick a moment; the planet
// keeps turning and the timeline goes on from there. Arrow keys move one instant,
// Page Up / Page Down one turn (a day or a year), Home / End to the ends.
//
// Speed buttons (4x and 8x, starting at 4x) make each turn cover more real time; the planet keeps
// its pace, and the header says how much one turn covers ("1 turn = 4 days").
//
// A static layer (forest) shows the same line dimmed, with its one period.
// It only shows and changes the shared clock of TimelineProvider; it owns no clock.

import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { LoadedLayer } from "../data/types";
import { dateLabelAt, frameIndexAt } from "../lib/timeline";
import {
  cadenceText,
  fractionAtPosition,
  framesPerTurn,
  positionAtFraction,
  positionOfFrame,
  timelineTicks,
  turnText,
  TIMELINE_SPEEDS,
} from "../lib/timelineTrack";
import { isTimed, trackValueText } from "./timelineFormat";

export interface TimelineTrackProps {
  /** The picked layer; a static one draws the dimmed line. */
  layer: LoadedLayer;
  position: number;
  /** True while the timeline plays; only the person pauses it. */
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (position: number) => void;
  /** Timeline speed: how many times the normal real time one turn covers. */
  speed: number;
  onSpeed: (speed: number) => void;
  className?: string;
}

const panel = "pointer-events-auto rounded bg-slate-950/70 px-4 py-2 text-sm text-slate-100 backdrop-blur-sm";

export function TimelineTrack(props: TimelineTrackProps) {
  const { layer, position, playing, onTogglePlay, onSeek, speed, onSpeed, className = "" } = props;
  const { manifest } = layer;
  const timed = isTimed(layer);
  const frames = manifest.dates.length;
  const ticks = useMemo(() => (timed ? timelineTicks(manifest) : []), [manifest, timed]);
  const lineRef = useRef<HTMLDivElement>(null);
  const date = dateLabelAt(manifest, position);
  const head = timed ? fractionAtPosition(manifest, position) : 0;

  const seekAt = (clientX: number): void => {
    const line = lineRef.current;
    if (!line) return;
    const box = line.getBoundingClientRect();
    if (box.width <= 0) return;
    onSeek(positionAtFraction(manifest, (clientX - box.left) / box.width));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!timed) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekAt(event.clientX);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (timed && event.currentTarget.hasPointerCapture(event.pointerId)) seekAt(event.clientX);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!timed) return;
    const frame = frameIndexAt(position, frames);
    const turn = Math.max(1, Math.round(framesPerTurn(manifest.cadence, frames)));
    const targets: Record<string, number> = {
      ArrowLeft: frame - 1,
      ArrowDown: frame - 1,
      ArrowRight: frame + 1,
      ArrowUp: frame + 1,
      PageDown: frame - turn,
      PageUp: frame + turn,
      Home: 0,
      End: frames - 1,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    onSeek(positionOfFrame(Math.min(frames - 1, Math.max(0, target)), frames));
  };

  return (
    <div data-testid="timeline-track" className={`${panel} flex flex-col gap-1 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="text-slate-300">
          {manifest.title}
          {timed && manifest.cadence && <span className="text-slate-400"> · {cadenceText(manifest.cadence)}</span>}
        </span>
        <span data-testid={`timeline-date-${manifest.id}`} className="font-mono text-slate-100">
          {date}
        </span>
        {timed ? (
          <button
            type="button"
            data-testid="timeline-play"
            aria-pressed={!playing}
            aria-label={playing ? "Pause the timeline" : "Play the timeline"}
            className="rounded bg-slate-800 px-2 py-0.5 text-slate-300 hover:bg-slate-700"
            onClick={onTogglePlay}
          >
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
        ) : (
          <span data-testid="timeline-playing" className="text-slate-400">
            fixed layer
          </span>
        )}
      </div>

      {timed && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div role="group" aria-label="Timeline speed" className="flex gap-1">
            {TIMELINE_SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                data-testid={`timeline-speed-${value}`}
                aria-pressed={speed === value}
                className={`rounded px-2 py-0.5 font-mono ${
                  speed === value ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
                onClick={() => onSpeed(value)}
              >
                {value}×
              </button>
            ))}
          </div>
          {manifest.cadence && (
            <span data-testid="timeline-turn" className="text-slate-400">
              1 turn = {turnText(manifest.cadence, speed)}
            </span>
          )}
        </div>
      )}

      <div
        ref={lineRef}
        data-testid="timeline-scrub"
        role="slider"
        tabIndex={timed ? 0 : -1}
        aria-label={`${manifest.title} timeline`}
        aria-disabled={!timed}
        aria-valuemin={1}
        aria-valuemax={Math.max(1, frames)}
        aria-valuenow={timed ? frameIndexAt(position, frames) + 1 : 1}
        aria-valuetext={trackValueText(layer, position)}
        className={`relative h-9 select-none rounded outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
          timed ? "cursor-pointer touch-none" : "opacity-50"
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
      >
        <div className="absolute inset-x-0 top-3 h-px bg-slate-500" />
        {timed ? (
          <>
            <div className="absolute left-0 top-[11px] h-[3px] rounded bg-emerald-600/70" style={{ width: `${head * 100}%` }} />
            {ticks.map((tick, index) => (
              <div
                key={index}
                className={`absolute w-px ${tick.major ? "top-1 h-4 bg-slate-300" : "top-2 h-2 bg-slate-500/70"}`}
                style={{ left: `${tick.fraction * 100}%` }}
              />
            ))}
            {ticks.map((tick, index) =>
              tick.major ? (
                <span
                  key={`label-${index}`}
                  className={`absolute top-5 whitespace-nowrap text-[10px] text-slate-400 ${
                    tick.fraction > 0.97 ? "-translate-x-full" : ""
                  }`}
                  style={{ left: `${tick.fraction * 100}%` }}
                >
                  {tick.label}
                </span>
              ) : null,
            )}
            <div
              className="absolute top-0.5 h-5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-400 shadow"
              style={{ left: `${head * 100}%` }}
            />
          </>
        ) : (
          <>
            <div className="absolute inset-x-0 top-2 h-2 rounded bg-slate-500/60" />
            <span className="absolute inset-x-0 top-5 text-center text-[10px] text-slate-400">{manifest.dates[0]}</span>
          </>
        )}
      </div>
    </div>
  );
}
