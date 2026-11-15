// The planet: one segmented mesh that blends between a sphere and the flat
// world map according to `view.flatten` (0 = sphere, 1 = map), drawn with
// the base image (earth-8k.jpg or earth-4k.jpg) and the active layer on top
// (FR1.1, FR1.2, FR3, NFR1).
//
// Both shapes live in one geometry: `position` holds the sphere and `aPlane`
// the flat map, and the vertex shader mixes them, so the blend costs nothing
// on the CPU. The flat map is shifted so the Amazon centre sits where the
// sphere's front point is once the planet faces the Amazon: the region stays
// in place while the planet flattens around it.
//
// Inside the Amazon rectangle the base colour comes from a full-resolution
// crop of the base image (earth-amazon.jpg), on the planet and on the map;
// outside it, from the global image.
//
// The forest (a relief layer) is drawn like NASA SVS 4950 from the GEDI 1 km
// height images (forest-height-8k/4k.png, forest-height-amazon.png): colour from
// the GEDI colour bar, shaded relief and exaggerated height, all computed here
// from the height. Until they load, or if they fail, it uses the 0.25 degree
// grids of the data file instead.
//
// Lightning is drawn like NASA SVS 5011 from the sharp dots image
// (lightning-4k.png): colour from the lightning stops, presence from the value
// and a soft glow from a coarser mipmap level, over the planet dimmed to grey.
// Until it loads, or if it fails, it uses the grids of the data file instead.
//
// Picking (FR4.1, FR4.2): an invisible sphere while on the planet and an
// invisible plane while on the map; nothing is picked during the transition.
//
// Regions (regions.ts): the region map (one byte per cell, region index + 1)
// lets the shader outline every region on the planet, and the one under the
// cursor more strongly with a light tint; double-clicking a region on the
// planet asks the scene to fly there, and double-clicking its map returns.
// The outlines are hidden during the transitions and on the map. The flat map is centred on the region
// being visited (`focusBbox`) through a uniform, so no geometry is rebuilt.

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Matrix3,
  Matrix4,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type Group,
  type IUniform,
  type Mesh,
  type Texture,
} from "three";
import type { BoundingBox } from "../data/types";
import type { SceneDefinition } from "../scenes/types";
import { OVERVIEW_COLUMNS, OVERVIEW_ROWS, type VisibleCell, type VisibleColumn, type VisibleField } from "../audio/overview";
import { LocationMarkers } from "./LocationMarkers";
import { SceneMarkers } from "./SceneMarkers";
import type { ViewMode, ViewState } from "./FocusTransition";
import {
  GLOBE_RADIUS,
  PLANE_HEIGHT,
  PLANE_WIDTH,
  bboxCenter,
  lonLatToPlanePoint,
  lonLatToSpherePoint,
  planeUvToLonLat,
  spherePointToLonLat,
} from "./geo";
import { glowColor, type DotImageStyle } from "./dotImage";
import type { ListeningPoint } from "./listeningPoint";
import { spinStep } from "./spin";
import type { ColorRamp, LayerTextures } from "./layerTexture";
import {
  SHADER_STOPS,
  SHADE_STEP_GLOBAL_DEGREES,
  SHADE_STEP_REGION_DEGREES,
  lodForSpacing,
  shadeStepDegrees,
  shaderColorbar,
  shaderPresence,
} from "./relief";

/** Turn per dragged pixel, radians. */
const DRAG_SPEED = 0.005;
const MAX_PITCH = 1.2;
/** A press that moves more than this is a drag, not a click. */
const CLICK_TOLERANCE_PX = 5;
/** Wait this long before treating a click as a single click. */
const SINGLE_CLICK_MS = 350;
/** How often the point under a resting cursor is looked up again, seconds. */
const HOVER_REFRESH_SECONDS = 0.05;
/**
 * Relief layers (forest, like NASA SVS 4950): how far the tallest value (50 m)
 * is raised, as a fraction of the globe radius. Height is exaggerated on
 * purpose so the canopy reads at the scale of the planet; the map is raised
 * half as much.
 */
const RELIEF_LIFT = 0.025;
/**
 * Strength of the shaded relief (light from the north-west), per unit of height
 * difference (0..1 = 0..50 m) across one shading step. Soft, like SVS 4950: a
 * 5 m rise across the step brightens or darkens by about 17 %, and the shading
 * always stays between 0.7 and 1.25 (the 0.25 degree grids used 6 and 0.55..1.4).
 */
const RELIEF_SHADE = 2.5;

export interface GlobeHit {
  lon: number;
  lat: number;
  clientX: number;
  /** The point comes from a finger (touch screen), not a mouse or pen. */
  touch: boolean;
}

