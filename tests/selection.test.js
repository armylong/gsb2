import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SelectionStore,
  MODE_REPLACE,
  MODE_ADD,
  MODE_REMOVE,
} from '../src/core/SelectionStore.js';

test('点选替换：重复点选同一物件不产生重复对象或计数错误', () => {
  const store = new SelectionStore();

  store.apply([42], MODE_REPLACE, 'point');
  assert.deepEqual(store.values(), [42]);
  assert.equal(store.size, 1);

  // 再次点选同一个 id（含重复入参），替换模式下仍是 1 个
  store.apply([42, 42, 42], MODE_REPLACE, 'point');
  assert.deepEqual(store.values(), [42]);
  assert.equal(store.size, 1);
});

test('追加 / 取消选择：Set 语义去重，计数始终准确', () => {
  const store = new SelectionStore();
  store.apply([1, 2, 3], MODE_REPLACE, 'box');
  assert.equal(store.size, 3);

  // 追加已存在与新对象混合：只新增真正新的 id
  store.apply([2, 3, 4, 4], MODE_ADD, 'box');
  assert.deepEqual(store.values(), [1, 2, 3, 4]);
  assert.equal(store.size, 4);

  // 取消不存在的 id 不产生副作用
  store.apply([99, 100], MODE_REMOVE, 'point');
  assert.equal(store.size, 4);

  // 取消部分选择
  store.apply([1, 4], MODE_REMOVE, 'box');
  assert.deepEqual(store.values(), [2, 3]);
  assert.equal(store.size, 2);
});

test('重复执行相同框选：结果幂等，无重复对象', () => {
  const store = new SelectionStore();
  const batch = [10, 20, 30, 40, 50];

  store.apply(batch, MODE_REPLACE, 'box');
  const first = store.values();
  // 再来一次完全相同的框选（替换模式）
  store.apply(batch, MODE_REPLACE, 'box');
  assert.deepEqual(store.values(), first);
  assert.equal(store.size, batch.length);

  // 追加模式下重复同一批也不增长
  store.apply(batch, MODE_ADD, 'box');
  assert.equal(store.size, batch.length);
});

test('清空选择与变更通知', () => {
  const store = new SelectionStore();
  const events = [];
  store.subscribe((change) => events.push(change.selectedSize));

  store.apply([1, 2], MODE_REPLACE, 'box');
  store.clear();
  assert.equal(store.size, 0);
  assert.deepEqual(store.values(), []);
  assert.deepEqual(events, [2, 0]);

  // 空集合清空不发事件
  store.clear();
  assert.equal(events.length, 2);
});

test('粘滞模式切换', () => {
  const store = new SelectionStore();
  assert.equal(store.stickyMode, MODE_REPLACE);
  store.setStickyMode(MODE_ADD);
  assert.equal(store.stickyMode, MODE_ADD);
  store.apply([7]); // 使用粘滞模式
  assert.deepEqual(store.values(), [7]);
});
