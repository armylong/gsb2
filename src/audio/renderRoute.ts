import { bufferOffsetForAtom } from './scrubPlanner';
import type { ScrubAtom, ScrubRoute } from '../domain/types';

export function applyAtomEnvelope(param: AudioParam, when: number, atom: ScrubAtom): void {
  const duration = Math.max(0.03, atom.duration);
  const fadeIn = Math.min(atom.fadeIn, duration * 0.4);
  const fadeOut = Math.min(atom.fadeOut, duration * 0.45);
  param.setValueAtTime(0.0001, when);
  param.exponentialRampToValueAtTime(Math.max(0.001, atom.gain), when + fadeIn);
  const holdEnd = when + Math.max(fadeIn, duration - fadeOut);
  if (holdEnd > when + fadeIn + 0.004) param.setValueAtTime(atom.gain, holdEnd);
  param.exponentialRampToValueAtTime(0.0001, when + duration);
}

export async function renderRouteToBuffer(
  route: ScrubRoute,
  original: AudioBuffer,
  reversed: AudioBuffer,
): Promise<AudioBuffer> {
  const sampleRate = original.sampleRate;
  const totalDuration = Math.max(0.12, route.duration + 0.12);
  const length = Math.ceil(totalDuration * sampleRate);
  const offline = new OfflineAudioContext(2, length, sampleRate);

  for (const atom of route.atoms) {
    const buffer = atom.direction === -1 ? reversed : original;
    const offset = bufferOffsetForAtom(atom, buffer.duration);
    if (offset >= buffer.duration - 0.002) continue;

    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = atom.rate;

    const gain = offline.createGain();
    applyAtomEnvelope(gain.gain, atom.at + 0.01, atom);
    source.connect(gain);
    gain.connect(offline.destination);

    const when = atom.at + 0.01;
    source.start(when, offset);
    source.stop(when + atom.duration + 0.03);
  }

  return await offline.startRendering();
}
