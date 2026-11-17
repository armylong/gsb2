/**
 * FieldModel —— 场景数据层（不依赖 three.js，可在 Node 下单测）
 *
 * 身份不变量（整个工具正确性的基石）：
 *   每个物件在生成时获得稳定 id，且 id === InstancedMesh 的 instanceIndex，
 *   之后永不重排。移动只改位置矩阵，隐藏只把缩放置 0，
 *   因此选择集里存 id 就永远指向同一个物件，与画面位置无关。
 */

/** 确定性 PRNG（mulberry32），保证每次生成的场景可复现 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FieldModel {
  /**
   * @param {object} opts
   * @param {number} opts.count 物件总数（默认 5000）
   * @param {number} opts.cols 网格列数
   * @param {number} opts.spacing 网格间距
   * @param {number} opts.seed 随机种子
   */
  constructor({ count = 5000, cols = 100, spacing = 1.2, seed = 20261117 } = {}) {
    const rand = mulberry32(seed);
    this.count = count;
    this.spacing = spacing;

    /** 稳定 id 列表（= 下标，仅作为显式身份语义保留） */
    this.ids = Array.from({ length: count }, (_, i) => i);

    /** 每个 id 的世界坐标 [x, y, z] */
    this.positions = new Array(count);
    /** 每个 id 是否隐藏（隐藏不删除、不重排） */
    this.hidden = new Uint8Array(count);
    /** 隐藏物件 id 计数 */
    this.hiddenCount = 0;

    const rows = Math.ceil(count / cols);
    const offX = ((cols - 1) * spacing) / 2;
    const offZ = ((rows - 1) * spacing) / 2;

    for (let id = 0; id < count; id++) {
      const col = id % cols;
      const row = Math.floor(id / cols);
      // 规则网格 + 小幅抖动：形成密集、有遮挡的三维阵列，且外观完全一致
      const jitterX = (rand() - 0.5) * spacing * 0.25;
      const jitterZ = (rand() - 0.5) * spacing * 0.25;
      const jitterY = (rand() - 0.5) * spacing * 0.2;
      this.positions[id] = [
        col * spacing - offX + jitterX,
        jitterY,
        row * spacing - offZ + jitterZ,
      ];
    }

    /**
     * 撤销栈：每次批量隐藏压入一组 id。
     * “恢复全部”是另一种语义（一次性恢复所有隐藏件），会清空撤销栈。
     */
    this._undoStack = [];
  }

  has(id) {
    return id >= 0 && id < this.count;
  }

  getPosition(id) {
    return this.positions[id];
  }

  isHidden(id) {
    return this.hidden[id] === 1;
  }

  get visibleCount() {
    return this.count - this.hiddenCount;
  }

  /**
   * 移动物件：只改坐标，id 与实例下标均不变。
   * @returns 实际发生移动的 id 列表（隐藏物件不会被移动，跳过）
   */
  move(ids, delta) {
    const moved = [];
    for (const id of ids) {
      if (!this.has(id) || this.hidden[id]) continue;
      const p = this.positions[id];
      p[0] += delta.x;
      p[1] = Math.max(0.3, p[1] + delta.y);
      p[2] += delta.z;
      moved.push(id);
    }
    return moved;
  }

  /**
   * 批量隐藏：已隐藏的 id 自动去重（重复执行不产生重复记录）。
   * @returns 本次新隐藏的 id 列表
   */
  hide(ids) {
    const batch = [];
    for (const id of ids) {
      if (this.has(id) && !this.hidden[id]) {
        this.hidden[id] = 1;
        batch.push(id);
      }
    }
    if (batch.length > 0) {
      this.hiddenCount += batch.length;
      this._undoStack.push(batch);
    }
    return batch;
  }

  /** 撤销最近一次批量隐藏，返回恢复的 id 列表（无批次时为空数组） */
  undoHide() {
    const batch = this._undoStack.pop();
    if (!batch) return [];
    for (const id of batch) {
      this.hidden[id] = 0;
    }
    this.hiddenCount -= batch.length;
    return batch;
  }

  canUndoHide() {
    return this._undoStack.length > 0;
  }

  /** 恢复全部隐藏物件，并清空撤销栈 */
  restoreAll() {
    const restored = [];
    for (let id = 0; id < this.count; id++) {
      if (this.hidden[id]) {
        this.hidden[id] = 0;
        restored.push(id);
      }
    }
    this.hiddenCount = 0;
    this._undoStack.length = 0;
    return restored;
  }
}
