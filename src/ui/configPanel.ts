import type { Engine } from '../engine/engine';
import type { BranchId } from '../engine/types';

const BRANCH_LABEL: Record<BranchId, string> = {
  retreat: '低生命撤退',
  chase: '范围内追逐',
  patrol: '普通巡逻',
  idle: '原地待命(兜底)',
};

/** 配置写入 stagedConfig, 在 engine.tick() 边界提交 → "修改后下一周期生效" */
export function renderConfig(engine: Engine, el: HTMLElement, onChange: () => void): void {
  const staged = engine.world.stagedConfig;
  const current = engine.world.config;
  const pending = JSON.stringify(staged) !== JSON.stringify(current);

  el.innerHTML = `
    <div class="cfg-row">
      <label>低生命撤退阈值</label>
      <input type="range" id="cfg-hp" min="0" max="100" step="5" value="${staged.lowHpThreshold}">
      <span class="num" id="cfg-hp-num">${staged.lowHpThreshold}</span>
    </div>
    <div class="cfg-row">
      <label>警戒范围</label>
      <input type="range" id="cfg-alert" min="40" max="360" step="10" value="${staged.alertRange}">
      <span class="num" id="cfg-alert-num">${staged.alertRange}</span>
    </div>
    <div class="cfg-row">
      <label>巡逻点等待(s)</label>
      <input type="range" id="cfg-pwait" min="0.5" max="8" step="0.5" value="${staged.patrolWait}">
      <span class="num" id="cfg-pwait-num">${staged.patrolWait.toFixed(1)}</span>
    </div>
    <div class="cfg-row">
      <label>休息点等待(s)</label>
      <input type="range" id="cfg-rwait" min="0.5" max="8" step="0.5" value="${staged.restWait}">
      <span class="num" id="cfg-rwait-num">${staged.restWait.toFixed(1)}</span>
    </div>
    <div class="checkline">
      <input type="checkbox" id="cfg-patrol-on" ${staged.patrolEnabled ? 'checked' : ''}>
      <label for="cfg-patrol-on">启用巡逻分支(关闭后巡逻条件恒失败, NPC 只能追逐/撤退/待命)</label>
    </div>
    <div class="checkline">
      <label>NPC 生命(手动):</label>
      <input type="range" id="cfg-hp-manual" min="0" max="100" step="1" value="${engine.world.npc.hp}">
      <span class="num" id="cfg-hp-manual-num">${engine.world.npc.hp}</span>
    </div>
    <div>
      <label class="k" style="color:var(--muted);font-size:12px">分支优先级(从上到下评估, 即时调整, 下一周期生效)</label>
      <div class="prio-list" id="prio-list"></div>
    </div>
    ${pending ? '<div class="pending-note">⏳ 有未生效的修改, 将在下一个决策周期开始时提交</div>' : ''}
  `;

  const bind = (id: string, fn: (v: number) => void, numId?: string): void => {
    const input = el.querySelector(`#${id}`) as HTMLInputElement;
    input.addEventListener('input', () => {
      fn(Number(input.value));
      if (numId) (el.querySelector(`#${numId}`) as HTMLElement).textContent = input.value;
      onChange();
    });
  };

  bind('cfg-hp', (v) => (staged.lowHpThreshold = v), 'cfg-hp-num');
  bind('cfg-alert', (v) => (staged.alertRange = v), 'cfg-alert-num');
  bind('cfg-pwait', (v) => (staged.patrolWait = v), 'cfg-pwait-num');
  bind('cfg-rwait', (v) => (staged.restWait = v), 'cfg-rwait-num');
  bind('cfg-hp-manual', (v) => (engine.world.npc.hp = v), 'cfg-hp-manual-num');
  el.querySelector('#cfg-patrol-on')!.addEventListener('change', (e) => {
    staged.patrolEnabled = (e.target as HTMLInputElement).checked;
    onChange();
  });

  renderPriority(engine, el.querySelector('#prio-list') as HTMLElement, onChange);
}

function renderPriority(engine: Engine, list: HTMLElement, onChange: () => void): void {
  const order = engine.world.stagedConfig.branchOrder;
  list.innerHTML = order
    .map((id, i) => {
      const pinned = id === 'idle';
      return `
        <div class="prio-item ${pinned ? 'pinned' : ''}" data-branch="${id}">
          <span class="rank">${i + 1}</span>
          <span class="pname">${BRANCH_LABEL[id]}</span>
          <button class="btn small" data-move="up" ${i === 0 || pinned ? 'disabled' : ''}>↑</button>
          <button class="btn small" data-move="down" ${i === order.length - 2 || pinned ? 'disabled' : ''}>↓</button>
        </div>`;
    })
    .join('');

  list.querySelectorAll<HTMLElement>('.prio-item').forEach((row) => {
    const branch = row.dataset.branch as BranchId;
    row.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const arr = engine.world.stagedConfig.branchOrder;
        const idx = arr.indexOf(branch);
        const target = btn.dataset.move === 'up' ? idx - 1 : idx + 1;
        if (target < 0 || target >= arr.length - 1) return; // idle 钉在最后
        [arr[idx], arr[target]] = [arr[target], arr[idx]];
        onChange();
      });
    });
  });
}
