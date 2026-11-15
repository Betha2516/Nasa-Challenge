import type { Driver } from "driver.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AudioStart } from "./audio/AudioStart";
import type { SoundEngine } from "./audio/engine";
import { useSoundEngine } from "./audio/useSoundEngine";
import { loadJukeboxData } from "./data/loadManifest";
import type { JukeboxData, LoadedLayer } from "./data/types";
import { sampleLayerAt } from "./lib/interpolate";
import { frameBlend, frameIndexAt, framePosition } from "./lib/timeline";
import { SpinAccumulator, positionPerTurn } from "./lib/timelineTrack";
import { EarthScene, type Probe, type TargetView } from "./scene/EarthScene";
import { loadScenes } from "./scenes/loadScenes";
import type { SceneDefinition, ScenesManifest } from "./scenes/types";
import type { ViewMode } from "./scene/FocusTransition";
import { AMAZON_REGION_ID, DEFAULT_REGIONS, loadWorldRegions, regionById, type Region } from "./scene/regions";
import {
  ListeningPointProvider,
  useListeningPoint,
} from "./scene/listeningPoint";
import { TIMELINE_UPDATE_HZ, TimelineProvider, useTimeline, useTimelineActions } from "./timeline/TimelineProvider";
import { PlanetHud } from "./ui/PlanetHud";
import { ScenePopup } from "./ui/ScenePopup";
import { ZoneInProgressPopup } from "./ui/ZoneInProgressPopup";
import { EARTH_VIEW_ID, layerForChoice } from "./ui/layerChoice";
import { layerVoices } from "./ui/soloLayer";
import { TimelineTrack } from "./ui/TimelineTrack";
import { startTour } from "./ui/tour";
import { browserFlagStore, hasSeenTour, markTourSeen } from "./ui/tourSteps";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: JukeboxData }
  | { status: "error"; message: string };

/** Data voices fade to this level while a scene popup is open, over 0.6 s. */
const SCENE_DATA_DUCK = 0.12;
const SCENE_DATA_FADE_SECONDS = 0.6;

/** Plan B switch: `?lite=1` in the address (half-resolution planet image, instant view changes). */
function readLiteMode(search: string): boolean {
  return new URLSearchParams(search).get("lite") === "1";
}

interface PlanetViewProps {
  data: JukeboxData;
  lite: boolean;
  audio?: ReactNode;
  /** The layer picker's value: a layer id or EARTH_VIEW_ID. */
  activeLayerId: string;
  onSelectLayer: (layerId: string) => void;
  onShowTour?: () => void;
  scenes?: ScenesManifest | null;
  onSceneSelect?: (scene: SceneDefinition) => void;
  onCloseScene?: () => void;
  focusedScene?: SceneDefinition | null;
}

