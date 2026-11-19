import { useMemo, useState } from 'react';
import { CanvasView } from './ui/CanvasView';
import { Toolbar } from './ui/Toolbar';
import { NodeInspector } from './ui/NodeInspector';
import { ConnectionInspector } from './ui/ConnectionInspector';
import { ConfigEditor } from './ui/ConfigEditor';
import { LedgerTable } from './ui/LedgerTable';
import { EventLog } from './ui/EventLog';
import { SCENARIOS } from './engine/scenarios';
import { useSimulation } from './state/useSimulation';

type Tab = 'inspect' | 'config' | 'ledger' | 'events';

export default function App() {
  const [scenarioKey, setScenarioKey] = useState(SCENARIOS[0].key);
  const scenario = SCENARIOS.find((s) => s.key === scenarioKey)!;
  // 场景只在切换时重建，保证 React 受控组件生命周期稳定。
  const initialConfig = useMemo(() => scenario.build(), [scenarioKey]);
  const sim = useSimulation(initialConfig);
  const [tab, setTab] = useState<Tab>('inspect');
  const state = sim.getState();

  const switchScenario = (key: string) => {
    setScenarioKey(key);
    const next = SCENARIOS.find((s) => s.key === key)!;
    sim.reset(next.build());
    setTab('inspect');
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>产线模拟器</h1>
        <span className="subtitle">矿石采集 → 冶炼 → 装配的库存流转、阻塞与账目核对</span>
      </header>

      <div className="scenario-bar">
        <span className="muted small">场景：</span>
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            className={`btn-mini ${s.key === scenarioKey ? 'active' : ''}`}
            onClick={() => switchScenario(s.key)}
            title={s.description}
          >
            {s.name}
          </button>
        ))}
        <span className="muted small scenario-desc">{scenario.description}</span>
      </div>

      <Toolbar sim={sim} />

      <div className="main">
        <div className="canvas-col">
          <CanvasView sim={sim} />
          <Legend />
        </div>

        <aside className="side-col">
          <div className="tabs">
            {([
              ['inspect', '节点检查'],
              ['config', '参数编辑'],
              ['ledger', '资源账目'],
              ['events', '事件日志'],
            ] as [Tab, string][]).map(([k, label]) => (
              <button
                key={k}
                className={`tab ${tab === k ? 'active' : ''}`}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="tab-panel">
            {tab === 'inspect' && (
              <>
                <NodeInspector sim={sim} />
                <ConnectionInspector sim={sim} />
              </>
            )}
            {tab === 'config' && (
              <ConfigEditor config={sim.getConfig()} onApply={(cfg) => sim.applyConfig(cfg)} />
            )}
            {tab === 'ledger' && <LedgerTable state={state} />}
            {tab === 'events' && <EventLog events={state.events} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ['#16a34a', '加工中'],
    ['#dc2626', '缺料'],
    ['#d97706', '等待输出空间'],
    ['#7c3aed', '手动暂停'],
    ['#64748b', '空闲'],
    ['#0e7490', '仓库'],
  ];
  return (
    <div className="legend">
      {items.map(([color, label]) => (
        <span key={label} className="legend-item">
          <i style={{ background: color }} />
          {label}
        </span>
      ))}
      <span className="muted small">圆点为在途货物，沿连线按运输时间移动；数字为批内件数。</span>
    </div>
  );
}
