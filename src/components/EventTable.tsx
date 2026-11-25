/**
 * EventTable —— 按键序列的精确时刻编辑。
 *
 * 时刻用数字输入精确到毫秒，是暂停后重播触发点一致性的录入入口；
 * 允许同一时刻存在多个事件（零长度音）。
 */
import type { KeySequence, SequenceEvent, SequenceEventType } from '../audio/sequence';
import { nextEventId, sortedEvents } from '../audio/sequence';

interface Props {
  sequence: KeySequence;
  onChange: (next: KeySequence) => void;
  onInsertAt: (time: number) => void;
  insertTime: number;
}

const TYPES: SequenceEventType[] = ['noteOn', 'noteOff', 'paramChange'];
const TYPE_LABEL: Record<SequenceEventType, string> = {
  noteOn: '按下',
  noteOff: '松开',
  paramChange: '改参数',
};

export function EventTable({ sequence, onChange, onInsertAt, insertTime }: Props) {
  const events = sortedEvents(sequence.events);

  const update = (id: string, patch: Partial<SequenceEvent>) => {
    onChange({
      ...sequence,
      events: sequence.events.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  };

  const remove = (id: string) => {
    onChange({ ...sequence, events: sequence.events.filter((e) => e.id !== id) });
  };

  const add = (type: SequenceEventType) => {
    const ev: SequenceEvent = {
      id: nextEventId(),
      time: Math.max(0, Number(insertTime.toFixed(3))),
      type,
      ...(type === 'noteOn' ? { velocity: 1 } : {}),
    };
    onChange({ ...sequence, events: [...sequence.events, ev] });
  };

  return (
    <div>
      <div className="row spread" style={{ marginBottom: 8 }}>
        <div className="row">
          <span className="hint">插入时刻</span>
          <input
            type="number"
            step={0.01}
            min={0}
            value={insertTime}
            onChange={(e) => onInsertAt(Number(e.target.value))}
            aria-label="插入时刻（秒）"
          />
          <span className="hint">s</span>
        </div>
        <div className="row">
          {TYPES.map((t) => (
            <button key={t} className="tiny" onClick={() => add(t)}>
              + {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      <table className="event-table">
        <thead>
          <tr>
            <th>时刻 (s)</th>
            <th>类型</th>
            <th>力度</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  value={e.time}
                  onChange={(ev) => update(e.id, { time: Math.max(0, Number(ev.target.value)) })}
                  aria-label={`事件时刻 ${e.id}`}
                />
              </td>
              <td>
                <select
                  value={e.type}
                  onChange={(ev) => update(e.id, { type: ev.target.value as SequenceEventType })}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {e.type === 'noteOn' ? (
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    max={1}
                    value={e.velocity ?? 1}
                    onChange={(ev) =>
                      update(e.id, {
                        velocity: Math.min(1, Math.max(0, Number(ev.target.value))),
                      })
                    }
                    aria-label={`力度 ${e.id}`}
                  />
                ) : (
                  <span className="hint">—</span>
                )}
              </td>
              <td>
                <button className="tiny" onClick={() => remove(e.id)} aria-label={`删除事件 ${e.id}`}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={4} className="hint">
                还没有事件，用上方按钮添加按下/松开。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
