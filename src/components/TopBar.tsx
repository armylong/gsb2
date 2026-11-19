import { useEffect, useState } from 'react';

export type MainTab = 'simulate' | 'scenarios' | 'verify';

const TABS: { id: MainTab; label: string; hint: string }[] = [
  { id: 'simulate', label: '结算模拟', hint: '时间线 + 事件表 + 数值' },
  { id: 'scenarios', label: '示例库', hint: '三组可重置例子' },
  { id: 'verify', label: '结算验证', hint: '已知预期数值核对' },
];

export function TopBar({
  tab,
  onTab,
  dirty,
  scenarioName,
  resultHash,
}: {
  tab: MainTab;
  onTab: (tab: MainTab) => void;
  dirty: boolean;
  scenarioName: string;
  resultHash: string;
}) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = window.localStorage.getItem('settle-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('settle-theme', theme);
  }, [theme]);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <h1>技能效果结算模拟台</h1>
          <p className="subtle">增益 · 持续伤害 · 护盾 — 叠加、刷新、到期使用同一套规则</p>
        </div>
      </div>
      <nav className="tabs" aria-label="主导航">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'tab active' : 'tab'}
            onClick={() => onTab(item.id)}
            title={item.hint}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="top-meta">
        <span className={dirty ? 'badge warn' : 'badge ok'} title={dirty ? '时间表已改动，结果已按新时间表重算' : '与示例初始状态一致'}>
          {dirty ? '已修改' : '原始示例'} · {scenarioName}
        </span>
        <code className="hash" title="结果指纹：时间表或目标配置变化即变化">
          {resultHash.split(':').pop()}
        </code>
        <button className="ghost icon" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} title="切换明暗主题">
          {theme === 'light' ? '☾' : '☀'}
        </button>
      </div>
    </header>
  );
}
