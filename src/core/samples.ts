/** 程序生成的样例路径，全部为场景坐标，不依赖外部素材 */
import { Vec2 } from './math2d';

export interface SamplePath {
  id: string;
  name: string;
  closed: boolean;
  points: Vec2[];
}

export const SAMPLES: SamplePath[] = [
  {
    id: 'line',
    name: '直线',
    closed: false,
    points: [
      { x: -4, y: 0 },
      { x: 4, y: 0 },
    ],
  },
  {
    id: 'right-angle',
    name: '直角折线',
    closed: false,
    points: [
      { x: -4, y: -2 },
      { x: 2, y: -2 },
      { x: 2, y: 3 },
    ],
  },
  {
    id: 'sharp',
    name: '尖角折线（小夹角）',
    closed: false,
    points: [
      { x: -4, y: 2 },
      { x: 1, y: 0 },
      { x: -4, y: -2 },
    ],
  },
  {
    id: 'multi',
    name: '多转角折线',
    closed: false,
    points: [
      { x: -5, y: 2.5 },
      { x: -1, y: 2.5 },
      { x: -1, y: -1 },
      { x: 3, y: -1 },
      { x: 3, y: 2 },
      { x: 5.5, y: 2 },
    ],
  },
  {
    id: 'rect',
    name: '闭合矩形',
    closed: true,
    points: [
      { x: -3, y: -2 },
      { x: 3, y: -2 },
      { x: 3, y: 2 },
      { x: -3, y: 2 },
    ],
  },
  {
    id: 'triangle',
    name: '闭合尖角三角形',
    closed: true,
    points: [
      { x: -4, y: -2 },
      { x: 4, y: -2 },
      { x: -2.5, y: 1.2 },
    ],
  },
  {
    id: 'duplicates',
    name: '含连续重复点',
    closed: false,
    points: [
      { x: -4, y: 1 },
      { x: -4, y: 1 },
      { x: -1, y: 1 },
      { x: -1, y: 1 },
      { x: -1, y: 1 },
      { x: -1, y: -2 },
      { x: 3, y: -2 },
      { x: 3, y: -2 },
    ],
  },
];
