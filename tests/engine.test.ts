import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.ts';
import { beatToTime, buildChart } from '../src/engine/chart.ts';
import { gradeDelta } from '../src/engine/judge.ts';
import type { Chart, ChartConfig, InputEvent } from '../src/engine/types.ts';

const cfg: ChartConfig = {
  bpm: 120,
  beatsPerMeasure: 4,
  measures: 4,
  perfectWindow: 0.05,
  goodWindow: 0.12,
};

function chart(targets: Chart['targets'], over: Partial<ChartConfig> = {}): Chart {
  return { config: { ...cfg, ...over }, targets };
}

function tap(id: string, lane: string, beat: number) {
  return { id, lane, beat, lengthBeats: 0 };
}
function hold(id: string, lane: string, beat: number, len: number) {
  return { id, lane, beat, lengthBeats: len };
}

function feed(engine: Engine, events: InputEvent[], endT: number, step = 1 / 60): void {
  for (const e of events) engine.queueInput(e);
  for (let t = step / 2; t <= endT; t += step) engine.update(Math.min(t, endT));
  engine.update(endT);
}

describe('判定窗口边界（闭区间，压线归更优档）', () => {
  it('恰好 -50ms / +50ms 都是 perfect', () => {
    const c = chart([tap('T1', 'F', 2)]);
    const at = beatToTime(2, 120);
    const e1 = new Engine(c);
    e1.queueInput({ t: at - 0.05, kind: 'down', lane: 'F' });
    e1.update(at - 0.05);
    expect(e1.targets[0].finalGrade).toBe('perfect');
    const e2 = new Engine(chart([tap('T1b', 'F', 2)]));
    e2.queueInput({ t: at + 0.05, kind: 'down', lane: 'F' });
    e2.update(at + 0.05);
    expect(e2.targets[0].finalGrade).toBe('perfect');
  });

  it('51ms 落 good，120ms 压线仍是 good，121ms 不可命中', () => {
    const at = beatToTime(2, 120);
    const e1 = new Engine(chart([tap('T1', 'F', 2)]));
    e1.queueInput({ t: at + 0.051, kind: 'down', lane: 'F' });
    e1.update(at + 0.051);
    expect(e1.targets[0].finalGrade).toBe('good');

    const e2 = new Engine(chart([tap('T2', 'F', 2)]));
    e2.queueInput({ t: at + 0.12, kind: 'down', lane: 'F' });
    e2.update(at + 0.12);
    expect(e2.targets[0].finalGrade).toBe('good');

    const e3 = new Engine(chart([tap('T3', 'F', 2)]));
    e3.queueInput({ t: at + 0.121, kind: 'down', lane: 'F' });
    e3.update(at + 0.121);
    // 输入超窗 → ignored；随后引擎自动 miss
    expect(e3.log.some((r) => r.grade === 'ignored')).toBe(true);
    e3.update(at + 0.2);
    expect(e3.targets[0].finalGrade).toBe('miss');
  });

  it('gradeDelta 单位与闭区间正确', () => {
    expect(gradeDelta(0, 0.05, 0.12)).toBe('perfect');
    expect(gradeDelta(-0.05, 0.05, 0.12)).toBe('perfect');
    expect(gradeDelta(0.0500001, 0.05, 0.12)).toBe('good');
    expect(gradeDelta(-0.12, 0.05, 0.12)).toBe('good');
    expect(gradeDelta(0.1201, 0.05, 0.12)).toBeNull();
  });

  it('早/晚毫秒带符号记录', () => {
    const at = beatToTime(1, 120);
    const e = new Engine(chart([tap('T1', 'F', 1)]));
    e.queueInput({ t: at - 0.03, kind: 'down', lane: 'F' });
    e.update(at);
    expect(e.log[0].deltaMs).toBeCloseTo(-30, 5);
  });
});

describe('自动 miss', () => {
  it('超过 good 窗口未踩 → miss，且严格大于才触发（压线输入仍可命中）', () => {
    const at = beatToTime(1, 120);
    const e = new Engine(chart([tap('T1', 'F', 1)]));
    e.update(at + 0.12); // 压线时刻还没 miss
    expect(e.targets[0].state).toBe('pending');
    e.update(at + 0.121);
    expect(e.targets[0].finalGrade).toBe('miss');
    const row = e.log.find((r) => r.targetId === 'T1');
    expect(row?.source).toBe('auto');
  });
});

