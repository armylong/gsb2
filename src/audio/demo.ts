export const DEMO_DURATION_SEC = 8;
export const DEMO_BEAT_SEC = 0.5;

export interface DemoCue {
  time: number;
  label: string;
  semitone: number;
}

const SCALE_semitones = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36];

export const DEMO_CUES: DemoCue[] = SCALE_semitones.map((semitone, index) => ({
  time: index * DEMO_BEAT_SEC,
  label: `${index + 1}`,
  semitone,
}));

function midiToFreq(semitoneFromC4: number): number {
  return 261.6256 * 2 ** (semitoneFromC4 / 12);
}

function addKick(left: Float32Array, right: Float32Array, sampleRate: number, start: number): void {
  const length = Math.floor(sampleRate * 0.2);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 24);
    const frequency = 48 + 105 * Math.exp(-t * 34);
    phase += (2 * Math.PI * frequency) / sampleRate;
    const sample = 0.5 * envelope * Math.sin(phase);
    const index = start + i;
    if (index < left.length) {
      left[index] += sample * 0.96;
      right[index] += sample;
    }
  }
}

function addHat(channels: Float32Array[], sampleRate: number, start: number, pan: number, seed: number): void {
  const length = Math.floor(sampleRate * 0.055);
  let state = seed >>> 0;
  let previous = 0;
  let highPass = 0;
  const leftGain = Math.sqrt((1 - pan) / 2);
  const rightGain = Math.sqrt((1 + pan) / 2);

  for (let i = 0; i < length; i += 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    const white = ((state / 4294967296) * 2 - 1) * 0.35;
    highPass = white - previous + 0.82 * highPass;
    previous = white;
    const t = i / sampleRate;
    const sample = highPass * Math.exp(-t * 75) * 0.24;
    const index = start + i;
    if (index < channels[0].length) {
      channels[0][index] += sample * leftGain;
      channels[1][index] += sample * rightGain;
    }
  }
}

function addCountCue(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  start: number,
  cue: DemoCue,
): void {
  const length = Math.floor(sampleRate * 0.34);
  const baseFrequency = midiToFreq(cue.semitone);
  const pan = cue.time % 1 < 0.5 ? -0.18 : 0.18;
  const leftGain = Math.sqrt((1 - pan) / 2);
  const rightGain = Math.sqrt((1 + pan) / 2);

  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.012);
    const envelope = attack * Math.exp(-t * 7.5);
    const glide = 1 + 0.18 * Math.exp(-t * 28);
    const frequency = baseFrequency * glide;
    const vibrato = 1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t);
    const phase = 2 * Math.PI * frequency * vibrato * t;

    // Formant-ish additive tone: an intentionally non-speech “count substitute”.
    const body =
      Math.sin(phase) +
      0.48 * Math.sin(2.01 * phase) +
      0.24 * Math.sin(3.02 * phase) +
      0.12 * Math.sin(4.7 * phase);
    const sample = envelope * body * 0.11;
    const index = start + i;
    if (index < left.length) {
      left[index] += sample * leftGain;
      right[index] += sample * rightGain;
    }
  }

  // Two short orientation ticks make the cue number easier to localize by ear.
  const tickCount = Math.min(4, Math.floor(cue.semitone / 4) + 1);
  for (let tick = 0; tick < tickCount; tick += 1) {
    const tickStart = start + Math.floor((0.22 + tick * 0.035) * sampleRate);
    const tickLength = Math.floor(0.018 * sampleRate);
    for (let i = 0; i < tickLength; i += 1) {
      const t = i / sampleRate;
      const sample = 0.12 * Math.exp(-t * 90) * Math.sin(2 * Math.PI * (1320 + tick * 110) * t);
      const index = tickStart + i;
      if (index < left.length && index < right.length) {
        left[index] += sample * leftGain;
        right[index] += sample * rightGain;
      }
    }
  }
}

export function createDemoBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = 44100;
  const totalSamples = Math.floor(sampleRate * DEMO_DURATION_SEC);
  const buffer = context.createBuffer(2, totalSamples, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  DEMO_CUES.forEach((cue, index) => {
    const start = Math.floor(cue.time * sampleRate);
    addKick(left, right, sampleRate, start);
    addCountCue(left, right, sampleRate, start, cue);
    addHat([left, right], sampleRate, Math.floor((cue.time + 0.25) * sampleRate), index % 2 ? 0.32 : -0.32, index + 91);
  });

  // Very quiet room tone prevents digital edge silence from feeling disconnected.
  let seed = 1234567;
  for (let i = 0; i < totalSamples; i += 1) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const noise = ((seed / 4294967296) * 2 - 1) * 0.006;
    left[i] += noise;
    right[i] += noise * 0.92;
  }

  return buffer;
}
