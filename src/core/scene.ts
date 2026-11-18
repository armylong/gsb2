import type { Block, Character, Scene } from './types';
import { CHAR_HEIGHT, CHAR_SX, CHAR_SY, GRID_SIZE, MAX_BLOCKS, blockAABB, characterAABB, overlaps3D } from './geometry';

let blockSeq = 0;

function makeBlock(
  label: string,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  h: number,
  color: string,
): Block {
  blockSeq += 1;
  return { id: `b${String(blockSeq).padStart(2, '0')}`, label, x, y, z, sx, sy, h, color };
}

/**
 * 程序化初始布局（15 个积木，≤20）：
 * L 形矮墙拐角、长条平台、台阶、顶部平台、高柱及若干散箱，
 * 长条平台两端上方各放一个箱子，用于观察“长条物两端遮挡”。
 */
export function createDefaultScene(): Scene {
  blockSeq = 0;
  const blocks: Block[] = [
    // —— L 形矮墙拐角（两段只共边、不共享体积，高 1.0）——
    makeBlock('矮墙·横段', 3, 2, 0, 4, 1, 1, '#7d8db0'),
    makeBlock('矮墙·竖段', 2, 2, 0, 1, 4, 1, '#6d7da2'),
    // —— 高柱，角色绕柱时前后关系翻转 ——
    makeBlock('高柱', 6, 3, 0, 1, 1, 3.2, '#c98f5b'),
    // —— 长条平台（长 6，高 1.0）——
    makeBlock('长条平台', 3, 7, 0, 6, 1, 1, '#5fa8a0'),
    // 平台两端上方各一个箱子：正确模式必须都画在平台之后，naive 会画错
    makeBlock('平台东端箱子', 7.2, 7.15, 1, 0.7, 0.7, 0.8, '#b99a4f'),
    makeBlock('平台西端箱子', 3.15, 7.15, 1, 0.7, 0.7, 0.8, '#b99a4f'),
    // 平台南侧（更靠近相机）贴地矮箱：naive 同样会误判
    makeBlock('平台前矮箱', 5, 8.4, 0, 0.8, 0.8, 0.6, '#a86f8f'),
    // —— 台阶：0.5 / 1.0 两级 ——
    makeBlock('台阶一(0.5)', 9, 2, 0, 1, 1, 0.5, '#8aa06f'),
    makeBlock('台阶二(1.0)', 10, 2, 0, 1, 1, 1, '#7e9662'),
    makeBlock('顶部平台', 10, 3, 0, 2, 2, 1, '#6f8c58'),
    // —— 长条平台二（贴地矮台，验证长物体投影）——
    makeBlock('长条矮台', 1, 10, 0, 5, 1, 0.5, '#7886b8'),
    // —— 散箱 ——
    makeBlock('散箱甲', 8.5, 10, 0, 1, 1, 1, '#b07a55'),
    makeBlock('散箱乙', 10.2, 9.6, 0, 0.8, 0.8, 0.7, '#9c6f9e'),
    makeBlock('散箱丙', 0.5, 6.5, 0, 0.9, 0.9, 1.2, '#6ba083'),
    makeBlock('矮墙尾箱', 7.6, 2.1, 0, 0.8, 0.8, 0.9, '#b5895e'),
  ];
  return { blocks, character: { x: 4, y: 4.5, z: 0 } };
}

export interface PlacementCheck {
  ok: boolean;
  reason?: string;
  conflictWith?: Block;
}

/** 校验积木移动/改高后的摆放：边界、数量与三维穿入。 */
export function checkBlockPlacement(scene: Scene, candidate: Block, ignoreId?: string): PlacementCheck {
  if (scene.blocks.length >= MAX_BLOCKS && !scene.blocks.some((b) => b.id === ignoreId)) {
    return { ok: false, reason: `积木数量不得超过 ${MAX_BLOCKS} 个` };
  }
  if (
    candidate.x < 0 || candidate.y < 0 ||
    candidate.x + candidate.sx > GRID_SIZE || candidate.y + candidate.sy > GRID_SIZE
  ) {
    return { ok: false, reason: '积木超出 12×12 场景边界' };
  }
  if (candidate.z < 0 || candidate.h <= 0) {
    return { ok: false, reason: '底面高度与高度值必须为正' };
  }
  const box = blockAABB(candidate);
  for (const b of scene.blocks) {
    if (b.id === ignoreId) continue;
    if (overlaps3D(box, blockAABB(b))) {
      return { ok: false, reason: `与「${b.label}」三维体积互相穿入`, conflictWith: b };
    }
  }
  if (overlaps3D(box, characterAABB(scene.character))) {
    return { ok: false, reason: '与角色占地互相穿入' };
  }
  return { ok: true };
}

/** 某世界点处积木顶面/地面的高度（角色贴地行走用）。 */
export function groundHeightAt(scene: Scene, x: number, y: number): number {
  let h = 0;
  for (const b of scene.blocks) {
    if (x >= b.x && x < b.x + b.sx && y >= b.y && y < b.y + b.sy) {
      h = Math.max(h, b.z + b.h);
    }
  }
  return h;
}

/**
 * 角色能否把中心移动到 (x,y)：边界 + 与积木的身体穿入检测。
 * fromZ 为出发底面高度（调用方保证等于起点地面高度），单步抬升不得超过 1 级。
 */
export function canCharacterMoveTo(
  scene: Scene,
  x: number,
  y: number,
  fromZ: number = groundHeightAt(scene, scene.character.x, scene.character.y),
): { ok: boolean; reason?: string } {
  const margin = 0.01;
  if (
    x - CHAR_SX / 2 < -margin || y - CHAR_SY / 2 < -margin ||
    x + CHAR_SX / 2 > GRID_SIZE + margin || y + CHAR_SY / 2 > GRID_SIZE + margin
  ) {
    return { ok: false, reason: '角色不能走出 12×12 场景' };
  }
  const targetZ = groundHeightAt(scene, x, y);
  const probe: Character = { x, y, z: targetZ };
  const charBox = characterAABB(probe);
  for (const b of scene.blocks) {
    const bb = blockAABB(b);
    if (overlaps3D(charBox, bb)) {
      return { ok: false, reason: `被「${b.label}」挡住（身体穿入墙身）` };
    }
  }
  // 台阶高度限制：单步抬升必须小于 1.0（标准台阶每级 0.5；1.0 需分两步走）
  if (targetZ - fromZ >= 1.0 - 1e-9) {
    return { ok: false, reason: `台阶过高：单步抬升需小于 1.0 格（当前需抬升 ${(targetZ - fromZ).toFixed(1)}）` };
  }
  return { ok: true };
}

export const CHAR_MOVE_STEP = 0.5;
export const CHAR_DIMENSIONS = { sx: CHAR_SX, sy: CHAR_SY, h: CHAR_HEIGHT };