describe('窗口重叠：一次操作最多记一块', () => {
  it('同轨等距候选 → 更早拍位赢，输家保留待判，候选全记录', () => {
    const c = chart([tap('T2', 'F', 1), tap('T3', 'F', 1.4)]);
    const e = new Engine(c);
    // 0.60s：距 T2(0.50) +100ms，距 T3(0.70) -100ms
    e.queueInput({ t: 0.6, kind: 'down', lane: 'F' });
    e.update(0.6);
    const row = e.log[0];
    expect(row.targetId).toBe('T2');
    expect(row.grade).toBe('good');
    expect(row.candidates).toHaveLength(2);
    const loser = row.candidates!.find((x) => x.targetId === 'T3')!;
    expect(loser.won).toBe(false);
    expect(loser.reason).toContain('|Δ|');
    expect(e.targets.find((t) => t.id === 'T3')!.state).toBe('pending');
  });

  it('|Δ| 不等时归更近的板', () => {
    const c = chart([tap('T2', 'F', 1), tap('T3', 'F', 1.4)]);
    const e = new Engine(c);
    // 0.66s：距 T2 +160（超窗）、距 T3 -40 → 只有 T3 在窗口
    e.queueInput({ t: 0.66, kind: 'down', lane: 'F' });
    e.update(0.66);
    expect(e.log[0].targetId).toBe('T3');
    expect(e.log[0].grade).toBe('perfect');
    e.update(0.75);
    // T2 之后自动 miss
    expect(e.targets.find((t) => t.id === 'T2')!.finalGrade).toBe('miss');
  });

  it('异轨板在窗口里也不能被抢占，只进候选围观', () => {
    const c = chart([tap('A', 'F', 1), tap('B', 'J', 1.05)]);
    const e = new Engine(c);
    e.queueInput({ t: beatToTime(1.05, 120), kind: 'down', lane: 'F' });
    e.update(beatToTime(1.05, 120));
    const row = e.log[0];
    expect(row.targetId).toBe('A'); // F 键只能拿 F 板
    const j = row.candidates!.find((x) => x.targetId === 'B')!;
    expect(j.sameLane).toBe(false);
    expect(j.won).toBe(false);
    expect(j.reason).toContain('异轨');
  });

  it('窗口内没有本轨板 → ignored，不消耗任何目标', () => {
    const c = chart([tap('A', 'J', 1)]);
    const e = new Engine(c);
    e.queueInput({ t: beatToTime(1, 120), kind: 'down', lane: 'F' });
    e.update(beatToTime(1, 120));
    expect(e.log[0].grade).toBe('ignored');
    expect(e.targets[0].state).toBe('pending');
  });

  it('同拍同距（理论极端）→ id 字典序兜底，结果确定', () => {
    const c = chart([tap('ZB', 'F', 1), tap('AA', 'F', 1)]);
    const e = new Engine(c);
    const at = beatToTime(1, 120);
    e.queueInput({ t: at, kind: 'down', lane: 'F' });
    e.update(at);
    expect(e.log[0].targetId).toBe('AA');
  });

  it('重复按下（同轨已按住）记 ignored，不影响其他拍位', () => {
    const c = chart([hold('H1', 'F', 1, 1), tap('T9', 'F', 4)]);
    const e = new Engine(c);
    const h = beatToTime(1, 120);
    e.queueInput({ t: h, kind: 'down', lane: 'F' });
    e.queueInput({ t: h + 0.1, kind: 'down', lane: 'F' });
    e.update(h + 0.1);
    expect(e.log.map((r) => r.grade)).toEqual(['perfect', 'ignored']);
    expect(e.targets[0].state).toBe('held');
  });
});

