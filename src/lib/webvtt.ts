import type { ConfirmedCue } from './types';
import { vttTime } from './format';

const EPSILON = 1e-9;

function cleanCueText(text: string): string {
  return text
    .replace(/-->/g, '→')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function cleanIdentifier(captionId: string): string {
  return captionId.replace(/[^\w.:-]+/g, '-');
}

export interface WebVttBuild {
  vtt: string;
  exported: ConfirmedCue[];
  skipped: ConfirmedCue[];
  duplicatesDropped: number;
}

/**
 * 只导出“已确认”的字幕，并且以 captionId 去重：
 * 同一条字幕无论被重发、修订多少次，最终只对应一个 cue。
 */
export function buildWebVtt(cues: readonly ConfirmedCue[]): WebVttBuild {
  const seen = new Set<string>();
  const exported: ConfirmedCue[] = [];
  const skipped: ConfirmedCue[] = [];
  let duplicatesDropped = 0;

  const sorted = [...cues].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.captionId.localeCompare(b.captionId),
  );

  for (const cue of sorted) {
    if (seen.has(cue.captionId)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(cue.captionId);
    if (cleanCueText(cue.text).length === 0) {
      skipped.push(cue);
      continue;
    }
    exported.push(cue);
  }

  const blocks: string[] = ['WEBVTT', ''];
  exported.forEach((cue, index) => {
    const end = Math.max(cue.end, cue.start + 0.001);
    blocks.push(`${index + 1}`, cleanIdentifier(cue.captionId), `${vttTime(cue.start)} --> ${vttTime(end)}`, cleanCueText(cue.text), '');
  });

  return {
    vtt: blocks.join('\n').replace(/\n+$/, '\n'),
    exported,
    skipped,
    duplicatesDropped,
  };
}

/** 导出边界摘要：重叠与空行等核对点。 */
export function cueBoundaryIssues(cues: readonly ConfirmedCue[]): string[] {
  const issues: string[] = [];
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.captionId.localeCompare(b.captionId));
  for (let index = 0; index < sorted.length; index += 1) {
    const cue = sorted[index];
    if (cue.end <= cue.start + EPSILON) {
      issues.push(`${cue.captionId} 的结束时间不晚于开始时间`);
    }
    if (cue.text.trim().length === 0) {
      issues.push(`${cue.captionId} 的文本为空`);
    }
    const next = sorted[index + 1];
    if (next && next.start < cue.end - EPSILON) {
      issues.push(`${cue.captionId} 与 ${next.captionId} 的区间重叠`);
    }
  }
  return issues;
}
