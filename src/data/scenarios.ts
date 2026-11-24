import type { CaptionEvent, Checkpoint, ReplaySnapshot, Scenario } from '../lib/types';
import { buildWebVtt, cueBoundaryIssues } from '../lib/webvtt';

const event = (value: CaptionEvent): CaptionEvent => value;

const lateUpdates: CaptionEvent[] = [
  event({
    id: 'late-1',
    captionId: 'cap-101',
    seq: 1,
    kind: 'revision',
    text: '我们先测一下本地字幕的延迟。',
    mediaStart: 2,
    mediaEnd: 6,
    arrival: 1,
    note: '首版到达',
  }),
  event({
    id: 'late-2',
    captionId: 'cap-101',
    seq: 2,
    kind: 'revision',
    text: '我们先测一下本地字幕的显示延迟。',
    mediaStart: 2,
    mediaEnd: 6,
    arrival: 1.8,
    note: '修正措辞',
  }),
  event({
    id: 'late-1-stale',
    captionId: 'cap-101',
    seq: 1,
    kind: 'revision',
    text: '我们先测一下本地字幕延时。',
    mediaStart: 2,
    mediaEnd: 6,
    arrival: 2.4,
    note: '序号更旧的修订迟到 0.6 秒',
  }),
  event({
    id: 'late-2',
    captionId: 'cap-101',
    seq: 2,
    kind: 'revision',
    text: '我们先测一下本地字幕的显示延迟。',
    mediaStart: 2,
    mediaEnd: 6,
    arrival: 2.9,
    note: '网络重试：同一事件再次到达',
  }),
  event({
    id: 'late-3-conflict',
    captionId: 'cap-101',
    seq: 2,
    kind: 'revision',
    text: '同序号但内容不同的一次重发。',
    mediaStart: 2,
    mediaEnd: 6,
    arrival: 3.3,
    note: '同序号冲突，不能覆盖已生效文本',
  }),
  event({
    id: 'late-3-final',
    captionId: 'cap-101',
    seq: 3,
    kind: 'final',
    text: '',
    mediaStart: 2,
    mediaEnd: 6,
    arrival: 3.8,
    note: '结束标记：正文沿用 seq2，并锁定导出',
  }),
  event({
    id: 'late-4-after',
    captionId: 'cap-101',
    seq: 4,
    kind: 'revision',
    text: '确认之后补发的修订，不应再上屏或入档。',
    mediaStart: 2,
    mediaEnd: 6,
    arrival: 4.6,
    note: '确认后到达，必须拒绝',
  }),
];

function singleCue(snapshot: ReplaySnapshot, expectedText: string): boolean {
  const build = buildWebVtt(snapshot.confirmed);
  return (
    build.exported.length === 1 &&
    build.exported[0].text === expectedText &&
    build.exported[0].start === 2 &&
    build.exported[0].end === 6 &&
    build.vtt.includes('00:00:02.000 --> 00:00:06.000')
  );
}