describe('长按：头拍/尾拍与跨小节', () => {
  it('完整按住并在尾拍窗口内松手 → 头尾各一条，跨小节正常', () => {
    const c = chart([hold('H1', 'J', 3, 2)]); // beat3 → beat5，跨第 1/2 小节
    const e = new Engine(c);
    const head = beatToTime(3, 120);
    const tail = beatToTime(5, 120);
    e.queueInput({ t: head, kind: 'down', lane: 'J' });
    e.queueInput({ t: tail + 0.04, kind: 'up', lane: 'J' });
    feed(e, [], tail + 0.1);
    const rows = e.log.filter((r) => r.targetId === 'H1');
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('head');
    expect(rows[1].kind).toBe('tail');
    expect(rows.map((r) => r.grade)).toEqual(['perfect', 'perfect']);
  });

  it('中途提前释放 → 尾拍 miss，头拍成绩保留', () => {
    const c = chart([hold('H1', 'F', 5, 1)]);
    const e = new Engine(c);
    const head = beatToTime(5, 120);
    e.queueInput({ t: head, kind: 'down', lane: 'F' });
    e.queueInput({ t: head + 0.25, kind: 'up', lane: 'F' }); // 尾拍在 +0.5
    feed(e, [], head + 1);
    const rows = e.log.filter((r) => r.targetId === 'H1');
    expect(rows.map((r) => r.grade)).toEqual(['perfect', 'miss']);
    expect(e.targets[0].finalGrade).toBe('miss');
  });

  it('跨过尾拍不松手 → 尾拍时刻自动 perfect 结算', () => {
    const c = chart([hold('H1', 'F', 1, 1)]);
    const e = new Engine(c);
    const head = beatToTime(1, 120);
    const tail = beatToTime(2, 120);
    e.queueInput({ t: head, kind: 'down', lane: 'F' });
    feed(e, [], tail + 0.3);
    const tailRow = e.log.find((r) => r.kind === 'tail')!;
    expect(tailRow.grade).toBe('perfect');
    expect(tailRow.source).toBe('auto');
    expect(e.targets[0].state).toBe('done');
  });

  it('没有匹配按住的 up 静默丢弃', () => {
    const e = new Engine(chart([]));
    e.queueInput({ t: 1, kind: 'up', lane: 'F' });
    e.update(1);
    expect(e.log).toHaveLength(0);
  });
});

describe('暂停清理规则', () => {
  it('暂停瞬间所有按住按尾拍规则强制结算，无残留 held', () => {
    const c = chart([hold('H1', 'F', 1, 2)]);
    const e = new Engine(c);
    const head = beatToTime(1, 120);
    e.queueInput({ t: head, kind: 'down', lane: 'F' });
    e.update(head);
    // 在头拍后 0.3s 暂停，尾拍在 1.0s 后 → 远在窗口外 → miss
    e.pause(head + 0.3);
    expect(e.paused).toBe(true);
    expect(e.targets[0].state).toBe('done');
    const tailRow = e.log.find((r) => r.kind === 'tail')!;
    expect(tailRow.grade).toBe('miss');
    expect(tailRow.source).toBe('pause');
    // 暂停期间 update 不推进
    const before = e.log.length;
    e.update(head + 5);
    expect(e.log.length).toBe(before);
    // 暂停会清空未处理输入队列：暂停期间入队的事件不会在恢复后补判
    e.queueInput({ t: head + 0.4, kind: 'down', lane: 'F' });
    e.resume();
    e.update(head + 5);
    expect(e.targets[0].state).toBe('done');
    // 恢复后没有新的目标被改变（H1 仍是暂停时的 miss）
    expect(e.targets[0].finalGrade).toBe('miss');
  });

  it('暂停时恰好在尾拍窗口内 → 按窗口给 perfect/good', () => {
    const c = chart([hold('H1', 'F', 1, 1)]);
    const e = new Engine(c);
    const head = beatToTime(1, 120);
    const tail = beatToTime(2, 120);
    e.queueInput({ t: head, kind: 'down', lane: 'F' });
    e.update(head);
    e.pause(tail + 0.05); // 压线 perfect
    expect(e.log.find((r) => r.kind === 'tail')!.grade).toBe('perfect');
  });
});

