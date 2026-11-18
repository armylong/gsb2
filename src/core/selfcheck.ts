import type { Block, Camera, Scene } from './types';
import { blockAABB, characterAABB, project } from './geometry';
import { computeOrder, type OrderEntity, topoSort, type Graph, findCycleEntities } from './ordering';
import { checkBlockPlacement, createDefaultScene, groundHeightAt, canCharacterMoveTo } from './scene';
import { pickEntity, pickGroundCell } from './picking';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const baseCamera: Camera = { originX: 400, originY: 300, k: 32 };

function entitiesOf(scene: Scene): OrderEntity[] {
  return [
    ...scene.blocks.map((b) => ({ id: b.id, box: blockAABB(b) })),
    { id: 'character', box: characterAABB(scene.character) },
  ];
}

/** 断言 drawOrder 中 before 必须先于 after。 */
function expectBefore(order: string[], before: string, after: string): boolean {
  return order.indexOf(before) !== -1 && order.indexOf(after) !== -1 && order.indexOf(before) < order.indexOf(after);
}

/** 用例 1：长条物两端遮挡 —— 平台两端上方的箱子都必须画在平台之后。 */
function checkLongPlatform(): CheckResult {
  const scene = createDefaultScene();
  const result = computeOrder(entitiesOf(scene), baseCamera, 'correct');
  const platform = scene.blocks.find((b) => b.label === '长条平台')!;
  const east = scene.blocks.find((b) => b.label === '平台东端箱子')!;
  const west = scene.blocks.find((b) => b.label === '平台西端箱子')!;
  const front = scene.blocks.find((b) => b.label === '平台前矮箱')!;
  const ok =
    expectBefore(result.order, platform.id, east.id) &&
    expectBefore(result.order, platform.id, west.id) &&
    // 前矮箱在平台靠近相机一侧，正确关系是它先于平台绘制
    expectBefore(result.order, front.id, platform.id);
  const naive = computeOrder(entitiesOf(scene), baseCamera, 'naive');
  const naiveWrong =
    !expectBefore(naive.order, platform.id, east.id) ||
    !expectBefore(naive.order, platform.id, west.id);
  return {
    name: '长条物两端遮挡（正确 vs 纵坐标对照）',
    pass: ok && naiveWrong,
    detail: ok
      ? `正确模式：平台→东箱/西箱、前矮箱→平台 关系成立；对照模式确实出错（${naive.naiveViolations.length} 条违例）`
      : '正确模式未能保证两端箱子都画在平台之后',
  };
}

/** 用例 2：角色绕高柱 —— 柱南（近相机）角色在前，柱北（远相机）角色在后。 */
function checkCharacterPillar(): CheckResult {
  const scene = createDefaultScene();
  const pillar = scene.blocks.find((b) => b.label === '高柱')!;
  const south: Scene = {
    ...scene,
    character: { x: pillar.x + 0.5, y: pillar.y + 1.5, z: 0 },
  };
  const north: Scene = {
    ...scene,
    character: { x: pillar.x + 0.5, y: pillar.y - 1.0, z: 0 },
  };
  const rSouth = computeOrder(entitiesOf(south), baseCamera, 'correct');
  const rNorth = computeOrder(entitiesOf(north), baseCamera, 'correct');
  // 角色在柱南侧（更靠近相机）：柱先画、角色后画
  const okSouth = expectBefore(rSouth.order, pillar.id, 'character');
  // 角色在柱北侧（远离相机）：角色先画、柱后画
  const okNorth = expectBefore(rNorth.order, 'character', pillar.id);
  return {
    name: '角色绕高柱前后翻转',
    pass: okSouth && okNorth,
    detail: `柱南：${okSouth ? '柱→角色 ✓' : '✗'}；柱北：${okNorth ? '角色→柱 ✓' : '✗'}`,
  };
}

