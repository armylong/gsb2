import './style.css';
import { simulate } from './engine';
import { findRoutes, nodeName, pathCost, uid, clamp } from './graph';
import { levels } from './levels';
import { buildConflictPresets, cloneData, type ConflictPreset } from './presets';
import { hitActor, renderStage, STAGE_H, STAGE_W } from './render';
import { runLocalValidation } from './validation';
import type { PlanAction, SimulationResult, ValidationReport } from './types';

const presets = buildConflictPresets();

let levelIndex = 0;
let level = levels[levelIndex];
let plan = cloneData(level.solution);
let sim: SimulationResult = simulate(level, plan);
let time = 0;
let playing = false;
let speed = 1;
let selectedActorId: string | null = level.actors[0]?.id ?? null;
let tab: 'plan' | 'check' = 'plan';
let report: ValidationReport | null = null;
let flash = '';
let lastRenderedBeat = -1;
let renderedPositions = new Map<string, { x: number; y: number }>();

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="app-header">
    <div>
      <p class="eyebrow">TypeScript + Canvas · Local Puzzle Prototype</p>
      <h1>后台赶场：小剧场排戏解谜</h1>
    </div>
    <div class="header-actions">
      <button class="btn good" data-action="replay">↻ 改完，从开场重看</button>
      <button class="btn primary" data-action="run-validation">运行本地验证</button>
    </div>
  </header>

  <nav class="level-tabs" id="level-tabs"></nav>
  <section class="card level-brief" id="level-brief"></section>

  <div class="layout">
    <section class="card stage-card">
      <div class="canvas-wrap">
        <canvas id="stage" width="${STAGE_W}" height="${STAGE_H}" aria-label="剧场后台地图"></canvas>
      </div>
      <div class="transport">
        <button class="btn small" data-action="reset" title="回到开场">⏮ 开场</button>
        <button class="btn small" data-action="back">−1 拍</button>
        <button class="btn primary" data-action="play" id="play-btn">▶ 播放</button>
        <button class="btn small" data-action="forward">+1 拍</button>
        <input id="scrub" type="range" min="0" max="${level.horizon}" value="0" step="1" aria-label="时间轴" />
        <span class="beat-readout" id="beat-readout">第 0 拍</span>
        <select id="speed" class="speed-select" aria-label="播放速度">
          <option value="0.5">0.5 拍/秒</option>
          <option value="1" selected>1 拍/秒</option>
          <option value="2">2 拍/秒</option>
          <option value="4">4 拍/秒</option>
        </select>
      </div>
      <div id="prefix-bar"></div>
      <div id="inspector" class="stack"></div>
    </section>

    <aside class="sidebar">
      <div class="tabs">
        <button class="btn tab-btn" data-action="tab" data-tab="plan">① 选角 / 分配走法</button>
        <button class="btn tab-btn" data-action="tab" data-tab="check">② 停拍核对 / 结算</button>
      </div>
      <div id="plan-tab">
        <section class="card panel" id="casting-panel"></section>
        <section class="card panel" id="actions-panel"></section>
      </div>
      <div id="check-tab" hidden>
        <section class="card panel" id="result-panel"></section>
        <section class="card panel" id="scenes-panel"></section>
        <section class="card panel" id="violations-panel"></section>
        <section class="card panel" id="presets-panel"></section>
        <section class="card panel" id="validation-panel"></section>
        <section class="card panel">
          <h3>规则与操作</h3>
          <ul class="help-list">
            <li>走道标签是单程通行拍数；移动块时长必须等于所选路线总时长。</li>
            <li>换装块必须位于 A/B 间，时长达到衣服的连续所需拍数；两间更衣室不能重叠占用。</li>
            <li>演员同一时间不能重叠两个计划块，也不能在幕的演出区间内离开舞台。</li>
            <li>外套先由本人在中转台「留」，另一人再「取」；取到后仍须进更衣室完整换上。</li>
            <li>点画布中的演员可选中；点 −1/+1 或拖动时间轴可停在指定拍核对位置、穿着和入口队列。</li>
            <li>可把当前拍标记为保留段并锁定；之后改后面的块，再点“从开场重看”，前面的计划不会丢。</li>
          </ul>
        </section>
      </div>
    </aside>
  </div>
