// 引擎单元测试（node:test，无需浏览器）。
// 覆盖：预置通关路径、载人随板转动、栏杆半程截停与原位保留、
// 端口位置+朝向双条件、可走边与可见地面一致、重来完全复原。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canStep,
  computeWalkableEdges,
  createGameState,
  platformById,
  previewRotation,
  reset,
  runtimePorts,
  startRotation,
  tryMove,
  update,
  ROTATION_DURATION,
} from '../src/engine/engine.js';
import { createBlockedLevel, createSolvableLevel } from '../src/engine/levels.js';
import type { Dir, GameState } from '../src/engine/types.js';

function walk(state: GameState, dirs: Dir[]): void {
  for (const d of dirs) {
    tryMove(state, d);
    // 走步有冷却，推进时间让下一次输入生效
    update(state, 0.2);
  }
}

function rotate(state: GameState, id: 'A' | 'B', dir: 'cw' | 'ccw'): void {
  const ok = startRotation(state, id, dir);
  assert.equal(ok, true, '本次转动应当被允许');
  // 推进超过动画时长，保证落回 idle
  update(state, ROTATION_DURATION + 0.05);
  assert.equal(state.phase, 'idle');
}

test('房间 1：按 A、B 各顺时针转一次可以走到出口', () => {
  const state = createGameState(createSolvableLevel());
  assert.deepEqual(state.player.cell, { x: 1, y: 4 });

  walk(state, ['E', 'E']); // (1,4) -> (2,4) 西缘 -> A 中心 (3,4)
  assert.equal(state.player.aboard, 'A');
  rotate(state, 'A', 'cw'); // 载人转动，中心格玩家原地不动，板的端口换位
  walk(state, ['E']); // 板内走到新的东端口 (4,4)
  // B 初始自带西端口，A->B 的隔坑对口其实已经成立；
  // 但 B 缺东端口，就算跨过去也无法向东穿出（见后面的断言）。
  assert.equal(canStep(state, { x: 4, y: 4 }, { x: 5, y: 4 }), false);
  assert.equal(canStep(state, { x: 8, y: 4 }, { x: 9, y: 4 }), false);

  // 玩家在 A 上，与 B 的扫掠区隔着整列空洞，可以安全先转 B
  rotate(state, 'B', 'cw');
  // 转后 B 东端口就位：一次对口跨越落到 (6,4)，再穿过 B 到出口 (11,4)
  assert.equal(canStep(state, { x: 8, y: 4 }, { x: 9, y: 4 }), true);
  walk(state, ['E', 'E', 'E', 'E', 'E', 'E']);
  assert.deepEqual(state.player.cell, state.exit);
  update(state, 0.1);
  assert.equal(state.phase, 'won');
});

test('未对接端口时不能跨到另一块步道/空洞', () => {
  const state = createGameState(createSolvableLevel());
  walk(state, ['E', 'E']); // 从西缘上 A，站在中心 (3,4)
  assert.equal(state.player.aboard, 'A');
  // A 初始缺东端口：走到东缘 (4,4) 后向东出板没有端口，必须被拒
  walk(state, ['E']);
  assert.deepEqual(state.player.cell, { x: 4, y: 4 });
  assert.equal(canStep(state, { x: 4, y: 4 }, { x: 5, y: 4 }), false);
  walk(state, ['E']);
  assert.deepEqual(state.player.cell, { x: 4, y: 4 });

  // 空洞格永远不可走
  assert.equal(canStep(state, { x: 4, y: 3 }, { x: 5, y: 3 }), false);
});

test('载人转动：角色相对枢轴位置随 90° 旋转更新', () => {
  const state = createGameState(createSolvableLevel());
  walk(state, ['E', 'E']); // 到 A 中心 (3,4)，枢轴 (3.5,4.5)，本地偏移 (0,0)
  assert.deepEqual(state.player.localOffset, { x: 0, y: 0 });
  // 再向北走一格到 (3,3)，本地偏移 (0,-1)，能看出旋转效果
  walk(state, ['N']);
  assert.deepEqual(state.player.cell, { x: 3, y: 3 });
  assert.deepEqual(state.player.localOffset, { x: 0, y: -1 });

  rotate(state, 'A', 'cw');
  // 屏幕坐标顺时针 90°：(0,-1) -> (1,0)，新格 (4,4)
  assert.deepEqual(state.player.localOffset, { x: 1, y: 0 });
  assert.deepEqual(state.player.cell, { x: 4, y: 4 });
  assert.equal(state.player.aboard, 'A');
  assert.equal(platformById(state.platforms, 'A')!.orientation, 1);
});

