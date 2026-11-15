// Minimal controls over the 3D view until the side panel of plan Step 13:
// "Amazon" and "Back to Earth" (FR2.1, FR2.2), a temporary active-layer picker
// (FR1.4) whose layer is also the only one that sounds, the "Auto-rotate"
// switch that starts and stops the planet's own turn, the "?"
// button that repeats the guided tour, the longitude/latitude/value indicator
// (FR4.4) and a frames-per-second counter (NFR1).
//
// Responsive: on a phone (below Tailwind's `sm`, 640 px) the panels stack and
// take the full width, with smaller margins and the safe areas of notched
// screens kept clear; from `sm` up the layout is the original one.

import type { ReactNode } from "react";
import type { LoadedLayer } from "../data/types";
import type { ViewMode } from "../scene/FocusTransition";
import type { Probe } from "../scene/EarthScene";
import { useListeningPoint } from "../scene/listeningPoint";
import { layerChoices, layerForChoice } from "./layerChoice";
import { TOUR_BUTTON_TEST_ID } from "./tourSteps";

export interface PlanetHudProps {
  layers: LoadedLayer[];
  activeLayerId: string;
  onSelectLayer: (layerId: string) => void;
  /** Whether the planet turns by itself on the planet view (the "Auto-rotate" switch). */
  autoRotate: boolean;
  onToggleAutoRotate: (on: boolean) => void;
  mode: ViewMode;
  onAmazon: () => void;
  onBackToEarth: () => void;
  /** Name of the region the map view visits (or is flying to). */
  regionName?: string;
  /** Name of the region under the cursor, or null. */
  hoveredRegionName?: string | null;
  probe: Probe | null;
  fps: number | null;
  lite: boolean;
  sceneError: string | null;
  /** Value of the active layer at the selected point, or null when there is no data there. */
  selectedValue?: number | null;
  /** Sound controls, docked in the bottom-right panel so they never overlap the HUD. */
  audio?: ReactNode;
  /** Timeline line under the planet, between the two bottom panels (its own row on narrow screens). */
  timeline?: ReactNode;
  /** Shows the welcome window and guided tour again (the "?" button). */
  onShowTour?: () => void;
}

/** Below this the NFR1 target (30 frames per second) is missed. */
const FPS_TARGET = 30;

function formatLongitude(lon: number): string {
  if (Math.abs(lon) < 0.05) return "0.0°";
  return `${Math.abs(lon).toFixed(1)}° ${lon < 0 ? "W" : "E"}`;
}

function formatLatitude(lat: number): string {
  if (Math.abs(lat) < 0.05) return "0.0°";
  return `${Math.abs(lat).toFixed(1)}° ${lat < 0 ? "S" : "N"}`;
}

export function modeLabel(mode: ViewMode, regionName = "Amazon", hoveredRegionName: string | null = null): string {
  switch (mode) {
    case "globe":
      return hoveredRegionName
        ? `${hoveredRegionName}: double-click (or tap again) to fly there.`
        : "Overview of the visible planet. Drag to turn it; double-click a region to fly there.";
    case "to-map":
      return `Flying to ${regionName}…`;
    case "map":
      return `${regionName} map. Click a point to lock its sound; drag to move it; double-click to return.`;
    case "to-globe":
      return "Back to the planet…";
  }
}

const panel =
  "pointer-events-auto rounded-lg bg-slate-950/75 p-2 text-sm shadow-lg backdrop-blur sm:p-3";
const button =
  "rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400";