describe('从小节重新练习', () => {
  it('重置该小节起的目标与流水，保留之前成绩；跨越跳转点的长按强制收尾', () => {
    const c = chart([tap('T1', 'F', 0), tap('T2', 'F', 4), hold('H3', 'J', 3, 2)]);
    const e = new Engine(c);
    feed(
      e,
      [
        { t: beatToTime(0, 120), kind: 'down', lane: 'F' },
        { t: beatToTime(3, 120), kind: 'down', lane: 'J' },
      ],
      beatToTime(4.5, 120),
    );
    expect(e.targets.find((t) => t.id === 'T1')!.finalGrade).toBe('perfect');
    e.seekToMeasure(1); // 第 2 小节，beat4
    expect(e.now).toBeCloseTo(beatToTime(4, 120), 6);
    expect(e.targets.find((t) => t.id === 'T1')!.finalGrade).toBe('perfect');
    expect(e.targets.find((t) => t.id === 'T2')!.state).toBe('pending');
    // H3 头拍(beat3)在跳转点之前且仍 held：尾拍 miss 强制收尾，不参与重练
    const h3 = e.targets.find((t) => t.id === 'H3')!;
    expect(h3.state).toBe('done');
    expect(h3.finalGrade).toBe('miss');
    expect(e.log.filter((r) => r.targetId === 'H3')).toHaveLength(2); // 头 perfect + 尾 seek miss
    expect(e.log.filter((r) => r.targetId === 'T1')).toHaveLength(1);
  });

  it('从头拍所在小节跳走 → 该板重置 pending，无残留按住', () => {
    const c = chart([hold('H1', 'F', 4, 2)]);
    const e = new Engine(c);
    const head = beatToTime(4, 120);
    e.queueInput({ t: head, kind: 'down', lane: 'F' });
    e.update(head + 0.1);
    expect(e.targets[0].state).toBe('held');
    e.seekToMeasure(1); // beat4，正好是 H1 头拍
    expect(e.targets[0].state).toBe('pending');
    expect(e.summary().perfect + e.summary().miss).toBe(0);
  });
});

describe('拍号设置', () => {
  it('3/4 与 4/4 谱面都能构建与结算', () => {
    const text4 = 'F, 0, 0\nJ, 3, 0';
    const r4 = buildChart({ ...cfg, beatsPerMeasure: 4 }, text4);
    expect(r4.errors).toHaveLength(0);
    const e4 = new Engine(r4.chart!);
    e4.queueInput({ t: 0, kind: 'down', lane: 'F' });
    e4.update(0.1);
    expect(e4.targets[0].finalGrade).toBe('perfect');

    const text3 = 'F, 0, 0\nJ, 2, 1';
    const r3 = buildChart({ ...cfg, beatsPerMeasure: 3, measures: 4 }, text3);
    expect(r3.errors).toHaveLength(0);
    const e3 = new Engine(r3.chart!);
    e3.queueInput({ t: 0, kind: 'down', lane: 'F' });
    e3.update(0.1);
    expect(e3.targets[0].finalGrade).toBe('perfect');
  });

  it('非法配置被拒绝', () => {
    expect(buildChart({ ...cfg, perfectWindow: 0.2, goodWindow: 0.1 }, 'F,0').errors.length).toBeGreaterThan(0);
    expect(buildChart(cfg, 'F, abc').errors.length).toBeGreaterThan(0);
  });
});

describe('成绩汇总', () => {
  it('ignored 不进分母，hold 计两条', () => {
    const c = chart([hold('H1', 'F', 1, 1), tap('T2', 'J', 3)]);
    const e = new Engine(c);
    const head = beatToTime(1, 120);
    e.queueInput({ t: head, kind: 'down', lane: 'F' });
    e.queueInput({ t: 5, kind: 'down', lane: 'F' }); // 乱按 ignored
    feed(e, [], 5.5);
    const s = e.summary();
    expect(s.total).toBe(3);
    expect(s.ignored).toBe(1);
    expect(s.perfect).toBe(2); // hold 头尾
    expect(s.miss).toBe(1); // T2
    expect(s.accuracy).toBeCloseTo(2 / 3, 6);
  });
});
