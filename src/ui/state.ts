import * as THREE from 'three';
import type { PathConfig, PathMode, PlaybackConfig, SpeedMode, LookMode, TimeKnot } from '../core/types';
import { defaultTimeKnots } from '../core/timeMapping';
import { ordinaryPreset } from '../core/presets';

/** Mutable application state. The rig is rebuilt deterministically from this. */
export interface AppState {
  path: PathConfig;
  playback: PlaybackConfig;
  /** Current playhead in seconds. */
  currentTime: number;
  playing: boolean;
  /** Playback rate multiplier. */
  rate: number;
  /** Export sample interval (seconds). */
  exportInterval: number;
  activePresetId: string;
}

export function createInitialState(): AppState {
  const preset = ordinaryPreset();
  return {
    path: structuredCloneish(preset.path),
    playback: structuredCloneish(preset.playback),
    currentTime: 0,
    playing: false,
    rate: 1,
    exportInterval: 0.5,
    activePresetId: preset.id,
  };
}

/** structuredClone cannot copy three.js Vector3; do an explicit deep copy. */
export function clonePath(p: PathConfig): PathConfig {
  return {
    mode: p.mode,
    tension: p.tension,
    controlPoints: p.controlPoints.map((v) => v.clone()),
  };
}

export function clonePlayback(p: PlaybackConfig): PlaybackConfig {
  return {
    speedMode: p.speedMode,
    lookMode: p.lookMode,
    duration: p.duration,
    timeKnots: p.timeKnots.map((k) => ({ ...k })),
    target: p.target.clone(),
  };
}

function structuredCloneish<T>(v: T): T {
  if (v instanceof THREE.Vector3) return v.clone() as unknown as T;
  if (Array.isArray(v)) return v.map(structuredCloneish) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = structuredCloneish(val);
    }
    return out as T;
  }
  return v;
}

export type { PathMode, SpeedMode, LookMode, TimeKnot };
export { defaultTimeKnots };
