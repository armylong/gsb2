import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HORIZON_MS,
  formatMs,
  indexAtTime,
  simulate,
  stateAtIndex,
} from './engine/simulator';
import type { SettlementRecord, SimState, TargetConfig, TimelineEvent } from './engine/types';
import { DEFAULT_SCENARIO_ID, SCENARIOS, getScenario, nextEventId, normalizeEvents } from './scenarios';
import { TopBar } from './components/TopBar';
import type { MainTab } from './components/TopBar';
import { TargetPanel } from './components/TargetPanel';
import { EventTable } from './components/EventTable';
import { EffectTimeline } from './components/EffectTimeline';
import { PlaybackBar } from './components/PlaybackBar';
import { SettlementLog } from './components/SettlementLog';
import { ActiveEffects } from './components/ActiveEffects';
import { RulesCard } from './components/RulesCard';
import { ScenarioGallery } from './components/ScenarioGallery';
import { ScenarioPicker } from './components/ScenarioPicker';
import { VerificationPanel } from './components/VerificationPanel';
import { ScheduleDiff } from './components/ScheduleDiff';
import { OwnedEventMenu } from './components/OwnedEventMenu';
import { CATEGORY_ICON, CATEGORY_LABEL, deltaRows } from './ui';

export default function App() {
  const initial = getScenario(DEFAULT_SCENARIO_ID);
  const [scenarioId, setScenarioId] = useState(initial.id);
  const [target, setTarget] = useState<TargetConfig>(initial.target);
  const [events, setEvents] = useState<TimelineEvent[]>(initial.events);
  const [tab, setTab] = useState<MainTab>('simulate');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedRecordSeq, setSelectedRecordSeq] = useState<number | null>(null);
  const [selectedLifetimeKey, setSelectedLifetimeKey] = useState<string | null>(null);

  const [cursor, setCursor] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [jumpInput, setJumpInput] = useState('');
  const [requestedTime, setRequestedTime] = useState<number | null>(null);

  const schedule = useMemo(() => normalizeEvents(events), [events]);
  const computed = useMemo(() => {
    const startedAt = new Date();
    const next = simulate(schedule, target, { horizonMs: HORIZON_MS });
    return { result: next, at: startedAt, ms: Date.now() - startedAt.getTime() };
  }, [schedule, target]);
  const result = computed.result;

  const scenario = getScenario(scenarioId);
  const dirty =
    JSON.stringify(target) !== JSON.stringify(scenario.target) ||
    JSON.stringify(schedule) !== JSON.stringify(normalizeEvents(scenario.events));

  const currentIndex = Math.min(cursor, result.records.length - 1);
  const currentState: SimState = stateAtIndex(result, currentIndex);
  const currentTime = currentIndex < 0 ? 0 : result.records[currentIndex].time;

  // 时间表/目标变化后，游标可能越界；夹回合法范围并停止播放。
  useEffect(() => {
    setCursor((value) => Math.min(value, result.records.length - 1));
    setPlaying(false);
  }, [result]);

  useEffect(() => {
    if (!playing) return;
    if (currentIndex >= result.records.length - 1) {
      setPlaying(false);
      return;
    }
    const next = result.records[currentIndex + 1];
    const gap = next.time - (currentIndex < 0 ? 0 : result.records[currentIndex].time);
    const delay = Math.max(50, Math.min(450, 120 + gap * 0.25)) / speed;
    const timer = window.setTimeout(
      () => setCursor((value) => Math.min(value + 1, result.records.length - 1)),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [playing, currentIndex, result.records, speed]);

  // ── 场景 ─────────────────────────────────────────────────
  function loadScenario(id: string) {
    setRequestedTime(null);
    const next = getScenario(id);
    setScenarioId(next.id);
    setTarget(next.target);
    setEvents(next.events);
    setSelectedRecordSeq(null);
    setSelectedLifetimeKey(null);
    setSelectedEventId(null);
    setPlaying(false);
    setCursor(-1);
  }

  function resetCurrentScenario() {
    loadScenario(scenarioId);
  }

  function resetPlayback() {
    setPlaying(false);
    setCursor(-1);
    setRequestedTime(null);
    setSelectedRecordSeq(null);
  }

  // ── 事件编辑 ─────────────────────────────────────────────
  function updateEvents(next: TimelineEvent[]) {
    setEvents(normalizeEvents(next));
    setSelectedRecordSeq(null);
    setPlaying(false);
  }

  function updateTarget(next: TargetConfig) {
    setTarget(next);
    setSelectedRecordSeq(null);
    setPlaying(false);
  }

  function addEvent(partial: Partial<TimelineEvent> & { kind: TimelineEvent['kind'] }) {
    const fallbackTime = events.length === 0 ? 0 : Math.min(HORIZON_MS, Math.max(...events.map((e) => e.time)) + 500);
    const event = {
      id: nextEventId(),
      order: events.length,
      time: fallbackTime,
      ...partial,
    } as TimelineEvent;
    updateEvents([...events, event]);
    setSelectedEventId(event.id);
  }

  function updateEvent(id: string, patch: Partial<TimelineEvent>) {
    updateEvents(events.map((event) => (event.id === id ? ({ ...event, ...patch } as TimelineEvent) : event)));
  }

  function removeEvent(id: string) {
    updateEvents(events.filter((event) => event.id !== id));
    if (selectedEventId === id) setSelectedEventId(null);
  }

  function duplicateEvent(id: string) {
    const source = events.find((event) => event.id === id);
    if (!source) return;
    const clone = {
      ...source,
      id: nextEventId(),
      time: Math.min(HORIZON_MS, source.time + 500),
      order: source.order + 1,
    };
    updateEvents([...events, clone]);
    setSelectedEventId(clone.id);
  }

  /** 与相邻的同刻事件交换次序，交换后按 (time, order) 重排。 */
  function moveWithinTime(id: string, direction: -1 | 1) {
    const sorted = normalizeEvents(events).map((event) => ({ ...event }));
    const index = sorted.findIndex((event) => event.id === id);
    if (index < 0) return;
    const neighbor = sorted[index + direction];
    if (!neighbor || neighbor.time !== sorted[index].time) return;
    const self = sorted[index];
    const selfOrder = self.order;
    self.order = neighbor.order;
    neighbor.order = selfOrder;
    updateEvents(sorted);
  }

  function moveTime(id: string, deltaMs: number) {
    const event = events.find((item) => item.id === id);
    if (!event) return;
    updateEvent(id, { time: Math.max(0, Math.min(HORIZON_MS, event.time + deltaMs)) });
  }

  // ── 播放控制 ─────────────────────────────────────────────
  function seekTime(time: number) {
    const clamped = Math.max(0, Math.min(HORIZON_MS, Math.round(time)));
    setPlaying(false);
    setRequestedTime(clamped);
    setSelectedRecordSeq(null);
    setCursor(indexAtTime(result, clamped));
  }

  /** 跳到下一个用户事件时刻（不是下一条结算）；没有则停在末尾。 */
  function nextEvent() {
    const target = result.schedule
      .map((event) => event.time)
      .filter((time) => time > currentTime)
      .sort((a, b) => a - b)[0];
    if (target !== undefined) seekTime(target);
    else {
      setPlaying(false);
      setCursor(result.records.length - 1);
    }
  }

  function step(direction: -1 | 1) {
    setPlaying(false);
    setRequestedTime(null);
    setSelectedRecordSeq(null);
    setCursor((value) => Math.max(-1, Math.min(result.records.length - 1, value + direction)));
  }

  function togglePlay() {
    setSelectedRecordSeq(null);
    setPlaying((value) => {
      if (!value && currentIndex >= result.records.length - 1) setCursor(-1);
      return !value;
    });
  }

  function selectRecord(seq: number) {
    setPlaying(false);
    setRequestedTime(null);
    setCursor(seq);
    setSelectedRecordSeq(seq);
  }


  // 未显式选中时，详情面板跟随当前游标；显式选中（日志/时间线标记）则保持在该条记录。
  const currentRecord: SettlementRecord | null =
    currentIndex >= 0 ? result.records[currentIndex] ?? null : null;
  const selectedRecord: SettlementRecord | null =
    selectedRecordSeq !== null ? result.records[selectedRecordSeq] ?? null : currentRecord;

  return (
    <div className="app">
      <TopBar
        tab={tab}
        onTab={setTab}
        dirty={dirty}
        scenarioName={scenario.name}
        resultHash={result.scheduleHash}
      />

      {tab === 'simulate' && (
        <main className="layout">
          <section className="col-left">
            <ScenarioPicker
              scenarios={SCENARIOS}
              activeId={scenarioId}
              dirty={dirty}
              scenario={scenario}
              onLoad={loadScenario}
              onReset={resetCurrentScenario}
              onOpenGallery={() => setTab('scenarios')}
            />
            <TargetPanel target={target} state={currentState} onChange={updateTarget} onReset={() => updateTarget(scenario.target)} />
            <ActiveEffects
              state={currentState}
              selectedKey={selectedLifetimeKey}
              onSelectEffect={setSelectedLifetimeKey}
              result={result}
              onSeek={(time) => {
                setSelectedLifetimeKey(null);
                seekTime(time);
              }}
            />
            <RulesCard />
          </section>

          <section className="col-main">
            <PlaybackBar
              playing={playing}
              speed={speed}
              cursor={currentIndex}
              total={result.records.length}
              time={currentTime}
              horizon={HORIZON_MS}
              jumpInput={jumpInput}
              onJumpInput={setJumpInput}
              onPlayToggle={togglePlay}
              onStep={() => step(1)}
              onStepBack={() => step(-1)}
              onNextEvent={nextEvent}
              onSeekTime={seekTime}
              onSpeed={setSpeed}
              onReset={resetPlayback}
              dead={currentState.dead}
              requestedTime={requestedTime}
            />
            <EffectTimeline
              result={result}
              rows={result.lifetimes}
              cursorTime={currentTime}
              selectedKey={selectedLifetimeKey}
              onSelect={setSelectedLifetimeKey}
              onSeek={seekTime}
              onSelectRecord={selectRecord}
            />
            <div className="split">
              <SettlementLog
                result={result}
                cursor={currentIndex}
                selectedSeq={selectedRecordSeq}
                onSelect={selectRecord}
                computedAt={computed.at}
                computeMs={computed.ms}
              />
              <OwnedEventMenu
                events={schedule}
                selectedId={selectedEventId}
                target={target}
                onRemove={removeEvent}
                onDuplicate={duplicateEvent}
                onMove={moveWithinTime}
                onMoveTime={moveTime}
                onAdd={addEvent}
                onSeek={seekTime}
              />
            </div>
            <EventTable
              events={schedule}
              selectedId={selectedEventId}
              currentTime={currentTime}
              onSelect={setSelectedEventId}
              onUpdate={updateEvent}
              onRemove={removeEvent}
              onDuplicate={duplicateEvent}
              onMove={moveWithinTime}
              onAdd={addEvent}
              onSeek={seekTime}
            />
          </section>

          <aside className="col-right">
            <RecordInspector
              result={result}
              record={selectedRecord}
              currentState={currentState}
              onSelectRecord={selectRecord}
              onSeek={seekTime}
            />
            <ScheduleDiff result={result} />
          </aside>
        </main>
      )}

      {tab === 'scenarios' && (
        <main className="layout single">
          <ScenarioGallery
            scenarios={SCENARIOS}
            activeId={scenarioId}
            onLoad={(id) => {
              loadScenario(id);
              setTab('simulate');
            }}
            onExplore={(id) => {
              loadScenario(id);
              setTab('simulate');
            }}
          />
        </main>
      )}

      {tab === 'verify' && (
        <main className="layout single">
          <VerificationPanel />
        </main>
      )}
    </div>
  );
}

function RecordInspector({
  result,
  record,
  currentState,
  onSelectRecord,
  onSeek,
}: {
  result: import('./engine/types').SimulationResult;
  record: SettlementRecord | null;
  currentState: SimState;
  onSelectRecord: (seq: number) => void;
  onSeek: (time: number) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [record?.seq]);

  if (!record) {
    return (
      <div className="card inspector">
        <div className="card-head">
          <h2>结算详情</h2>
        </div>
        <div className="inspector-empty">
          <p className="muted">在时间线、日志或事件表中选择一条结算，这里会显示前后数值与原因。</p>
          <CurrentSummary state={currentState} />
          <p className="muted tiny">当前位于初始状态（尚未发生任何结算）；点“下一步”或日志任意一行即可查看。</p>
        </div>
      </div>
    );
  }

  const related = result.records.filter(
    (other) =>
      other.seq !== record.seq &&
      ((record.effectId && other.effectId === record.effectId) ||
        (record.eventId && other.eventId === record.eventId)),
  );

  return (
    <div className="card inspector">
      <div className="card-head">
        <h2>结算详情 · #{record.seq + 1}</h2>
        <button className="ghost small" onClick={() => onSeek(record.time)}>
          定位 {formatMs(record.time)}
        </button>
      </div>
      <div className="inspector-body" ref={bodyRef}>
        <div className="inspector-title">
          <span className={`cat-badge cat-${record.kind}`}>{CATEGORY_ICON[record.kind]}</span>
          <strong>{record.text}</strong>
        </div>
        <BeforeAfter before={record.before} after={record.after} />
        <h3>原因与分解</h3>
        <table className="kv">
          <tbody>
            {deltaRows(record.delta).map((row) => (
              <tr key={row.label}>
                <th>{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
            {deltaRows(record.delta).length === 0 && (
              <tr>
                <td className="muted">无额外分解</td>
              </tr>
            )}
          </tbody>
        </table>
        {record.delta.note ? <p className="note">{record.delta.note}</p> : null}
        {related.length > 0 && (
          <>
            <h3>相关结算</h3>
            <ul className="related">
              {related.map((other) => (
                <li key={other.seq}>
                  <button className="link" onClick={() => onSelectRecord(other.seq)}>
                    #{other.seq + 1} · {formatMs(other.time)} · {CATEGORY_LABEL[other.kind]}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function BeforeAfter({ before, after }: { before: SimState; after: SimState }) {
  const rows = [
    { label: '生命', before: `${before.hp}`, after: `${after.hp}`, changed: before.hp !== after.hp },
    {
      label: '累计扣血',
      before: `${before.damageTaken}`,
      after: `${after.damageTaken}`,
      changed: before.damageTaken !== after.damageTaken,
    },
    {
      label: '护盾总计',
      before: `${before.shieldTotal}`,
      after: `${after.shieldTotal}`,
      changed: before.shieldTotal !== after.shieldTotal,
    },
    {
      label: '有效攻击',
      before: `${before.attack.effectiveAttack}`,
      after: `${after.attack.effectiveAttack}`,
      changed: before.attack.effectiveAttack !== after.attack.effectiveAttack,
    },
    {
      label: '攻击组成',
      before: composition(before.attack),
      after: composition(after.attack),
      changed:
        before.attack.flatBonus !== after.attack.flatBonus ||
        before.attack.pctBonus !== after.attack.pctBonus ||
        before.attack.baseAttack !== after.attack.baseAttack,
    },
    { label: '死亡', before: before.dead ? '是' : '否', after: after.dead ? '是' : '否', changed: before.dead !== after.dead },
  ];
  return (
    <table className="kv compare">
      <thead>
        <tr>
          <th>指标</th>
          <th>之前</th>
          <th>之后</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className={row.changed ? 'changed' : ''}>
            <th>{row.label}</th>
            <td>{row.before}</td>
            <td>{row.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function composition(attack: SimState['attack']): string {
  return `(${attack.baseAttack} + ${attack.flatBonus}) × ${(1 + attack.pctBonus / 100).toFixed(2)}`;
}

function CurrentSummary({ state }: { state: SimState }) {
  return (
    <div className="current-summary">
      <div>
        <span className="muted">时刻</span>
        <strong>{formatMs(state.time)}</strong>
      </div>
      <div>
        <span className="muted">生命</span>
        <strong className={state.dead ? 'danger-text' : ''}>
          {state.hp} / {state.maxHp}
        </strong>
      </div>
      <div>
        <span className="muted">有效攻击</span>
        <strong>{state.attack.effectiveAttack}</strong>
      </div>
      <div>
        <span className="muted">护盾</span>
        <strong>{state.shieldTotal}</strong>
      </div>
    </div>
  );
}
