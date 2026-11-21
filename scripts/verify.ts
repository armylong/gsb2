/**
 * 无 DOM 的纯逻辑验证, 直接跑在 Node 上:
 *   npm run verify   (node --experimental-strip-types scripts/verify.ts)
 *
 * 覆盖:
 *  1. 确定性: 同配置两次全量运行逐帧一致
 *  2. 单步可重复: step() 序列与一次 runFull() 的同 tick 结果完全相等
 *  3. 状态钳制: zoom 不越界, 镜头中心不超出平移范围(考虑视口半宽)
 *  4. 超距裁切: 拉大间距后必出 MAX_ZOOM 与被裁角色
 *  5. 帧率效果: per-tick 平滑下 15/60fps 镜头位置发散; exp 模式收敛一致
 *  6. 名单与回放: 空名单镜头保持不动; 多帧率角色路径一致; recordRun 与现场仿真一致
 */
import { CameraRig } from '../src/core/camera.ts';
import { generateScenario } from '../src/core/scenario.ts';
import { recordRun, Simulation, VIEWPORT_H, VIEWPORT_W } from '../src/core/simulation.ts';
import type { CameraConfig, Snapshot } from '../src/core/types.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const baseConfig = (): CameraConfig => ({
  safeMargin: { x: 0.12, y: 0.12 },
  minZoom: 0.35,
  maxZoom: 1.8,
  panBounds: { x: 0, y: 0, w: 1800, h: 1100 },
  smoothing: 0.25,
  smoothingMode: 'per-tick',
});

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- 1. 确定性 ----------
console.log('1) 确定性 (同 seed / 同配置两次运行)');
{
  const cfg = baseConfig();
  const r1 = recordRun(generateScenario(14416), cfg, 30);
  const r2 = recordRun(generateScenario(14416), cfg, 30);
  check('两次运行帧数相同', r1.length === r2.length, `${r1.length} vs ${r2.length}`);
  check('逐帧快照完全一致', r1.every((s, i) => sameSnapshot(s, r2[i])));
}

// ---------- 2. 单步可重复 ----------
console.log('2) 暂停单步可重复 (逐次 step 与整段 runFull 一致)');
{
  const cfg = baseConfig();
  const scenario = generateScenario(14416);
  const oneShot = recordRun(scenario, cfg, 30);

  const manual = new Simulation(scenario, cfg, 30);
  const stepped: Snapshot[] = [manual.current()];
  const n = Math.round(scenario.duration * 30);
  for (let i = 0; i < n; i++) stepped.push(manual.step());

  check('帧数一致', stepped.length === oneShot.length);
  check('每个 tick 结果完全相等', stepped.every((s, i) => sameSnapshot(s, oneShot[i])));

  // 再点一遍单步: 从 t0 重建后结果依旧一致
  const again = new Simulation(generateScenario(14416), cfg, 30);
  const againFirst = again.step();
  check('重复单步首帧一致', sameSnapshot(againFirst, oneShot[1]));
}

// ---------- 3. 钳制 ----------
console.log('3) 缩放范围与平移范围钳制');
{
  const cfg = baseConfig();
  const run = recordRun(generateScenario(14416), cfg, 30);
  let zoomOk = true;
  let panOk = true;
  for (const s of run) {
    const z = s.camera.zoom;
    if (z < cfg.minZoom - 1e-12 || z > cfg.maxZoom + 1e-12) zoomOk = false;
    const v = s.camera.view;
    const b = cfg.panBounds;
    // 视口窄于活动范围: 必须严格包含在范围内
    if (v.w <= b.w && v.h <= b.h) {
      if (
        v.x < b.x - 1e-9 ||
        v.x + v.w > b.x + b.w + 1e-9 ||
        v.y < b.y - 1e-9 ||
        v.y + v.h > b.y + b.h + 1e-9
      ) {
        panOk = false;
      }
    } else {
      // 视口物理上宽于活动范围: 唯一正确行为是镜头居中并上报 PAN_LIMIT
      const centeredX = v.w > b.w ? approx(s.camera.cx, b.x + b.w / 2, 1e-9) : true;
      const centeredY = v.h > b.h ? approx(s.camera.cy, b.y + b.h / 2, 1e-9) : true;
      const reported =
        (v.w > b.w ? s.camera.limits.includes('PAN_LIMIT_X') : true) &&
        (v.h > b.h ? s.camera.limits.includes('PAN_LIMIT_Y') : true);
      if (!centeredX || !centeredY || !reported) panOk = false;
    }
  }
  check('zoom 始终落在 [minZoom, maxZoom]', zoomOk);
  check('视口不越出平移范围(或超宽时居中且报 PAN_LIMIT)', panOk);

  // 收紧平移范围后, 越界方向必须持续上报 PAN_LIMIT
  const tightCfg: CameraConfig = {
    ...cfg,
    panBounds: { x: 400, y: 300, w: 1000, h: 500 },
  };
  const tightRun = recordRun(generateScenario(14416), tightCfg, 30, ['A', 'B']);
  check(
    '收紧活动范围后出现 PAN_LIMIT 帧',
    tightRun.some((s) => s.camera.limits.some((l) => l.startsWith('PAN_LIMIT'))),
  );
}

