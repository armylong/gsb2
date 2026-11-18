import * as THREE from 'three';

/**
 * 12 个稳定的对象身份颜色（色相在色环上均匀分布，亮度经过人工挑选，
 * 在深色背景上均可辨识）。多对象同时选中时各自颜色固定，不随选择顺序变化。
 */
export const OBJECT_COLORS: THREE.Color[] = [
  '#4aa3ff',
  '#ff6b6b',
  '#51d88a',
 '#ffd166',
  '#c792ea',
  '#ff9f43',
  '#26d0ce',
  '#f368e0',
  '#a0e548',
  '#ff7ab6',
  '#7f8cff',
  '#67e8f9',
].map((hex) => new THREE.Color(hex));

/** 遮挡轮廓使用的暗色（在对应对象本色基础上压暗，虚线绘制）。 */
export function hiddenColorOf(c: THREE.Color): THREE.Color {
  return c.clone().multiplyScalar(0.42);
}
