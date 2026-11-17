import * as THREE from 'three';
import type { PathConfig, PlaybackConfig } from './types';
import { defaultTimeKnots } from './timeMapping';

export interface Preset {
  id: string;
  name: string;
  description: string;
  path: PathConfig;
  playback: PlaybackConfig;
}

const DURATION = 12;

function basePlayback(overrides: Partial<PlaybackConfig> = {}): PlaybackConfig {
  return {
    speedMode: 'constant',
    lookMode: 'forward',
    duration: DURATION,
    timeKnots: defaultTimeKnots(DURATION),
    target: new THREE.Vector3(0, 2, 0),
    ...overrides,
  };
}

/** 1. Ordinary curved open path with a gentle hill and an S bend. */
export function ordinaryPreset(): Preset {
  const pts: THREE.Vector3[] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = i / (n - 1);
    const x = -18 + 36 * a;
    const z = Math.sin(a * Math.PI * 1.5) * 7;
    const y = 1.5 + Math.sin(a * Math.PI) * 3;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return {
    id: 'ordinary',
    name: '普通弯道（开放）',
    description: '缓坡 + S 弯，开放路径，用于检查普通弯道的速度与朝向平滑性。',
    path: { controlPoints: pts, mode: 'open', tension: 0.5 },
    playback: basePlayback({ target: new THREE.Vector3(0, 3, 0) }),
  };
}

/** 2. Open path with a full vertical climb, an inverted overhang feel and a descent. */
export function verticalPreset(): Preset {
  const pts: THREE.Vector3[] = [
    new THREE.Vector3(-14, 2, 0),
    new THREE.Vector3(-8, 2, 0),
    new THREE.Vector3(-4, 2, 0),
    new THREE.Vector3(-4, 8, 0), // straight vertical climb
    new THREE.Vector3(-4, 14, 0),
    new THREE.Vector3(0, 16, 0), // crest
    new THREE.Vector3(4, 14, 0),
    new THREE.Vector3(4, 8, 0), // straight vertical descent
    new THREE.Vector3(4, 2, 0),
    new THREE.Vector3(10, 2, 0),
    new THREE.Vector3(14, 2, 0),
  ];
  // Time curve: slow the climb (dwell around the vertical section), then speed up.
  const knots = [
    { t: 0, p: 0 },
    { t: DURATION * 0.45, p: 0.28 },
    { t: DURATION * 0.6, p: 0.55 },
    { t: DURATION * 0.8, p: 0.72 },
    { t: DURATION, p: 1 },
  ];
  return {
    id: 'vertical',
    name: '含竖直段（开放）',
    description: '包含完整竖直爬升与下降段，检查经过竖直方向时朝向不翻转、不滚转半圈。',
    path: { controlPoints: pts, mode: 'open', tension: 0.5 },
    playback: basePlayback({
      speedMode: 'timed',
      timeKnots: knots,
      target: new THREE.Vector3(0, 9, 6),
    }),
  };
}

/** 3. Closed loop with a banked turn, crossing different heights; seam must be continuous. */
export function closedPreset(): Preset {
  const pts: THREE.Vector3[] = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 11 + Math.sin(a * 3) * 2.5;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = 3 + Math.sin(a * 2) * 4;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return {
    id: 'closed',
    name: '闭环路径（循环）',
    description: '起伏环形闭环，检查循环接缝处位置与朝向完全衔接、循环播放无跳变。',
    path: { controlPoints: pts, mode: 'closed', tension: 0.5 },
    playback: basePlayback({ target: new THREE.Vector3(0, 4, 0) }),
  };
}

export const ALL_PRESETS: (() => Preset)[] = [ordinaryPreset, verticalPreset, closedPreset];
