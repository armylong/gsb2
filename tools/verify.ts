/**
 * 命令行验证：对三组内置预设构建网格并运行全部核验，
 * 另附两个应被拒绝的非法参数用例。运行：npm run verify
 */
import { buildIntersection } from '../src/geometry/mesh';
import { PRESETS } from '../src/geometry/presets';
import { verifyBuild, CheckResult } from '../src/geometry/verify';
import { serializeExport, verifyExportText } from '../src/geometry/export';
import { IntersectionParams } from '../src/geometry/types';

let failures = 0;

function printChecks(checks: CheckResult[], indent = '  ') {
  for (const c of checks) {
    console.log(`${indent}${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    if (!c.ok) failures++;
  }
}

console.log('=== 预设路口构建与核验 ===\n');
for (const key of Object.keys(PRESETS)) {
  const preset = PRESETS[key];
  const params = structuredClone(preset.params);
  const res = buildIntersection(params);
  console.log(`【${preset.name}】${preset.description}`);
  if (!res.ok) {
    console.log('  ✗ 构建失败：');
    res.errors.forEach((e) => console.log(`    - ${e}`));
    failures++;
    continue;
  }
  const s = res.stats;
  console.log(
    `  顶点 ${s.vertexCount}，三角形 ${s.triangleCount}，` +
      `范围 X [${s.bboxMin[0].toFixed(2)}, ${s.bboxMax[0].toFixed(2)}]，Z [${s.bboxMin[2].toFixed(2)}, ${s.bboxMax[2].toFixed(2)}]`
  );
  for (const br of res.branches) {
    console.log(
      `  分支${br.label}：角度 ${br.angleDeg}°，宽 ${br.width}，长 ${br.length}，` +
        `路口边界 ${br.tClear.toFixed(2)}，停止线 ${br.stopT.toFixed(2)}，虚线 ${br.dashCount} 段`
    );
  }
  if (res.warnings.length) res.warnings.forEach((w) => console.log(`  ! ${w}`));
  printChecks(verifyBuild(res));
  // 导出并重新读取核对
  const text = serializeExport(params, res);
  printChecks(verifyExportText(text));
  console.log('');
}

console.log('=== 非法参数用例（应被拒绝并指明分支） ===\n');

const badAngle: IntersectionParams = {
  cornerRadius: 1,
  branches: [
    { id: 'A', angleDeg: 0, width: 4, length: 20 },
    { id: 'B', angleDeg: 20, width: 4, length: 20 },
    { id: 'C', angleDeg: 180, width: 4, length: 20 },
  ],
};
const r1 = buildIntersection(badAngle);
console.log('【夹角过小】分支A与分支B夹角 20°：');
if (!r1.ok && r1.errors.some((e) => e.includes('夹角'))) {
  r1.errors.forEach((e) => console.log(`  ✓ 已拒绝：${e}`));
} else {
  console.log('  ✗ 未被正确拒绝');
  failures++;
}

const badLength: IntersectionParams = {
  cornerRadius: 1,
  branches: [
    { id: 'A', angleDeg: 0, width: 8, length: 10 },
    { id: 'B', angleDeg: 35, width: 4.4, length: 40 },
    { id: 'C', angleDeg: 180, width: 8, length: 10 },
    { id: 'D', angleDeg: 215, width: 4.4, length: 40 },
  ],
};
const r2 = buildIntersection(badLength);
console.log('【长度不足】35° 斜交长支路使路口核心区延伸至 ~9.4，分支A/C 长仅 10：');
if (!r2.ok && r2.errors.some((e) => e.includes('长度不足'))) {
  r2.errors.forEach((e) => console.log(`  ✓ 已拒绝：${e}`));
} else {
  console.log('  ✗ 未被正确拒绝');
  if (!r2.ok) r2.errors.forEach((e) => console.log(`    实际错误：${e}`));
  failures++;
}

const badCover: IntersectionParams = {
  cornerRadius: 1,
  branches: [
    { id: 'A', angleDeg: 0, width: 8, length: 10 },
    { id: 'B', angleDeg: 35, width: 8, length: 40 },
    { id: 'C', angleDeg: 180, width: 8, length: 10 },
    { id: 'D', angleDeg: 215, width: 8, length: 40 },
  ],
};
const r3 = buildIntersection(badCover);
console.log('【边界无法连接】35° 斜交、宽 8 长支路吞没短路末端：');
if (!r3.ok && r3.errors.length > 0) {
  r3.errors.forEach((e) => console.log(`  ✓ 已拒绝：${e}`));
} else {
  console.log('  ✗ 未被正确拒绝');
  failures++;
}

console.log('');
if (failures > 0) {
  console.log(`验证未通过：${failures} 项失败`);
  process.exit(1);
} else {
  console.log('全部验证通过。');
}
