import { ACTION_MAP, ActionId, BindingMap, SceneId, resolveActive } from './bindings';
import { Chord } from './keys';

export type EngineEvent =
  | { type: 'actionDown'; action: ActionId }
  | { type: 'actionUp'; action: ActionId }
  | { type: 'edge'; action: ActionId }
  | { type: 'scene'; scene: SceneId };

type Trigger = 'keydown' | 'keyup' | 'scene' | 'clear';

/**
 * 输入引擎：跟踪物理键状态，按当前场景的绑定解析出激活动作。
 *
 * 边沿动作（交互/暂停/冲刺）规则：
 *  - 只在动作由「未激活 → 激活」且触发源是 keydown 时触发一次；
 *  - 系统重复按键（repeat）不会产生新的 keydown 语义，不会重复触发；
 *  - 若激活是因为「松开修饰键」（如 Shift+E 冲刺后松开 Shift，E 仍在按住），
 *    单键动作进入激活状态但被闩锁抑制，不会凭空触发一次交互；
 *    直到主键完全松开后再按下才会触发。
 */
export class InputEngine {
  private pressed = new Set<string>();
  private active = new Map<ActionId, Chord>();
  private latched = new Set<ActionId>();
  private listeners = new Set<(e: EngineEvent) => void>();

  scene: SceneId = 'game';
  /** 为 false 时忽略所有真实按键（录制回放、捕获模式期间使用） */
  enabled = true;

  constructor(public bindings: BindingMap) {}

  subscribe(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: EngineEvent) {
    for (const fn of this.listeners) fn(e);
  }

  getPressed(): ReadonlySet<string> {
    return this.pressed;
  }

  getActive(): ReadonlyMap<ActionId, Chord> {
    return this.active;
  }

  keyDown(code: string): void {
    if (!this.enabled) return;
    // 已按住的键（含系统重复事件）直接忽略，不会产生新的边沿
    if (this.pressed.has(code)) return;
    this.pressed.add(code);
    this.recompute('keydown');
  }

  keyUp(code: string): void {
    if (!this.enabled) return;
    if (!this.pressed.delete(code)) return;
    this.recompute('keyup');
  }

  setScene(scene: SceneId): void {
    if (this.scene === scene) return;
    this.scene = scene;
    // 切换场景后旧场景按住的动作全部释放；新场景下因按键仍按住而激活的
    // 边沿动作不触发（trigger 为 'scene'，等同 keyup 的抑制逻辑）
    this.recompute('scene');
    this.emit({ type: 'scene', scene });
  }

  /** 窗口失焦、暂停等情况：清空所有按住状态并释放动作 */
  clearAll(): void {
    if (this.pressed.size === 0 && this.active.size === 0) return;
    this.pressed.clear();
    this.recompute('clear');
  }

  private recompute(trigger: Trigger): void {
    const next = resolveActive(this.bindings, this.scene, this.pressed);
    for (const [action] of this.active) {
      if (!next.has(action)) {
        this.emit({ type: 'actionUp', action });
        this.latched.delete(action);
      }
    }
    for (const [action] of next) {
      if (this.active.has(action)) continue;
      this.emit({ type: 'actionDown', action });
      if (ACTION_MAP[action].kind === 'edge') {
        if (trigger === 'keydown' && !this.latched.has(action)) {
          this.emit({ type: 'edge', action });
        }
        // 无论是否触发都闩锁，直到动作解除
        this.latched.add(action);
      }
    }
    this.active = next;
  }
}
