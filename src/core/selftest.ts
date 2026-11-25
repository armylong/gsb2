/**
 * 自检:
 * 1. 纯几何断言(Node 与浏览器都能跑): 奇偶/方向计数、自交、重叠、同向内孔陷阱、遮罩与关系。
 * 2. 浏览器额外项: 用 canvas 原生 isPointInPath 对一批采样点交叉验证,
 *    确保自研射线判定与浏览器口径一致。
 */
import { fillRuleAt, toPath2D } from './geometry/path';
import type { VectorPath } from './geometry/path';
import { holedSquarePath, overlappingCirclesPath, starPath } from './samples/paths';
import { hitTest } from './hitTest';
import { defaultScene, trapScene } from './scene/scene';
import type { FillRule } from './geometry/path';

export interface SelftestResult {
  ok: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

function check(name: string, actual: unknown, expected: unknown, checks: SelftestResult['checks']): void {
  const passed = actual === expected;
  checks.push({
    name,
    passed,
    detail: `期望 ${String(expected)}, 实际 ${String(actual)}`,
  });
}

export function runGeometrySelftest(): SelftestResult {
  const checks: SelftestResult['checks'] = [];

  // 1. 反向内孔(常规镂空): 两种规则下孔内都是 outside
  const properHole = holedSquarePath(false);
  check('反向内孔·孔内 nonzero', fillRuleAt(properHole, { x: 0, y: 0 }, 'nonzero').verdict, 'outside', checks);
  check('反向内孔·孔内 evenodd', fillRuleAt(properHole, { x: 0, y: 0 }, 'evenodd').verdict, 'outside', checks);
  check('反向内孔·实体区 nonzero', fillRuleAt(properHole, { x: 80, y: 80 }, 'nonzero').verdict, 'inside', checks);

  // 2. 同向内孔(陷阱): nonzero 填平, evenodd 仍镂空
  const trap = holedSquarePath(true);
  check('同向内孔·nonzero 填平陷阱', fillRuleAt(trap, { x: 0, y: 0 }, 'nonzero').verdict, 'inside', checks);
  check('同向内孔·evenodd 仍镂空', fillRuleAt(trap, { x: 0, y: 0 }, 'evenodd').verdict, 'outside', checks);
  check('同向内孔·实体区仍在内', fillRuleAt(trap, { x: 80, y: 80 }, 'nonzero').verdict, 'inside', checks);

  // 3. 自交五角星(pentagram): 中心在 evenodd 下镂空, nonzero 下实心
  const star = starPath(0, 0, 100);
  check('五角星·中心 nonzero', fillRuleAt(star, { x: 0, y: 0 }, 'nonzero').verdict, 'inside', checks);
  check('五角星·中心 evenodd', fillRuleAt(star, { x: 0, y: 0 }, 'evenodd').verdict, 'outside', checks);
  check('五角星·臂内 nonzero', fillRuleAt(star, { x: 0, y: -85 }, 'nonzero').verdict, 'inside', checks);
  check('五角星·臂内 evenodd', fillRuleAt(star, { x: 0, y: -85 }, 'evenodd').verdict, 'inside', checks);
  check('五角星·外部留白', fillRuleAt(star, { x: 200, y: 0 }, 'evenodd').verdict, 'outside', checks);

  // 4. 重叠双圆: 透镜区 nonzero 并集实心, evenodd 镂空
  const overlap = overlappingCirclesPath();
  check('双圆·透镜 nonzero 实心', fillRuleAt(overlap, { x: 0, y: 0 }, 'nonzero').verdict, 'inside', checks);
  check('双圆·透镜 evenodd 镂空', fillRuleAt(overlap, { x: 0, y: 0 }, 'evenodd').verdict, 'outside', checks);
  check('双圆·单圆区在内', fillRuleAt(overlap, { x: -100, y: 0 }, 'evenodd').verdict, 'inside', checks);

  // 5. 边界点判定
  check('落在轮廓边上', fillRuleAt(properHole, { x: -100, y: 0 }, 'nonzero').verdict, 'boundary', checks);

  // 6. 遮罩与关系: 父层孔里 B 放行了也不可见
  const scene = defaultScene();
  const inAOnly = { x: -120, y: -60 }; // A 的方孔内(局部), 根坐标随 A 矩阵
  const hitInHole = hitTest(scene, inAOnly);
  check('父层孔中·A 不放行', hitInHole.masks.A.passes, false, checks);
  check('父层孔中·整体不可见', hitInHole.visible, false, checks);

  // 7. 陷阱场景加载即验证
  const trapSceneModel = trapScene();
  const r = fillRuleAt(trapSceneModel.shapes[0].path, { x: 0, y: 0 }, 'nonzero');
  check('陷阱样例·默认 nonzero 实心', r.verdict, 'inside', checks);

  return { ok: checks.every((c) => c.passed), checks };
}

/** 浏览器专用: 与 canvas 原生 isPointInPath 交叉验证采样网格。 */
export function runCanvasCrossCheck(
  paths: { name: string; path: VectorPath; rule: FillRule }[],
): SelftestResult {
  const checks: SelftestResult['checks'] = [];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, checks: [{ name: 'canvas 上下文', passed: false, detail: '不可用' }] };

  for (const { name, path, rule } of paths) {
    const p2d = toPath2D(path);
    let mismatches = 0;
    let samples = 0;
    for (let x = -240; x <= 240; x += 12) {
      for (let y = -240; y <= 240; y += 12) {
        samples += 1;
        const native = ctx.isPointInPath(p2d, x, y, rule);
        const mine = fillRuleAt(path, { x, y }, rule).verdict !== 'outside';
        if (native !== mine) mismatches += 1;
      }
    }
    check(`交叉验证 ${name} (${samples} 点)`, mismatches, 0, checks);
  }
  return { ok: checks.every((c) => c.passed), checks };
}
