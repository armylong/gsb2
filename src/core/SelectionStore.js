/**
 * SelectionStore —— 选择状态层（纯逻辑，不依赖 three.js）
 *
 * 选择集只存稳定 id（Set 天然去重）：
 *   - 移动/隐藏/恢复都不改动 id，选择结果始终指向原物件；
 *   - 重复点选、重复框选同一批物件不会产生重复对象或计数错误；
 *   - 隐藏的物件若处于选中态，其选中身份保留，恢复后依旧高亮。
 */

export const MODE_REPLACE = 'replace'; // 替换选择
export const MODE_ADD = 'add';         // 追加选择
export const MODE_REMOVE = 'remove';   // 取消选择

export const MODE_LABELS = {
  [MODE_REPLACE]: '替换选择',
  [MODE_ADD]: '追加选择',
  [MODE_REMOVE]: '取消选择',
};

export class SelectionStore {
  constructor() {
    /** @type {Set<number>} 选中 id 集合 */
    this._selected = new Set();
    /** 粘滞模式（HUD 按钮 / 数字键切换） */
    this.stickyMode = MODE_REPLACE;
    /** 订阅者列表 */
    this._listeners = new Set();
  }

  get size() {
    return this._selected.size;
  }

  has(id) {
    return this._selected.has(id);
  }

  /** 按 id 升序导出，保证测试与界面输出确定、无重复 */
  values() {
    return [...this._selected].sort((a, b) => a - b);
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(change) {
    for (const fn of this._listeners) fn(change);
  }

  /**
   * 应用一次选择操作。
   * @param {number[]} ids 命中的 id 列表（允许重复，内部经 Set 去重）
   * @param {'replace'|'add'|'remove'} mode
   * @param {'point'|'box'} source 操作来源，便于界面提示
   */
  apply(ids, mode = this.stickyMode, source = 'box') {
    const unique = [...new Set(ids)].filter(Number.isInteger);
    const before = this._selected.size;

    if (mode === MODE_REPLACE) {
      this._selected = new Set(unique);
    } else if (mode === MODE_ADD) {
      for (const id of unique) this._selected.add(id);
    } else {
      for (const id of unique) this._selected.delete(id);
    }

    this._emit({
      source,
      mode,
      hits: unique,
      added: this._selected.size - before > 0 ? this._selected.size - before : 0,
      selectedSize: this._selected.size,
    });
    return unique;
  }

  /** 清空选择（不影响物件可见性） */
  clear(source = 'manual') {
    if (this._selected.size === 0) return;
    const cleared = this.values();
    this._selected.clear();
    this._emit({ source: 'clear', mode: MODE_REPLACE, hits: cleared, selectedSize: 0 });
  }

  setStickyMode(mode) {
    this.stickyMode = mode;
    this._emit({ source: 'mode', mode, hits: [], selectedSize: this._selected.size });
  }
}
