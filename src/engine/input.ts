import type { InputState } from './types';

/**
 * 键盘输入层。
 * - jumpQueued 只在物理 keydown（repeat=false）时置位，每个引擎步帧消费一次；
 *   浏览器长按产生的 repeat 事件与物理长按都不会再次起跳。
 * - 窗口失焦 / 切后台时清空全部按键，并通过 onBlur 通知宿主暂停，
 *   保证不会残留“按住”状态。
 */
export class KeyboardInput {
  private left = false;
  private right = false;
  private jumpQueued = false;
  private jumpHeld = false;
  readonly onBlur: () => void;

  constructor(target: Window, onBlur: () => void) {
    this.onBlur = onBlur;
    target.addEventListener('keydown', this.handleKeyDown);
    target.addEventListener('keyup', this.handleKeyUp);
    target.addEventListener('blur', this.handleBlur);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  dispose(target: Window): void {
    target.removeEventListener('keydown', this.handleKeyDown);
    target.removeEventListener('keyup', this.handleKeyUp);
    target.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('visibilitychange', this.handleVisibility);
  }

  private isGameKey(code: string): boolean {
    return code === 'ArrowLeft' || code === 'ArrowRight' || code === 'ArrowUp' || code === 'Space' || code === 'KeyA' || code === 'KeyD' || code === 'KeyW';
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.isGameKey(e.code)) return;
    e.preventDefault();
    // e.repeat=true 是浏览器长按重复事件，直接忽略
    if (e.repeat) return;
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.left = true;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = true;
        break;
      case 'ArrowUp':
      case 'KeyW':
      case 'Space':
        if (!this.jumpHeld) this.jumpQueued = true;
        this.jumpHeld = true;
        break;
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.left = false;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = false;
        break;
      case 'ArrowUp':
      case 'KeyW':
      case 'Space':
        this.jumpHeld = false;
        break;
    }
  };

  private handleBlur = (): void => {
    this.clear();
    this.onBlur();
  };

  private handleVisibility = (): void => {
    if (document.hidden) {
      this.clear();
      this.onBlur();
    }
  };

  /** 清空全部按住状态（失焦 / 暂停 / 重置时调用） */
  clear(): void {
    this.left = false;
    this.right = false;
    this.jumpHeld = false;
    this.jumpQueued = false;
  }

  /** 取出一个引擎步帧的输入；jumpPressed 为一次性边沿 */
  consume(): InputState {
    const move = (this.right ? 1 : 0) - (this.left ? 1 : 0);
    const jumpPressed = this.jumpQueued;
    this.jumpQueued = false;
    return { move, jumpPressed };
  }

  /** 暂停期间丢弃输入，但保留当前按住态供 HUD 显示 */
  peekHeld(): { left: boolean; right: boolean; jump: boolean } {
    return { left: this.left, right: this.right, jump: this.jumpHeld };
  }
}
