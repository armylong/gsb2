import { test } from 'node:test';
import assert from 'node:assert/strict';
import { level, paradeA, paradeB, solutionA, solutionB } from '../src/data.js';
import { simulate, checkSight, layoutConflict, cloneLayout, signAnchorAt, EDGE_EPS } from '../src/sim.js';
import { Game } from '../src/game.js';
import { Layout, ParadeDef } from '../src/model.js';

const okAll = (parade: ParadeDef, l: Layout) => simulate(level, parade, l).viewers.every(v => v.ok);

// ---------- 可重复通关布置 ----------
test('通关布置可重复通关:巡游一', () => {
  assert.ok(okAll(paradeA, solutionA));
  assert.ok(okAll(paradeA, solutionA)); // 重复跑结果一致
});
test('通关布置可重复通关:巡游二', () => {
  assert.ok(okAll(paradeB, solutionB));
});

// ---------- 样例一:遮挡变换(前排观众挡住小船) ----------
test('遮挡变换:后排观众被前排挡住低矮小船', () => {
  // 阿婆(眼高1.15)坐后排,老塔(眼高1.6)坐她正前方;第二轮小船贴岸最低。
  const layout: Layout = {
    chairs: [
      { id: 'c1', holeId: 'h21', facing: -Math.PI / 2, viewerId: 'apo' },   // 后排
      { id: 'c2', holeId: 'h01', facing: -Math.PI / 2, viewerId: 'laota' }, // 正前方
      { id: 'c3', holeId: 'h04', facing: -Math.PI / 2, viewerId: 'ama' },
      { id: 'c4', holeId: 'h14', facing: -Math.PI / 2, viewerId: 'ashe' },
      { id: 'c5', holeId: 'h20', facing: -Math.PI / 2, viewerId: 'adao' },
      { id: 'c6', holeId: 'h24', facing: -Math.PI / 2, viewerId: 'xiaohai' },
    ],
  };
  const r = simulate(level, paradeA, layout);
  const lost = r.events.find(e => e.viewerId === 'apo' && e.round === 1 && e.kind === 'lost' && e.reason.includes('观众'));
  assert.ok(lost, '第二轮应出现被前排观众挡住的丢失事件');
  // 同一时刻换成没有前排的布置就看得见
  const solo: Layout = { chairs: [{ id: 'c1', holeId: 'h21', facing: -Math.PI / 2, viewerId: 'apo' }] };
  const alone = simulate(level, paradeA, solo);
  const apoAlone = alone.viewers.find(v => v.viewerId === 'apo')!;
  assert.ok(apoAlone.detail.includes('贴岸穿行'), '单人时应能统计到第二轮占比');
});

// ---------- 样例二:临时错位(朝向转开,关键时刻错过) ----------
test('临时错位:椅子转错朝向导致关键时刻错过,转回即恢复', () => {
  const broken = cloneLayout(solutionA);
  const chair = broken.chairs.find(c => c.viewerId === 'ashe')!;
  chair.facing = Math.PI / 2; // 转向岸边,背对水面
  const r = simulate(level, paradeA, broken);
  const ashe = r.viewers.find(v => v.viewerId === 'ashe')!;
  assert.equal(ashe.ok, false);
  assert.ok(ashe.firstFailG !== null, '失败应记录可跳回的时刻');
  // 该时刻的即时判定:不在可接受朝向内
  const round = paradeA.rounds[2];
  const s = checkSight(level, broken, round, paradeA, level.viewers.find(v => v.id === 'ashe')!, chair, 'big', 14);
  assert.equal(s.inFov, false);
  // 转回通关朝向即恢复
  assert.ok(okAll(paradeA, solutionA));
});

// ---------- 样例三:合法换位与同孔冲突 ----------
test('合法换位:交换两椅孔位,占用仍唯一;同孔冲突保持原布置', () => {
  const swapped = cloneLayout(solutionA);
  const [a, b] = [swapped.chairs[0], swapped.chairs[1]];
  [a.holeId, b.holeId] = [b.holeId, a.holeId];
  assert.equal(layoutConflict(swapped), null);

  const game = new Game(level, paradeA);
  const before = JSON.stringify(game.committed);
  // 暂存两把椅子到同一孔位 → 应用时保持原布置
  game.stageMove(game.staged.chairs[0].id, 'h03');
  game.stageMove(game.staged.chairs[1].id, 'h03');
  game.applyAndPlay();
  assert.equal(JSON.stringify(game.committed), before, '同孔冲突应保持原来的布置');
  assert.ok(game.message.includes('同一孔位'));
  assert.equal(game.phase, 'edit');

  // 合法移动:移动次数与座位占用一致
  game.stageMove(game.staged.chairs[0].id, 'h03');
  assert.equal(game.stagedMoveCount(), 1);
  const movesBefore = game.movesLeft;
  game.applyAndPlay();
  assert.equal(game.movesLeft, movesBefore - 1);
  assert.equal(game.phase, 'playing');
  // 撤销:次数退回、布置还原
  game.undo();
  assert.equal(game.movesLeft, movesBefore);
  assert.equal(JSON.stringify(game.committed), before);
});

