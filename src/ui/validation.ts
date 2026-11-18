/**
 * 关键验证入口。
 * 全部用例都驱动真实的 Simulation(真实建网格、真实 A*、真实碰撞校验),
 * 不使用预设成功提示; 每一步记录实测状态与数值, 失败时给出实际观测结果。
 *
 * 覆盖:
 *  V1 两条通路切换(布局 A, 关门后必须绕行另一条通道)
 *  V2 角色半径导致窄门失效(布局 B, 中心线能过但大体积过不去)
 *  V3 无路后重新开门 + 门占住角色位置(布局 C / A)
 *  V4 路线沿途碰撞检查(正常路线无违例 + 合成穿障线段必被独立校验拦截)
 */
import { Simulation } from '../core/simulation';
import { LAYOUTS, LayoutDef } from '../core/layouts';
import { checkRouteClearance, segmentClearance } from '../core/collision';
import { Vec2 } from '../core/geometry';

export interface CheckEntry {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ValidationReport {
  id: string;
  title: string;
  checks: CheckEntry[];
  get passed(): boolean;
}

function makeReport(id: string, title: string, checks: CheckEntry[]): ValidationReport {
  return {
    id,
    title,
    checks,
    get passed() {
      return checks.every((c) => c.pass);
    },
  };
}

function freshSim(layoutId: string): Simulation {
  const layout = LAYOUTS.find((l) => l.id === layoutId) as LayoutDef;
  return new Simulation(layout);
}

/** 推进模拟直到到达/停止或超过最长模拟时间 */
function runUntilSettled(sim: Simulation, maxSeconds = 30): { arrived: boolean; seconds: number } {
  const dt = 1 / 60;
  let t = 0;
  sim.play();
  while (t < maxSeconds) {
    sim.step(dt);
    t += dt;
    if (!sim.playing) break;
  }
  return { arrived: sim.status === 'arrived', seconds: t };
}

function routePassesThroughY(sim: Simulation, yMin: number, yMax: number): boolean {
  return sim.route.some((p) => p.y >= yMin && p.y <= yMax);
}

/**
 * 窄墙(实体 x∈[20,22])在网格中体现为两条 slab 边界(x≈19.8 与 22.2),
 * 每条边界在门洞 y 带内各有一个门户, 共 2 个; 大角色时膨胀封死, 为 0。
 */
function countWallCrossingPortals(sim: Simulation): number {
  let count = 0;
  for (const p of sim.navMesh.allPortals()) {
    const atWallBoundary = Math.abs(p.a.x - 19.8) <= 0.05 || Math.abs(p.a.x - 22.2) <= 0.05;
    if (!atWallBoundary) continue;
    // 门户开口与缺口 y 带 [14.5,15.5] 有重叠即属于窄门连接
    if (p.a.y < 15.5 && p.b.y > 14.5) count++;
  }
  return count;
}

/** 折线是否有线段穿过指定的竖直 x 带, 且交点 y 落在 [yMin,yMax] */
function routeCrossesBand(
  route: Vec2[],
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
): boolean {
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    if (hi < xMin || lo > xMax) continue;
    // 求线段在 x=xMin(或带内任一 x)处的 y, 用线性插值
    const denom = b.x - a.x;
    if (Math.abs(denom) < 1e-9) {
      if (a.y >= yMin && a.y <= yMax) return true;
      continue;
    }
    const t = (Math.max(xMin, lo) - a.x) / denom;
    const y = a.y + (b.y - a.y) * t;
    if (y >= yMin && y <= yMax) return true;
  }
  return false;
}

// ---------------- V1: 双通道切换 ----------------

