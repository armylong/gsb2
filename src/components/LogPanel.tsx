import { useEffect, useMemo, useRef, useState } from 'react';
import { LOG_TYPE_LABEL } from '../engine/types';
import type { LogEntry, LogType } from '../engine/types';
import type { StudioSnapshot } from '../studio/store';
import { describeLogEntry } from '../engine/log-format';

interface LogPanelProps {
  state: StudioSnapshot;
}

const FILTERS: LogType[] = ['event', 'state-enter', 'transition', 'interrupt', 'window', 'loop', 'input'];

export function LogPanel({ state }: LogPanelProps) {
  const [enabled, setEnabled] = useState<Set<LogType>>(
    () => new Set(['event', 'state-enter', 'transition', 'interrupt']),
  );
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const log = state.machine.log;
  const logLength = state.machine.logLength;

  const filtered = useMemo(
    () =>
      log.filter((entry) => {
        if (!enabled.has(entry.type)) return false;
        if (!query.trim()) return true;
        const text = describeLogEntry(entry, state.config);
        return text.toLowerCase().includes(query.trim().toLowerCase());
      }),
    // 日志按追加方式更新, 依赖 logLength 触发重新过滤
    [log, logLength, enabled, query, state.config],
  );

  useEffect(() => {
    if (!autoScroll || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [filtered.length, autoScroll]);

  const toggle = (type: LogType) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <section className="log-panel">
      <header className="panel-header">
        <h2>事件记录</h2>
        <span className="hint small">{filtered.length} / {log.length} 条</span>
        <input
          className="log-search"
          placeholder="筛选…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="switch inline small">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          <span>跟随</span>
        </label>
      </header>
      <div className="log-filters">
        {FILTERS.map((type) => (
          <button
            type="button"
            key={type}
            className={`chip log-chip type-${type} ${enabled.has(type) ? 'active' : ''}`}
            onClick={() => toggle(type)}
          >
            {LOG_TYPE_LABEL[type]}
          </button>
        ))}
      </div>
      <ol className="log-list" ref={listRef}>
        {filtered.map((entry) => (
          <LogRow key={entry.seq} entry={entry} configName={state.config.name} snapshot={state} />
        ))}
        {filtered.length === 0 ? <li className="hint">没有匹配记录</li> : null}
      </ol>
      <p className="hint small">
        实际事件 = 动作真触发; 过渡/中断/窗口为状态机记录。预览模式不产生任何记录。
      </p>
    </section>
  );
}

function LogRow({
  entry,
  snapshot,
}: {
  entry: LogEntry;
  configName: string;
  snapshot: StudioSnapshot;
}) {
  // 类型已在左侧标签展示, 正文去掉重复的类型前缀
  const text = describeLogEntry(entry, snapshot.config)
    .replace(/^#\d+ t=\d+ms tick=\d+ /, '')
    .replace(/^(实际事件|初始进入|进入|过渡|窗口|中断|循环|输入) /, '');
  return (
    <li className={`log-row type-${entry.type}`}>
      <span className="log-seq">#{entry.seq}</span>
      <span className="log-time">t={entry.atMs}ms</span>
      <span className={`log-type type-${entry.type}`}>{LOG_TYPE_LABEL[entry.type]}</span>
      <span className="log-text">{text}</span>
    </li>
  );
}
