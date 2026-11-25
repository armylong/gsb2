import { runGeometrySelftest } from '../src/core/selftest';
import { circlePath, holedSquarePath, starPath } from '../src/core/samples/paths';
import { fillRuleAt, signedArea, toContours } from '../src/core/geometry/path';
import { apply, invert, multiply, rotation, rotationAround, translation } from '../src/core/geometry/matrix';

let failures = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✖ ${name} ${detail}`);
  }
}

console.log('— 自检套件(与浏览器共用) —');
const result = runGeometrySelftest();
for (const c of result.checks) assert(c.name, c.passed, c.detail);

console.log('— 圆的方向 —');
const cwArea = signedArea(toContours(circlePath(0, 0, 50, true))[0]);
const ccwArea = signedArea(toContours(circlePath(0, 0, 50, false))[0]);
assert('顺时针圆有向面积为正(y 向下)', cwArea > 0, `area=${cwArea}`);
assert('逆时针圆有向面积为负', ccwArea < 0, `area=${ccwArea}`);

console.log('— 矩阵链 —');
const p = { x: 3, y: 4 };
const m = multiply(translation(10, 20), rotation(Math.PI / 2));
const inv = invert(m);
const back = apply(inv, apply(m, p));
assert('矩阵求逆往返', Math.hypot(back.x - p.x, back.y - p.y) < 1e-9, `got=${JSON.stringify(back)}`);

const pivot = { x: 5, y: 5 };
const r = rotationAround(pivot, Math.PI / 2);
assert('绕点旋转保持枢轴不动', Math.hypot(apply(r, pivot).x - pivot.x, apply(r, pivot).y - pivot.y) < 1e-9);

console.log('— 曲线展平精度 —');
const star = starPath(0, 0, 100);
assert('五角星展平为单条闭合轮廓', toContours(star).length === 1);
const holed = holedSquarePath(false);
assert('带孔方块展平为 2 条轮廓', toContours(holed).length === 2);

console.log('— 规则差异一致性 —');
const trap = holedSquarePath(true);
const points = [
  { x: 0, y: 0 },
  { x: 30, y: 30 },
  { x: 80, y: 80 },
  { x: 0, y: 99 },
];
for (const pt of points) {
  const nz = fillRuleAt(trap, pt, 'nonzero').verdict;
  const eo = fillRuleAt(trap, pt, 'evenodd').verdict;
  assert(`点 ${JSON.stringify(pt)} 两规则均可给出判定`, nz !== undefined && eo !== undefined);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
