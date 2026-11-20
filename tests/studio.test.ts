import { describe, expect, it } from 'vitest';
import { Studio } from '../src/studio/store';
import { createDemoConfig } from '../src/engine/demo';
import { serializeConfig } from '../src/engine/config-store';

function makeStudio() {
  return new Studio(createDemoConfig());
}

describe('Studio 单步与运行', () => {
  it('单步推进一个固定更新周期', () => {
    const studio = makeStudio();
    studio.step();
    const snap = studio.getSnapshot();
    expect(snap.machine.clockMs).toBe(16);
    expect(snap.machine.tick).toBe(1);
    expect(snap.machine.elapsedMs).toBe(16);
  });

  it('运行态输入会立即写入日志, 暂停后不再推进', () => {
    const studio = makeStudio();
    studio.queueAttack();
    studio.setHurt(true);
    const log = studio.getSnapshot().machine.log;
    expect(log.some((e) => e.type === 'input' && e.action === 'queue-attack')).toBe(true);
    expect(log.some((e) => e.type === 'input' && e.action === 'hurt')).toBe(true);
    const before = studio.getSnapshot().machine.clockMs;
    studio.pause();
    expect(studio.getSnapshot().machine.clockMs).toBe(before);
  });

  it('重置回到确定初态并清空日志', () => {
    const studio = makeStudio();
    studio.queueAttack();
    studio.step();
    studio.step();
    studio.reset();
    const snap = studio.getSnapshot();
    expect(snap.machine.clockMs).toBe(0);
    expect(snap.machine.pendingAttacks).toBe(0);
    expect(snap.machine.log).toHaveLength(2); // reset + 初始进入
    expect(snap.machine.stateId).toBe('idle');
  });

  it('慢放档位只接受白名单值', () => {
    const studio = makeStudio();
    studio.setTimeScale(0.25);
    expect(studio.getSnapshot().timeScale).toBe(0.25);
    studio.setTimeScale(3);
    expect(studio.getSnapshot().timeScale).toBe(0.25);
  });
});

describe('Studio 预览隔离', () => {
  it('进入/退出预览不改变状态机日志与待处理触发', () => {
    const studio = makeStudio();
    studio.queueAttack();
    studio.step();
    studio.step();
    const before = JSON.stringify(studio.getSnapshot().machine);
    studio.enterPreview();
    expect(studio.getSnapshot().mode).toBe('preview');
    studio.seekPreview(300);
    studio.setPreviewState('attack');
    studio.step();
    studio.togglePreviewPlay();
    studio.togglePreviewPlay();
    studio.exitPreview();
    expect(studio.getSnapshot().mode).toBe('runtime');
    expect(JSON.stringify(studio.getSnapshot().machine)).toBe(before);
  });

  it('预览不会被退出时推进时间', () => {
    const studio = makeStudio();
    studio.step();
    const clock = studio.getSnapshot().machine.clockMs;
    studio.enterPreview();
    studio.step();
    studio.step();
    expect(studio.getSnapshot().machine.clockMs).toBe(clock);
  });
});

describe('Studio 配置应用', () => {
  it('非法草稿应用被拒绝且保留当前配置', () => {
    const studio = makeStudio();
    const before = serializeConfig(studio.getSnapshot().config);
    studio.patchState('idle', { durationMs: -10 });
    const ok = studio.applyDraft();
    expect(ok).toBe(false);
    expect(serializeConfig(studio.getSnapshot().config)).toBe(before);
    const notice = studio.getSnapshot().notice;
    expect(notice?.kind).toBe('error');
    expect(notice?.details?.length).toBeGreaterThan(0);
  });

  it('合法草稿应用后重建状态机并回到初态', () => {
    const studio = makeStudio();
    studio.step();
    studio.patchState('idle', { durationMs: 2000 });
    const ok = studio.applyDraft();
    expect(ok).toBe(true);
    const snap = studio.getSnapshot();
    expect(snap.config.states.find((s) => s.id === 'idle')?.durationMs).toBe(2000);
    expect(snap.machine.clockMs).toBe(0);
    expect(snap.dirty).toBe(false);
    expect(snap.mode).toBe('runtime');
  });

  it('文本导入非法 JSON 时保留草稿与已应用配置', () => {
    const studio = makeStudio();
    const appliedBefore = serializeConfig(studio.getSnapshot().config);
    const draftBefore = serializeConfig(studio.getSnapshot().draft);
    expect(studio.importText('{ nope')).toBe(false);
    expect(serializeConfig(studio.getSnapshot().config)).toBe(appliedBefore);
    expect(serializeConfig(studio.getSnapshot().draft)).toBe(draftBefore);
  });

  it('缩短时长导致事件越界时应用被拒绝', () => {
    const studio = makeStudio();
    const before = serializeConfig(studio.getSnapshot().config);
    studio.patchState('idle', { durationMs: 900 }); // 呼吸落 1000ms 变成越界
    expect(studio.applyDraft()).toBe(false);
    expect(serializeConfig(studio.getSnapshot().config)).toBe(before);
    expect(studio.getSnapshot().draftErrors.join()).toContain('越界');
  });

  it('撤销修改回到已应用配置', () => {
    const studio = makeStudio();
    const applied = serializeConfig(studio.getSnapshot().config);
    studio.patchState('idle', { name: '临时名字' });
    expect(studio.getSnapshot().dirty).toBe(true);
    studio.revertDraft();
    expect(serializeConfig(studio.getSnapshot().draft)).toBe(applied);
    expect(studio.getSnapshot().dirty).toBe(false);
  });

  it('新增与删除过渡会更新草稿并产生校验结果', () => {
    const studio = makeStudio();
    const count = studio.getSnapshot().draft.transitions.length;
    studio.addTransition();
    expect(studio.getSnapshot().draft.transitions.length).toBe(count + 1);
    const created = studio.getSnapshot().selectedTransitionId;
    expect(created).toBeTruthy();
    if (created) studio.removeTransition(created);
    expect(studio.getSnapshot().draft.transitions.length).toBe(count);
  });
});
