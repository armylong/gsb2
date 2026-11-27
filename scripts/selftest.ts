/**
 * 无浏览器自检:用"台阶遮挡示例"的观察点跑一遍完整流程 —
 * 投影 → 分面导出 SVG → 只解析 SVG 文本折回三维再投影,核对对位误差。
 * 运行: npm run selftest
 */
import { buildPaintMeshes, DEFAULT_SPEC, FACE_LABEL, FACE_ORDER, OCCLUDED_EYE } from '../src/geom';
import { computeProjection, Sampler } from '../src/project';
import { exportFaceSVG } from '../src/svg';
import { verifySVG } from '../src/verify';

const spec = structuredClone(DEFAULT_SPEC);
const eye = OCCLUDED_EYE.clone();

// 程序化取色(代替浏览器画布),几何核对与颜色无关
const sampler: Sampler = (u, v) => {
  const r = Math.floor(((u + 2) / 4) * 200) % 256;
  const g = Math.floor(((v + 2) / 4) * 200) % 256;
  return `rgb(${r},${g},120)`;
};

const { ground, step } = buildPaintMeshes(spec);
const result = computeProjection(eye, spec.image, [ground, step], 120, 150, sampler);

console.log(`网格 120×150,有效格 ${result.cells.length},问题格 ${result.marks.length}`);
const byFace = new Map<string, number>();
for (const c of result.cells) byFace.set(c.face, (byFace.get(c.face) ?? 0) + 1);
for (const f of FACE_ORDER) console.log(`  ${FACE_LABEL[f]}: ${byFace.get(f) ?? 0} 格`);

// 遮挡是否生效:图像下部应有一部分落到台阶正面,而不是被挡住的地面
const frontCells = result.cells.filter((c) => c.face === 'stepFront');
if (frontCells.length === 0) {
  console.error('失败:没有任何格子落到台阶正面,遮挡示例不成立');
  process.exit(1);
}
// 被挡的地面不能算可见:台阶正后方(z < 台阶前沿)且被台阶遮住的区域不应有地面格
const frontZ = spec.step.cz + spec.step.d / 2;
const stepX0 = spec.step.cx - spec.step.w / 2;
const stepX1 = spec.step.cx + spec.step.w / 2;
const suspect = result.cells.filter(
  (c) =>
    c.face === 'ground' &&
    c.corners3.every((p) => p.z < frontZ && p.z > spec.step.cz - spec.step.d / 2 && p.x > stepX0 && p.x < stepX1 && p.y < spec.step.h + 1e-6),
);
if (suspect.length > 0) {
  console.error(`失败:发现 ${suspect.length} 个地面格位于台阶体内部(被遮挡区域被误算成可见)`);
  process.exit(1);
}
console.log('遮挡检查通过:台阶体内部没有被误算的地面格');

// 导出问题格统计
const kinds = { miss: 0, edge: 0, blocked: 0 };
for (const m of result.marks) kinds[m.kind]++;
console.log(`问题格: 射出场景 ${kinds.miss}, 跨面边缘 ${kinds.edge}, 不可画面 ${kinds.blocked}`);

// 导出 + 核对
let worst = 0;
let total = 0;
for (const face of FACE_ORDER) {
  const svg = exportFaceSVG(face, result.cells);
  if (!svg) {
    console.log(`  ${FACE_LABEL[face]}: 无绘制区域,不导出`);
    continue;
  }
  const report = verifySVG(svg, spec, eye, spec.image);
  worst = Math.max(worst, report.maxErr);
  total += report.vertexCount;
  console.log(
    `  ${FACE_LABEL[face]}: SVG ${(svg.length / 1024).toFixed(1)} KB, ${report.vertexCount} 顶点, ` +
      `最大误差 ${(report.maxErr * 1000).toFixed(4)} mm, 平均 ${(report.meanErr * 1000).toFixed(4)} mm`,
  );
}
if (total === 0) {
  console.error('失败:没有导出任何面');
  process.exit(1);
}
if (worst > 0.001) {
  console.error(`失败:最大对位误差 ${(worst * 1000).toFixed(4)} mm 超过 1 mm`);
  process.exit(1);
}
console.log(`自检通过:共 ${total} 个导出顶点,折回三维再投影的最大误差 ${(worst * 1000).toFixed(4)} mm`);
