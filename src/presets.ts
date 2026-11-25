/**
 * 内置摆位：每组给出初始配重、卡榫武装与预期现象。
 * 数值经过 tools/sweep.ts 网格扫描 + tools/tune.ts 无头仿真校准。
 *
 * 平衡点：三质量相等时（m1=mL=m2）合力恰好为 0；
 * 偏离平衡即按 (m·g−2T) 的符号决定各体上行/下行。
 */
import type { BodyId, LatchId } from './model.js';

export interface Preset {
  id: string;
  name: string;
  desc: string;
  expected: string;
  weights: Record<BodyId, number>;
  arm: LatchId[];
}

export const PRESETS: Preset[] = [
  {
    id: 'gentle',
    name: '合理调重：缓慢升到上窗格',
    desc: '两个托架各 1.1kg、纸灯 1.0kg，托架侧略重把纸灯缓缓抬升；阻尼使其到达上窗格前速度已衰减，进入窗格时 |v|≈0，卡榫可靠合上。',
    expected: '约 7s 进入上窗格，检查记录为 locked；灯停在 h≈115。',
    weights: { carriage1: 1.1, lantern: 1.0, carriage2: 1.1 },
    arm: ['upper'],
  },
  {
    id: 'crash',
    name: '配重不平衡：托架1撞底限位',
    desc: '托架1 重达 2.2kg，系统明显失衡。托架1加速下坠撞底并被该侧接触锁死，随后托架2撞顶；纸灯按绳长约束停在对应高度，全程绳长和恒为 660，不会突然变长。',
    expected: '先出现托架2撞顶、再出现托架1撞底事件；最终三物体速度全 0。',
    weights: { carriage1: 2.2, lantern: 0.9, carriage2: 0.45 },
    arm: [],
  },
  {
    id: 'overshoot',
    name: '刚好过头：擦着阈值穿过下窗格',
    desc: '纸灯 1.05kg 略重于平衡，下行穿过下窗格时速度约 24px/s，仅比卡榫阈值 22 高一点 → 卡不上并留下 too-fast 记录。可在行程中把纸灯换成 0.9kg，使其减速回升，第二次慢速经过即可补卡。',
    expected: '首次过下窗格 too-fast（|v|≈24 > 22）；调重后回升出现 locked。',
    weights: { carriage1: 0.9, lantern: 1.05, carriage2: 0.9 },
    arm: ['lower'],
  },
  {
    id: 'balanced',
    name: '精确平衡：静止调重台',
    desc: '三质量均为 1.0kg，合力严格为 0，系统长期静止。用于演示行程中换配重：替换任一配重后，系统从当前速度（静止即 0）按新合力平滑起步，不会跳位置。',
    expected: '不操作则完全静止；换配重后按当前状态平滑起步。',
    weights: { carriage1: 1.0, lantern: 1.0, carriage2: 1.0 },
    arm: [],
  },
];
