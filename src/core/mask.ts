import type { BoneName, JointMask } from './types';
import { BONE_NAMES, getBoneSpec } from './skeleton';

export type MaskPresetId = 'all' | 'upper' | 'lower' | 'none';

export const MASK_PRESETS: { id: MaskPresetId; label: string }[] = [
  { id: 'all', label: '全身混合' },
  { id: 'upper', label: '仅上半身' },
  { id: 'lower', label: '仅下半身' },
  { id: 'none', label: '全部关闭' },
];

function regionMatches(region: 'root' | 'upper' | 'lower', preset: MaskPresetId): boolean {
  switch (preset) {
    case 'all':
      return true;
    case 'upper':
      // 髋根不纳入上半身预设：下肢仍由基础动作驱动时，根不能被目标动作带走
      return region === 'upper';
    case 'lower':
      return region === 'lower' || region === 'root';
    case 'none':
      return false;
  }
}

/** 由预设生成一份逐关节遮罩（值只有 0/1） */
export function createPresetMask(preset: MaskPresetId): JointMask {
  const mask = new Map<BoneName, number>();
  for (const name of BONE_NAMES) {
    mask.set(name, regionMatches(getBoneSpec(name).region, preset) ? 1 : 0);
  }
  return mask;
}

/** 创建全 0 遮罩 */
export function createZeroMask(): JointMask {
  const mask = new Map<BoneName, number>();
  for (const name of BONE_NAMES) mask.set(name, 0);
  return mask;
}

/** 计算每个关节的实际混合权重 = 全局淡入权重 α × 关节遮罩权重 */
export function resolvePerBoneWeight(globalWeight: number, mask: JointMask): Map<BoneName, number> {
  const out = new Map<BoneName, number>();
  for (const name of BONE_NAMES) {
    out.set(name, globalWeight * (mask.get(name) ?? 0));
  }
  return out;
}
