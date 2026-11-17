import type { AnimationBlender } from './blender';
import type { JointMask } from './types';
import { BONE_NAMES, getBoneSpec } from './skeleton';
import { createPresetMask, type MaskPresetId } from './mask';

export interface DemoState {
  id: string;
  label: string;
  description: string;
  fadeDuration: number;
  mask: JointMask;
  applyRootMotion: boolean;
  /** 进入该演示状态时对引擎执行的动作 */
  apply: (blender: AnimationBlender) => void;
}

/** 复制一份遮罩，避免各演示状态共享同一个 Map */
function cloneMask(mask: JointMask): JointMask {
  return new Map(mask);
}

function setPreset(blender: AnimationBlender, preset: MaskPresetId): void {
  blender.mask = createPresetMask(preset);
}

/**
 * 三个可重复演示状态：
 * 1. 完整混合（交叉淡入）—— 全身遮罩，定时淡入 A→B
 * 2. 上身遮罩 —— 下半身保持行走步态，上肢采用潜行动作
 * 3. 中途反向切换 —— 淡入到一半立刻反向，验证从当前状态平滑继续
 */
export function createDemoStates(): DemoState[] {
  const fullMask = createPresetMask('all');

  return [
    {
      id: 'full-blend',
      label: '演示 1 · 完整交叉淡入',
      description: '全身遮罩，0.8s 内由行走交叉淡入到潜行；注意两段动作播放头始终独立前进。',
      fadeDuration: 0.8,
      mask: cloneMask(fullMask),
      applyRootMotion: true,
      apply: (b) => {
        setPreset(b, 'all');
        b.fadeDuration = 0.8;
        b.applyRootMotion = true;
        b.startFade('sneak');
      },
    },
    {
      id: 'upper-mask',
      label: '演示 2 · 上半身遮罩',
      description: '仅上半身关节权重为 1：下肢继续行走，上肢与脊柱采用潜行的摆动。',
      fadeDuration: 0.6,
      mask: createPresetMask('upper'),
      applyRootMotion: true,
      apply: (b) => {
        setPreset(b, 'upper');
        b.fadeDuration = 0.6;
        b.applyRootMotion = true;
        // 直接进入混合并把淡入权重推满，便于稳定观察遮罩姿态
        b.startFade('sneak');
        b.globalWeight = 1;
      },
    },
    {
      id: 'reverse',
      label: '演示 3 · 淡入中途反向',
      description: '淡入进行到 40% 时立即反向切回；姿态与权重从当前状态平滑回退，不跳回起点。',
      fadeDuration: 1.0,
      mask: cloneMask(fullMask),
      applyRootMotion: true,
      apply: (b) => {
        setPreset(b, 'all');
        b.fadeDuration = 1.0;
        b.applyRootMotion = true;
        b.startFade('sneak');
        b.globalWeight = 0.4;
        b.startFade('walk');
      },
    },
  ];
}

/** 校验：某预设下所有关节的遮罩值仅为 0 或 1，且分区归属正确 */
export function assertPresetRegions(preset: MaskPresetId): { name: string; region: string; weight: number }[] {
  const mask = createPresetMask(preset);
  return BONE_NAMES.map((name) => ({
    name,
    region: getBoneSpec(name).region,
    weight: mask.get(name) ?? 0,
  }));
}