test('房间 2：栏杆半程截停（顺时针）且被挡后原位与原通路保留', () => {
  const state = createGameState(createBlockedLevel());
  const before = {
    cell: structuredClone(state.player.cell),
    aboard: state.player.aboard,
    orientA: platformById(state.platforms, 'A')!.orientation,
    edges: computeWalkableEdges(state).length,
  };

  // 顺时针：旋转顶点要走到约 40° 才进入对角栏杆格，是真正的“半程遇挡”
  const cw = previewRotation(state, 'A', 'cw');
  assert.equal(cw.ok, false);
  assert.equal(cw.blocker?.kind, 'rail');
  assert.deepEqual(cw.blocker?.cell, { x: 4, y: 2 });
  assert.ok(
    cw.blocker!.atAngle > Math.PI / 5,
    '顺时针应转到约 40°（>36°）才被截停',
  );
  assert.equal(startRotation(state, 'A', 'cw'), false);

  // 被挡后没有任何状态变化
  assert.equal(state.phase, 'idle');
  assert.deepEqual(state.player.cell, before.cell);
  assert.equal(state.player.aboard, before.aboard);
  assert.equal(platformById(state.platforms, 'A')!.orientation, before.orientA);
  assert.equal(computeWalkableEdges(state).length, before.edges);
  assert.match(state.banner, /截停/);
});

test('房间 2：逆时针起步即被同栏杆挡，同样保留原位', () => {
  const state = createGameState(createBlockedLevel());
  const ccw = previewRotation(state, 'A', 'ccw');
  assert.equal(ccw.ok, false);
  assert.equal(ccw.blocker?.kind, 'rail');
  assert.equal(startRotation(state, 'A', 'ccw'), false);
  assert.equal(state.phase, 'idle');
  assert.equal(platformById(state.platforms, 'A')!.orientation, 0);
});

test('房间 2 预览返回扫掠格且包含栏杆格（受影响范围可见）', () => {
  const state = createGameState(createBlockedLevel());
  const preview = previewRotation(state, 'A', 'cw');
  const keys = preview.sweptCells.map((c) => `${c.x},${c.y}`);
  assert.ok(keys.includes('4,2'), '扫掠范围应包含栏杆 (4,2)');
});

test('扫掠区不漏掉旋转边中途扫过的对角格（回归：稀疏采样漏格）', () => {
  // (4,2) 不在任一采样姿态的角点/中点上，但旋转边会在约 40° 扫入；
  // 若 collectSweptCells 只采角点与边中点，会漏掉它导致碰撞失检。
  const state = createGameState(createBlockedLevel());
  const preview = previewRotation(state, 'A', 'cw');
  assert.equal(preview.ok, false, '漏掉对角格会让本应被挡的转动误判为可转');
  assert.equal(preview.blocker?.kind, 'rail');
});

test('两块步道对接要求端口位置与朝向同时成立', () => {
  const state = createGameState(createSolvableLevel());

  // 玩家先上 A 再转动（出生点 (1,4) 在 A 的扫掠菱形里，不上去会挡住转动）
  walk(state, ['E', 'E']); // A 中心 (3,4)
  rotate(state, 'A', 'cw');
  walk(state, ['E']); // 东端口 (4,4)
  const portsA = runtimePorts(platformById(state.platforms, 'A')!);
  assert.deepEqual(portsA.find((p) => p.dir === 'E')!.cell, { x: 4, y: 4 });

  // B 初始自带西端口，A->B 的隔坑对口已成立；但 B 缺东端口，东侧出板被拒
  assert.equal(canStep(state, { x: 4, y: 4 }, { x: 5, y: 4 }), false); // 相邻坑格
  assert.equal(canStep(state, { x: 4, y: 4 }, { x: 6, y: 4 }), true); // 隔坑对口
  assert.equal(canStep(state, { x: 8, y: 4 }, { x: 9, y: 4 }), false); // B 东缘出不去

  // 玩家在 A 上，与 B 的扫掠区不相交，可以安全转 B
  rotate(state, 'B', 'cw');
  // 转后 B 东端口就位，板东缘可以穿出；隔坑对口依然成立
  assert.equal(canStep(state, { x: 4, y: 4 }, { x: 6, y: 4 }), true);
  assert.equal(canStep(state, { x: 8, y: 4 }, { x: 9, y: 4 }), true);
});

