import * as THREE from 'three';
import type { TraceResult, TraceEvent } from '../physics/tracer';
import { toV3 } from './tank';

const COLORS = {
  segment: 0x4fc3f7,
  cameraRay: 0x607d8b,
  baseline: 0xffffff,
  tir: 0xce93d8,
  out: 0xef5350,
  blocked: 0xffb74d,
  ruler: 0x81c784,
  point: 0xffe082,
  apparent: 0x4dd0e1,
  swingA: 0xffcc80,
  swingB: 0x90caf9,
};

/** 一段折线（支持虚线） */
function makeLine(points: THREE.Vector3[], color: number, dashed = false, opacity = 1): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 1.1, gapSize: 0.7, transparent: true, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 20;
  return line;
}

function makeSphere(color: number, radius = 0.45): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false }),
  );
  m.renderOrder = 30;
  return m;
}

export interface RayVisual {
  group: THREE.Group;
  children: RayVisual[];
  dispose: () => void;
}

function makeVisual(group: THREE.Group, disposables: (THREE.BufferGeometry | THREE.Material)[]): RayVisual {
  const children: RayVisual[] = [];
  return {
    group,
    children,
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      children.forEach((c) => c.dispose());
    },
  };
}

/** 把一条 TraceResult 画成路径 + 事件标记 */
export function visualizeTrace(
  result: TraceResult,
  opts: { showCameraRay?: boolean; isBaseline?: boolean; lineColor?: number; dashed?: boolean } = {},
): RayVisual {
  const group = new THREE.Group();
  group.name = 'ray';
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  const track = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    disposables.push(x);
    return x;
  };

  if (opts.isBaseline) {
    // 基线：整条白色虚线
    const pts = result.points.map(toV3);
    const line = makeLine(pts, opts.lineColor ?? COLORS.baseline, true, 0.75);
    track(line.geometry);
    track(line.material as THREE.Material);
    group.add(line);
    if (result.reading) {
      const s = makeSphere(COLORS.baseline, 0.32);
      s.position.copy(toV3(result.endpoint));
      group.add(s);
    }
    return makeVisual(group, disposables);
  }

  // 实际路径：按事件给每段上色
  const events = result.events;
  const pts = result.points.map(toV3);

  // 原始相机视线（点击点之前）——灰蓝实线，便于对照表观方向
  if (opts.showCameraRay && pts.length >= 2) {
    const line = makeLine([pts[0], pts[1]], COLORS.cameraRay, false, 0.85);
    track(line.geometry);
    track(line.material as THREE.Material);
    group.add(line);
  }

  // 折射段：分段绘制，TIR 段用紫色，普通段用青色，超范围末段红色虚线
  for (let i = 1; i < pts.length; i++) {
    const ev = events[i - 1];
    let color = COLORS.segment;
    let dashed = false;
    let opacity = 0.95;
    if (ev?.kind === 'tir') color = COLORS.tir;
    if (ev?.kind === 'out-of-range') {
      color = COLORS.out;
      dashed = true;
      opacity = 0.95;
    }
    if (ev?.kind === 'blocked') color = COLORS.blocked;
    const line = makeLine([pts[i - 1], pts[i]], color, dashed, opacity);
    track(line.geometry);
    track(line.material as THREE.Material);
    group.add(line);
  }

  // 事件点标记
  events.forEach((ev: TraceEvent, idx) => {
    if (ev.kind === 'out-of-range') return; // 末端单独处理
    let color = COLORS.point;
    let radius = 0.32;
    if (ev.kind === 'tir') {
      color = COLORS.tir;
      radius = 0.55;
    } else if (ev.kind === 'ruler') {
      color = COLORS.ruler;
      radius = 0.6;
    } else if (ev.kind === 'blocked') {
      color = COLORS.blocked;
      radius = 0.55;
    }
    const s = makeSphere(color, radius);
    s.position.copy(toV3(ev.point));
    s.name = `event-${idx}`;
    group.add(s);
  });

  // 末端状态标记
  const end = makeSphere(
    result.status === 'out-of-range'
      ? COLORS.out
      : result.status.startsWith('blocked')
        ? COLORS.blocked
        : COLORS.ruler,
    0.7,
  );
  end.position.copy(toV3(result.endpoint));
  group.add(end);

  // 超范围：在末端加醒目红色 X + 圆环脉冲，明确“这里没有读数”
  if (result.status === 'out-of-range') {
    const xGroup = new THREE.Group();
    const mat = track(new THREE.LineBasicMaterial({ color: COLORS.out, depthTest: false }));
    const r = 1.8;
    const c = toV3(result.endpoint);
    for (const [a, b] of [
      [new THREE.Vector3(-r, -r, 0), new THREE.Vector3(r, r, 0)],
      [new THREE.Vector3(-r, r, 0), new THREE.Vector3(r, -r, 0)],
    ]) {
      const g = track(new THREE.BufferGeometry().setFromPoints([a.clone().add(c), b.clone().add(c)]));
      const l = new THREE.Line(g, mat);
      l.renderOrder = 31;
      xGroup.add(l);
    }
    // 红色圆环（始终面向相机）
    const ringMat = track(new THREE.MeshBasicMaterial({ color: COLORS.out, transparent: true, opacity: 0.9, depthTest: false }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.7, 32), ringMat);
    ring.position.copy(c);
    ring.renderOrder = 30;
    ring.userData.billboard = true;
    xGroup.add(ring);
    group.add(xGroup);
    group.userData.pulseRing = ring;
  }

  // 表观方向延长线：从第一个命中点沿原始视线到后标尺（青色点线）
  if (result.apparentPoint && pts.length >= 2) {
    const line = makeLine([pts[1], toV3(result.apparentPoint)], COLORS.apparent, true, 0.45);
    track(line.geometry);
    track(line.material as THREE.Material);
    group.add(line);
  }

  return makeVisual(group, disposables);
}

/** 暂停扫查时的 ±1.5° 两条对比路径 */
export function visualizeSwing(
  result: TraceResult,
  color: number,
): RayVisual {
  const group = new THREE.Group();
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const pts = result.points.map(toV3);
  for (let i = 1; i < pts.length; i++) {
    const ev = result.events[i - 1];
    const isTir = ev?.kind === 'tir';
    const isOut = ev?.kind === 'out-of-range';
    const line = makeLine(
      [pts[i - 1], pts[i]],
      isTir ? COLORS.tir : isOut ? COLORS.out : color,
      isOut,
      0.85,
    );
    disposables.push(line.geometry, line.material as THREE.Material);
    group.add(line);
  }
  const end = makeSphere(color, 0.4);
  end.position.copy(toV3(result.endpoint));
  group.add(end);
  return makeVisual(group, disposables);
}