export function validateChannelSwitch(): ValidationReport {
  const checks: CheckEntry[] = [];
  const sim = freshSim('dual-channel');

  // 两扇门都开: 路线应能生成且合法
  const initialOk = sim.status === 'ready' || sim.status === 'moving';
  checks.push({
    name: '两门全开时存在可行路线',
    pass: initialOk,
    detail: `实测状态=${sim.status}, 路线长度=${sim.route.length}, 途经区域=${sim.pathResult?.cellIds.length ?? 0} 个`,
  });

  const usedTopFirst = routePassesThroughY(sim, 6, 10);
  const usedBottomFirst = routePassesThroughY(sim, 20, 24);
  checks.push({
    name: '初始路线确实经过其中一条通道',
    pass: usedTopFirst || usedBottomFirst,
    detail: `经过上通道=${usedTopFirst}, 经过下通道=${usedBottomFirst}`,
  });

  // 沿当前路线先走 1 秒, 再关闭当前使用的通道门
  sim.play();
  sim.step(1);
  const usedTop = routePassesThroughY(sim, 6, 10);
  const doorToClose = usedTop ? 'A-top' : 'A-bottom';
  const otherDoor = usedTop ? 'A-bottom' : 'A-top';
  sim.setDoorOpen(doorToClose, false);

  checks.push({
    name: `关闭${usedTop ? '上' : '下'}门后立即重算且未报不可达`,
    pass: sim.status === 'ready' || sim.status === 'moving',
    detail: `实测状态=${sim.status}; 重新寻路次数=${sim.repathCount}`,
  });

  const nowUsesOther = usedTop
    ? routePassesThroughY(sim, 20, 24)
    : routePassesThroughY(sim, 6, 10);
  checks.push({
    name: '新路线改走另一条通道(绕行而非失败)',
    pass: nowUsesOther,
    detail: `关门后路线经过${usedTop ? '下' : '上'}通道=${nowUsesOther}`,
  });

  const verify = sim.verifyRoute();
  checks.push({
    name: '绕行路线通过独立碰撞校验',
    pass: verify.ok,
    detail: verify.ok
      ? `沿途最小间隙=${verify.clearance.toFixed(3)} (半径=${sim.radius})`
      : `校验失败: ${verify.reason}`,
  });

  // 两扇门全关: 房间被横墙切成两半, 应明确不可达
  sim.setDoorOpen(otherDoor, false);
  checks.push({
    name: '两扇门全关时如实报告不可达',
    pass: sim.status === 'no-path',
    detail: `实测状态=${sim.status}, 详情=${sim.statusDetail}`,
  });

  // 重新打开一扇: 路线必须恢复
  sim.setDoorOpen(otherDoor, true);
  checks.push({
    name: '重开一扇门后路线恢复可达',
    pass: sim.status === 'ready' || sim.status === 'moving',
    detail: `实测状态=${sim.status}, 路线长度=${sim.route.length}`,
  });

  const end = runUntilSettled(sim);
  checks.push({
    name: '沿恢复后的路线实际走到终点',
    pass: end.arrived,
    detail: end.arrived
      ? `用时 ${end.seconds.toFixed(2)} 秒到达, 最终状态=${sim.status}`
      : `未到达, 最终状态=${sim.status}`,
  });

  return makeReport('V1', '两条通路切换', checks);
}

// ---------------- V2: 半径导致窄门失效 ----------------

export function validateNarrowDoor(): ValidationReport {
  const checks: CheckEntry[] = [];

  // 先量化"中心线能过": 直线连接起终点, 测量它到窄门两侧墙的间隙
  const layout = LAYOUTS.find((l) => l.id === 'narrow-door') as LayoutDef;
  const small = freshSim('narrow-door');
  const walls = layout.staticObstacles.filter((_, i) => i <= 1);
  const centerLineGap = segmentClearance(small.start, small.goal, walls, small.width, small.height);
  checks.push({
    name: '角色中心线到窄门墙体仍有间隙(中心线判断会误判可过)',
    pass: centerLineGap > 0,
    detail: `中心线实测最小间隙=${centerLineGap.toFixed(3)} 单位, 窄门净宽=1.0`,
  });

  // 小角色 r=0.2: 应能找到穿过窄门的路线并实际到达
  small.setRadius(0.2);
  const smallReady = small.status === 'ready' || small.status === 'moving';
  // 穿过窄门 = 路线的某条线段与门洞竖带(x∈[19.8,22.2])在缺口 y 带内相交
  const smallCrosses = routeCrossesBand(small.route, 19.8, 22.2, 14.0, 16.0);
  checks.push({
    name: '半径 0.2 时导航网格保留窄门连接',
    pass: smallReady && smallCrosses,
    detail: `状态=${small.status}; 路线穿过窄门区域=${smallCrosses}; 穿墙门户数=${countWallCrossingPortals(small)}`,
  });
  const smallRun = runUntilSettled(small);
  checks.push({
    name: '半径 0.2 的角色实际通过窄门到达终点',
    pass: smallRun.arrived,
    detail: smallRun.arrived
      ? `用时 ${smallRun.seconds.toFixed(2)} 秒, 沿途最小间隙=${small.verifyRoute().clearance.toFixed(3)}`
      : `未到达, 状态=${small.status}`,
  });

  // 大角色 r=0.8: 直径 1.6 > 净宽 1.0, 门户应在网格构建阶段消失
  const big = freshSim('narrow-door');
  big.setRadius(0.8);
  const bigWallPortals = countWallCrossingPortals(big);
  checks.push({
    name: '半径 0.8 时窄门处不存在可通过门户(体积判定, 非中心线)',
    pass: bigWallPortals === 0 && big.status === 'no-path',
    detail: `穿墙门户数=${bigWallPortals}; 状态=${big.status}; 直径=1.6 > 净宽=1.0`,
  });
  checks.push({
    name: '大角色没有产生任何穿门路线',
    pass: big.route.length === 0 && big.status === 'no-path',
    detail: `路线点数=${big.route.length}(无路可走时不生成路线, 角色停在合法位置=(${big.position.x.toFixed(2)}, ${big.position.y.toFixed(2)}))`,
  });

  // 半径滑回 0.2: 连接应恢复
  big.setRadius(0.2);
  checks.push({
    name: '半径调回 0.2 后窄门重新可通行',
    pass: big.status === 'ready' || big.status === 'moving',
    detail: `实测状态=${big.status}, 重新寻路次数=${big.repathCount}`,
  });

  return makeReport('V2', '角色半径导致窄门失效', checks);
}

