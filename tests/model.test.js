import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldModel } from '../src/core/FieldModel.js';
import { SelectionStore, MODE_REPLACE } from '../src/core/SelectionStore.js';

test('程序化生成：每个物件有稳定且唯一的身份 id', () => {
  const model = new FieldModel({ count: 5000, cols: 100, seed: 1 });
  assert.equal(model.count, 5000);
  assert.equal(new Set(model.ids).size, 5000);
  // 同一种子生成结果可复现
  const again = new FieldModel({ count: 5000, cols: 100, seed: 1 });
  assert.deepEqual(again.positions[123], model.positions[123]);
});

test('移动后身份不变：选择集仍指向同一物件', () => {
  const model = new FieldModel({ count: 64, cols: 8 });
  const store = new SelectionStore();
  const before = model.getPosition(5).slice();

  store.apply([5, 6], MODE_REPLACE, 'box');
  const moved = model.move(store.values(), { x: 10, y: 1, z: -8 });

  assert.deepEqual(moved, [5, 6]);
  // id 与位置数组下标都没变，只是坐标变了
  assert.equal(model.getPosition(5)[0], before[0] + 10);
  assert.equal(model.getPosition(5)[2], before[2] - 8);
  assert.ok(store.has(5) && store.has(6));
  assert.equal(store.size, 2);
});

test('批量隐藏：去重、计数准确，选中身份保留；可逐级撤销', () => {
  const model = new FieldModel({ count: 100, cols: 10 });
  const store = new SelectionStore();
  store.apply([1, 2, 3, 4], MODE_REPLACE, 'box');

  // 重复隐藏同一批，第二次为空操作，撤销栈只记一批
  const first = model.hide([1, 2, 3, 4]);
  const second = model.hide([1, 2, 3, 4, 999]);
  assert.deepEqual(first, [1, 2, 3, 4]);
  assert.deepEqual(second, []);
  assert.equal(model.hiddenCount, 4);
  assert.equal(model.visibleCount, 96);
  for (const id of [1, 2, 3, 4]) assert.ok(model.isHidden(id));
  // 隐藏不影响选择集——恢复后仍是选中态
  assert.equal(store.size, 4);

  // 再隐藏一批，撤销栈两层
  model.hide([10, 20]);
  assert.equal(model.hiddenCount, 6);
  assert.ok(model.canUndoHide());

  const undone1 = model.undoHide();
  assert.deepEqual(undone1, [10, 20]);
  assert.equal(model.hiddenCount, 4);
  const undone2 = model.undoHide();
  assert.deepEqual(undone2, [1, 2, 3, 4]);
  assert.equal(model.hiddenCount, 0);
  assert.equal(model.canUndoHide(), false);
  assert.deepEqual(model.undoHide(), []);
});

test('恢复全部：一次性恢复并清空撤销栈', () => {
  const model = new FieldModel({ count: 50, cols: 10 });
  model.hide([1, 2]);
  model.hide([3, 4, 5]);
  const restored = model.restoreAll();
  assert.deepEqual(restored, [1, 2, 3, 4, 5]);
  assert.equal(model.hiddenCount, 0);
  assert.equal(model.canUndoHide(), false);
  assert.deepEqual(model.restoreAll(), []);
});

test('隐藏物件不参与移动，移动不会破坏隐藏状态', () => {
  const model = new FieldModel({ count: 20, cols: 5 });
  model.hide([7]);
  const moved = model.move([7, 8], { x: 5, y: 0, z: 0 });
  assert.deepEqual(moved, [8]);
  assert.ok(model.isHidden(7));
});
