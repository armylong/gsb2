import { describe, expect, it } from 'vitest';
import { buildSnapshot, nextArrival, previousArrival, timelineEnd } from './engine';
import { BUILT_IN_SCENARIOS } from '../data/scenarios';
import { buildWebVtt, cueBoundaryIssues } from './webvtt';
import { parseCaptionEvents, parseCaptionEventsText } from './validate';
import type { CaptionEvent } from './types';

const late = BUILT_IN_SCENARIOS[0].events;
const adjacent = BUILT_IN_SCENARIOS[1].events;

describe('到达顺序与接收判定', () => {
  it('未到达的事件不进入接收状态', () => {
    const snapshot = buildSnapshot(late, 0.6);
    expect(snapshot.stats.receivedCount).toBe(0);
    expect(snapshot.stats.pendingCount).toBe(late.length);
    expect(snapshot.audit.every((record) => record.verdict === 'pending')).toBe(true);
  });

  it('迟到的旧修订不覆盖已生效版本', () => {
    const snapshot = buildSnapshot(late, 2.5);
    expect(snapshot.captions[0].accepted?.seq).toBe(2);
    expect(snapshot.captions[0].accepted?.text).toBe('我们先测一下本地字幕的显示延迟。');
    const stale = snapshot.audit.find((record) => record.event.id === 'late-1-stale');
    expect(stale?.verdict).toBe('rejected');
    expect(stale?.reason).toBe('stale-revision');
    expect(stale?.effectiveText).toBe('我们先测一下本地字幕的显示延迟。');
  });

  it('同一事件重发只产生一条接收结果', () => {
    const snapshot = buildSnapshot(late, 3);
    const records = snapshot.audit.filter((record) => record.event.id === 'late-2');
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.verdict === 'accepted')).toHaveLength(1);
    expect(records.filter((record) => record.reason === 'duplicate-event')).toHaveLength(1);
  });

  it('同序号不同内容不能覆盖已生效文本', () => {
    const snapshot = buildSnapshot(late, 3.5);
    const conflict = snapshot.audit.find((record) => record.event.id === 'late-3-conflict');
    expect(conflict?.reason).toBe('duplicate-revision');
    expect(conflict?.verdict).toBe('rejected');
    expect(snapshot.captions[0].accepted?.text).toBe('我们先测一下本地字幕的显示延迟。');
  });

  it('结束标记可以沿用正文并锁定字幕', () => {
    const snapshot = buildSnapshot(late, 4);
    expect(snapshot.captions[0].final).toBe(true);
    expect(snapshot.captions[0].accepted?.seq).toBe(3);
    expect(snapshot.captions[0].accepted?.text).toBe('我们先测一下本地字幕的显示延迟。');
  });

  it('确认后到达的修订被拒绝', () => {
    const snapshot = buildSnapshot(late, 5);
    const after = snapshot.audit.find((record) => record.event.id === 'late-4-after');
    expect(after?.reason).toBe('after-final');
    expect(snapshot.confirmed).toHaveLength(1);
    expect(snapshot.confirmed[0].text).toBe('我们先测一下本地字幕的显示延迟。');
  });

  it('按到达顺序消费，与输入数组顺序无关', () => {
    const shuffled = [...late].sort((a, b) => b.id.localeCompare(a.id));
    const fromShuffled = buildSnapshot(shuffled, 5);
    const fromOrdered = buildSnapshot(late, 5);
    expect(fromShuffled.confirmed).toEqual(fromOrdered.confirmed);
    expect(fromShuffled.captions[0].accepted).toEqual(fromOrdered.captions[0].accepted);
    expect(fromShuffled.stats).toEqual(fromOrdered.stats);
  });
});

describe('任意跳转不残留未来版本', () => {
  it('从末尾跳回开头后画面与状态完全清空', () => {
    const atEnd = buildSnapshot(adjacent, 12.5);
    expect(atEnd.stats.confirmedCount).toBe(2);
    expect(atEnd.screen).toHaveLength(0); // 两句的媒体区间都已在 11s 结束

    const back = buildSnapshot(adjacent, 0);
    expect(back.screen).toEqual([]);
    expect(back.captions.every((caption) => caption.accepted === null)).toBe(true);
    expect(back.confirmed).toEqual([]);
    expect(back.stats.receivedCount).toBe(0);
  });

  it('来回跳转得到与单次跳转相同的快照', () => {
    const direct = buildSnapshot(adjacent, 7.2);
    const viaFuture = buildSnapshot(adjacent, 12);
    const back = buildSnapshot(adjacent, 7.2);
    expect(back).toEqual(direct);
    expect(viaFuture.time).toBe(12);
  });

  it('7.5s 时屏幕只有第二句，且第一句的迟到修正已接收', () => {
    const snapshot = buildSnapshot(adjacent, 7.5);
    expect(snapshot.screen).toHaveLength(1);
    expect(snapshot.screen[0].captionId).toBe('cap-202');
    expect(snapshot.captions.find((caption) => caption.captionId === 'cap-201')?.accepted?.seq).toBe(2);
  });

  it('时间回退到 6.9s 时第一句仍是旧版，第二句不在屏', () => {
    const snapshot = buildSnapshot(adjacent, 6.9);
    expect(snapshot.screen).toHaveLength(1);
    expect(snapshot.screen[0].captionId).toBe('cap-201');
    expect(snapshot.screen[0].seq).toBe(1);
    expect(snapshot.stats.receivedCount).toBe(2);
  });
});

