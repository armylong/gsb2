import { useMemo, useRef, useState } from 'react';
import { runDemoScenarios } from '../engine/scenarios';
import type { ScenarioReport } from '../engine/scenarios';
import type { StudioSnapshot } from '../studio/store';

interface ScenarioPanelProps {
  state: StudioSnapshot;
  onRestoreDemo: () => void;
}

export function ScenarioPanel({ state, onRestoreDemo }: ScenarioPanelProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [rerunKey, setRerunKey] = useState(0);
  const reports = useMemo(
    () => runDemoScenarios(state.config),
    // configRevision 变化时重算; config 引用稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.config, rerunKey],
  );
  const allPassed = reports.every((r) => r.passed);

  return (
    <section className="scenario-panel">
      <header className="panel-header">
        <h2>内置示例 · 真实事件记录</h2>
        <span className={`tag ${allPassed ? 'ok' : 'bad'}`}>
          {allPassed ? '全部通过' : '存在失败'}
        </span>
        <button
          type="button"
          className="btn tiny"
          onClick={() => setRerunKey((k) => k + 1)}
        >
          ↻ 从确定初态重跑
        </button>
      </header>
      <p className="hint small">
        示例直接在当前已应用的配置上运行。若改过配置后想核对内置场景, 先恢复内置示例再重跑。
      </p>
      <div className="scenario-actions">
        <button type="button" className="btn muted" onClick={onRestoreDemo}>
          恢复内置示例配置
        </button>
      </div>
      <ul className="scenario-list">
        {reports.map((report) => (
          <li key={report.id} className={report.passed ? 'pass' : 'fail'}>
            <button
              type="button"
              className="scenario-head"
              onClick={() => setOpenId(openId === report.id ? null : report.id)}
            >
              <span className="scenario-name">
                {report.passed ? '✓' : '✕'} {report.name}
              </span>
              <span className="scenario-checks">
                {report.checks.filter((c) => c.pass).length}/{report.checks.length} 项
              </span>
            </button>
            {openId === report.id ? <ScenarioDetail report={report} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScenarioDetail({ report }: { report: ScenarioReport }) {
  const [tab, setTab] = useState<'checks' | 'log'>('checks');
  const logRef = useRef<HTMLOListElement>(null);
  return (
    <div className="scenario-detail">
      <p className="hint small">{report.description}</p>
      <div className="tabs">
        <button
          type="button"
          className={tab === 'checks' ? 'tab active' : 'tab'}
          onClick={() => setTab('checks')}
        >
          断言 ({report.checks.filter((c) => c.pass).length}/{report.checks.length})
        </button>
        <button
          type="button"
          className={tab === 'log' ? 'tab active' : 'tab'}
          onClick={() => setTab('log')}
        >
          真实记录 ({report.lines.length})
        </button>
      </div>
      {tab === 'checks' ? (
        <ul className="check-list">
          {report.checks.map((check, index) => (
            <li key={`${check.label}-${index}`} className={check.pass ? 'ok' : 'bad'}>
              <span className="mark">{check.pass ? '✓' : '✕'}</span>
              <span className="check-label">{check.label}</span>
              <span className="check-detail">{check.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ol className="scenario-log" ref={logRef}>
          {report.lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
