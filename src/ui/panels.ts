import { evaluateChecks } from '../game/checks';
import { actions, selectBoard } from '../game/store';
import {
  STATION_IDS,
  buildObservationMap,
  claimValue,
} from '../game/engine';
import { DIR_NAMES } from '../game/layout';
import { OBSTACLE_MAP } from '../game/obstacles';
import { SCENARIOS, SCENARIO_ORDER, stationNames } from '../game/scenarios';
import { FRAME_LEN, SYMBOLS, SYMBOL_MAP } from '../game/symbols';
import type { Claim, GameState, Observation, StationId } from '../game/types';
import { glyphSvg, levelBadge } from './glyph';

const ROLE_NAME = ['开头', '数据', '数据', '数据', '数据', '复核', '结尾'];

// ---------------- 顶部走拍控制条 ----------------

export function renderTransport(s: GameState): string {
  const atEnd = s.cursor >= s.cues.length;
  return `
    <div class="transport-row">
      <button class="btn" data-action="restart" title="重新载入当前剧本">↺ 重置</button>
      <button class="btn" data-action="prev" ${s.cursor === 0 ? 'disabled' : ''}>← 上一拍</button>
      <button class="btn primary" data-action="toggle-play">
        ${s.playing ? '⏸ 暂停' : atEnd ? '↻ 重播' : '▶ 自动逐拍'}
      </button>
      <button class="btn primary" data-action="next" ${atEnd ? 'disabled' : ''}>下一拍 →</button>
      <span class="beat-count">第 <b>${s.cursor}</b> / ${s.cues.length} 拍</span>
    </div>
    <input class="scrub" type="range" min="0" max="${s.cues.length}" value="${s.cursor}"
      data-action="scrub" aria-label="拖动到任意拍" />
    <div class="transport-row between">
      <div class="policy-toggle" role="group" aria-label="判读策略">
        <button class="seg ${s.policy === 'lenient' ? 'on' : ''}" data-action="set-policy" data-policy="lenient"
          title="每面旗在任意半拍被看见即可，允许跨半拍拼合">宽松：半拍证据拼接</button>
        <button class="seg ${s.policy === 'strict' ? 'on' : ''}" data-action="set-policy" data-policy="strict"
          title="只在两面旗同时清楚的半拍识图，绝不跨半拍拼">严格：须同半拍双清</button>
      </div>
    </div>`;
}

// ---------------- 侧栏面板分发 ----------------

export function renderPanel(s: GameState): string {
  switch (s.tab) {
    case 'script':
      return scriptPanel(s);
    case 'receipts':
      return receiptsPanel(s);
    case 'decode':
      return decodePanel(s);
    case 'checks':
      return checksPanel(s);
    case 'rules':
      return rulesPanel();
  }
}

// ---------------- 剧本 / 编旗 ----------------

