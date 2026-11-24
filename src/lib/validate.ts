import type { CaptionEvent, CaptionEventDraft } from './types';

export interface ImportResult {
  ok: boolean;
  events: CaptionEvent[];
  name: string;
  errors: string[];
  warnings: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function coerceEvent(raw: unknown, index: number, errors: string[]): CaptionEvent | null {
  const at = `第 ${index + 1} 条`;
  if (!isRecord(raw)) {
    errors.push(`${at}：应为对象`);
    return null;
  }
  const draft = raw as Partial<CaptionEventDraft>;

  if (typeof draft.id !== 'string' || draft.id.trim() === '') {
    errors.push(`${at}：id 必须是非空字符串`);
  }
  if (typeof draft.captionId !== 'string' || draft.captionId.trim() === '') {
    errors.push(`${at}：captionId 必须是非空字符串`);
  }
  if (!finiteNumber(draft.seq) || !Number.isInteger(draft.seq) || draft.seq < 1) {
    errors.push(`${at}：seq 必须是 >= 1 的整数`);
  }
  if (draft.kind !== 'revision' && draft.kind !== 'final') {
    errors.push(`${at}：kind 必须是 "revision" 或 "final"`);
  }
  if (typeof draft.text !== 'string') {
    errors.push(`${at}：text 必须是字符串`);
  }
  if (!finiteNumber(draft.mediaStart) || draft.mediaStart < 0) {
    errors.push(`${at}：mediaStart 必须是 >= 0 的数字`);
  }
  if (!finiteNumber(draft.mediaEnd) || draft.mediaEnd < 0) {
    errors.push(`${at}：mediaEnd 必须是 >= 0 的数字`);
  }
  if (finiteNumber(draft.mediaStart) && finiteNumber(draft.mediaEnd) && draft.mediaEnd < draft.mediaStart) {
    errors.push(`${at}：mediaEnd 不能早于 mediaStart`);
  }
  if (!finiteNumber(draft.arrival) || draft.arrival < 0) {
    errors.push(`${at}：arrival 必须是 >= 0 的数字`);
  }

  if (errors.length > 0) return null;

  return {
    id: draft.id as string,
    captionId: draft.captionId as string,
    seq: draft.seq as number,
    kind: draft.kind as CaptionEvent['kind'],
    text: draft.text as string,
    mediaStart: draft.mediaStart as number,
    mediaEnd: draft.mediaEnd as number,
    arrival: draft.arrival as number,
    note: typeof draft.note === 'string' ? draft.note : undefined,
  };
}

/** 读取用户粘贴/上传的 JSON，返回可回放的事件；错误全部列出来而不是只报第一条。 */
export function parseCaptionEvents(input: unknown): ImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let name = '导入的事件';
  let list: unknown[];

  if (Array.isArray(input)) {
    list = input;
  } else if (isRecord(input) && Array.isArray(input.events)) {
    list = input.events;
    if (typeof input.name === 'string' && input.name.trim() !== '') name = input.name.trim();
  } else {
    return {
      ok: false,
      events: [],
      name,
      errors: ['顶层应为事件数组，或形如 { "name": "...", "events": [...] } 的对象'],
      warnings,
    };
  }

  if (list.length === 0) {
    errors.push('事件数组为空');
  }

  const events: CaptionEvent[] = [];
  list.forEach((raw, index) => {
    // 用局部错误收集，避免某一条的失败影响后续条目。
    const local: string[] = [];
    const parsed = coerceEvent(raw, index, local);
    if (local.length > 0) {
      errors.push(...local);
      return;
    }
    if (parsed) events.push(parsed);
  });

  if (events.length > 0) {
    const seenIds = new Map<string, CaptionEvent>();
    for (const item of events) {
      const existing = seenIds.get(item.id);
      if (existing) {
        if (existing.captionId !== item.captionId || existing.seq !== item.seq || existing.text !== item.text) {
          warnings.push(`事件 id "${item.id}" 重复且内容不同：引擎会把后到的当作重复投递拒绝`);
        } else {
          warnings.push(`事件 id "${item.id}" 重复：保留为可核对的重复投递记录`);
        }
      } else {
        seenIds.set(item.id, item);
      }
    }

    const captions = new Set(events.map((item) => item.captionId));
    if (captions.size > 6) {
      warnings.push(`共 ${captions.size} 条字幕，时间轴只绘制前 6 条；台账仍包含全部事件`);
    }

    const arrivals = events.map((item) => item.arrival);
    if (Math.max(...arrivals) > 600) {
      warnings.push('到达时间跨度超过 10 分钟，播放速度与拖动会显得很粗');
    }
  }

  return { ok: errors.length === 0 && events.length > 0, events, name, errors, warnings };
}

export function parseCaptionEventsText(text: string): ImportResult {
  try {
    return parseCaptionEvents(JSON.parse(text));
  } catch (error) {
    return {
      ok: false,
      events: [],
      name: '导入的事件',
      errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
}
