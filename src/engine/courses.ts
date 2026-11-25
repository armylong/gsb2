import { vec } from '../vec';
import type { Buoy, CurrentZone, WindState } from './types';
import type { CourseDef } from './course';

/** 初始风：北风（向屏幕下方吹），风眼在正北（屏幕上方）。玩家要之字向上走。 */
export const DEFAULT_WIND: WindState = { dir: Math.PI / 2, speed: 6 };

export const BUOYS: Buoy[] = [
  { id: 1, name: '1 号浮标', pos: vec(500, 150), radius: 14 },
  { id: 2, name: '2 号浮标', pos: vec(760, 330), radius: 14 },
  { id: 3, name: '3 号浮标', pos: vec(240, 520), radius: 14 },
  { id: 4, name: '4 号浮标', pos: vec(700, 700), radius: 14 },
  { id: 5, name: '5 号警示浮标', pos: vec(500, 470), radius: 12 },
];

/** 横向水流区：覆盖场中央的一条东西向水带，水流向东。 */
export const CURRENTS: CurrentZone[] = [
  {
    x0: 40,
    x1: 960,
    y0: 360,
    y1: 580,
    velocity: vec(1.4, 0),
    feather: 45,
  },
];

const GATE_HALF_WIDTH = 80;

/**
 * 路线一：迎风之字。
 * 从底部出发，近迎风换舷上行绕过 1 号标（左舷侧），
 * 再顺风回到 2 号标（右舷侧），最后到终点门。
 */
export const COURSE_1: CourseDef = {
  id: 'upwind',
  name: '路线一 · 迎风之字',
  description: '顶风无法直行，用近迎风左右换舷爬到 1 号标，从左舷侧绕过，再顺风回到 2 号标。',
  startPos: vec(500, 830),
  startHeading: -Math.PI / 2 + Math.PI / 180 * 50,
  defaultSheet: 0.12,
  gates: [
    {
      buoyId: 1,
      center: vec(500, 150),
      legDir: vec(0, -1),
      halfWidth: GATE_HALF_WIDTH,
      requiredSide: 'port',
      label: '1 号标（左舷侧）',
    },
    {
      buoyId: 2,
      center: vec(760, 330),
      legDir: vec(0.72, 0.69),
      halfWidth: GATE_HALF_WIDTH,
      requiredSide: 'starboard',
      label: '2 号标（右舷侧）',
    },
    {
      buoyId: null,
      center: vec(500, 820),
      legDir: vec(-0.55, 0.83),
      halfWidth: 60,
      requiredSide: null,
      label: '终点门',
    },
  ],
};

/**
 * 路线二：横穿水流。
 * 连续横风换舷，两次穿过中部水流带，体会漂移对绕标侧别的影响。
 */
export const COURSE_2: CourseDef = {
  id: 'current',
  name: '路线二 · 横穿水流',
  description: '依次绕过 3、4 号标，途中两次进入横向水流带；提前修正流压，别被推过线。',
  startPos: vec(120, 800),
  startHeading: -Math.PI / 2 + Math.PI / 180 * 50,
  defaultSheet: 0.3,
  gates: [
    {
      buoyId: 3,
      center: vec(240, 520),
      legDir: vec(0.32, -0.95),
      halfWidth: GATE_HALF_WIDTH,
      requiredSide: 'starboard',
      label: '3 号标（右舷侧）',
    },
    {
      buoyId: 4,
      center: vec(700, 700),
      legDir: vec(0.92, 0.39),
      halfWidth: GATE_HALF_WIDTH,
      requiredSide: 'port',
      label: '4 号标（左舷侧）',
    },
    {
      buoyId: 2,
      center: vec(760, 330),
      legDir: vec(0.12, -0.99),
      halfWidth: GATE_HALF_WIDTH,
      requiredSide: 'starboard',
      label: '2 号标（右舷侧）',
    },
    {
      buoyId: null,
      center: vec(150, 260),
      legDir: vec(-0.86, -0.51),
      halfWidth: 60,
      requiredSide: null,
      label: '终点门',
    },
  ],
};

export const COURSES: CourseDef[] = [COURSE_1, COURSE_2];
