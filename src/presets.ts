import * as THREE from 'three';

export interface Preset {
  name: string;
  closed: boolean;
  points: [number, number, number][];
}

export const PRESETS: Preset[] = [
  {
    name: '空间弯曲',
    closed: false,
    points: [
      [-4, 0, -2], [-1.5, 1.5, 1.5], [1, -0.5, 2.5],
      [3, 1.5, 0.5], [4.5, 0.5, -2],
    ],
  },
  {
    name: '含竖直段',
    closed: false,
    points: [
      [-4, 0, 0], [-1.5, 0, 0], [-1.5, 3, 0],
      [1, 3, 1], [3.5, 1, 1.5],
    ],
  },
  {
    name: '闭环',
    closed: true,
    points: [
      [3, 0, 0], [2, 1.2, 1], [0, 2.2, 0], [-2, 1.2, -1],
      [-3, 0, 0], [-2, -1.2, 1], [0, -2.2, 0], [2, -1.2, -1],
    ],
  },
];

export function toVectors(p: Preset): THREE.Vector3[] {
  return p.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
}