`;

const canvas = app.querySelector<HTMLCanvasElement>('#stage')!;
const ctx = canvas.getContext('2d')!;
const scrub = app.querySelector<HTMLInputElement>('#scrub')!;
const speedSelect = app.querySelector<HTMLSelectElement>('#speed')!;

function garmentName(id: string | null | undefined): string {
  if (!id) return '未穿对应件';
  return level.garments.find((g) => g.id === id)?.name ?? id;
}

function sceneTitle(sceneId: string | null | undefined): string {
  if (!sceneId) return '';
  return level.scenes.find((s) => s.id === sceneId)?.title ?? sceneId;
}

function actionSummary(action: PlanAction): string {
  if (action.type === 'move') {
    return `移动 ${action.path.join(' → ')}`;
  }
  if (action.type === 'change') {
    return `在 ${action.room} 间换「${garmentName(action.garmentId)}」`;
  }
  return `${action.type === 'leave' ? '留交' : '取走'}「${garmentName(action.garmentId)}」于中转台`;
}

function loadLevel(index: number): void {
  levelIndex = index;
  level = levels[index];
  plan = cloneData(level.solution);
  sim = simulate(level, plan);
  time = 0;
  playing = false;
  selectedActorId = level.actors[0]?.id ?? null;
  report = null;
  flash = '';
  scrub.max = String(level.horizon);
  scrub.value = '0';
  speedSelect.value = String(speed);
  renderAll();
}

function loadPreset(preset: ConflictPreset): void {
  const idx = levels.findIndex((l) => l.id === preset.levelId);
  levelIndex = idx;
  level = levels[idx];
  plan = cloneData(preset.plan);
  sim = simulate(level, plan);
  time = 0;
  playing = false;
  selectedActorId = level.actors[0]?.id ?? null;
  tab = 'check';
  flash = `已载入冲突例：${preset.description}`;
  scrub.max = String(level.horizon);
  renderAll();
}

function recompute(): void {
  sim = simulate(level, plan);
  renderLevelChrome();
  renderPlanPanel();
  renderCheckPanel();
  renderInspector(true);
}

function setTab(next: 'plan' | 'check'): void {
  tab = next;
  renderLevelChrome();
}

// ---------------------------------------------------------------------------
// Rendering: header / panels
// ---------------------------------------------------------------------------

function updateHud(): void {
  const playBtn = app.querySelector<HTMLButtonElement>('#play-btn');
  if (playBtn) playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
  const readout = app.querySelector<HTMLElement>('#beat-readout');
  if (readout) readout.textContent = `第 ${Math.floor(time)} / ${level.horizon} 拍`;
  if (document.activeElement !== scrub) scrub.value = String(Math.floor(time));
}

function renderLevelChrome(): void {
  const tabs = app.querySelector<HTMLElement>('#level-tabs')!;
  tabs.innerHTML = levels
    .map(
      (item, i) => `
      <button data-action="level" data-index="${i}" class="btn level-tab ${i === levelIndex ? 'active' : ''}">
        ${item.name}
        <span class="muted" style="display:block;margin-top:3px;font-weight:600">${item.tagline}</span>
      </button>`,
    )
    .join('');

  app.querySelector<HTMLElement>('#level-brief')!.innerHTML = `
    <h2>${level.name}</h2>
    <p>${level.brief}</p>
    <p class="hint">${level.winHint}</p>
    ${flash ? `<p><span class="badge warn">${flash}</span></p>` : ''}
  `;

  app.querySelector<HTMLElement>('#plan-tab')!.hidden = tab !== 'plan';
  app.querySelector<HTMLElement>('#check-tab')!.hidden = tab !== 'check';
  app.querySelectorAll<HTMLButtonElement>('[data-action="tab"]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  updateHud();
}

function renderPrefixBar(): void {
  const host = app.querySelector<HTMLElement>('#prefix-bar')!;
  const p = plan.preserveThrough ?? null;
  const safeBeat = sim.firstErrorBeat === null ? level.horizon : Math.max(0, sim.firstErrorBeat - 1);
  if (p === null || p === undefined) {
    host.innerHTML = `
      <div class="prefix-bar" style="margin-top:12px">
        <span>引擎判断当前计划的无错误前缀约到 <b>第 ${safeBeat} 拍</b>；也可播放到目标拍后手动保留。</span>
        <button class="btn small good" data-action="set-preserve-beat" data-beat="${safeBeat}">保留建议前缀</button>
        <button class="btn small" data-action="set-preserve">保留到第 ${Math.floor(time)} 拍</button>
      </div>`;
    return;
  }
  const bad = sim.violations.some((v) => v.beat <= p);
  host.innerHTML = `
    <div class="prefix-bar" style="margin-top:12px">
      <span class="badge ${bad ? 'err' : 'ok'}">${bad ? '保留段内仍有冲突' : `第 0–${p} 拍可行并已保留`}</span>
      <span>${plan.lockPreserved ? '早于保留点的计划块已锁定，可在后面改一段。' : '锁定后可防止误改前面的可行块。'}</span>
      <button class="btn small" data-action="toggle-lock">${plan.lockPreserved ? '解锁保留段' : '锁定保留段'}</button>
      <button class="btn small" data-action="set-preserve">更新到第 ${Math.floor(time)} 拍</button>
      <button class="btn small danger" data-action="clear-preserve">清除</button>
    </div>`;
}

function renderInspector(force = false): void {
  const beat = Math.floor(clamp(time, 0, level.horizon));
  if (!force && beat === lastRenderedBeat) return;
  lastRenderedBeat = beat;
  renderPrefixBar();

  const snap = sim.snapshots[beat];
  const host = app.querySelector<HTMLElement>('#inspector')!;
  if (!snap) return;

  const actorCards = level.actors
    .map((actor) => {
      const state = snap.actors.find((a) => a.id === actor.id)!;
      let position = nodeName(level, state.location);
      if (state.transit) {
        const names = state.transit.path.map((id) => nodeName(level, id)).join(' → ');
        position = `路上：${names}（${state.transit.elapsed}/${state.transit.duration} 拍）`;
      }
      const currentAction = state.currentActionId
        ? plan.actions.find((a) => a.id === state.currentActionId)
        : null;
      const rejected = currentAction ? sim.statusById[currentAction.id] === 'rejected' : false;
      const worn = (['base', 'outer'] as const)
        .map((slot) => `<span class="badge info">${slot === 'base' ? '贴身' : '外套'}：${garmentName(state.worn[slot])}</span>`)
        .join(' ');
      const carried = state.carried.length
        ? state.carried.map((id) => `<span class="badge warn">携：${garmentName(id)}</span>`).join(' ')
        : '<span class="muted">无携带物</span>';
      const queueBadges = (['L', 'R'] as const)
        .filter((door) => snap.queues[door].includes(actor.id))
        .map((door) => `<span class="badge ok">${door} 入口队列 #${snap.queues[door].indexOf(actor.id) + 1}</span>`)
        .join('');
      const status = state.busySceneId
        ? `<span class="badge info">演出中：${sceneTitle(state.busySceneId)}</span>`
        : currentAction
          ? `<span class="badge ${rejected ? 'err' : 'warn'}">${rejected ? '冲突块已停止生效：' : '正在：'}${actionSummary(currentAction)}</span>`
          : '<span class="badge ok">空闲/待命</span>';
      return `
        <div class="actor-inspector ${selectedActorId === actor.id ? 'selected' : ''}" data-action="select-actor" data-id="${actor.id}">
          <div class="actor-line">
            <span class="dot" style="background:${actor.color}"></span>
            <span>${actor.name}</span>
            ${queueBadges}
          </div>
          <div class="kv">
            <b>位置</b><span>${position}</span>
            <b>状态</b><span>${status}</span>
            <b>穿着</b><span>${worn}</span>
            <b>携带</b><span>${carried}</span>
          </div>
        </div>`;
    })
    .join('');

  const rooms = (['A', 'B'] as const)
    .map((room) => {
      const usage = snap.roomUsage.filter((u) => u.room === room);
      return `<div><b>${room} 间：</b>${
        usage.length
          ? usage
              .map(
                (u) =>
                  `<span class="badge ${u.accepted ? 'warn' : 'err'}">${u.actorId} ${u.start}–${u.end} ${u.label}${u.accepted ? '' : ' 冲突'}</span>`,
              )
              .join(' ')
          : '<span class="muted">空</span>'
      }</div>`;
    })
    .join('');

  const relayItems = snap.garments.filter((g) => g.location === 'T' && !g.wornBy && !g.carriedBy);
  const beatIssues = sim.violations.filter((v) => v.beat <= beat);
  const currentSceneVerdicts = sim.sceneVerdicts.filter((s) => s.start <= beat);

  host.innerHTML = `
    <div class="section-title">第 ${beat} 拍核对台</div>
    ${
      beat === level.horizon
        ? `<div class="result-banner ${sim.passed ? 'pass' : 'fail'}">${
            sim.passed
              ? '时间到：所有幕均按实际到场和换衣结果通关'
              : `时间到：本场未通关，${sim.violations.length} 条冲突 / ${sim.cueVerdicts.filter((c) => !c.ok).length} 个登场未过`
          }</div>`
        : ''
    }
    <div class="stack">${actorCards}</div>

    <div class="card panel" style="margin:12px 0 0;padding:12px">
      <h3>两处入口排队</h3>
      <div class="queue-row"><span class="badge info">左 L</span> ${
        snap.queues.L.length ? snap.queues.L.map((id, i) => `${i + 1}. ${level.actors.find((a) => a.id === id)?.name}`).join('　') : '<span class="muted">无人排队</span>'
      }</div>
      <div class="queue-row" style="margin-top:6px"><span class="badge info">右 R</span> ${
        snap.queues.R.length ? snap.queues.R.map((id, i) => `${i + 1}. ${level.actors.find((a) => a.id === id)?.name}`).join('　') : '<span class="muted">无人排队</span>'
      }</div>
    </div>

    <div class="card panel" style="margin:12px 0 0;padding:12px">
      <h3>更衣室 / 中转台</h3>
      <div class="stack">${rooms}</div>
      <div class="relay-row" style="margin-top:8px">
        <span class="badge ok">T 中转台</span>
        ${relayItems.length ? relayItems.map((g) => `<span class="badge warn">${g.name}</span>`).join(' ') : '<span class="muted">没有暂存衣物</span>'}
      </div>
    </div>

    <div class="card panel" style="margin:12px 0 0;padding:12px">
      <h3>已开演幕的结算</h3>
      ${
        currentSceneVerdicts.length
          ? currentSceneVerdicts
              .map(
                (s) => `
          <div class="scene-card ${s.ok ? 'ok' : 'bad'}" style="margin-bottom:8px">
            <div class="scene-title"><span>${s.title} · ${s.start} 拍 · ${s.entrance} 口</span><span class="badge ${s.ok ? 'ok' : 'err'}">${s.ok ? '通过' : '未通过'}</span></div>
            ${s.cues
              .map(
                (c) => `<div class="cue"><span>${c.role} / ${c.actorId ?? '未分配'}</span><span class="badge ${c.ok ? 'ok' : 'err'}">${cueStatusLabel(c.status)}</span></div>`,
              )
              .join('')}
          </div>`,
              )
              .join('')
          : '<p class="muted">尚未有幕开演。可播放或拖动到开演拍。</p>'
      }
      ${
        beatIssues.length
          ? `<p class="muted" style="margin-bottom:0">截至本拍已有 ${beatIssues.length} 条错误，右侧“核对”页可看完整原因。</p>`
          : '<p class="muted" style="margin-bottom:0">截至本拍没有诊断错误。</p>'
      }
    </div>
  `;
}

function cueStatusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return '准时 / 对门 / 衣服对';
    case 'uncast':
      return '未分配';
    case 'late':
      return '迟到';
    case 'wrong-door':
      return '走错门';
    case 'costume':
      return '衣服没换好';
    case 'conflict':
      return '时间冲突';
    case 'casting':
      return '选角不符';
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Plan editor
// ---------------------------------------------------------------------------

function isLocked(action: PlanAction): boolean {
  const p = plan.preserveThrough;
  return !!plan.lockPreserved && p !== null && p !== undefined && action.start + action.duration <= p;
}

function renderCastingPanel(): void {
  const host = app.querySelector<HTMLElement>('#casting-panel')!;
  host.innerHTML = `
    <div class="panel-head"><h3>一幕需要哪些角色 / 入口</h3></div>
    <div class="casting-grid">
      ${level.scenes
        .map(
          (scene) => `
          <div class="section-title" style="margin:4px 0">${scene.title}：第 ${scene.start} 拍 · ${scene.entrance} 口 · 演出 ${scene.duration} 拍</div>
          ${scene.appearances
            .map((app) => {
              const options = app.candidateIds
                .map((id) => `<option value="${id}" ${plan.casting[app.id] === id ? 'selected' : ''}>${level.actors.find((a) => a.id === id)?.name ?? id}</option>`)
                .join('');
              return `
                <div class="casting-row">
                  <div><b>${app.role}</b><div class="muted">需要：${Object.values(app.requires).map(garmentName).join(' + ')}</div></div>
                  <select data-casting="${app.id}" aria-label="分配演员">
                    <option value="">未分配</option>
                    ${options}
                  </select>
                </div>`;
            })
            .join('')}
        `,
        )
        .join('')}
    </div>
  `;
}