function scriptPanel(s: GameState): string {
  const cards = SCENARIO_ORDER.map((id) => {
    const d = SCENARIOS[id];
    const active = s.runId === id;
    return `
      <article class="scenario-card ${active ? 'active' : ''}">
        <div class="scenario-head">
          <h3>${d.name}</h3>
          <span class="duration">${d.duration}</span>
        </div>
        <p class="tagline">${d.tagline}</p>
        <p class="desc">${d.description}</p>
        <p class="question">🧪 ${d.question}</p>
        <ol class="guide">${d.guide.map((g) => `<li>${g}</li>`).join('')}</ol>
        <button class="btn ${active ? '' : 'primary'}" data-action="load-scenario" data-id="${id}">
          ${active ? '重新载入此剧本' : '载入此剧本'}
        </button>
      </article>`;
  }).join('');

  const stationTabs = STATION_IDS.map(
    (id) =>
      `<button class="chip-station ${s.editorStation === id ? 'on' : ''}"
        data-action="set-editor-station" data-id="${id}">${stationNames[id]}</button>`,
  ).join('');

  const seq = s.sequences[s.editorStation];
  const chips = seq
    .map((sid, i) => {
      const sym = SYMBOL_MAP[sid];
      const role = i < FRAME_LEN ? ROLE_NAME[i] : `第${i + 1}拍`;
      return `<span class="seq-chip" title="${role}">
        ${glyphSvg(sym.pair, 30)}
        <b>${sym.label}</b>
        <em>${role}</em>
        <button class="chip-x" data-action="remove-chip" data-index="${i}" aria-label="删除第 ${i + 1} 拍">×</button>
      </span>`;
    })
    .join('');

  const paletteGroup = (title: string, kind: string) => `
    <div class="palette-group">
      <span class="palette-title">${title}</span>
      <div class="palette-row">
        ${SYMBOLS.filter((x) => x.kind === kind)
          .map(
            (sym) => `
          <button class="palette-item" data-action="append-symbol" data-symbol="${sym.id}" title="${sym.hint}">
            ${glyphSvg(sym.pair, 34)}<b>${sym.label}</b>
          </button>`,
          )
          .join('')}
      </div>
    </div>`;

  return `
    <section class="panel-block">
      <h2>内置剧本</h2>
      ${cards}
    </section>
    <section class="panel-block">
      <h2>自编节拍序列</h2>
      <div class="station-row">${stationTabs}</div>
      <p class="hint">每台都能用两面旗的组合编一小段；格式为
        <b>启 + 4 数据 + 复核数 + 止</b>，复核数 = 四个数据编号之和 mod 10。</p>
      <div class="seq-track">${chips || '<span class="hint">还没有节拍，从下面符号盘点入</span>'}</div>
      <div class="seq-actions">
        <button class="btn danger-ghost" data-action="clear-seq">清空</button>
        <button class="btn primary" data-action="play-custom">▶ 播放${stationNames[s.editorStation]}序列</button>
      </div>
      ${paletteGroup('开头 / 结尾', 'start')}
      ${paletteGroup('数据符（编号 0–7）', 'data')}
      ${paletteGroup('复核数字', 'check')}
      <p class="hint">结尾符：</p>
      <div class="palette-row">
        ${SYMBOLS.filter((x) => x.kind === 'end')
          .map(
            (sym) => `
          <button class="palette-item" data-action="append-symbol" data-symbol="${sym.id}" title="${sym.hint}">
            ${glyphSvg(sym.pair, 34)}<b>${sym.label}</b>
          </button>`,
          )
          .join('')}
      </div>
    </section>`;
}

// ---------------- 观测收条 ----------------

function armEvidence(o: Observation): string {
  return o.arms
    .map((a) => {
      const color = a.arm === 0 ? '朱旗' : '青旗';
      const dot = a.arm === 0 ? 'red' : 'blue';
      const halves = ([0, 1] as const)
        .map((h) => {
          const v = a.halves[h];
          if (v.seen) {
            return `<span class="half-seen">${h === 0 ? '前' : '后'}:见 ${DIR_NAMES[v.recordedDir as number]}${
              v.misread ? '<i class="misread-tag">误判</i>' : ''
            }</span>`;
          }
          const obName = v.blockedBy ? OBSTACLE_MAP[v.blockedBy]?.name ?? v.blockedBy : '遮挡';
          return `<span class="half-blocked">${h === 0 ? '前' : '后'}:遮·${obName}</span>`;
        })
        .join('');
      return `<div class="arm-line"><i class="dot ${dot}"></i><b>${color}</b>${halves}</div>`;
    })
    .join('');
}