/** The planet, the Amazon map and their controls, once the data is loaded. Starts on the plain Earth, with no layer drawn. */
function PlanetView({
  data,
  lite,
  audio,
  activeLayerId,
  onSelectLayer,
  onShowTour,
  scenes,
  onSceneSelect,
  onCloseScene,
  focusedScene,
}: PlanetViewProps) {
  // The pair of instants on screen and the nearest one, tagged with their layer so
  // a stale pair is never used for another. How far the picture is between the
  // two lives in a ref, read on every animation frame (no re-render).
  const [tracked, setTracked] = useState<TrackedFrames | null>(null);
  const positionRef = useRef(0);
  const frameMixRef = useRef(0);
  const [targetView, setTargetView] = useState<TargetView>("globe");
  const [mode, setMode] = useState<ViewMode>("globe");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [sceneHover, setSceneHover] = useState<{ scene: SceneDefinition; x: number; y: number } | null>(null);
  // The planet starts turning by itself; the "Auto-rotate" switch stops it.
  const [autoRotate, setAutoRotate] = useState(true);

  // null: the plain Earth view, no layer drawn.
  const activeLayer = useMemo(
    () => layerForChoice(data.layers, activeLayerId),
    [data, activeLayerId],
  );
  // Right after a layer change the tracker has not reported yet: read the position
  // it last mirrored, so the textures are built once, at the right instant.
  const layerFrames = activeLayer?.region.frames ?? 1;
  const frames: Omit<TrackedFrames, "layerId"> =
    activeLayer === null
      ? { from: 0, to: 0, nearest: 0 }
      : tracked?.layerId === activeLayer.manifest.id
        ? tracked
        : framesAt(positionRef.current, layerFrames, !lite);
  const frame = frames.nearest;
  // The timeline plays with the planet's own turn: one turn moves it by a day of
  // hourly data or a year of monthly data (positionPerTurn). Handed on about 30
  // times a second; a drag, Auto-rotate off or the map view stop the turn and so
  // the timeline. Only the actions are read here, so this view does not re-render
  // as the timeline moves.
  const { step } = useTimelineActions();
  const perTurnRef = useRef(0);
  perTurnRef.current = activeLayer ? positionPerTurn(activeLayer.manifest) : 0;
  const spinRef = useRef<SpinAccumulator | null>(null);
  spinRef.current ??= new SpinAccumulator(1000 / TIMELINE_UPDATE_HZ, step);
  useEffect(() => spinRef.current?.reset(), [activeLayer]);
  const handleSpin = useCallback((radians: number) => {
    spinRef.current?.add((radians / (2 * Math.PI)) * perTurnRef.current, performance.now());
  }, []);
  const selectedPoint = useListeningPoint();
  const selectedValue =
    selectedPoint && activeLayer
      ? sampleLayerAt(activeLayer, data.bbox, selectedPoint.lon, selectedPoint.lat, frame)
      : null;
  // The regions of the world (the Amazon alone until regions.json arrives, or if it
  // cannot be read), the one the map view visits and the one under the cursor.
  // null while regions.json loads, so the region map is built once, with all of them.
  const [regions, setRegions] = useState<readonly Region[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadWorldRegions(data.baseUrl)
      .then((loaded) => {
        if (!cancelled) setRegions(loaded);
      })
      .catch((cause: unknown) => {
        console.error("Earth Jukebox could not load the world regions; only the Amazon is outlined:", cause);
        if (!cancelled) setRegions(DEFAULT_REGIONS);
      });
    return () => {
      cancelled = true;
    };
  }, [data.baseUrl]);
  const [focusRegionId, setFocusRegionId] = useState(AMAZON_REGION_ID);
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null);
  const visitRegion = useCallback((regionId: string) => {
    setFocusRegionId(regionId);
    setTargetView("map");
  }, []);
  const showAmazon = useCallback(() => visitRegion(AMAZON_REGION_ID), [visitRegion]);
  const showEarth = useCallback(() => {
    setSceneHover(null);
    onCloseScene?.();
    setTargetView("globe");
  }, [onCloseScene]);
  const handleSceneSelect = useCallback(
    (scene: SceneDefinition) => {
      setSceneHover(null);
      onSceneSelect?.(scene);
    },
    [onSceneSelect],
  );
  const handleSceneHover = useCallback(
    (scene: SceneDefinition | null, clientX?: number, clientY?: number) => {
      if (!scene || clientX === undefined || clientY === undefined) {
        setSceneHover(null);
        return;
      }
      setSceneHover({ scene, x: clientX, y: clientY });
    },
    [],
  );

  useEffect(() => {
    if (targetView !== "map") setSceneHover(null);
  }, [targetView]);
  // Only the Amazon has zones of interest so far: once the zoom into any other
  // region finishes, a notice says its zone is in progress.
  const [zoneNoticeRegionId, setZoneNoticeRegionId] = useState<string | null>(null);
  useEffect(() => {
    setZoneNoticeRegionId(mode === "map" && focusRegionId !== AMAZON_REGION_ID ? focusRegionId : null);
  }, [mode, focusRegionId]);
  const closeZoneNotice = useCallback(() => setZoneNoticeRegionId(null), []);
  // Every way back to the planet (the button, a double-click or double-tap on the
  // map) closes the open scene too.
  const requestView = useCallback(
    (view: TargetView) => {
      if (view === "globe") showEarth();
      else setTargetView(view);
    },
    [showEarth],
  );

  if (data.layers.length === 0) {
    return (
      <p
        role="alert"
        data-testid="data-error"
        className="m-8 rounded border border-red-400 p-4 text-red-200"
      >
        The data file lists no layers.
      </p>
    );
  }

  return (
    <>
      <FrameTracker
        layerId={activeLayer?.manifest.id ?? ""}
        frames={layerFrames}
        fade={!lite}
        positionRef={positionRef}
        mixRef={frameMixRef}
        onFrames={setTracked}
      />
      <div className="absolute inset-0">
        <EarthScene
          data={data}
          activeLayer={activeLayer}
          frame={frames.from}
          nextFrame={frames.to}
          frameMix={frameMixRef}
          targetView={targetView}
          lite={lite}
          autoRotate={autoRotate}
          onSpin={handleSpin}
          onRequestView={requestView}
          regions={regions}
          focusRegionId={focusRegionId}
          onFocusRegion={visitRegion}
          onHoverRegion={setHoveredRegionId}
          onModeChange={setMode}
          onProbe={setProbe}
          onFps={setFps}
          onSceneError={setSceneError}
          scenes={scenes?.scenes}
          onSceneSelect={handleSceneSelect}
          onSceneHover={handleSceneHover}
          focusedScene={focusedScene}
        />
      </div>
      <PlanetHud
        layers={data.layers}
        activeLayerId={activeLayer?.manifest.id ?? EARTH_VIEW_ID}
        onSelectLayer={onSelectLayer}
        autoRotate={autoRotate}
        onToggleAutoRotate={setAutoRotate}
        mode={mode}
        onAmazon={showAmazon}
        onBackToEarth={showEarth}
        regionName={regionById(focusRegionId, regions ?? DEFAULT_REGIONS)?.name ?? "Amazon"}
        hoveredRegionName={hoveredRegionId ? (regionById(hoveredRegionId, regions ?? DEFAULT_REGIONS)?.name ?? null) : null}
        probe={probe}
        fps={fps}
        lite={lite}
        sceneError={sceneError}
        selectedValue={selectedValue}
        audio={audio}
        timeline={
          activeLayer ? (
            <TimelineControls layer={activeLayer} playing={autoRotate && mode === "globe"} />
          ) : undefined
        }
        onShowTour={onShowTour}
      />
      {sceneHover && !focusedScene && (
        <div
          data-testid="scene-marker-title"
          className="pointer-events-none fixed z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-slate-950/90 px-2 py-1 text-center text-xs text-white shadow"
          style={{ left: sceneHover.x, top: sceneHover.y - 10 }}
        >
          {sceneHover.scene.title}
        </div>
      )}
      {zoneNoticeRegionId && (
        <ZoneInProgressPopup
          regionName={regionById(zoneNoticeRegionId, regions ?? DEFAULT_REGIONS)?.name ?? ""}
          onClose={closeZoneNotice}
        />
      )}
    </>
  );
}

