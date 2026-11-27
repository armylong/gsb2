import { describe, expect, it } from 'vitest';
import { LEVEL_1, LEVEL_2 } from '../src/game/levels';
import {
  analyzeCatch,
  initState,
  legalTargets,
  runScript,
  setGear,
  simulateTurn,
  type Action,
  type ScriptedTurn,
} from '../src/game/engine';
import type { GameState } from '../src/game/types';
import { Session } from '../src/game/session';

// 剧本简写：[档位, 操作] 表示本拍先调档（辅助操作，不占主要操作）再执行唯一主要操作
function script(...turns: Array<[0 | 1 | 2, Action] | Action>): ScriptedTurn[] {
  return turns.map((t) => (Array.isArray(t) ? { gear: t[0], action: t[1] } : { action: t }));
}
const move = (doughId: string, target: 'proof' | 'rack' | 'oven'): Action => ({
  type: 'move',
  doughId,
  target,
});
const pass: Action = { type: 'pass' };

function donenessMap(s: GameState): Record<string, number> {
  return Object.fromEntries(s.doughs.map((d) => [d.id, d.doneness]));
}

// ─────────────────────────────────────────────────────────────
// 第一关数据：A(熟2 窗[5,6] 止9) B(熟1 窗[7,9] 止10) C(熟3 窗[6,7] 止8)
// 温箱2槽 档0/1/2；凉架+1；炉占2拍，入炉拍冻结，下一拍打点交单
// ─────────────────────────────────────────────────────────────
const L1_WIN: ScriptedTurn[] = script(
  [1, move('A', 'proof')], // T1 A进箱 →A=3
  [2, move('C', 'proof')], // T2 C进箱 →A=5 C=5
  [2, move('A', 'oven')], // T3 A入炉(冻5,剩1)；C=7
  [0, move('B', 'proof')], // T4 A交单5✓；0档保温 C=7 B=1
  [2, move('C', 'oven')], // T5 C入炉(冻7)；B=3
  [2, pass], // T6 C交单7✓(止8)；B=5
  [2, pass], // T7 B=7
  [2, move('B', 'oven')], // T8 B入炉(冻7)
  pass, // T9 B交单7✓（止10）
);

describe('第一关 · 熟悉温箱', () => {
  it('通关剧本逐拍熟度与交单完全符合设计', () => {
    const { state, results } = runScript(LEVEL_1, L1_WIN);
    expect(donenessMap(results[0].state)).toEqual({ A: 3, B: 1, C: 3 });
    expect(donenessMap(results[1].state)).toEqual({ A: 5, B: 1, C: 5 });
    expect(donenessMap(results[2].state)).toEqual({ A: 5, B: 1, C: 7 }); // A 入炉冻结
    expect(donenessMap(results[3].state)).toEqual({ A: 5, B: 1, C: 7 }); // 0 档保温
    expect(donenessMap(results[4].state)).toEqual({ A: 5, B: 3, C: 7 }); // C 入炉冻结
    expect(donenessMap(results[5].state)).toEqual({ A: 5, B: 5, C: 7 });
    expect(donenessMap(results[6].state)).toEqual({ A: 5, B: 7, C: 7 });
    expect(donenessMap(results[7].state)).toEqual({ A: 5, B: 7, C: 7 }); // B 入炉冻结

    expect(state.status).toBe('won');
    expect(state.deliveries.map((r) => r.doughId)).toEqual(['A', 'C', 'B']);
    expect(state.deliveries.every((r) => r.result === 'success')).toBe(true);
    expect(state.deliveries.map((r) => r.turn)).toEqual([4, 6, 9]);
    expect(state.deliveries.map((r) => r.doneness)).toEqual([5, 7, 7]);
  });

  it('反例：C 贪留温箱多吃一拍 2 档，熟度 9 越过窗口上沿 7 → 烤过退单', () => {
    const counter = script(
      [2, move('C', 'proof')], // T1 C=5
      [2, pass], // T2 C=7（窗口上沿，本该准备入炉）
      [2, pass], // T3 C=9（越窗）
      move('C', 'oven'), // T4 入炉冻结 9
      pass, // T5 交单判定
    );
    const { state } = runScript(LEVEL_1, counter);
    expect(state.status).toBe('lost');
    const rec = state.deliveries.find((r) => r.doughId === 'C')!;
    expect(rec).toMatchObject({ result: 'late', doneness: 9, turn: 5 });
    expect(rec.reasons.join('；')).toContain('高于窗口上限 7');
  });

  it('一次交错失败不会清空其他面团：A、B 的熟度/位置/记录都保留', () => {
    // A 一直在温箱涨过自己的窗口；C 走失败线；B 完全不动
    const counter = script(
      [2, move('A', 'proof')], // T1 A=4
      [2, move('C', 'proof')], // T2 A=6 C=5
      [2, pass], // T3 A=8 C=7
      [2, pass], // T4 A=10 C=9
      move('C', 'oven'), // T5 C 入炉（A=12 触顶）
      pass, // T6 C 交单=9 烤过退单
    );
    const { state } = runScript(LEVEL_1, counter);
    expect(state.status).toBe('lost');
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({ doughId: 'C', result: 'late' });
    const A = state.doughs.find((d) => d.id === 'A')!;
    const B = state.doughs.find((d) => d.id === 'B')!;
    expect(A.doneness).toBe(12);
    expect(A.zone).toBe('proof');
    expect(B.doneness).toBe(1);
    expect(B.zone).toBe('bench');
  });
});