function receiptsPanel(s: GameState): string {
  const filterPills = ['all', ...STATION_IDS]
    .map((id) => {
      const label = id === 'all' ? '全部台' : stationNames[id as StationId];
      return `<button class="chip-station ${s.observerFilter === id ? 'on' : ''}"
        data-action="set-filter" data-id="${id}">${label}</button>`;
    })
    .join('');

  const cues = s.cues.slice(0, s.cursor);
  if (cues.length === 0) {
    return `<section class="panel-block"><h2>观测收条</h2>
      <div class="empty">还没有走拍。每走一拍，三座台里除发送台外的两座都会写下自己<b>实际看见</b>的旗位。</div></section>`;
  }

  const rows = cues
    .map((cue) => {
      const observers = STATION_IDS.filter(
        (o) => o !== cue.sender && (s.observerFilter === 'all' || s.observerFilter === o),
      );
      const obsRows = observers
        .map((o) => {
          const obs = storeStateObs(s, cue.id, o);
          if (!obs) return '';
          const lenient = obs.lenientValue
            ? `${glyphSvg(SYMBOL_MAP[obs.lenientValue].pair, 26)}<b>${SYMBOL_MAP[obs.lenientValue].label}</b>`
            : `<span class="muted">${obs.lenientIssue ?? '不可认'}</span>`;
          const strict = obs.strictValue
            ? `${glyphSvg(SYMBOL_MAP[obs.strictValue].pair, 26)}<b>${SYMBOL_MAP[obs.strictValue].label}</b>`
            : `<span class="muted">${obs.strictIssue ?? '不可认'}</span>`;
          return `
          <div class="receipt-row">
            <div class="receipt-head">
              <span class="receipt-who">${stationNames[o]}收条</span>
              ${levelBadge(obs.level)}
              <button class="btn tiny ghost" data-action="open-obs" data-cue="${cue.id}" data-observer="${o}">原收条</button>
            </div>
            <div class="arm-evidence">${armEvidence(obs)}</div>
            <div class="interpret-row">
              <span class="interp lenient" title="允许跨半拍拼合"><em>宽松</em>${lenient}</span>
              <span class="interp strict" title="须同半拍双清"><em>严格</em>${strict}</span>
            </div>
          </div>`;
        })
        .join('');
      return `
        <article class="cue-receipt">
          <header class="cue-receipt-head">
            <span class="step-no">第 ${cue.stepIndex + 1} 拍</span>
            <span>${stationNames[cue.sender]} 举 <b>${SYMBOL_MAP[cue.symbolId].label}</b></span>
            ${cue.tag ? `<span class="tag-pill">${cue.tag}</span>` : ''}
          </header>
          ${cue.note ? `<p class="cue-note">${cue.note}</p>` : ''}
          ${obsRows}
        </article>`;
    })
    .join('');

  return `<section class="panel-block">
    <h2>观测收条</h2>
    <div class="station-row">${filterPills}</div>
    <p class="hint">收条只记录该台视线实际所见，不记录「应该是什么」。
      紫色「分半拼见」= 没有任何半拍两面同清，但两半各见过一面。</p>
    ${rows}
  </section>`;
}

// 从当前状态重算 observation 映射（拍数很小，直接算）
function storeStateObs(s: GameState, cueId: string, observer: StationId): Observation | undefined {
  const map = buildObservationMap(s.cues, s.cursor);
  return map.get(`${cueId}::${observer}`);
}

// ---------------- 译码 / 冲突裁决 ----------------

