/**
 * 纯逻辑自检: 不启动浏览器, 直接验证几何与花纹规则。
 * 运行: npm run selfcheck (Node 22+ 原生剥离 TS 类型)
 */
import { TAU, angleInArc, normalizeAngle, samplePolarSegment } from '../src/geometry.ts';
import { PATTERNS } from '../src/patterns.ts';

const DEG = Math.PI / 180;
let failures = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

// 1. 快速拖过零度线: 358° -> 2° 必须走 4° 短弧, 所有子点都贴在盘边 (r=250),
//    不能出现经过盘心 (r 接近 0) 的采样点
{
  const samples = samplePolarSegment(
    { r: 250, theta: 358 * DEG },
    { r: 250, theta: 2 * DEG },
    10,
  );
  check('跨零度采样点数量 > 0', samples.length > 0);
  const allOnRim = samples.every((s) => Math.abs(s.r - 250) < 1e-9);
  check('跨零度所有子点保持在盘边 (不横穿盘心)', allOnRim);
  const angles = [358 * DEG, ...samples.map((s) => s.theta)];
  const gaps = angles.slice(1).map((a, i) => {
    let d = a - angles[i];
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return Math.abs(d) / DEG;
  });
  const maxGap = Math.max(...gaps);
  check('跨零度相邻点角度差远小于 180°', maxGap < 30, `maxGap=${maxGap.toFixed(1)}`);
}

// 2. 反向拖过零度: 2° -> 358° 同样走短弧 (负方向 4°)
{
  const samples = samplePolarSegment(
    { r: 100, theta: 2 * DEG },
    { r: 100, theta: 358 * DEG },
    10,
  );
  const allMidRadius = samples.every((s) => Math.abs(s.r - 100) < 1e-9);
  check('反向跨零度同样不横穿盘心', allMidRadius);
}

// 3. 测试花纹的留白弧从 350° 跨到 10°: 弧内判 true, 弧外判 false
{
  const p = PATTERNS.find((x) => x.id === 'cross-zero-gap');
  check('存在跨零度测试花纹', !!p);
  if (p) {
    const b = p.blanks[0];
    check('355° 在跨零留白弧内', angleInArc(355 * DEG, b.start, b.length));
    check('0° 在跨零留白弧内', angleInArc(0, b.start, b.length));
    check('5° 在跨零留白弧内', angleInArc(5 * DEG, b.start, b.length));
    check('349° 不在留白弧内', !angleInArc(349 * DEG, b.start, b.length));
    check('11° 不在留白弧内', !angleInArc(11 * DEG, b.start, b.length));
    check('180° 不在留白弧内', !angleInArc(180 * DEG, b.start, b.length));
  }
}

// 4. 可完成花纹没有留白, 圆带参数合法
{
  const p = PATTERNS.find((x) => x.id === 'double-ring');
  check('存在可完成花纹', !!p);
  if (p) {
    check('可完成花纹无留白弧', p.blanks.length === 0);
    check('圆带内半径 < 外半径', p.rMin < p.rMax);
  }
}

// 5. 归一化工具边界
{
  check('normalizeAngle(2π) = 0', Math.abs(normalizeAngle(TAU)) < 1e-9);
  check('normalizeAngle(-π/2) 归一到 3π/2', Math.abs(normalizeAngle(-Math.PI / 2) - (3 * Math.PI) / 2) < 1e-9);
}

if (failures > 0) {
  console.error(`\n${failures} 项自检失败`);
  process.exit(1);
}
console.log('\n全部自检通过');
