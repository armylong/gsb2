import * as THREE from 'three';
import type { CameraRig } from './CameraRig';
import type { CameraSample } from './types';

export interface ExportOptions {
  /** Sample interval in seconds. Endpoints are always included. */
  intervalSeconds: number;
}

export interface ExportedFrame {
  index: number;
  time: number;
  /** Arc-length progress in [0,1] (closed loop: 1 equals the 0 seam). */
  progress: number;
  /** Travelled arc length in metres. */
  arcLength: number;
  /** Camera position in metres, world axes X right, Y up, Z toward viewer (right-handed). */
  position: { x: number; y: number; z: number };
  /** Full orientation as a unit quaternion [w, x, y, z]. */
  quaternion: { w: number; x: number; y: number; z: number };
  /**
   * Intrinsic Euler angles in radians, rotation order XYZ (roll about local X,
   * then pitch about local Y, then yaw about local Z — three.js convention).
   * Derived from the quaternion; prefer the quaternion for interpolation.
   */
  eulerRadians: { x: number; y: number; z: number; order: 'XYZ' };
  /** Camera local axes in world coordinates, unit vectors. */
  axes: {
    right: { x: number; y: number; z: number }; // local +X
    up: { x: number; y: number; z: number }; // local +Y
    backward: { x: number; y: number; z: number }; // local +Z; viewing direction is -backward
  };
  targetHeld: boolean;
}

export interface ExportDocument {
  format: 'camera-dolly-export';
  formatVersion: 1;
  generatedAt: string;
  conventions: {
    coordinateSystem: 'right-handed; X right, Y up, Z toward viewer';
    lengthUnit: 'metre';
    timeUnit: 'second';
    angleUnit: 'radian';
    quaternionOrder: '[w, x, y, z], unit quaternion, rotates local camera axes to world';
    eulerOrder: 'intrinsic XYZ radians';
    cameraAxes: '+X right, +Y up, +Z backward; the camera looks along local -Z';
    progress: 'normalized arc length; on a closed loop progress 1 is the same pose as 0';
  };
  path: {
    mode: 'open' | 'closed';
    totalLength: number;
    controlPoints: { x: number; y: number; z: number }[];
  };
  playback: {
    duration: number;
    speedMode: 'constant' | 'timed';
    lookMode: 'forward' | 'target';
    timeKnots: { t: number; p: number }[];
    target: { x: number; y: number; z: number };
  };
  sampling: { intervalSeconds: number; frameCount: number; includesEndpoints: true };
  frames: ExportedFrame[];
}

function v3(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}

function round(n: number): number {
  // 9 decimals: sub-nanometre precision, keeps files readable.
  return Number(n.toFixed(9));
}

function frameToJson(index: number, s: CameraSample): ExportedFrame {
  return {
    index,
    time: round(s.time),
    progress: round(s.progress),
    arcLength: round(s.arcLength),
    position: v3(s.position),
    quaternion: {
      w: round(s.quaternion.w),
      x: round(s.quaternion.x),
      y: round(s.quaternion.y),
      z: round(s.quaternion.z),
    },
    eulerRadians: {
      x: round(s.euler.x),
      y: round(s.euler.y),
      z: round(s.euler.z),
      order: 'XYZ',
    },
    axes: { right: v3(s.right), up: v3(s.up), backward: v3(s.backward) },
    targetHeld: s.targetHeld,
  };
}

/**
 * Build the export document from the CURRENT rig (path + duration + speed
 * mode). Sampling at interval dt, always including t=0 and t=duration.
 * Every frame comes from the same stateless evaluator used by the preview,
 * so an exported frame at time t matches the on-screen pose at t exactly.
 */
export function buildExport(rig: CameraRig, opts: ExportOptions): ExportDocument {
  const dt = Math.max(1e-4, opts.intervalSeconds);
  const duration = rig.duration;
  const count = Math.max(1, Math.round(duration / dt));
  const frames: ExportedFrame[] = [];

  for (let k = 0; k <= count; k++) {
    const t = k === count ? duration : Math.min(duration, k * dt);
    frames.push(frameToJson(k, rig.sampleAt(t)));
  }

  const cfg = rig.path.config;
  const pb = rig.playback;
  return {
    format: 'camera-dolly-export',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    conventions: {
      coordinateSystem: 'right-handed; X right, Y up, Z toward viewer',
      lengthUnit: 'metre',
      timeUnit: 'second',
      angleUnit: 'radian',
      quaternionOrder: '[w, x, y, z], unit quaternion, rotates local camera axes to world',
      eulerOrder: 'intrinsic XYZ radians',
      cameraAxes: '+X right, +Y up, +Z backward; the camera looks along local -Z',
      progress: 'normalized arc length; on a closed loop progress 1 is the same pose as 0',
    },
    path: {
      mode: cfg.mode,
      totalLength: round(rig.path.totalLength),
      controlPoints: cfg.controlPoints.map(v3),
    },
    playback: {
      duration: round(duration),
      speedMode: pb.speedMode,
      lookMode: pb.lookMode,
      timeKnots: pb.timeKnots.map((k) => ({ t: round(k.t), p: round(k.p) })),
      target: v3(pb.target),
    },
    sampling: { intervalSeconds: round(dt), frameCount: frames.length, includesEndpoints: true },
    frames,
  };
}

/** Trigger a local file download in the browser. */
export function downloadJson(doc: ExportDocument, filename = 'camera-dolly-export.json'): void {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