function decodePanel(s: GameState): string {
  const board = selectBoard(s);
  if (board.messages.length === 0) {
    return `<section class="panel-block"><h2>译码 / 裁决</h2>
      <div class="empty">还没有任何台认出开头「启」。走完一个剧本，或播放你编的序列。<br/><br/>
      消息结构固定七拍：<b>启 · 数 · 数 · 数 · 数 · 核 · 止</b>。</div></section>`;
  }

  const cards = board.messages
    .map((m) => {
      const slots = m.slots
        .map((slot) => {
          const v = slot.resolvedValue;
          const sym = v ? SYMBOL_MAP[v] : null;
          const classes = ['frame-slot'];
          if (slot.conflict && !slot.chosenClaimId) classes.push('conflict');
          else if (slot.missing) classes.push('missing');
          else classes.push('ok');
          if (slot.chosenClaimId) classes.push('chosen');
          const clickable = slot.claims.length > 0;
          return `
            <button class="${classes.join(' ')}"
              ${clickable ? `data-action="open-conflict" data-msg="${m.msgId}" data-slot="${slot.slot}"` : 'disabled'}
              title="${clickable ? `${slot.claims.length} 条来源记录，点击查看 / 裁决` : '暂无来源记录'}">
              <span class="slot-role">${ROLE_NAME[slot.slot]}</span>
              ${glyphSvg(sym?.pair ?? null, 34)}
              <span class="slot-label">${sym?.label ?? '缺'}</span>
              ${slot.conflict ? '<i class="conflict-dot">⚡</i>' : ''}
              <span class="claim-count">${slot.claims.length} 源</span>
            </button>`;
        })
        .join('');

      const status = m.hasUnresolvedConflict
        ? `<span class="status bad">有来源冲突待人工裁决</span>`
        : !m.complete
          ? `<span class="status warn">缺第 ${m.missingSlots.map((x) => x + 1).join('、')} 拍，留待补发</span>`
          : m.checksumOk
            ? `<span class="status good">复核通过：${m.text}</span>`
            : `<span class="status bad">复核不符：${m.text}</span>`;

      const resendButtons = m.missingSlots
        .map((slot) => {
          const hasOrigin =
            m.txId !== null &&
            m.startBeat !== null &&
            s.cues.some(
              (c) => c.txId === m.txId && c.beatIndex === (m.startBeat as number) + slot,
            );
          if (!hasOrigin) {
            return `<span class="hint gap-wait">第 ${slot + 1} 拍尚未发送，无原拍可补发</span>`;
          }
          return `<button class="btn tiny" data-action="resend" data-msg="${m.msgId}" data-slot="${slot}">
              请求补发第 ${slot + 1} 拍</button>`;
        })
        .join('');

      const forwardButtons = STATION_IDS.map((id) => {
        const isSender = m.sender === id;
        return `<button class="btn tiny ${isSender ? 'ghost' : ''}"
          data-action="forward" data-msg="${m.msgId}" data-station="${id}"
          title="${isSender ? '这是原发台，转发应来自另外一处' : `由${stationNames[id]}转发全文`}">
          ${isSender ? `${stationNames[id]}（原发）` : `由${stationNames[id]}转发`}
        </button>`;
      }).join('');

      return `
        <article class="decode-card">
          <header class="decode-head">
            <h3>消息帧 · ${m.txId ?? '外部来源'}${m.startBeat !== null ? ` · 第 ${m.startBeat + 1} 拍起` : ''}</h3>
            ${m.sender ? `<span class="hint">原发：${stationNames[m.sender]}</span>` : ''}
          </header>
          <div class="slots-row">${slots}</div>
          <div class="decode-status">${status}</div>
          <div class="decode-actions">
            <button class="btn primary" data-action="sign" data-msg="${m.msgId}">复核 / 签收</button>
            ${resendButtons}
          </div>
          <div class="forward-row">
            <span class="hint">异台转发：</span>${forwardButtons}
          </div>
        </article>`;
    })
    .join('');

  const records = s.scoreRecords
    .map(
      (r) => `
      <li class="score-row ${r.duplicate ? 'dup' : 'earn'}">
        <span class="delta">${r.delta > 0 ? `+${r.delta}` : '+0'}</span>
        <span class="score-text">${r.text}
          <em>${r.duplicate ? '重复收到，不重复得分' : r.sourceLabel}</em></span>
      </li>`,
    )
    .join('');
  const attempts = s.attempts
    .map(
      (a) =>
        `<li class="attempt ${a.ok ? 'ok' : 'bad'}">${a.ok ? '✓' : '✕'} ${a.reason}${a.text ? ` —— ${a.text}` : ''}</li>`,
    )
    .join('');

  return `<section class="panel-block">
    <h2>译码 / 裁决</h2>
    <div class="score-board">
      <div class="score-num">${s.score}</div>
      <div class="score-meta">
        <div>已签收 ${s.signedKeys.length} 条不同消息</div>
        <div class="hint">同一内容转发 / 重复签收不再加分</div>
      </div>
    </div>
    ${cards}
    ${
      attempts
        ? `<div class="attempts"><h3>复核记录</h3><ul>${attempts}</ul></div>`
        : ''
    }
    ${
      records
        ? `<div class="scores"><h3>得分流水</h3><ul>${records}</ul></div>`
        : ''
    }
  </section>`;
}

// ---------------- 验收清单 ----------------

function checksPanel(s: GameState): string {
  const items = evaluateChecks(s);
  const pass = items.filter((i) => i.status === 'pass').length;
  const icon = { pass: '✅', fail: '❌', pending: '⏳' };
  return `<section class="panel-block">
    <h2>剧本验收清单</h2>
    <p class="hint">${pass}/${items.length} 项通过；清单随逐拍推进、人工裁决与签收实时更新。</p>
    <ul class="check-list">
      ${items
        .map(
          (i) => `
        <li class="check-item ${i.status}">
          <span class="check-icon">${icon[i.status]}</span>
          <div><div class="check-label">${i.label}</div>
          ${i.detail ? `<div class="check-detail">${i.detail}</div>` : ''}</div>
        </li>`,
        )
        .join('')}
    </ul>
  </section>`;
}

// ---------------- 规则页 ----------------

export function rulesPanel(): string {
  return `<section class="panel-block rules-doc">
    <h2>游戏规则（简版）</h2>
    ${rulesBodyHtml()}
  </section>`;
}

export function rulesPageHtml(): string {
  return `
    <div class="rules-page-inner">
      <h2>规则全文与设计结论</h2>
      ${rulesBodyHtml()}
    </div>`;
}

