/**
 * 应用状态与编辑操作。
 *
 * 与渲染分离：这里只维护 world、选中格、当前材质，
 * 每次编辑后统一发出 change 事件，渲染层据此重建脏块。
 */
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import {
  createSampleWorld,
  DEFAULT_SIZE,
  DEFAULT_CHUNK_SIZE,
} from '../voxel/scene.js';
import { verifyChunkConsistency } from '../voxel/mesher.js';
import { isKnownMaterial } from '../voxel/materials.js';

export class EditorState {
  constructor({ onChange } = {}) {
    this.world = createSampleWorld();
    // 快照只读：用于“恢复初始样例”，编辑不会改动它。
    this.initialSnapshot = this.world.toSnapshot();
    this.selected = null; // { x, y, z } 或 null
    this.hovered = null;
    this.currentMaterial = 'stone';
    this.onChange = onChange ?? (() => {});
    this.lastEdit = null;
  }

  setMaterial(material) {
    if (!isKnownMaterial(material)) return;
    this.currentMaterial = material;
    this.onChange({ type: 'material', material });
  }

  select(position) {
    const next = position ? { ...position } : null;
    const same =
      (this.selected === null && next === null) ||
      (this.selected &&
        next &&
        this.selected.x === next.x &&
        this.selected.y === next.y &&
        this.selected.z === next.z);
    if (same) return;
    this.selected = next;
    this.onChange({ type: 'selection', selected: this.selected });
  }

  setHovered(position) {
    const next = position ? { ...position } : null;
    const same =
      (this.hovered === null && next === null) ||
      (this.hovered &&
        next &&
        this.hovered.x === next.x &&
        this.hovered.y === next.y &&
        this.hovered.z === next.z);
    if (same) return;
    this.hovered = next;
    this.onChange({ type: 'hover', hovered: this.hovered });
  }

  placeBlock(position) {
    if (!position) return false;
    const material = this.currentMaterial;
    // 用 add 而不是 set：添加模式下点到的位置若已被占用（例如透明块），
    // 不应该静默覆盖原有方块。
    const changed = this.world.add(position.x, position.y, position.z, material);
    if (changed) {
      this.lastEdit = { type: 'place', position: { ...position }, material };
      this.selected = { ...position };
      // 脏块由渲染层统一 consumeDirtyChunks；这里不要抢先清空。
      this.onChange({ type: 'edit', selected: this.selected });
    }
    return changed;
  }

  deleteBlock(position) {
    if (!position) return false;
    const changed = this.world.remove(position.x, position.y, position.z);
    if (changed) {
      this.lastEdit = { type: 'delete', position: { ...position } };
      this.onChange({ type: 'edit' });
    }
    return changed;
  }

  /**
   * 恢复初始样例。
   * 复用同一个 world 实例，避免渲染层持有过期引用；
   * 快照恢复会标记所有块为脏并触发全量重建。
   */
  reset() {
    this.world.loadSnapshot(this.initialSnapshot);
    this.selected = null;
    this.hovered = null;
    this.lastEdit = { type: 'reset' };
    this.onChange({ type: 'reset' });
  }

  clearAll() {
    this.world.clear();
    this.selected = null;
    this.hovered = null;
    this.lastEdit = { type: 'clear' };
    this.onChange({ type: 'clear' });
  }

  getStats() {
    return this.world.getStats();
  }

  selfCheck() {
    return verifyChunkConsistency(this.world);
  }
}

export function createState(options) {
  return new EditorState(options);
}

export { VoxelWorld, DEFAULT_SIZE, DEFAULT_CHUNK_SIZE };
