import * as THREE from 'three';
import { computeFrames } from '../src/frames';
import { buildPipe, PipeParams } from '../src/pipe';
import { runValidation } from '../src/validate';
import { analyzePath } from '../src/warnings';
import { PRESETS, toVectors } from '../src/presets';

function build(pts: THREE.Vector3[], closed: boolean, params: Partial<PipeParams> = {}) {
  const p: PipeParams = { radius: 0.35, segments: 64, sides: 16, shape: 'circle', caps: true, closed, ...params };
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
  const sampled = curve.getSpacedPoints(p.segments);
  const seamGap = closed ? sampled[0].distanceTo(sampled[sampled.length - 1]) : 0;
  if (closed) sampled.pop();
  const frames = computeFrames(sampled, closed);
  const pipe = buildPipe(frames, p);
  return { p, frames, pipe, seamGap };
}

// 1. 三个样例全部跑验证
for (const preset of PRESETS) {
  const { p, pipe, seamGap } = build(toVectors(preset), preset.closed, { shape: 'square' });
  const results = runValidation({ samplePoints: pipe.frames.points, params: p, pipe, seamGap });
  console.log(`== ${preset.name} (closed=${preset.closed}) V=${pipe.vertexCount} T=${pipe.triangleCount} seamGap=${seamGap.toExponential(2)}`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.name}: expected=${r.expected} measured=${r.measured}`);
}

// 2. 竖直段不应急弯误报
{
  const pts = [new THREE.Vector3(-4,0,0), new THREE.Vector3(-1.5,0,0), new THREE.Vector3(-1.5,3,0), new THREE.Vector3(1,3,1), new THREE.Vector3(3.5,1,1.5)];
  const { p, frames } = build(pts, false);
  const w = analyzePath(frames, p, pts);
  console.log('== 含竖直段警告数:', w.length, w.map(x=>x.kind));
}

// 3. 急弯应报警: 半径很大的管子走小弯
{
  const pts = [new THREE.Vector3(0,0,0), new THREE.Vector3(1,0,0), new THREE.Vector3(1,0.6,0), new THREE.Vector3(2,0.6,0)];
  const { p, frames } = build(pts, false, { radius: 1.5, segments: 128 });
  const w = analyzePath(frames, p, pts);
  console.log('== 急弯警告数(应>0):', w.length, w.filter(x=>x.kind==='curvature').length, 'curvature');
}

// 4. 控制点重合应报过近
{
  const pts = [new THREE.Vector3(0,0,0), new THREE.Vector3(1,0,0), new THREE.Vector3(1,0,0), new THREE.Vector3(2,0,0)];
  const { p, frames } = build(pts, false);
  const w = analyzePath(frames, p, pts);
  console.log('== 重复控制点警告:', w.map(x=>x.kind));
}

// 5. 闭环不同分段数下接缝仍闭合
for (const seg of [16, 33, 100]) {
  const { p, pipe, seamGap } = build(toVectors(PRESETS[2]), true, { segments: seg });
  const results = runValidation({ samplePoints: pipe.frames.points, params: p, pipe, seamGap });
  const seam = results.filter(r => r.name.includes('接缝') || r.name.includes('拓扑'));
  console.log(`== 闭环 segments=${seg}:`, seam.map(r => `${r.pass ? 'PASS' : 'FAIL'}`).join(' '), 'V=' + pipe.vertexCount, 'T=' + pipe.triangleCount);
}
