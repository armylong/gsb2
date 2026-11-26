import type { ClickEvent, ClickKind, Marker, Project } from './types';
import { Timeline, barQuarters, roundQ } from './timeline';
import { mixInto, renderClick, softLimit, CLICK_DURATION } from './synth';

export interface ExportOptions {
  sampleRate: number;
  /** 框选的小节下标, 两端都含 */
  barFrom: number;
  barTo: number;
  /** 是否在选区前加一小节预备拍 */
  countIn: boolean;
}

export interface PlannedHit {
  q: number;
  /** 相对文件零点的秒数 (含预备拍平移); 预备拍自身为负值坐标平移后的正值 */
  tInFile: number;
  sample: number;
  kind: ClickKind;
  inCountIn: boolean;
  beatInBar: number;
  barIndex: number;
}

export interface ExportPlan {
  qFrom: number;
  qTo: number;
  /** 预备拍时长 (秒), 0 表示没有 */
  countInDuration: number;
  /** 选区本身时长, 不含预备拍与尾部 */
  selectionDuration: number;
  totalDuration: number;
  hits: PlannedHit[];
  markers: Marker[];
}

/** 只做时间规划, 不渲染音频; 导出前在界面上展示零点/段首/末拍用 */
export function planExport(timeline: Timeline, project: Project, opts: ExportOptions): ExportPlan {
  const bars = timeline.bars;
  if (opts.barFrom < 0 || opts.barTo >= bars.length || opts.barFrom > opts.barTo) {
    throw new Error('导出小节范围无效');
  }
  const firstBar = bars[opts.barFrom];
  const lastBar = bars[opts.barTo];
  const qFrom = firstBar.qStart;
  const qTo = lastBar.qEnd;

  const span0 = timeline.spans[firstBar.segmentIndex];
  const bpm0 = span0.segment.mode === 'ramp' ? span0.segment.bpmStart : span0.segment.bpmStart;
  const countLen = opts.countIn ? barQuarters(firstBar.meter) : 0;
  const countInDuration = (countLen * 60) / bpm0;

  const tSelFrom = timeline.qToTime(qFrom);
  const tSelTo = timeline.qToTime(qTo);
  const selectionDuration = tSelTo - tSelFrom;
  const totalDuration = countInDuration + selectionDuration;

  // 选区内事件: 严格排除 qTo 上的边界拍 (它属于下一区域, 不能多发)
  const eps = 1e-9;
  const inner = timeline.buildEvents(qFrom, qTo).filter((e) => e.q < qTo - eps);
  if (!project.settings.playSubdivisions) {
    inner.splice(0, inner.length, ...inner.filter((e) => e.kind !== 'sub'));
  }

  const hits: PlannedHit[] = [];
  const countHits: ClickEvent[] = [];
  if (opts.countIn) {
    // 预备拍只排整拍 (预备小节的作用是给进入速度, 不加分拍)
    const countLen2 = countLen;
    for (let k = 0; k < countLen2; k++) {
      const vq = qFrom - countLen2 + k;
      countHits.push({
        q: roundQ(vq),
        t: 0,
        kind: k === 0 ? 'downbeat' : 'beat',
        segmentId: span0.segment.id,
        barIndex: -1,
        beatInBar: k + 1,
        isSegmentStart: false,
        isPickup: false,
        parentBeatQ: roundQ(vq),
      });
    }
  }

  for (const e of countHits) {
    const tRel = ((e.q - qFrom) * 60) / bpm0; // 负值
    const tInFile = countInDuration + tRel;
    hits.push({
      q: e.q,
      tInFile,
      sample: Math.round(tInFile * opts.sampleRate),
      kind: e.kind,
      inCountIn: true,
      beatInBar: e.beatInBar,
      barIndex: -1,
    });
  }
  for (const e of inner) {
    const tInFile = countInDuration + (e.t - tSelFrom);
    hits.push({
      q: e.q,
      tInFile,
      sample: Math.round(tInFile * opts.sampleRate),
      kind: e.kind,
      inCountIn: false,
      beatInBar: e.beatInBar,
      barIndex: e.barIndex,
    });
  }
  hits.sort((a, b) => a.sample - b.sample);

  const markers: Marker[] = [];
  markers.push({ q: qFrom, t: countInDuration, label: '文件零点 / 选区首拍', kind: 'zero' });
  if (opts.countIn) {
    markers.push({ q: qFrom - countLen, t: 0, label: '预备拍开始', kind: 'count-in' });
  }
  for (const span of timeline.spans) {
    if (span.qStart > qFrom + eps && span.qStart < qTo - eps) {
      markers.push({
        q: span.qStart,
        t: countInDuration + (timeline.qToTime(span.qStart) - tSelFrom),
        label: '新段首拍',
        kind: 'segment-start',
      });
    }
  }
  const lastWhole = [...inner].reverse().find((e) => e.kind !== 'sub');
  if (lastWhole) {
    markers.push({
      q: lastWhole.q,
      t: countInDuration + (lastWhole.t - tSelFrom),
      label: '最后一拍',
      kind: 'last-beat',
    });
  }
  markers.push({ q: qTo, t: totalDuration, label: '选区结束 (静音边界, 不发声)', kind: 'selection-end' });

  return { qFrom, qTo, countInDuration, selectionDuration, totalDuration, hits, markers };
}

export interface RenderedExport {
  pcm: Float32Array;
  plan: ExportPlan;
  sampleRate: number;
  /** 尾部留白长度 (秒), 保证最后一响衰减不被截断 */
  tailDuration: number;
}

/** 离线渲染整段 WAV 的 PCM。与实时试听共用 renderClick, 采样逐点一致。 */
export function renderExport(timeline: Timeline, project: Project, opts: ExportOptions): RenderedExport {
  const plan = planExport(timeline, project, opts);
  const tailDuration = CLICK_DURATION.downbeat;
  const totalSamples = Math.ceil((plan.totalDuration + tailDuration) * opts.sampleRate);
  const pcm = new Float32Array(totalSamples);

  const cache = new Map<string, Float32Array>();
  const clickFor = (kind: ClickKind): Float32Array => {
    const voice = project.settings.voices[kind];
    const key = `${kind}:${voice.timbre}:${voice.pitch}`;
    let buf = cache.get(key);
    if (!buf) {
      buf = renderClick(voice, kind, opts.sampleRate);
      cache.set(key, buf);
    }
    return buf;
  };

  for (const hit of plan.hits) {
    const voice = project.settings.voices[hit.kind];
    mixInto(pcm, clickFor(hit.kind), hit.sample, voice.volume);
  }
  softLimit(pcm);
  return { pcm, plan, sampleRate: opts.sampleRate, tailDuration };
}
