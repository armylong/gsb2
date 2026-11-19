import { simulate } from '../engine/simulator';
import type { SimulationResult } from '../engine/types';
import type { Scenario } from '../scenarios';
import { formatMs } from '../engine/simulator';
import { KIND_CLASS, KIND_LABEL } from '../ui';

export function ScenarioGallery({
  scenarios,
  activeId,
  onLoad,
  onExplore,
}: {
  scenarios: Scenario[];
  activeId: string;
  onLoad: (id: string) => void;
  onExplore: (id: string) => void;
}) {
  const results = new Map(scenarios.map((scenario) => [scenario.id, simulate(scenario.events, scenario.target, { horizonMs: 30000 })]));
  return (
    <div className="gallery">
      <div className="gallery-head">
        <h2>可重置示例</h2>
        <p className="muted">
          三组例子分别覆盖「重施临近触发点」「叠层分别到期」「护盾耗尽」。点击加载后，时间线会标出实际发生与跳过的结算，
          选中任一条记录可查看前后数值与原因。
        </p>
      </div>
      <div className="gallery-grid">
        {scenarios.map((scenario) => {
          const summary = summarize(results.get(scenario.id)!);
          return (
            <article key={scenario.id} className={`gallery-card ${activeId === scenario.id ? 'active' : ''}`}>
              <header>
                <h3>{scenario.name}</h3>
                <span className={`badge ${activeId === scenario.id ? 'ok' : ''}`}>{activeId === scenario.id ? '当前加载' : '示例'}</span>
              </header>
              <p>{scenario.summary}</p>
              <div className="focus-tags">
                {scenario.focus.map((f) => (
                  <span key={f} className="tag">
                    {f}
                  </span>
                ))}
              </div>
              <MiniTimeline events={scenario.events} />
              <dl className="gallery-stats">
                <div>
                  <dt>事件</dt>
                  <dd>{scenario.events.length}</dd>
                </div>
                <div>
                  <dt>预计生命</dt>
                  <dd>{summary.hp}</dd>
                </div>
                <div>
                  <dt>跳过结算</dt>
                  <dd>{summary.skipped}</dd>
                </div>
                <div>
                  <dt>护盾吸收</dt>
                  <dd>{summary.absorbed}</dd>
                </div>
              </dl>
              <div className="gallery-actions">
                <button className="primary small" onClick={() => onLoad(scenario.id)}>
                  加载并模拟
                </button>
                <button className="ghost small" onClick={() => onExplore(scenario.id)}>
                  查看时间线
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function summarize(result: SimulationResult) {
  return {
    hp: result.finalState.hp,
    skipped: result.records.filter((r) => r.kind === 'skipped').length,
    absorbed: result.records.filter((r) => r.kind === 'shieldAbsorb').length,
  };
}

function MiniTimeline({ events }: { events: Scenario['events'] }) {
  const horizon = 30000;
  const times = events.map((event) => event.time);
  return (
    <div className="mini-timeline" role="img" aria-label="事件时刻概览">
      <span className="mini-axis" />
      {times.map((time, index) => {
        const event = events[index];
        const tone = event.kind === 'apply' ? KIND_CLASS[event.effectKind] : event.kind === 'dispel' ? 'tone-dispel' : 'tone-damage';
        return (
          <span
            key={`${time}-${index}`}
            className={`mini-event ${tone}`}
            style={{ left: `${(time / horizon) * 100}%` }}
            title={`${formatMs(time)} · ${eventTitle(event)}`}
          />
        );
      })}
      <span className="mini-label start">0</span>
      <span className="mini-label end">30s</span>
    </div>
  );
}

function eventTitle(event: Scenario['events'][number]): string {
  if (event.kind === 'apply') return `${KIND_LABEL[event.effectKind]} ${event.source}`;
  if (event.kind === 'dispel') return `驱散 ${event.source}`;
  return `伤害 ${event.amount}`;
}