interface TrackedFrames {
  layerId: string;
  /** Earlier instant of the fade (the picture's base). */
  from: number;
  /** Later instant the picture fades towards; equal to `from` without fading. */
  to: number;
  /** Instant nearest the timeline position: the one the date on the line names. */
  nearest: number;
}

/** The pair of instants around a position (or the nearest one twice, without fading). */
function framesAt(position: number, frames: number, fade: boolean): Omit<TrackedFrames, "layerId"> {
  const nearest = frameIndexAt(position, frames);
  if (!fade) return { from: nearest, to: nearest, nearest };
  const { from, to } = frameBlend(position, frames);
  return { from, to, nearest };
}

/**
 * Turns the shared timeline position into the instants of the active layer on
 * screen: the pair the picture fades between and the nearest one (the date on
 * the line). It reads the clock about 30 times a second, puts how far it is
 * between the pair in `mixRef` (read by the shader on every animation frame) and
 * reports only when an instant changes, so the planet view re-renders a few
 * times per instant, not on every clock tick. In lite mode it does not fade:
 * the nearest instant is shown alone.
 */
function FrameTracker({
  layerId,
  frames,
  fade,
  positionRef,
  mixRef,
  onFrames,
}: {
  layerId: string;
  frames: number;
  fade: boolean;
  positionRef: { current: number };
  mixRef: { current: number };
  onFrames: (tracked: TrackedFrames) => void;
}) {
  const { position } = useTimeline();
  positionRef.current = position;
  mixRef.current = fade ? frameBlend(position, frames).mix : 0;
  const { from, to, nearest } = framesAt(position, frames, fade);
  useEffect(() => {
    onFrames({ layerId, from, to, nearest });
  }, [layerId, from, to, nearest, onFrames]);
  return null;
}

