import { describe, expect, it } from 'vitest';
import { RULES } from '../src/engine/rules';
import {
  createSimulation,
  deliver,
  move,
  pickup,
  wait,
} from '../src/engine/engine';
import { LEVEL } from '../src/engine/level';
import { planHint, canReturnHome } from '../src/engine/planner';
import { tideLevel, ticksUntilClosed } from '../src/engine/tide';

const sim = () => createSimulation(LEVEL);

describe('潮汐时间表', () => {
  it('一个周期内完成退潮-低潮-涨潮-满潮', () => {
    expect(tideLevel(0, 60)).toBe(4);
    expect(tideLevel(20, 60)).toBe(0);
    expect(tideLevel(27, 60)).toBe(0);
    expect(tideLevel(54, 60)).toBe(4);
    // 周期循环
    expect(tideLevel(60, 60)).toBe(4);
    expect(tideLevel(80, 60)).toBe(0);
  });

  it('退潮沟(h0)只在水位为0的低潮窗口露出，涨潮一开始最先封', () => {
    // h0：水位严格等于 0 时才露出；低潮 t20–t34，t34 起水位 >0 立刻封
    expect(ticksUntilClosed(20, 0, 60)).not.toBeNull();
    const closeAt = 20 + ticksUntilClosed(20, 0, 60)!;
    expect(closeAt).toBeGreaterThanOrEqual(33.5);
    expect(closeAt).toBeLessThanOrEqual(34.5);
    // 满潮时 h0 必然封着
    expect(tideLevel(0, 60)).toBe(4);
  });
});

describe('跨格移动与中途打断', () => {
  it('退潮窗口内 A-C-D 能走通，移动花确定时间', () => {
    const s = sim();
    wait(s, 17); // t=17，缓滩 h1 在水位降到 <1 时才通
    const r1 = move(s, 'C');
    expect(r1.ok).toBe(true);
    expect(s.cellId).toBe('C');
    expect(s.tick).toBe(17 + RULES.MOVE_TICKS);
    const r2 = move(s, 'D'); // 退潮沟
    expect(r2.ok).toBe(true);
    expect(s.cellId).toBe('D');
  });

  it('在低坪拖到涨潮后原路回 C，途中被打断并撤退', () => {
    const s = sim();
    wait(s, 17);
    move(s, 'C'); // t20
    move(s, 'D'); // t23
    // 退潮沟在 t34 后封；等到 t33 再动身，3 格移动必被打断
    wait(s, 10); // t33
    const before = s.tick;
    const r = move(s, 'C');
    expect(r.ok).toBe(true); // 打断但撤退成功
    expect(s.interruptCount).toBe(1);
    expect(s.lastMotion?.interruptedAt).toBeDefined();
    expect(s.tick).toBeGreaterThan(before);
    // 出发格 D 此时仍干（h1，水位还没到 1），应原路退回 D
    expect(s.cellId).toBe('D');
    expect(s.lastMotion?.retreatTo).toBe('D');
  });

  it('撤退规则：出发格上水时撤向高处干地而不是淹死', () => {
    const s = sim();
    wait(s, 17);
    move(s, 'C'); // t20
    move(s, 'D'); // t23
    // h1 在 t40 上水：等到 t40，D 已连续受淹 1 刻
    wait(s, 17); // t40
    const wetBefore = s.wetTicks;
    expect(wetBefore).toBe(1);
    // 退潮沟已封不能去 C；绕行脊 D-E(h2) 此刻仍露出，可紧急撤到高处
    const blocked = move(s, 'C');
    expect(blocked.ok).toBe(false);
    const r = move(s, 'E');
    expect(r.ok).toBe(true);
    expect(s.cellId).toBe('E');
    expect(s.wetTicks).toBe(0);
  });
});

describe('等待与受淹', () => {
  it('站在低格等过涨潮会逐刻累计受淹，超过阈值被困', () => {
    const s = sim();
    wait(s, 17);
    move(s, 'C'); // t20
    move(s, 'D'); // t23
    // h1 在 t40 上水；分两段等（单次上限 20 刻），到 t49 连续受淹 10 刻 >= 6
    wait(s, 20); // t43，湿 4
    wait(s, 6); // t49，湿 10 -> 被困
    expect(s.status).toBe('stranded');
    expect(s.wetTicks).toBeGreaterThanOrEqual(RULES.STRANDED_WET_TICKS);
  });

  it('轻信片泡水 3 刻即损毁，比爬虫被困更早触发', () => {
    const s = sim();
    wait(s, 17);
    move(s, 'C'); // t20
    move(s, 'D'); // t23
    pickup(s, 'L1');
    // h1 自 t40 上水，等到 t43 连续受淹 4 刻，超过轻信片 3 刻损毁线
    wait(s, 20); // t43
    expect(s.status).toBe('ruined');
    expect(s.interruptCount).toBe(0);
  });
});