// ─────────────────────────────────────────────────────────────
// 第二关数据：A(熟1 窗[4,5] 止6) B(熟4 窗[7,9] 止9) C(熟2 窗[6,8] 止10)
// 烤炉一次一团占2拍；EDF 顺序 A→B→C
// ─────────────────────────────────────────────────────────────
// 第二关最终通关剧本（模块级常量，供文档与测试共用）
// 关键约束：温箱只有 2 槽，T4 A 出箱后 C 才能进；C 走凉架慢速线，档期正好接住 B 腾出的炉
const L2_FINAL: ScriptedTurn[] = script(
  [1, move('A', 'proof')], // T1 A=2
  [1, move('B', 'proof')], // T2 A=3 B=5
  [1, pass], // T3 A=4 B=6（养熟 A，等炉位档期）
  move('A', 'oven'), // T4 A入炉(冻4)，腾出箱槽；B=7
  [1, move('C', 'rack')], // T5 A交单4✓(止6)；B=8；C上凉架=3
  move('B', 'oven'), // T6 B入炉(冻8)；C凉架=4
  pass, // T7 B交单8✓(止9)；C=5
  pass, // T8 C=6（炉空着，先在凉架养到窗口内）
  move('C', 'oven'), // T9 C 换位入炉(冻6)，凉架 +1 在换位之后、入炉吃不到
  pass, // T10 C 交单=6✓（止10，窗口[6,8]下沿）
);

