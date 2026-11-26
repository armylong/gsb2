/**
 * verify.ts — 关卡设计契约 + 状态/判定逻辑自检
 * 运行: node scripts/verify.ts （也挂在 npm run verify 中）
 */
import assert from 'node:assert/strict';
import { LEVELS } from '../src/levels.ts';
import { GameStore } from '../src/game.ts';
import {
  evaluatePartition,
  outcomeOf,
  survivingAssignments,
  sumOf,
} from '../src/engine.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/* ---------- 每个关卡的基本契约 ---------- */
for (const lv of LEVELS) {
  check(`[${lv.id}] 真实重量合法且落在候选中`, () => {
    assert.equal(lv.trueWeights.length, lv.packageCount);
    for (const w of lv.trueWeights) assert.ok(lv.candidates.includes(w), `真实重量 ${w} 不在候选中`);
    assert.ok(lv.candidates.length >= 2);
    assert.ok(lv.maxWeighings >= 2);
  });

  check(`[${lv.id}] 预设分组完整且在真实重量下等重`, () => {
    const all = [...lv.intendedPartition.left, ...lv.intendedPartition.right].sort();
    assert.equal(all.length, lv.packageCount);
    assert.deepEqual(all, Array.from({ length: lv.packageCount }, (_, i) => i));
    const ls = sumOf(lv.trueWeights, lv.intendedPartition.left);
    const rs = sumOf(lv.trueWeights, lv.intendedPartition.right);
    assert.equal(ls, rs);
  });

  check(`[${lv.id}] scriptedWeighings 的结果与真实重量一致`, () => {
    assert.ok(lv.scriptedWeighings.length >= 1);
    for (const w of lv.scriptedWeighings) {
      assert.ok(w.left.length && w.right.length, '两盘都必须有包裹');
      assert.equal(outcomeOf(lv.trueWeights, w), w.outcome);
    }
  });
}

/* ---------- 组合称量关卡 ---------- */
const comboIdx = LEVELS.findIndex((l) => l.highlight === '组合称量');
const combo = LEVELS[comboIdx];

check('[combo] 每条证据称量单独都不足以使答案分组必然', () => {
  for (let i = 0; i < combo.scriptedWeighings.length; i++) {
    const surv = survivingAssignments(combo.packageCount, combo.candidates, [combo.scriptedWeighings[i]]);
    const v = evaluatePartition(surv, combo.intendedPartition.left, combo.intendedPartition.right);
    assert.notEqual(v.kind, 'necessary-equal', `第 ${i + 1} 条单称后竟已必然`);
  }
});

check('[combo] 全部证据联合后答案分组必然等重，且仍保留多个完整可能', () => {
  const surv = survivingAssignments(combo.packageCount, combo.candidates, combo.scriptedWeighings);
  assert.ok(surv.length > 1, '联合后应保留多个可能结果');
  const v = evaluatePartition(surv, combo.intendedPartition.left, combo.intendedPartition.right);
  assert.equal(v.kind, 'necessary-equal');
  if (v.kind === 'necessary-equal') assert.ok(v.possibleEqualSums.length >= 1);
});

check('[combo] 引擎给出的每个候选重量都有完整分配支撑', () => {
  const surv = survivingAssignments(combo.packageCount, combo.candidates, combo.scriptedWeighings);
  // 包裹 1（index 0）在设计中被夹逼为唯一值 1
  const values = new Set(surv.map((a) => a[0]));
  assert.deepEqual([...values], [1]);
  for (const a of surv) {
    for (const r of combo.scriptedWeighings) assert.equal(outcomeOf(a, r), r.outcome);
  }
});

/* ---------- 限次未定关卡 ---------- */
const tightIdx = LEVELS.findIndex((l) => l.highlight === '限次未定');
const tight = LEVELS[tightIdx];

check('[tight] 两次称量走完后仍有大量联合可能（用光次数仍不确定）', () => {
  assert.equal(tight.maxWeighings, tight.scriptedWeighings.length);
  const surv = survivingAssignments(tight.packageCount, tight.candidates, tight.scriptedWeighings);
  assert.ok(surv.length >= 10, `期望至少 10 种剩余可能，实际 ${surv.length}`);
});

check('[tight] 预设真实等重划分在两次记录后只是 contingent，必能给出反例', () => {
  const surv = survivingAssignments(tight.packageCount, tight.candidates, tight.scriptedWeighings);
  const v = evaluatePartition(surv, tight.intendedPartition.left, tight.intendedPartition.right);
  assert.equal(v.kind, 'contingent-equal');
  if (v.kind === 'contingent-equal') {
    // 反例确实来自剩余可能、满足全部记录、且两边不等
    assert.equal(v.counterexample.length, tight.packageCount);
    assert.notEqual(v.counterSums.left, v.counterSums.right);
    for (const r of tight.scriptedWeighings) {
      assert.equal(outcomeOf(v.counterexample, r), r.outcome, '反例不满足记录');
    }
    // 等重对照确实相等
    assert.equal(v.equalSums.left, v.equalSums.right);
  }
});