// ---------------- V3: 无路后重新开门 + 门占住角色 ----------------

export function validateDoorRecoveryAndTrapped(): ValidationReport {
  const checks: CheckEntry[] = [];

  // 3a 布局 C: 围住的终点, 双门关闭 -> 不可达 -> 重开 -> 到达
  const sim = freshSim('enclosed-goal');
  sim.setDoorOpen('C-north', false);
  sim.setDoorOpen('C-south', false);
  checks.push({
    name: '南北门同时关闭时终点不可达',
    pass: sim.status === 'no-path',
    detail: `实测状态=${sim.status}; 当前有效路线点数=${sim.route.length}(旧结果已丢弃)`,
  });

  sim.setDoorOpen('C-north', true);
  const reopenedOk = sim.status === 'ready' || sim.status === 'moving';
  checks.push({
    name: '重开北门后重新出现可行路线',
    pass: reopenedOk,
    detail: `状态=${sim.status}; 路线进入围墙=${sim.route.some((p) => p.x > 24 && p.x < 36 && p.y > 8 && p.y < 22)}`,
  });
  const run = runUntilSettled(sim);
  checks.push({
    name: '开门后角色实际走进围墙到达终点',
    pass: run.arrived,
    detail: run.arrived ? `用时 ${run.seconds.toFixed(2)} 秒到达` : `未到达, 状态=${sim.status}`,
  });

  // 3b 门在角色脸上关闭: 角色被困, 暂停, 不传送; 移开门后恢复
  const sim2 = freshSim('dual-channel');
  // 让角色沿上门走入门洞后再关门
  sim2.setStart({ x: 4, y: 8 });
  sim2.play();
  for (let i = 0; i < 60 * 5; i++) {
    sim2.step(1 / 60);
    if (sim2.position.x >= 18.2 && sim2.position.x <= 19.8) break;
    if (sim2.status !== 'moving') break;
  }
  sim2.pause();
  const beforeTrap = { ...sim2.position };
  const reachedDoorway = beforeTrap.x > 18 && beforeTrap.x < 20;
  sim2.setDoorOpen('A-top', false);
  checks.push({
    name: '门把角色所在位置占住时进入 trapped 状态并暂停',
    pass: reachedDoorway && sim2.status === 'trapped' && !sim2.playing,
    detail: `角色进门洞=${reachedDoorway}(x=${beforeTrap.x.toFixed(2)}); 实测状态=${sim2.status}, playing=${sim2.playing}, 详情=${sim2.statusDetail}`,
  });
  checks.push({
    name: '被困时角色坐标原样保留(无传送)',
    pass: sim2.position.x === beforeTrap.x && sim2.position.y === beforeTrap.y && sim2.route.length === 0,
    detail: `被困位置=(${sim2.position.x.toFixed(2)}, ${sim2.position.y.toFixed(2)}), 路线点数=${sim2.route.length}`,
  });
  // 尝试推进时间, 角色必须纹丝不动
  sim2.play();
  sim2.step(0.5);
  const stayed = sim2.position.x === beforeTrap.x && sim2.position.y === beforeTrap.y;
  checks.push({
    name: '被困状态下即使播放也不移动',
    pass: stayed && sim2.status === 'trapped',
    detail: `推进 0.5 秒后位置=(${sim2.position.x.toFixed(2)}, ${sim2.position.y.toFixed(2)}), 状态=${sim2.status}`,
  });
  sim2.setDoorOpen('A-top', true);
  checks.push({
    name: '重新开门后障碍解除, 恢复寻路能力',
    pass: sim2.status === 'ready' || sim2.status === 'moving' || sim2.status === 'arrived',
    detail: `实测状态=${sim2.status}, 角色仍在原位置=(${sim2.position.x.toFixed(2)}, ${sim2.position.y.toFixed(2)})`,
  });

  return makeReport('V3', '无路后重新开门 / 门占住角色', checks);
}

