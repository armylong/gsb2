import type { Coord, GameStatus, InkId, StencilId } from './types';
import type { StampFailureReason } from './game';
import type { ScriptStep, VerificationScript } from './script';

/** 网格坐标 → 便于阅读的格子标签，如 A1。 */
export function cellId(coord: Coord): string {
  if (coord.x < 0 || coord.y < 0) throw new Error(`坐标不能为负：${coord.x},${coord.y}`);
  return `${String.fromCharCode(65 + coord.x)}${coord.y + 1}`;
}

export function parseCellId(text: string): Coord {
  const match = /^([A-Z])([1-9]\d*)$/.exec(text.trim());
  if (!match) throw new Error(`格子标签无效：${text}（应形如 A1）`);
  const x = match[1]!.charCodeAt(0) - 65;
  const y = Number(match[2]) - 1;
  return { x, y };
}

function parseStatus(raw: string): GameStatus {
  if (raw === 'playing' || raw === 'failed' || raw === 'solved') return raw;
  throw new Error(`状态无效：${raw}`);
}

function parseIntToken(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^-?\d+$/.test(raw)) throw new Error(`缺少整数参数 ${name}`);
  return Number(raw);
}

function parseCellList(raw: string | undefined): Coord[] {
  if (raw === undefined) throw new Error('缺少格子列表');
  if (raw === '-') return [];
  return raw.split(',').filter(Boolean).map(parseCellId);
}

const FAILURE_REASONS: Record<string, StampFailureReason> = {
  ink: 'insufficient-ink',
  contact: 'no-contact',
  state: 'not-playing',
};

/**
 * 解析操作串文本。格式是一行一步：
 *   @name / @level / @about 元信息
 *   stamp <模板> <墨> at <格> rot <0-3> flip <0|1> [cost N] [ink N] [status S]
 *         [new-clean A1,B2|-] [masked A1|-] [reject ink|contact|state] // 备注
 *   mask <格> on|off [color <颜色id>]
 *   undo [ink <墨> N] [status S]
 *   reset
 */
export function parseScript(text: string): VerificationScript {
  const lines = text.split(/\r?\n/);
  let name = '';
  let levelId = '';
  let about = '';
  const steps: ScriptStep[] = [];

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const rawLine = lines[lineNo]!;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      if (line.startsWith('@name ')) {
        name = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('@level ')) {
        levelId = line.slice(7).trim();
        continue;
      }
      if (line.startsWith('@about ')) {
        about = line.slice(7).trim();
        continue;
      }
      if (line.startsWith('#')) continue;

      const commentIndex = line.indexOf('//');
      const body = commentIndex >= 0 ? line.slice(0, commentIndex).trim() : line;
      const label = commentIndex >= 0 ? line.slice(commentIndex + 2).trim() : '';
      const tokens = body.split(/\s+/);
      const kind = tokens[0];

      if (kind === 'reset') {
        steps.push({ kind: 'reset', label: label || '重新开始' });
        continue;
      }

      if (kind === 'mask') {
        const coord = parseCellId(tokens[1] ?? '');
        const state = tokens[2];
        if (state !== 'on' && state !== 'off') throw new Error('mask 需要 on 或 off');
        const expect: { masked: boolean; cellColor?: string } = { masked: state === 'on' };
        for (let i = 3; i < tokens.length; i += 1) {
          if (tokens[i] === 'color') {
            expect.cellColor = tokens[i + 1];
            i += 1;
          } else {
            throw new Error(`mask 无法识别参数：${tokens[i]}`);
          }
        }
        steps.push({
          kind: 'mask',
          label: label || `${state === 'on' ? '贴' : '收'}挡墨纸 ${cellId(coord)}`,
          x: coord.x,
          y: coord.y,
          expect,
        });
        continue;
      }

      if (kind === 'undo') {
        const expect: { ink?: InkId; inkLeft?: number; status?: GameStatus } = {};
        for (let i = 1; i < tokens.length; i += 2) {
          const key = tokens[i];
          const value = tokens[i + 1];
          if (key === 'ink') {
            const ink = value;
            const left = tokens[i + 2];
            if (!ink || left === undefined) throw new Error('undo ink 需要 <墨> <剩余>');
            expect.ink = ink;
            expect.inkLeft = parseIntToken(left, '剩余');
            i += 1;
          } else if (key === 'status') {
            expect.status = parseStatus(value ?? '');
          } else {
            throw new Error(`undo 无法识别参数：${key}`);
          }
        }
        steps.push({ kind: 'undo', label: label || '撤回上一步', expect });
        continue;
      }

      if (kind !== 'stamp') throw new Error(`未知指令：${kind}`);
      const stencilId: StencilId = tokens[1] ?? '';
      const ink: InkId = tokens[2] ?? '';
      if (!stencilId || !ink) throw new Error('stamp 需要 <模板> <墨色>');
      if (tokens[3] !== 'at') throw new Error('stamp 缺少 at <格>');
      const pivot = parseCellId(tokens[4] ?? '');
      let rotation = 0;
      let flipped = false;
      const expect: Record<string, unknown> = {};
      for (let i = 5; i < tokens.length; i += 2) {
        const key = tokens[i];
        const value = tokens[i + 1];
        if (key === 'rot') {
          rotation = parseIntToken(value, 'rot');
          if (rotation < 0 || rotation > 3) throw new Error('rot 必须在 0..3');
        } else if (key === 'flip') {
          if (value !== '0' && value !== '1') throw new Error('flip 必须是 0 或 1');
          flipped = value === '1';
        } else if (key === 'cost') {
          expect.cost = parseIntToken(value, 'cost');
        } else if (key === 'ink') {
          expect.inkLeft = parseIntToken(value, 'ink');
        } else if (key === 'status') {
          expect.status = parseStatus(value ?? '');
        } else if (key === 'new-clean') {
          expect.newClean = parseCellList(value);
        } else if (key === 'masked') {
          expect.masked = parseCellList(value);
        } else if (key === 'reject') {
          const reason = FAILURE_REASONS[value ?? ''];
          if (!reason) throw new Error(`reject 原因无效：${value}`);
          expect.ok = false;
          expect.reason = reason;
        } else {
          throw new Error(`stamp 无法识别参数：${key}`);
        }
      }
      if (expect.ok !== false) expect.ok = true;
      steps.push({
        kind: 'stamp',
        label: label || `${stencilId} · ${ink} · ${cellId(pivot)}`,
        stencilId,
        ink,
        pivot,
        rotation,
        flipped,
        expect: expect as never,
      });
    } catch (error) {
      throw new Error(`操作串第 ${lineNo + 1} 行：${(error as Error).message}`);
    }
  }

  if (!name) throw new Error('操作串缺少 @name');
  if (!levelId) throw new Error('操作串缺少 @level');
  return {
    id: `parsed-${levelId}`,
    levelId,
    name,
    description: about,
    steps,
  };
}