function routeEditor(action: Extract<PlanAction, { type: 'move' }>, locked: boolean): string {
  const from = action.path[0];
  const to = action.path[action.path.length - 1];
  const routes = findRoutes(level, from, to);
  const currentKey = JSON.stringify(action.path);
  if (!routes.some((r) => JSON.stringify(r) === currentKey)) routes.unshift(action.path);
  const nodeOptions = level.nodes
    .map((n) => `<option value="${n.id}" ${n.id === from ? 'selected' : ''}>${n.id} ${n.name}</option>`)
    .join('');
  const toOptions = level.nodes
    .map((n) => `<option value="${n.id}" ${n.id === to ? 'selected' : ''}>${n.id} ${n.name}</option>`)
    .join('');
  const routeOptions = routes
    .map((route) => {
      const cost = pathCost(level, route) ?? '?';
      const key = encodeURIComponent(JSON.stringify(route));
      return `<option value="${key}" ${JSON.stringify(route) === currentKey ? 'selected' : ''}>${route.join('→')}（${cost}拍）</option>`;
    })
    .join('');
  return `
    <label class="field">起点<select data-edit-action="${action.id}" data-field="route-from" ${locked ? 'disabled' : ''}>${nodeOptions}</select></label>
    <label class="field">终点<select data-edit-action="${action.id}" data-field="route-to" ${locked ? 'disabled' : ''}>${toOptions}</select></label>
    <label class="field wide">具体走法 / 路线时长<select data-edit-action="${action.id}" data-field="route-path" ${locked ? 'disabled' : ''}>${routeOptions}</select></label>
    <label class="field">实际耗时<input type="number" value="${action.duration}" disabled /></label>
  `;
}

