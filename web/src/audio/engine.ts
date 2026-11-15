// Real-time sound engine (plan Step 10).
//
// Headless by design: it owns the Web Audio graph and exposes a small API that
// the scene and the controls (Steps 12-14) call. Nothing here reads the data
// grids; the scene samples a place and a time and passes a value in 0..1, or
// null where the layer has no data.
//
// Blocks B1 (forest voice) and B2 (smoke and CO2 voices, three-layer mix) are
// implemented here. Block B3 is manual tuning and measurement.

import { LAYER_IDS, type LayerId } from "../data/types";
import { clampUnit, co2ToBreath, forestToVoice, intensityToGain, lightningToPercussion, positionToPan, smokeToTimbre } from "./mapping";
import {
  OVERVIEW_BASE_HZ,
  OVERVIEW_COLUMNS,
  OVERVIEW_INSTRUMENTS,
  OVERVIEW_LAYER_GAIN,
  OVERVIEW_ROWS,
  REGIONAL_ENRICHMENT,
  pitchForValue,
  type OverviewColumn,
} from "./overview";
import { TEMPO_STYLES, lightningBpm } from "./tempo";
import { DEFAULT_SMOOTHING_SECONDS, OnePoleSmoother } from "./smoothing";

export type SoundEngineState = "idle" | "running" | "suspended";

export interface SoundEngine {
  readonly state: SoundEngineState;
  /** Resolves once the AudioContext is running. Must be called from a user gesture. */
  start(): Promise<void>;
  stop(): void;
  /** value in 0..1, or null where the layer has no data. */
  setLayerIntensity(layer: LayerId, value: number | null): void;
  setLayerEnabled(layer: LayerId, enabled: boolean): void;
  /** Horizontal position across the listened area, 0 (left) .. 1 (right). */
  setPan(horizontal: number): void;
  /** Replaces the overview field; the scan reads it while enabled. */
  setOverview(layer: LayerId | null, columns: readonly OverviewColumn[] | null): void;
  /** Starts or stops the visible-area field. */
  setOverviewEnabled(enabled: boolean): void;
  /** Adds or removes the randomly spaced forest bird samples. */
  setForestBirds(enabled: boolean): void;
  /** Plays one data-time mark for a timed layer. */
  playTempoBeat(layer: LayerId): void;
  /** One regional note: layer value -> pitch in the visible range, selected screen x -> pan. */
  setRegionalPoint(
    layer: LayerId | null,
    value: number | null,
    horizontal: number,
    range?: { min: number; max: number },
  ): void;
  setMasterVolume(value: number): void;
  /** Current output level in 0..1, for a meter. */
  getOutputLevel(): number;
  /** Device latency reported by the context, in milliseconds (base + output). */
  getLatencyMs(): number;
  /** Plays the scene transition one-shot (ARPA). */
  playSceneTransition(url: string): Promise<void>;
  /** Starts or replaces the scene loop; it fades from 0 to `gain`. */
  playSceneLoop(url: string, options?: { gain?: number; fadeInSeconds?: number }): Promise<void>;
  /** Stops the scene loop with a short fade. */
  stopSceneLoop(options?: { fadeOutSeconds?: number }): void;
  /** Stops the transition and the loop (closing the popup). */
  stopSceneAudio(): void;
  /** Ducks the data voices; 1 restores them. */
  setDataVoiceDuck(amount: number, seconds?: number): void;
  dispose(): void;
}

export interface SoundEngineOptions {
  /** Injected context, for tests and for hosts that already own one. */
  context?: AudioContext;
  /** Time an audible parameter takes to settle after a change, in seconds. */
  rampSeconds?: number;
  /** Time constant of the one-pole input smoother, in seconds. */
  smoothingSeconds?: number;
  /** Thunder sample for the lightning layer; `null` keeps the synthesized hit. */
  lightningSampleUrl?: string | null;
  /** Injected sample buffer (tests); skips the network. */
  lightningSample?: AudioBuffer | null;
  /** Forest bird sample; `null` disables the ambience. */
  birdSampleUrl?: string | null;
  /** Injected bird sample (tests); skips the network. */
  birdSample?: AudioBuffer | null;
  /** Random source for bird spacing and excerpt offsets (tests). */
  random?: () => number;
  /** Loader injection for tests; defaults to `fetch`. */
  fetchSample?: (url: string) => Promise<ArrayBuffer>;
}

const DEFAULT_RAMP_SECONDS = 0.05;
const DEFAULT_VOLUME = 0.8;
const START_FADE_SECONDS = 0.2;
const STOP_FADE_SECONDS = 0.2;
const SETTLE_MS = 250;
/** When the rate rises by more than this, the pending hit is moved earlier. */
const LIGHTNING_RATE_RESCHEDULE = 0.05;
/** Thunder sample prepared by tools/audio/prepare.py from TORMENTA ALBERT.wav. */
export const DEFAULT_LIGHTNING_SAMPLE_URL = "./audio/samples/tormenta-albert.ogg";
/** Excerpt starts (seconds) cycled through so repeated hits do not sound identical. */
const LIGHTNING_SAMPLE_OFFSETS = [0.15, 4.25, 6.25, 8.25];
const LIGHTNING_SAMPLE_GAIN = 0.9;
const LIGHTNING_SAMPLE_ATTACK = 0.008;
/** How long one thunder hit rings; new hits stack under it instead of cutting it. */
export const LIGHTNING_SAMPLE_TAIL_SECONDS = 2.4;
/** Fade the very end of the excerpt so stopping it does not click. */
const LIGHTNING_SAMPLE_FADE_OUT = 0.25;
const FOREST_HARMONY_MIX = 0.35;
const FOREST_LOWPASS_HZ = 4000;
const SMOKE_TONE_HZ = 180;
const CO2_NOISE_MIX = 0.5;
const NOISE_SECONDS = 2;
const SCENE_TRANSITION_GAIN = 0.9;
const SCENE_TRANSITION_FADE_OUT_SECONDS = 0.4;
const SCENE_LOOP_GAIN_MULTIPLIER = 2;
const SCENE_LOOP_MAX_GAIN = 2;
const SCENE_FADE_IN_SECONDS = 0.5;
const SCENE_FADE_OUT_SECONDS = 0.3;
const OVERVIEW_BUS_GAIN = 0.75;
const OVERVIEW_COLUMN_HEADROOM = 0.9;
/** Existing forest recording used as a sparse bird ambience. */
export const FOREST_BIRD_SAMPLE_URL = "./audio/samples/oajaros-suaves.ogg";
const BIRD_BUS_GAIN = 0.55;
const BIRD_FIRST_DELAY_MIN_SECONDS = 1;
const BIRD_FIRST_DELAY_MAX_SECONDS = 4;
const BIRD_GAP_MIN_SECONDS = 6;
const BIRD_GAP_MAX_SECONDS = 14;
const BIRD_EXCERPT_MIN_SECONDS = 2;
const BIRD_EXCERPT_MAX_SECONDS = 5;
const BIRD_GAIN = 0.7;
const BIRD_ATTACK_SECONDS = 0.04;
const BIRD_FADE_SECONDS = 0.25;
const REGIONAL_POINT_GAIN = 0.35;

/**
 * Per-layer output trim. The smoke voice is mostly filtered noise and a low
 * tone, so at equal gain the two-oscillator forest masks it. Raising its level
 * keeps it audible in the three-layer mix (B3 listening feedback).
 */
export const SMOKE_LAYER_TRIM = 1.6;
const LAYER_TRIM: Record<LayerId, number> = { forest: 1, smoke: SMOKE_LAYER_TRIM, co2: 1, lightning: 1 };

interface ForestVoice {
  main: OscillatorNode;
  harmony: OscillatorNode;
  harmonyGain: GainNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode;
}

interface SmokeVoice {
  noiseGain: GainNode;
  tone: OscillatorNode;
  toneGain: GainNode;
  filter: BiquadFilterNode;
  tremolo: GainNode;
  tremoloDepth: GainNode;
  lfo: OscillatorNode;
  gain: GainNode;
  panner: StereoPannerNode;
}

