import { timeToX } from '../domain/mapping';
import type { DemoCue } from '../audio/demo';
import type { WavePeaks } from '../audio/peaks';
import type { ScrubRoute } from '../domain/types';

export interface WaveformDrawState {
  durationSec: number;
  currentTime: number;
  peaks: WavePeaks | null;
  route?: ScrubRoute | null;
  cues?: DemoCue[];
  playing?: boolean;
}

const COLORS = {
  left: '#2563eb',
  right: '#0891b2',
  forward: '#2563eb',
  reverse: '#ea580c',
  ink: '#1f2937',
  muted: '#6b7280',
  grid: '#e5e7eb',
  panel: '#ffffff',
};

function prepareCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(180, rect.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function tickInterval(duration: number, width: number): number {
  const target = duration / Math.max(4, width / 96);
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => step >= target) ?? 300;
}

export function drawWaveform(canvas: HTMLCanvasElement, state: WaveformDrawState): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { ctx, width, height } = prepared;
  const duration = Math.max(0.01, state.durationSec);
  const ruler = 30;
  const laneGap = 14;
  const channelCount = Math.max(1, state.peaks?.channels.length ?? 2);
  const laneHeight = (height - ruler - 10 - laneGap * (channelCount - 1)) / channelCount;

  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, 0, width, height);

  // Time ruler and grid.
  const interval = tickInterval(duration, width);
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (let t = 0; t <= duration + interval * 0.01; t += interval) {
    const x = timeToX(t, width, duration);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, ruler - 6);
    ctx.lineTo(x, height - 4);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = x < 42 ? 'left' : 'center';
    ctx.fillText(`${Number(t.toFixed(2))}s`, x + (x < 42 ? 4 : 0), 12);
  }

  // Built-in cue labels.
  if (state.cues?.length) {
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    state.cues.forEach((cue) => {
      const x = timeToX(cue.time, width, duration);
      ctx.strokeStyle = 'rgba(22,163,74,0.18)';
      ctx.beginPath();
      ctx.moveTo(x, ruler - 4);
      ctx.lineTo(x, height - 4);
      ctx.stroke();
      ctx.fillStyle = '#15803d';
      ctx.textAlign = 'center';
      ctx.fillText(cue.label, x + 5, 24);
    });
  }

  const laneTops = Array.from({ length: channelCount }, (_, i) => ruler + i * (laneHeight + laneGap));

  // Route overlays.
  if (state.route) {
    for (const atom of state.route.atoms) {
      const span = Math.min(duration, Math.max(0.012, atom.duration * atom.rate));
      const leftTime = atom.direction === 1 ? atom.sourceTime : Math.max(0, atom.sourceTime - span);
      const rightTime = atom.direction === 1 ? Math.min(duration, atom.sourceTime + span) : atom.sourceTime;
      const x1 = timeToX(leftTime, width, duration);
      const x2 = timeToX(rightTime, width, duration);
      laneTops.forEach((top) => {
        ctx.fillStyle = atom.direction === 1 ? 'rgba(37,99,235,0.13)' : 'rgba(234,88,12,0.16)';
        ctx.fillRect(x1, top, Math.max(2, x2 - x1), laneHeight);
      });
      ctx.strokeStyle = atom.direction === 1 ? COLORS.forward : COLORS.reverse;
      ctx.lineWidth = 1.5;
      const anchorX = timeToX(atom.sourceTime, width, duration);
      laneTops.forEach((top) => {
        ctx.beginPath();
        ctx.moveTo(anchorX, top + 3);
        ctx.lineTo(anchorX, top + laneHeight - 3);
        ctx.stroke();
      });
    }
  }

  // Wave lanes.
  if (!state.peaks) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('打开 WAV 或载入内置示例后显示左右波形', width / 2, height / 2);
    return;
  }

  state.peaks.channels.forEach((channel, channelIndex) => {
    const top = laneTops[channelIndex];
    const centerY = top + laneHeight / 2;
    const amplitude = laneHeight * 0.43;
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, top, width, laneHeight);
    ctx.strokeStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();

    const color = channelIndex === 0 ? COLORS.left : COLORS.right;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.72;
    for (let x = 0; x < width; x += 1) {
      const bucket = Math.min(channel.max.length - 1, Math.floor((x / width) * channel.max.length));
      const yTop = centerY - channel.max[bucket] * amplitude;
      const yBottom = centerY - channel.min[bucket] * amplitude;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = COLORS.ink;
    ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(channelIndex === 0 ? 'L' : 'R', 8, top + 12);
  });

  // Playhead.
  const playheadX = timeToX(state.currentTime, width, duration);
  ctx.strokeStyle = state.playing ? '#16a34a' : COLORS.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playheadX, 4);
  ctx.lineTo(playheadX, height - 4);
  ctx.stroke();
  ctx.fillStyle = state.playing ? '#16a34a' : COLORS.ink;
  ctx.beginPath();
  ctx.moveTo(playheadX - 6, 4);
  ctx.lineTo(playheadX + 6, 4);
  ctx.lineTo(playheadX, 13);
  ctx.closePath();
  ctx.fill();
}

export function drawMiniWave(canvas: HTMLCanvasElement, peaks: WavePeaks | null, progress = 0): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { ctx, width, height } = prepared;
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);
  if (!peaks) return;
  const channel = peaks.channels[0];
  if (!channel) return;
  const centerY = height / 2;
  const amplitude = height * 0.42;
  ctx.fillStyle = '#94a3b8';
  for (let x = 0; x < width; x += 1) {
    const bucket = Math.min(channel.max.length - 1, Math.floor((x / width) * channel.max.length));
    const yTop = centerY - channel.max[bucket] * amplitude;
    const yBottom = centerY - channel.min[bucket] * amplitude;
    ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
  }
  if (progress > 0) {
    ctx.fillStyle = 'rgba(22,163,74,0.28)';
    ctx.fillRect(0, 0, width * Math.min(1, progress), height);
    ctx.fillStyle = '#16a34a';
    ctx.fillRect(width * Math.min(1, progress), 0, 2, height);
  }
}