function renderActionCard(action: PlanAction): string {
  const locked = isLocked(action);
  const rejected = sim.statusById[action.id] === 'rejected';
  const common = `
    <label class="field">开始拍
      <input type="number" min="0" max="${level.horizon}" step="1" value="${action.start}" data-edit-action="${action.id}" data-field="start" ${locked ? 'disabled' : ''}/>
    </label>`;
  let fields = '';

  if (action.type === 'move') {
    fields = routeEditor(action, locked);
  } else if (action.type === 'change') {
    fields = `
      <label class="field">更衣室
        <select data-edit-action="${action.id}" data-field="room" ${locked ? 'disabled' : ''}>
          <option value="A" ${action.room === 'A' ? 'selected' : ''}>A 间</option>
          <option value="B" ${action.room === 'B' ? 'selected' : ''}>B 间</option>
        </select>
      </label>
      <label class="field wide">要换的衣服
        <select data-edit-action="${action.id}" data-field="garmentId" ${locked ? 'disabled' : ''}>
          ${level.garments
            .map(
              (g) =>
                `<option value="${g.id}" ${action.garmentId === g.id ? 'selected' : ''}>${g.name}（需 ${g.don} 拍，可穿：${g.wearableBy.join('/')}）</option>`,
            )
            .join('')}
        </select>
      </label>
      <label class="field">给时(拍)
        <input type="number" min="1" step="1" value="${action.duration}" data-edit-action="${action.id}" data-field="duration" ${locked ? 'disabled' : ''}/>
      </label>`;
  } else {
    fields = `
      <label class="field">动作
        <select data-edit-action="${action.id}" data-field="transfer-type" ${locked ? 'disabled' : ''}>
          <option value="leave" ${action.type === 'leave' ? 'selected' : ''}>留到 T</option>
          <option value="take" ${action.type === 'take' ? 'selected' : ''}>从 T 取</option>
        </select>
      </label>
      <label class="field wide">交接衣物
        <select data-edit-action="${action.id}" data-field="garmentId" ${locked ? 'disabled' : ''}>
          ${level.garments
            .map((g) => `<option value="${g.id}" ${action.garmentId === g.id ? 'selected' : ''}>${g.name}${g.transferable ? '（可交接）' : '（不可交接）'}</option>`)
            .join('')}
        </select>
      </label>
      <label class="field">耗时
        <input type="number" min="1" step="1" value="${action.duration}" data-edit-action="${action.id}" data-field="duration" ${locked ? 'disabled' : ''}/>
      </label>`;
  }

  return `
    <div class="action-card ${locked ? 'locked' : ''} ${rejected ? 'rejected' : ''}">
      <div class="action-meta">
        <span class="action-type">${action.type === 'move' ? '🚶 走路' : action.type === 'change' ? '👘 更衣' : '🔁 交接'} · ${action.start}–${action.start + action.duration} 拍</span>
        <span>
          ${locked ? '<span class="badge ok">已保留锁定</span>' : ''}
          ${rejected ? '<span class="badge err">冲突停用</span>' : ''}
          <button class="btn small danger" data-action="delete-action" data-id="${action.id}" ${locked ? 'disabled' : ''}>删除</button>
        </span>
      </div>
      <div class="action-grid">${common}${fields}</div>
    </div>`;
}

