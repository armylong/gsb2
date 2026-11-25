/** 渲染层使用的颜色与尺寸常量，引擎本身只用颜色字符串键。 */
export interface ColorDef {
  key: string;
  name: string;
  /** 彩带主色。 */
  main: string;
  /** 深色描边/阴影。 */
  dark: string;
  /** 浅色高光。 */
  light: string;
}

export const COLOR_DEFS: Record<string, ColorDef> = {
  red: {
    key: 'red',
    name: '朱红',
    main: '#d64545',
    dark: '#8f2323',
    light: '#f08a8a',
  },
  blue: {
    key: 'blue',
    name: '靛蓝',
    main: '#3d6fd4',
    dark: '#24478f',
    light: '#86a8ef',
  },
  green: {
    key: 'green',
    name: '松绿',
    main: '#3a9d6e',
    dark: '#236b48',
    light: '#82cfac',
  },
};

export const COLOR_ORDER = ['red', 'blue', 'green'];

export function colorDef(key: string): ColorDef {
  return (
    COLOR_DEFS[key] ?? {
      key,
      name: key,
      main: '#888888',
      dark: '#555555',
      light: '#bbbbbb',
    }
  );
}

export const THEME = {
  boardBg: '#f7f2e8',
  boardBorder: '#4a3f33',
  gridLine: '#d8cfbd',
  hole: '#3a342d',
  holeInner: '#211d18',
  targetRing: '#e8a33d',
  targetRingOk: '#4caf72',
  conflict: '#e23b3b',
  conflictGlow: 'rgba(226, 59, 59, 0.35)',
  selectFill: 'rgba(70, 120, 220, 0.18)',
  selectStroke: '#4678dc',
  hoverFill: 'rgba(70, 120, 220, 0.10)',
  portLabel: '#3b332a',
  cellRadius: 7,
  ribbonWidth: 13,
};