test('可走边只落在可站立地面上（墙/空洞/栏杆格无入边）', () => {
  const state = createGameState(createSolvableLevel());
  const edges = computeWalkableEdges(state);
  for (const edge of edges) {
    for (const cell of [edge.from, edge.to]) {
      const kind = state.grid.get(`${cell.x},${cell.y}`) ?? 'floor';
      const onPlatform = state.platforms.some(
        (p) =>
          cell.x >= p.origin.x &&
          cell.x < p.origin.x + p.size &&
          cell.y >= p.origin.y &&
          cell.y < p.origin.y + p.size,
      );
      assert.ok(
        onPlatform || kind === 'floor',
        `可走边端点 (${cell.x},${cell.y}) 落在不可站立格 ${kind}`,
      );
    }
  }
});

test('转动期间移动被锁定，停稳后按新位置通行', () => {
  const state = createGameState(createSolvableLevel());
  walk(state, ['E', 'E']); // 上 A，站在中心 (3,4)
  assert.equal(startRotation(state, 'A', 'cw'), true);
  assert.equal(state.phase, 'rotating');
  // 动画中途尝试移动：无效
  update(state, ROTATION_DURATION / 2);
  const cellMid = structuredClone(state.player.cell);
  tryMove(state, 'E');
  assert.deepEqual(state.player.cell, cellMid);
  // 推进到停稳
  update(state, ROTATION_DURATION);
  assert.equal(state.phase, 'idle');
  assert.deepEqual(state.player.cell, { x: 3, y: 4 });
  // 板内走到东端口后，按新位置出现通向坑对面的对口可走边
  walk(state, ['E']);
  assert.deepEqual(state.player.cell, { x: 4, y: 4 });
  assert.equal(canStep(state, { x: 4, y: 3 }, { x: 4, y: 4 }), true);
});

test('未乘板的角色挡在扫掠路径上会阻止转动', () => {
  const state = createGameState(createSolvableLevel());
  // 把角色放到 A 东侧外一格 (4,4)（该格属于 A 占位，改为放到北边 (3,2) 地板），
  // A 转动时菱形顶点会扫到
  state.player.cell = { x: 3, y: 2 };
  state.player.pos = { x: 3.5, y: 2.5 };
  state.player.aboard = null;
  state.player.localOffset = null;
  const preview = previewRotation(state, 'A', 'cw');
  assert.equal(preview.ok, false);
  assert.equal(preview.blocker?.kind, 'player');
});

test('重来：房间 2 被挡后 reset 完整复原角色与通路', () => {
  const original = createBlockedLevel();
  const state = createGameState(original);
  startRotation(state, 'A', 'cw'); // 被挡
  walk(state, ['N', 'S']); // 随便走走
  const restored = reset(state);
  assert.deepEqual(restored.player.cell, original.spawn);
  assert.equal(restored.player.aboard, 'A');
  assert.equal(platformById(restored.platforms, 'A')!.orientation, 0);
  assert.equal(restored.phase, 'idle');
  assert.equal(restored.banner, '');
});

test('房间 2 中 B 未受栏杆影响，仍可正常转动', () => {
  const state = createGameState(createBlockedLevel());
  const preview = previewRotation(state, 'B', 'cw');
  assert.equal(preview.ok, true);
  rotate(state, 'B', 'cw');
  assert.equal(platformById(state.platforms, 'B')!.orientation, 1);
});
