// The 3D view: canvas, camera, the planet mesh, the click on the Amazon
// (FR2.1), the listening point under the cursor (FR4.3) and the active layer's
// value there (FR4.4). The base image is earth-8k.jpg when the graphics card
// accepts 8192-pixel textures and earth-4k.jpg otherwise, plus the Amazon crop
// earth-amazon.jpg (FR1.2, FR1.3). Lite mode (`?lite=1`, plan B) always uses
// earth-4k.jpg, fewer segments, no antialiasing and switches views at once.
// The forest layer is drawn from the GEDI height images forest-height-8k.png
// (or -4k.png, same rule as the base image) and forest-height-amazon.png, and
// lightning from the dots image lightning-4k.png (one size: 4096 pixels fit every
// card); the sound and the probe keep reading the grids.

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { gsap } from "gsap";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  TextureLoader,
  UnsignedByteType,
  type Texture,
  type WebGLRenderer,
} from "three";
import type { VisibleField } from "../audio/overview";
import type { JukeboxData, LoadedLayer } from "../data/types";
import type { SceneDefinition } from "../scenes/types";
import { sceneMapPosition } from "../scenes/geometry";
import { sampleLayerAt } from "../lib/interpolate";
import { FOREST_HEIGHT_IMAGES, REGION_BASE_IMAGE, REGION_FOREST_HEIGHT_IMAGE, pickBaseImage, pickImage } from "./baseImage";
import { dotImageFor } from "./dotImage";
import { EarthMesh, type DotImage, type GlobeHit, type ReliefImages } from "./EarthMesh";
import {
  GLOBE_CAMERA_Z,
  createViewState,
  globeCameraZ,
  mapCameraZ,
  playFocus,
  playReturn,
  type CancelTransition,
  type ViewMode,
  type ViewState,
} from "./FocusTransition";
import { GLOBE_RADIUS, screenX01 } from "./geo";
import { disposeLayerTextures, layerTextureFor, rampFor, showLayerBlend, type LayerTextures } from "./layerTexture";
import { useListeningPoint, useSetListeningPoint, type ListeningPoint } from "./listeningPoint";
import {
  AMAZON_REGION_ID,
  DEFAULT_REGIONS,
  buildRegionMap,
  focusBboxFor,
  regionById,
  regionMapIndexAt,
  type Region,
  type RegionMap,
} from "./regions";

export type TargetView = "globe" | "map";

/** What the on-screen indicator shows: the place under the cursor and the active layer's value (0..1 or null). */
export interface Probe {
  lon: number;
  lat: number;
  value: number | null;
}

export interface EarthSceneProps {
  data: JukeboxData;
  /** null: the plain Earth, no layer drawn. */
  activeLayer: LoadedLayer | null;
  /** Instant of the active layer to draw, from the timeline (frameBlend.from); 0 for static layers. */
  frame: number;
  /** Instant the picture fades towards (frameBlend.to); equal to `frame` when there is no fade. */
  nextFrame: number;
  /** How far the timeline is from `frame` towards `nextFrame` (0..1), read on every animation frame. */
  frameMix: RefObject<number>;
  targetView: TargetView;
  lite: boolean;
  /** The "Auto-rotate" switch: the planet turns by itself on the planet view. */
  autoRotate: boolean;
  onRequestView: (view: TargetView) => void;
  /**
   * Regions of the world, the Amazon first (regions.ts); they are outlined and can be
   * visited. null while they load: nothing is outlined yet, and the region map is
   * built once, when they arrive.
   */
  regions: readonly Region[] | null;
  /** Region visited by the map view (an id of `regions`); the Amazon uses the data file's rectangle. */
  focusRegionId: string;
  /** A region was double-clicked on the planet: visit it. */
  onFocusRegion: (regionId: string) => void;
  /** Region under the cursor on the planet (an id of `regions`), or null. */
  onHoverRegion: (regionId: string | null) => void;
  onModeChange: (mode: ViewMode) => void;
  onProbe: (probe: Probe | null) => void;
  onFps: (fps: number) => void;
  /** A problem that leaves the view usable (for example a base image missing). */
  onSceneError: (message: string | null) => void;
  /** Clickable scene points on the Amazon map. */
  scenes?: SceneDefinition[];
  onSceneSelect?: (scene: SceneDefinition) => void;
  /** Scene whose popup is open; the map zooms towards its point. */
  focusedScene?: SceneDefinition | null;
  onSceneHover?: (scene: SceneDefinition | null, clientX?: number, clientY?: number) => void;
  /** Visible screen field for the overview scan; null while the globe is not visible. */
  onOverviewField?: (field: VisibleField | null) => void;
}