interface Co2Voice {
  noiseGain: GainNode;
  tone: OscillatorNode;
  toneGain: GainNode;
  filter: BiquadFilterNode;
  breath: GainNode;
  breathDepth: GainNode;
  lfo: OscillatorNode;
  gain: GainNode;
  panner: StereoPannerNode;
}

/**
 * The lightning layer is percussion, not a continuous voice: it owns only a
 * level and a panner, and each hit builds short-lived nodes on demand.
 */
interface LightningVoice {
  gain: GainNode;
  panner: StereoPannerNode;
}

interface OverviewColumnVoice {
  oscillators: OscillatorNode[];
  gains: GainNode[];
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
}

interface OverviewGraph {
  columns: OverviewColumnVoice[];
  bus: GainNode;
}

interface OverviewState {
  layer: LayerId | null;
  columns: readonly OverviewColumn[];
  enabled: boolean;
}

interface RegionalFx {
  dry: GainNode;
  chorusSend: GainNode;
  chorusDelay: DelayNode;
  chorusWet: GainNode;
  chorusLfo: OscillatorNode;
  chorusDepth: GainNode;
  reverbSend: GainNode;
  reverb: ConvolverNode;
  reverbWet: GainNode;
}

interface RegionalVoice {
  oscillators: OscillatorNode[];
  oscillatorGains: GainNode[];
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode;
  fx: RegionalFx;
  sampleSource: AudioBufferSourceNode | null;
  sampleFilter: BiquadFilterNode | null;
  sampleGain: GainNode | null;
  sampleLayer: LayerId | null;
  sampleToken: number;
}

interface RegionalState {
  layer: LayerId | null;
  value: number | null;
  pan: number;
  min: number;
  max: number;
}

interface EngineGraph {
  noise: AudioBufferSourceNode;
  /** Layer voices (forest, smoke, CO2, lightning) connect here. */
  bus: GainNode;
  /** Scene transition and loop connect here, so they are not ducked with the data. */
  sceneBus: GainNode;
  limiter: DynamicsCompressorNode;
  master: GainNode;
  analyser: AnalyserNode;
  forest: ForestVoice;
  smoke: SmokeVoice;
  co2: Co2Voice;
  lightning: LightningVoice;
}

interface LightningHit {
  stop(): void;
}

interface LayerRuntime {
  value: number | null;
  enabled: boolean;
  smoother: OnePoleSmoother;
  lastUpdateTime: number;
  settleTimer: ReturnType<typeof setTimeout> | undefined;
}

function makeLayerRuntime(): LayerRuntime {
  return { value: null, enabled: true, smoother: new OnePoleSmoother(0), lastUpdateTime: 0, settleTimer: undefined };
}

/** Schedules a glide; setTargetAtTime reaches ~95% of the distance in 3 time constants. */
function rampParameter(parameter: AudioParam, target: number, now: number, rampSeconds: number): void {
  parameter.setTargetAtTime(target, now, Math.max(0.005, rampSeconds / 3));
}

export class WebAudioSoundEngine implements SoundEngine {
  private readonly injectedContext: AudioContext | undefined;
  private readonly rampSeconds: number;
  private readonly smoothingSeconds: number;

  private context: AudioContext | undefined;
  private graph: EngineGraph | undefined;
  private currentState: SoundEngineState = "idle";
  private volume = DEFAULT_VOLUME;
  private lastPan = 0.5;
  private readonly layers: Record<LayerId, LayerRuntime> = {
    forest: makeLayerRuntime(),
    smoke: makeLayerRuntime(),
    co2: makeLayerRuntime(),
    lightning: makeLayerRuntime(),
  };
  private levelBuffer: Float32Array | undefined;
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;
  private dataDuck = 1;
  private transitionSource: AudioBufferSourceNode | null = null;
  private transitionGain: GainNode | null = null;
  private sceneLoopSource: AudioBufferSourceNode | null = null;
  private sceneLoopGain: GainNode | null = null;
  private readonly sceneBuffers = new Map<string, AudioBuffer>();
  private readonly sceneLoads = new Map<string, Promise<AudioBuffer>>();
  private lightningTimer: ReturnType<typeof setTimeout> | undefined;
  private lightningRateHz = 0;
  private lightningNextHitAt = 0;
  private lightningPitchHz = 90;
  private lightningDecaySeconds = 0.16;
  private lightningHitIndex = 0;
  private readonly lightningHits = new Set<LightningHit>();
  private readonly lightningSampleUrl: string | null;
  private readonly fetchSample: (url: string) => Promise<ArrayBuffer>;
  private lightningSample: AudioBuffer | null;
  private lightningSampleLoad: Promise<void> | null = null;
  private overviewGraph: OverviewGraph | undefined;
  private readonly birdSampleUrl: string | null;
  private readonly random: () => number;
  private birdSample: AudioBuffer | null;
  private birdSampleLoad: Promise<AudioBuffer | null> | null = null;
  private forestBirdsEnabled = false;
  private birdStarted = false;
  private birdTimer: ReturnType<typeof setTimeout> | undefined;
  private birdBus: GainNode | undefined;
  private readonly birdHits = new Set<LightningHit>();
  private readonly tempoHits = new Set<LightningHit>();
  private regionalVoice: RegionalVoice | undefined;
  private regionalLightningTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly regionalLightningHits = new Set<LightningHit>();
  private readonly regional: RegionalState = {
    layer: null,
    value: null,
    pan: 0.5,
    min: 0,
    max: 1,
  };
  private readonly overview: OverviewState = {
    layer: null,
    columns: [],
    enabled: false,
  };

  /** Keeps `state` honest when the browser or the OS suspends the context. */
  private readonly handleContextStateChange = (): void => {
    const context = this.context;
    if (!context) return;
    const state = context.state as string;
    if (state === "running") {
      if (this.currentState !== "idle") this.currentState = "running";
      this.startOverview();
      this.startForestBirds();
      this.startRegional();
    } else if (this.currentState === "running") {
      this.currentState = "suspended";
      this.clearLightning();
      this.fadeOverview(0);
      this.stopForestBirds();
      this.clearTempoHits();
      this.clearRegionalLightning();
      this.stopSceneAudio();
    }
  };