describe('第二关 · 烤炉撞单', () => {
  it('通关剧本：三单按截止顺序排队，全部准时合格', () => {
    const { state, results } = runScript(LEVEL_2, L2_FINAL);
    expect(donenessMap(results[2].state)).toMatchObject({ A: 4, B: 6 });
    expect(donenessMap(results[4].state)).toMatchObject({ B: 8, C: 3 });
    expect(donenessMap(results[6].state)).toMatchObject({ C: 5 });
    expect(donenessMap(results[7].state)).toMatchObject({ C: 6 });
    expect(state.status).toBe('won');
    expect(state.deliveries.map((r) => r.doughId)).toEqual(['A', 'B', 'C']);
    expect(state.deliveries.map((r) => r.result)).toEqual(['success', 'success', 'success']);
    expect(state.deliveries.map((r) => r.turn)).toEqual([5, 7, 10]);
    expect(state.deliveries.map((r) => r.doneness)).toEqual([4, 8, 6]);
  });

  it('反例一（夹生 early）：A 只养到熟度 3 就抢入炉，交单低于窗口下限 4', () => {
    const counter = script(
      [1, move('A', 'proof')], // T1 A=2
      move('A', 'oven'), // T2 A 提前入炉（冻 3… 实际 T1 末已 2，入炉拍冻结为 2）
      pass, // T3 交单
    );
    const { state } = runScript(LEVEL_2, counter);
    expect(state.status).toBe('lost');
    expect(state.deliveries[0]).toMatchObject({ doughId: 'A', result: 'early', doneness: 2, turn: 3 });
    expect(state.deliveries[0].reasons.join()).toContain('低于窗口下限 4');
  });

  it('反例二（撞单超时）：B 抢先入炉，A 被挤到截止之后，且熟度也不足', () => {
    const counter = script(
      [1, move('A', 'proof')], // T1 A=2
      [1, move('B', 'proof')], // T2 A=3 B=5
      move('B', 'oven'), // T3 B 抢炉（冻5）
      [1, move('C', 'proof')], // T4 B 交单=5（B 窗[7,9] → B 自己先夹生退单）
    );
    const { state } = runScript(LEVEL_2, counter);
    expect(state.status).toBe('lost');
    expect(state.deliveries[0]).toMatchObject({ doughId: 'B', result: 'early', doneness: 5, turn: 4 });
    // A 仍在温箱，状态未被清空
    expect(state.doughs.find((d) => d.id === 'A')!.zone).toBe('proof');
  });

  it('反馈区分：熟度合格但晚于截止 → overdue；窗口判定优先于截止判定', () => {
    function deliverA(entryTurn: number) {
      let st = initState(LEVEL_2);
      st = setGear(st, 1);
      // T1 进箱 T2/T3 续养：1→2→3→4（合格）
      st = simulateTurn(st, LEVEL_2, move('A', 'proof')).state;
      st = simulateTurn(st, LEVEL_2, pass).state;
      st = simulateTurn(st, LEVEL_2, pass).state;
      expect(st.doughs.find((d) => d.id === 'A')!.doneness).toBe(4);
      // 转 0 档在温箱里空等，熟度冻结在 4
      st = setGear(st, 0);
      while (st.turn < entryTurn) st = simulateTurn(st, LEVEL_2, pass).state;
      st = simulateTurn(st, LEVEL_2, move('A', 'oven')).state;
      const final = simulateTurn(st, LEVEL_2, pass);
      return final.state.deliveries.find((r) => r.doughId === 'A')!;
    }
    // 入炉 T5 → 交单 T6（=截止 6）边界准时
    expect(deliverA(5)).toMatchObject({ result: 'success', turn: 6, doneness: 4 });
    // 入炉 T6 → 交单 T7（>截止 6），熟度仍合格 → overdue
    expect(deliverA(6)).toMatchObject({ result: 'overdue', turn: 7, doneness: 4 });
  });
});

describe('结算顺序与工位规则', () => {
  it('事件顺序固定：换位 → 烤炉倒数 → 温箱 → 凉架；刚换位在新位置结算', () => {
    const st0 = setGear(initState(LEVEL_1), 2);
    const r = simulateTurn(st0, LEVEL_1, move('A', 'proof'));
    const kinds = r.events.map((e) => e.kind);
    expect(kinds[0]).toBe('move');
    expect(kinds.indexOf('move')).toBeLessThan(kinds.indexOf('proof-tick'));
    // A 本拍刚进温箱也吃到 +2：2 → 4
    expect(r.state.doughs.find((d) => d.id === 'A')!.doneness).toBe(4);
  });

  it('温箱槽位有限：两槽占满后第三团入箱被拒，且状态不变', () => {
    let st = initState(LEVEL_1);
    st = simulateTurn(st, LEVEL_1, move('A', 'proof')).state;
    st = simulateTurn(st, LEVEL_1, move('C', 'proof')).state;
    expect(legalTargets(st, 'B')).not.toContain('proof');
    const r = simulateTurn(st, LEVEL_1, move('B', 'proof'));
    expect(r.rejected).not.toBeNull();
    expect(r.state).toBe(st);
  });

  it('烤炉一次一团：占用期间其他面团不能入炉', () => {
    let st = initState(LEVEL_1);
    st = simulateTurn(st, LEVEL_1, move('A', 'oven')).state;
    expect(st.ovenDoughId).toBe('A');
    expect(legalTargets(st, 'B')).not.toContain('oven');
  });

  it('炉内熟度冻结，占满 2 拍自动交单', () => {
    let st = initState(LEVEL_1);
    const before = st.doughs.find((d) => d.id === 'A')!.doneness;
    st = simulateTurn(st, LEVEL_1, move('A', 'oven')).state;
    expect(st.doughs.find((d) => d.id === 'A')!.ovenRemaining).toBe(1);
    expect(st.doughs.find((d) => d.id === 'A')!.doneness).toBe(before);
    st = simulateTurn(st, LEVEL_1, pass).state;
    const rec = st.deliveries.find((r) => r.doughId === 'A')!;
    expect(rec.doneness).toBe(before);
    expect(st.ovenDoughId).toBeNull();
  });

  it('凉架以更慢速度变化，案板完全不变', () => {
    let st = initState(LEVEL_1);
    st = simulateTurn(st, LEVEL_1, move('C', 'rack')).state;
    expect(st.doughs.find((d) => d.id === 'C')!.doneness).toBe(4); // 3+1
    expect(st.doughs.find((d) => d.id === 'B')!.doneness).toBe(1); // 案板不动
  });
});