export interface EarthMeshProps {
  /** Global base image (earth-8k.jpg or earth-4k.jpg); null while loading or when it failed (a plain ocean colour is drawn). */
  baseTexture: Texture | null;
  /** Amazon crop of the base image (earth-amazon.jpg); null while loading or when it failed (the global image is used). */
  regionBaseTexture: Texture | null;
  layerTextures: LayerTextures;
  bbox: BoundingBox;
  /** Rectangle of the region being visited: its centre sits in front of the camera once flat. */
  focusBbox: BoundingBox;
  /** Region map (regions.ts): one channel, region index + 1, 0 outside; null draws no outline. */
  regionMask: Texture | null;
  /** Region under a point (index in REGIONS), or null; sets the pointer cursor over regions. */
  regionAt: (lon: number, lat: number) => number | null;
  /** Region outlined (index in REGIONS), or null. */
  hoverRegion: number | null;
  view: RefObject<ViewState>;
  mode: ViewMode;
  segments: { width: number; height: number };
  /** Raise relief layers above the surface (off in lite mode; the shaded relief stays). */
  raiseRelief: boolean;
  /** The "Auto-rotate" switch: the planet turns by itself on the planet view. */
  autoRotate: boolean;
  /**
   * How far the timeline is from the instant in `layerTextures.global/region`
   * towards the one in `globalNext/regionNext` (0..1). Read on every frame, so
   * the picture fades smoothly without React re-rendering.
   */
  frameMix?: RefObject<number>;
  /**
   * Sharp forest height images (forest-height-8k/4k.png and forest-height-amazon.png),
   * when the active layer is the forest and both have loaded; null otherwise, and
   * the relief then comes from the layer's grids (layerTextures.height*).
   */
  reliefImages: ReliefImages | null;
  /**
   * Sharp dots image (lightning-4k.png) when the active layer is drawn from one
   * and it has loaded; null otherwise, and the layer then comes from its grids.
   */
  dotImage: DotImage | null;
  /** Clickable scene points; shown only on the flattened Amazon map. */
  scenes?: SceneDefinition[];
  onSceneSelect?: (scene: SceneDefinition) => void;
  onSceneHover?: (scene: SceneDefinition | null, clientX?: number, clientY?: number) => void;
  /** Point whose sound is selected (click); drawn on the globe and the map. */
  selectedPoint?: ListeningPoint | null;
  /** Point under the cursor; drawn as a crosshair. */
  hoverPoint?: { lon: number; lat: number } | null;
  onHover: (hit: GlobeHit | null) => void;
  /** Double-click on the planet (not after a drag): the point whose sound is selected. */
  onGlobeSelectPoint: (lon: number, lat: number, clientX: number) => void;
  /** Click on a region of the planet (not after a drag): visit it. */
  onGlobeFocusRegion: (lon: number, lat: number) => void;
  /** Click on the map of a region (not after a drag): back to the planet. */
  onMapBack: () => void;
  /** Touch screens: a tap on the planet (not after a drag); double taps are not reported as double-clicks. */
  onGlobeTap: (lon: number, lat: number) => void;
  /** Touch screens: a tap on the map of a region. */
  onMapTap: () => void;
  /** Visible screen field for the overview scan; null when the globe is not visible. */
  onOverviewField?: (field: VisibleField | null) => void;
}

export interface ReliefImages {
  global: Texture;
  region: Texture;
  /** Colour ramp of the layer (its stops and presence go to the shader). */
  ramp: ColorRamp;
  /**
   * True for heights (the forest): shaded relief and raised height. False for any
   * other value drawn sharp (CO2): colour and presence only, the surface stays flat.
   */
  relief: boolean;
}

export interface DotImage {
  /** Whole planet, one channel, north row first, with mipmaps. */
  texture: Texture;
  /** Ramp (stops and presence on the image's scale) and glow. */
  style: DotImageStyle;
}

