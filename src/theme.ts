/** 图表配色：分类色板前三槽给 F1/F2/F3，紫槽给成音，灰槽给源声 */
export interface ThemeColors {
  surface: string;
  ink: string;
  muted: string;
  grid: string;
  axis: string;
  f1: string;
  f2: string;
  f3: string;
  source: string;
  shape: string;
  output: string;
  cursor: string;
  good: string;
  warning: string;
  critical: string;
}

const LIGHT: ThemeColors = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  f1: '#2a78d6',
  f2: '#eb6834',
  f3: '#1baf7a',
  source: '#898781',
  shape: '#6250d6',
  output: '#eda100',
  cursor: '#0b0b0b',
  good: '#006300',
  warning: '#b97a00',
  critical: '#d03b3b',
};

const DARK: ThemeColors = {
  surface: '#1a1a19',
  ink: '#f0efec',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  f1: '#3987e5',
  f2: '#d95926',
  f3: '#199e70',
  source: '#898781',
  shape: '#9085e9',
  output: '#c98500',
  cursor: '#f0efec',
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#e66767',
};

export function themeColors(): ThemeColors {
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? DARK : LIGHT;
}
