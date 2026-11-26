import { describe, expect, it } from 'vitest';
import { createExampleProject } from './project';
import { planExport, renderExport } from './render';
import { Timeline } from './timeline';
import { encodeWav, parseWavHeader } from './wav';
import { renderClick } from './synth';

const SR = 48000;
const project = createExampleProject();
const tl = new Timeline(project);

describe('导出规划: 零点 / 段首 / 末拍 / 边界拍', () => {
  it('无预备拍: 第一拍在文件零点 (sample 0), 最后一个发声点不是选区结束边界', () => {
    const plan = planExport(tl, project, { sampleRate: SR, barFrom: 1, barTo: 4, countIn: false });
    expect(plan.countInDuration).toBe(0);
    expect(plan.hits[0].sample).toBe(0);
    expect(plan.hits[0].kind).toBe('downbeat');
    const last = plan.hits[plan.hits.length - 1];
    const lastBar = tl.bars[4];
    expect(last.q).toBeLessThan(lastBar.qEnd);
    expect(plan.hits.some((h) => h.q >= lastBar.qEnd)).toBe(false);

    const zero = plan.markers.find((m) => m.kind === 'zero')!;
    expect(zero.t).toBe(0);
    const end = plan.markers.find((m) => m.kind === 'selection-end')!;
    expect(end.t).toBeCloseTo(plan.selectionDuration, 12);
    const lastBeat = plan.markers.find((m) => m.kind === 'last-beat')!;
    expect(lastBeat.t).toBeGreaterThan(0);
    expect(lastBeat.t).toBeLessThan(end.t);
  });

  it('含预备拍: 预备拍在前, 选区首拍平移到预备小节结束处, 段首标记同步平移', () => {
    const plan = planExport(tl, project, { sampleRate: SR, barFrom: 3, barTo: 5, countIn: true });
    const firstBar = tl.bars[3]; // 5/4 第一小节
    const countDur = (5 * 60) / 132;
    expect(plan.countInDuration).toBeCloseTo(countDur, 12);

    const countHits = plan.hits.filter((h) => h.inCountIn);
    expect(countHits.length).toBe(5); // 预备拍只排整拍
    expect(countHits[0].kind).toBe('downbeat');
    expect(countHits.slice(1).every((h) => h.kind === 'beat')).toBe(true);
    const firstInner = plan.hits.find((h) => !h.inCountIn)!;
    expect(firstInner.q).toBe(firstBar.qStart);
    expect(firstInner.sample).toBe(Math.round(countDur * SR));
    expect(firstInner.kind).toBe('downbeat');

    const zero = plan.markers.find((m) => m.kind === 'zero')!;
    expect(zero.t).toBeCloseTo(countDur, 12);
  });

  it('每个发声点的采样位置 = 时间戳 * 采样率 (四舍五入), 可逐点核对', () => {
    const plan = planExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 7, countIn: false });
    for (const h of plan.hits) {
      expect(h.sample).toBe(Math.round(h.tInFile * SR));
    }
  });

  it('新段首拍标记落在段边界 q 上, 且该点确实有 downbeat 发声', () => {
    const plan = planExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 7, countIn: false });
    const segMarkers = plan.markers.filter((m) => m.kind === 'segment-start');
    const segQs = segMarkers.map((m) => m.q);
    expect(segQs).toContain(7);
    expect(segQs).toContain(17);
    for (const m of segMarkers) {
      const hit = plan.hits.find((h) => Math.abs(h.tInFile - m.t) < 1e-9);
      expect(hit?.kind).toBe('downbeat');
    }
  });

  it('关闭分拍后导出中没有 sub 事件, 整拍采样位置不变', () => {
    const withSub = planExport(tl, project, { sampleRate: SR, barFrom: 1, barTo: 3, countIn: false });
    const noSubProject = structuredClone(project);
    noSubProject.settings.playSubdivisions = false;
    const noSub = planExport(tl, noSubProject, { sampleRate: SR, barFrom: 1, barTo: 3, countIn: false });
    expect(noSub.hits.every((h) => h.kind !== 'sub')).toBe(true);
    const a = withSub.hits.filter((h) => h.kind !== 'sub').map((h) => h.sample);
    const b = noSub.hits.map((h) => h.sample);
    expect(a).toEqual(b);
  });
});

describe('离线渲染与 WAV', () => {
  it('PCM 在每个计划采样点出现能量, 发声前保持静音', () => {
    const { pcm, plan } = renderExport(tl, project, {
      sampleRate: SR,
      barFrom: 1,
      barTo: 2,
      countIn: false,
    });
    for (const h of plan.hits) {
      // 正弦在 i=0 恰好过零, 用偏移 1 的采样判定; 发声点前 4 个采样必须静音
      if (h.sample >= 4) {
        for (let k = 4; k >= 1; k--) expect(pcm[h.sample - k]).toBe(0);
      }
      expect(pcm[h.sample + 1]).not.toBe(0);
    }
    // 总长度覆盖到最后一响衰减 + 尾部
    const lastSample = plan.hits[plan.hits.length - 1].sample;
    expect(pcm.length).toBeGreaterThan(lastSample + 100);
  });

  it('导出的点击与试听 renderClick 是同一份采样 (试听即导出)', () => {
    const voice = project.settings.voices.beat;
    const pcm = renderClick(voice, 'beat', SR);
    // 选一个独立小节的整拍 (bar 1 = 3/4 满小节), 避免与其他发声点衰减重叠
    const { pcm: mix, plan } = renderExport(tl, project, {
      sampleRate: SR,
      barFrom: 1,
      barTo: 1,
      countIn: false,
    });
    const beatHit = plan.hits.find(
      (h) => h.kind === 'beat' && !h.inCountIn && h.beatInBar === 2,
    )!;
    // 与相邻发声点间隔足够远的区段内, 混音应严格等于该点击 * 音量
    for (let i = 0; i < pcm.length - 200; i++) {
      expect(mix[beatHit.sample + i]).toBeCloseTo(pcm[i] * voice.volume, 6);
    }
  });

  it('音量为 0 的声部不发声, 其他声部位置不变', () => {
    const muted = structuredClone(project);
    muted.settings.voices.sub.volume = 0;
    const { pcm, plan } = renderExport(tl, muted, { sampleRate: SR, barFrom: 1, barTo: 2, countIn: false });
    for (const h of plan.hits) {
      if (h.kind === 'sub') {
        expect(pcm[h.sample + 1]).toBe(0);
      } else {
        expect(pcm[h.sample + 1]).not.toBe(0);
      }
    }
  });

  it('WAV 头可被解析, 长度与 PCM 一致', () => {
    const { pcm } = renderExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 1, countIn: true });
    const wav = encodeWav(pcm, SR);
    const info = parseWavHeader(wav);
    expect(info.sampleRate).toBe(SR);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.totalSamples).toBe(pcm.length);
    expect(wav.byteLength).toBe(44 + pcm.length * 2);
  });

  it('同一工程两次渲染逐采样一致 (确定性)', () => {
    const a = renderExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 7, countIn: true });
    const b = renderExport(tl, project, { sampleRate: SR, barFrom: 0, barTo: 7, countIn: true });
    expect(Array.from(a.pcm)).toEqual(Array.from(b.pcm));
  });
});