const CAMERA_FOV = 45;
/** The layer drawn from the sharp GEDI height images (forest-height-*.png). */
const SHARP_RELIEF_LAYER = "forest";
/** The layer drawn from the sharp dots image (lightning-4k.png). */
const DOT_IMAGE_LAYER = "lightning";
/** Largest anisotropic filtering used on those images. */
const MAX_ANISOTROPY = 8;
// Dense enough for the raised forest relief to show its shape (about 0.7 degrees per vertex).
const FULL_SEGMENTS = { width: 512, height: 256 };
const LITE_SEGMENTS = { width: 64, height: 32 };

function emptyLayerTextures(): LayerTextures {
  const region = new DataTexture(new Uint8Array(4), 1, 1);
  region.needsUpdate = true;
  return {
    global: null,
    region,
    globalNext: null,
    regionNext: region,
    heightGlobal: null,
    heightRegion: null,
    opacity: 0.8,
    baseDim: 0,
    frame: 0,
    nextFrame: 0,
  };
}

/** Size of the region map: about 0.09 degrees per cell, so the outline stays smooth on the zoomed map. */
const REGION_MASK_SIZE = { width: 4096, height: 2048 };
/** Touch screens: longest time between the two taps that return from a region's map. */
const DOUBLE_TAP_MS = 400;
/** Lite mode (plan B): a quarter of the cells, built faster and four times lighter on the GPU. */
const LITE_REGION_MASK_SIZE = { width: 2048, height: 1024 };

/** The layer whose heights shape the regions (the forest inside each search area). */
const REGION_SHAPE_LAYER = "forest";

/**
 * The region map (regions.ts), shaped by the forest height grid when the data has
 * one, and its one-channel texture, read cell by cell (no filtering between regions).
 */
interface RegionMask {
  map: RegionMap;
  texture: DataTexture;
}

function buildRegionMask(data: JukeboxData, regions: readonly Region[], lite: boolean): RegionMask {
  const { width, height } = lite ? LITE_REGION_MASK_SIZE : REGION_MASK_SIZE;
  const forest = data.layers.find((layer) => layer.manifest.id === REGION_SHAPE_LAYER)?.global ?? null;
  const map = buildRegionMap(width, height, forest, regions);
  const texture = new DataTexture(map.cells, width, height, RedFormat, UnsignedByteType);
  texture.unpackAlignment = 1;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { map, texture };
}

/** WebGL's largest texture side, or null when the renderer does not report it. */
function readMaxTextureSize(gl: WebGLRenderer): number | null {
  try {
    const size = gl.capabilities.maxTextureSize;
    return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null;
  } catch (cause) {
    console.warn("Earth Jukebox could not read the largest texture size; using the 4096 planet image.", cause);
    return null;
  }
}

/**
 * Loads an image as a texture. On failure it logs the cause, reports
 * `failureMessage` and leaves the texture null, so the caller draws without it.
 * A success (or a new URL) clears the message, so a fixed image stops the banner.
 * A null URL loads nothing. `configure` runs on the texture before it is first
 * drawn (filters, format), so it applies to the first upload to the GPU.
 */