/* ---------- 判定器通用性质 ---------- */
check('evaluatePartition: necessary 时所有剩余分配都等重', () => {
  const surv = survivingAssignments(combo.packageCount, combo.candidates, combo.scriptedWeighings);
  const v = evaluatePartition(surv, combo.intendedPartition.left, combo.intendedPartition.right);
  assert.equal(v.kind, 'necessary-equal');
  for (const a of surv) {
    assert.equal(sumOf(a, combo.intendedPartition.left), sumOf(a, combo.intendedPartition.right));
  }
});

check('evaluatePartition: 零记录下 1+2 vs 3 为 contingent 且反例合法', () => {
  const surv = survivingAssignments(3, [1, 2, 3], []);
  const v = evaluatePartition(surv, [0, 1], [2]);
  assert.equal(v.kind, 'contingent-equal');
  if (v.kind === 'contingent-equal') {
    assert.notEqual(v.counterSums.left, v.counterSums.right);
    assert.equal(v.equalSums.left, v.equalSums.right);
  }
});

/* ---------- GameStore：次数消耗与重开还原 ---------- */
check('store: 摆放不消耗次数，只有 confirm 消耗 1 次', () => {
  const store = new GameStore(tightIdx);
  assert.equal(store.attemptsLeft(), tight.maxWeighings);
  store.setTray(0, 'left');
  store.setTray(1, 'right');
  assert.equal(store.attemptsLeft(), tight.maxWeighings, '摆放不应消耗次数');
  const rec = store.confirmWeighing();
  assert.ok(rec);
  assert.equal(store.state.records.length, 1);
  assert.equal(store.attemptsLeft(), tight.maxWeighings - 1);
});

check('store: 两盘缺一时不能确认', () => {
  const store = new GameStore(0);
  store.setTray(0, 'left');
  assert.equal(store.confirmWeighing(), null);
  assert.equal(store.state.records.length, 0);
});

check('store: 走完限次关卡 → 次数 0；重开后次数/记录/摆法/分组/判定全部还原', () => {
  const store = new GameStore(tightIdx);
  for (const w of tight.scriptedWeighings) {
    for (const p of w.left) store.setTray(p, 'left');
    for (const p of w.right) store.setTray(p, 'right');
    const rec = store.confirmWeighing();
    assert.ok(rec);
    // 确认后摆法保留，下一轮需手动清空再摆
    store.clearTray();
  }
  assert.equal(store.attemptsLeft(), 0);
  assert.equal(store.state.records.length, 2);
  assert.equal(store.canConfirm().ok, false);

  // 随便提交一个完整分组，产生判定
  for (let p = 0; p < tight.packageCount; p++) store.setShelf(p, p % 2 === 0 ? 'A' : 'B');
  const verdict = store.submitPartition();
  assert.ok(verdict);
  assert.ok(store.state.verdict !== null);

  store.restart();
  assert.equal(store.state.records.length, 0, '记录应清空');
  assert.equal(store.attemptsLeft(), tight.maxWeighings, '次数应还原');
  assert.ok(store.state.tray.every((s) => s === null), '天平摆法应清空');
  assert.ok(store.state.shelf.every((s) => s === null), '货架分组应清空');
  assert.equal(store.state.verdict, null, '判定应清空');
  assert.equal(store.state.won, false);
  assert.equal(store.state.viewing, 'draft');
  assert.equal(store.state.resetCount, 1);
});

check('store: 组合关卡按 scripted 操作可通关，通关状态为 won', () => {
  const store = new GameStore(comboIdx);
  for (const w of combo.scriptedWeighings) {
    for (const p of w.left) store.setTray(p, 'left');
    for (const p of w.right) store.setTray(p, 'right');
    assert.ok(store.confirmWeighing());
    store.clearTray();
  }
  const part = combo.intendedPartition;
  for (const p of part.left) store.setShelf(p, 'A');
  for (const p of part.right) store.setShelf(p, 'B');
  const v = store.submitPartition();
  assert.equal(v?.kind, 'necessary-equal');
  assert.equal(store.state.won, true);
});

check('store: 切换关卡得到全新状态', () => {
  const store = new GameStore(0);
  store.setTray(0, 'left');
  store.selectLevel(2);
  assert.equal(store.state.levelIndex, 2);
  assert.equal(store.state.records.length, 0);
  assert.ok(store.state.tray.every((s) => s === null));
});

console.log(`\n全部 ${passed} 项校验通过 ✅`);
