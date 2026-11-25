import { createBleedFixture, createLeafAtlas, type RGBAImage } from './image.ts';
import { buildNaiveMipChain, buildSafeMipChain } from './mips.ts';

export interface AtlasCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

function pixel(image: RGBAImage, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

function maxDiff(a: [number, number, number], b: [number, number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

export function runAtlasChecks(): {
  checks: AtlasCheck[];
  atlas: RGBAImage;
  safeAtlas: RGBAImage[];
  naiveAtlas: RGBAImage[];
  fixture: RGBAImage;
  safeFixture: RGBAImage[];
  naiveFixture: RGBAImage[];
} {
  const atlas = createLeafAtlas();
  const safeAtlas = buildSafeMipChain(atlas);
  const naiveAtlas = buildNaiveMipChain(atlas);
  const fixture = createBleedFixture();
  const safeFixture = buildSafeMipChain(fixture);
  const naiveFixture = buildNaiveMipChain(fixture);

  const safeEdge = pixel(safeFixture[1], 0, 0);
  const safeNeighbor = pixel(safeFixture[1], 1, 1);
  const naiveEdge = pixel(naiveFixture[1], 0, 0);

  const red: [number, number, number] = [255, 0, 0];
  const blue: [number, number, number] = [0, 0, 255];
  const safeEdgeDiff = maxDiff([safeEdge[0], safeEdge[1], safeEdge[2]], red);
  const safeNeighborDiff = maxDiff([safeNeighbor[0], safeNeighbor[1], safeNeighbor[2]], blue);

  const checks: AtlasCheck[] = [
    {
      id: 'dirty-fringe',
      label: '透明底脏 RGB 不进入安全缩小层',
      pass: safeEdgeDiff <= 1,
      detail: `安全 L1 边缘 RGBA=(${safeEdge.join(', ')})，应接近 (255,0,0,64)；最大通道差 ${safeEdgeDiff}。`,
    },
    {
      id: 'neighbor-color',
      label: '相邻蓝格不借色给红格边缘',
      pass: safeNeighborDiff <= 1 && safeEdge[2] === 0,
      detail: `红格边缘=(${safeEdge.join(', ')})，蓝格边缘=(${safeNeighbor.join(', ')})；通道差 ${safeNeighborDiff}。`,
    },
    {
      id: 'naive-control',
      label: '对照算法确实能复现脏边（说明测试有效）',
      pass: naiveEdge[2] > 120,
      detail: `非预乘直接平均的 L1 边缘=(${naiveEdge.join(', ')})，透明像素里的品红把 B 通道抬到 ${naiveEdge[2]}。`,
    },
  ];

  return { checks, atlas, safeAtlas, naiveAtlas, fixture, safeFixture, naiveFixture };
}
