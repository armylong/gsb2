import * as THREE from 'three';

/** Open path or closed loop. */
export type PathMode = 'open' | 'closed';

/** Constant arc-length speed, or variable speed driven by a time/progress curve. */
export type SpeedMode = 'constant' | 'timed';

/** Camera looks along path tangent, or keeps looking at a movable target. */
export type LookMode = 'forward' | 'target';

/** One editable node of the time curve: at time `t` seconds, arc fraction `p` of the whole path is done. */
export interface TimeKnot {
  t: number; // seconds, 0 <= t <= duration
  p: number; // normalized arc-length progress, 0 <= p <= 1
}

export interface PathConfig {
  /** Catmull-Rom control points in world coordinates, metres. */
  controlPoints: THREE.Vector3[];
  mode: PathMode;
  /** Catmull-Rom tension, 0.5 = centripetal (never overshoots, safe through vertical runs). */
  tension: number;
}

export interface PlaybackConfig {
  speedMode: SpeedMode;
  lookMode: LookMode;
  /** Total duration in seconds. */
  duration: number;
  /** Time-curve knots, kept sorted by t with non-decreasing p. */
  timeKnots: TimeKnot[];
  /** Movable look-at target in world coordinates (lookMode === 'target'). */
  target: THREE.Vector3;
}

/** Full, deterministic camera state at one instant. */
export interface CameraSample {
  /** Seconds from start. */
  time: number;
  /** Arc-length fraction in [0,1] (closed loop: 1 == 0 seam). */
  progress: number;
  /** Travelled arc length in metres. */
  arcLength: number;
  /** World-space position, metres; X right, Y up, Z toward viewer. */
  position: THREE.Vector3;
  /** Unit path tangent (direction of travel). */
  tangent: THREE.Vector3;
  /** Camera local +Z axis (backward), unit. */
  backward: THREE.Vector3;
  /** Camera local +Y axis (up), unit, parallel-transport continuous. */
  up: THREE.Vector3;
  /** Camera local +X axis (right), unit. */
  right: THREE.Vector3;
  /** Full orientation as a unit quaternion (w,x,y,z). */
  quaternion: THREE.Quaternion;
  /** Euler XYZ intrinsic angles in radians, derived from the quaternion. */
  euler: THREE.Euler;
  /** True when the look target coincides with the camera and the last valid pose is held. */
  targetHeld: boolean;
}