// ---------- 场中变化:导览牌按演出时间挪动 ----------
test('场中变化:导览牌在剧本时刻换锚点', () => {
  const round = paradeA.rounds[2];
  assert.equal(signAnchorAt(round, 11.9), 2);
  assert.equal(signAnchorAt(round, 12), 0);
  const roundB = paradeB.rounds[1];
  assert.equal(signAnchorAt(roundB, 9.9), 1);
  assert.equal(signAnchorAt(roundB, 10), 2);
});

// ---------- 擦边统一规则:预览与结算一致 ----------
test('擦边规则:恰好相切算看得见,预览与结算同一判定', () => {
  const eye = level.holes.find(h => h.id === 'h04')!.pos; // (830,445)
  const pillar = level.pillars[1];                        // (560,398) r15 h3.0
  const dir = { x: pillar.pos.x - eye.x, y: pillar.pos.y - eye.y };
  const dl = Math.hypot(dir.x, dir.y);
  const u = { x: dir.x / dl, y: dir.y / dl };
  const L = 500;
  // 从眼睛作柱圆的切线:方向取 u 旋转 asin(off/dl),线到柱心距离恰为 off
  const mk = (off: number) => {
    const a = Math.atan2(u.y, u.x) + Math.asin(off / dl);
    return { x: eye.x + Math.cos(a) * L, y: eye.y + Math.sin(a) * L };
  };
  const viewer = level.viewers.find(v => v.id === 'ashe')!; // 眼高1.45
  const facing = (p: { x: number; y: number }) => Math.atan2(p.y - eye.y, p.x - eye.x);
  const mkParade = (boatPos: { x: number; y: number }): ParadeDef => ({
    id: 'T', name: '擦边校验',
    boats: [{ id: 'big', name: '校验船', height: 3.4, speed: 0, color: '#fff' }],
    rounds: [{
      name: 'r', routes: { big: [boatPos, boatPos] }, signAnchor: 0, duration: 1,
      keyMoments: [{ id: 'T-m', t: 0, label: '校验时刻' }],
    }],
  });
  const mkLayout = (boatPos: { x: number; y: number }): Layout => ({
    chairs: [{ id: 'c1', holeId: 'h04', facing: facing(boatPos), viewerId: 'ashe' }],
  });
  const viewerLevel = { ...level, viewers: [{ ...viewer, contract: { kind: 'moments' as const, boatId: 'big', moments: ['T-m'] } }] };

  // 恰好相切(距离 == 半径):按统一规则算看得见
  const tangent = mk(pillar.r);
  const p1 = mkParade(tangent), l1 = mkLayout(tangent);
  const s1 = checkSight(viewerLevel, l1, p1.rounds[0], p1, viewerLevel.viewers[0], l1.chairs[0], 'big', 0);
  assert.equal(s1.visible, true, '相切应算看得见');
  const set1 = simulate(viewerLevel, p1, l1);
  assert.equal(set1.viewers[0].ok, true, '结算与预览一致:相切算看得见');

  // 边缘内 EPS 范围(距离 = r - EDGE_EPS/2):仍算看得见
  const graze = mk(pillar.r - EDGE_EPS / 2);
  const p2 = mkParade(graze), l2 = mkLayout(graze);
  const s2 = checkSight(viewerLevel, l2, p2.rounds[0], p2, viewerLevel.viewers[0], l2.chairs[0], 'big', 0);
  assert.equal(s2.visible, true, '擦边在 EPS 内仍算看得见');

  // 明确压线(距离 < r - EPS):被立柱挡住
  const inside = mk(pillar.r - EDGE_EPS - 4);
  const p3 = mkParade(inside), l3 = mkLayout(inside);
  const s3 = checkSight(viewerLevel, l3, p3.rounds[0], p3, viewerLevel.viewers[0], l3.chairs[0], 'big', 0);
  assert.equal(s3.visible, false);
  assert.ok(s3.blockers.some(b => b.type === 'pillar' && b.id === pillar.id));
  const set3 = simulate(viewerLevel, p3, l3);
  assert.equal(set3.viewers[0].ok, false, '结算与预览一致:压线算被挡');
});

// ---------- 失败可跳回 ----------
test('失败记录带有可跳回的时刻', () => {
  const game = new Game(level, paradeA); // 初始布置并非通关布置
  const r = game.committedSim();
  const failed = r.viewers.filter(v => !v.ok);
  assert.ok(failed.length > 0, '初始布置应有人不达标');
  for (const f of failed) assert.ok(f.firstFailG !== null && f.firstFailG >= 0);
  game.jumpTo(failed[0].firstFailG!);
  assert.equal(game.phase, 'playing');
  assert.ok(game.paused);
  assert.ok(Math.abs(game.globalT - failed[0].firstFailG!) < 1e-6);
});
