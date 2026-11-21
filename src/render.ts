/**
 * 终端渲染: 报告表格 / 逐抽时间线 / 对照实验。
 * 只依赖字符串, 不依赖任何第三方库。
 */

import type { RarityId } from './config.ts';
import type { Report, SegmentBucket, ArmSummary, TimelineEntry } from './stats.ts';

/** 粗略的显示宽度: CJK 与全角标点算 2 列 */
function charWidth(code: number): number {
  if (code === 0) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

export function padEnd(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

export function padStart(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? ' '.repeat(gap) + text : text;
}

function printTable(headers: readonly string[], rows: readonly (readonly string[])[], align: readonly ('l' | 'r')[]): string[] {
  const widths = headers.map((header, i) => {
    let width = displayWidth(header);
    for (const row of rows) width = Math.max(width, displayWidth(row[i] ?? ''));
    return width;
  });
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (align[i] === 'r' ? padStart(cell, widths[i]!) : padEnd(cell, widths[i]!)))
      .join('  ');
  const divider = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), divider, ...rows.map(line)];
}

const pct = (value: number | null | undefined): string =>
  value === null || value === undefined ? '-' : `${(value * 100).toFixed(2)}%`;

function ruleText(counts: { weighted: number; pity: number; empty: number }): string {
  return `权重 ${counts.weighted} / 保底 ${counts.pity} / 空 ${counts.empty}`;
}

export interface RenderOptions {
  readonly rarityOrder?: readonly RarityId[];
}

/** 分段表: 每段一行, 每个稀有度两列 (次数 / 命中率) */
export function renderSegments(segments: readonly SegmentBucket[], rarityIds: readonly RarityId[]): string[] {
  if (segments.length === 0) return ['    (无样本)'];
  const headers = ['连续未中区间', '抽数', ...rarityIds.map((id) => `${id} 命中`), ...rarityIds.map((id) => `${id} 命中率`)];
  const align: ('l' | 'r')[] = ['l', 'r', ...rarityIds.map(() => 'r' as const), ...rarityIds.map(() => 'r' as const)];
  const rows = segments.map((segment) => [
    `${segment.from}-${segment.to}`,
    String(segment.draws),
    ...rarityIds.map((id) => String(segment.hits[id] ?? 0)),
    ...rarityIds.map((id) => pct(segment.rates[id] ?? 0)),
  ]);
  return printTable(headers, rows, align);
}

export function renderReport(report: Report, options: RenderOptions = {}): string {
  const out: string[] = [];
  const rarityIds = options.rarityOrder ?? Object.keys(report.rarityLabels);

  out.push('═'.repeat(78));
  out.push(`掉落保底模拟报告  总抽数: ${report.draws}   规则: ${ruleText(report.ruleCounts)}`);
  out.push(
    `计划: ${report.plan.mode} × ${report.plan.passes} 轮 / ${report.plan.pools.length} 池 × ${report.plan.characters.length} 角色` +
      (report.plan.mode === 'pool-blocks' ? ` (每块 ${report.plan.drawsPerBlock} 抽)` : ''),
  );
  out.push('═'.repeat(78));

  out.push('');
  out.push('## 实际抽中的权重版本');
  if (report.versions.length === 0) out.push('  (无)');
  else {
    out.push(
      ...printTable(
        ['物品池', '版本', '标签', '抽数', '命中'],
        report.versions.map((v) => [v.poolId, `v${v.version}`, v.label, String(v.draws), String(v.hits)]),
        ['l', 'r', 'l', 'r', 'r'],
      ).map((line) => `  ${line}`),
    );
  }

  for (const pool of report.pools) {
    out.push('');
    out.push(`## 物品池 ${pool.label} (${pool.poolId})` + (pool.sharedGroupId ? ` — 共享保底组 ${pool.sharedGroupId}` : ' — 独立保底'));
    out.push(`  抽数 ${pool.draws}, 规则分布: ${ruleText(pool.ruleCounts)}`);
    if (pool.rarities.length === 0) {
      out.push('  (空池)');
      continue;
    }
    out.push(
      ...printTable(
        ['稀有度', '抽数', '命中', '实际命中率', '名义权重占比', '基础命中', '加成命中', '保底命中', '最长未中'],
        pool.rarities.map((r) => [
          `${r.label} (${r.id})`,
          String(r.draws),
          String(r.hits),
          pct(r.rate),
          r.nominalRate === null ? '-' : pct(r.nominalRate),
          String(r.weightedHits),
          String(r.bonusHits),
          String(r.pityHits),
          String(r.maxMissStreak),
        ]),
        ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
      ).map((line) => `  ${line}`),
    );
    out.push('  分段命中率 (按抽前最大连续未中分段):');
    out.push(...renderSegments(pool.segments, rarityIds.filter((id) => pool.rarities.some((r) => r.id === id))).map((line) => `    ${line}`));
  }

  out.push('');
  out.push('## 角色视图');
  for (const character of report.characters) {
    out.push('');
    out.push(`### ${character.label} (${character.characterId}) — 抽数 ${character.draws}, 规则: ${ruleText(character.ruleCounts)}`);
    if (character.rarities.length > 0) {
      out.push(
        ...printTable(
          ['稀有度', '命中', '命中率', '基础', '加成', '保底', '最长未中'],
          character.rarities.map((r) => [
            `${r.label} (${r.id})`,
            String(r.hits),
            pct(r.rate),
            String(r.weightedHits),
            String(r.bonusHits),
            String(r.pityHits),
            String(r.maxMissStreak),
          ]),
          ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
        ).map((line) => `    ${line}`),
      );
    }
    for (const scope of character.progressScopes) {
      const streaks = Object.entries(scope.streaks)
        .map(([id, value]) => `${id}=${value}`)
        .join(', ');
      out.push(`    进度 ${scope.scope === 'group' ? `组 ${scope.ownerId}` : `池 ${scope.ownerId}`}: ${streaks}`);
    }
  }
  return out.join('\n');
}