// Height of a relief layer (0..1) at a texture coordinate of the planet: the
// detailed Amazon texture inside the rectangle, the global one outside it, at
// the given mipmap levels. Both textures hold the north row first (flipY off).
const HEIGHT_AT = /* glsl */ `
  uniform sampler2D uHeightGlobal;
  uniform sampler2D uHeightRegion;
  uniform bool uHasHeight;
  uniform bool uHasHeightGlobal;
  uniform vec4 uBbox; // west, south, east, north in degrees

  float heightAt(vec2 p, float lodGlobal, float lodRegion) {
    if (!uHasHeight) return 0.0;
    float lon = -180.0 + 360.0 * p.x;
    float lat = -90.0 + 180.0 * p.y;
    if (lon >= uBbox.x && lon <= uBbox.z && lat >= uBbox.y && lat <= uBbox.w) {
      vec2 r = vec2((lon - uBbox.x) / (uBbox.z - uBbox.x), (uBbox.w - lat) / (uBbox.w - uBbox.y));
      return textureLod(uHeightRegion, r, lodRegion).r;
    }
    if (uHasHeightGlobal) return textureLod(uHeightGlobal, vec2(p.x, 1.0 - p.y), lodGlobal).r;
    return 0.0;
  }
`;

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aPlane;
  uniform mat3 uRotation;
  uniform float uFlatten;
  uniform float uLift;
  uniform vec2 uPlaneShift; // flat-map position of the centre of the region being visited
  // Mipmap levels about one vertex wide, so each vertex rises with the mean height around it.
  uniform float uLiftLodGlobal;
  uniform float uLiftLodRegion;
  varying vec2 vUv;
  varying float vShade;
  ${HEIGHT_AT}

  void main() {
    vUv = uv;
    vec3 spherePosition = uRotation * position;
    // Relief layers rise along the surface normal: outwards on the sphere, towards the camera on the map.
    float lift = uLift > 0.0 ? heightAt(uv, uLiftLodGlobal, uLiftLodRegion) * uLift : 0.0;
    vec3 raisedSphere = spherePosition + normalize(spherePosition) * lift;
    vec3 raisedPlane = aPlane - vec3(uPlaneShift, 0.0) + vec3(0.0, 0.0, lift * 0.5);
    vec3 blended = mix(raisedSphere, raisedPlane, uFlatten);
    // Soft light from the upper left on the sphere; the flat map is lit evenly.
    float light = 0.55 + 0.45 * max(dot(normalize(spherePosition), normalize(vec3(-0.4, 0.5, 1.0))), 0.0);
    vShade = mix(light, 1.0, uFlatten);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(blended, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uBase;
  uniform bool uHasBase;
  uniform sampler2D uRegionBase;
  uniform bool uHasRegionBase;
  uniform sampler2D uLayerGlobal;
  uniform bool uHasGlobal;
  uniform sampler2D uLayerRegion;
  // The next instant of the layer and how far the timeline is towards it (0..1).
  uniform sampler2D uLayerGlobalNext;
  uniform sampler2D uLayerRegionNext;
  uniform float uFrameMix;
  uniform float uLayerOpacity;
  uniform float uBaseDim;
  // uBbox comes with HEIGHT_AT below.
  uniform float uReliefShade;
  // Texels of the height textures, and the shading step and its mipmap level, in
  // planet texture units (u covers 360 degrees, v covers 180).
  uniform vec2 uHeightSizeGlobal;
  uniform vec2 uHeightSizeRegion;
  uniform vec2 uShadeStepGlobal;
  uniform vec2 uShadeStepRegion;
  uniform float uShadeLodGlobal;
  uniform float uShadeLodRegion;
  // Colour from the height itself (sharp forest images): GEDI colour bar and presence alpha.
  uniform bool uColorFromHeight;
  uniform vec3 uColorbar[11];
  uniform vec2 uPresence; // start, fade on the 0..1 height (or dots image) scale
  // Sharp dots image (lightning): its value takes the colour bar and presence above.
  uniform sampler2D uDotImage;
  uniform bool uHasDotImage;
  uniform float uGlow; // strength of the glow around the dots
  uniform float uGlowBias; // mipmap levels above the drawn one where the glow is read
  uniform vec3 uGlowColor;
  // Region map (one byte per cell: region index + 1) and the region outlined (index + 1, 0 = none).
  uniform sampler2D uRegionMask;
  uniform float uHoverRegion;
  uniform float uShowRegions; // 1 on the planet, 0 on the map and during the transitions
  varying vec2 vUv;
  varying float vShade;
  ${HEIGHT_AT}

  float regionAt(vec2 maskUv) {
    return floor(texture2D(uRegionMask, maskUv).r * 255.0 + 0.5);
  }

  // Mipmap level of a texture of size texels covering the given uv derivatives.
  float lodOf(vec2 dx, vec2 dy, vec2 size) {
    vec2 a = dx * size;
    vec2 b = dy * size;
    return max(0.0, 0.5 * log2(max(max(dot(a, a), dot(b, b)), 1e-12)));
  }

  // GEDI colour bar, linear between its eleven stops (0 m to 50 m).
  vec3 colorbar(float h) {
    float x = clamp(h, 0.0, 1.0) * 10.0;
    vec3 color = uColorbar[0];
    for (int i = 0; i < 10; i++) {
      if (x >= float(i)) color = mix(uColorbar[i], uColorbar[i + 1], clamp(x - float(i), 0.0, 1.0));
    }
    return color;
  }

  // Shaded relief like a hillshade: slopes facing the light (north-west) are
  // brighter, slopes facing away darker. The step is a fixed distance in degrees
  // (or one texel of the level being drawn, when that is coarser), sampled at a
  // mipmap level about one step wide so the shading is soft and has no bands.
  float reliefShade(bool inRegion, float lodGlobal, float lodRegion, vec2 regionScale) {
    if (!uHasHeight) return 1.0;
    float lg = max(lodGlobal, uShadeLodGlobal);
    float lr = max(lodRegion, uShadeLodRegion);
    vec2 s = inRegion
      ? max(uShadeStepRegion, exp2(lr) / (uHeightSizeRegion * regionScale))
      : max(uShadeStepGlobal, exp2(lg) / uHeightSizeGlobal);
    float dx = heightAt(vUv + vec2(s.x, 0.0), lg, lr) - heightAt(vUv - vec2(s.x, 0.0), lg, lr);
    float dy = heightAt(vUv + vec2(0.0, s.y), lg, lr) - heightAt(vUv - vec2(0.0, s.y), lg, lr);
    // Normal ~ (-dx, -dy, 1) with x east and y north; light towards the north-west (-1, 1).
    return clamp(1.0 + uReliefShade * 0.7 * (dx - dy), 0.7, 1.25);
  }

  // Fades from one instant of the layer to the next, weighting each colour by its
  // own opacity so a transparent pixel adds no colour of its own.
  vec4 blendFrames(vec4 a, vec4 b, float m) {
    float alpha = mix(a.a, b.a, m);
    vec3 rgb = (a.rgb * a.a * (1.0 - m) + b.rgb * b.a * m) / max(alpha, 1e-4);
    return vec4(rgb, alpha);
  }

  void main() {
    float lon = -180.0 + 360.0 * vUv.x;
    float lat = -90.0 + 180.0 * vUv.y;
    bool inRegion = lon >= uBbox.x && lon <= uBbox.z && lat >= uBbox.y && lat <= uBbox.w;
    // Levels of detail of both height textures, worked out here, outside any
    // branch, because screen-space derivatives are undefined inside one.
    vec2 duvx = dFdx(vUv);
    vec2 duvy = dFdy(vUv);
    vec2 regionScale = vec2(360.0 / (uBbox.z - uBbox.x), 180.0 / (uBbox.w - uBbox.y));
    float lodGlobal = lodOf(duvx, duvy, uHeightSizeGlobal);
    float lodRegion = lodOf(duvx * regionScale, duvy * regionScale, uHeightSizeRegion);
    // Dots image: sampled under a uniform condition only, so the GPU picks the
    // mipmap level and filters anisotropically (sharp up close, steady when turning).
    float dotValue = 0.0;
    float dotGlow = 0.0;
    if (uHasDotImage) {
      vec2 dotUv = vec2(vUv.x, 1.0 - vUv.y);
      dotValue = texture2D(uDotImage, dotUv).r;
      dotGlow = texture2D(uDotImage, dotUv, uGlowBias).r;
    }
    vec3 color = uHasBase ? texture2D(uBase, vUv).rgb : vec3(0.04, 0.11, 0.23);
    if (inRegion && uHasRegionBase) {
      // Same calculation as regionUv() in geo.ts: v grows northwards like an image texture.
      vec2 cropUv = vec2((lon - uBbox.x) / (uBbox.z - uBbox.x), (lat - uBbox.y) / (uBbox.w - uBbox.y));
      color = texture2D(uRegionBase, cropUv).rgb;
    }
    // Some layers (lightning, like NASA SVS 5011) dim the planet to dark grey so they stand out.
    float grey = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(grey * 0.5), uBaseDim);
    vec4 overlay = vec4(0.0);
    if (uColorFromHeight) {
      // Sharp forest images: colour and presence straight from the height.
      float h = heightAt(vUv, lodGlobal, lodRegion);
      overlay = vec4(colorbar(h), clamp((h - uPresence.x) / uPresence.y, 0.0, 1.0));
    } else if (uHasDotImage) {
      // Sharp lightning dots, on the planet and in the Amazon alike (the image is finer than the regional grid).
      overlay = vec4(colorbar(dotValue), clamp((dotValue - uPresence.x) / uPresence.y, 0.0, 1.0));
    } else if (inRegion) {
      // Inside the Amazon: the detailed regional grid (north row first).
      vec2 regionUv = vec2((lon - uBbox.x) / (uBbox.z - uBbox.x), (uBbox.w - lat) / (uBbox.w - uBbox.y));
      overlay = blendFrames(texture2D(uLayerRegion, regionUv), texture2D(uLayerRegionNext, regionUv), uFrameMix);
    } else if (uHasGlobal) {
      vec2 globalUv = vec2(vUv.x, 1.0 - vUv.y);
      overlay = blendFrames(texture2D(uLayerGlobal, globalUv), texture2D(uLayerGlobalNext, globalUv), uFrameMix);
    }
    float layerAmount = overlay.a * uLayerOpacity;
    color = mix(color, overlay.rgb, layerAmount);
    // The relief shading applies where the layer is drawn, not to the base image around it.
    color *= mix(1.0, reliefShade(inRegion, lodGlobal, lodRegion, regionScale), layerAmount);
    // Soft glow where the dots are dense (0 without a dots image).
    color += uGlowColor * (dotGlow * uGlow);
    color *= vShade;
    if (uShowRegions > 0.5) {
      // Every region gets a soft border; the one under the cursor a light tint and
      // a stronger, wider border. A pixel is on the border when a neighbour a few
      // pixels away (on screen) belongs to another region or to none.
      vec2 maskUv = vec2(vUv.x, 1.0 - vUv.y);
      float here = regionAt(maskUv);
      if (here > 0.5) {
        bool hovered = abs(here - uHoverRegion) < 0.5;
        // At most one degree: near the planet's edge the screen derivatives grow
        // without bound and would paint whole bands of the region as border.
        vec2 reach = min((abs(duvx) + abs(duvy)) * (hovered ? 2.2 : 1.5), vec2(1.0 / 360.0, 1.0 / 180.0));
        float outside = 0.0;
        outside += step(0.5, abs(regionAt(maskUv + vec2(reach.x, 0.0)) - here));
        outside += step(0.5, abs(regionAt(maskUv - vec2(reach.x, 0.0)) - here));
        outside += step(0.5, abs(regionAt(maskUv + vec2(0.0, reach.y)) - here));
        outside += step(0.5, abs(regionAt(maskUv - vec2(0.0, reach.y)) - here));
        if (hovered) {
          color = outside > 0.0 ? vec3(0.65, 1.0, 0.85) : mix(color, vec3(0.2, 0.9, 0.6), 0.2);
        } else if (outside > 0.0) {
          color = mix(color, vec3(0.55, 0.95, 0.8), 0.8);
        }
      }
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;

/** Grid of vertices from the north-west corner: sphere in `position`, flat map (centred on 0°, 0°) in `aPlane`. */
function buildMorphGeometry(columns: number, rows: number): BufferGeometry {
  const count = (columns + 1) * (rows + 1);
  const spherePositions = new Float32Array(count * 3);
  const planePositions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    const lat = 90 - 180 * v;
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      const lon = -180 + 360 * u;
      const index = row * (columns + 1) + column;
      const sphere = lonLatToSpherePoint(lon, lat);
      const plane = lonLatToPlanePoint(lon, lat);
      spherePositions.set([sphere.x, sphere.y, sphere.z], index * 3);
      planePositions.set([plane.x, plane.y, GLOBE_RADIUS], index * 3);
      uvs.set([u, 1 - v], index * 2);
    }
  }

  const indices: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = row * (columns + 1) + column;
      const b = a + columns + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(spherePositions, 3));
  geometry.setAttribute("aPlane", new BufferAttribute(planePositions, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

interface Uniforms {
  [name: string]: IUniform;
  uRotation: IUniform<Matrix3>;
  uFlatten: IUniform<number>;
  uBase: IUniform<Texture | null>;
  uHasBase: IUniform<boolean>;
  uRegionBase: IUniform<Texture | null>;
  uHasRegionBase: IUniform<boolean>;
  uLayerGlobal: IUniform<Texture | null>;
  uHasGlobal: IUniform<boolean>;
  uLayerRegion: IUniform<Texture | null>;
  uLayerGlobalNext: IUniform<Texture | null>;
  uLayerRegionNext: IUniform<Texture | null>;
  uFrameMix: IUniform<number>;
  uBbox: IUniform<Vector4>;
  uLayerOpacity: IUniform<number>;
  uBaseDim: IUniform<number>;
  uHeightGlobal: IUniform<Texture | null>;
  uHeightRegion: IUniform<Texture | null>;
  uHasHeight: IUniform<boolean>;
  uHasHeightGlobal: IUniform<boolean>;
  uLift: IUniform<number>;
  uLiftLodGlobal: IUniform<number>;
  uLiftLodRegion: IUniform<number>;
  uReliefShade: IUniform<number>;
  uHeightSizeGlobal: IUniform<Vector2>;
  uHeightSizeRegion: IUniform<Vector2>;
  uShadeStepGlobal: IUniform<Vector2>;
  uShadeStepRegion: IUniform<Vector2>;
  uShadeLodGlobal: IUniform<number>;
  uShadeLodRegion: IUniform<number>;
  uColorFromHeight: IUniform<boolean>;
  uColorbar: IUniform<Float32Array>;
  uPresence: IUniform<Vector2>;
  uDotImage: IUniform<Texture | null>;
  uHasDotImage: IUniform<boolean>;
  uGlow: IUniform<number>;
  uGlowBias: IUniform<number>;
  uGlowColor: IUniform<Vector3>;
  uPlaneShift: IUniform<Vector2>;
  uRegionMask: IUniform<Texture | null>;
  uHoverRegion: IUniform<number>;
  uShowRegions: IUniform<number>;
}

/** Width and height in texels of a loaded texture (image or data), null when unknown. */
function textureSize(texture: Texture | null): { width: number; height: number } | null {
  const image = texture?.image as { width?: unknown; height?: unknown } | undefined;
  if (!image || typeof image.width !== "number" || typeof image.height !== "number") return null;
  if (!(image.width > 0) || !(image.height > 0)) return null;
  return { width: image.width, height: image.height };
}

export function EarthMesh({
  baseTexture,
  regionBaseTexture,
  layerTextures,
  bbox,
  focusBbox,
  regionMask,
  regionAt,
  hoverRegion,
  view,
  mode,
  segments,
  raiseRelief,
  autoRotate,
  frameMix,
  reliefImages,
  dotImage,
  scenes,
  onSceneSelect,
  onSceneHover,
  selectedPoint,
  hoverPoint,
  onHover,
  onGlobeSelectPoint,
  onGlobeFocusRegion,
  onMapBack,
  onGlobeTap,
  onMapTap,
  onOverviewField,
}: EarthMeshProps) {
  const gl = useThree((state) => state.gl);
  const pickGroup = useRef<Group>(null);
  const sphereMesh = useRef<Mesh>(null);
  const planeMesh = useRef<Mesh>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const planeDown = useRef<{ x: number; y: number } | null>(null);
  const clickTimer = useRef<number | null>(null);
  const overviewSince = useRef(0);
  const overviewNdc = useMemo(() => new Vector2(), []);
  // Where the cursor rests over the canvas, so the point under it can be found
  // again while the planet turns or a transition ends beneath a still cursor.
  const pointerRef = useRef<{ inside: boolean; clientX: number; touch: boolean }>({ inside: false, clientX: 0, touch: false });
  // Whether the last press on the planet or the map was a finger: taps then select and
  // visit regions, and the browser's double-click (and double-tap zoom) are ignored.
  const lastPressTouch = useRef(false);
  const sinceHoverRefresh = useRef(0);
  // True while the last report to the scene was a point (not "nothing under the cursor").
  const reportedPoint = useRef(false);

  const uniforms = useMemo<Uniforms>(
    () => ({
      uRotation: { value: new Matrix3() },
      uFlatten: { value: 0 },
      uBase: { value: null },
      uHasBase: { value: false },
      uRegionBase: { value: null },
      uHasRegionBase: { value: false },
      uLayerGlobal: { value: null },
      uHasGlobal: { value: false },
      uLayerRegion: { value: null },
      uLayerGlobalNext: { value: null },
      uLayerRegionNext: { value: null },
      uFrameMix: { value: 0 },
      uBbox: { value: new Vector4() },
      uLayerOpacity: { value: 0.8 },
      uBaseDim: { value: 0 },
      uHeightGlobal: { value: null },
      uHeightRegion: { value: null },
      uHasHeight: { value: false },
      uHasHeightGlobal: { value: false },
      uLift: { value: 0 },
      uLiftLodGlobal: { value: 0 },
      uLiftLodRegion: { value: 0 },
      uReliefShade: { value: RELIEF_SHADE },
      uHeightSizeGlobal: { value: new Vector2(1, 1) },
      uHeightSizeRegion: { value: new Vector2(1, 1) },
      uShadeStepGlobal: { value: new Vector2() },
      uShadeStepRegion: { value: new Vector2() },
      uShadeLodGlobal: { value: 0 },
      uShadeLodRegion: { value: 0 },
      uColorFromHeight: { value: false },
      uColorbar: { value: new Float32Array(SHADER_STOPS * 3) },
      uPresence: { value: new Vector2(0, 1) },
      uDotImage: { value: null },
      uHasDotImage: { value: false },
      uGlow: { value: 0 },
      uGlowBias: { value: 0 },
      uGlowColor: { value: new Vector3() },
      uPlaneShift: { value: new Vector2() },
      uRegionMask: { value: null },
      uHoverRegion: { value: 0 },
      uShowRegions: { value: 0 },
    }),
    [],
  );
  const material = useMemo(
    () => new ShaderMaterial({ uniforms, vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER, side: DoubleSide }),
    [uniforms],
  );
  useEffect(() => () => material.dispose(), [material]);

  const geometry = useMemo(
    () => buildMorphGeometry(segments.width, segments.height),
    [segments.width, segments.height],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(() => {
    uniforms.uBase.value = baseTexture;
    uniforms.uHasBase.value = baseTexture !== null;
    uniforms.uRegionBase.value = regionBaseTexture;
    uniforms.uHasRegionBase.value = regionBaseTexture !== null;
    uniforms.uLayerGlobal.value = layerTextures.global;
    uniforms.uHasGlobal.value = layerTextures.global !== null;
    uniforms.uLayerRegion.value = layerTextures.region;
    uniforms.uLayerGlobalNext.value = layerTextures.globalNext;
    uniforms.uLayerRegionNext.value = layerTextures.regionNext;
    uniforms.uBbox.value.set(bbox.west, bbox.south, bbox.east, bbox.north);
    uniforms.uLayerOpacity.value = layerTextures.opacity;
    uniforms.uBaseDim.value = layerTextures.baseDim;
    // A layer with sharp images (the forest heights, CO2) draws from them once they
    // are there, from its own grids before that or when they failed to load. Only
    // heights are shaded and raised.
    const sharp = reliefImages !== null;
    const relief = sharp ? reliefImages.relief : layerTextures.heightRegion !== null;
    const heightGlobal = sharp ? reliefImages.global : layerTextures.heightGlobal;
    const heightRegion = sharp ? reliefImages.region : layerTextures.heightRegion;
    uniforms.uHeightGlobal.value = heightGlobal;
    uniforms.uHeightRegion.value = heightRegion;
    uniforms.uHasHeight.value = heightRegion !== null;
    uniforms.uHasHeightGlobal.value = heightGlobal !== null;
    uniforms.uColorFromHeight.value = sharp;
    if (sharp) {
      uniforms.uColorbar.value = shaderColorbar(reliefImages.ramp);
      uniforms.uPresence.value.set(...shaderPresence(reliefImages.ramp));
    }
    // A layer with a dots image (lightning) draws from it once it is there, from its grids before that.
    const dots = sharp ? null : dotImage;
    uniforms.uDotImage.value = dots?.texture ?? null;
    uniforms.uHasDotImage.value = dots !== null;
    uniforms.uGlow.value = dots?.style.glow.strength ?? 0;
    uniforms.uGlowBias.value = dots?.style.glow.lodBias ?? 0;
    if (dots) {
      uniforms.uColorbar.value = shaderColorbar(dots.style.ramp);
      uniforms.uPresence.value.set(...shaderPresence(dots.style.ramp));
      uniforms.uGlowColor.value.set(...glowColor(dots.style.ramp));
    }

    // Texel sizes in degrees (global textures cover 360 x 180, the Amazon ones the rectangle).
    const globalSize = textureSize(heightGlobal);
    const regionSize = textureSize(heightRegion);
    const globalCell = globalSize ? 360 / globalSize.width : 0;
    const regionCell = regionSize ? (bbox.east - bbox.west) / regionSize.width : 0;
    uniforms.uHeightSizeGlobal.value.set(globalSize?.width ?? 1, globalSize?.height ?? 1);
    uniforms.uHeightSizeRegion.value.set(regionSize?.width ?? 1, regionSize?.height ?? 1);

    // Shaded relief: a fixed step in degrees (one texel on the coarser grids), in planet texture units.
    const stepGlobal = shadeStepDegrees(SHADE_STEP_GLOBAL_DEGREES, globalCell);
    const stepRegion = shadeStepDegrees(SHADE_STEP_REGION_DEGREES, regionCell);
    uniforms.uShadeStepGlobal.value.set(stepGlobal / 360, stepGlobal / 180);
    uniforms.uShadeStepRegion.value.set(stepRegion / 360, stepRegion / 180);
    uniforms.uShadeLodGlobal.value = lodForSpacing(stepGlobal, globalCell);
    uniforms.uShadeLodRegion.value = lodForSpacing(stepRegion, regionCell);

    // Raised height: sample one mean height per vertex (the mesh has `segments.width` columns over 360 degrees).
    uniforms.uLift.value = relief && raiseRelief ? RELIEF_LIFT : 0;
    // Shaded relief only for heights; other sharp values (CO2) keep the surface evenly lit.
    uniforms.uReliefShade.value = relief ? RELIEF_SHADE : 0;
    const vertexSpacing = 360 / segments.width;
    uniforms.uLiftLodGlobal.value = lodForSpacing(vertexSpacing, globalCell);
    uniforms.uLiftLodRegion.value = lodForSpacing(vertexSpacing, regionCell);
  }, [uniforms, baseTexture, regionBaseTexture, layerTextures, reliefImages, dotImage, bbox, raiseRelief, segments.width]);

  const center = bboxCenter(focusBbox);
  const shift = lonLatToPlanePoint(center.lon, center.lat);
  useEffect(() => {
    uniforms.uPlaneShift.value.set(shift.x, shift.y);
  }, [uniforms, shift.x, shift.y]);
  useEffect(() => {
    uniforms.uRegionMask.value = regionMask;
    // Outlines only on the planet: they go away while flying to a region and on its map.
    const onPlanet = regionMask !== null && mode === "globe";
    uniforms.uShowRegions.value = onPlanet ? 1 : 0;
    uniforms.uHoverRegion.value = onPlanet && hoverRegion !== null ? hoverRegion + 1 : 0;
  }, [uniforms, regionMask, hoverRegion, mode]);

  // Dragging follows the pointer anywhere on the page once it started on the planet.
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const state = view.current;
      state.yaw = drag.yaw + (event.clientX - drag.x) * DRAG_SPEED;
      state.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, drag.pitch + (event.clientY - drag.y) * DRAG_SPEED));
    };
    const end = () => {
      dragRef.current = null;
      planeDown.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [view]);

  useEffect(() => {
    if (mode !== "globe") dragRef.current = null;
    gl.domElement.style.cursor = "";
  }, [mode, gl]);

  // Fingers on the planet turn it and tap regions: no page scroll or double-tap zoom.
  useEffect(() => {
    const canvas = gl.domElement;
    const before = canvas.style.touchAction;
    canvas.style.touchAction = "none";
    return () => {
      canvas.style.touchAction = before;
    };
  }, [gl]);

  const euler = useMemo(() => new Euler(0, 0, 0, "XYZ"), []);
  const rotation = useMemo(() => new Matrix4(), []);
  useFrame((_, delta) => {
    const state = view.current;
    state.yaw = spinStep(state.yaw, delta, {
      spinning: state.spinning,
      autoRotate,
      mode,
      dragging: dragRef.current !== null,
    });
    uniforms.uFrameMix.value = frameMix?.current ?? 0;
    euler.set(state.pitch, state.yaw, 0);
    rotation.makeRotationFromEuler(euler);
    uniforms.uRotation.value.setFromMatrix4(rotation);
    uniforms.uFlatten.value = state.flatten;
    pickGroup.current?.rotation.copy(euler);
  });

  // Remember whether the cursor is over the canvas and where, for the lookup below.
  useEffect(() => {
    const canvas = gl.domElement;
    const move = (event: PointerEvent) => {
      pointerRef.current = { inside: true, clientX: event.clientX, touch: event.pointerType === "touch" };
    };
    const leave = () => {
      pointerRef.current = { ...pointerRef.current, inside: false };
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    return () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
    };
  }, [gl]);

  const sphereLonLat = (world: Vector3) => {
    const group = pickGroup.current;
    if (!group) return null;
    const local = group.worldToLocal(world.clone());
    return spherePointToLonLat(local.x, local.y, local.z);
  };

  const emit = (hit: GlobeHit | null) => {
    reportedPoint.current = hit !== null;
    onHover(hit);
  };

  const reportSphere = (world: Vector3, clientX: number) => {
    const point = sphereLonLat(world);
    if (!point) return;
    gl.domElement.style.cursor = regionAt(point.lon, point.lat) !== null ? "pointer" : "grab";
    emit({ ...point, clientX, touch: pointerRef.current.touch });
  };

  const reportPlane = (uvX: number, uvY: number, clientX: number) => {
    // PlaneGeometry's texture v grows northwards; planeUvToLonLat counts from the north.
    emit({ ...planeUvToLonLat(uvX, 1 - uvY), clientX, touch: pointerRef.current.touch });
  };

  // Sample a small screen grid over the visible globe or region map. It uses
  // screen space, so the column on the right is the column heard on the right,
  // and raycasting naturally leaves out the part of the grid off the surface.
  useFrame((state, delta) => {
    if (!onOverviewField) return;
    const globe = mode === "globe";
    const map = mode === "map";
    if (!globe && !map) {
      overviewSince.current = 0;
      return;
    }
    overviewSince.current += delta;
    if (overviewSince.current < 0.1) return;
    overviewSince.current = 0;
    const sphere = globe ? sphereMesh.current : null;
    const plane = map ? planeMesh.current : null;
    const target = sphere ?? plane;
    if (!target) return;
    target.updateMatrixWorld(true);
    pickGroup.current?.updateMatrixWorld(true);

    const columns: VisibleColumn[] = [];
    for (let column = 0; column < OVERVIEW_COLUMNS; column += 1) {
      const screenX = (column + 0.5) / OVERVIEW_COLUMNS;
      const cells: (VisibleCell | null)[] = [];
      for (let row = 0; row < OVERVIEW_ROWS; row += 1) {
        const screenY = (row + 0.5) / OVERVIEW_ROWS;
        overviewNdc.set(screenX * 2 - 1, 1 - screenY * 2);
        state.raycaster.setFromCamera(overviewNdc, state.camera);
        const hit = state.raycaster.intersectObject(target, false)[0];
        const point = sphere
          ? hit
            ? sphereLonLat(hit.point)
            : null
          : hit?.uv
            ? planeUvToLonLat(hit.uv.x, 1 - hit.uv.y)
            : null;
        cells.push(point ? { lon: point.lon, lat: point.lat, screenX, screenY } : null);
      }
      columns.push({ screenX, cells });
    }
    onOverviewField(columns);
  });

  useEffect(() => {
    if (mode !== "globe" && mode !== "map") onOverviewField?.(null);
  }, [mode, onOverviewField]);

  // Browsers only send pointer events when the mouse moves. While the planet
  // turns, or when a transition ends under a still cursor, look the point up
  // again a few times a second so the sound follows what is under the cursor.
  useFrame((state, delta) => {
    sinceHoverRefresh.current += delta;
    if (sinceHoverRefresh.current < HOVER_REFRESH_SECONDS) return;
    sinceHoverRefresh.current = 0;
    const { inside, clientX } = pointerRef.current;
    if (!inside) {
      // The cursor left the canvas while the scene was ignoring hovers (a transition).
      if (reportedPoint.current) emit(null);
      return;
    }
    state.raycaster.setFromCamera(state.pointer, state.camera);
    if (mode === "globe" && sphereMesh.current) {
      pickGroup.current?.updateMatrixWorld(true);
      const hit = state.raycaster.intersectObject(sphereMesh.current, false)[0];
      if (hit) reportSphere(hit.point, clientX);
      else emit(null);
    } else if (mode === "map" && planeMesh.current) {
      planeMesh.current.updateMatrixWorld(true);
      const hit = state.raycaster.intersectObject(planeMesh.current, false)[0];
      if (hit?.uv) reportPlane(hit.uv.x, hit.uv.y, clientX);
      else emit(null);
    }
  });

  const clearClickTimer = () => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
  };

  useEffect(() => clearClickTimer, []);

  const handleSphereMove = (event: ThreeEvent<PointerEvent>) => {
    reportSphere(event.point, event.nativeEvent.clientX);
  };

  const handleSphereDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    clearClickTimer();
    lastPressTouch.current = event.nativeEvent.pointerType === "touch";
    // The general view rotates the planet; selecting a listening point belongs
    // to the region map, so a drag here never scrubs a point.
    const state = view.current;
    dragRef.current = { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY, yaw: state.yaw, pitch: state.pitch };
  };

  const handleSphereDoubleClick = (event: ThreeEvent<MouseEvent>) => {
    clearClickTimer();
    if (lastPressTouch.current || event.delta > CLICK_TOLERANCE_PX) return;
    const point = sphereLonLat(event.point);
    if (point) onGlobeFocusRegion(point.lon, point.lat);
  };

  const handleSphereClick = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > CLICK_TOLERANCE_PX) return;
    // Touch screens keep the region flow: one tap chooses, the next visits.
    if (!lastPressTouch.current) return;
    const point = sphereLonLat(event.point);
    if (point) onGlobeTap(point.lon, point.lat);
  };

  const handlePlaneDown = (event: ThreeEvent<PointerEvent>) => {
    clearClickTimer();
    lastPressTouch.current = event.nativeEvent.pointerType === "touch";
    planeDown.current = { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY };
  };

  const handlePlaneClick = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > CLICK_TOLERANCE_PX) return;
    if (!event.uv) return;
    const point = planeUvToLonLat(event.uv.x, 1 - event.uv.y);
    const clientX = event.nativeEvent.clientX;
    // Touch screens keep their double-tap flow; a tap still selects the point.
    if (lastPressTouch.current) {
      onGlobeSelectPoint(point.lon, point.lat, clientX);
      onMapTap();
      return;
    }
    // Wait: a second click cancels this timer and returns to the planet instead.
    if (event.nativeEvent.detail > 1) {
      clearClickTimer();
      return;
    }
    clearClickTimer();
    const { lon, lat } = point;
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      onGlobeSelectPoint(lon, lat, clientX);
    }, SINGLE_CLICK_MS);
  };

  const handlePlaneMove = (event: ThreeEvent<PointerEvent>) => {
    if (!event.uv) return;
    const clientX = event.nativeEvent.clientX;
    reportPlane(event.uv.x, event.uv.y, clientX);
    const down = planeDown.current;
    if (!down) return;
    if (Math.hypot(clientX - down.x, event.nativeEvent.clientY - down.y) <= CLICK_TOLERANCE_PX) return;
    const point = planeUvToLonLat(event.uv.x, 1 - event.uv.y);
    onGlobeSelectPoint(point.lon, point.lat, clientX);
  };

  const handlePlaneDoubleClick = (event: ThreeEvent<MouseEvent>) => {
    clearClickTimer();
    if (lastPressTouch.current || event.delta > CLICK_TOLERANCE_PX) return;
    onMapBack();
  };

  const handleOut = () => {
    gl.domElement.style.cursor = "";
    emit(null);
  };

  return (
    <>
      <mesh geometry={geometry} material={material} frustumCulled={false} />

      {mode === "globe" && (
        <group ref={pickGroup}>
          <mesh
            ref={sphereMesh}
            onPointerMove={handleSphereMove}
            onPointerDown={handleSphereDown}
            onClick={handleSphereClick}
            onDoubleClick={handleSphereDoubleClick}
            onPointerOut={handleOut}
          >
            <sphereGeometry args={[GLOBE_RADIUS * 1.002, 64, 32]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <LocationMarkers mode="globe" selectedPoint={selectedPoint} hoverPoint={hoverPoint} />
        </group>
      )}

      {mode === "map" && (
        <>
          <mesh
            ref={planeMesh}
            position={[-shift.x, -shift.y, GLOBE_RADIUS]}
            onPointerMove={handlePlaneMove}
            onPointerDown={handlePlaneDown}
            onClick={handlePlaneClick}
            onDoubleClick={handlePlaneDoubleClick}
            onPointerOut={handleOut}
          >
            <planeGeometry args={[PLANE_WIDTH, PLANE_HEIGHT]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <LocationMarkers mode="map" bbox={focusBbox} selectedPoint={selectedPoint} hoverPoint={hoverPoint} />
          {scenes && scenes.length > 0 && onSceneSelect && (
            <SceneMarkers
              scenes={scenes}
              bbox={bbox}
              onSelect={onSceneSelect}
              onHover={onSceneHover ?? (() => {})}
            />
          )}
        </>
      )}
    </>
  );
}
