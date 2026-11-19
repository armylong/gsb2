// 物理键位与组合键模型。所有键以 KeyboardEvent.code（物理键位）标识，与键盘布局无关。

export type Modifier = 'Shift' | 'Ctrl' | 'Alt' | 'Meta';
export const MODIFIERS: Modifier[] = ['Shift', 'Ctrl', 'Alt', 'Meta'];

export interface Chord {
  /** 主键，KeyboardEvent.code，如 'KeyE'、'ArrowUp'、'Space' */
  code: string;
  /** 需要同时按下的修饰键（抽象层，左右均可） */
  modifiers: Modifier[];
}

export const MODIFIER_CODES: Record<Modifier, string[]> = {
  Shift: ['ShiftLeft', 'ShiftRight'],
  Ctrl: ['ControlLeft', 'ControlRight'],
  Alt: ['AltLeft', 'AltRight'],
  Meta: ['MetaLeft', 'MetaRight'],
};

export function modifierOfCode(code: string): Modifier | null {
  for (const m of MODIFIERS) if (MODIFIER_CODES[m].includes(code)) return m;
  return null;
}

export function isModifierCode(code: string): boolean {
  return modifierOfCode(code) !== null;
}

/** 规范化排序后的修饰键，便于比较 */
function sortedMods(mods: Modifier[]): Modifier[] {
  return [...mods].sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
}

export function chordEquals(a: Chord, b: Chord): boolean {
  if (a.code !== b.code) return false;
  const ma = sortedMods(a.modifiers);
  const mb = sortedMods(b.modifiers);
  return ma.length === mb.length && ma.every((m, i) => m === mb[i]);
}

/** 组合键是否被当前按下的物理键集合满足（修饰键为子集匹配，多余的修饰键不影响） */
export function chordSatisfied(chord: Chord, pressed: ReadonlySet<string>): boolean {
  if (!pressed.has(chord.code)) return false;
  return chord.modifiers.every((m) => MODIFIER_CODES[m].some((c) => pressed.has(c)));
}

/** 具体程度：修饰键越多越具体 */
export function specificity(chord: Chord): number {
  return chord.modifiers.length;
}

const KEY_NAMES: Record<string, string> = {
  Space: '空格',
  Enter: '回车',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: '退格',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  CapsLock: 'CapsLock',
  ShiftLeft: '左Shift',
  ShiftRight: '右Shift',
  ControlLeft: '左Ctrl',
  ControlRight: '右Ctrl',
  AltLeft: '左Alt',
  AltRight: '右Alt',
  MetaLeft: '左Cmd',
  MetaRight: '右Cmd',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const MOD_LABEL: Record<Modifier, string> = {
  Shift: 'Shift',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Meta: 'Cmd',
};

/** 物理键位 code → 可理解名称 */
export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return '小键盘' + code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

export function chordLabel(chord: Chord): string {
  const mods = sortedMods(chord.modifiers).map((m) => MOD_LABEL[m]);
  return [...mods, keyLabel(chord.code)].join(' + ');
}

/**
 * 浏览器/操作系统保留、页面无法可靠捕获的组合。
 * 返回原因字符串；返回 null 表示可以可靠捕获。
 */
export function unreliableReason(chord: Chord): string | null {
  const mods = new Set(chord.modifiers);
  const has = (m: Modifier) => mods.has(m);
  const c = chord.code;
  const ctrlOrMeta = has('Ctrl') || has('Meta');
  if (ctrlOrMeta && c === 'KeyW') return '关闭标签页，浏览器不会把该组合交给页面';
  if (has('Meta') && c === 'KeyQ') return '退出浏览器（macOS），系统级快捷键';
  if (ctrlOrMeta && c === 'KeyN') return '新建窗口，浏览器保留';
  if (ctrlOrMeta && c === 'KeyT') return '新建标签页，浏览器保留';
  if (ctrlOrMeta && c === 'Tab') return '切换标签页，浏览器保留';
  if (ctrlOrMeta && c === 'KeyR') return '刷新页面，浏览器保留';
  if (ctrlOrMeta && c === 'KeyH') return '历史/隐藏窗口，浏览器保留';
  if (ctrlOrMeta && c === 'KeyM' && has('Meta')) return '最小化窗口（macOS），系统级快捷键';
  if (c === 'F5') return '刷新页面，多数浏览器保留';
  if (c === 'F11') return '全屏切换，浏览器保留';
  if (c === 'F12') return '开发者工具，浏览器保留';
  if (has('Alt') && c === 'Home') return '回到主页，浏览器保留';
  if (has('Alt') && (c === 'ArrowLeft' || c === 'ArrowRight')) return '前进/后退导航，浏览器保留';
  if (has('Meta') && c === 'Space') return '输入法/聚焦搜索（macOS），系统级快捷键';
  if (has('Ctrl') && c === 'Space') return '输入法切换，系统级快捷键';
  return null;
}