export function renderTimeline(entries: readonly TimelineEntry[], limit = 40): string {
  const out: string[] = [];
  out.push('逐次试抽 (最近 %d 抽)'.replace('%d', String(Math.min(limit, entries.length))));
  out.push('');
  const shown = entries.slice(-limit);
  const headers = ['#', '角色', '池', '版本', 'roll', '规则', '命中', '抽前streak', '进度来源', '随机状态'];
  const rows = shown.map((entry) => [
    String(entry.index),
    entry.characterId,
    entry.poolId,
    `v${entry.version}`,
    entry.roll === null ? '-' : entry.roll.toFixed(6),
    entry.rule,
    entry.hit ?? '-',
    Object.entries(entry.streaksBefore).map(([id, v]) => `${id}=${v}`).join(','),
    `${entry.scope === 'group' ? '组' : '池'}:${entry.ownerId}/${entry.strategy}`,
    entry.rngBefore,
  ]);
  out.push(...printTable(headers, rows, ['r', 'l', 'l', 'r', 'r', 'l', 'l', 'l', 'l', 'l']));
  out.push('');
  out.push('说明 (逐抽):');
  for (const entry of shown) {
    out.push(`  #${entry.index} [${entry.characterId}/${entry.poolId} v${entry.version}] ${entry.notes.join(' | ')}`);
  }
  return out.join('\n');
}

export interface ComparisonRow {
  readonly label: string;
  readonly left: string;
  readonly right: string;
  readonly delta?: string;
}

export function renderComparison(left: ArmSummary, right: ArmSummary): string {
  const out: string[] = [];
  out.push('═'.repeat(78));
  out.push(`对照实验: A = ${left.label} / B = ${right.label}`);
  out.push('═'.repeat(78));
  const rows: string[][] = [
    ['总抽数', String(left.draws), String(right.draws)],
    ['权重命中', String(left.ruleCounts.weighted), String(right.ruleCounts.weighted)],
    ['保底命中', String(left.ruleCounts.pity), String(right.ruleCounts.pity)],
    ['空结果', String(left.ruleCounts.empty), String(right.ruleCounts.empty)],
  ];
  const rarityIds = new Set([...left.perRarity.map((r) => r.rarityId), ...right.perRarity.map((r) => r.rarityId)]);
  for (const id of rarityIds) {
    const a = left.perRarity.find((r) => r.rarityId === id);
    const b = right.perRarity.find((r) => r.rarityId === id);
    rows.push([
      `${a?.label ?? b?.label ?? id} 命中(率)`,
      `${a?.hits ?? 0} (${pct(a?.rate ?? 0)})`,
      `${b?.hits ?? 0} (${pct(b?.rate ?? 0)})`,
    ]);
    rows.push([
      `${a?.label ?? b?.label ?? id} 保底/加成`,
      `${a?.pityHits ?? 0}/${a?.bonusHits ?? 0}`,
      `${b?.pityHits ?? 0}/${b?.bonusHits ?? 0}`,
    ]);
    rows.push([
      `${a?.label ?? b?.label ?? id} 最长未中`,
      String(a?.maxMissStreak ?? 0),
      String(b?.maxMissStreak ?? 0),
    ]);
  }
  out.push(...printTable(['指标', 'A', 'B'], rows, ['l', 'r', 'r']));
  out.push('');
  const versionText = (arm: ArmSummary): string =>
    arm.versions.map((v) => `${v.poolId}#v${v.version}(${v.label})×${v.draws}`).join(', ') || '(无)';
  out.push(`A 版本使用: ${versionText(left)}`);
  out.push(`B 版本使用: ${versionText(right)}`);
  return out.join('\n');
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}
