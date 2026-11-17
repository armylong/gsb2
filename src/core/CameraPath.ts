import * as THREE from 'three';
import type { PathConfig } from './types';

/**
 * A Catmull-Rom camera path with:
 *  - exact arc-length parameterization (constant-speed playback never sees
 *    speed changes from uneven control-point spacing),
 *  - a parallel-transport frame (no flips through vertical segments),
 *  - twist correction on closed loops so the frame matches across the seam.
 *
 * All queries are pure functions of the arc-length fraction: two calls with
 * the same fraction always return the same pose, independent of history.
 */
export class CameraPath {
  readonly config: PathConfig;
  readonly curve: THREE.CatmullRomCurve3;
  readonly totalLength: number;
  readonly closed: boolean;

  /** Number of integration segments. */
  static readonly SEGMENTS = 2048;
  private readonly M = CameraPath.SEGMENTS;

  private readonly points: THREE.Vector3[]; // length M+1
  private readonly cum: Float64Array; // length M+1, cum[M] = totalLength
  private readonly tangents: THREE.Vector3[]; // length M (segment tangents); closed wraps
  private readonly ups: THREE.Vector3[]; // length M+1, parallel-transport up vector

  constructor(config: PathConfig) {
    this.config = config;
    this.closed = config.mode === 'closed';
    if (config.controlPoints.length < 2) {
      throw new Error('CameraPath needs at least 2 control points');
    }
    this.curve = new THREE.CatmullRomCurve3(
      config.controlPoints.map((p) => p.clone()),
      this.closed,
      'centripetal',
      config.tension,
    );

    const M = this.M;
    this.points = new Array(M + 1);
    for (let i = 0; i <= M; i++) {
      this.points[i] = this.curve.getPoint(i / M);
    }

    // Arc-length cumulative table.
    this.cum = new Float64Array(M + 1);
    for (let i = 0; i < M; i++) {
      this.cum[i + 1] = this.cum[i] + this.points[i].distanceTo(this.points[i + 1]);
    }
    this.totalLength = this.cum[M];

    // Segment tangents.
    this.tangents = new Array(M);
    for (let i = 0; i < M; i++) {
      this.tangents[i] = this.points[i + 1].clone().sub(this.points[i]).normalize();
    }

    this.ups = this.buildTransportFrames();
  }

  /** Parallel transport an up vector along the whole curve; correct residual twist on loops. */
  private buildTransportFrames(): THREE.Vector3[] {
    const M = this.M;
    const T = this.tangents;
    const up = new Array<THREE.Vector3>(M + 1);

    // Initial up: world Y projected onto the plane perpendicular to T0.
    const helper = Math.abs(T[0].y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    up[0] = helper.clone().addScaledVector(T[0], -helper.dot(T[0])).normalize();

    const axis = new THREE.Vector3();
    for (let i = 0; i < M; i++) {
      const t0 = T[i];
      const t1 = T[(i + 1) % M];
      axis.crossVectors(t0, t1);
      const sinA = axis.length();
      const cosA = THREE.MathUtils.clamp(t0.dot(t1), -1, 1);
      const n = up[i].clone();
      if (sinA > 1e-10) {
        const angle = Math.atan2(sinA, cosA);
        n.applyAxisAngle(axis.normalize(), angle);
      }
      // Re-orthogonalize against the new tangent to kill numerical drift.
      n.addScaledVector(t1, -n.dot(t1)).normalize();
      up[i + 1] = n;
    }

    if (this.closed) {
      // up[M] is the transported frame back at the seam tangent T[0].
      // Remove the residual twist by rotating each frame around its own tangent,
      // distributing the correction evenly along the loop.
      const twist = Math.atan2(
        new THREE.Vector3().crossVectors(up[M], up[0]).dot(T[0]),
        THREE.MathUtils.clamp(up[M].dot(up[0]), -1, 1),
      );
      for (let i = 1; i <= M; i++) {
        const ti = i < M ? T[i] : T[0];
        up[i].applyAxisAngle(ti, (-twist * i) / M);
        up[i].addScaledVector(ti, -up[i].dot(ti)).normalize();
      }
      // Force exact seam equality.
      up[M].copy(up[0]);
    }

    return up;
  }

  /** Locate the integration segment containing arc-length fraction q. */
  private locate(q: number): { i: number; alpha: number; dist: number } {
    const qq = THREE.MathUtils.clamp(q, 0, 1);
    const dist = qq * this.totalLength;
    const M = this.M;
    let lo = 0;
    let hi = M;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < dist) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(0, lo - 1);
    const segLen = this.cum[i + 1] - this.cum[i] || 1;
    const alpha = THREE.MathUtils.clamp((dist - this.cum[i]) / segLen, 0, 1);
    return { i, alpha, dist };
  }

  /** Position at arc-length fraction q in [0,1]. */
  positionAt(q: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { i, alpha } = this.locate(q);
    return out.copy(this.points[i]).lerp(this.points[i + 1], alpha);
  }

  /** Unit tangent (direction of travel) at q. */
  tangentAt(q: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { i, alpha } = this.locate(q);
    if (this.closed && q >= 1 - 1e-12) {
      // Exact seam: report the first frame's tangent so the loop closes.
      return out.copy(this.tangents[0]);
    }
    const t1 = this.tangents[Math.min(i + 1, this.M - 1)];
    out.copy(this.tangents[i]).lerp(t1, alpha);
    if (out.lengthSq() < 1e-12) out.copy(this.tangents[i]);
    return out.normalize();
  }

  /** Parallel-transport up vector at q — continuous through vertical runs and the loop seam. */
  upAt(q: number, out = new THREE.Vector3()): THREE.Vector3 {
    if (this.closed && q >= 1 - 1e-12) {
      return out.copy(this.ups[0]);
    }
    const { i, alpha } = this.locate(q);
    out.copy(this.ups[i]).lerp(this.ups[i + 1], alpha);
    const t = this.tangentAt(q, _tmpT);
    out.addScaledVector(t, -out.dot(t)).normalize();
    return out;
  }

  /** Right vector = tangent x up. */
  rightAt(q: number, out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.tangentAt(q, _tmpT);
    const u = this.upAt(q, _tmpU);
    return out.crossVectors(t, u).normalize();
  }

  /** Discretized frame at integration index i in [0, M] (used by the evaluator tables). */
  frameAt(i: number): { position: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3 } {
    const idx = Math.min(i, this.M);
    const tangent =
      idx < this.M ? this.tangents[idx] : this.closed ? this.tangents[0] : this.tangents[this.M - 1];
    return { position: this.points[idx], tangent, up: this.ups[idx] };
  }

  get segmentCount(): number {
    return this.M;
  }
}

const _tmpT = new THREE.Vector3();
const _tmpU = new THREE.Vector3();
