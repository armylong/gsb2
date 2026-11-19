import { BindingMap, cloneBindings, defaultBindings } from './bindings';
import { Recording, simulateEvents } from './recording';
import { World } from './world';

export interface Demo {
  id: string;
  name: string;
  description: string;
  apply: (world: World) => void;
}

function resetWorld(world: World, bindings?: BindingMap) {
  world.stopPlayback();
  world.stopRecording();
  world.engine.bindings = bindings ?? defaultBindings();
  world.engine.clearAll();
  world.sim.reset({ scene: 'game' });
  if (world.engine.scene !== 'game') world.engine.setScene('game');
  world.log = [];
}

/** 构造一份自带核对点的录像（演示用，等价于「先录制再回放」） */
function forgeRecording(
  name: string,
  initial: Recording['initial'],
  events: Recording['events'],
  durationTicks: number,
): Recording {
  const { checkpoints, final } = simulateEvents(initial, events, durationTicks);
  return { version: 1, name, durationTicks, initial, events, checkpoints, final };
}

export const DEMOS: Demo[] = [
  {
    id: 'combo-priority',
    name: '演示 1：单键与组合键竞争',
    description:
      '绑定 E=交互、Shift+E=冲刺。脚本依次按下 E、Shift+E、然后先松开 Shift（E 仍按住）。' +
      '预期：Shift+E 只触发冲刺；松开 Shift 不会凭空补一次交互。',
    apply(world) {
      const b = defaultBindings();
      b.game.interact = { code: 'KeyE', modifiers: [] };
      b.game.dash = { code: 'KeyE', modifiers: ['Shift'] };
      resetWorld(world, b);
      const e = world.engine;
      world.runScript([
        { tick: 10, run: () => e.keyDown('KeyE') },
        { tick: 30, run: () => e.keyUp('KeyE') },
        { tick: 60, run: () => e.keyDown('ShiftLeft') },
        { tick: 70, run: () => e.keyDown('KeyE') },
        { tick: 90, run: () => e.keyUp('ShiftLeft') },
        { tick: 110, run: () => e.keyUp('KeyE') },
        { tick: 130, run: () => e.keyDown('KeyE') },
        { tick: 150, run: () => e.keyUp('KeyE') },
      ]);
    },
  },
  {
    id: 'menu-reuse',
    name: '演示 2：菜单场景复用同一按键',
    description:
      '游戏与菜单都把 E 绑定为「交互」。脚本在游戏中按 E（交互+1），切到菜单再按 E（确认+1），' +
      '按 Esc 返回游戏，再按 E（交互+1）。同键在不同场景各走各的绑定。',
    apply(world) {
      const b = defaultBindings();
      b.game.interact = { code: 'KeyE', modifiers: [] };
      b.menu.interact = { code: 'KeyE', modifiers: [] };
      resetWorld(world, b);
      const e = world.engine;
      world.runScript([
        { tick: 10, run: () => e.keyDown('KeyE') },
        { tick: 20, run: () => e.keyUp('KeyE') },
        { tick: 40, run: () => world.setScene('menu') },
        { tick: 60, run: () => e.keyDown('KeyE') },
        { tick: 70, run: () => e.keyUp('KeyE') },
        { tick: 90, run: () => e.keyDown('Escape') },
        { tick: 100, run: () => e.keyUp('Escape') },
        { tick: 120, run: () => e.keyDown('KeyE') },
        { tick: 130, run: () => e.keyUp('KeyE') },
      ]);
    },
  },
  {
    id: 'rebind-replay',
    name: '演示 3：录制后改键再回放',
    description:
      '先用默认绑定「录制」一段移动+冲刺+交互，然后把交互改成 J、冲刺改成 Shift+J、移动改成方向键，' +
      '再回放录像。回放作用于逻辑动作层，与当前绑定无关，最终位置和交互次数必须一致。',
    apply(world) {
      resetWorld(world);
      const rec = forgeRecording(
        '演示录像（默认绑定录制）',
        { x: 240, y: 180, scene: 'game' },
        [
          { tick: 0, type: 'down', action: 'moveRight' },
          { tick: 30, type: 'edge', action: 'interact' },
          { tick: 40, type: 'edge', action: 'dash' },
          { tick: 60, type: 'up', action: 'moveRight' },
          { tick: 60, type: 'down', action: 'moveDown' },
          { tick: 90, type: 'edge', action: 'interact' },
          { tick: 120, type: 'up', action: 'moveDown' },
        ],
        180,
      );
      world.recordings.push(rec);
      // 录制完成后换一套完全不同的按键
      const b = cloneBindings(defaultBindings());
      b.game.moveUp = { code: 'ArrowUp', modifiers: [] };
      b.game.moveDown = { code: 'ArrowDown', modifiers: [] };
      b.game.moveLeft = { code: 'ArrowLeft', modifiers: [] };
      b.game.moveRight = { code: 'ArrowRight', modifiers: [] };
      b.game.interact = { code: 'KeyJ', modifiers: [] };
      b.game.dash = { code: 'KeyJ', modifiers: ['Shift'] };
      world.engine.bindings = b;
      world.startPlayback(rec);
    },
  },
];
