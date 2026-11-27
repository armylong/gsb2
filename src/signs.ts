import * as THREE from 'three';
import { Sign, type SizeMode } from './Sign';
import type { FaceMode } from './orientation';
import type { GlyphShape, SignTextureSpec } from './textures';

export interface SignConfig {
  id: string;
  label: string;
  anchor: [number, number, number];
  width: number;
  height: number;
  faceMode: FaceMode;
  sizeMode: SizeMode;
  fixedYaw: number;
  fixedTilt: number;
  screenRatio: number;
  onShelf: boolean;
  texture: SignTextureSpec;
}

const T = (
  title: string,
  subtitle: string,
  bg: string,
  accent: string,
  shape: GlyphShape,
  verticalTitle = false,
  flip = false,
): SignTextureSpec => ({ title, subtitle, bg, accent, shape, verticalTitle, flip });

/**
 * 七张牌：
 * - 三张地面自由牌（固定 / 全向 / 竖轴），不同高度、不同图形与文字方向
 * - 一张竖排小标记（全向 + 屏幕尺寸）
 * - 三张挂在带运动的父级架子上（覆盖三种朝向与两种尺寸模式）
 */
export const SIGN_CONFIGS: SignConfig[] = [
  {
    id: 'fixed-exit',
    label: 'A·出口立牌（固定）',
    anchor: [-8, 1.7, 2],
    width: 2.4,
    height: 1.2,
    faceMode: 'FIXED',
    sizeMode: 'WORLD',
    fixedYaw: Math.PI / 2.4,
    fixedTilt: 0,
    screenRatio: 0.22,
    onShelf: false,
    texture: T('安全出口', 'EXIT →', '#155e4f', '#35d0ba', 'arrow-right'),
  },
  {
    id: 'billboard-info',
    label: 'B·咨询台（全向·世界尺寸）',
    anchor: [-2.5, 3.4, -4.5],
    width: 2.2,
    height: 1.1,
    faceMode: 'BILLBOARD',
    sizeMode: 'WORLD',
    fixedYaw: 0,
    fixedTilt: 0,
    screenRatio: 0.22,
    onShelf: false,
    texture: T('咨询台', 'INFORMATION', '#27406b', '#7db4ff', 'circle'),
  },
  {
    id: 'ylock-warning',
    label: 'C·警示牌（仅竖轴·世界尺寸）',
    anchor: [0.8, 1.1, 1.6],
    width: 1.8,
    height: 1.8,
    faceMode: 'Y_LOCKED',
    sizeMode: 'WORLD',
    fixedYaw: -0.6,
    fixedTilt: 0,
    screenRatio: 0.22,
    onShelf: false,
    texture: T('注意脚下', 'WATCH YOUR STEP', '#7a4a12', '#ffb020', 'triangle'),
  },
  {
    id: 'screen-marker',
    label: 'D·小标记（全向·屏幕尺寸）',
    anchor: [-5.5, 5.2, -5.5],
    width: 1.1,
    height: 1.1,
    faceMode: 'BILLBOARD',
    sizeMode: 'SCREEN',
    fixedYaw: 0,
    fixedTilt: 0,
    screenRatio: 0.16,
    onShelf: false,
    texture: T('指引', 'GUIDE', '#5b2a6b', '#d896ff', 'arrow-up', true),
  },
  {
    id: 'shelf-fixed',
    label: 'E·架上固定牌（世界尺寸）',
    anchor: [-1.2, 3.05, 0],
    width: 1.5,
    height: 0.75,
    faceMode: 'FIXED',
    sizeMode: 'WORLD',
    fixedYaw: Math.PI,
    fixedTilt: 0,
    screenRatio: 0.2,
    onShelf: true,
    texture: T('区域E', 'ZONE E', '#6b2f2f', '#ff8a8a', 'chevron', false, true),
  },
  {
    id: 'shelf-ylock',
    label: 'F·架上竖轴牌（世界尺寸）',
    anchor: [0, 2.15, 0],
    width: 1.5,
    height: 0.75,
    faceMode: 'Y_LOCKED',
    sizeMode: 'WORLD',
    fixedYaw: 0.4,
    fixedTilt: 0,
    screenRatio: 0.2,
    onShelf: true,
    texture: T('区域F', 'ZONE F', '#12524d', '#4fe0c8', 'arrow-left'),
  },
  {
    id: 'shelf-screen',
    label: 'G·架上屏幕牌（全向·屏幕尺寸）',
    anchor: [1.2, 3.05, 0],
    width: 1.3,
    height: 0.75,
    faceMode: 'BILLBOARD',
    sizeMode: 'SCREEN',
    fixedYaw: 0,
    fixedTilt: 0,
    screenRatio: 0.14,
    onShelf: true,
    texture: T('区域G', 'ZONE G', '#3c3f1a', '#d9e06a', 'cross'),
  },
];

export function createSigns(shelf: THREE.Group, scene: THREE.Scene): Sign[] {
  return SIGN_CONFIGS.map((cfg) => new Sign({
    id: cfg.id,
    label: cfg.label,
    anchor: new THREE.Vector3(...cfg.anchor),
    width: cfg.width,
    height: cfg.height,
    faceMode: cfg.faceMode,
    sizeMode: cfg.sizeMode,
    fixedYaw: cfg.fixedYaw,
    fixedTilt: cfg.fixedTilt,
    screenRatio: cfg.screenRatio,
    parent: cfg.onShelf ? shelf : scene,
    texture: cfg.texture,
  }));
}
