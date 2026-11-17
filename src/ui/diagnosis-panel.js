// 诊断卡片与 A/B 差异面板渲染
import { STATE_LABELS } from '../diag/engine.js';

const SEVERITY_CLASS = { error: 'sev-error', warn: 'sev-warn', info: 'sev-info' };
const KIND_LABELS = {
  coverage: '覆盖范围',
  bias: '偏移',
  resolution: '清晰度',
  ok: '正常',
};

export function renderDiagnosis(root, report, params) {
  root.innerHTML = '';

  // 顶部指标条
  const meter = document.createElement('div');
  meter.className = 'diag-meter';
  const coveragePct = Math.round(report.viewCoverage * 100);
  meter.innerHTML = `
    <div class="metric"><b>${coveragePct}%</b><span>视野覆盖率</span></div>
    <div class="metric"><b>${report.texel.toFixed(3)}</b><span>texel(单位)</span></div>
    <div class="metric"><b>${report.stats.inside}/${report.stats.total}</b><span>覆盖物体</span></div>
    <div class="metric"><b>${params.mapSize}px</b><span>阴影贴图</span></div>
  `;
  root.appendChild(meter);

  // 诊断条目
  for (const f of report.findings) {
    const card = document.createElement('div');
    card.className = `finding ${SEVERITY_CLASS[f.severity]}`;
    card.innerHTML = `
      <div class="finding-head">
        <span class="finding-kind">${KIND_LABELS[f.kind] || f.kind}</span>
        <span class="finding-title">${f.title}</span>
      </div>
      <p class="finding-detail">${f.detail}</p>
      <p class="finding-basis"><b>依据：</b>${f.basis}</p>
      ${f.suggestion ? `<p class="finding-suggestion"><b>建议：</b>${f.suggestion}</p>` : ''}
    `;
    root.appendChild(card);
  }

  // 物体状态表
  const table = document.createElement('div');
  table.className = 'state-table';
  table.innerHTML = '<h4>物体覆盖状态（随视角/参数实时更新）</h4>';
  for (const o of report.objectReports) {
    const row = document.createElement('div');
    row.className = 'state-row';
    row.innerHTML = `
      <span class="state-dot state-${o.state}"></span>
      <span class="state-label">${o.label}</span>
      <span class="state-value">${STATE_LABELS[o.state]}</span>
      <span class="state-view">${o.inView ? '视野内' : '视野外'}</span>
    `;
    table.appendChild(row);
  }
  root.appendChild(table);
}

export function renderDiff(root, diff, nameA, nameB) {
  root.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = `诊断差异：${nameA} → ${nameB}`;
  root.appendChild(h);

  // 指标对比
  const metricTable = document.createElement('div');
  metricTable.className = 'diff-metrics';
  for (const m of diff.metrics) {
    const row = document.createElement('div');
    row.className = 'diff-metric-row';
    const delta = m.b - m.a;
    const better = m.higherBetter ? delta > 0 : delta < 0;
    const worse = m.higherBetter ? delta < 0 : delta > 0;
    row.innerHTML = `
      <span class="diff-metric-label">${m.label}</span>
      <span class="diff-metric-values">
        ${m.format(m.a)} <i>→</i> <b class="${better ? 'val-better' : worse ? 'val-worse' : ''}">${m.format(m.b)}</b>
      </span>
    `;
    metricTable.appendChild(row);
  }
  root.appendChild(metricTable);

  // 诊断条目变化
  if (!diff.entries.length) {
    const ok = document.createElement('p');
    ok.className = 'diff-empty';
    ok.textContent = '两组设置触发的诊断条目完全相同。';
    root.appendChild(ok);
  } else {
    const CHANGE_META = {
      introduced: ['新增问题', 'diff-introduced'],
      resolved: ['已消除', 'diff-resolved'],
      worsened: ['严重度上升', 'diff-worsened'],
      improved: ['严重度下降', 'diff-improved'],
    };
    for (const e of diff.entries) {
      const [label, cls] = CHANGE_META[e.change];
      const card = document.createElement('div');
      card.className = `diff-entry ${cls}`;
      card.innerHTML = `<span class="diff-tag">${label}</span><span>${e.title}</span>`;
      root.appendChild(card);
    }
  }

  // 物体级状态变化
  if (diff.objDiffs.length) {
    const sub = document.createElement('h4');
    sub.textContent = '物体状态变化';
    root.appendChild(sub);
    for (const d of diff.objDiffs) {
      const row = document.createElement('div');
      row.className = 'diff-obj-row';
      row.innerHTML = `<span>${d.label}</span><span>${STATE_LABELS[d.from]} <i>→</i> <b>${STATE_LABELS[d.to]}</b></span>`;
      root.appendChild(row);
    }
  }
}
