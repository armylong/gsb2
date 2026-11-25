import { isBlackKey, midiToName } from '../audio/notes';

/** 电脑键盘 -> midi 的映射, 从 C4 起两个八度 */
const KEY_MAP: Record<string, number> = {
  a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71,
  k: 72, o: 73, l: 74, p: 75, ';': 76,
};

export interface KeyboardHandlers {
  noteOn: (midi: number) => void;
  noteOff: (midi: number) => void;
}

/**
 * 两八度屏幕键盘 (C4..B5), 支持鼠标按住与电脑键盘。
 * 同一音符的重复按下被吞掉, 不会重触发。
 */
export class Keyboard {
  private held = new Set<number>();
  private keyEls = new Map<number, HTMLElement>();

  constructor(container: HTMLElement, private handlers: KeyboardHandlers) {
    this.build(container);
    this.bindComputerKeyboard();
  }

  private build(container: HTMLElement): void {
    const startMidi = 60; // C4
    const endMidi = 83; // B5
    const whiteCount = this.countWhite(startMidi, endMidi);

    const whiteWrap = document.createElement('div');
    whiteWrap.className = 'white-wrap';
    whiteWrap.style.position = 'relative';
    whiteWrap.style.width = `${whiteCount * 44}px`;
    whiteWrap.style.height = '150px';

    let whiteIndex = 0;
    const blackPositions: { midi: number; left: number }[] = [];

    for (let midi = startMidi; midi <= endMidi; midi++) {
      const el = document.createElement('div');
      el.dataset.midi = String(midi);
      const label = document.createElement('span');
      label.className = 'key-label';
      label.textContent = midiToName(midi);

      if (isBlackKey(midi)) {
        el.className = 'key black-key';
        el.style.left = `${whiteIndex * 44 - 13}px`;
        blackPositions.push({ midi, left: whiteIndex * 44 - 13 });
      } else {
        el.className = 'key white-key';
        el.style.left = `${whiteIndex * 44}px`;
        el.appendChild(label);
        whiteIndex++;
      }
      this.keyEls.set(midi, el);
      this.bindPointer(el, midi);
      whiteWrap.appendChild(el);
    }

    container.appendChild(whiteWrap);
  }

  private countWhite(start: number, end: number): number {
    let n = 0;
    for (let m = start; m <= end; m++) if (!isBlackKey(m)) n++;
    return n;
  }

  private bindPointer(el: HTMLElement, midi: number): void {
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      this.press(midi);
    });
    el.addEventListener('pointerup', () => this.release(midi));
    el.addEventListener('pointercancel', () => this.release(midi));
    // 指针滑出也释放, 避免卡住
    el.addEventListener('pointerleave', (ev) => {
      if (el.hasPointerCapture(ev.pointerId)) this.release(midi);
    });
  }

  private bindComputerKeyboard(): void {
    window.addEventListener('keydown', (ev) => {
      if (ev.repeat) return;
      const target = ev.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const midi = KEY_MAP[ev.key.toLowerCase()];
      if (midi !== undefined) {
        ev.preventDefault();
        this.press(midi);
      }
    });
    window.addEventListener('keyup', (ev) => {
      const midi = KEY_MAP[ev.key.toLowerCase()];
      if (midi !== undefined) this.release(midi);
    });
  }

  private press(midi: number): void {
    if (this.held.has(midi)) return; // 吞掉重复触发
    this.held.add(midi);
    this.keyEls.get(midi)?.classList.add('pressed');
    this.handlers.noteOn(midi);
  }

  private release(midi: number): void {
    if (!this.held.has(midi)) return;
    this.held.delete(midi);
    this.keyEls.get(midi)?.classList.remove('pressed');
    this.handlers.noteOff(midi);
  }
}
