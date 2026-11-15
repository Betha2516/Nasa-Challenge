// Minimal AudioContext stand-in for the sound-engine tests.
//
// It records the nodes the engine creates and the parameter events it
// schedules, so the tests can check the graph shape and the values without a
// browser. Only the surface the engine actually touches is implemented.

import { vi } from "vitest";

export interface ParamEvent {
  method: string;
  target: number;
  time: number;
}

export class FakeParam {
  /** Value after an instant `setValueAtTime`; ramps do not change it until they would finish. */
  value = 0;
  /** Last target scheduled with a ramp or `setTargetAtTime`; null before the first one. */
  scheduledTarget: number | null = null;
  readonly events: ParamEvent[] = [];

  setValueAtTime(target: number, time: number): void {
    this.value = target;
    this.scheduledTarget = target;
    this.events.push({ method: "setValueAtTime", target, time });
  }

  linearRampToValueAtTime(target: number, time: number): void {
    this.scheduledTarget = target;
    this.events.push({ method: "linearRampToValueAtTime", target, time });
  }

  exponentialRampToValueAtTime(target: number, time: number): void {
    this.scheduledTarget = target;
    this.events.push({ method: "exponentialRampToValueAtTime", target, time });
  }

  setTargetAtTime(target: number, time: number, _timeConstant: number): void {
    this.scheduledTarget = target;
    this.events.push({ method: "setTargetAtTime", target, time });
  }

  cancelScheduledValues(time: number): void {
    this.events.push({ method: "cancelScheduledValues", target: this.value, time });
  }
}

export class FakeNode {
  readonly connections: unknown[] = [];
  readonly connect = vi.fn((target: unknown): unknown => {
    this.connections.push(target);
    return target;
  });
  readonly disconnect = vi.fn();
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

export class FakeOscillator extends FakeNode {
  type = "sine";
  readonly frequency = new FakeParam();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

export class FakeBiquad extends FakeNode {
  type = "lowpass";
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

export class FakePanner extends FakeNode {
  readonly pan = new FakeParam();
}

export class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam();
}

export class FakeConvolver extends FakeNode {
  buffer: AudioBuffer | null = null;
}

export class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  readonly getFloatTimeDomainData = vi.fn((data: Float32Array): void => {
    data.fill(0.25);
  });
}

export class FakeAudioBuffer {
  readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? new Float32Array(this.length);
  }
}

export class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  baseLatency = 0.005;
  outputLatency = 0.02;
  state: "suspended" | "running" | "closed" = "suspended";
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];
  readonly filters: FakeBiquad[] = [];
  readonly panners: FakePanner[] = [];
  readonly analysers: FakeAnalyser[] = [];
  readonly buffers: FakeAudioBuffer[] = [];
  readonly bufferSources: FakeBufferSource[] = [];
  /** When set, resume() rejects with it (autoplay policy or a closed context). */
  resumeError: Error | null = null;
  readonly resume = vi.fn(async (): Promise<void> => {
    if (this.resumeError) {
      this.state = "suspended";
      throw this.resumeError;
    }
    this.state = "running";
  });
  decodedDuration = 16.6;
  readonly decodeAudioData = vi.fn(async (_data: ArrayBuffer): Promise<AudioBuffer> => {
    return { duration: this.decodedDuration } as AudioBuffer;
  });
  readonly addEventListener = vi.fn();
  readonly removeEventListener = vi.fn();
  readonly suspend = vi.fn(async (): Promise<void> => {
    this.state = "suspended";
  });
  readonly close = vi.fn(async (): Promise<void> => {
    this.state = "closed";
  });

  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createOscillator(): FakeOscillator {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }

  createBiquadFilter(): FakeBiquad {
    const node = new FakeBiquad();
    this.filters.push(node);
    return node;
  }

  createStereoPanner(): FakePanner {
    const node = new FakePanner();
    this.panners.push(node);
    return node;
  }

  createDelay(_maxDelayTime?: number): FakeDelay {
    return new FakeDelay();
  }

  createConvolver(): FakeConvolver {
    return new FakeConvolver();
  }

  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }

  createAnalyser(): FakeAnalyser {
    const node = new FakeAnalyser();
    this.analysers.push(node);
    return node;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    const buffer = new FakeAudioBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource(): FakeBufferSource {
    const node = new FakeBufferSource();
    this.bufferSources.push(node);
    return node;
  }

  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}