/**
 * Feeds the sound engine from the point under the cursor and the shared
 * timeline position (plan Step 10, FR3, FR6 and FR7). Lives inside
 * ListeningPointProvider, so the scene publishes the point without knowing
 * about audio. The timeline moves with the planet's turn and with the line
 * under the planet.
 */
function AudioListener({
  data,
  engine,
  fade,
}: {
  data: JukeboxData;
  engine: SoundEngine;
  /** Blend the two instants around the position like the picture does (off in lite mode). */
  fade: boolean;
}) {
  const point = useListeningPoint();
  const { position } = useTimeline();

  useEffect(() => {
    if (!point) {
      for (const layer of data.layers) {
        engine.setLayerIntensity(layer.manifest.id, null);
      }
      return;
    }
    for (const layer of data.layers) {
      // Shared normalized position -> the same blend of the two instants around
      // it that the picture fades between (the nearest instant alone in lite
      // mode), so what is heard is what is seen. Static layers have one frame,
      // so this is 0 and sampleLayerAt ignores time for them.
      const frame = fade
        ? framePosition(position, layer.region.frames)
        : frameIndexAt(position, layer.region.frames);
      engine.setLayerIntensity(
        layer.manifest.id,
        sampleLayerAt(layer, data.bbox, point.lon, point.lat, frame),
      );
    }
    engine.setPan(point.screenX);
  }, [engine, data, point, position, fade]);

  return null;
}

/**
 * The timeline line bound to the shared clock. Only this component reads the
 * clock, so the moving playhead re-renders it alone, not the planet view around it.
 */
function TimelineControls({ layer, playing }: { layer: LoadedLayer; playing: boolean }) {
  const timeline = useTimeline();
  return (
    <TimelineTrack
      position={timeline.position}
      layer={layer}
      playing={playing}
      onSeek={timeline.seek}
      speed={timeline.speed}
      onSpeed={timeline.setSpeed}
    />
  );
}

/** Delay before the first-visit tour, so the HUD is laid out when it measures it. */
const TOUR_START_DELAY_MS = 400;

/**
 * The welcome window and guided tour: shown by itself on the first visit of
 * this browser, and again whenever `show` is called (the "?" button).
 */