const lateUpdateCheckpoints: Checkpoint[] = [
  {
    id: 'late-waiting',
    at: 0.6,
    title: '还没收到任何投递',
    detail: '画面为空，台账里全部是“未到达”；播放不会预支未来的版本。',
    verify: (snapshot) =>
      snapshot.stats.receivedCount === 0 &&
      snapshot.stats.pendingCount === lateUpdates.length &&
      snapshot.screen.length === 0,
  },
  {
    id: 'late-received-not-onscreen',
    at: 1.5,
    title: '首版已收到，但还未进画面',
    detail: '媒体时间只到 1.5s，首句从 2.0s 才开始。字幕状态为“未进画面”，屏幕保持干净。',
    verify: (snapshot) =>
      snapshot.stats.acceptedCount === 1 &&
      snapshot.screen.length === 0 &&
      snapshot.captions[0]?.window === 'upcoming',
  },
  {
    id: 'late-revision',
    at: 2,
    title: 'seq2 修正已生效',
    detail: 'seq2 在 1.8s 到达，2.0s 时屏幕上应是“显示延迟”的版本。',
    verify: (snapshot) =>
      snapshot.screen.length === 1 &&
      snapshot.screen[0].seq === 2 &&
      snapshot.screen[0].text === '我们先测一下本地字幕的显示延迟。',
  },
  {
    id: 'late-stale',
    at: 2.5,
    title: '旧修订迟到，被拒绝',
    detail: 'seq1 在 2.4s 到达，比已生效的 seq2 旧，不能把屏幕改回去。',
    verify: (snapshot) =>
      snapshot.stats.rejectedCount === 1 &&
      snapshot.screen[0]?.seq === 2 &&
      snapshot.audit.some(
        (record) => record.event.id === 'late-1-stale' && record.reason === 'stale-revision',
      ),
  },
  {
    id: 'late-duplicate-event',
    at: 3,
    title: '同一事件重试，只记一次结果',
    detail: 'late-2 再次到达时按事件 id 判为重复投递，不产生第二个修订版本。',
    verify: (snapshot) =>
      snapshot.stats.rejectedCount === 2 &&
      snapshot.audit.filter((record) => record.event.id === 'late-2' && record.received).length ===
        2 &&
      snapshot.audit.filter(
        (record) => record.event.id === 'late-2' && record.verdict === 'accepted',
      ).length === 1,
  },
  {
    id: 'late-conflict',
    at: 3.5,
    title: '同序号冲突，保留已生效文本',
    detail: '新事件换了个 id 却带相同的 seq2 和不同正文，作为冲突拒绝。',
    verify: (snapshot) =>
      snapshot.stats.rejectedCount === 3 &&
      snapshot.screen[0]?.text === '我们先测一下本地字幕的显示延迟。' &&
      snapshot.audit.some(
        (record) => record.event.id === 'late-3-conflict' && record.reason === 'duplicate-revision',
      ),
  },
  {
    id: 'late-final',
    at: 4,
    title: '结束标记确认，导出边界成型',
    detail: '结束标记沿用 seq2 正文，导出只有一条 [00:00:02.000, 00:00:06.000] 的 cue。',
    verify: (snapshot) =>
      snapshot.confirmed.length === 1 &&
      snapshot.captions[0]?.final === true &&
      singleCue(snapshot, '我们先测一下本地字幕的显示延迟。'),
  },
  {
    id: 'late-after-final',
    at: 5,
    title: '确认后的修订不再生效',
    detail: '4.6s 到达的 seq4 被拒绝；导出仍是一条 cue，文本与边界都不变。',
    verify: (snapshot) =>
      snapshot.stats.rejectedCount === 4 &&
      snapshot.audit.some(
        (record) => record.event.id === 'late-4-after' && record.reason === 'after-final',
      ) &&
      singleCue(snapshot, '我们先测一下本地字幕的显示延迟。'),
  },
];

const adjacentPair: CaptionEvent[] = [
  event({
    id: 'adj-1',
    captionId: 'cap-201',
    seq: 1,
    kind: 'revision',
    text: '第一句：会议在十点开始。',
    mediaStart: 4,
    mediaEnd: 7,
    arrival: 2,
    note: '第一句首版',
  }),
  event({
    id: 'adj-2',
    captionId: 'cap-202',
    seq: 1,
    kind: 'revision',
    text: '第二句：请大家提前五分钟到场。',
    mediaStart: 7,
    mediaEnd: 11,
    arrival: 4.2,
    note: '第二句首版，与第一句首尾相接',
  }),
  event({
    id: 'adj-3',
    captionId: 'cap-201',
    seq: 2,
    kind: 'revision',
    text: '第一句：会议在十点整开始。',
    mediaStart: 4,
    mediaEnd: 7,
    arrival: 7.2,
    note: '首句修正迟到，此时第二句已在屏幕上',
  }),
  event({
    id: 'adj-4',
    captionId: 'cap-202',
    seq: 2,
    kind: 'revision',
    text: '第二句：请大家提前五分钟到会场。',
    mediaStart: 7,
    mediaEnd: 11,
    arrival: 8.4,
    note: '第二句修正',
  }),
  event({
    id: 'adj-4',
    captionId: 'cap-202',
    seq: 2,
    kind: 'revision',
    text: '第二句：请大家提前五分钟到会场。',
    mediaStart: 7,
    mediaEnd: 11,
    arrival: 8.8,
    note: '第二句同一事件重发',
  }),
  event({
    id: 'adj-5-final',
    captionId: 'cap-202',
    seq: 3,
    kind: 'final',
    text: '',
    mediaStart: 7,
    mediaEnd: 11,
    arrival: 9.6,
    note: '第二句确认，正文沿用 seq2',
  }),
  event({
    id: 'adj-5-stale',
    captionId: 'cap-202',
    seq: 2,
    kind: 'revision',
    text: '确认后迟到的旧修订。',
    mediaStart: 7,
    mediaEnd: 11,
    arrival: 10.2,
    note: '确认后到达，拒绝',
  }),
  event({
    id: 'adj-6-final',
    captionId: 'cap-201',
    seq: 3,
    kind: 'final',
    text: '第一句：会议在十点整开始。',
    mediaStart: 4,
    mediaEnd: 7,
    arrival: 10.8,
    note: '第一句确认',
  }),
  event({
    id: 'adj-7-after',
    captionId: 'cap-201',
    seq: 4,
    kind: 'revision',
    text: '第一句确认后的修补。',
    mediaStart: 4,
    mediaEnd: 7,
    arrival: 12,
    note: '确认后到达，拒绝',
  }),
];