function renderActionsPanel(): void {
  const host = app.querySelector<HTMLElement>('#actions-panel')!;
  host.innerHTML = `
    <div class="panel-head">
      <h3>演员时间块 / 走法 / 更衣时间</h3>
      <div class="add-row">
        <button class="btn small" data-action="load-solution">填入参考方案</button>
      </div>
    </div>
    <p class="muted">修改后会立即从第 0 拍确定性重算；点顶部“从开场重看”可播放。路线时长由走道时间自动求和。</p>
    ${level.actors
      .map((actor) => {
        const actions = plan.actions
          .filter((a) => a.actorId === actor.id)
          .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        return `
          <div class="actor-plan-group">
            <div class="actor-plan-head">
              <div class="actor-line"><span class="dot" style="background:${actor.color}"></span><b>${actor.name}</b></div>
              <div class="add-row">
                <button class="btn small" data-action="add-move" data-actor="${actor.id}">+ 走路</button>
                <button class="btn small" data-action="add-change" data-actor="${actor.id}">+ 更衣</button>
                <button class="btn small" data-action="add-transfer" data-actor="${actor.id}">+ 交接</button>
              </div>
            </div>
            ${actions.length ? actions.map(renderActionCard).join('') : '<p class="muted">还没有计划块。</p>'}
          </div>`;
      })
      .join('')}
  `;
}

function renderPlanPanel(): void {
  renderCastingPanel();
  renderActionsPanel();
}

// ---------------------------------------------------------------------------
// Check panels
// ---------------------------------------------------------------------------

function renderResultPanel(): void {
  const host = app.querySelector<HTMLElement>('#result-panel')!;
  const errorCount = sim.violations.length;
  host.innerHTML = `
    <h3>整场结算</h3>
    <div class="result-banner ${sim.passed ? 'pass' : 'fail'}">
      ${sim.passed ? '通关：实际到场、入口与演出中换衣均成立' : `尚不能通关：${errorCount} 条错误，第一处通常在第 ${sim.firstErrorBeat ?? '?'} 拍`}
    </div>
    <div class="add-row">
      <button class="btn small" data-action="seek" data-beat="${level.horizon}">跳到最终结算拍</button>
      <button class="btn small good" data-action="replay">从开场重新播放</button>
    </div>
    <p class="muted" style="margin-bottom:0">判定不看计划块的“意图”，只看模拟后的实际位置、穿着、更衣室占用和衣物归属。</p>
  `;
}

function renderScenesPanel(): void {
  const host = app.querySelector<HTMLElement>('#scenes-panel')!;
  host.innerHTML = `
    <h3>每幕开演核对</h3>
    ${sim.sceneVerdicts
      .map((scene) => {
        const future = scene.start > Math.floor(time);
        return `
        <div class="scene-card ${scene.ok ? 'ok' : 'bad'} ${future ? 'future' : ''}" style="margin-bottom:10px">
          <div class="scene-title">
            <span>${scene.title} · 第 ${scene.start} 拍 · ${scene.entrance} 口</span>
            <button class="btn small" data-action="seek" data-beat="${scene.start}">停在这拍</button>
          </div>
          ${scene.cues
            .map(
              (cue) => `
              <div class="cue">
                <div><b>${cue.role}</b> / ${cue.actorId ?? '未分配'}
                  <div class="muted">${cue.issues.map((i) => i.message).join('；') || (future ? '尚未开演，以下为完整模拟结果' : '准时、入口正确、戏服正确')}</div>
                </div>
                <span class="badge ${cue.ok ? 'ok' : 'err'}">${cueStatusLabel(cue.status)}</span>
              </div>`,
            )
            .join('')}
        </div>`;
      })
      .join('')}
  `;
}

function renderViolationsPanel(): void {
  const host = app.querySelector<HTMLElement>('#violations-panel')!;
  const sorted = [...sim.violations].sort((a, b) => a.beat - b.beat);
  host.innerHTML = `
    <h3>冲突与原因（${sorted.length}）</h3>
    ${
      sorted.length
        ? sorted
            .map(
              (v) => `
            <div class="violation-card">
              <div><code>${v.code}</code> · 第 ${v.beat} 拍${v.actorId ? ` · 演员 ${v.actorId}` : ''}</div>
              <div>${v.message}</div>
              ${v.actionId ? `<div class="muted">计划块：${v.actionId}</div>` : ''}
            </div>`,
            )
            .join('')
        : '<p class="muted">没有静态或动态冲突。</p>'
    }
  `;
}