function useImageTexture(
  url: string | null,
  failureMessage: string,
  onError: (message: string | null) => void,
  configure?: (texture: Texture) => void,
): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const messageRef = useRef(failureMessage);
  messageRef.current = failureMessage;
  const configureRef = useRef(configure);
  configureRef.current = configure;

  useEffect(() => {
    onErrorRef.current(null);
    if (url === null) return;
    let cancelled = false;
    let loaded: Texture | null = null;
    new TextureLoader().load(
      url,
      (result) => {
        if (cancelled) {
          result.dispose();
          return;
        }
        configureRef.current?.(result);
        loaded = result;
        setTexture(loaded);
        onErrorRef.current(null);
      },
      undefined,
      (cause) => {
        if (cancelled) return;
        console.error(`Earth Jukebox could not load ${url}:`, cause);
        onErrorRef.current(messageRef.current);
      },
    );
    return () => {
      cancelled = true;
      loaded?.dispose();
      setTexture(null);
    };
  }, [url]);

  return texture;
}

/**
 * A greyscale image (forest height, lightning dots) as a one-channel texture (R8:
 * a quarter of the memory of RGBA), north row first like the grids, with mipmaps
 * so the planet does not shimmer when the image is drawn much smaller than its
 * size and so the shader can read mean values per vertex, per shading step or for
 * the glow around the lightning dots.
 */