const adjacentCheckpoints: Checkpoint[] = [
  {
    id: 'adj-first-only',
    at: 5,
    title: '第一句在屏，第二句尚未进画面',
    detail: '第二句 4.2s 已收到，但媒体区间从 7.0s 开始；屏幕仍只显示第一句。',
    verify: (snapshot) =>
      snapshot.screen.length === 1 &&
      snapshot.screen[0].captionId === 'cap-201' &&
      snapshot.screen[0].seq === 1 &&
      snapshot.captions.find((caption) => caption.captionId === 'cap-202')?.window ===
        'upcoming',
  },
  {
    id: 'adj-boundary',
    at: 7.5,
    title: '跨过 7.0s 边界，切到第二句',
    detail: '第一句离开画面，第二句进屏。首句 7.2s 的修正已接收，但它的媒体区间已过，零延迟下再也上不了屏。',
    verify: (snapshot) =>
      snapshot.screen.length === 1 &&
      snapshot.screen[0].captionId === 'cap-202' &&
      snapshot.captions.find((caption) => caption.captionId === 'cap-201')?.accepted?.seq === 2,
  },
  {
    id: 'adj-delay',
    at: 7.5,
    delay: 2,
    title: '延迟 2s：第一句仍留在画面',
    detail: '呈现时钟为 5.5s，观众还在看第一句，而且 7.2s 才到的修正已经补了进来——这正是显示延迟的缓冲作用。',
    verify: (snapshot) =>
      snapshot.presentationTime === 5.5 &&
      snapshot.screen.length === 1 &&
      snapshot.screen[0].captionId === 'cap-201' &&
      snapshot.screen[0].seq === 2 &&
      snapshot.screen[0].text === '第一句：会议在十点整开始。',
  },
  {
    id: 'adj-second-revised',
    at: 8.6,
    title: '第二句修正上屏',
    detail: '8.4s 到达的 seq2 已生效；同事件在 8.8s 的重发还没到。',
    verify: (snapshot) =>
      snapshot.screen.length === 1 &&
      snapshot.screen[0].seq === 2 &&
      snapshot.screen[0].text === '第二句：请大家提前五分钟到会场。',
  },
  {
    id: 'adj-second-final',
    at: 9.8,
    title: '第二句确认，先占一条导出',
    detail: '第二句 9.6s 确认；第一句尚未确认，导出暂时只有一条 cue。',
    verify: (snapshot) =>
      buildWebVtt(snapshot.confirmed).exported.length === 1 &&
      snapshot.confirmed[0]?.captionId === 'cap-202',
  },
  {
    id: 'adj-export-boundary',
    at: 11,
    title: '两句都确认，导出边界首尾相接',
    detail: '第一句 [4.0, 7.0]、第二句 [7.0, 11.0]，两条 cue 在 7.0s 精确相接，无重叠。',
    verify: (snapshot) => {
      const build = buildWebVtt(snapshot.confirmed);
      return (
        build.exported.length === 2 &&
        build.exported[0].captionId === 'cap-201' &&
        build.exported[0].end === 7 &&
        build.exported[1].captionId === 'cap-202' &&
        build.exported[1].start === 7 &&
        cueBoundaryIssues(snapshot.confirmed).length === 0 &&
        (build.vtt.match(/-->/g) ?? []).length === 2
      );
    },
  },
  {
    id: 'adj-after-final',
    at: 12.5,
    title: '确认后重发仍只有两条 cue',
    detail: '两个确认后的修订都被拒绝，文件里不会出现同一句的第二条记录。',
    verify: (snapshot) => {
      const build = buildWebVtt(snapshot.confirmed);
      return (
        build.exported.length === 2 &&
        !build.vtt.includes('确认后') &&
        snapshot.stats.rejectedCount === 3 &&
        snapshot.audit
          .filter((record) => record.verdict === 'rejected')
          .every((record) => record.reason === 'duplicate-event' || record.reason === 'after-final')
      );
    },
  },
];

export const BUILT_IN_SCENARIOS: Scenario[] = [
  {
    id: 'late-updates',
    name: '迟到更新',
    kicker: '样例 A',
    description:
      '单句字幕在 4.6s 内经历首版、修正、旧修订迟到、重复事件、同序号冲突和确认。重点核对“后到的旧版本不覆盖已生效版本”。',
    events: lateUpdates,
    checkpoints: lateUpdateCheckpoints,
  },
  {
    id: 'adjacent-pair',
    name: '两句相邻',
    kicker: '样例 B',
    description:
      '第一句 [4.0, 7.0] 与第二句 [7.0, 11.0] 首尾相接。重点核对切句瞬间的画面、2 秒显示延迟下的回看，以及两条 cue 的导出边界。',
    events: adjacentPair,
    checkpoints: adjacentCheckpoints,
  },
];