function renderPresetsPanel(): void {
  const host = app.querySelector<HTMLElement>('#presets-panel')!;
  host.innerHTML = `
    <h3>一键载入冲突处理例</h3>
    <div class="preset-grid">
      ${presets
        .map(
          (p) => `
        <button class="btn preset-btn" data-action="preset" data-id="${p.id}">
          <b>${p.name}</b>
          <span class="muted" style="display:block;margin-top:3px">${p.description}</span>
        </button>`,
        )
        .join('')}
    </div>
  `;
}

function renderValidationPanel(): void {
  const host = app.querySelector<HTMLElement>('#validation-panel')!;
  host.innerHTML = `
    <div class="panel-head"><h3>本地验证</h3><button class="btn small primary" data-action="run-validation">重新验证</button></div>
    <p class="muted">等价命令：<code>npm run validate</code>。它会走完整两场，并断言六类冲突与保留段重算。</p>
    ${
      report
        ? report.checks
            .map(
              (c) => `
          <div class="check-line ${c.ok ? 'ok' : 'fail'}">
            <div class="check-icon">${c.ok ? '✓' : '×'}</div>
            <div><b>${c.name}</b><div class="check-detail">${c.detail}</div></div>
          </div>`,
            )
            .join('') +
          `<div class="result-banner ${report.ok ? 'pass' : 'fail'}">${report.ok ? `全部 ${report.checks.length} 项本地验证通过` : '存在失败验证'}</div>`
        : '<p class="muted">尚未在浏览器内运行验证。</p>'
    }
  `;
}

function renderCheckPanel(): void {
  renderResultPanel();
  renderScenesPanel();
  renderViolationsPanel();
  renderPresetsPanel();
  renderValidationPanel();
}

function renderAll(): void {
  renderLevelChrome();
  renderPlanPanel();
  renderCheckPanel();
  lastRenderedBeat = -1;
  renderInspector(true);
}

// ---------------------------------------------------------------------------
// Editing operations
// ---------------------------------------------------------------------------

function addBlock(actorId: string, type: 'move' | 'change' | 'transfer'): void {
  const beat = Math.floor(time);
  const actor = sim.snapshots[clamp(beat, 0, level.horizon)].actors.find((a) => a.id === actorId)!;
  const lastEnd = plan.actions
    .filter((a) => a.actorId === actorId)
    .reduce((max, a) => Math.max(max, a.start + a.duration), 0);
  const start = Math.max(beat, lastEnd, plan.preserveThrough ?? 0);

  if (type === 'move') {
    const routes = findRoutes(level, actor.location, 'R');
    const route = routes.find((r) => (pathCost(level, r) ?? 0) > 0) ?? [actor.location, ...level.nodes.filter((n) => n.id !== actor.location).slice(0, 1).map((n) => n.id)];
    const duration = pathCost(level, route) ?? 1;
    plan.actions.push({ id: uid('move'), type: 'move', actorId, start, duration, path: route });
  } else if (type === 'change') {
    const room = actor.location === 'A' || actor.location === 'B' ? actor.location : 'A';
    const garment =
      level.garments.find((g) => g.wearableBy.includes(actorId) && (actor.location === room || true)) ??
      level.garments[0];
    plan.actions.push({
      id: uid('change'),
      type: 'change',
      actorId,
      start,
      duration: garment.don,
      room,
      garmentId: garment.id,
    });
  } else {
    const transferable = level.garments.find((g) => g.transferable) ?? level.garments[0];
    plan.actions.push({
      id: uid('transfer'),
      type: 'take',
      actorId,
      start,
      duration: 1,
      node: 'T',
      garmentId: transferable.id,
    });
  }
  recompute();
}

function updateAction(id: string, patch: Record<string, unknown>): void {
  const action = plan.actions.find((a) => a.id === id);
  if (!action || isLocked(action)) return;
  Object.assign(action, patch);
  recompute();
}