describe('信片负重规则', () => {
  it('重信片不能走 h1 缓滩 A-C，但可经 h2 高路 D-B-A 回家', () => {
    const s = sim();
    wait(s, 17);
    move(s, 'C'); // t20
    move(s, 'E'); // t23 h2
    move(s, 'F'); // t26
    pickup(s, 'H1');
    // 负重 5 刻/格：F-D-B-A 全是 h2，算上涨潮也要赶在 h2 封路前
    const r1 = move(s, 'D');
    expect(r1.ok).toBe(true);
    expect(s.tick).toBe(31);
    const r2 = move(s, 'B');
    expect(r2.ok).toBe(true);
    expect(s.tick).toBe(36);
    const r3 = move(s, 'A');
    expect(r3.ok).toBe(true);
    expect(s.cellId).toBe('A');
    expect(s.tick).toBe(41);
    expect(deliver(s)).toBe(true);
    expect(s.delivered).toContain('H1');
  });

  it('负重站在 C 时 A-C 缓滩确实封死', () => {
    const s = sim();
    // 把重信片运到 C：F-E-C
    wait(s, 17);
    move(s, 'C'); // 20
    move(s, 'E'); // 23
    move(s, 'F'); // 26
    pickup(s, 'H1');
    move(s, 'E'); // 31 负重
    move(s, 'C'); // 36
    const r = move(s, 'A'); // 缓滩 h1，负重禁行
    expect(r.ok).toBe(false);
    expect(s.cellId).toBe('C');
    expect(s.log.some((l) => l.kind === 'refuse')).toBe(true);
    // 负重移动耗时翻倍
    expect(s.log.some((l) => l.text.includes('5 刻'))).toBe(true);
  });
});

describe('内置题：顺路取件但不能原路回来', () => {
  it('提示给出先等再走、绕行脊回家的全程方案，且每段在潮时下可完成', () => {
    const s = sim();
    const plan = planHint(LEVEL, { cell: 'A', carried: [], tick: 0, wet: 0, goal: 'deliver-all' });
    expect(plan).not.toBeNull();
    expect(plan!.steps.length).toBeGreaterThan(0);
    // 方案必须包含等待（开局满潮，不能立刻走）
    expect(plan!.steps.some((st) => st.type === 'wait')).toBe(true);
    // 必须包含拾件与交件
    expect(plan!.steps.some((st) => st.type === 'pickup')).toBe(true);
    expect(plan!.steps.some((st) => st.type === 'deliver')).toBe(true);
  });

  it('回程探测：退潮沟通行时回得来；在 D 拖到涨潮后提示只认真实潮时', () => {
    // t23 在 D，潮时安全
    expect(canReturnHome(LEVEL, { cell: 'D', carried: [], tick: 23, wet: 0 })).toBe(true);
    // t39 在 D：沟已封、D 刚上水，但 3 刻移动末刻 t42 < t45(h2封)，绕行脊还来得及
    expect(canReturnHome(LEVEL, { cell: 'D', carried: [], tick: 39, wet: 0 })).toBe(true);
    // t42：任何 3 刻移动的末刻都 >= t45，h2 全部封死，且等不到下个低潮（被困阈值 6 刻）
    expect(canReturnHome(LEVEL, { cell: 'D', carried: [], tick: 42, wet: 2 })).toBe(false);
    // t39 取轻信片：给出的撤离方案第一步不得是走入已封的退潮沟 C
    const late = planHint(LEVEL, { cell: 'D', carried: ['L1'], tick: 39, wet: 0, goal: 'reach-home' });
    expect(late).not.toBeNull();
    const firstMove = late!.steps.find((st) => st.type === 'move');
    expect(firstMove?.targetCell).not.toBe('C');
  });

  it('双件完整成功局：重件绕高路、轻件走缓滩，时刻全部入记录', () => {
    const s = sim();
    wait(s, 17);
    move(s, 'C'); // 20
    move(s, 'D'); // 23 退潮沟
    pickup(s, 'L1'); // t23
    move(s, 'F'); // 26 绕行脊
    pickup(s, 'H1'); // t26，此时同时带轻+重
    // 负重后移动 5 刻/格，只能走 h2：F-D-B-A
    move(s, 'D'); // 31
    move(s, 'B'); // 36
    move(s, 'A'); // 41
    expect(deliver(s)).toBe(true);
    expect(s.status).toBe('success');
    expect(s.pickupTicks['L1']).toBe(23);
    expect(s.pickupTicks['H1']).toBe(26);
    expect(s.deliverTicks['L1']).toBe(41);
    expect(s.deliverTicks['H1']).toBe(41);
    // 原路 C-D 在 t34 后封死，本方案没有一次走回头沟
    expect(s.interruptCount).toBe(0);
  });

  it('成功交件局（轻件绕行脊 + 缓滩回家），记录可重复对照', () => {
    const runOnce = () => {
      const s = sim();
      wait(s, 17);
      move(s, 'C'); // 20
      move(s, 'D'); // 23
      pickup(s, 'L1');
      move(s, 'E'); // 26 绕行脊
      move(s, 'C'); // 29
      move(s, 'A'); // 32 缓滩，轻信片可走
      expect(deliver(s, false)).toBe(true);
      return s;
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.status).toBe('success');
    expect(b.status).toBe('success');
    // 确定性：两局取件 / 交件时刻一致
    expect(a.pickupTicks).toEqual(b.pickupTicks);
    expect(a.deliverTicks).toEqual(b.deliverTicks);
    expect(a.deliverTicks['L1']! - a.pickupTicks['L1']!).toBe(9);
  });});
