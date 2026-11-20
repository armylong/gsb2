/**
 * 命令行验证：与页面共用 src/core/* 的同一套数学。
 * 运行：npm run verify
 *
 * 验证内容：
 *  1. 镜像 UV 区域手性为 -1，正常区域为 +1
 *  2. 正确处理下，±X/±Y/±Z 轴向光左右区域漫反射一致
 *  3. 错误处理（强制 w=1）下，同一位置修改前后采样值不同 —— 复现亮暗翻转
 *  4. DirectX/OpenGL 纵向约定采样结果互为绿通道翻转
 *  5. UV 旋转数学正确
 *  6. 退化 UV 条带被正确标出
 */
import { buildMirroredPlane, frameAtPoint } from '../src/core/geometry';
import { mirrorX, rotateUV, runAxisValidation, v3 } from '../src/core/tangentSpace';
import { sampleTSNormal } from '../src/core/heightfield';
import { sampleDiffuse, samplePipeline, type SampleOptions } from '../src/core/sampler';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}

const BASE: SampleOptions = { rotationDeg: 0, convention: 'opengl', fixMode: 'correct' };
const geo = buildMirroredPlane();
const geoBand = buildMirroredPlane({ degenerateBand: true });

const left = frameAtPoint(geo, -1, 0);
const right = frameAtPoint(geo, 1, 0);

// 1. 手性
check('左区(正常UV)手性 = +1', left.frame.w === 1, `w=${left.frame.w}`);
check('右区(镜像UV)手性 = -1', right.frame.w === -1, `w=${right.frame.w}`);

// 2. 轴向灯光验证（正确处理 → 左区(L) 与 右区(镜像L) 一致）
const rowsCorrect = runAxisValidation((region, dir) => {
  const p = region === 'left' ? left : right;
  return sampleDiffuse(p.frame, p.uv, p.region, { ...BASE, fixMode: 'correct' }, dir);
});
const maxCorrect = Math.max(...rowsCorrect.map((r) => Math.abs(r.delta)));
for (const r of rowsCorrect) {
  console.log(`     光 ${r.axis}: 左=${r.left.toFixed(6)} 右(镜像光)=${r.right.toFixed(6)} Δ=${r.delta.toExponential(2)}`);
}
check('正确处理：轴向光下左右互为镜像一致', maxCorrect < 1e-6, `max|Δ|=${maxCorrect.toExponential(2)}`);

// 3. 错误处理：同一位置修改前后采样值对比（复现亮暗翻转）
const before = sampleDiffuse(right.frame, right.uv, right.region, { ...BASE, fixMode: 'correct' }, [0, 1, 0.4]);
const after = sampleDiffuse(right.frame, right.uv, right.region, { ...BASE, fixMode: 'wrong' }, [0, 1, 0.4]);
console.log(`     右区同一点 修改前(正确) N·L=${before.toFixed(4)} → 修改后(错误) N·L=${after.toFixed(4)}`);
check('错误处理：同一点采样值发生翻转（bug 复现）', Math.abs(after - before) > 0.01, `Δ=${(after - before).toFixed(4)}`);

const rowsWrong = runAxisValidation((region, dir) => {
  const p = region === 'left' ? left : right;
  return sampleDiffuse(p.frame, p.uv, p.region, { ...BASE, fixMode: 'wrong' }, dir);
});
const maxWrong = Math.max(...rowsWrong.map((r) => Math.abs(r.delta)));
check('错误处理：轴向光下左右不一致', maxWrong > 0.01, `max|Δ|=${maxWrong.toFixed(4)}`);

// 3b. 修正后左右世界法线应互为镜像（同一纹理点、镜像框架互相补偿）
const sL = samplePipeline(left.frame, left.uv, left.region, BASE);
const sR = samplePipeline(right.frame, right.uv, right.region, BASE);
const nDiff = v3.len(v3.sub(mirrorX(sL.worldNormal), sR.worldNormal));
check('修正后左右对称点世界法线互为镜像', nDiff < 1e-6, `|ΔN|=${nDiff.toExponential(2)}`);

// 4. 纵向编码约定
const gl = sampleTSNormal(0.3, 0.7, 'opengl');
const dx = sampleTSNormal(0.3, 0.7, 'directx');
check(
  'DirectX 约定 = OpenGL 绿通道翻转',
  Math.abs(gl[0] - dx[0]) < 1e-12 && Math.abs(gl[1] + dx[1]) < 1e-12 && Math.abs(gl[2] - dx[2]) < 1e-12,
  `gl=${gl.map((x) => x.toFixed(3))} dx=${dx.map((x) => x.toFixed(3))}`,
);

// 5. UV 旋转：90° 时 (u,v) → (1-v, u)
const r = rotateUV([0.2, 0.9], 90);
check('rotateUV 90° 正确', Math.abs(r[0] - 0.1) < 1e-12 && Math.abs(r[1] - 0.2) < 1e-12, `(${r[0]}, ${r[1]})`);

// 6. 退化坐标标记
const degCount = geoBand.degenerate.reduce((a, b) => a + b, 0);
const degNone = geo.degenerate.reduce((a, b) => a + b, 0);
check('插入条带后存在退化坐标顶点', degCount > 0, `${degCount} 个`);
check('无条带时无退化顶点', degNone === 0, `${degNone} 个`);
const seamHit = frameAtPoint(geoBand, 0, 0);
check('接缝中心被标为退化', seamHit.degenerate === true);

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