/** 用例 3：台阶高度 —— 每级台阶与顶部平台的 z 叠放顺序。 */
function checkStairs(): CheckResult {
  const scene = createDefaultScene();
  const s1 = scene.blocks.find((b) => b.label === '台阶一(0.5)')!;
  const s2 = scene.blocks.find((b) => b.label === '台阶二(1.0)')!;
  const top = scene.blocks.find((b) => b.label === '顶部平台')!;
  const ground = groundHeightAt(scene, s1.x + 0.5, s1.y + 0.5);
  const topGround = groundHeightAt(scene, top.x + 0.5, top.y + 0.5);
  // 角色逐级上台阶：一级可走、两级连走可到顶、从地面一步跨上顶部平台（抬升 1.0）被拒
  const step1 = canCharacterMoveTo({ ...scene, character: { x: 9.5, y: 1.0, z: 0 } }, 9.5, 2.5, 0);
  const sceneOn1 = { ...scene, character: { x: 9.5, y: 2.5, z: 0.5 } };
  const step2 = canCharacterMoveTo(sceneOn1, 10.5, 2.5, 0.5);
  const jump = canCharacterMoveTo({ ...scene, character: { x: 9.5, y: 1.0, z: 0 } }, 11.0, 4.0, 0);
  const r = computeOrder(entitiesOf(scene), baseCamera, 'correct');
  const orderOk = !r.hasConflict;
  const ok =
    Math.abs(ground - 0.5) < 1e-9 && Math.abs(topGround - 1) < 1e-9 &&
    step1.ok && step2.ok && !jump.ok && orderOk;
  return {
    name: '台阶高度与逐级移动',
    pass: ok,
    detail: `一级顶面=${ground}、顶部平台=${topGround}；逐级移动 ${step1.ok && step2.ok ? '✓' : '✗'}，从地面一步跨上顶部平台被拒 ${!jump.ok ? '✓' : '✗'}（${jump.reason ?? ''}）`,
  };
}

/** 用例 4：排序冲突 —— 构造互相穿入的三个实体，必须标出相关对象且无无限排序。 */
function checkConflict(): CheckResult {
  const blocks: Block[] = [
    { id: 'x1', label: '穿入甲', x: 1, y: 1, z: 0, sx: 2, sy: 2, h: 1, color: '#f00' },
    { id: 'x2', label: '穿入乙', x: 2, y: 2, z: 0.5, sx: 2, sy: 2, h: 1, color: '#0f0' },
    { id: 'x3', label: '穿入丙', x: 3, y: 3, z: 1.0, sx: 2, sy: 2, h: 1, color: '#00f' },
  ];
  const scene: Scene = { blocks, character: { x: 8, y: 8, z: 0 } };
  const result = computeOrder(entitiesOf(scene), baseCamera, 'correct');
  const flagged = new Set([
    ...result.interpenetrations.flatMap((p) => [p.a, p.b]),
    ...result.cycleEntities,
  ]);
  const allFlagged = blocks.every((b) => flagged.has(b.id));
  // 排序必须终止且给出有限顺序
  const terminates = result.order.length === entitiesOf(scene).length;
  return {
    name: '排序冲突标记与有限终止',
    pass: result.hasConflict && allFlagged && terminates,
    detail: `穿入对=${result.interpenetrations.length}，被标记对象=[${[...flagged].join(', ')}]，顺序长度=${result.order.length}（有限）`,
  };
}