function configureGreyImage(texture: Texture, wrapAround: boolean, anisotropy: number): void {
  texture.format = RedFormat;
  texture.colorSpace = NoColorSpace; // heights, not colours: no conversion on upload
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = wrapAround ? RepeatWrapping : ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

/** Average frames per second over the last second, reported once a second. */
function FpsProbe({ onFps }: { onFps: (fps: number) => void }) {
  const counter = useRef({ frames: 0, since: performance.now() });
  useFrame(() => {
    const current = counter.current;
    current.frames += 1;
    const now = performance.now();
    const elapsed = now - current.since;
    if (elapsed >= 1000) {
      onFps(Math.round((current.frames * 1000) / elapsed));
      current.frames = 0;
      current.since = now;
    }
  });
  return null;
}

interface SceneContentsProps extends EarthSceneProps {
  setListeningPoint: (point: ListeningPoint | null) => void;
}

function SceneContents(props: SceneContentsProps) {
  const {
    data,
    activeLayer,
    frame,
    nextFrame,
    frameMix,
    targetView,
    lite,
    autoRotate,
    regions,
    focusRegionId,
    onRequestView,
    onFocusRegion,
    onHoverRegion,
    onModeChange,
    onProbe,
    onFps,
    onSceneError,
    scenes,
    onSceneSelect,
    onSceneHover,
    focusedScene,
    onOverviewField,
    setListeningPoint,
  } = props;
  const selectedPoint = useListeningPoint();
  const [hoverPoint, setHoverPoint] = useState<{ lon: number; lat: number } | null>(null);
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);

  const view = useRef<ViewState>(createViewState());

  // Regions: the map of every region for the shader (built once), the one under
  // the cursor, and the rectangle of the one being visited.
  // Built once the regions are known, after the frame is drawn (never during a
  // render), and again only if the data, the regions or lite mode change.
  const [mask, setMask] = useState<RegionMask | null>(null);
  useEffect(() => {
    if (regions === null) return undefined;
    let built: RegionMask | null = null;
    const timer = window.setTimeout(() => {
      try {
        built = buildRegionMask(data, regions, lite);
        setMask(built);
      } catch (cause) {
        console.error("Earth Jukebox could not build the region outlines:", cause);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      built?.texture.dispose();
      setMask(null);
    };
  }, [data, regions, lite]);
  const knownRegions = regions ?? DEFAULT_REGIONS;
  const regionAt = useCallback(
    (lon: number, lat: number) => (mask ? regionMapIndexAt(mask.map, lon, lat) : null),
    [mask],
  );
  const [hoverRegion, setHoverRegion] = useState<number | null>(null);
  // Region chosen with a tap on a touch screen (index), waiting for a second tap to visit it.
  const touchSelected = useRef<number | null>(null);
  const focusBbox = useMemo(() => {
    const region = regionById(focusRegionId, knownRegions) ?? regionById(AMAZON_REGION_ID, knownRegions);
    return region ? focusBboxFor(region, data.bbox) : data.bbox;
  }, [focusRegionId, data.bbox, knownRegions]);
  const showHoverRegion = useCallback(
    (index: number | null) => {
      setHoverRegion(index);
      onHoverRegion(index === null ? null : (knownRegions[index]?.id ?? null));
    },
    [onHoverRegion, knownRegions],
  );
  // A new region map renumbers the regions: forget the old highlight, in the
  // shader and in the status text alike.
  useEffect(() => {
    touchSelected.current = null;
    showHoverRegion(null);
  }, [mask, showHoverRegion]);
  const [mode, setModeState] = useState<ViewMode>("globe");
  const modeRef = useRef<ViewMode>("globe");
  const targetRef = useRef<TargetView>(targetView);
  targetRef.current = targetView;
  const cancelRef = useRef<CancelTransition | null>(null);
  const focusRef = useRef({ x: 0, y: 0, zoom: 0 });
  const lastHitRef = useRef<GlobeHit | null>(null);
  const lastProbeRef = useRef<Probe | null>(null);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [regionError, setRegionError] = useState<string | null>(null);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [forestGlobalError, setForestGlobalError] = useState<string | null>(null);
  const [forestRegionError, setForestRegionError] = useState<string | null>(null);
  const [lightningError, setLightningError] = useState<string | null>(null);
  const [sharpGlobalError, setSharpGlobalError] = useState<string | null>(null);
  const [sharpRegionError, setSharpRegionError] = useState<string | null>(null);

  const maxTextureSize = useMemo(() => readMaxTextureSize(gl), [gl]);
  const baseUrl = `${data.baseUrl}${pickBaseImage(maxTextureSize, lite)}`;
  const baseTexture = useImageTexture(
    baseUrl,
    `The planet image (${baseUrl}) could not be loaded, so the planet is drawn without it. The layers, the map and the controls still work.`,
    setBaseError,
  );
  const regionUrl = `${data.baseUrl}${REGION_BASE_IMAGE}`;
  const regionBaseTexture = useImageTexture(
    regionUrl,
    `The detailed Amazon image (${regionUrl}) could not be loaded, so the Amazon is drawn from the planet image. Everything else still works.`,
    setRegionError,
  );

  // Sharp forest images: requested the first time the forest is chosen and then
  // kept, so switching back to it is instant. The Earth view and other layers
  // never wait for them.
  const forestActive = activeLayer?.manifest.id === SHARP_RELIEF_LAYER;
  const [forestWanted, setForestWanted] = useState(forestActive);
  useEffect(() => {
    if (forestActive) setForestWanted(true);
  }, [forestActive]);
  const anisotropy = useMemo(() => {
    try {
      return Math.max(1, Math.min(MAX_ANISOTROPY, gl.capabilities.getMaxAnisotropy()));
    } catch {
      return 1;
    }
  }, [gl]);
  const configureGlobalHeight = useCallback((texture: Texture) => configureGreyImage(texture, true, anisotropy), [anisotropy]);
  const configureRegionHeight = useCallback((texture: Texture) => configureGreyImage(texture, false, anisotropy), [anisotropy]);
  const forestGlobalUrl = forestWanted ? `${data.baseUrl}${pickImage(maxTextureSize, lite, FOREST_HEIGHT_IMAGES)}` : null;
  const forestGlobal = useImageTexture(
    forestGlobalUrl,
    `The sharp forest image (${forestGlobalUrl}) could not be loaded, so the forest is drawn from the coarser grid. Everything else still works.`,
    setForestGlobalError,
    configureGlobalHeight,
  );
  const forestRegionUrl = forestWanted ? `${data.baseUrl}${REGION_FOREST_HEIGHT_IMAGE}` : null;
  const forestRegion = useImageTexture(
    forestRegionUrl,
    `The sharp Amazon forest image (${forestRegionUrl}) could not be loaded, so the forest is drawn from the coarser grid. Everything else still works.`,
    setForestRegionError,
    configureRegionHeight,
  );
  const forestImages = useMemo<ReliefImages | null>(
    () =>
      forestActive && forestGlobal && forestRegion
        ? { global: forestGlobal, region: forestRegion, ramp: rampFor(SHARP_RELIEF_LAYER), relief: true }
        : null,
    [forestActive, forestGlobal, forestRegion],
  );

  // Sharp images that tools/prep made for the active layer (CO2): one per instant,
  // only the instant on screen is loaded. Until both are there, or if one fails,
  // the layer is drawn from its grids. The forest keeps its own height images.
  const sharp = activeLayer && !forestActive ? activeLayer.manifest.sharp : undefined;
  const sharpFrame = activeLayer ? Math.min(frame, activeLayer.region.frames - 1) : 0;
  const sharpGlobalFile = sharp?.global && sharp.region ? (sharp.global.files[sharpFrame] ?? null) : null;
  const sharpRegionFile = sharp?.global && sharp.region ? (sharp.region.files[sharpFrame] ?? null) : null;
  const sharpGlobalUrl = sharpGlobalFile ? `${data.baseUrl}${sharpGlobalFile}` : null;
  const sharpRegionUrl = sharpRegionFile ? `${data.baseUrl}${sharpRegionFile}` : null;
  const sharpGlobal = useImageTexture(
    sharpGlobalUrl,
    `The sharp image of this layer (${sharpGlobalUrl}) could not be loaded, so it is drawn from the coarser grid. Everything else still works.`,
    setSharpGlobalError,
    configureGlobalHeight,
  );
  const sharpRegion = useImageTexture(
    sharpRegionUrl,
    `The sharp Amazon image of this layer (${sharpRegionUrl}) could not be loaded, so it is drawn from the coarser grid. Everything else still works.`,
    setSharpRegionError,
    configureRegionHeight,
  );
  const layerSharpImages = useMemo<ReliefImages | null>(
    () =>
      activeLayer && sharpGlobal && sharpRegion
        ? { global: sharpGlobal, region: sharpRegion, ramp: rampFor(activeLayer.manifest.id), relief: false }
        : null,
    [activeLayer, sharpGlobal, sharpRegion],
  );
  const reliefImages = forestImages ?? layerSharpImages;

  // Sharp lightning dots: requested the first time lightning is shown, then kept
  // (same rule as the forest images), so start-up does not wait for them.
  // The dots image holds the whole period at once, so it is only drawn while the
  // lightning data has a single instant. With one instant per quarter, the timeline
  // draws each quarter from its grids instead (one quarter at a time, never accumulated).
  // Kept on purpose, although the shipped data has 27 instants and never takes this
  // path: if the lightning layer is ever published with a single instant again, the
  // sharp dots (lightning-4k.png, dotImage.ts, `lightning_dots.py render`) apply.
  const lightningActive = activeLayer?.manifest.id === DOT_IMAGE_LAYER && activeLayer.region.frames <= 1;
  const dotStyle = lightningActive ? dotImageFor(DOT_IMAGE_LAYER) : null;
  const [lightningWanted, setLightningWanted] = useState(lightningActive);
  useEffect(() => {
    if (lightningActive) setLightningWanted(true);
  }, [lightningActive]);
  const lightningFile = dotImageFor(DOT_IMAGE_LAYER)?.file ?? null;
  const lightningUrl = lightningWanted && lightningFile ? `${data.baseUrl}${lightningFile}` : null;
  const lightningTexture = useImageTexture(
    lightningUrl,
    `The sharp lightning image (${lightningUrl}) could not be loaded, so lightning is drawn from the coarser grid. Everything else still works.`,
    setLightningError,
    configureGlobalHeight,
  );
  const dotImage = useMemo<DotImage | null>(
    () => (dotStyle && lightningTexture ? { texture: lightningTexture, style: dotStyle } : null),
    [dotStyle, lightningTexture],
  );

  // The textures are built once per layer, at the instant on screen; later instants
  // are swapped in place below, so playing the timeline does not rebuild them.
  const frameRef = useRef({ frame, nextFrame });
  frameRef.current = { frame, nextFrame };
  const layer = useMemo(() => {
    // The plain Earth view: an empty (fully transparent) layer, so only the planet shows.
    if (activeLayer === null) return { textures: emptyLayerTextures(), error: null };
    try {
      return { textures: layerTextureFor(activeLayer, frameRef.current.frame, frameRef.current.nextFrame), error: null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { textures: emptyLayerTextures(), error: message };
    }
  }, [activeLayer]);
  useEffect(() => {
    if (layer.error) {
      console.error("Earth Jukebox could not draw a layer:", layer.error);
      setLayerError(`${layer.error} The layer is not drawn.`);
    } else {
      setLayerError(null);
    }
    return () => disposeLayerTextures(layer.textures);
  }, [layer]);

  // The timeline moved to another pair of instants: they replace the ones on screen.
  useEffect(() => {
    if (activeLayer === null || layer.error) return;
    try {
      showLayerBlend(layer.textures, activeLayer, frame, nextFrame);
      // This instant drew well: a banner left by an earlier one no longer applies.
      setLayerError(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error("Earth Jukebox could not draw an instant of a layer:", cause);
      setLayerError(`${message} The layer stays on its previous instant.`);
    }
  }, [layer, activeLayer, frame, nextFrame]);

  // One banner for every source: a good layer or image clears itself without
  // hiding a failure somewhere else.
  // The forest image banners only show while the forest is the layer on screen.
  const forestError = forestActive ? (forestGlobalError ?? forestRegionError) : null;
  // Likewise the lightning image banner, only while lightning is on screen.
  const lightningImageError = lightningActive ? lightningError : null;
  const sharpImageError = sharpGlobalUrl ? (sharpGlobalError ?? sharpRegionError) : null;
  useEffect(() => {
    onSceneError(layerError ?? baseError ?? regionError ?? forestError ?? lightningImageError ?? sharpImageError ?? null);
  }, [layerError, baseError, regionError, forestError, lightningImageError, sharpImageError, onSceneError]);

  const setMode = (next: ViewMode) => {
    modeRef.current = next;
    setModeState(next);
    onModeChange(next);
    if (next === "to-map" || next === "to-globe") {
      // The indicator and crosshair hide during the transition, but the selected
      // point stays so the sound does not cut out (FR5.2).
      setHoverPoint(null);
      onProbe(null);
      lastProbeRef.current = null;
      touchSelected.current = null;
      showHoverRegion(null);
    }
  };

  // Moves towards the requested view; called again when a transition ends in
  // case the request changed meanwhile.
  const advanceRef = useRef<() => void>(() => {});
  advanceRef.current = () => {
    const current = modeRef.current;
    const target = targetRef.current;
    const instant = lite;
    if (target === "map" && current === "globe") {
      setMode("to-map");
      const cameraZ = mapCameraZ(focusBbox, CAMERA_FOV, size.width / size.height);
      cancelRef.current = playFocus(view.current, { bbox: focusBbox, cameraZ }, {
        instant,
        onComplete: () => {
          setMode("map");
          advanceRef.current();
        },
      });
    } else if (target === "globe" && current === "map") {
      setMode("to-globe");
      cancelRef.current = playReturn(
        view.current,
        {
          instant,
          onComplete: () => {
            setMode("globe");
            advanceRef.current();
          },
        },
        globeCameraZ(CAMERA_FOV, size.width / size.height),
      );
    }
  };
  useEffect(() => {
    advanceRef.current();
  }, [targetView]);
  useEffect(() => () => cancelRef.current?.(), []);

  // Zoom the map towards the open scene; zoom back out when it closes.
  useEffect(() => {
    const focused = focusedScene && modeRef.current === "map";
    const target = focused ? sceneMapPosition(focusedScene, data.bbox) : { x: 0, y: 0 };
    const base = Math.max(0.01, mapCameraZ(data.bbox, CAMERA_FOV, size.width / size.height) - GLOBE_RADIUS);
    const zoom = focused ? base * 0.45 : 0;
    gsap.killTweensOf(focusRef.current);
    gsap.to(focusRef.current, {
      x: target.x,
      y: target.y,
      zoom,
      duration: 0.55,
      ease: "power2.inOut",
    });
    return () => {
      gsap.killTweensOf(focusRef.current);
    };
  }, [focusedScene, data.bbox, size.width, size.height, lite]);

  useFrame(() => {
    const state = view.current;
    const focus = focusRef.current;
    if (modeRef.current === "map") {
      // Keep the region visited framed if the window is resized while on the map.
      state.cameraZ = mapCameraZ(focusBbox, CAMERA_FOV, size.width / size.height);
      camera.position.set(focus.x, focus.y, state.cameraZ - focus.zoom);
      camera.lookAt(focus.x, focus.y, GLOBE_RADIUS);
    } else {
      if (modeRef.current === "globe") {
        // Keep the whole planet on screen, also on a phone held upright or turned.
        state.cameraZ = globeCameraZ(CAMERA_FOV, size.width / size.height);
      }
      camera.position.set(0, 0, state.cameraZ);
      camera.lookAt(0, 0, 0);
    }
  });

  const probeFor = useCallback(
    (hit: GlobeHit): Probe => ({
      lon: hit.lon,
      lat: hit.lat,
      // The reading of the instant on screen, so the indicator matches the picture.
      // The same blend of the two instants the picture shows.
      value: activeLayer
        ? sampleLayerAt(activeLayer, data.bbox, hit.lon, hit.lat, frame + (nextFrame - frame) * (frameMix.current ?? 0))
        : null,
    }),
    [activeLayer, data.bbox, frame, nextFrame, frameMix],
  );

  // The pointer can deliver several moves per frame; publish the latest one once.
  const pendingHover = useRef<GlobeHit | null | undefined>(undefined);
  const hoverFrame = useRef<number | null>(null);

  const publishHover = useCallback(() => {
    hoverFrame.current = null;
    const hit = pendingHover.current;
    pendingHover.current = undefined;
    if (hit === undefined) return;
    // While the view changes, keep the last point (and the sound) as it is.
    if (modeRef.current === "to-map" || modeRef.current === "to-globe") return;
    lastHitRef.current = hit;
    if (!hit) {
      lastProbeRef.current = null;
      setHoverPoint(null);
      onProbe(null);
      // A region chosen with a tap stays chosen when the finger lifts.
      if (touchSelected.current === null) showHoverRegion(null);
      return;
    }
    setHoverPoint({ lon: hit.lon, lat: hit.lat });
    // Regions are only picked on the planet; on the map there is no outline. On touch
    // screens taps choose the region (handleGlobeTap), not the moving finger.
    if (!hit.touch) {
      touchSelected.current = null;
      showHoverRegion(modeRef.current === "globe" ? regionAt(hit.lon, hit.lat) : null);
    }
    const probe = probeFor(hit);
    // The cursor may rest while the point is looked up again; do not repaint for the same reading.
    const last = lastProbeRef.current;
    if (last && last.lon === probe.lon && last.lat === probe.lat && last.value === probe.value) return;
    lastProbeRef.current = probe;
    onProbe(probe);
  }, [gl, onProbe, probeFor, showHoverRegion, regionAt]);

  const handleHover = useCallback(
    (hit: GlobeHit | null) => {
      // While the view changes, keep the last point (and the sound) as it is.
      if (modeRef.current === "to-map" || modeRef.current === "to-globe") return;
      pendingHover.current = hit;
      if (hoverFrame.current === null) {
        hoverFrame.current = requestAnimationFrame(publishHover);
      }
    },
    [publishHover],
  );

  useEffect(
    () => () => {
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );

  // A new layer (or a new instant of it) changes the reading under a cursor that has not moved.
  useEffect(() => {
    lastProbeRef.current = null;
    const hit = lastHitRef.current;
    if (hit) handleHover(hit);
  }, [handleHover]);

  const handleGlobeSelectPoint = useCallback(
    (lon: number, lat: number, clientX: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      setListeningPoint({ lon, lat, screenX: screenX01(clientX, rect.left, rect.width) });
    },
    [gl, setListeningPoint],
  );

  const handleMapBack = useCallback(() => onRequestView("globe"), [onRequestView]);

  // Touch screens: the first tap on a region chooses it (outline and name), a second
  // tap on the same region flies there; a tap elsewhere chooses again or clears.
  const handleGlobeTap = useCallback(
    (lon: number, lat: number) => {
      const index = regionAt(lon, lat);
      const region = index === null ? undefined : knownRegions[index];
      if (index === null || !region) {
        touchSelected.current = null;
        showHoverRegion(null);
        return;
      }
      if (touchSelected.current === index) {
        touchSelected.current = null;
        onFocusRegion(region.id);
        return;
      }
      touchSelected.current = index;
      showHoverRegion(index);
    },
    [regionAt, knownRegions, showHoverRegion, onFocusRegion],
  );

  // Touch screens: two taps on the map within DOUBLE_TAP_MS go back to the planet.
  const lastMapTap = useRef(0);
  const handleMapTap = useCallback(() => {
    const now = performance.now();
    if (now - lastMapTap.current <= DOUBLE_TAP_MS) {
      lastMapTap.current = 0;
      onRequestView("globe");
    } else {
      lastMapTap.current = now;
    }
  }, [onRequestView]);

  const handleGlobeFocusRegion = useCallback(
    (lon: number, lat: number) => {
      const index = regionAt(lon, lat);
      const region = index === null ? undefined : knownRegions[index];
      if (region) onFocusRegion(region.id);
    },
    [onFocusRegion, regionAt, knownRegions],
  );

  return (
    <>
      <EarthMesh
        baseTexture={baseTexture}
        regionBaseTexture={regionBaseTexture}
        layerTextures={layer.textures}
        bbox={data.bbox}
        focusBbox={focusBbox}
        regionMask={mask?.texture ?? null}
        regionAt={regionAt}
        hoverRegion={hoverRegion}
        view={view}
        mode={mode}
        segments={lite ? LITE_SEGMENTS : FULL_SEGMENTS}
        raiseRelief={!lite}
        autoRotate={autoRotate}
        frameMix={frameMix}
        reliefImages={reliefImages}
        dotImage={dotImage}
        // Scenes are points of the Amazon map: shown only when the Amazon is the region visited.
        scenes={focusRegionId === AMAZON_REGION_ID ? scenes : undefined}
        onSceneSelect={onSceneSelect}
        onSceneHover={onSceneHover}
        selectedPoint={selectedPoint}
        hoverPoint={hoverPoint}
        onHover={handleHover}
        onGlobeSelectPoint={handleGlobeSelectPoint}
        onGlobeFocusRegion={handleGlobeFocusRegion}
        onMapBack={handleMapBack}
        onGlobeTap={handleGlobeTap}
        onMapTap={handleMapTap}
        onOverviewField={onOverviewField}
      />
      <FpsProbe onFps={onFps} />
    </>
  );
}

function EarthSceneView(props: EarthSceneProps) {
  // Read outside the Canvas and passed in, so no context has to cross the renderer.
  const setListeningPoint = useSetListeningPoint();
  return (
    <Canvas
      data-testid="planet-canvas"
      camera={{ fov: CAMERA_FOV, position: [0, 0, GLOBE_CAMERA_Z], near: 0.01, far: 100 }}
      dpr={props.lite ? 1 : [1, 2]}
      gl={{ antialias: !props.lite }}
      fallback={
        <p role="alert" data-testid="planet-webgl-error" className="p-8 text-red-200">
          This browser cannot draw the 3D planet (WebGL is not available).
        </p>
      }
    >
      <SceneContents {...props} setListeningPoint={setListeningPoint} />
    </Canvas>
  );
}

export const EarthScene = memo(EarthSceneView);
