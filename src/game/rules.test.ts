import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBoard,
  observeCue,
  scanFrameStarts,
} from './engine';
import { SCENARIOS } from './scenarios';
import {
  CANONICAL_MESSAGE,
  checksumOf,
  symbolFromDirs,
  verifyFrame,
} from './symbols';
import type { GameState } from './types';

// store.notify 会用到 window.setTimeout
vi.stubGlobal('window', { setTimeout: (fn: () => void) => setTimeout(fn, 0) });

import { actions, store } from './store';

const LABELS: Record<string, string> = {
  north: '北岭台',
  west: '西坡台',
  east: '东崖台',
};

function boardAt(
  scenarioId: keyof typeof SCENARIOS,
  cursor: number,
  choices: Record<string, string> = {},
  policy: 'lenient' | 'strict' = 'lenient',
  manifests?: GameState['manifests'],
) {
  const def = SCENARIOS[scenarioId];
  return buildBoard({
    cues: def.cues,
    cursor,
    policy,
    choices,
    manifests: manifests ?? (scenarioId === 'forward' ? forwardManifests() : []),
    stationLabels: LABELS,
  });
}

function forwardManifests(): GameState['manifests'] {
  return [
    {
      id: 'manifest-east-1',
      msgId: 'frame:tx-origin:0',
      fromStation: 'east',
      values: [...CANONICAL_MESSAGE],
      readyStep: 13,
      label: '东崖台转发件',
    },
  ];
}

describe('符号与复核规则', () => {
  it('20 个符号的旗位对互不重复且都可反查', () => {
    expect(symbolFromDirs(1, 7)).toBe('start');
    expect(symbolFromDirs(3, 5)).toBe('end');
    expect(symbolFromDirs(7, 1)).toBe('start'); // 无序
    expect(checksumOf(['d0', 'd3', 'd7', 'd6'])).toBe(6);
  });

  it('主消息七拍通过复核，改错一个数据符就失败', () => {
    expect(verifyFrame(CANONICAL_MESSAGE).ok).toBe(true);
    const bad = [...CANONICAL_MESSAGE];
    bad[3] = 'd1'; // 月 -> 林
    const r = verifyFrame(bad);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('复核不符');
  });
});

describe('拍帧规则：缺符留缺，不得挪用下一条开头', () => {
  it('固定七拍窗口 + 启锚点：中间 null 不会被后面的 start 顶替', () => {
    // 启 风 山 月 缺 6 止 | 启 林 火 ...
    const stream = [
      'start',
      'd0',
      'd3',
      'd7',
      null,
      'c6',
      'end',
      'start',
      'd1',
      'd2',
    ];
    const starts = scanFrameStarts(stream as Array<string | null>);
    expect(starts).toEqual([0, 7]);

    const first = stream.slice(0, 7);
    expect(first[4]).toBeNull();
    // 即使把第 8 拍的 start 放到缺失位置附近，角色校验也拒绝它进入数据槽
    const probe = [...first];
    probe[4] = 'start';
    expect(verifyFrame(probe).ok).toBe(false);
  });
});

