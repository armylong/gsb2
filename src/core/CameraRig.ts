import * as THREE from 'three';
import { CameraPath } from './CameraPath';
import { progressAtTime } from './timeMapping';
import type { CameraSample, PathConfig, PlaybackConfig } from './types';

const EPS = 1e-3; // 1 mm: target closer than this counts as coincident

/**
 * Stateless camera evaluator.
 *
 * Every call to {@link sampleAt} depends only on (config, time): seeking to t
 * and playing continuously to t produce byte-identical poses, with no hidden
 * velocity integration, previous-frame memory or quaternion sign drift.
 *
 * Orientation continuity:
 *  - forward mode uses the path's parallel-transport frame,
 *  - target mode builds a dense table of look-at quaternions whose signs are
 *    canonicalized against the previous sample, and holds the last valid
 *    orientation while target and camera coincide.
 */
export class CameraRig {
  readonly path: CameraPath;
  readonly playback: PlaybackConfig;

  private readonly N: number;
  private readonly fwdQ: THREE.Quaternion[];
  private readonly tgtQ: THREE.Quaternion[];
  private readonly tgtHeld: boolean[];

  constructor(pathConfig: PathConfig, playback: PlaybackConfig) {
    this.path = new CameraPath(pathConfig);
    this.playback = playback;
    this.N = this.path.segmentCount;
    this.fwdQ = new Array(this.N + 1);
    this.tgtQ = new Array(this.N + 1);
    this.tgtHeld = new Array(this.N + 1).fill(false);
    this.buildForwardTable();
    this.buildTargetTable();
  }

  get duration(): number {
    return this.playback.duration;
  }

  private static basisToQuaternion(
    right: THREE.Vector3,
    up: THREE.Vector3,
    backward: THREE.Vector3,
  ): THREE.Quaternion {
    // Camera axes in world coordinates: columns of the rotation matrix.
    const m = new THREE.Matrix4().makeBasis(right, up, backward);
    // Normalize defensively: setFromRotationMatrix assumes an orthonormal
    // basis; any tiny drift in the input vectors would otherwise produce a
    // non-unit quaternion and break angle-based orientation comparisons.
    return new THREE.Quaternion().setFromRotationMatrix(m).normalize();
  }

  private buildForwardTable(): void {
    const p = this.path;
    for (let i = 0; i <= this.N; i++) {
      const q = i / this.N;
      const tangent = p.tangentAt(q);
      const up = p.upAt(q);
      const right = p.rightAt(q);
      // Looking along tangent: camera local -Z points along travel,
      // so local +Z (backward) is -tangent.
      const backward = tangent.clone().negate();
      this.fwdQ[i] = CameraRig.basisToQuaternion(right, up, backward);
    }

    if (this.path.closed) {
      // The transport frame already matches at the seam; canonicalize the sign
      // anyway so table slerp near q=1 can never see a half-turn.
      const first = this.fwdQ[0];
      const last = this.fwdQ[this.N];
      if (last.dot(first) < 0) last.set(-last.x, -last.y, -last.z, -last.w);
      last.copy(first); // exact seam equality
    }
  }

  private buildTargetTable(): void {
    const p = this.path;
    const target = this.playback.target;
    const pos = new THREE.Vector3();
    const upRef = new THREE.Vector3();
    const rightRef = new THREE.Vector3();
    const f = new THREE.Vector3(); // view direction (camera local -Z)
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const q = new THREE.Quaternion();
    // The coincidence/hold region spans ~1.5 integration cells around the
    // target: at 2048 cells the arc spacing is L/2048. This keeps the frozen
    // window sampled as a contiguous multi-cell block at any practical frame
    // rate while still being small on normal paths (~3 cm for a 40 m path).
    const holdRadius = Math.max(EPS, (p.totalLength / p.segmentCount) * 1.5);

    let lastValid: THREE.Quaternion | null = null;

    for (let i = 0; i <= this.N; i++) {
      const frac = i / this.N;
      p.positionAt(frac, pos);
      p.upAt(frac, upRef); // transport up as the roll reference: no flips at vertical runs
      p.rightAt(frac, rightRef);
      f.subVectors(target, pos);
      const dist = f.length();

      if (dist < holdRadius) {
        this.tgtHeld[i] = true;
        if (lastValid) {
          const heldQ = lastValid.clone();
          // Sign-canonicalize even the frozen copy: quaternion double cover
          // would otherwise make angleTo() against the pre-hold pose report
          // a spurious large angle.
          if (heldQ.dot(lastValid) < 0) {
            heldQ.set(-heldQ.x, -heldQ.y, -heldQ.z, -heldQ.w);
          }
          this.tgtQ[i] = heldQ;
        }
        continue;
      }

      f.normalize();
      // Single-formula Gram-Schmidt frame, with NO branch on how parallel the
      // reference up is to the view direction. A branch switch between two
      // different roll references proved discontinuous near the degeneracy
      // (|up.f| ~ |right.f|). Instead:
      //   1. project the parallel-transport up onto the plane normal to f,
      //   2. if it collapses (looking exactly along the transport up), rebuild
      //      it from the transport right vector,
      //   3. derive right/up so (right, up, -f) is right-handed.
      // The rare fallback in step 2 only triggers at an exact singular point,
      // where any roll is equally valid, and still yields a continuous frame
      // because rightRef is itself parallel-transported.
      up.copy(upRef).addScaledVector(f, -upRef.dot(f));
      if (up.lengthSq() < 1e-12) {
        // f parallel to upRef: a perpendicular roll hint comes from rightRef.
        up.crossVectors(f, rightRef);
      }
      up.normalize();
      right.crossVectors(f, up).normalize();
      const backward = f.clone().negate();
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, backward)).normalize();

