import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, defaultState, SOURCE_PRESETS } from '../../src/store.js';
import { BOUNDS } from '../../src/spatial.js';

test('初始状态含 1 个听者和 3 个声源，均未播放', () => {
  const store = new Store();
  assert.equal(store.state.sources.length, 3);
  assert.ok(store.state.sources.every((s) => s.playing === false));
  assert.equal(store.state.soloId, null);
  assert.deepEqual(store.state.listener, { x: 0, y: 0, z: 0, yaw: 0 });
});

test('每次 update 只通知一次，多声源操作不互相覆盖', () => {
  const store = new Store();
  let calls = 0;
  store.subscribe(() => calls++);
  store.setPlaying('s1', true);
  store.setSourceVolume('s2', 0.3);
  store.setPlaying('s3', true);
  assert.equal(calls, 3);
  assert.equal(store.getSource('s1').playing, true);
  assert.equal(store.getSource('s2').volume, 0.3);
  assert.equal(store.getSource('s3').playing, true);
  // s1 的播放状态不受 s3 操作影响
  assert.equal(store.getSource('s1').playing, true);
});

test('位置被限制在场景边界内', () => {
  const store = new Store();
  store.setSourcePosition('s1', 999, -999, 5);
  assert.deepEqual(
    [store.getSource('s1').x, store.getSource('s1').y, store.getSource('s1').z],
    [BOUNDS.x, -BOUNDS.y, 5],
  );
  store.setListenerPosition(-999, 0, 999);
  assert.deepEqual(
    [store.state.listener.x, store.state.listener.z],
    [-BOUNDS.x, BOUNDS.z],
  );
});

test('独奏只切换 soloId，不改写各声源播放与音量', () => {
  const store = new Store();
  store.setPlaying('s1', true);
  store.setPlaying('s2', true);
  store.setSourceVolume('s2', 0.4);
  store.setSolo('s1');
  assert.equal(store.state.soloId, 's1');
  assert.equal(store.getSource('s2').playing, true);
  assert.equal(store.getSource('s2').volume, 0.4);
  // 再次独奏同一声源退出
  store.setSolo('s1');
  assert.equal(store.state.soloId, null);
});

test('togglePlaying 支持快速连续切换且最终状态正确（无残留）', () => {
  const store = new Store();
  for (let i = 0; i < 10; i++) store.togglePlaying('s1');
  assert.equal(store.getSource('s1').playing, false);
  for (let i = 0; i < 7; i++) store.togglePlaying('s1');
  assert.equal(store.getSource('s1').playing, true);
});

test('reset 恢复全部位置/朝向/音量/播放/独奏，但保留音频启用标记', () => {
  const store = new Store();
  store.setAudioEnabled(true);
  store.setListenerPosition(3, 2, -3);
  store.setListenerYaw(90);
  store.setSourcePosition('s1', -5, 1, 4);
  store.setSourceVolume('s1', 0.1);
  store.setPlaying('s1', true);
  store.setPlaying('s2', true);
  store.setSolo('s1');

  store.reset();

  const fresh = defaultState();
  assert.deepEqual(store.state.listener, fresh.listener);
  assert.deepEqual(
    store.state.sources.map((s) => ({ x: s.x, y: s.y, z: s.z, volume: s.volume, playing: s.playing })),
    fresh.sources.map((s) => ({ x: s.x, y: s.y, z: s.z, volume: s.volume, playing: s.playing })),
  );
  assert.equal(store.state.soloId, null);
  assert.equal(store.state.audioEnabled, true, '已启用的音频上下文不应被 reset 关闭');
});

test('声源预设颜色与类型互不相同，便于视听区分', () => {
  const colors = new Set(SOURCE_PRESETS.map((p) => p.color));
  const types = new Set(SOURCE_PRESETS.map((p) => p.type));
  assert.equal(colors.size, 3);
  assert.equal(types.size, 3);
});
