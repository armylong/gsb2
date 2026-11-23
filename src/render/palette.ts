import * as THREE from 'three';

export const COLORS = {
  original: 0x5a6b80,
  offset: 0xd8e3ef,
  sideNormal: 0x4fc3a1,
  sideProblem: 0xf2545f,
  backface: 0x8a93a6,
  wire: 0x2b3542,
  sourceWire: 0xffb454,
  holeEdge: 0x54b6ff,
  selection: 0xffd166,
  gap: 0xff9f1c,
  fold: 0xff5d73,
  intersection: 0xff2d55,
  ghost: 0x93a4b8,
  region: 0x2fd8ff,
} as const;

export function doubleSided(color: number, options: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.05,
    roughness: 0.62,
    side: THREE.DoubleSide,
    flatShading: false,
    ...options,
  });
}

let pointTexture: THREE.Texture | null = null;

/** 圆点贴图: 默认 PointsMaterial 是方块, 换成圆点更易读 */
export function dotTexture(): THREE.Texture {
  if (pointTexture) return pointTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  pointTexture = texture;
  return texture;
}

export function lineMaterial(color: number, opacity = 1, width = 1): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: true,
    depthWrite: opacity >= 1,
    linewidth: width,
  });
}
