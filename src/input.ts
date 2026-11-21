import type { Input } from './sim/types.js';

/** 键盘采集: 方向键/WASD 移动, Space/W/↑ 跳, S/↓ 松手, R 复位, 1..5 回放样例 */
export class Keyboard {
  private down = new Set<string>();
  private prevJump = false;
  /** 由主循环消费的一次性按键 */
  pressedKeys = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.pressedKeys.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
  }

  private has(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  poll(): Input {
    const jump = this.has('Space', 'KeyW', 'ArrowUp');
    const input: Input = {
      left: this.has('ArrowLeft', 'KeyA'),
      right: this.has('ArrowRight', 'KeyD'),
      down: this.has('ArrowDown', 'KeyS'),
      jump,
      jumpPressed: jump && !this.prevJump,
    };
    this.prevJump = jump;
    return input;
  }

  /** 取走并清空一次性按键 */
  drainPressed(): Set<string> {
    const s = this.pressedKeys;
    this.pressedKeys = new Set();
    return s;
  }
}