function rulesBodyHtml(): string {
  const tableRows = SYMBOLS.map(
    (sym) => `
    <div class="rule-symbol" title="${sym.hint}">
      ${glyphSvg(sym.pair, 40)}
      <b>${sym.label}</b>
      <span>${[...sym.pair].map((d) => DIR_NAMES[d]).join(' + ')}</span>
    </div>`,
  ).join('');
  return `
    <div class="rule-card">
      <h3>① 三座观测台，两面旗拼一个符号</h3>
      <p>北岭、西坡、东崖三台各有一名旗手。每拍两面旗各停在八个旗位之一，无序组合查表得到符号。发送台自己不记收条，另外两台只按自己的视线记录。</p>
      <div class="rule-symbols">${tableRows}</div>
    </div>
    <div class="rule-card">
      <h3>② 收条只写「实际看见的旗位」</h3>
      <ul>
        <li><b class="lv-both">双清</b>：存在某一半拍，两面旗同时清楚。</li>
        <li><b class="lv-stitch">分半拼见</b>：没有任何半拍两面同清，但前、后半拍各见过一面（遮半拍的临界情形）。</li>
        <li><b class="lv-one">单旗</b>：整拍只确认了一面旗的旗位。</li>
        <li><b class="lv-none">全遮</b>：两面旗全程没看见，该拍只有空缺。</li>
      </ul>
      <p>策略开关直接回答标题里的实验题：</p>
      <ul>
        <li><b>宽松规则</b>：旗势在一拍内保持不动，任意半拍看清的旗位都可采信，因此允许跨半拍拼合——后半拍双清当然该认；两半各见一旗也拼认。</li>
        <li><b>严格规则</b>：只在两面同清的半拍识图；「分半拼见」一律留缺，避免把云的移动误当成旗位变化。</li>
      </ul>
      <p class="question">结论不是一刀切：遮挡半拍不等于毁掉整拍证据；是否允许跨半拍拼认，是这套规则留给玩家的严格度选择，复核码会兜底。</p>
    </div>
    <div class="rule-card">
      <h3>③ 开头、结尾、复核，与「不许挪用下一条」</h3>
      <p>固定七拍：<code>启 · 数① · 数② · 数③ · 数④ · 核 · 止</code>。
      复核规则：<code>核 =（四个数据符编号之和）mod 10</code>。</p>
      <p>译码只认真正判为「启」的拍作为帧锚点，窗口长度固定七拍：中间没看见的槽位保持空缺、等待申报槽号的补发；
      后面到达的下一条「启」会另开一帧，<b>绝不允许拿来填前一条的数据槽</b>——角色校验也会直接拒绝「启」进入数据槽。</p>
    </div>
    <div class="rule-card">
      <h3>④ 异台转发、重复计分与冲突人工裁决</h3>
      <p>完整且复核通过的消息可由另外一座台全文转发。同一内容无论收到几次，只在第一次复核签收时 +100，之后都是 +0 的重复记录。</p>
      <p>两个来源在同一槽位给出不同符号时，系统不自动猜：点开冲突槽可查看每份原收条的逐半拍证据与剧本批注，人工选择采信哪一份；选错会被复核码拦下，可随时改选。</p>
    </div>
    <div class="rule-card">
      <h3>⑤ 怎么验收</h3>
      <p>三个内置剧本都可以逐拍 / 自动逐拍推进；「验收清单」页逐项核对每拍能见度分级、「不挪用下一条开头」不变量、冲突、重复计分以及最终是否解出同一条
      <code>${'启 风 山 月 关 6 止'}</code>。所有规则纯函数都有 vitest 用例锁定。</p>
    </div>`;
}

// ---------------- 模态框 ----------------