describe('撤销与模拟', () => {
  it('撤销回到整回合开始：熟度、炉位、剩余时间、档位与日志全部还原', () => {
    const session = new Session(LEVEL_1);
    session.changeGear(2);
    const snap = JSON.parse(JSON.stringify(session.state)) as GameState;
    session.planMove('A', 'proof');
    session.commit();
    expect(session.state.doughs.find((d) => d.id === 'A')!.doneness).toBe(4);
    expect(session.undo()).toBe(true);
    expect(JSON.parse(JSON.stringify(session.state))).toEqual(JSON.parse(JSON.stringify(snap)));
    expect(session.state.doughs.find((d) => d.id === 'A')!.doneness).toBe(2);
    expect(session.state.gear).toBe(2);
    expect(session.state.ovenDoughId).toBeNull();
  });

  it('模拟只算不提交：预览里熟度变化，真实状态不变', () => {
    const session = new Session(LEVEL_1);
    session.planMove('A', 'proof');
    const sim = session.preview();
    expect(sim.rejected).toBeNull();
    expect(sim.state.doughs.find((d) => d.id === 'A')!.doneness).toBe(3);
    expect(session.state.doughs.find((d) => d.id === 'A')!.doneness).toBe(2);
  });

  it('非法操作提交被拒：不推进回合、不入撤销栈', () => {
    const session = new Session(LEVEL_1);
    session.planMove('A', 'oven');
    session.commit();
    const turn = session.state.turn;
    const stackDepth = (session as unknown as { undoStack: unknown[] }).undoStack.length;
    session.planMove('B', 'oven'); // 炉被 A 占着
    const r = session.commit();
    expect(r.rejected).not.toBeNull();
    expect(session.state.turn).toBe(turn);
    expect((session as unknown as { undoStack: unknown[] }).undoStack.length).toBe(stackDepth);
  });
});

describe('赶单分析', () => {
  it('开局三团都可赶，且给出最晚入炉拍 = 截止 - 占炉 + 1', () => {
    const infos = analyzeCatch(initState(LEVEL_2), LEVEL_2);
    const byId = Object.fromEntries(infos.map((i) => [i.doughId, i]));
    expect(byId.A.status).not.toBe('impossible');
    expect(byId.B.status).not.toBe('impossible');
    expect(byId.C.status).not.toBe('impossible');
    expect(byId.A.latestEntry).toBe(5); // 6-2+1
    expect(byId.C.latestEntry).toBe(9); // 10-2+1
  });

  it('熟度冲过窗口上限后判定赶不上', () => {
    let st = setGear(initState(LEVEL_1), 2);
    st = simulateTurn(st, LEVEL_1, move('A', 'proof')).state; // 4
    st = simulateTurn(st, LEVEL_1, pass).state; // 6
    st = simulateTurn(st, LEVEL_1, pass).state; // 8（A 窗 [5,6]）
    const info = analyzeCatch(st, LEVEL_1).find((i) => i.doughId === 'A')!;
    expect(info.status).toBe('impossible');
    expect(info.detail).toContain('超过窗口上限');
  });
});