      if (lastValid) {
        // Quaternion double cover: pick the sign on the same hemisphere as the
        // previous sample so adjacent poses never jump a half turn.
        if (q.dot(lastValid) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      }
      this.tgtQ[i] = q.clone();
      lastValid = this.tgtQ[i];
    }

    if (this.path.closed && !this.tgtHeld[this.N]) {
      // Closed loop: force the seam pose to equal the start pose so a looped
      // playback has no orientation jump when wrapping t=duration -> 0.
      this.tgtQ[this.N].copy(this.tgtQ[0]);
    }

    // Backfill a coincident region that starts at i=0 (no previous valid
    // sample): find the nearest later valid sample and hold its orientation.
    if (this.tgtHeld[0] || !this.tgtQ[0]) {
      let j = 0;
      while (j <= this.N && (this.tgtHeld[j] || !this.tgtQ[j])) j++;
      if (j <= this.N) {
        for (let k = 0; k < j; k++) this.tgtQ[k] = this.tgtQ[j].clone();
      } else if (this.fwdQ[0]) {
        // Entire path coincides with target: fall back to forward orientation.
        for (let k = 0; k <= this.N; k++) this.tgtQ[k] = this.fwdQ[k].clone();
      }
    }
    // Defensive: any remaining gap gets the forward frame.
    for (let k = 0; k <= this.N; k++) {
      if (!this.tgtQ[k]) this.tgtQ[k] = this.fwdQ[k].clone();
    }
  }

  /** Arc-length progress for a given time under the configured speed mode. */
  progressForTime(time: number): number {
    const t = THREE.MathUtils.clamp(time, 0, this.playback.duration);
    if (this.playback.speedMode === 'constant') {
      return this.playback.duration <= 0 ? 0 : t / this.playback.duration;
    }
    return progressAtTime(this.playback.timeKnots, this.playback.duration, t);
  }

  /**
   * Pure evaluation: the full camera state at time `time`.
   * Calling this at t directly, or playing 0..t and calling at t, gives
   * identical results.
   */
  sampleAt(time: number): CameraSample {
    const clampedTime = THREE.MathUtils.clamp(time, 0, this.playback.duration);
    const progress = this.progressForTime(clampedTime);
    const p = this.path;

    const position = p.positionAt(progress);
    const tangent = p.tangentAt(progress);

    // Dense-table lookup with slerp between neighbouring grid poses.
    const x = progress * this.N;
    const i = Math.min(Math.floor(x), this.N - 1);
    const alpha = x - i;
    const table = this.playback.lookMode === 'forward' ? this.fwdQ : this.tgtQ;
    let quaternion: THREE.Quaternion;
    let held = false;
    if (
      this.playback.lookMode === 'target' &&
      (this.tgtHeld[i] || this.tgtHeld[i + 1])
    ) {
      // Any sample whose bracketing interval touches a coincidence cell
      // freezes on the held block's single shared pose (all held cells are
      // written with one identical quaternion while building the table), so
      // the whole coincidence window returns one bit-stable orientation.
      held = true;
      const heldIndex = this.tgtHeld[i] ? i : i + 1;
      quaternion = table[heldIndex].clone();
    } else {
      quaternion = table[i].clone().slerp(table[i + 1], alpha).normalize();
    }

    // Derive axis vectors from the final quaternion so export and on-screen
    // gizmo always agree with the actual orientation.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    const backward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');

    // Held flag was set together with the freeze rule above.

    return {
      time: clampedTime,
      progress,
      arcLength: progress * p.totalLength,
      position,
      tangent,
      backward,
      up,
      right,
      quaternion,
      euler,
      targetHeld: held,
    };
  }

  /** Speed in metres/second implied by the time curve at time t (numeric derivative). */
  speedAtTime(time: number): number {
    const dt = Math.min(0.01, this.playback.duration / 1000);
    const t0 = Math.max(0, time - dt);
    const t1 = Math.min(this.playback.duration, time + dt);
    if (t1 === t0) return 0;
    const s0 = this.progressForTime(t0) * this.path.totalLength;
    const s1 = this.progressForTime(t1) * this.path.totalLength;
    return (s1 - s0) / (t1 - t0);
  }
}
