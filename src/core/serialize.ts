// 录像导出/导入与校验。
// 导入时依次检查: 格式标识 -> 格式版本 -> 规则版本 -> 结构 -> 整体校验和 -> 逐步重放对指纹。

import {
  RULE_VERSION,
  INPUTS,
  initialState,
  step,
  hashState,
  fnv1a,
  type Input,
} from "./sim.ts";
import { Recorder, type Branch } from "./tape.ts";

export const FORMAT = "sandbox-tape";
export const FORMAT_VERSION = 1;

export interface BranchData {
  id: string;
  name: string;
  parentId: string | null;
  forkStep: number;
  inputs: Input[];
  hashes: string[];
  cursor: number;
}

export interface TapeFile {
  format: string;
  formatVersion: number;
  ruleVersion: string;
  branches: BranchData[];
  checksum: string; // fnv1a(稳定序列化(branches)), 防篡改/截断
}

/** 对分支数据做稳定序列化后再取指纹, 保证同一内容恒定同一校验和 */
export function computeChecksum(branches: BranchData[]): string {
  const sorted = [...branches].sort((a, b) => (a.id < b.id ? -1 : 1));
  return fnv1a(
    JSON.stringify(
      sorted.map((b) => [b.id, b.name, b.parentId, b.forkStep, b.inputs, b.hashes, b.cursor]),
    ),
  );
}

export function exportTape(rec: Recorder): string {
  const branches: BranchData[] = [...rec.branches.values()].map((b) => ({
    id: b.id,
    name: b.name,
    parentId: b.parentId,
    forkStep: b.forkStep,
    inputs: [...b.inputs],
    hashes: [...b.hashes],
    cursor: b.cursor,
  }));
  const file: TapeFile = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    ruleVersion: RULE_VERSION,
    branches,
    checksum: computeChecksum(branches),
  };
  return JSON.stringify(file, null, 2);
}

export interface Divergence {
  branchId: string;
  branchName: string;
  step: number; // 首个发生分歧的步骤 (1 起计; 0 表示初始状态就不一致)
  expected: string; // 录像中记录的指纹
  actual: string; // 按当前规则重放得到的指纹
}

export type ImportResult =
  | { ok: true; recorder: Recorder }
  | { ok: false; errors: string[]; divergence?: Divergence };

export function importTape(json: string): ImportResult {
  let file: TapeFile;
  try {
    file = JSON.parse(json) as TapeFile;
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败: ${(e as Error).message}`] };
  }

  const errors: string[] = [];
  if (file.format !== FORMAT) errors.push(`格式标识不符: ${String(file.format)}`);
  if (file.formatVersion !== FORMAT_VERSION)
    errors.push(`格式版本不支持: ${String(file.formatVersion)} (当前 ${FORMAT_VERSION})`);
  if (file.ruleVersion !== RULE_VERSION)
    errors.push(`规则版本不匹配: 数据=${String(file.ruleVersion)} 当前=${RULE_VERSION}`);
  if (!Array.isArray(file.branches) || file.branches.length === 0)
    errors.push("缺少分支数据");
  if (errors.length > 0) return { ok: false, errors };

  // 快照完整性: 整体校验和
  if (file.checksum !== computeChecksum(file.branches))
    errors.push("校验和不匹配: 数据可能被篡改或截断");

  // 结构校验
  const ids = new Set<string>();
  for (const b of file.branches) {
    if (ids.has(b.id)) errors.push(`分支 id 重复: ${b.id}`);
    ids.add(b.id);
    if (!Array.isArray(b.inputs) || b.inputs.some((i) => !INPUTS.includes(i)))
      errors.push(`分支 ${b.name} 含非法输入`);
    else if (!Array.isArray(b.hashes) || b.hashes.length !== b.inputs.length + 1)
      errors.push(`分支 ${b.name} 快照数量与输入步数不符 (快照 ${b.hashes?.length} / 需要 ${b.inputs.length + 1})`);
    if (b.parentId !== null && !file.branches.some((p) => p.id === b.parentId))
      errors.push(`分支 ${b.name} 的父分支不存在: ${b.parentId}`);
    if (b.forkStep < 0) errors.push(`分支 ${b.name} 的 forkStep 非法`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // 逐步重放, 定位首个分歧步骤
  for (const b of file.branches) {
    let s = initialState();
    const h0 = hashState(s);
    if (h0 !== b.hashes[0]) {
      return {
        ok: false,
        errors: [`分支 ${b.name} 初始状态即不一致`],
        divergence: { branchId: b.id, branchName: b.name, step: 0, expected: b.hashes[0], actual: h0 },
      };
    }
    for (let i = 0; i < b.inputs.length; i++) {
      s = step(s, b.inputs[i]);
      const h = hashState(s);
      if (h !== b.hashes[i + 1]) {
        return {
          ok: false,
          errors: [`分支 ${b.name} 在第 ${i + 1} 步首次发生分歧`],
          divergence: {
            branchId: b.id,
            branchName: b.name,
            step: i + 1,
            expected: b.hashes[i + 1],
            actual: h,
          },
        };
      }
    }
  }

  // 全部通过后重建 Recorder
  const rec = new Recorder();
  rec.branches.clear();
  for (const bd of file.branches) {
    let s = initialState();
    const states = [s];
    for (const input of bd.inputs) {
      s = step(s, input);
      states.push(s);
    }
    const branch: Branch = {
      id: bd.id,
      name: bd.name,
      parentId: bd.parentId,
      forkStep: bd.forkStep,
      inputs: [...bd.inputs],
      hashes: [...bd.hashes],
      states,
      cursor: Math.min(bd.cursor, bd.inputs.length),
    };
    rec.branches.set(branch.id, branch);
  }
  rec.currentId = file.branches[0].id;
  return { ok: true, recorder: rec };
}
