import { idx, roomAt } from '../core/grid';
import type { FailureReason } from '../core/types';
import { LOCK_COLORS, Tile, colorName } from '../core/types';
import { describeCell, eventToCell, render, type RenderState } from './renderer';
import { AppState, type Tool } from './store';

const REASON_LABEL: Record<FailureReason, string> = {
  terrain: '地形断开',
  missing_key: '缺少钥匙',
  self_lock: '钥匙自锁',
  circular: '锁钥依赖环',
};

const state = new AppState();
const canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const toastEl = document.getElementById('toast')!;
const hoverTip = document.getElementById('hoverTip')!;
let toastTimer: number | null = null;

function toast(message: string, danger = false): void {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden', 'danger');
  if (danger) toastEl.classList.add('danger');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), 3600);
}

// ---------- 渲染 ----------

function draw(): void {
  const st: RenderState = {
    map: state.map,
    analysis: state.analysis,
    player: state.player
      ? {
          x: state.player.x,
          y: state.player.y,
          heldColors: state.player.heldColors,
          openedDoorIds: state.player.openedDoorIds,
          pickedKeyIds: state.player.pickedKeyIds,
        }
      : null,
    routeCursor: state.routeCursor,
    route: state.route,
    stale: false,
    hoverCell: hoverCell,
    selectedKeyId: state.selectedKeyId,
  };
  render(ctx, st);
  renderStatus();
  renderEditLog();
  renderPlayerState();
  renderEvents();
}

let hoverCell: { x: number; y: number } | null = null;

// ---------- 检查结果面板 ----------

function renderStatus(): void {
  const body = document.getElementById('statusBody')!;
  const a = state.analysis;
  const parts: string[] = [];
  parts.push(
    a.exitReachable
      ? '<span class="badge ok">可解:出口可达</span>'
      : `<span class="badge bad">不可达:${a.failure ? REASON_LABEL[a.failure.reason] : '未知'}</span>`,
  );
  parts.push(
    `<div class="kv">
      <span class="k">种子/参数</span><span>${state.params.seed} · ${state.params.roomCount} 房间 · ${state.params.colorCount} 色锁${state.scenarioId ? ' · 内置现场' : ''}</span>
      <span class="k">实际可达房间</span><span>${a.reachableRooms.map((r) => `R${r}`).join('、') || '无'}</span>
      <span class="k">忽略锁可达</span><span>${a.terrainReachable.size} 格</span>
      <span class="k">实际可达</span><span>${a.reachable.size} 格</span>
    </div>`,
  );

  if (a.disconnectedRooms.length > 0) {
    parts.push(
      `<p style="color:#ff9b9e;margin:6px 0">地形断开区域(忽略锁也到不了):
        <ul class="room-list">${[...a.disconnectedComponents.values()]
          .map((rooms) => `<li>断开分量:${rooms.map((r) => `R${r}`).join('、')}</li>`)
          .join('')}</ul>
      </p>`,
    );
  }

  parts.push(
    `<table class="key-table"><thead><tr><th>钥匙</th><th>所在房间</th><th>地形可达</th><th>实际可取得</th></tr></thead><tbody>
      ${
        a.keyInfos.length === 0
          ? '<tr><td colspan="4" style="color:var(--muted)">本地图无钥匙</td></tr>'
          : a.keyInfos
              .map((k) => {
                const c = LOCK_COLORS[k.color];
                return `<tr>
                  <td><span class="dot" style="background:${c.fill}"></span> ${colorName(k.color)}</td>
                  <td>${k.roomId !== null ? `R${k.roomId}` : '通道'}</td>
                  <td>${k.terrainReachable ? '✅' : '❌'}</td>
                  <td>${k.obtainable ? '✅' : '❌'}</td>
                </tr>`;
              })
              .join('')
      }
    </tbody></table>`,
  );

  if (a.failure) {
    const f = a.failure;
    parts.push(
      `<div style="margin-top:8px;padding:8px;border:1px solid var(--danger);border-radius:8px;background:rgba(229,72,77,0.08)">
        <strong>诊断:${REASON_LABEL[f.reason]}</strong>
        <p style="margin:6px 0">${f.message}</p>
        ${
          f.blockers.length > 0
            ? `<ul class="blocker-list">${f.blockers
                .map((b) => {
                  const c = LOCK_COLORS[b.color];
                  return `<li><span class="dot" style="background:${c?.fill ?? '#888'}"></span>
                    门 #${b.doorId}(${colorName(b.color)}色)位于 (${b.x},${b.y}),连接 R${b.rooms[0]} ↔ R${b.rooms[1]}</li>`;
                })
                .join('')}</ul>`
            : ''
        }
        ${f.roomIds.length > 0 ? `<p style="margin:4px 0;color:var(--muted)">相关房间:${f.roomIds.map((r) => `R${r}`).join('、')}</p>` : ''}
      </div>`,
    );
  }

  if (a.route) {
    parts.push(
      `<p style="margin:8px 0 0;color:#9cc1ff">实际路线:${a.route.length} 步,事件 ${a.route.events.length} 条(先拾取/开门次序见下方路线核查)。</p>`,
    );
  }
  body.innerHTML = parts.join('');
}