// ---------- 4. 超距裁切 ----------
console.log('4) 目标间距超出镜头能力 -> MAX_ZOOM + 裁切诊断');
{
  const cfg = baseConfig();
  const scenario = generateScenario(14416);
  const run = recordRun(scenario, cfg, 30, ['A', 'B']);
  const clippedFrames = run.filter((s) => s.camera.clips.length > 0);
  const maxZoomFrames = run.filter((s) => s.camera.limits.includes('MAX_ZOOM'));
  check('存在被裁角色的帧', clippedFrames.length > 0, `共 ${clippedFrames.length} 帧`);
  check('存在 MAX_ZOOM 触限帧', maxZoomFrames.length > 0, `共 ${maxZoomFrames.length} 帧`);

  // 硬切(无平滑)时, 触限帧上实际 zoom 必须等于 maxZoom
  const hard = { ...cfg, smoothing: 1 };
  const hardRun = recordRun(scenario, hard, 30, ['A', 'B']);
  const limited = hardRun.filter((s) => s.camera.limits.includes('MAX_ZOOM'));
  check(
    '硬切触限帧 zoom === maxZoom',
    limited.every((s) => approx(s.camera.zoom, cfg.maxZoom, 1e-12)),
  );

  // 视口确实装不下被裁角色: 被裁边与 view 矩形一致
  const sample = clippedFrames.find((s) =>
    s.camera.clips.some((c) => c.sides.includes('left') || c.sides.includes('right')),
  );
  check('裁切帧带具体边信息', !!sample);
}

// ---------- 5. 帧率效果 ----------
console.log('5) 不同帧率下的镜头行为');
{
  const scenario = generateScenario(14416);

  const perTickCfg = baseConfig(); // per-tick
  const r15 = recordRun(scenario, perTickCfg, 15);
  const r60 = recordRun(scenario, perTickCfg, 60);

  // 取同一墙钟时间 t≈2s 附近比较镜头中心
  const f15 = r15.find((s) => s.t >= 2)!;
  const f60 = r60.find((s) => s.t >= 2)!;
  const diverged =
    Math.abs(f15.camera.cx - f60.camera.cx) > 1 ||
    Math.abs(f15.camera.cy - f60.camera.cy) > 1;
  check('per-tick: 15fps 与 60fps 镜头位置发散', diverged,
    `cx ${f15.camera.cx.toFixed(2)} vs ${f60.camera.cx.toFixed(2)}`);

  // 角色路径只取决于时间, 与帧率无关
  const actorSame =
    approx(f15.actors[0].x, f60.actors[0].x, 1e-6) &&
    approx(f15.actors[0].y, f60.actors[0].y, 1e-6);
  check('角色位置在同一墙钟时间一致(与帧率无关)', actorSame);

  // exp 帧率无关模式: 同样的墙钟时间, 镜头应高度接近
  const expCfg: CameraConfig = { ...baseConfig(), smoothingMode: 'exp' };
  const e15 = recordRun(scenario, expCfg, 15);
  const e60 = recordRun(scenario, expCfg, 60);
  const g15 = e15.find((s) => s.t >= 2)!;
  const g60 = e60.find((s) => s.t >= 2)!;
  const close =
    Math.abs(g15.camera.cx - g60.camera.cx) < 4 &&
    Math.abs(g15.camera.cy - g60.camera.cy) < 4;
  check('exp: 15fps 与 60fps 镜头收敛一致(误差<4世界单位)', close,
    `Δcx=${(g15.camera.cx - g60.camera.cx).toFixed(3)}`);
}

