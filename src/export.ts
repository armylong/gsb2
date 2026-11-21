/**
 * 导出: 配置、报告、逐抽记录、Session 快照 (可续跑) 全部落盘为 JSON。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { LabConfig } from './config.ts';
import { sessionToJson, type Session } from './engine.ts';
import { buildTimeline, type ArmSummary, type Report } from './stats.ts';

export interface ExportOptions {
  /** 输出目录 */
  readonly dir: string;
  /** 文件名前缀, 默认带时间戳 */
  readonly prefix?: string;
}

export interface ExportedFiles {
  readonly dir: string;
  readonly files: readonly string[];
}

export interface ExportPayload {
  readonly config?: LabConfig;
  readonly session?: Session;
  readonly report?: Report;
  readonly comparison?: { readonly left: ArmSummary; readonly right: ArmSummary };
  readonly meta?: Record<string, unknown>;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/**
 * 导出到目录:
 *  - config.json        完整配置
 *  - report.json        统计报告
 *  - timeline.json      逐抽记录 (含随机状态、池版本、进度)
 *  - session.json       可续跑的 Session 快照
 *  - comparison.json    可选, 对照实验两组摘要
 *  - meta.json          可选, 运行参数
 */
export async function exportRun(payload: ExportPayload, options: ExportOptions): Promise<ExportedFiles> {
  const dir = resolve(options.dir);
  const prefix = options.prefix ?? `run-${timestamp()}`;
  const files: string[] = [];

  const emit = async (name: string, value: unknown): Promise<void> => {
    const file = join(dir, `${prefix}-${name}.json`);
    await writeJson(file, value);
    files.push(file);
  };

  if (payload.config) await emit('config', payload.config);
  if (payload.session) {
    await emit('session', JSON.parse(sessionToJson(payload.session)));
    await emit('timeline', buildTimeline(payload.session.records));
  }
  if (payload.report) await emit('report', payload.report);
  if (payload.comparison) await emit('comparison', payload.comparison);
  if (payload.meta) await emit('meta', payload.meta);

  return { dir, files };
}