function handleRouteEdit(actionId: string, field: string, value: string): void {
  const action = plan.actions.find((a) => a.id === actionId);
  if (!action || action.type !== 'move' || isLocked(action)) return;

  let from = action.path[0];
  let to = action.path[action.path.length - 1];
  if (field === 'route-from') from = value as any;
  if (field === 'route-to') to = value as any;

  if (field === 'route-path') {
    try {
      const path = JSON.parse(decodeURIComponent(value)) as any[];
      updateAction(actionId, { path: path as any, duration: pathCost(level, path as any) ?? action.duration });
      return;
    } catch {
      return;
    }
  }

  const routes = findRoutes(level, from as any, to as any);
  const route = routes[0] ?? [from, to];
  updateAction(actionId, { path: route, duration: pathCost(level, route) ?? action.duration });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

app.addEventListener('click', (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'level':
      loadLevel(Number(el.dataset.index));
      break;
    case 'tab':
      setTab(el.dataset.tab as 'plan' | 'check');
      break;
    case 'play':
      if (time >= level.horizon) time = 0;
      playing = !playing;
      renderLevelChrome();
      break;
    case 'reset':
      playing = false;
      time = 0;
      renderLevelChrome();
      renderInspector(true);
      break;
    case 'back':
      playing = false;
      time = Math.max(0, Math.ceil(time) - 1);
      renderLevelChrome();
      renderInspector(true);
      break;
    case 'forward':
      playing = false;
      time = Math.min(level.horizon, Math.floor(time) + 1);
      renderLevelChrome();
      renderInspector(true);
      break;
    case 'replay':
      time = 0;
      playing = true;
      renderLevelChrome();
      break;
    case 'seek':
      playing = false;
      time = Number(el.dataset.beat);
      renderLevelChrome();
      renderInspector(true);
      break;
    case 'select-actor':
      selectedActorId = el.dataset.id ?? null;
      renderInspector(true);
      renderPlanPanel();
      break;
    case 'load-solution':
      plan = cloneData(level.solution);
      flash = '已填入本关参考方案。';
      recompute();
      renderLevelChrome();
      break;
    case 'preset': {
      const preset = presets.find((p) => p.id === el.dataset.id);
      if (preset) loadPreset(preset);
      break;
    }
    case 'run-validation':
      report = runLocalValidation();
      tab = 'check';
      renderAll();
      break;
    case 'set-preserve-beat':
      plan.preserveThrough = Number(el.dataset.beat);
      plan.lockPreserved = true;
      recompute();
      break;
    case 'set-preserve':
      plan.preserveThrough = Math.floor(time);
      plan.lockPreserved = true;
      recompute();
      break;
    case 'toggle-lock':
      plan.lockPreserved = !plan.lockPreserved;
      recompute();
      break;
    case 'clear-preserve':
      plan.preserveThrough = null;
      plan.lockPreserved = false;
      recompute();
      break;
    case 'delete-action': {
      const id = el.dataset.id!;
      const action = plan.actions.find((a) => a.id === id);
      if (action && !isLocked(action)) {
        plan.actions = plan.actions.filter((a) => a.id !== id);
        recompute();
      }
      break;
    }
    case 'add-move':
      addBlock(el.dataset.actor!, 'move');
      break;
    case 'add-change':
      addBlock(el.dataset.actor!, 'change');
      break;
    case 'add-transfer':
      addBlock(el.dataset.actor!, 'transfer');
      break;
    default:
      break;
  }
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  if (target.id === 'speed') {
    speed = Number(target.value);
    return;
  }
  if (target.dataset.casting !== undefined) {
    plan.casting[target.dataset.casting] = target.value;
    recompute();
    return;
  }
  const actionId = target.dataset.editAction;
  const field = target.dataset.field;
  if (!actionId || !field) return;

  if (field === 'route-from' || field === 'route-to' || field === 'route-path') {
    handleRouteEdit(actionId, field, target.value);
    return;
  }

  let value: string | number = target.value;
  if (field === 'start' || field === 'duration') value = Number(target.value);
  if (field === 'transfer-type') {
    updateAction(actionId, { type: value as 'leave' | 'take' });
    return;
  }
  updateAction(actionId, { [field]: value });
});

scrub.addEventListener('input', () => {
  playing = false;
  time = Number(scrub.value);
  app.querySelector<HTMLElement>('#beat-readout')!.textContent = `第 ${time} / ${level.horizon} 拍`;
  renderInspector(true);
});

canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * STAGE_W;
  const y = ((event.clientY - rect.top) / rect.height) * STAGE_H;
  let clickedId: string | null = null;
  for (const [id, point] of renderedPositions) {
    if (Math.hypot(x - point.x, y - point.y) <= 27) {
      clickedId = id;
      break;
    }
  }
  if (!clickedId) clickedId = hitActor(level, sim, plan, time, x, y);
  if (clickedId) {
    selectedActorId = clickedId;
    renderInspector(true);
  }
});

// ---------------------------------------------------------------------------
// Canvas sizing / frame loop
// ---------------------------------------------------------------------------

function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
}
new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas();

let lastFrame = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing) {
    time += dt * speed;
    if (time >= level.horizon) {
      time = level.horizon;
      playing = false;
    }
    updateHud();
    renderInspector();
  }
  const xScale = canvas.width / STAGE_W;
  const yScale = canvas.height / STAGE_H;
  ctx.setTransform(xScale, 0, 0, yScale, 0, 0);
  renderedPositions = renderStage(ctx, level, sim, plan, time, selectedActorId);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

renderAll();