describe('显示延迟', () => {
  it('延迟 2s 时呈现时钟回看，修正已带上', () => {
    const snapshot = buildSnapshot(adjacent, 7.5, 2);
    expect(snapshot.presentationTime).toBe(5.5);
    expect(snapshot.screen).toHaveLength(1);
    expect(snapshot.screen[0].captionId).toBe('cap-201');
    expect(snapshot.screen[0].seq).toBe(2);
    expect(snapshot.screen[0].text).toBe('第一句：会议在十点整开始。');
  });

  it('延迟不会改变接收与导出边界', () => {
    const noDelay = buildSnapshot(adjacent, 11, 0);
    const withDelay = buildSnapshot(adjacent, 11, 3);
    expect(withDelay.confirmed).toEqual(noDelay.confirmed);
    expect(withDelay.audit).toEqual(noDelay.audit);
    expect(withDelay.presentationTime).toBe(8);
  });

  it('负延迟按 0 处理', () => {
    const snapshot = buildSnapshot(adjacent, 5, -3);
    expect(snapshot.delay).toBe(0);
    expect(snapshot.presentationTime).toBe(5);
  });
});

describe('WebVTT 导出', () => {
  it('同一条字幕重发不会产生第二条 cue', () => {
    const snapshot = buildSnapshot(adjacent, 12.5);
    const build = buildWebVtt(snapshot.confirmed);
    expect(build.exported).toHaveLength(2);
    expect((build.vtt.match(/-->/g) ?? []).length).toBe(2);
    expect(build.vtt.match(/^cap-/gm)?.length).toBe(2);
  });

  it('重复传入同一 captionId 的 cue 会被去重', () => {
    const build = buildWebVtt([
      { captionId: 'a', seq: 1, text: '一', start: 1, end: 2, confirmedAt: 1 },
      { captionId: 'a', seq: 2, text: '二', start: 1, end: 2, confirmedAt: 2 },
      { captionId: 'b', seq: 1, text: '三', start: 2, end: 3, confirmedAt: 2 },
    ]);
    expect(build.exported).toHaveLength(2);
    expect(build.duplicatesDropped).toBe(1);
    expect(build.exported[0].text).toBe('一');
  });

  it('转义时间戳箭头并跳过空文本', () => {
    const build = buildWebVtt([
      { captionId: 'x', seq: 1, text: 'a --> b', start: 0, end: 1, confirmedAt: 0 },
      { captionId: 'y', seq: 1, text: '   ', start: 1, end: 2, confirmedAt: 1 },
    ]);
    expect(build.vtt).toContain('a → b');
    expect(build.skipped).toHaveLength(1);
    expect((build.vtt.match(/-->/g) ?? []).length).toBe(1);
  });

  it('两句相邻的导出边界首尾相接、无重叠', () => {
    const snapshot = buildSnapshot(adjacent, 11);
    expect(cueBoundaryIssues(snapshot.confirmed)).toEqual([]);
    expect(snapshot.confirmed[0].end).toBe(snapshot.confirmed[1].start);
    expect(buildWebVtt(snapshot.confirmed).vtt).toContain(
      '00:00:04.000 --> 00:00:07.000',
    );
    expect(buildWebVtt(snapshot.confirmed).vtt).toContain(
      '00:00:07.000 --> 00:00:11.000',
    );
  });

  it('只导出截至回放时刻已确认的字幕', () => {
    const early = buildSnapshot(adjacent, 9.8);
    expect(buildWebVtt(early.confirmed).exported).toHaveLength(1);
    const later = buildSnapshot(adjacent, 11);
    expect(buildWebVtt(later.confirmed).exported).toHaveLength(2);
  });
});

describe('内置样例', () => {
  it('每个核对点在其自身时刻通过', () => {
    for (const scenario of BUILT_IN_SCENARIOS) {
      for (const checkpoint of scenario.checkpoints) {
        const snapshot = buildSnapshot(scenario.events, checkpoint.at, checkpoint.delay ?? 0);
        expect(
          checkpoint.verify(snapshot),
          `${scenario.name} / ${checkpoint.title} @ ${checkpoint.at}s delay ${checkpoint.delay ?? 0}s`,
        ).toBe(true);
      }
    }
  });

  it('核对点覆盖了迟到、重复、乱序、确认后与相邻边界', () => {
    const lateReasons = new Set(
      buildSnapshot(late, 5).audit.map((record) => record.reason).filter(Boolean),
    );
    expect(lateReasons).toContain('stale-revision');
    expect(lateReasons).toContain('duplicate-event');
    expect(lateReasons).toContain('after-final');
  });

  it('时间轴刻度与前后投递', () => {
    const arrivals = late.map((event) => event.arrival);
    expect(nextArrival(late, 0)).toBe(Math.min(...arrivals));
    expect(nextArrival(late, 2.4)).toBe(2.9);
    expect(previousArrival(late, 2.4)).toBe(1.8);
    expect(previousArrival(late, 0)).toBeNull();
    expect(timelineEnd(late)).toBe(9);
  });
});

describe('JSON 导入校验', () => {
  const valid: CaptionEvent = {
    id: 'a',
    captionId: 'c',
    seq: 1,
    kind: 'revision',
    text: '你好',
    mediaStart: 0,
    mediaEnd: 1,
    arrival: 0,
  };

  it('接受数组和带 name 的对象', () => {
    expect(parseCaptionEvents([valid]).ok).toBe(true);
    const wrapped = parseCaptionEvents({ name: '现场', events: [valid] });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.name).toBe('现场');
  });

  it('逐条列出错误', () => {
    const result = parseCaptionEvents([
      { ...valid, seq: 0 },
      { ...valid, id: '' },
      { ...valid, mediaEnd: -1 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('坏 JSON 返回可读错误', () => {
    const result = parseCaptionEventsText('{oops');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('JSON 解析失败');
  });
});
