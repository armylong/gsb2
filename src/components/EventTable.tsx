import { useState } from 'react';
import type {
  ApplyEffectEvent,
  DamageEvent,
  DispelEvent,
  TimelineEvent,
} from '../engine/types';
import { HORIZON_MS } from '../engine/simulator';
import { TimeInput } from './TimeInput';
import { eventSummary, eventTitle, KIND_LABEL } from '../ui';

type DraftKind = 'apply' | 'dispel' | 'damage';

export function EventTable({
  events,
  selectedId,
  currentTime,
  onSelect,
  onUpdate,
  onRemove,
  onDuplicate,
  onMove,
  onAdd,
  onSeek,
}: {
  events: TimelineEvent[];
  selectedId: string | null;
  currentTime: number;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<TimelineEvent>) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onAdd: (partial: Partial<TimelineEvent> & { kind: TimelineEvent['kind'] }) => void;
  onSeek: (time: number) => void;
}) {
  const [draftKind, setDraftKind] = useState<DraftKind>('apply');
  const [draftEffect, setDraftEffect] = useState<'attackBuff' | 'periodicDamage' | 'shield'>('attackBuff');
  const [draftTime, setDraftTime] = useState('1000');

  function addDraft() {
    const time = Math.max(0, Math.min(HORIZON_MS, Math.round(Number(draftTime) || 0)));
    if (draftKind === 'damage') {
      onAdd({ kind: 'damage', time, amount: 100, label: '普通伤害' } as Partial<TimelineEvent> & { kind: 'damage' });
    } else if (draftKind === 'dispel') {
      onAdd({ kind: 'dispel', time, effectKind: draftEffect, source: '战歌', label: '驱散' } as Partial<TimelineEvent> & {
        kind: 'dispel';
      });
    } else {
      onAdd(applyTemplate(draftEffect, time));
    }
  }

  return (
    <div className="card event-card">
      <div className="card-head">
        <h2>事件表 · {events.length} 条</h2>
        <span className="muted tiny">时间单位 ms · ▲▼ 调整同一时刻内的结算次序</span>
      </div>
      <div className="event-scroll">
        <table className="events">
          <thead>
            <tr>
              <th>次序</th>
              <th>时刻 (ms)</th>
              <th>事件</th>
              <th>同刻次序</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, index) => {
              const isSelected = selectedId === event.id;
              const sameTime = events.filter((item) => item.time === event.time);
              const withinTime = sameTime.findIndex((item) => item.id === event.id) + 1;
              return (
                <EventRowGroup key={event.id}>
                  <tr
                    className={[
                      isSelected ? 'selected' : '',
                      event.time <= currentTime ? 'past' : 'future',
                    ].join(' ')}
                    onClick={() => onSelect(isSelected ? null : event.id)}
                  >
                    <td className="order-cell">
                      <span className="order-index">{index + 1}</span>
                      <span className={`kind-dot kind-${event.kind === 'apply' ? event.effectKind : event.kind}`} />
                    </td>
                    <td onClick={(evt) => evt.stopPropagation()}>
                      <TimeInput
                        value={event.time}
                        max={HORIZON_MS}
                        onCommit={(time) => onUpdate(event.id, { time })}
                        ariaLabel={`事件 ${index + 1} 的时刻（毫秒）`}
                      />
                    </td>
                    <td className="content-cell">
                      <span className="kind-label">{eventTitle(event)}</span>
                      <span className="summary">
                        {eventSummary(event)}
                        {event.label ? <span className="label-note"> · {event.label}</span> : null}
                      </span>
                    </td>
                    <td className="reorder-cell" onClick={(evt) => evt.stopPropagation()}>
                      <span className="instant-order" title={`同刻第 ${withinTime} / ${sameTime.length} 个结算`}>
                        {withinTime}/{sameTime.length}
                      </span>
                      <button
                        className="ghost tiny"
                        title="同刻上移"
                        aria-label="同一时刻上移"
                        onClick={() => onMove(event.id, -1)}
                        disabled={!hasSameTimeNeighbor(events, event.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="ghost tiny"
                        title="同刻下移"
                        aria-label="同一时刻下移"
                        onClick={() => onMove(event.id, 1)}
                        disabled={!hasSameTimeNeighbor(events, event.id, 1)}
                      >
                        ↓
                      </button>
                    </td>
                    <td className="actions-cell" onClick={(evt) => evt.stopPropagation()}>
                      <button className="ghost tiny" onClick={() => onSeek(event.time)} title="跳到该时刻">
                        定位
                      </button>
                      <button className="ghost tiny danger" onClick={() => onRemove(event.id)} title="删除">
                        ✕
                      </button>
                    </td>
                  </tr>
                  {isSelected && (
                    <tr className="edit-row">
                      <td colSpan={5}>
                        <div className="edit-detail">
                          <span className="edit-title">编辑 · {eventTitle(event)}</span>
                          {event.kind === 'apply' && (
                            <ApplyFields event={event} onUpdate={(patch) => onUpdate(event.id, patch as Partial<TimelineEvent>)} />
                          )}
                          {event.kind === 'dispel' && (
                            <DispelFields event={event} onUpdate={(patch) => onUpdate(event.id, patch)} />
                          )}
                          {event.kind === 'damage' && (
                            <DamageFields event={event} onUpdate={(patch) => onUpdate(event.id, patch)} />
                          )}
                          <button className="ghost tiny" onClick={() => onDuplicate(event.id)}>
                            复制到 +500ms
                          </button>
                          <label className="inline-field">
                            备注
                            <input
                              className="note-input"
                              value={event.label ?? ''}
                              onChange={(evt) => onUpdate(event.id, { label: evt.target.value })}
                            />
                          </label>
                        </div>
                      </td>
                    </tr>
                  )}
                </EventRowGroup>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="add-row">
        <span className="muted">新增</span>
        <select value={draftKind} onChange={(event) => setDraftKind(event.target.value as DraftKind)}>
          <option value="apply">施加效果</option>
          <option value="dispel">驱散</option>
          <option value="damage">普通伤害</option>
        </select>
        {draftKind !== 'damage' && (
          <select value={draftEffect} onChange={(event) => setDraftEffect(event.target.value as typeof draftEffect)}>
            {(['attackBuff', 'periodicDamage', 'shield'] as const).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        )}
        <label className="inline-field">
          时刻
          <TimeInput
            value={Number(draftTime) || 0}
            max={HORIZON_MS}
            onCommit={(time) => setDraftTime(String(time))}
            ariaLabel="新事件的时刻（毫秒）"
          />
          ms
        </label>
        <button className="primary small" onClick={addDraft}>
          ＋ 添加
        </button>
        <span className="muted tiny">新增后按 (时刻, 次序) 自动重排</span>
      </div>
    </div>
  );
}

function EventRowGroup({ children }: { children: import('react').ReactNode }) {
  return <>{children}</>;
}

function hasSameTimeNeighbor(events: TimelineEvent[], id: string, direction: -1 | 1): boolean {
  const index = events.findIndex((event) => event.id === id);
  if (index < 0) return false;
  const time = events[index].time;
  const neighbor = events[index + direction];
  return Boolean(neighbor && neighbor.time === time);
}

function ApplyFields({ event, onUpdate }: { event: ApplyEffectEvent; onUpdate: (patch: Partial<ApplyEffectEvent>) => void }) {
  return (
    <span className="inline-fields">
      <label>
        来源
        <input value={event.source} onChange={(evt) => onUpdate({ source: evt.target.value })} />
      </label>
      {event.effectKind === 'attackBuff' && (
        <>
          <label>
            固定
            <input
              type="number"
              value={event.attackFlat ?? 0}
              onChange={(evt) => onUpdate({ attackFlat: Number(evt.target.value) || 0 })}
            />
          </label>
          <label>
            百分比%
            <input
              type="number"
              value={event.attackPct ?? 0}
              onChange={(evt) => onUpdate({ attackPct: Number(evt.target.value) || 0 })}
            />
          </label>
        </>
      )}
      {event.effectKind === 'periodicDamage' && (
        <>
          <label>
            每跳
            <input
              type="number"
              value={event.tickDamage ?? 0}
              onChange={(evt) => onUpdate({ tickDamage: Number(evt.target.value) || 0 })}
            />
          </label>
          <label>
            周期
            <input
              type="number"
              value={event.intervalMs ?? 1000}
              onChange={(evt) => onUpdate({ intervalMs: Math.max(1, Number(evt.target.value) || 1) })}
            />
          </label>
        </>
      )}
      {event.effectKind === 'shield' && (
        <label>
          吸收
          <input
            type="number"
            value={event.absorb ?? 0}
            onChange={(evt) => onUpdate({ absorb: Number(evt.target.value) || 0 })}
          />
        </label>
      )}
      <label>
        持续
        <input
          type="number"
          value={event.durationMs ?? 0}
          onChange={(evt) => onUpdate({ durationMs: Math.max(0, Number(evt.target.value) || 0) })}
        />
      </label>
    </span>
  );
}

function DispelFields({ event, onUpdate }: { event: DispelEvent; onUpdate: (patch: Partial<DispelEvent>) => void }) {
  return (
    <span className="inline-fields">
      <label>
        效果
        <select value={event.effectKind} onChange={(evt) => onUpdate({ effectKind: evt.target.value as DispelEvent['effectKind'] })}>
          {(['attackBuff', 'periodicDamage', 'shield'] as const).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </label>
      <label>
        来源
        <input value={event.source} onChange={(evt) => onUpdate({ source: evt.target.value })} />
      </label>
    </span>
  );
}

function DamageFields({ event, onUpdate }: { event: DamageEvent; onUpdate: (patch: Partial<DamageEvent>) => void }) {
  return (
    <span className="inline-fields">
      <label>
        伤害
        <input type="number" value={event.amount} onChange={(evt) => onUpdate({ amount: Number(evt.target.value) || 0 })} />
      </label>
    </span>
  );
}

function applyTemplate(
  kind: 'attackBuff' | 'periodicDamage' | 'shield',
  time: number,
): Partial<TimelineEvent> & { kind: 'apply' } {
  if (kind === 'attackBuff') {
    return {
      kind: 'apply',
      time,
      effectKind: 'attackBuff',
      source: '新增益',
      attackFlat: 10,
      attackPct: 10,
      durationMs: 3000,
      label: '攻击加成',
    };
  }
  if (kind === 'periodicDamage') {
    return {
      kind: 'apply',
      time,
      effectKind: 'periodicDamage',
      source: '新持续伤害',
      intervalMs: 1000,
      durationMs: 3000,
      tickDamage: 50,
      label: '周期伤害',
    };
  }
  return {
    kind: 'apply',
    time,
    effectKind: 'shield',
    source: '新护盾',
    absorb: 100,
    durationMs: 3000,
    label: '护盾',
  };
}
