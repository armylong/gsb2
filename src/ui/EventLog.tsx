import type { SimEvent } from '../engine/types';

const TYPE_LABEL: Record<SimEvent['type'], { label: string; cls: string }> = {
  start: { label: '开工', cls: 'ev-start' },
  complete: { label: '完成', cls: 'ev-complete' },
  ship: { label: '发货', cls: 'ev-ship' },
  deliver: { label: '到货', cls: 'ev-deliver' },
  blocked: { label: '满仓等待', cls: 'ev-blocked' },
  starved: { label: '缺料', cls: 'ev-starved' },
};

/** 最近的资源流转事件（环形缓冲，最多 400 条），最新在上。 */
export function EventLog({ events }: { events: SimEvent[] }) {
  const reversed = [...events].reverse();
  return (
    <div className="event-log">
      {reversed.length === 0 && <div className="muted">尚无事件，点击运行或单步开始模拟。</div>}
      {reversed.map((ev, i) => {
        const meta = TYPE_LABEL[ev.type];
        return (
          <div className={`event-row ${meta.cls}`} key={`${ev.tick}-${i}`}>
            <span className="event-tick">t={ev.tick}</span>
            <span className="event-type">{meta.label}</span>
            <span className="event-detail">{ev.detail}</span>
          </div>
        );
      })}
    </div>
  );
}