function renderEditLog(): void {
  const ul = document.getElementById('editLog')!;
  ul.innerHTML =
    state.edits.length === 0
      ? '<li style="list-style:none">暂无人工修改</li>'
      : state.edits
          .map((e) => `<li>[${e.at}] ${e.note}</li>`)
          .reverse()
          .join('');
  const undoBtn = document.getElementById('undoEditBtn') as HTMLButtonElement;
  undoBtn.disabled = !state.canUndo;
}

function renderPlayerState(): void {
  const el = document.getElementById('playerState')!;
  const p = state.player;
  if (!p) {
    el.innerHTML = '标记未放置(点击“重置标记”回到起点状态)。';
    return;
  }
  const chips =
    p.heldColors.size === 0
      ? '<span style="color:var(--muted)">无</span>'
      : [...p.heldColors]
          .map((c) => `<span class="chip" style="background:${LOCK_COLORS[c].fill}">${colorName(c)}钥匙</span>`)
          .join('');
  el.innerHTML = `位置 (${p.x},${p.y}) · 步数 ${p.stepCount} · 已开门 ${p.openedDoorIds.size} 扇 · 持有 <span class="chips">${chips}</span>${
    p.atExit ? ' · <strong style="color:#7fe0a3">已在出口</strong>' : ''
  }`;
}

function renderEvents(): void {
  const el = document.getElementById('routeEvents')!;
  const events = state.visibleEvents();
  if (events.length === 0) {
    el.innerHTML = '<div class="ev" style="color:var(--muted)">路线事件会显示在这里。</div>';
    return;
  }
  el.innerHTML = events
    .map((e) => `<div class="ev ${e.kind} ${e.current ? 'current' : ''}">${e.current ? '▶ ' : ''}${e.text}</div>`)
    .join('');
  el.scrollTop = el.scrollHeight;
}

// ---------- 顶部控件 ----------

document.getElementById('generateBtn')!.addEventListener('click', () => {
  const seed = (document.getElementById('seedInput') as HTMLInputElement).value.trim() || `seed-${Date.now()}`;
  const roomCount = Number((document.getElementById('roomCountInput') as HTMLInputElement).value);
  const colorCount = Number((document.getElementById('colorCountInput') as HTMLSelectElement).value);
  const res = state.regenerate({ seed, roomCount, colorCount });
  if (!res.ok) toast(res.error!, true);
  else toast(`已生成:种子 ${seed},${roomCount} 个房间,${colorCount} 种锁色`);
});

document.querySelectorAll<HTMLButtonElement>('button.scene').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.loadScenario(btn.dataset.scene!);
    toast(`已载入${btn.textContent}`);
  });
});

// ---------- 工具切换 ----------

document.querySelectorAll<HTMLButtonElement>('button.tool').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.tool = btn.dataset.tool as Tool;
    state.selectedKeyId = null;
    document.querySelectorAll('button.tool').forEach((b) => b.classList.toggle('active', b === btn));
    state.emit();
  });
});

// ---------- Canvas 交互 ----------

canvas.addEventListener('mousemove', (e) => {
  const cell = eventToCell(e, canvas);
  hoverCell = cell;
  hoverTip.classList.remove('hidden');
  hoverTip.innerHTML = describeCell(state.map, state.analysis, cell.x, cell.y);
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.width;
  hoverTip.style.left = `${(cell.x + 1) * 15 * scale}px`;
  hoverTip.style.top = `${(cell.y + 1) * 15 * scale}px`;
  draw();
});
canvas.addEventListener('mouseleave', () => {
  hoverCell = null;
  hoverTip.classList.add('hidden');
  draw();
});