  constructor(options: SoundEngineOptions = {}) {
    this.injectedContext = options.context;
    this.rampSeconds = options.rampSeconds ?? DEFAULT_RAMP_SECONDS;
    this.smoothingSeconds = options.smoothingSeconds ?? DEFAULT_SMOOTHING_SECONDS;
    this.lightningSampleUrl =
      options.lightningSampleUrl === undefined ? DEFAULT_LIGHTNING_SAMPLE_URL : options.lightningSampleUrl;
    this.lightningSample = options.lightningSample ?? null;
    this.birdSampleUrl = options.birdSampleUrl === undefined ? FOREST_BIRD_SAMPLE_URL : options.birdSampleUrl;
    this.birdSample = options.birdSample ?? null;
    this.random = options.random ?? Math.random;
    this.fetchSample =
      options.fetchSample ??
      (async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.arrayBuffer();
      });
  }

  get state(): SoundEngineState {
    return this.currentState;
  }

  async start(): Promise<void> {
    if (this.currentState === "running") return;

    let context = this.context;
    if (!context) {
      context = this.injectedContext ?? new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      context.addEventListener("statechange", this.handleContextStateChange);
      this.buildGraph();
    }

    this.clearSuspendTimer();
    this.clearSettleTimers();
    this.clearLightning();
    this.lightningHitIndex = 0;
    await this.loadLightningSample(context);
    if (this.context !== context || !this.graph) return;
    try {
      await context.resume();
    } catch (cause) {
      // A dispose() during the await is not an error to show the person.
      if (this.context !== context) return;
      throw cause;
    }
    if (this.context !== context || !this.graph) return;
    const graph = this.graph;

    const now = context.currentTime;
    const master = graph.master.gain;
    master.cancelScheduledValues(now);
    master.setValueAtTime(0, now);
    master.linearRampToValueAtTime(this.volume, now + START_FADE_SECONDS);

    graph.bus.gain.cancelScheduledValues(now);
    graph.bus.gain.setValueAtTime(this.dataDuck, now);
    this.currentState = "running";
    for (const layer of LAYER_IDS) {
      this.layers[layer].lastUpdateTime = now;
      this.applyLayer(layer, true);
    }
    this.applyPan(now);
    this.startOverview();
    this.startForestBirds();
    this.startRegional();
  }

  stop(): void {
    if (!this.context || !this.graph || this.currentState === "idle") return;
    const context = this.context;
    const now = context.currentTime;
    const master = this.graph.master.gain;
    master.cancelScheduledValues(now);
    master.setValueAtTime(master.value, now);
    master.linearRampToValueAtTime(0, now + STOP_FADE_SECONDS);
    this.currentState = "suspended";
    this.clearSettleTimers();
    this.clearLightning();
    this.fadeOverview(0);
    this.stopForestBirds();
    this.clearTempoHits();
    this.clearRegionalLightning();
    this.fadeRegional(0);
    this.stopSceneAudio();
    this.setDataVoiceDuck(1, 0.1);

    this.clearSuspendTimer();
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = undefined;
      if (this.currentState === "suspended") {
        void context.suspend();
      }
    }, STOP_FADE_SECONDS * 1000 + 20);
  }

  setLayerIntensity(layer: LayerId, value: number | null): void {
    // A non-finite sample is bad data, not "almost zero": silence is safer.
    this.layers[layer].value = value === null || !Number.isFinite(value) ? null : clampUnit(value);
    if (this.currentState === "running") {
      this.applyLayer(layer, false);
    }
  }

  setLayerEnabled(layer: LayerId, enabled: boolean): void {
    this.layers[layer].enabled = enabled;
    if (this.currentState === "running") {
      this.applyLayer(layer, false);
    }
  }

  setPan(horizontal: number): void {
    this.lastPan = clampUnit(horizontal);
    if (this.currentState === "running" && this.context) {
      this.applyPan(this.context.currentTime);
    }
  }

  setOverview(layer: LayerId | null, columns: readonly OverviewColumn[] | null): void {
    const nextColumns = columns ?? [];
    const layerChanged = layer !== this.overview.layer;
    this.overview.layer = layer;
    this.overview.columns = nextColumns;
    if (layer === null || nextColumns.length === 0) {
      this.fadeOverview(0);
      return;
    }
    if (!this.overview.enabled || this.currentState !== "running") return;
    if (layerChanged) this.applyOverviewInstrument();
    this.startOverview();
  }

  setOverviewEnabled(enabled: boolean): void {
    this.overview.enabled = enabled;
    if (!enabled) {
      this.fadeOverview(0);
      return;
    }
    if (
      !this.overview.layer ||
      this.overview.columns.length === 0 ||
      this.currentState !== "running"
    ) {
      return;
    }
    this.startOverview();
  }

  setForestBirds(enabled: boolean): void {
    this.forestBirdsEnabled = enabled;
    if (!enabled) {
      this.stopForestBirds();
      return;
    }
    if (this.currentState === "running") this.startForestBirds();
  }

  playTempoBeat(layer: LayerId): void {
    const context = this.context;
    const graph = this.graph;
    const style = TEMPO_STYLES[layer];
    if (!context || !graph || !style || this.currentState !== "running") return;

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    oscillator.type = style.wave;
    oscillator.frequency.setValueAtTime(style.frequencyHz, now);

    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(graph.bus);
    const end = now + Math.max(0.02, style.durationSeconds);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(style.gain, now + Math.max(0.002, style.attackSeconds));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.start(now);
    oscillator.stop(end + 0.02);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        oscillator.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
      this.tempoHits.delete(hit);
    };
    const hit: LightningHit = {
      stop: () => {
        try {
          oscillator.stop();
        } catch {
          // Already stopped.
        }
        cleanup();
      },
    };
    oscillator.onended = cleanup;
    this.tempoHits.add(hit);
  }

  setRegionalPoint(
    layer: LayerId | null,
    value: number | null,
    horizontal: number,
    range?: { min: number; max: number },
  ): void {
    this.regional.layer = layer;
    this.regional.value =
      value === null || !Number.isFinite(value) ? null : clampUnit(value);
    this.regional.pan = clampUnit(horizontal);
    this.regional.min = range && Number.isFinite(range.min) ? clampUnit(range.min) : 0;
    this.regional.max = range && Number.isFinite(range.max) ? clampUnit(range.max) : 1;

    if (layer === "lightning") {
      if (this.regionalVoice) {
        this.fadeRegional(0);
        this.stopRegionalSample(this.regionalVoice);
      }
      if (this.currentState === "running" && this.regional.value !== null) {
        this.startRegionalLightning();
      } else {
        this.clearRegionalLightning();
      }
      return;
    }

    this.clearRegionalLightning();
    if (this.currentState === "running" && layer && this.regional.value !== null) {
      this.ensureRegionalVoice();
      this.applyRegionalPoint();
    } else if (this.regionalVoice) {
      this.fadeRegional(0);
      this.fadeRegionalSample(0);
    }
  }

  private ensureRegionalVoice(): RegionalVoice | undefined {
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph) return undefined;
    if (this.regionalVoice) return this.regionalVoice;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1600;
    filter.Q.value = 0.9;
    const gain = context.createGain();
    gain.gain.value = 0;
    const panner = context.createStereoPanner();
    panner.pan.value = 0;
    filter.connect(gain);
    gain.connect(panner);

    const oscillators: OscillatorNode[] = [];
    const oscillatorGains: GainNode[] = [];
    for (let index = 0; index < 3; index += 1) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = OVERVIEW_BASE_HZ;
      const oscillatorGain = context.createGain();
      oscillatorGain.gain.value = index === 0 ? 1 : 0;
      oscillator.connect(oscillatorGain);
      oscillatorGain.connect(filter);
      oscillator.start();
      oscillators.push(oscillator);
      oscillatorGains.push(oscillatorGain);
    }

    const fx = this.buildRegionalFx(context, graph.bus, panner);
    const voice: RegionalVoice = {
      oscillators,
      oscillatorGains,
      filter,
      gain,
      panner,
      fx,
      sampleSource: null,
      sampleFilter: null,
      sampleGain: null,
      sampleLayer: null,
      sampleToken: 0,
    };
    this.regionalVoice = voice;
    return voice;
  }

  private buildRegionalFx(context: AudioContext, bus: GainNode, source: StereoPannerNode): RegionalFx {
    const dry = context.createGain();
    dry.gain.value = 0.78;
    source.connect(dry);
    dry.connect(bus);

    const chorusSend = context.createGain();
    chorusSend.gain.value = 0;
    const chorusDelay = context.createDelay(0.1);
    chorusDelay.delayTime.value = 0.025;
    const chorusWet = context.createGain();
    chorusWet.gain.value = 0.55;
    const chorusLfo = context.createOscillator();
    chorusLfo.type = "sine";
    chorusLfo.frequency.value = 0.33;
    const chorusDepth = context.createGain();
    chorusDepth.gain.value = 0.0025;
    source.connect(chorusSend);
    chorusSend.connect(chorusDelay);
    chorusDelay.connect(chorusWet);
    chorusWet.connect(bus);
    chorusLfo.connect(chorusDepth);
    chorusDepth.connect(chorusDelay.delayTime);
    chorusLfo.start();

    const reverbSend = context.createGain();
    reverbSend.gain.value = 0;
    const reverb = context.createConvolver();
    reverb.buffer = this.buildReverbImpulse(context);
    const reverbWet = context.createGain();
    reverbWet.gain.value = 0.7;
    source.connect(reverbSend);
    reverbSend.connect(reverb);
    reverb.connect(reverbWet);
    reverbWet.connect(bus);

    return {
      dry,
      chorusSend,
      chorusDelay,
      chorusWet,
      chorusLfo,
      chorusDepth,
      reverbSend,
      reverb,
      reverbWet,
    };
  }

  private buildReverbImpulse(context: AudioContext): AudioBuffer {
    const seconds = 2.2;
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) {
        const decay = (1 - index / data.length) ** 2.6;
        data[index] = (Math.random() * 2 - 1) * decay;
      }
    }
    return buffer;
  }

  private startRegional(): void {
    if (!this.regional.layer || this.regional.value === null || this.currentState !== "running") {
      return;
    }
    if (this.regional.layer === "lightning") {
      this.startRegionalLightning();
      return;
    }
    this.ensureRegionalVoice();
    this.applyRegionalPoint();
  }

  private applyRegionalPoint(): void {
    const context = this.context;
    const voice = this.regionalVoice;
    const layer = this.regional.layer;
    if (!context || !voice || !layer) return;
    const instrument = OVERVIEW_INSTRUMENTS[layer];
    const enrichment = REGIONAL_ENRICHMENT[layer];
    const now = context.currentTime;
    const value = this.regional.value;
    const span = this.regional.max - this.regional.min;
    const amount =
      value === null ? 0 : span > 0 ? (value - this.regional.min) / span : 0.5;
    const pitch =
      pitchForValue(amount, instrument.scale, 0, 1) *
      2 ** (instrument.detuneCents / 1200) *
      2 ** instrument.octave;

    voice.oscillators.forEach((oscillator) => {
      oscillator.type = instrument.wave;
    });
    rampParameter(voice.oscillators[0]!.frequency, pitch, now, this.rampSeconds);
    rampParameter(
      voice.oscillators[1]!.frequency,
      pitch * 2 ** (enrichment.detuneCents / 1200),
      now,
      this.rampSeconds,
    );
    rampParameter(
      voice.oscillators[2]!.frequency,
      pitch * 2 ** (enrichment.subOctave / 12),
      now,
      this.rampSeconds,
    );
    rampParameter(voice.oscillatorGains[0]!.gain, 1, now, this.rampSeconds);
    rampParameter(voice.oscillatorGains[1]!.gain, 0.35, now, this.rampSeconds);
    rampParameter(voice.oscillatorGains[2]!.gain, enrichment.subGain, now, this.rampSeconds);
    rampParameter(voice.filter.frequency, instrument.filterHz, now, this.rampSeconds);
    rampParameter(voice.filter.Q, instrument.filterQ, now, this.rampSeconds);
    rampParameter(voice.panner.pan, positionToPan(this.regional.pan), now, this.rampSeconds);
    rampParameter(voice.fx.chorusSend.gain, enrichment.chorusSend, now, this.rampSeconds);
    rampParameter(voice.fx.reverbSend.gain, enrichment.reverbSend, now, this.rampSeconds);

    this.configureRegionalSample(layer, voice);
    if (voice.sampleGain) {
      const sampleGain = value !== null && value > 0 ? enrichment.sample?.gain ?? 0 : 0;
      rampParameter(voice.sampleGain.gain, sampleGain, now, Math.max(0.01, instrument.releaseSeconds));
    }

    const target = value !== null && value > 0 ? instrument.gain * REGIONAL_POINT_GAIN : 0;
    const ramp =
      target < voice.gain.gain.value ? instrument.releaseSeconds : instrument.attackSeconds;
    rampParameter(voice.gain.gain, target, now, Math.max(0.01, ramp));
  }

  private configureRegionalSample(layer: LayerId, voice: RegionalVoice): void {
    if (voice.sampleLayer === layer) return;
    voice.sampleLayer = layer;
    voice.sampleToken += 1;
    const token = voice.sampleToken;
    this.stopRegionalSample(voice);
    const config = REGIONAL_ENRICHMENT[layer].sample;
    if (!config) return;
    void this.loadSceneBuffer(config.url).then((buffer) => {
      if (this.regionalVoice !== voice || voice.sampleToken !== token || this.regional.layer !== layer) {
        return;
      }
      const context = this.context;
      if (!context) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = config.filterHz;
      filter.Q.value = config.filterQ;
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(voice.panner);
      source.start();
      voice.sampleSource = source;
      voice.sampleFilter = filter;
      voice.sampleGain = gain;
    }).catch((cause: unknown) => {
      console.warn("Earth Jukebox: a regional texture sample could not be loaded.", cause);
    });
  }

  private stopRegionalSample(voice: RegionalVoice): void {
    if (voice.sampleSource) {
      try {
        voice.sampleSource.stop();
      } catch {
        // Already stopped.
      }
      voice.sampleSource.disconnect();
      voice.sampleSource = null;
    }
    voice.sampleFilter?.disconnect();
    voice.sampleFilter = null;
    voice.sampleGain?.disconnect();
    voice.sampleGain = null;
  }

  private fadeRegionalSample(target: number): void {
    const voice = this.regionalVoice;
    const context = this.context;
    if (!voice?.sampleGain || !context) return;
    rampParameter(voice.sampleGain.gain, target, context.currentTime, this.rampSeconds);
  }

  private startRegionalLightning(): void {
    if (
      this.currentState !== "running" ||
      this.regional.layer !== "lightning" ||
      this.regional.value === null
    ) {
      return;
    }
    if (this.regionalLightningTimer !== undefined) return;
    this.playRegionalLightningNote();
    this.scheduleRegionalLightning();
  }

  private scheduleRegionalLightning(): void {
    if (
      this.currentState !== "running" ||
      this.regional.layer !== "lightning" ||
      this.regional.value === null
    ) {
      return;
    }
    const bpm = lightningBpm(this.regional.value);
    this.regionalLightningTimer = setTimeout(() => {
      this.regionalLightningTimer = undefined;
      this.playRegionalLightningNote();
      this.scheduleRegionalLightning();
    }, 60_000 / bpm);
  }

  private clearRegionalLightning(): void {
    if (this.regionalLightningTimer !== undefined) {
      clearTimeout(this.regionalLightningTimer);
      this.regionalLightningTimer = undefined;
    }
    for (const hit of [...this.regionalLightningHits]) hit.stop();
    this.regionalLightningHits.clear();
  }

  private playRegionalLightningNote(): void {
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph || this.currentState !== "running") return;
    const layer = this.regional.layer;
    const value = this.regional.value;
    if (layer !== "lightning" || value === null) return;
    const instrument = OVERVIEW_INSTRUMENTS.lightning;
    const span = this.regional.max - this.regional.min;
    const amount = span > 0 ? (value - this.regional.min) / span : 0.5;
    const pitch =
      pitchForValue(amount, instrument.scale, 0, 1) *
      2 ** (instrument.detuneCents / 1200) *
      2 ** instrument.octave;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    oscillator.type = instrument.wave;
    oscillator.frequency.setValueAtTime(pitch, now);
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(instrument.filterHz, now);
    filter.Q.setValueAtTime(instrument.filterQ, now);
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(graph.bus);
    panner.pan.setValueAtTime(positionToPan(this.regional.pan), now);
    const level = instrument.gain * REGIONAL_POINT_GAIN;
    const decay = Math.max(0.2, instrument.releaseSeconds);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + Math.max(0.002, instrument.attackSeconds));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    oscillator.start(now);
    oscillator.stop(now + decay + 0.02);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        oscillator.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        filter.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        panner.disconnect();
      } catch {
        // Already disconnected.
      }
      this.regionalLightningHits.delete(hit);
    };
    const hit: LightningHit = {
      stop: () => {
        try {
          oscillator.stop();
        } catch {
          // Already stopped.
        }
        cleanup();
      },
    };
    oscillator.onended = cleanup;
    this.regionalLightningHits.add(hit);
  }

  private fadeRegional(target: number): void {
    const context = this.context;
    const voice = this.regionalVoice;
    if (!context || !voice) return;
    rampParameter(voice.gain.gain, target, context.currentTime, this.rampSeconds);
  }

  private clearTempoHits(): void {
    for (const hit of [...this.tempoHits]) hit.stop();
    this.tempoHits.clear();
  }

  setMasterVolume(value: number): void {
    this.volume = clampUnit(value);
    if (this.currentState === "running" && this.context && this.graph) {
      rampParameter(this.graph.master.gain, this.volume, this.context.currentTime, this.rampSeconds);
    }
  }

  getOutputLevel(): number {
    if (!this.context || !this.graph) return 0;
    const analyser = this.graph.analyser;
    if (!this.levelBuffer || this.levelBuffer.length !== analyser.fftSize) {
      this.levelBuffer = new Float32Array(analyser.fftSize);
    }
    analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const sample of this.levelBuffer) {
      sum += sample * sample;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuffer.length));
  }

  getLatencyMs(): number {
    if (!this.context) return 0;
    const base = Number.isFinite(this.context.baseLatency) ? this.context.baseLatency : 0;
    const output = Number.isFinite(this.context.outputLatency) ? this.context.outputLatency : 0;
    return (base + output) * 1000;
  }

  dispose(): void {
    this.clearSuspendTimer();
    this.clearSettleTimers();
    this.clearLightning();
    this.fadeOverview(0);
    this.stopSceneAudio();
    this.currentState = "idle";
    this.dataDuck = 1;
    this.sceneBuffers.clear();
    this.sceneLoads.clear();

    const graph = this.graph;
    if (graph) {
      const oscillators = [
        graph.forest.main,
        graph.forest.harmony,
        graph.smoke.tone,
        graph.smoke.lfo,
        graph.co2.tone,
        graph.co2.lfo,
      ];
      for (const oscillator of oscillators) {
        try {
          oscillator.stop();
        } catch {
          // Already stopped.
        }
      }
      try {
        graph.noise.stop();
      } catch {
        // Already stopped.
      }

      const nodes: AudioNode[] = [
        ...oscillators,
        graph.noise,
        graph.forest.harmonyGain,
        graph.forest.filter,
        graph.forest.gain,
        graph.forest.panner,
        graph.smoke.noiseGain,
        graph.smoke.toneGain,
        graph.smoke.filter,
        graph.smoke.tremolo,
        graph.smoke.tremoloDepth,
        graph.smoke.gain,
        graph.smoke.panner,
        graph.co2.noiseGain,
        graph.co2.toneGain,
        graph.co2.filter,
        graph.co2.breath,
        graph.co2.breathDepth,
        graph.co2.gain,
        graph.co2.panner,
        graph.lightning.gain,
        graph.lightning.panner,
        graph.bus,
        graph.sceneBus,
        graph.limiter,
        graph.master,
        graph.analyser,
      ];
      for (const node of nodes) {
        node.disconnect();
      }
    }
    const overview = this.overviewGraph;
    if (overview) {
      for (const column of overview.columns) {
        for (const oscillator of column.oscillators) {
          try {
            oscillator.stop();
          } catch {
            // Already stopped.
          }
        }
        for (const node of [...column.oscillators, ...column.gains, column.filter, column.panner]) {
          node.disconnect();
        }
      }
      overview.bus.disconnect();
    }
    if (this.regionalVoice) {
      const voice = this.regionalVoice;
      for (const oscillator of voice.oscillators) {
        try {
          oscillator.stop();
        } catch {
          // Already stopped.
        }
      }
      try {
        voice.fx.chorusLfo.stop();
      } catch {
        // Already stopped.
      }
      this.stopRegionalSample(voice);
      for (const node of [
        ...voice.oscillators,
        ...voice.oscillatorGains,
        voice.filter,
        voice.gain,
        voice.panner,
        voice.fx.dry,
        voice.fx.chorusSend,
        voice.fx.chorusDelay,
        voice.fx.chorusWet,
        voice.fx.chorusLfo,
        voice.fx.chorusDepth,
        voice.fx.reverbSend,
        voice.fx.reverb,
        voice.fx.reverbWet,
      ]) {
        node.disconnect();
      }
      this.regionalVoice = undefined;
    }
    if (this.birdBus) {
      this.birdBus.disconnect();
      this.birdBus = undefined;
    }
    this.birdSample = null;
    this.birdSampleLoad = null;
    this.overviewGraph = undefined;
    this.graph = undefined;
    this.levelBuffer = undefined;

    const context = this.context;
    this.context = undefined;
    if (context) {
      context.removeEventListener("statechange", this.handleContextStateChange);
      if (!this.injectedContext) {
        void context.close();
      }
    }
  }

  private ensureOverviewGraph(): OverviewGraph | undefined {
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph) return undefined;
    if (this.overviewGraph) return this.overviewGraph;
    const bus = context.createGain();
    bus.gain.value = 0;
    bus.connect(graph.bus);
    const columns: OverviewColumnVoice[] = [];
    for (let index = 0; index < OVERVIEW_COLUMNS; index += 1) {
      columns.push(this.buildOverviewColumn(context, bus));
    }
    this.overviewGraph = { columns, bus };
    return this.overviewGraph;
  }

  private buildOverviewColumn(context: AudioContext, bus: GainNode): OverviewColumnVoice {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1600;
    filter.Q.value = 0.9;
    const panner = context.createStereoPanner();
    filter.connect(panner);
    panner.connect(bus);

    const oscillators: OscillatorNode[] = [];
    const gains: GainNode[] = [];
    for (let row = 0; row < OVERVIEW_ROWS; row += 1) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = OVERVIEW_BASE_HZ;
      const rowGain = context.createGain();
      rowGain.gain.value = 0;
      oscillator.connect(rowGain);
      rowGain.connect(filter);
      oscillator.start();
      oscillators.push(oscillator);
      gains.push(rowGain);
    }
    return { oscillators, gains, filter, panner };
  }

  private applyOverviewInstrument(): void {
    const graph = this.overviewGraph;
    const layer = this.overview.layer;
    const context = this.context;
    if (!graph || !layer || !context) return;
    const instrument = OVERVIEW_INSTRUMENTS[layer];
    const now = context.currentTime;
    for (const column of graph.columns) {
      rampParameter(column.filter.frequency, instrument.filterHz, now, this.rampSeconds);
      rampParameter(column.filter.Q, instrument.filterQ, now, this.rampSeconds);
      for (const oscillator of column.oscillators) {
        oscillator.type = instrument.wave;
      }
    }
  }

  private startOverview(): void {
    if (
      !this.overview.enabled ||
      this.currentState !== "running" ||
      !this.overview.layer ||
      this.overview.columns.length === 0
    ) {
      this.fadeOverview(0);
      return;
    }
    const graph = this.ensureOverviewGraph();
    if (!graph) return;
    this.fadeOverview(OVERVIEW_BUS_GAIN);
    this.applyOverviewInstrument();
    this.applyOverviewField();
  }

  private applyOverviewField(): void {
    const context = this.context;
    const graph = this.overviewGraph;
    const layer = this.overview.layer;
    if (!context || !graph || !layer) return;
    const instrument = OVERVIEW_INSTRUMENTS[layer];
    const activeCells = this.overview.columns.reduce(
      (count, column) =>
        count + (column?.cells.reduce((rows, cell) => rows + (cell.gain > 0 ? 1 : 0), 0) ?? 0),
      0,
    );
    const gainScale = OVERVIEW_COLUMN_HEADROOM / Math.sqrt(Math.max(1, activeCells));
    const detune = 2 ** (instrument.detuneCents / 1200);
    const now = context.currentTime;

    for (let index = 0; index < OVERVIEW_COLUMNS; index += 1) {
      const voice = graph.columns[index]!;
      const column = this.overview.columns[index];
      rampParameter(voice.panner.pan, column?.pan ?? 0, now, this.rampSeconds);
      for (let row = 0; row < OVERVIEW_ROWS; row += 1) {
        const cell = column?.cells[row];
        const pitch = cell && Number.isFinite(cell.pitchHz) ? cell.pitchHz : OVERVIEW_BASE_HZ;
        const gain = cell
          ? clampUnit(cell.gain) * instrument.gain * gainScale * OVERVIEW_LAYER_GAIN
          : 0;
        const rowGain = voice.gains[row]!;
        const rampSeconds =
          gain < rowGain.gain.value ? instrument.releaseSeconds : instrument.attackSeconds;
        rampParameter(voice.oscillators[row]!.frequency, pitch * detune * 2 ** instrument.octave, now, this.rampSeconds);
        rampParameter(rowGain.gain, gain, now, Math.max(0.01, rampSeconds));
      }
    }
  }

  private fadeOverview(target: number): void {
    const graph = this.overviewGraph;
    const context = this.context;
    if (!graph || !context) return;
    rampParameter(graph.bus.gain, target, context.currentTime, this.rampSeconds);
  }

  private ensureBirdBus(): GainNode | undefined {
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph) return undefined;
    if (this.birdBus) return this.birdBus;
    const bus = context.createGain();
    bus.gain.value = 0;
    bus.connect(graph.bus);
    this.birdBus = bus;
    return bus;
  }

  private startForestBirds(): void {
    if (!this.forestBirdsEnabled || this.currentState !== "running") return;
    const bus = this.ensureBirdBus();
    if (!bus) return;
    rampParameter(bus.gain, BIRD_BUS_GAIN, this.context!.currentTime, this.rampSeconds);
    if (this.birdStarted || this.birdTimer !== undefined) return;
    this.birdStarted = true;
    void this.loadBirdSample().then((sample) => {
      this.birdStarted = false;
      if (!sample || !this.forestBirdsEnabled || this.currentState !== "running") return;
      this.birdSample = sample;
      this.scheduleForestBird(this.randomBetween(BIRD_FIRST_DELAY_MIN_SECONDS, BIRD_FIRST_DELAY_MAX_SECONDS));
    });
  }

  private stopForestBirds(): void {
    this.birdStarted = false;
    if (this.birdTimer !== undefined) {
      clearTimeout(this.birdTimer);
      this.birdTimer = undefined;
    }
    for (const hit of [...this.birdHits]) hit.stop();
    this.birdHits.clear();
    const context = this.context;
    if (this.birdBus && context) {
      rampParameter(this.birdBus.gain, 0, context.currentTime, this.rampSeconds);
    }
  }

  private async loadBirdSample(): Promise<AudioBuffer | null> {
    if (this.birdSample) return this.birdSample;
    if (!this.birdSampleUrl) return null;
    if (!this.birdSampleLoad) {
      const context = this.context;
      if (!context) return null;
      this.birdSampleLoad = this.loadSceneBuffer(this.birdSampleUrl)
        .catch((cause: unknown) => {
          console.warn("Earth Jukebox: the forest bird sample could not be loaded; keeping only the synth.", cause);
          return null;
        });
    }
    return this.birdSampleLoad;
  }

  private randomBetween(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  private scheduleForestBird(delaySeconds: number): void {
    if (!this.forestBirdsEnabled || this.currentState !== "running" || !this.birdSample) return;
    this.birdTimer = setTimeout(() => {
      this.birdTimer = undefined;
      if (!this.forestBirdsEnabled || this.currentState !== "running") return;
      this.playForestBird();
      this.scheduleForestBird(this.randomBetween(BIRD_GAP_MIN_SECONDS, BIRD_GAP_MAX_SECONDS));
    }, Math.max(100, delaySeconds * 1000));
  }

  private playForestBird(): void {
    const context = this.context;
    const sample = this.birdSample;
    const bus = this.birdBus;
    if (!context || !sample || !bus || this.currentState !== "running") return;
    const now = context.currentTime;
    const duration = Math.max(0.1, Math.min(BIRD_EXCERPT_MAX_SECONDS, sample.duration));
    const excerpt = Math.min(
      duration,
      this.randomBetween(BIRD_EXCERPT_MIN_SECONDS, BIRD_EXCERPT_MAX_SECONDS),
    );
    const offset = this.random() * Math.max(0, duration - excerpt - 0.05);
    const source = context.createBufferSource();
    source.buffer = sample;
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    source.connect(gain);
    gain.connect(panner);
    panner.connect(bus);
    rampParameter(panner.pan, (this.random() * 2 - 1) * 0.65, now, this.rampSeconds);
    const level = BIRD_GAIN * (0.65 + this.random() * 0.35);
    const fadeStart = Math.max(BIRD_ATTACK_SECONDS, excerpt - BIRD_FADE_SECONDS);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + BIRD_ATTACK_SECONDS);
    gain.gain.setValueAtTime(level, now + fadeStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + excerpt);
    source.start(now, offset, excerpt);
    source.stop(now + excerpt + 0.02);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        panner.disconnect();
      } catch {
        // Already disconnected.
      }
      this.birdHits.delete(hit);
    };
    const hit: LightningHit = {
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        cleanup();
      },
    };
    source.onended = cleanup;
    this.birdHits.add(hit);
  }

  private applyLayer(layer: LayerId, snap: boolean): void {
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph) return;

    const runtime = this.layers[layer];
    const now = context.currentTime;
    if (snap) {
      runtime.smoother.reset(runtime.value ?? 0);
    } else {
      const dt = Math.max(0, Math.min(0.25, now - runtime.lastUpdateTime));
      runtime.smoother.setTarget(runtime.value ?? 0);
      runtime.smoother.advance(dt, this.smoothingSeconds);
    }
    runtime.lastUpdateTime = now;
    this.renderLayer(layer);

    // The smoother only advances when a sample arrives. If the pointer stops,
    // this finish brings the voice to the value the HUD shows within 250 ms.
    if (!snap) {
      this.scheduleSettle(layer);
    }
  }

  private scheduleSettle(layer: LayerId): void {
    const runtime = this.layers[layer];
    if (runtime.settleTimer !== undefined) {
      clearTimeout(runtime.settleTimer);
    }
    runtime.settleTimer = setTimeout(() => {
      runtime.settleTimer = undefined;
      if (this.currentState !== "running" || !this.context) return;
      runtime.smoother.reset(runtime.value ?? 0);
      runtime.lastUpdateTime = this.context.currentTime;
      this.renderLayer(layer);
    }, SETTLE_MS);
  }

  private clearSettleTimers(): void {
    for (const layer of LAYER_IDS) {
      const runtime = this.layers[layer];
      if (runtime.settleTimer !== undefined) {
        clearTimeout(runtime.settleTimer);
        runtime.settleTimer = undefined;
      }
    }
  }

  /** Schedules every parameter of one layer from its current smoothed value. */
  private renderLayer(layer: LayerId): void {
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph) return;

    const runtime = this.layers[layer];
    const now = context.currentTime;
    const smoothed = runtime.smoother.value;
    const gain = runtime.value === null || !runtime.enabled ? 0 : intensityToGain(smoothed) * LAYER_TRIM[layer];

    if (layer === "forest") {
      const voice = forestToVoice(smoothed);
      rampParameter(graph.forest.main.frequency, voice.frequency, now, this.rampSeconds);
      rampParameter(graph.forest.harmony.frequency, voice.harmonyFrequency, now, this.rampSeconds);
      rampParameter(graph.forest.gain.gain, gain, now, this.rampSeconds);
      return;
    }

    if (layer === "smoke") {
      const timbre = smokeToTimbre(smoothed);
      const depth = timbre.roughness * 0.5;
      rampParameter(graph.smoke.filter.frequency, timbre.filterCutoffHz, now, this.rampSeconds);
      rampParameter(graph.smoke.noiseGain.gain, timbre.noiseMix, now, this.rampSeconds);
      rampParameter(graph.smoke.toneGain.gain, 1 - timbre.noiseMix, now, this.rampSeconds);
      rampParameter(graph.smoke.lfo.frequency, timbre.roughnessRateHz, now, this.rampSeconds);
      rampParameter(graph.smoke.tremoloDepth.gain, depth, now, this.rampSeconds);
      rampParameter(graph.smoke.tremolo.gain, 1 - depth, now, this.rampSeconds);
      rampParameter(graph.smoke.gain.gain, gain, now, this.rampSeconds);
      return;
    }

    // Lightning is percussion: the relative frequency sets the hit rate and the
    // body pitch (mapping.ts), so it never falls through to the CO2 branch.
    if (layer === "lightning") {
      const percussion = lightningToPercussion(smoothed);
      const active = runtime.value !== null && runtime.enabled && percussion.rateHz > 0;
      this.lightningRateHz = active ? percussion.rateHz : 0;
      this.lightningPitchHz = percussion.pitchHz;
      this.lightningDecaySeconds = percussion.decaySeconds;
      // If the rate rose, bring the pending hit forward instead of waiting for
      // the old (possibly long) interval. Slowing down keeps the current beat.
      if (active && this.lightningTimer !== undefined && context) {
        const remaining = this.lightningNextHitAt - context.currentTime;
        const interval = 1 / percussion.rateHz;
        if (interval < remaining - LIGHTNING_RATE_RESCHEDULE) {
          this.clearLightningTimer();
          this.scheduleLightningHit(interval * 1000);
        }
      }
      rampParameter(graph.lightning.gain.gain, active ? 1 : 0, now, this.rampSeconds);
      this.updateLightningScheduler();
      return;
    }
    if (layer !== "co2") return;

    const breath = co2ToBreath(smoothed);
    const depth = breath.depth * 0.5;
    rampParameter(graph.co2.filter.frequency, Math.min(FOREST_LOWPASS_HZ, breath.toneHz * 3), now, this.rampSeconds);
    rampParameter(graph.co2.noiseGain.gain, CO2_NOISE_MIX, now, this.rampSeconds);
    rampParameter(graph.co2.toneGain.gain, 1 - CO2_NOISE_MIX, now, this.rampSeconds);
    rampParameter(graph.co2.tone.frequency, breath.toneHz, now, this.rampSeconds);
    rampParameter(graph.co2.lfo.frequency, breath.rateHz, now, this.rampSeconds);
    rampParameter(graph.co2.breathDepth.gain, depth, now, this.rampSeconds);
    rampParameter(graph.co2.breath.gain, 1 - depth, now, this.rampSeconds);
    rampParameter(graph.co2.gain.gain, gain, now, this.rampSeconds);
  }

  private applyPan(now: number): void {
    const graph = this.graph;
    if (!graph) return;
    const pan = positionToPan(this.lastPan);
    rampParameter(graph.forest.panner.pan, pan, now, this.rampSeconds);
    rampParameter(graph.smoke.panner.pan, pan, now, this.rampSeconds);
    rampParameter(graph.co2.panner.pan, pan, now, this.rampSeconds);
    rampParameter(graph.lightning.panner.pan, pan, now, this.rampSeconds);
  }

  private buildGraph(): void {
    const context = this.context;
    if (!context) throw new Error("Sound engine: the audio context is missing.");

    const bus = context.createGain();
    bus.gain.value = this.dataDuck;

    const sceneBus = context.createGain();
    sceneBus.gain.value = 1;

    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    const master = context.createGain();
    master.gain.value = 0;

    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;

    bus.connect(limiter);
    sceneBus.connect(limiter);
    limiter.connect(master);
    master.connect(analyser);
    analyser.connect(context.destination);

    const noise = this.buildNoiseSource(context);
    const forest = this.buildForestVoice(context, bus);
    const smoke = this.buildSmokeVoice(context, bus, noise);
    const co2 = this.buildCo2Voice(context, bus, noise);
    const lightning = this.buildLightningVoice(context, bus);

    this.graph = { noise, bus, sceneBus, limiter, master, analyser, forest, smoke, co2, lightning };
  }

  /** One looping white-noise buffer shared by the smoke and CO2 voices. */
  private buildNoiseSource(context: AudioContext): AudioBufferSourceNode {
    const length = Math.max(1, Math.floor(context.sampleRate * NOISE_SECONDS));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.random() * 2 - 1;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.start();
    return source;
  }

  private buildForestVoice(context: AudioContext, bus: GainNode): ForestVoice {
    const base = forestToVoice(0);

    const main = context.createOscillator();
    main.type = "triangle";
    main.frequency.value = base.frequency;

    const harmony = context.createOscillator();
    harmony.type = "sine";
    harmony.frequency.value = base.harmonyFrequency;

    const harmonyGain = context.createGain();
    harmonyGain.gain.value = FOREST_HARMONY_MIX;

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = FOREST_LOWPASS_HZ;
    filter.Q.value = 0.7;

    const gain = context.createGain();
    gain.gain.value = 0;

    const panner = context.createStereoPanner();
    panner.pan.value = positionToPan(0.5);

    main.connect(filter);
    harmony.connect(harmonyGain);
    harmonyGain.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(bus);

    main.start();
    harmony.start();

    return { main, harmony, harmonyGain, filter, gain, panner };
  }

  private buildSmokeVoice(context: AudioContext, bus: GainNode, noise: AudioBufferSourceNode): SmokeVoice {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;
    filter.Q.value = 0.8;

    const noiseGain = context.createGain();
    noiseGain.gain.value = 0.3;

    const tone = context.createOscillator();
    tone.type = "sine";
    tone.frequency.value = SMOKE_TONE_HZ;

    const toneGain = context.createGain();
    toneGain.gain.value = 0.5;

    const tremolo = context.createGain();
    tremolo.gain.value = 1;

    const tremoloDepth = context.createGain();
    tremoloDepth.gain.value = 0;

    const lfo = context.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 18;

    const gain = context.createGain();
    gain.gain.value = 0;

    const panner = context.createStereoPanner();
    panner.pan.value = positionToPan(0.5);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(tremolo);
    tone.connect(toneGain);
    toneGain.connect(tremolo);
    lfo.connect(tremoloDepth);
    tremoloDepth.connect(tremolo.gain);
    tremolo.connect(gain);
    gain.connect(panner);
    panner.connect(bus);

    tone.start();
    lfo.start();

    return { noiseGain, tone, toneGain, filter, tremolo, tremoloDepth, lfo, gain, panner };
  }

  private buildCo2Voice(context: AudioContext, bus: GainNode, noise: AudioBufferSourceNode): Co2Voice {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;
    filter.Q.value = 0.7;

    const noiseGain = context.createGain();
    noiseGain.gain.value = CO2_NOISE_MIX;

    const tone = context.createOscillator();
    tone.type = "sine";
    tone.frequency.value = 520;

    const toneGain = context.createGain();
    toneGain.gain.value = 1 - CO2_NOISE_MIX;

    const breath = context.createGain();
    breath.gain.value = 1;

    const breathDepth = context.createGain();
    breathDepth.gain.value = 0;

    const lfo = context.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.3;

    const gain = context.createGain();
    gain.gain.value = 0;

    const panner = context.createStereoPanner();
    panner.pan.value = positionToPan(0.5);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(breath);
    tone.connect(toneGain);
    toneGain.connect(breath);
    lfo.connect(breathDepth);
    breathDepth.connect(breath.gain);
    breath.connect(gain);
    gain.connect(panner);
    panner.connect(bus);

    tone.start();
    lfo.start();

    return { noiseGain, tone, toneGain, filter, breath, breathDepth, lfo, gain, panner };
  }

  private buildLightningVoice(context: AudioContext, bus: GainNode): LightningVoice {
    const gain = context.createGain();
    gain.gain.value = 0;
    const panner = context.createStereoPanner();
    panner.pan.value = positionToPan(0.5);
    gain.connect(panner);
    panner.connect(bus);
    return { gain, panner };
  }

  /** Keeps one timer alive while the layer has a rate; the next hit is scheduled when it fires. */
  private updateLightningScheduler(): void {
    if (this.currentState !== "running" || this.lightningRateHz <= 0) {
      this.clearLightningTimer();
      return;
    }
    if (this.lightningTimer === undefined) {
      this.scheduleLightningHit(0);
    }
  }

  private scheduleLightningHit(delayMs: number): void {
    this.lightningNextHitAt = (this.context?.currentTime ?? 0) + Math.max(0, delayMs) / 1000;
    this.lightningTimer = setTimeout(() => {
      this.lightningTimer = undefined;
      if (this.currentState !== "running" || this.lightningRateHz <= 0) return;
      this.playLightningHit();
      this.scheduleLightningHit(1000 / Math.max(0.01, this.lightningRateHz));
    }, Math.max(0, delayMs));
  }

  private clearLightningTimer(): void {
    if (this.lightningTimer !== undefined) {
      clearTimeout(this.lightningTimer);
      this.lightningTimer = undefined;
      this.lightningNextHitAt = 0;
    }
  }

  /** Stops the rhythm and any hit that is still ringing. */
  private clearLightning(): void {
    this.clearLightningTimer();
    for (const hit of [...this.lightningHits]) hit.stop();
    this.lightningHits.clear();
  }

  /**
   * One percussion hit: a short filtered-noise crack plus a pitched body, both
   * with a fast attack and an exponential decay. Nodes are per hit and released
   * on `onended`; nothing is created per animation frame.
   */
  private playLightningHit(): void {
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph || this.currentState !== "running") return;
    if (this.lightningSample) {
      this.playLightningSampleHit(this.lightningSample);
      return;
    }
    const now = context.currentTime;
    const pitch = this.lightningPitchHz;
    const decay = this.lightningDecaySeconds;

    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = Math.min(9000, pitch * 8);
    noiseFilter.Q.value = 0.7;

    const noiseGain = context.createGain();
    graph.noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(graph.lightning.gain);
    noiseGain.gain.setValueAtTime(0, now);
    noiseGain.gain.linearRampToValueAtTime(0.5, now + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    const body = context.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(pitch, now);

    const bodyGain = context.createGain();
    body.connect(bodyGain);
    bodyGain.connect(graph.lightning.gain);
    bodyGain.gain.setValueAtTime(0, now);
    bodyGain.gain.linearRampToValueAtTime(0.6, now + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + decay * 1.2);
    body.start(now);
    body.stop(now + decay * 1.2 + 0.02);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        body.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        bodyGain.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        noiseGain.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        graph.noise.disconnect(noiseFilter);
      } catch {
        // Already disconnected.
      }
      try {
        noiseFilter.disconnect();
      } catch {
        // Already disconnected.
      }
      this.lightningHits.delete(hit);
    };
    const hit: LightningHit = {
      stop: () => {
        try {
          body.stop();
        } catch {
          // Already stopped.
        }
        cleanup();
      },
    };
    body.onended = cleanup;
    this.lightningHits.add(hit);
  }

  /** Loads the thunder sample once; a failure leaves the synthesized fallback. */
  private async loadLightningSample(context: AudioContext): Promise<void> {
    const url = this.lightningSampleUrl;
    if (!url || this.lightningSample) return;
    if (!this.lightningSampleLoad) {
      this.lightningSampleLoad = (async () => {
        try {
          const data = await this.fetchSample(url);
          this.lightningSample = await context.decodeAudioData(data.slice(0));
        } catch (cause) {
          console.warn(
            "Earth Jukebox: the thunder sample could not be loaded; using the synthesized hit.",
            cause,
          );
        }
      })();
    }
    await this.lightningSampleLoad;
  }

  /** One hit built from an excerpt of the thunder sample. */
  private playLightningSampleHit(sample: AudioBuffer): void {
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph || this.currentState !== "running") return;
    const now = context.currentTime;
    const duration = Number.isFinite(sample.duration) && sample.duration > 0 ? sample.duration : LIGHTNING_SAMPLE_TAIL_SECONDS;
    const tail = Math.min(LIGHTNING_SAMPLE_TAIL_SECONDS, duration);
    // Keep total loudness roughly constant as hits overlap: each one is quieter,
    // but its tail is still underneath the next one.
    const rate = Math.max(0.1, this.lightningRateHz);
    const hitGain = LIGHTNING_SAMPLE_GAIN * Math.min(1, 1 / Math.sqrt(rate));
    const fadeStart = Math.max(LIGHTNING_SAMPLE_ATTACK, Math.min(tail, tail - LIGHTNING_SAMPLE_FADE_OUT));
    const baseOffset = LIGHTNING_SAMPLE_OFFSETS[this.lightningHitIndex % LIGHTNING_SAMPLE_OFFSETS.length] ?? 0;
    this.lightningHitIndex += 1;
    const offset = Math.min(Math.max(0, duration - tail), baseOffset);

    const source = context.createBufferSource();
    source.buffer = sample;
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(graph.lightning.gain);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(hitGain, now + LIGHTNING_SAMPLE_ATTACK);
    gain.gain.setValueAtTime(hitGain, now + fadeStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + tail);
    source.start(now, offset, tail);
    source.stop(now + tail + 0.02);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
      this.lightningHits.delete(hit);
    };
    const hit: LightningHit = {
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        cleanup();
      },
    };
    source.onended = cleanup;
    this.lightningHits.add(hit);
  }

  async playSceneTransition(url: string): Promise<void> {
    const buffer = await this.loadSceneBuffer(url);
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph || this.currentState !== "running") return;

    this.stopSceneTransition(0.05);
    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(graph.sceneBus);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(SCENE_TRANSITION_GAIN, now + 0.01);
    // The source is cut at its natural end; fade the last 0.4 s so it does not
    // end with a click or an abrupt stop.
    const duration = Number.isFinite(buffer.duration) && buffer.duration > 0 ? buffer.duration : 1.6;
    const fadeStart = Math.max(0.01, duration - SCENE_TRANSITION_FADE_OUT_SECONDS);
    gain.gain.setValueAtTime(SCENE_TRANSITION_GAIN, now + fadeStart);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    source.start(now);
    source.stop(now + duration + 0.02);
    this.transitionSource = source;
    this.transitionGain = gain;
    source.onended = () => {
      if (this.transitionSource === source) {
        this.transitionSource = null;
        this.transitionGain = null;
      }
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }

  async playSceneLoop(
    url: string,
    options: { gain?: number; fadeInSeconds?: number } = {},
  ): Promise<void> {
    const buffer = await this.loadSceneBuffer(url);
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph || this.currentState !== "running") return;

    this.stopSceneLoop({ fadeOutSeconds: SCENE_FADE_OUT_SECONDS });
    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(graph.sceneBus);
    // Scenes are the foreground: give them more level than the data voices,
    // which are ducked by the app while the popup is open.
    const target = Math.min(
      SCENE_LOOP_MAX_GAIN,
      Math.max(0, (options.gain ?? 1) * SCENE_LOOP_GAIN_MULTIPLIER),
    );
    const fade = Math.max(0.01, options.fadeInSeconds ?? SCENE_FADE_IN_SECONDS);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(target, now + fade);
    source.start(now);
    this.sceneLoopSource = source;
    this.sceneLoopGain = gain;
    source.onended = () => {
      if (this.sceneLoopSource === source) {
        this.sceneLoopSource = null;
        this.sceneLoopGain = null;
      }
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
      try {
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }

  stopSceneLoop(options: { fadeOutSeconds?: number } = {}): void {
    const source = this.sceneLoopSource;
    const gain = this.sceneLoopGain;
    if (!source || !gain || !this.context) return;
    const now = this.context.currentTime;
    const fade = Math.max(0.01, options.fadeOutSeconds ?? SCENE_FADE_OUT_SECONDS);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fade);
    this.sceneLoopSource = null;
    this.sceneLoopGain = null;
    try {
      source.stop(now + fade + 0.02);
    } catch {
      // Already stopped.
    }
  }

  stopSceneAudio(): void {
    this.stopSceneTransition(0.1);
    this.stopSceneLoop({ fadeOutSeconds: SCENE_FADE_OUT_SECONDS });
  }

  setDataVoiceDuck(amount: number, seconds = 0.2): void {
    this.dataDuck = clampUnit(amount);
    const context = this.context;
    const graph = this.graph;
    if (!context || !graph || this.currentState !== "running") return;
    const now = context.currentTime;
    const fade = Math.max(0.01, seconds);
    graph.bus.gain.cancelScheduledValues(now);
    graph.bus.gain.setValueAtTime(graph.bus.gain.value, now);
    graph.bus.gain.linearRampToValueAtTime(this.dataDuck, now + fade);
  }

  private stopSceneTransition(fadeOutSeconds: number): void {
    const source = this.transitionSource;
    const gain = this.transitionGain;
    if (!source || !gain || !this.context) return;
    const now = this.context.currentTime;
    const fade = Math.max(0.01, fadeOutSeconds);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fade);
    this.transitionSource = null;
    this.transitionGain = null;
    try {
      source.stop(now + fade + 0.02);
    } catch {
      // Already stopped.
    }
  }

  private loadSceneBuffer(url: string): Promise<AudioBuffer> {
    const cached = this.sceneBuffers.get(url);
    if (cached) return Promise.resolve(cached);
    const pending = this.sceneLoads.get(url);
    if (pending) return pending;
    const context = this.context;
    if (!context) return Promise.reject(new Error("The sound engine is not started."));
    const promise = this.fetchSample(url)
      .then((data) => context.decodeAudioData(data.slice(0)))
      .then((buffer) => {
        this.sceneBuffers.set(url, buffer);
        this.sceneLoads.delete(url);
        return buffer;
      })
      .catch((cause: unknown) => {
        this.sceneLoads.delete(url);
        throw cause;
      });
    this.sceneLoads.set(url, promise);
    return promise;
  }

  private clearSuspendTimer(): void {
    if (this.suspendTimer !== undefined) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = undefined;
    }
  }
}

/** Creates a sound engine. The AudioContext is only created on `start()`. */
export function createSoundEngine(options: SoundEngineOptions = {}): SoundEngine {
  return new WebAudioSoundEngine(options);
}
