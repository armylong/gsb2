/**
 * 统一输入管理：键盘 WASD/方向键、鼠标拖拽视角、滚轮距离、Pointer Lock 可选。
 * 视角变化以增量回调抛出，由主控决定如何作用到 yaw/pitch；
 * 角色移动意图每帧采样，避免按键事件与渲染帧率耦合。
 */
export class InputManager {
  private keys = new Set<string>();
  private el: HTMLElement;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  /** 本帧鼠标累积增量（弧度由主控乘以灵敏度） */
  mouseDX = 0;
  mouseDY = 0;
  /** 滚轮累积量（正=拉远） */
  wheelDelta = 0;

  onToggleMap: (() => void) | null = null;
  onToggleCollision: (() => void) | null = null;
  onReset: (() => void) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    el.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    el.addEventListener('wheel', this.handleWheel, { passive: false });
    el.addEventListener('contextmenu', this.preventContext);
  }

  private preventContext = (e: Event) => e.preventDefault();

  private handleKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    if (e.code === 'KeyM') this.onToggleMap?.();
    if (e.code === 'KeyC') this.onToggleCollision?.();
    if (e.code === 'KeyR') this.onReset?.();
    // 防止方向键滚动页面
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private handlePointerDown = (e: PointerEvent) => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.el.setPointerCapture?.(e.pointerId);
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.mouseDX += e.clientX - this.lastX;
    this.mouseDY += e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private handlePointerUp = () => {
    this.dragging = false;
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheelDelta += e.deltaY;
  };

  /** 归一化移动意图：x=右, z=前（-Z 为前），区间 [-1,1] */
  sampleMove(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 0) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** 每帧末清零增量 */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.el.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    this.el.removeEventListener('wheel', this.handleWheel);
    this.el.removeEventListener('contextmenu', this.preventContext);
  }
}