canvas.addEventListener('click', (e) => {
  const { x, y } = eventToCell(e, canvas);
  const map = state.map;
  switch (state.tool) {
    case 'inspect':
      return;
    case 'moveKey': {
      const key = map.keys.find((k) => k.x === x && k.y === y);
      if (state.selectedKeyId === null) {
        if (!key) return toast('请先点击一把要移动的钥匙', true);
        state.selectedKeyId = key.id;
        toast(`已选择${colorName(key.color)}色钥匙 #${key.id},再点击目标房间`);
        state.emit();
        return;
      }
      const targetRoom = roomAt(map, x, y);
      if (targetRoom === -1) return toast('目标必须是房间内的格子', true);
      const res = state.doEdit(
        { type: 'moveKey', keyId: state.selectedKeyId, targetRoomId: targetRoom },
        `移动钥匙 #${state.selectedKeyId} → R${targetRoom}`,
      );
      toast(res.ok ? '钥匙已移动,检查结果已重新计算(旧路线已失效)' : res.error!, !res.ok);
      return;
    }
    case 'door': {
      const door = map.doors.find((d) => d.x === x && d.y === y);
      if (!door) return toast('请点击一扇门', true);
      // 红(0)→蓝(1)→绿(2)→无锁(null)→红
      const nextColor = door.color === null ? 0 : door.color === 2 ? null : door.color + 1;
      const res = state.doEdit(
        { type: 'setDoorColor', doorId: door.id, color: nextColor },
        `门 #${door.id} 改为${nextColor === null ? '无锁' : `${colorName(nextColor)}色锁`}`,
      );
      toast(res.ok ? '门锁已修改,检查结果已重新计算(旧路线已失效)' : res.error!, !res.ok);
      return;
    }
    case 'corridor': {
      if (map.tiles[idx(x, y, map.width)] !== Tile.Corridor) {
        return toast('请点击通道(灰色)格子', true);
      }
      const corr = map.corridors.find((c) => !c.removed && c.cells.some((p) => p.x === x && p.y === y));
      if (!corr) return toast('该通道已经被移除', true);
      const res = state.doEdit(
        { type: 'removeCorridor', corridorId: corr.id },
        `移除通道 #${corr.id}(R${corr.roomA}↔R${corr.roomB})`,
      );
      toast(res.ok ? '通道已移除,检查结果已重新计算(旧路线已失效)' : res.error!, !res.ok);
      return;
    }
  }
});

// ---------- 路线播放与手动控制 ----------

document.getElementById('routePlayBtn')!.addEventListener('click', () => {
  if (!state.route) return toast('当前布局没有可行路线,无法播放', true);
  if (state.isPlaying) {
    state.stopPlayback();
    draw();
    return;
  }
  state.startPlayback();
  toast('正在逐步走路线:拾取与开门事件见下方列表');
});
document.getElementById('routeStepBtn')!.addEventListener('click', () => {
  if (!state.route) return toast('当前布局没有可行路线', true);
  state.stopPlayback();
  try {
    state.playRouteStep();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
});
document.getElementById('routeResetBtn')!.addEventListener('click', () => {
  state.resetMarkers();
  state.emit();
});

function manual(dx: number, dy: number): void {
  const res = state.manualMove(dx, dy);
  if (!res.ok) toast(res.message, true);
  else if (res.message) toast(res.message);
}

document.querySelectorAll<HTMLButtonElement>('.dpad button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const dir = btn.dataset.dir!;
    if (dir === 'up') manual(0, -1);
    if (dir === 'down') manual(0, 1);
    if (dir === 'left') manual(-1, 0);
    if (dir === 'right') manual(1, 0);
  });
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return;
  const keyMap: Record<string, [number, number]> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    w: [0, -1],
    s: [0, 1],
    a: [-1, 0],
    d: [1, 0],
  };
  const mv = keyMap[e.key];
  if (mv) {
    e.preventDefault();
    manual(mv[0], mv[1]);
  }
});

// ---------- 保存 / 恢复 ----------

document.getElementById('saveBtn')!.addEventListener('click', () => {
  state.exportFile();
  state.saveToStorage();
  toast('已保存到浏览器并导出 JSON 文件(含种子、布局与全部人工修改)');
});
document.getElementById('loadBtn')!.addEventListener('click', () => {
  if (state.hasStorageSave()) {
    const res = state.loadFromStorage();
    if (res.ok) {
      toast('已从浏览器存档恢复(如需从 JSON 文件恢复,点旁边的文件选择)');
      return;
    }
    toast(res.error!, true);
  } else {
    toast('浏览器中没有存档,请选择 JSON 存档文件');
  }
  document.getElementById('loadFile')!.click();
});
document.getElementById('loadFile')!.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (): void => {
    const res = state.loadFromText(String(reader.result));
    toast(res.ok ? '已从文件恢复存档并重新检查' : res.error!, !res.ok);
  };
  reader.readAsText(file);
  input.value = '';
});

document.getElementById('undoEditBtn')!.addEventListener('click', () => {
  state.undo();
  toast('已撤销上次修改并重新检查');
});

// ---------- 图例 ----------

document.getElementById('legend')!.innerHTML = [
  ['#2b3140', '房间地板'],
  ['#3a4254', '通道'],
  ['rgba(53,167,92,0.5)', '实际可达'],
  ['rgba(229,161,60,0.6)', '锁挡住(地形通)'],
  ['rgba(229,72,77,0.6)', '地形断开'],
  ...LOCK_COLORS.map((c) => [c.fill, `${c.name}色锁/钥匙`] as [string, string]),
]
  .map(([color, label]) => `<span class="item"><span class="swatch" style="background:${color}"></span>${label}</span>`)
  .join('');

state.onChange(draw);
draw();