export function renderModal(s: GameState): string {
  if (!s.modal) return '';
  if (s.modal.type === 'observation') {
    const { cueId, observer } = s.modal;
    const obs = buildObservationMap(s.cues, s.cursor).get(`${cueId}::${observer}`);
    if (!obs) return modalShell('原收条', '<div class="empty">记录不存在（可能已回退拍点）</div>');
    const misreadNotes = s.cues
      .find((c) => c.id === cueId)
      ?.misreads?.filter((m) => m.observer === observer);
    const body = `
      <div class="obs-modal">
        <p><b>${stationNames[obs.observer]}</b> 观察 <b>${stationNames[obs.sender]}</b> 的第 ${obs.stepIndex + 1} 拍</p>
        <p>${levelBadge(obs.level)} <span class="hint">同清半拍：${obs.simultaneousHalf === null ? '无' : `第 ${obs.simultaneousHalf === 0 ? '前' : '后'}半拍`}</span></p>
        <div class="arm-evidence big">${armEvidence(obs)}</div>
        <table class="interp-table">
          <tr><th>宽松拼接</th><td>${obs.lenientValue ? glyphSvg(SYMBOL_MAP[obs.lenientValue].pair, 30) + SYMBOL_MAP[obs.lenientValue].label : obs.lenientIssue ?? '—'}</td></tr>
          <tr><th>严格同清</th><td>${obs.strictValue ? glyphSvg(SYMBOL_MAP[obs.strictValue].pair, 30) + SYMBOL_MAP[obs.strictValue].label : obs.strictIssue ?? '—'}</td></tr>
        </table>
        ${
          misreadNotes?.length
            ? `<p class="misread-note">剧本批注：${misreadNotes.map((m) => m.note).join('；')}</p>`
            : ''
        }
        <div class="modal-actions"><button class="btn primary" data-action="close-modal">看完了</button></div>
      </div>`;
    return modalShell('原始收条（不可改写）', body);
  }

  // conflict modal
  const { msgId, slot } = s.modal as { type: 'conflict'; msgId: string; slot: number };
  const board = selectBoard(s);
  const msg = board.messages.find((m) => m.msgId === msgId);
  const bslot = msg?.slots[slot];
  if (!bslot) return modalShell('来源裁决', '<div class="empty">槽位不存在</div>');

  const claimHtml = (c: Claim) => {
    const v = claimValue(c, s.policy);
    const sym = v ? SYMBOL_MAP[v] : null;
    const selected = bslot.chosenClaimId === c.id;
    const obs = c.raw;
    const notes = c.cueId
      ? s.cues
          .find((x) => x.id === c.cueId)
          ?.misreads?.filter((m) => m.observer === c.observer)
      : undefined;
    return `
      <div class="claim-option ${selected ? 'selected' : ''} ${c.roleValid ? '' : 'invalid'}">
        <div class="claim-main">
          <span class="claim-source">${c.sourceLabel}</span>
          <span class="claim-prov">${c.provenance}</span>
          ${c.kind === 'forward' ? '<span class="tag-pill fwd">转发件</span>' : ''}
        </div>
        <div class="claim-value">
          ${glyphSvg(sym?.pair ?? null, 40)}
          <b>${sym?.label ?? '空 / 不可认'}</b>
          ${!c.roleValid ? '<em class="role-bad">角色不符，不能补此槽</em>' : ''}
        </div>
        ${obs ? `<div class="claim-raw">${levelBadge(obs.level)} ${armEvidence(obs)}</div>` : ''}
        ${notes?.length ? `<p class="misread-note inline">主持批注：${notes.map((n) => n.note).join('；')}</p>` : ''}
        <div class="claim-actions">
          <button class="btn tiny ${selected ? 'primary' : ''}"
            data-action="choose-claim" data-msg="${msgId}" data-slot="${slot}" data-claim="${c.id}"
            ${!c.roleValid ? 'disabled' : ''}>
            ${selected ? '✓ 已采信' : '采信此来源'}
          </button>
          ${
            c.cueId && c.observer
              ? `<button class="btn tiny ghost" data-action="inspect-claim"
                  data-cue="${c.cueId}" data-observer="${c.observer}">跳到该拍 / 原收条</button>`
              : ''
          }
        </div>
      </div>`;
  };

  const body = `
    <p class="hint">当前策略：<b>${s.policy === 'lenient' ? '宽松拼接' : '严格双清'}</b>。
      第 ${slot + 1} 槽角色为「${ROLE_NAME[slot]}」。请比对原始收条后人工选择；选择会被复核码检验。</p>
    <div class="claim-list">${bslot.claims.map(claimHtml).join('') || '<div class="empty">没有来源</div>'}</div>
    <div class="modal-actions">
      <button class="btn ghost" data-action="choose-auto" data-msg="${msgId}" data-slot="${slot}">恢复自动（仅一致时采信）</button>
      <button class="btn primary" data-action="close-modal">完成</button>
    </div>`;
  const title = bslot.conflict
    ? '来源冲突 · 查看原收条并人工裁决'
    : '槽位来源 · 原收条比对';
  return modalShell(title, body);
}

function modalShell(title: string, body: string): string {
  return `
    <div class="modal-backdrop" data-backdrop="1" data-action="backdrop-close">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
        <header class="modal-head">
          <h3>${title}</h3>
          <button class="modal-x" data-action="close-modal" aria-label="关闭">×</button>
        </header>
        ${body}
      </div>
    </div>`;
}

export function renderToast(s: GameState): string {
  if (!s.toast) return '';
  return `<div class="toast ${s.toast.tone}" key="${s.toast.id}">${s.toast.text}</div>`;
}

// 让事件处理模块可以直接用 actions，避免循环引用问题
export { actions };