export function PlanetHud(props: PlanetHudProps) {
  const {
    layers,
    activeLayerId,
    onSelectLayer,
    autoRotate,
    onToggleAutoRotate,
    mode,
    onAmazon,
    onBackToEarth,
    regionName,
    hoveredRegionName,
    probe,
    fps,
    lite,
    sceneError,
    selectedValue = null,
    audio,
    timeline,
    onShowTour,
  } = props;
  // null on the plain Earth view.
  const activeLayer = layerForChoice(layers, activeLayerId);
  const selectedPoint = useListeningPoint();

  return (
    <div
      data-testid="planet-hud"
      className="hud-safe pointer-events-none absolute inset-0 flex flex-col justify-between gap-2"
    >
      <div className="flex items-start justify-between gap-2 sm:gap-4">
        <div className={`${panel} min-w-0`}>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-lg font-semibold sm:text-xl">Earth Jukebox</h1>
            {onShowTour && (
              <button
                type="button"
                data-testid={TOUR_BUTTON_TEST_ID}
                className="rounded-md border border-slate-500 px-2 py-0.5 font-medium text-slate-100 hover:border-slate-300"
                aria-label="Show the guided tour"
                title="Show the guided tour"
                onClick={onShowTour}
              >
                ?
              </button>
            )}
          </div>
          <label className="mt-2 flex min-w-0 items-center gap-2">
            <span className="text-slate-300">Layer</span>
            <select
              data-testid="planet-hud-layer-select"
              className="min-w-0 max-w-full rounded bg-slate-800 px-2 py-1"
              value={activeLayerId}
              onChange={(event) => onSelectLayer(event.target.value)}
            >
              {layerChoices(layers).map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-2 flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              data-testid="planet-hud-auto-rotate"
              className="h-4 w-4 cursor-pointer accent-emerald-600 [color-scheme:dark]"
              checked={autoRotate}
              onChange={(event) => onToggleAutoRotate(event.target.checked)}
            />
            <span className={autoRotate ? "text-slate-300" : "text-slate-400"}>
              Auto-rotate
            </span>
          </label>
        </div>

        <p
          data-testid="planet-hud-fps"
          className={`${panel} shrink-0 font-mono ${fps !== null && fps < FPS_TARGET ? "text-red-300" : "text-emerald-300"}`}
          title="Average frames per second over the last second (target: 30 or more)"
        >
          {fps === null ? "-- fps" : `${fps} fps`}
          {lite ? " · lite" : ""}
        </p>
      </div>

      {sceneError && (
        <p
          role="alert"
          data-testid="planet-hud-error"
          className={`${panel} self-center border border-amber-400 text-amber-100`}
        >
          {sceneError}
        </p>
      )}

      {/* Three columns on wide screens: the two side columns share the space
          equally, so the timeline in the middle sits centred under the planet.
          On narrow screens the panels stack and the timeline goes last. */}
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div
          data-testid="planet-hud-probe"
          className={`${panel} font-mono text-slate-400 sm:min-w-56 lg:justify-self-start`}
          aria-live="off"
        >
          <p className="text-slate-400">Hover</p>
          {probe ? (
            <>
              <p>
                <span data-testid="planet-hud-probe-lon">
                  {formatLongitude(probe.lon)}
                </span>
                {", "}
                <span data-testid="planet-hud-probe-lat">
                  {formatLatitude(probe.lat)}
                </span>
              </p>
              {activeLayer && (
                <p data-testid="planet-hud-probe-value">
                  {activeLayer.manifest.title}:{" "}
                  {probe.value === null
                    ? "no data here"
                    : `${Math.round(probe.value * 100)} %`}
                </p>
              )}
            </>
          ) : (
            <p className="text-slate-400">—</p>
          )}
          {(mode === "map" || mode === "to-map") && (
            <div className="mt-2 text-slate-100" data-testid="planet-hud-selected-coords">
              <p>Selected</p>
              {selectedPoint ? (
                <>
                  <p>{`${formatLongitude(selectedPoint.lon)}, ${formatLatitude(selectedPoint.lat)}`}</p>
                  {activeLayer && (
                    <p data-testid="planet-hud-selected-value">
                      {activeLayer.manifest.title}:{" "}
                      {selectedValue === null
                        ? "no data here"
                        : `${Math.round(selectedValue * 100)} %`}
                    </p>
                  )}
                </>
              ) : (
                <p>click the map</p>
              )}
            </div>
          )}
        </div>

        {timeline && (
          <div data-testid="planet-hud-timeline" className="order-last w-full lg:order-none lg:w-[28rem] xl:w-[40rem]">
            {timeline}
          </div>
        )}

        <div className={`${panel} flex flex-col items-stretch gap-2 sm:items-end lg:col-start-3 lg:max-w-sm lg:justify-self-end`}>
          {audio && <div className="w-full">{audio}</div>}
          <p
            role="status"
            data-testid="planet-hud-status"
            className="text-right text-slate-300 max-sm:sr-only [@media(max-height:480px)]:sr-only"
          >
            {modeLabel(mode, regionName, hoveredRegionName)}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="planet-hud-amazon-button"
              className={`${button} max-sm:flex-1`}
              disabled={mode !== "globe"}
              onClick={onAmazon}
            >
              Amazon
            </button>
            <button
              type="button"
              data-testid="planet-hud-back-button"
              className={`${button} max-sm:flex-1`}
              disabled={mode !== "map"}
              onClick={onBackToEarth}
            >
              Back to Earth
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