// ---------------- V4: 路线沿途碰撞检查 ----------------

export function validateRouteCollision(): ValidationReport {
  const checks: CheckEntry[] = [];

  // 4a 三个布局各自生成的真实路线, 独立碰撞校验必须全部通过, 且间隙 >= 半径
  for (const layout of LAYOUTS) {
    const sim = new Simulation(layout);
    const verify = sim.verifyRoute();
    const legal =
      (sim.status === 'ready' || sim.status === 'moving') &&
      verify.ok &&
      verify.clearance + 1e-6 >= sim.radius;
    checks.push({
      name: `布局 ${layout.name}: 初始路线沿途无碰撞`,
      pass: legal,
      detail:
        `状态=${sim.status}; 路线点数=${sim.route.length}; ` +
        (verify.ok
          ? `实测最小间隙=${verify.clearance.toFixed(3)} >= 半径=${sim.radius}`
          : `违例: ${verify.reason}`),
    });
  }

  // 4b 合成一条直接穿过障碍的折线, 独立校验必须拦截(证明校验不是橡皮图章)
  const sim = freshSim('dual-channel');
  const obstacle = sim.obstacleList[1]; // 中间横墙
  const inside: Vec2 = { x: obstacle.x + obstacle.w / 2, y: obstacle.y + obstacle.h / 2 };
  const badRoute: Vec2[] = [
    { x: 4, y: 15 },
    inside,
    { x: 36, y: 15 },
  ];
  const bad = checkRouteClearance(badRoute, sim.radius, sim.activeObstacles(), sim.width, sim.height);
  checks.push({
    name: '独立校验能拦截人工构造的穿障路线',
    pass: !bad.ok && bad.violationAt !== undefined,
    detail: bad.ok
      ? '意外放行穿障路线(校验失效!)'
      : `按预期拦截: ${bad.reason}, 违例点=(${bad.violationAt!.x.toFixed(2)}, ${bad.violationAt!.y.toFixed(2)})`,
  });

  // 4c 行进中把障碍拖到路线上: 模拟层必须停下并重新寻路, 不会沿旧线穿障
  const sim2 = freshSim('dual-channel');
  sim2.play();
  sim2.step(0.8);
  const posBefore = { ...sim2.position };
  // 找角色前方最近的路线拐点, 把一块障碍移到该线段上
  const wp = sim2.route[Math.min(sim2.waypointIndex, sim2.route.length - 1)];
  const blockerIndex = sim2.obstacleList.findIndex((o) => o.movable);
  const blockW = 3;
  const blockH = 3;
  sim2.pause(); // 拖动只允许在暂停时进行
  sim2.moveObstacle(blockerIndex, {
    x: Math.max(0, Math.min(sim2.width - blockW, (posBefore.x + wp.x) / 2 - blockW / 2)),
    y: Math.max(0, Math.min(sim2.height - blockH, (posBefore.y + wp.y) / 2 - blockH / 2)),
    w: blockW,
    h: blockH,
  });
  const afterMove = sim2.verifyRoute();
  checks.push({
    name: '拖动障碍封堵前路后旧路线立即失效并重算',
    pass: sim2.route.length === 0 || afterMove.ok,
    detail: `重算后状态=${sim2.status}; 重算次数=${sim2.repathCount}; 角色停在=(${posBefore.x.toFixed(2)}, ${posBefore.y.toFixed(2)}) 未被拖动`,
  });
  const run = runUntilSettled(sim2);
  checks.push({
    name: '重算后的新路线再次通过碰撞校验并到达/或如实报无路',
    pass: (run.arrived && sim2.verifyRoute().ok) || sim2.status === 'no-path' || sim2.status === 'trapped',
    detail: `最终状态=${sim2.status}; 路线最小间隙=${sim2.verifyRoute().clearance?.toFixed(3) ?? 'N/A'}`,
  });

  return makeReport('V4', '路线沿途碰撞检查', checks);
}

export const VALIDATORS: { id: string; title: string; run: () => ValidationReport }[] = [
  { id: 'V1', title: '两条通路切换', run: validateChannelSwitch },
  { id: 'V2', title: '半径导致窄门失效', run: validateNarrowDoor },
  { id: 'V3', title: '无路重开 / 门占住角色', run: validateDoorRecoveryAndTrapped },
  { id: 'V4', title: '路线沿途碰撞检查', run: validateRouteCollision },
];