/** 把操作串还原成规范文本，用于展示、复制与往返测试。 */
export function formatScript(script: VerificationScript): string {
  const lines = [
    `@name ${script.name}`,
    `@level ${script.levelId}`,
    `@about ${script.description}`,
    '',
  ];
  for (const step of script.steps) {
    if (step.kind === 'reset') {
      lines.push(`reset // ${step.label}`);
      continue;
    }
    if (step.kind === 'mask') {
      const bits = [`mask ${cellId(step)} ${step.expect.masked ? 'on' : 'off'}`];
      if (step.expect.cellColor) bits.push(`color ${step.expect.cellColor}`);
      lines.push(`${bits.join(' ')} // ${step.label}`);
      continue;
    }
    if (step.kind === 'undo') {
      const bits = ['undo'];
      if (step.expect?.ink && step.expect.inkLeft !== undefined) {
        bits.push(`ink ${step.expect.ink} ${step.expect.inkLeft}`);
      }
      if (step.expect?.status) bits.push(`status ${step.expect.status}`);
      lines.push(`${bits.join(' ')} // ${step.label}`);
      continue;
    }
    const bits = [
      'stamp',
      step.stencilId,
      step.ink,
      'at',
      cellId(step.pivot),
      'rot',
      String(step.rotation),
      'flip',
      step.flipped ? '1' : '0',
    ];
    const expect = step.expect;
    if (!expect.ok) {
      const reverse: Record<string, string> = {
        'insufficient-ink': 'ink',
        'no-contact': 'contact',
        'not-playing': 'state',
      };
      bits.push('reject', reverse[expect.reason ?? ''] ?? 'state');
    } else {
      if (expect.cost !== undefined) bits.push('cost', String(expect.cost));
      if (expect.inkLeft !== undefined) bits.push('ink', String(expect.inkLeft));
      if (expect.status) bits.push('status', expect.status);
      if (expect.newClean) bits.push('new-clean', expect.newClean.map(cellId).join(',') || '-');
      if (expect.masked) bits.push('masked', expect.masked.map(cellId).join(',') || '-');
    }
    lines.push(`${bits.join(' ')} // ${step.label}`);
  }
  return `${lines.join('\n')}\n`;
}
