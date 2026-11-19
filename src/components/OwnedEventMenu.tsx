import type { TargetConfig, TimelineEvent } from '../engine/types';
import { formatMs } from '../engine/simulator';
import { eventSummary, eventTitle } from '../ui';

/** 选中事件后的快捷操作：定位、改时刻、复制、删除、查看该事件的结算。 */
export function OwnedEventMenu({
  events,
  selectedId,
  target,
  onRemove,
  onDuplicate,
  onMove,
  onMoveTime,
  onAdd,
  onSeek,
}: {
  events: TimelineEvent[];
  selectedId: string | null;
  target: TargetConfig;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onMoveTime: (id: string, deltaMs: number) => void;
  onAdd: (partial: Partial<TimelineEvent> & { kind: TimelineEvent['kind'] }) => void;
  onSeek: (time: number) => void;
}) {
  const event = events.find((item) => item.id === selectedId) ?? null;
  return (
    <div className="card owned-card">
      <div className="card-head">
        <h2>事件操作</h2>
        <span className="muted tiny">目标 {target.maxHp} 生命 / {target.baseAttack} 基础攻击</span>
      </div>
      {!event ? (
        <div className="owned-empty">
          <p className="muted">在事件表中选中一条事件，可在此快速调整。</p>
          <div className="quick-add">
            <button className="ghost small" onClick={() => onAdd({ kind: 'damage', time: 1000, amount: 100 } as Partial<TimelineEvent> & { kind: 'damage' })}>
              ＋ 伤害
            </button>
            <button
              className="ghost small"
              onClick={() =>
                onAdd({
                  kind: 'apply',
                  time: 1000,
                  effectKind: 'shield',
                  source: '快速护盾',
                  absorb: 100,
                  durationMs: 3000,
                } as Partial<TimelineEvent> & { kind: 'apply' })
              }
            >
              ＋ 护盾
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="owned-head">
            <span className="kind-label">{eventTitle(event)}</span>
            <span className="muted">{formatMs(event.time)}</span>
          </div>
          <p className="muted tiny">{eventSummary(event)}</p>
          <div className="owned-actions">
            <button className="ghost small" onClick={() => onSeek(event.time)}>
              定位到此刻
            </button>
            <button className="ghost small" onClick={() => onMoveTime(event.id, -100)}>
              −100ms
            </button>
            <button className="ghost small" onClick={() => onMoveTime(event.id, 100)}>
              +100ms
            </button>
            <button className="ghost small" onClick={() => onMove(event.id, -1)}>
              同刻上移
            </button>
            <button className="ghost small" onClick={() => onMove(event.id, 1)}>
              同刻下移
            </button>
            <button className="ghost small" onClick={() => onDuplicate(event.id)}>
              复制到 +500ms
            </button>
            <button className="ghost small danger" onClick={() => onRemove(event.id)}>
              删除
            </button>
          </div>
          <div className="owned-note">
            <strong>改动后会重新模拟：</strong>
            哈希会变化，旧的结算记录不会以新时间表的名义展示。
          </div>
        </>
      )}
      <div className="owned-templates">
        <h3>模板</h3>
        <button
          className="ghost small"
          onClick={() =>
            onAdd({
              kind: 'apply',
              time: 0,
              effectKind: 'attackBuff',
              source: '战歌',
              attackFlat: 10,
              attackPct: 10,
              durationMs: 3000,
            } as Partial<TimelineEvent> & { kind: 'apply' })
          }
        >
          3 层攻击加成
        </button>
        <button
          className="ghost small"
          onClick={() =>
            onAdd({
              kind: 'apply',
              time: 0,
              effectKind: 'periodicDamage',
              source: '毒雾',
              intervalMs: 1000,
              durationMs: 3000,
              tickDamage: 50,
            } as Partial<TimelineEvent> & { kind: 'apply' })
          }
        >
          1000ms 周期伤害
        </button>
        <button
          className="ghost small"
          onClick={() =>
            onAdd({
              kind: 'dispel',
              time: 0,
              effectKind: 'periodicDamage',
              source: '毒雾',
            } as Partial<TimelineEvent> & { kind: 'dispel' })
          }
        >
          驱散毒雾
        </button>
        <button
          className="ghost small"
          onClick={() =>
            onAdd({
              kind: 'apply',
              time: 0,
              effectKind: 'shield',
              source: '护心',
              absorb: 200,
              durationMs: 4000,
            } as Partial<TimelineEvent> & { kind: 'apply' })
          }
        >
          200 点护盾
        </button>
      </div>
    </div>
  );
}