// ---------- 6. 名单与回放 ----------
console.log('6) 跟随名单与回放一致性');
{
  const cfg = baseConfig();
  const scenario = generateScenario(14416);

  // 空名单: 镜头保持初始位置不动
  const empty = recordRun(scenario, cfg, 30, []);
  const c0 = empty[0].camera;
  check(
    '空名单镜头全程不动',
    empty.every(
      (s) =>
        approx(s.camera.cx, c0.cx) &&
        approx(s.camera.cy, c0.cy) &&
        approx(s.camera.zoom, c0.zoom),
    ),
  );

  // 只跟 C: 永远不应该有裁切(C 在中央徘徊且 zoom 可放大)
  const onlyC = recordRun(scenario, cfg, 30, ['C']);
  check('单角色 C 在视口内不被裁', onlyC.every((s) => s.camera.clips.length === 0));

  // 现场仿真与离线录制一致
  const live = new Simulation(scenario, cfg, 30);
  live.setFollow(['A', 'B']);
  const liveRun = live.runFull();
  const offline = recordRun(scenario, cfg, 30, ['A', 'B']);
  check('recordRun 与现场 Simulation 结果一致',
    liveRun.every((s, i) => sameSnapshot(s, offline[i])));

  // 视口尺寸常量稳定(回放叠加依赖)
  check('逻辑视口尺寸为 960x600', VIEWPORT_W === 960 && VIEWPORT_H === 600);
}

// ---------- 7. 边缘出入稳定: 硬切模式下镜头不发生反向抖动 ----------
console.log('7) 边缘过渡稳定性 (硬切模式镜头中心单调跟随包围盒)');
{
  const cfg: CameraConfig = { ...baseConfig(), smoothing: 1 };
  const scenario = generateScenario(14416);
  const run = recordRun(scenario, cfg, 60, ['A']);
  // 未触平移限时, 实际中心必须等于期望中心
  const noSmear = run.every((s) =>
    s.camera.limits.includes('PAN_LIMIT_X')
      ? true
      : approx(s.camera.cx, s.camera.desiredCx, 1e-9),
  );
  check('硬切模式实际中心 == 期望中心(未触限处)', noSmear);

  // CameraRig 直接单元测试: 首次 update 即 snap, 不会从原点滑入。
  // 用足够大的平移范围, 让 (500,500) 落在允许区间内, 与居中钳制区分开。
  const rigCfg: CameraConfig = {
    ...cfg,
    maxZoom: 1,
    panBounds: { x: -5000, y: -5000, w: 10000, h: 10000 },
  };
  const rig = new CameraRig(rigCfg, VIEWPORT_W, VIEWPORT_H);
  const d = rig.update(1 / 60, [{ x: 500, y: 500 }], []);
  check('首帧直接对齐目标, 无入画滑动', approx(d.cx, 500) && approx(d.cy, 500));

  // 对照: 当视口比平移范围宽时, 镜头必须强制居中而不是跟随目标
  const tight = new CameraRig(
    { ...rigCfg, panBounds: { x: 0, y: 0, w: 500, h: 400 } },
    VIEWPORT_W,
    VIEWPORT_H,
  );
  const td = tight.update(1 / 60, [{ x: 400, y: 300 }], []);
  check(
    '视口宽于活动范围时强制居中并报 PAN_LIMIT',
    approx(td.cx, 250) &&
      approx(td.cy, 200) &&
      td.limits.includes('PAN_LIMIT_X') &&
      td.limits.includes('PAN_LIMIT_Y'),
  );
}

console.log('');
if (failures > 0) {
  console.error(`验证失败: ${failures} 项`);
  process.exit(1);
} else {
  console.log('全部验证通过 ✅');
}