function useGuidedTour(): () => void {
  const tourRef = useRef<Driver | null>(null);

  const show = useCallback(() => {
    tourRef.current?.destroy();
    tourRef.current = startTour(() => {
      markTourSeen(browserFlagStore());
      tourRef.current = null;
    });
  }, []);

  useEffect(() => {
    if (hasSeenTour(browserFlagStore())) return undefined;
    const timer = window.setTimeout(show, TOUR_START_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [show]);

  // Close a tour that is still open when the view goes away.
  useEffect(() => () => tourRef.current?.destroy(), []);

  return show;
}

function JukeboxView({ data, lite }: { data: JukeboxData; lite: boolean }) {
  const engine = useSoundEngine();
  // Starts on the plain Earth view, with no layer drawn and none sounding.
  const [activeLayerId, setActiveLayerId] = useState(EARTH_VIEW_ID);
  const showTour = useGuidedTour();
  const [scenes, setScenes] = useState<ScenesManifest | null>(null);
  const [openScene, setOpenScene] = useState<SceneDefinition | null>(null);
  const [sceneAudioError, setSceneAudioError] = useState<string | null>(null);
  const closeScene = useCallback(() => setOpenScene(null), []);

  useEffect(() => {
    let cancelled = false;
    loadScenes()
      .then((manifest) => {
        if (!cancelled) setScenes(manifest);
      })
      .catch((cause: unknown) => {
        console.warn("Earth Jukebox could not load its scenes:", cause);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Scene audio: ARPA and the loop start together; the loop fades in over 0.5 s
  // while ARPA keeps playing over it. Closing or switching stops both.
  useEffect(() => {
    if (!openScene) {
      engine.stopSceneAudio();
      engine.setDataVoiceDuck(1, SCENE_DATA_FADE_SECONDS);
      return;
    }
    let cancelled = false;
    setSceneAudioError(null);
    const start = async (): Promise<void> => {
      try {
        if (engine.state === "idle") await engine.start();
        if (cancelled) return;
        engine.setDataVoiceDuck(SCENE_DATA_DUCK, SCENE_DATA_FADE_SECONDS);
        const transition = `./${scenes?.transition.file ?? "audio/samples/arpa.ogg"}`;
        await Promise.all([
          engine.playSceneTransition(transition),
          engine.playSceneLoop(`./${openScene.loop}`, {
            gain: openScene.loopGain,
            fadeInSeconds: 0.5,
          }),
        ]);
      } catch (cause) {
        if (cancelled) return;
        engine.stopSceneAudio();
        engine.setDataVoiceDuck(1, SCENE_DATA_FADE_SECONDS);
        setSceneAudioError(
          `The scene sound could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    };
    void start();
    return () => {
      cancelled = true;
      engine.stopSceneAudio();
      engine.setDataVoiceDuck(1, SCENE_DATA_FADE_SECONDS);
    };
  }, [engine, openScene, scenes]);

  // The layers never mix: only the picked layer sounds (plain Earth: none).
  useEffect(() => {
    const voices = layerVoices(data.layers.map((layer) => layer.manifest.id), activeLayerId);
    for (const { manifest } of data.layers) {
      engine.setLayerEnabled(manifest.id, voices[manifest.id] === true);
    }
  }, [engine, data, activeLayerId]);

  return (
    <>
      <PlanetView
        data={data}
        lite={lite}
        audio={<AudioStart engine={engine} className="w-full sm:w-56" />}
        activeLayerId={activeLayerId}
        onSelectLayer={setActiveLayerId}
        onShowTour={showTour}
        scenes={scenes}
        onSceneSelect={setOpenScene}
        onCloseScene={closeScene}
        focusedScene={openScene}
      />
      <AudioListener data={data} engine={engine} fade={!lite} />
      {openScene && (
        <ScenePopup scene={openScene} onClose={closeScene} audioError={sceneAudioError} />
      )}
    </>
  );
}

/**
 * Loads the prepared data, then shows the 3D planet with the Amazon map
 * transition (plan Step 12) and the sound of the listening point (Step 10).
 */
export default function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const lite = useMemo(() => readLiteMode(window.location.search), []);

  useEffect(() => {
    let cancelled = false;
    loadJukeboxData()
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error("Earth Jukebox could not load its data:", cause);
        if (!cancelled) setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TimelineProvider>
      <ListeningPointProvider>
        <main className="relative h-full w-full overflow-hidden">
          {state.status === "loading" && (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <h1 className="text-3xl font-semibold">Earth Jukebox</h1>
              <p role="status" data-testid="data-loading">
                Loading data…
              </p>
            </div>
          )}

          {state.status === "error" && (
            <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-4 p-8">
              <h1 className="text-3xl font-semibold">Earth Jukebox</h1>
              <p
                role="alert"
                data-testid="data-error"
                className="rounded border border-red-400 p-4 text-red-200"
              >
                {state.message}
              </p>
            </div>
          )}

          {state.status === "ready" && (
            <JukeboxView data={state.data} lite={lite} />
          )}
        </main>
      </ListeningPointProvider>
    </TimelineProvider>
  );
}
