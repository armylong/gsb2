import { bufferOffsetForAtom } from './scrubPlanner';
import { applyAtomEnvelope } from './renderRoute';
import type { ScrubAtom } from '../domain/types';

interface NormalVoice {
  source: AudioBufferSourceNode;
  offset: number;
  startedAtCtx: number;
}

interface PreviewVoice {
  source: AudioBufferSourceNode;
}

interface ScrubVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  startedWhen: number;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private normal: NormalVoice | null = null;
  private preview: PreviewVoice | null = null;
  private scrubVoices = new Map<string, ScrubVoice>();
  onNormalEnded: (() => void) | null = null;
  onPreviewEnded: (() => void) | null = null;

  async ensureContext(): Promise<AudioContext> {
    if (!this.context) {
      const Ctor = window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('当前浏览器不支持 Web Audio API');
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context;
  }

  get currentTime(): number {
    return this.context?.currentTime ?? 0;
  }

  async unlock(): Promise<void> {
    await this.ensureContext();
  }

  stopNormal(): void {
    const voice = this.normal;
    this.normal = null;
    if (voice) {
      try {
        voice.source.onended = null;
        voice.source.stop();
      } catch {
        // already stopped
      }
    }
  }

  stopPreview(): void {
    const voice = this.preview;
    this.preview = null;
    if (voice) {
      try {
        voice.source.onended = null;
        voice.source.stop();
      } catch {
        // already stopped
      }
    }
  }

  stopScrub(fadeSec = 0.045): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    const end = now + fadeSec;
    for (const [, voice] of this.scrubVoices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, end);
        voice.source.stop(end + 0.02);
      } catch {
        // already stopped
      }
    }
  }

  stopAll(): void {
    this.stopNormal();
    this.stopPreview();
    this.stopScrub(0.035);
  }

  playNormal(buffer: AudioBuffer, offsetSec: number, delaySec = 0.09): number {
    if (!this.context || !this.master) throw new Error('AudioContext not ready');
    this.stopNormal();
    this.stopPreview();
    this.stopScrub(0.055);

    const ctx = this.context;
    const offset = Math.max(0, Math.min(offsetSec, Math.max(0, buffer.duration - 0.005)));
    const when = ctx.currentTime + delaySec;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    source.start(when, offset);

    this.normal = { source, offset, startedAtCtx: when };
    source.onended = () => {
      if (this.normal?.source === source) {
        this.normal = null;
        this.onNormalEnded?.();
      }
    };
    return when;
  }

  getNormalPosition(): number | null {
    if (!this.context || !this.normal) return null;
    return this.normal.offset + this.context.currentTime - this.normal.startedAtCtx;
  }

  isNormalPlaying(): boolean {
    return this.normal !== null;
  }

  pauseNormal(): number {
    const position = this.getNormalPosition();
    this.stopNormal();
    return position ?? 0;
  }

  startAtom(atom: ScrubAtom, original: AudioBuffer, reversed: AudioBuffer): void {
    if (!this.context || !this.master) return;
    const ctx = this.context;
    const buffer = atom.direction === -1 ? reversed : original;
    const offset = bufferOffsetForAtom(atom, buffer.duration);
    if (offset >= buffer.duration - 0.002) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = atom.rate;

    const gain = ctx.createGain();
    const when = ctx.currentTime + 0.012;
    applyAtomEnvelope(gain.gain, when, atom);
    source.connect(gain);
    gain.connect(this.master);

    const voice: ScrubVoice = { source, gain, startedWhen: when };
    this.scrubVoices.set(atom.id, voice);
    source.onended = () => {
      if (this.scrubVoices.get(atom.id)?.source === source) this.scrubVoices.delete(atom.id);
    };

    source.start(when, offset);
    source.stop(when + atom.duration + 0.04);

    // Defensive voice cap: never let a fast event burst accumulate.
    if (this.scrubVoices.size > 5) {
      const oldestId = this.scrubVoices.keys().next().value;
      if (oldestId) this.stopAtom(oldestId, 0.018);
    }
  }

  stopAtom(id: string, fadeOut: number): void {
    const voice = this.scrubVoices.get(id);
    if (!voice || !this.context) return;
    const now = this.context.currentTime;
    const end = now + fadeOut;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, end);
      voice.source.stop(end + 0.015);
    } catch {
      // already stopped
    }
  }

  playRenderedBuffer(buffer: AudioBuffer, onEnded?: () => void): void {
    if (!this.context || !this.master) throw new Error('AudioContext not ready');
    this.stopPreview();
    this.stopNormal();
    this.stopScrub(0.04);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    this.preview = { source };
    source.onended = () => {
      if (this.preview?.source === source) {
        this.preview = null;
        onEnded?.();
        this.onPreviewEnded?.();
      }
    };
    source.start();
  }
}
