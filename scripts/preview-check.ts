import { AnimationMachine } from '../src/engine/machine';
import { buildPreviewFrame, previewTransitionStatuses, PreviewTimeline } from '../src/engine/preview';
import { collectEvents, collectWindows } from '../src/engine/log-format';
import type { MachineConfig } from '../src/engine/types';
import type { ScenarioCheck } from '../src/engine/scenarios';

function check(label: string, pass: boolean, detail: string): ScenarioCheck {
  return { label, pass, detail };
}

export function runPreviewSideEffectChecks(config: MachineConfig): { checks: ScenarioCheck[] } {
  const checks: ScenarioCheck[] = [];

  const timeline = new PreviewTimeline(config, 'attack', 250);
  const frame = timeline.frame;
  checks.push(
    check(
      '预览帧停在指定时刻并列出已过/未到事件',
      frame.elapsedMs === 250 &&
        frame.passedEventIds.join(',') ===
          'attack-lunge,attack-window-open,attack-window-mid' &&
        frame.upcomingEventIds.join(',') === 'attack-window-close,attack-recover',
      `已过 [${frame.passedEventIds.join(', ')}] / 未到 [${frame.upcomingEventIds.join(', ')}]`,
    ),
  );

  const machine = new AnimationMachine(config, {
    initialStateId: 'attack',
    initialInputs: { pendingAttacks: 2 },
  });
  machine.update(250);
  const before = {
    log: JSON.stringify(machine.log),
    pending: machine.pendingAttacks,
    window: machine.getSnapshot().attackWindowOpen,
  };
  for (const t of [0, 120, 240, 420, 720, 3000]) timeline.seek(t);
  for (const id of ['run', 'hurt', 'victory', 'idle']) timeline.setState(id);
  previewTransitionStatuses(config, config.states[2], 250, { pendingAttacks: 2, hurt: false });
  buildPreviewFrame(config, 'run', 5000);
  const after = {
    log: JSON.stringify(machine.log),
    pending: machine.pendingAttacks,
    window: machine.getSnapshot().attackWindowOpen,
  };
  checks.push(
    check(
      '拖动预览时间轴/切换预览状态不产生日志',
      before.log === after.log,
      `${machine.log.length} 条日志保持逐字节一致`,
    ),
  );
  checks.push(
    check(
      '预览不消费待处理攻击',
      before.pending === after.pending,
      `待处理 ${before.pending} → ${after.pending}`,
    ),
  );
  checks.push(
    check(
      '预览不打开/关闭真实攻击窗口',
      before.window === true && after.window === true,
      `真实状态机在 250ms 已开窗=${before.window}, 预览后=${after.window}`,
    ),
  );

  const windows = collectWindows(machine.log);
  checks.push(
    check(
      '预览后真实窗口记录仍只有 1 条开窗事件',
      windows.length === 1 && windows[0].action === 'open',
      `窗口记录: ${windows.map((w) => w.action).join(', ')}`,
    ),
  );

  const events = collectEvents(machine.log);
  checks.push(
    check(
      '预览后真实事件仍是 3 条',
      events.length === 3,
      `事件: ${events.map((e) => e.eventId).join(', ')}`,
    ),
  );

  const configBefore = JSON.stringify(config);
  buildPreviewFrame(config, 'run', 1234);
  checks.push(
    check(
      '预览是纯函数, 不修改配置',
      JSON.stringify(config) === configBefore,
      '配置序列化前后一致',
    ),
  );

  return { checks };
}