/** 用例 5：穿入摆放被拒绝且场景保持原状态。 */
function checkPlacementReject(): CheckResult {
  const scene = createDefaultScene();
  const wall = scene.blocks.find((b) => b.label === '矮墙·横段')!;
  const before = scene.blocks.length;
  const candidate: Block = { ...wall, id: 'tmp', label: '试探块', x: wall.x + 1, y: wall.y };
  const check = checkBlockPlacement(scene, candidate);
  const unchanged = scene.blocks.length === before;
  // 合法贴放（横段南侧共面，取短块避开竖段与长条矮台）应通过
  const beside: Block = { ...wall, id: 'tmp2', label: '贴放块', x: wall.x, y: wall.y + wall.sy, sx: 1, sy: 1 };
  const okBeside = checkBlockPlacement(scene, beside).ok;
  // 越界拒绝
  const outside: Block = { ...wall, id: 'tmp3', label: '越界块', x: 11, y: 11 };
  const okOutside = !checkBlockPlacement(scene, outside).ok;
  return {
    name: '穿入/越界摆放拒绝',
    pass: !check.ok && unchanged && okBeside && okOutside,
    detail: `穿入拒绝=${!check.ok}（${check.reason ?? ''}），共面贴放通过=${okBeside}，越界拒绝=${okOutside}，场景未变=${unchanged}`,
  };
}

/** 用例 6：拾取 —— 前面的实体挡住后面的实体；平移缩放后格子反投影仍对应。 */
function checkPicking(): CheckResult {
  const scene = createDefaultScene();
  const platform = scene.blocks.find((b) => b.label === '长条平台')!;
  const east = scene.blocks.find((b) => b.label === '平台东端箱子')!;
  const result = computeOrder(entitiesOf(scene), baseCamera, 'correct');
  // 东端箱子顶面中心的屏幕位置
  const topCenter = {
    x: east.x + east.sx / 2,
    y: east.y + east.sy / 2,
    z: east.z + east.h + 0.01,
  };
  const sp = project(topCenter, baseCamera);
  const hit = pickEntity(sp.sx, sp.sy, entitiesOf(scene), result.order, baseCamera);
  const frontBlocks = hit?.id === east.id;
  // 平台顶面（未被箱子覆盖处）应直接命中平台
  const pTop = project({ x: 4.5, y: 7.5, z: 1.01 }, baseCamera);
  const hit2 = pickEntity(pTop.sx, pTop.sy, entitiesOf(scene), result.order, baseCamera);
  const platformHit = hit2?.id === platform.id;
  // 平移 + 缩放后反投影
  const cam2: Camera = { originX: 123, originY: 456, k: 47 };
  const world = { x: 7.3, y: 4.8 };
  const sp2 = project({ ...world, z: 0 }, cam2);
  const back = pickGroundCell(sp2.sx, sp2.sy, cam2);
  const inverseOk = back.gx === Math.floor(world.x) && back.gy === Math.floor(world.y);
  return {
    name: '可见表面拾取与缩放平移对应',
    pass: frontBlocks && platformHit && inverseOk,
    detail: `前方箱子挡住平台=${frontBlocks}，裸露平台面命中平台=${platformHit}，平移缩放后格子反投影=${inverseOk}`,
  };
}

// 避免循环导入风格问题，直接复用 geometry 的 project

/** 用例 7：环检测算法本身 —— 手工构造有环图，Tarjan 必须找出且拓扑排序不卡死。 */
function checkCycleAlgorithm(): CheckResult {
  const ids = ['a', 'b', 'c'];
  const graph: Graph = {
    edges: new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set()],
    ]),
    indegree: new Map([['a', 1], ['b', 1], ['c', 1], ['d', 0]]),
    reasons: new Map(),
  };
  const cycle = findCycleEntities(graph).sort();
  const { order, remaining } = topoSort(graph);
  const ok = cycle.join() === 'a,b,c' && order.length === 1 && order[0] === 'd' && remaining.length === 3;
  return {
    name: '环检测（Tarjan）与拓扑终止性',
    pass: ok,
    detail: `环节点=[${cycle.join(', ')}]，无环节点 d 正常输出，环上节点保留=${remaining.length} 个，不无限循环`,
  };
}

export function runAllChecks(): CheckResult[] {
  return [
    checkLongPlatform(),
    checkCharacterPillar(),
    checkStairs(),
    checkConflict(),
    checkPlacementReject(),
    checkPicking(),
    checkCycleAlgorithm(),
  ];
}
