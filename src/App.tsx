import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScenarioPicker, type LoadedSource } from './components/ScenarioPicker';
import { Stage } from './components/Stage';
import { TransportBar } from './components/TransportBar';
import { Timeline } from './components/Timeline';
import { EventLedger } from './components/EventLedger';
import { Inspector } from './components/Inspector';
import { ExportPanel } from './components/ExportPanel';
import { CheckpointPanel } from './components/CheckpointPanel';
import { usePlayback } from './hooks/usePlayback';
import { buildSnapshot, timelineEnd } from './lib/engine';
import { clock } from './lib/format';
import type { AuditRecord, CaptionEvent, Checkpoint } from './lib/types';
import { BUILT_IN_SCENARIOS } from './data/scenarios';
import { ClockIcon } from './components/Icons';

interface Source {
  id: string;
  name: string;
  description: string;
  events: CaptionEvent[];
  checkpoints: Checkpoint[];
  builtIn: boolean;
}

const BUILT_IN_SOURCES: Source[] = BUILT_IN_SCENARIOS.map((scenario) => ({
  id: scenario.id,
  name: scenario.name,
  description: scenario.description,
  events: scenario.events,
  checkpoints: scenario.checkpoints,
  builtIn: true,
}));

export default function App() {
  const [sources, setSources] = useState<Source[]>(BUILT_IN_SOURCES);
  const [activeId, setActiveId] = useState(BUILT_IN_SOURCES[0].id);
  const [delay, setDelay] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const active = sources.find((source) => source.id === activeId) ?? BUILT_IN_SOURCES[0];
  const events = active.events;
  const end = useMemo(() => timelineEnd(events), [events]);
  const playback = usePlayback(events, end);
  const snapshot = useMemo(
    () => buildSnapshot(events, playback.time, delay),
    [events, playback.time, delay],
  );

  const selected = useMemo(
    () => snapshot.audit.find((record) => record.index === selectedIndex) ?? null,
    [snapshot.audit, selectedIndex],
  );

  const jumpTo = useCallback(
    (time: number, nextDelay: number) => {
      setDelay(nextDelay);
      playback.seek(time);
    },
    [playback],
  );

  const handleSelectSource = (id: string) => {
    setActiveId(id);
    setSelectedIndex(null);
    setDelay(0);
  };

  const handleImport = (source: LoadedSource) => {
    setSources((current) => [...current, source]);
    handleSelectSource(source.id);
  };

  const handleCheckpoint = (checkpoint: Checkpoint) => {
    jumpTo(checkpoint.at, checkpoint.delay ?? 0);
    setSelectedIndex(null);
  };

  const handleFocusRecord = (record: AuditRecord) => {
    // 跳到该次投递刚到达的时刻，便于看到“接收之后”的状态。
    playback.seek(record.event.arrival);
  };

  // 键盘：空格播放、方向键微调、Shift+方向键逐条投递、Home 回到开头。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (typing) return;
      // 按钮上的空格交给浏览器原生激活，其余快捷键照常响应。
      if (event.code === 'Space' && target?.tagName === 'BUTTON') return;
      if (event.code === 'Space') {
        event.preventDefault();
        playback.toggle();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (event.shiftKey) playback.stepBack();
        else playback.nudge(-0.1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (event.shiftKey) playback.stepForward();
        else playback.nudge(0.1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        playback.restart();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playback]);

  const uniqueArrivalCount = useMemo(
    () => new Set(events.map((event) => event.arrival)).size,
    [events],
  );

  const activeCheckpoints = active.checkpoints;

  return (
    <div className="app">
      <div className="app__ambient" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <ClockIcon size={18} />
          </span>
          <div>
            <h1 className="brand__title">本地现场字幕 · 回放核对台</h1>
            <p className="brand__sub">
              按到达顺序重放文本事件，核对迟到、重复与乱序修订是否会影响画面和导出。
            </p>
          </div>
        </div>
        <div className="topbar__stats">
          <span className="stat">
            <span className="stat__value">{snapshot.stats.receivedCount}</span>
            <span className="stat__label">已接收</span>
          </span>
          <span className="stat">
            <span className="stat__value">{snapshot.stats.acceptedCount}</span>
            <span className="stat__label">生效接收</span>
          </span>
          <span className="stat">
            <span className="stat__value">{snapshot.stats.rejectedCount}</span>
            <span className="stat__label">拦截</span>
          </span>
          <span className="stat">
            <span className="stat__value">{snapshot.stats.pendingCount}</span>
            <span className="stat__label">待到达</span>
          </span>
        </div>
      </header>

      <ScenarioPicker
        scenarios={sources.map((source) => ({
          id: source.id,
          name: source.name,
          kicker: source.builtIn ? '内置样例' : '导入',
          description: source.description,
          events: source.events,
          checkpoints: source.checkpoints,
        }))}
        activeId={activeId}
        onSelect={handleSelectSource}
        onImport={handleImport}
      />

      <p className="source-desc">{active.description}</p>

      <main className="layout">
        <div className="layout__main">
          <Stage
            screen={snapshot.screen}
            captions={snapshot.captions}
            presentationTime={snapshot.presentationTime}
            replayTime={snapshot.time}
            delay={snapshot.delay}
          />

          <TransportBar
            playback={playback}
            end={end}
            delay={delay}
            onDelayChange={setDelay}
            arrivalCount={uniqueArrivalCount}
          />

          <Timeline
            events={events}
            audit={snapshot.audit}
            captions={snapshot.captions}
            time={snapshot.time}
            presentationTime={snapshot.presentationTime}
            delay={snapshot.delay}
            end={end}
            onSeek={(value) => playback.seek(value)}
          />

          <div className="layout__lower">
            <EventLedger
              audit={snapshot.audit}
              selectedIndex={selectedIndex}
              onSelect={(record) => setSelectedIndex(record.index)}
              onFocusTime={handleFocusRecord}
            />
            <div className="layout__side">
              <Inspector snapshot={snapshot} selected={selected} />
            </div>
          </div>
        </div>

        <aside className="layout__rail">
          <CheckpointPanel
            checkpoints={activeCheckpoints}
            events={events}
            snapshot={snapshot}
            onJump={handleCheckpoint}
          />
          <ExportPanel snapshot={snapshot} scenarioName={active.name} />
          <section className="notes" aria-label="播放说明">
            <h2 className="section-title">核对方式</h2>
            <ul className="notes__list">
              <li>
                <kbd>空格</kbd> 播放/暂停，<kbd>Shift</kbd> + <kbd>←</kbd>/<kbd>→</kbd> 逐条投递。
              </li>
              <li>拖动进度条或点时间轴任意位置，页面从零重新计算该时刻，不保留未来版本。</li>
              <li>
                显示延迟把画面时钟往后拨，等于给迟到修订留缓冲；接收与导出仍以回放时钟为准。
              </li>
              <li>终端时间 {clock(end, 1)}，文件只在字幕收到结束标记后才出现。</li>
            </ul>
          </section>
        </aside>
      </main>

      <footer className="footer">
        <span>纯前端 · 事件与媒体时间由样例数据模拟 · 导出格式 WebVTT</span>
      </footer>
    </div>
  );
}