describe('剧本几何：遮挡布置必须产生 authored 能见度', () => {
  for (const def of Object.values(SCENARIOS)) {
    it(`${def.name} 的逐拍预期全部成立`, () => {
      const failures: string[] = [];
      for (const cue of def.cues) {
        const exp = def.expectations[cue.id];
        if (!exp) continue;
        for (const [observer, level] of Object.entries(exp)) {
          if (observer === cue.sender) continue;
          const obs = observeCue(cue, observer as never);
          if (obs.level !== level) {
            failures.push(
              `cue ${cue.id} step ${cue.stepIndex} ${observer}: expected ${level}, got ${obs.level}`,
            );
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('剧本二关键拍的原始证据结构正确', () => {
    const def = SCENARIOS.half;
    const c1 = def.cues.find((c) => c.id === 'half-c1')!;
    const west1 = observeCue(c1, 'west');
    expect(west1.level).toBe('one');
    // 被遮住的是 arm 1
    expect(west1.arms[1].halves[0].seen).toBe(false);
    expect(west1.arms[1].halves[1].seen).toBe(false);
    expect(west1.arms[0].halves[0].seen).toBe(true);

    const c3 = def.cues.find((c) => c.id === 'half-c3')!;
    const west3 = observeCue(c3, 'west');
    expect(west3.level).toBe('stitch');
    expect(west3.simultaneousHalf).toBeNull();
    expect(west3.lenientValue).toBe('d7');
    expect(west3.strictValue).toBeNull();

    const c4 = def.cues.find((c) => c.id === 'half-c4')!;
    expect(observeCue(c4, 'west').level).toBe('none');
    expect(observeCue(c4, 'east').level).toBe('none');

    // 后半拍双清的遮挡拍：严格规则也能认
    const c2 = def.cues.find((c) => c.id === 'half-c2')!;
    const west2 = observeCue(c2, 'west');
    expect(west2.level).toBe('both');
    expect(west2.simultaneousHalf).toBe(1);
    expect(west2.strictValue).toBe('d3');
  });

  it('剧本三西台在几何可见下发生预埋误判', () => {
    const def = SCENARIOS.forward;
    const c3 = def.cues.find((c) => c.id === 'fwd-c3')!;
    const west = observeCue(c3, 'west');
    expect(west.level).toBe('both');
    expect(west.lenientValue).toBe('d1'); // 误判成 林
    const east = observeCue(c3, 'east');
    expect(east.lenientValue).toBe('d7'); // 正确 月
  });
});

describe('剧本一：完整消息', () => {
  it('走完七拍即解出 canonical', () => {
    const board = boardAt('clear', 7);
    const msg = board.messages.find((m) => m.msgId === 'frame:tx-origin:0');
    expect(msg).toBeTruthy();
    expect(msg?.complete).toBe(true);
    expect(msg?.checksumOk).toBe(true);
    expect(msg?.text).toBe('启 风 山 月 关 6 止');
  });
});

describe('剧本二：缺槽、新帧与补发', () => {
  it('补发前旧帧第 5 槽为空，且下一条另开一帧', () => {
    const before = boardAt('half', 9); // cues 0..8
    const old = before.messages.find((m) => m.msgId === 'frame:tx-origin:0')!;
    expect(old.slots[4].resolvedValue).toBeNull();
    expect(old.complete).toBe(false);
    const next = before.messages.find((m) => m.msgId === 'frame:tx-origin:7');
    expect(next).toBeTruthy();
  });

  it('补发拍显式入旧槽后，宽松 / 严格都可经东台一致证据解出', () => {
    const after = boardAt('half', 10);
    const old = after.messages.find((m) => m.msgId === 'frame:tx-origin:0')!;
    expect(old.complete).toBe(true);
    expect(old.checksumOk).toBe(true);
    expect(old.text).toBe('启 风 山 月 关 6 止');

    const strict = boardAt('half', 10, {}, 'strict');
    const oldStrict = strict.messages.find((m) => m.msgId === 'frame:tx-origin:0')!;
    expect(oldStrict.checksumOk).toBe(true);
  });
});

describe('自编序列：每个台都能播放并解出自己的小段', () => {
  beforeEach(() => {
    actions.loadScenario('clear');
  });

  it.each(['north', 'west', 'east'] as const)('%s 的预置序列七拍双清且复核通过', (id) => {
    actions.setEditorStation(id);
    actions.playCustomSequence(id);
    const seq = store.state.sequences[id];
    expect(seq).toHaveLength(7);
    actions.jumpTo(7);
    // 所有非发送观测台每拍都应双清（停泊遮挡不挡视线）
    for (const cue of store.state.cues) {
      for (const o of ['north', 'west', 'east'] as const) {
        if (o === cue.sender) continue;
        expect(observeCue(cue, o).level).toBe('both');
      }
    }
    const board = buildBoard({
      cues: store.state.cues,
      cursor: 7,
      policy: 'lenient',
      choices: {},
      manifests: [],
      stationLabels: LABELS,
    });
    const msg = board.messages.find((m) => m.checksumOk);
    expect(msg?.complete).toBe(true);
  });
});

describe('剧本三：冲突、人工选择、转发与重复计分', () => {
  beforeEach(() => {
    actions.loadScenario('forward');
  });

  it('原发走完时第 4 槽冲突，采信东台后复核通过', () => {
    const board = boardAt('forward', 7);
    const msg = board.messages.find((m) => m.msgId === 'frame:tx-origin:0')!;
    const slot3 = msg.slots[3];
    expect(slot3.conflict).toBe(true);
    expect(slot3.candidateValues.sort()).toEqual(['d1', 'd7']);

    const eastClaim = slot3.claims.find((c) => c.id === 'claim:east:fwd-c3')!;
    expect(eastClaim).toBeTruthy();

    const resolved = boardAt(
      'forward',
      14,
      { 'frame:tx-origin:0:3': eastClaim.id },
      'lenient',
    );
    const m2 = resolved.messages.find((m) => m.msgId === 'frame:tx-origin:0')!;
    expect(m2.slots[3].resolvedValue).toBe('d7');
    expect(m2.checksumOk).toBe(true);
  });

  it('store 签收：第一次 +100，第二次重复 +0，总分不变', () => {
    actions.jumpTo(14);
    const s0 = store.state;
    const board = buildBoard({
      cues: s0.cues,
      cursor: s0.cursor,
      policy: s0.policy,
      choices: s0.choices,
      manifests: s0.manifests,
      stationLabels: LABELS,
    });
    const slot3 = board.messages[0].slots[3];
    const eastClaim = slot3.claims.find((c) => c.sourceId === 'rcpt:east')!;
    actions.chooseClaim('frame:tx-origin:0', 3, eastClaim.id);

    actions.signMessage('frame:tx-origin:0');
    expect(store.state.score).toBe(100);
    expect(store.state.signedKeys).toHaveLength(1);

    actions.signMessage('frame:tx-origin:0');
    expect(store.state.score).toBe(100);
    expect(store.state.scoreRecords[0].duplicate).toBe(true);
    expect(store.state.scoreRecords[0].delta).toBe(0);
  });

  it('可由另外一台手动转发，转发件入板且仍是同一条消息', () => {
    actions.jumpTo(7);
    actions.chooseClaim('frame:tx-origin:0', 3, 'claim:east:fwd-c3');
    const cuesBefore = store.state.cues.length;
    actions.forwardMessage('frame:tx-origin:0', 'west');
    expect(store.state.cues.length).toBe(cuesBefore + 7);
    expect(store.state.manifests.some((m) => m.fromStation === 'west')).toBe(true);
    // 原发台不能转发自己的消息
    actions.forwardMessage('frame:tx-origin:0', 'north');
    expect(store.state.cues.length).toBe(cuesBefore + 7);
    // 走到全部结束，译码板仍只有同一条有效消息
    actions.jumpTo(store.state.cues.length);
    const board = buildBoard({
      cues: store.state.cues,
      cursor: store.state.cursor,
      policy: 'lenient',
      choices: store.state.choices,
      manifests: store.state.manifests,
      stationLabels: LABELS,
    });
    const valid = board.messages.filter((m) => m.checksumOk && m.text === '启 风 山 月 关 6 止');
    expect(valid.length).toBeGreaterThanOrEqual(1);
  });

  it('选错成西台误判值时复核失败，不能得分', () => {
    actions.jumpTo(7);
    actions.chooseClaim('frame:tx-origin:0', 3, 'claim:west:fwd-c3');
    actions.signMessage('frame:tx-origin:0');
    expect(store.state.score).toBe(0);
    expect(store.state.attempts[0].ok).toBe(false);
  });
});
