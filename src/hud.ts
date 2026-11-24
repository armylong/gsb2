import type { DiscSnapshot } from './disc';
import type { GameEvent, SwitchRecord } from './types';

function fmtVec(v: { x: number; y: number; z: number }) {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

export class Hud {
  root: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private switchEl: HTMLDivElement;
  private eventsEl: HTMLDivElement;
  private verdictEl: HTMLDivElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = `
      position: fixed; top: 12px; left: 12px; width: 380px; max-height: calc(100vh - 24px);
      overflow-y: auto; padding: 12px 14px; border-radius: 12px;
      background: rgba(13, 20, 34, 0.86); border: 1px solid rgba(125, 211, 252, 0.25);
      font-size: 12px; line-height: 1.55; color: #cfe0f5; pointer-events: auto;
      backdrop-filter: blur(6px);
    `;
    document.body.appendChild(this.root);

    const title = document.createElement('div');
    title.textContent = '多吸力面板运动场 · 控制试验台';
    title.style.cssText = 'font-size:14px;font-weight:700;color:#7dd3fc;margin-bottom:8px;';
    this.root.appendChild(title);

    this.statusEl = document.createElement('div');
    this.root.appendChild(this.statusEl);

    const help = document.createElement('div');
    help.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.12);color:#93a7c4;';
    help.innerHTML = `
      <b style="color:#dbeafe">操作</b><br/>
      WASD 按当前镜头参照移动 · Space 主动脱离 · R 重置<br/>
      C 切换镜头（跟随/顶面/侧面）· P 暂停/继续<br/>
      T 跑内置路线（两个外角+缺面）· L 脱离落回测试 · G 边带抖动防抖测试
    `;
    this.root.appendChild(help);

    this.switchEl = document.createElement('div');
    this.switchEl.style.marginTop = '8px';
    this.root.appendChild(this.switchEl);

    this.eventsEl = document.createElement('div');
    this.eventsEl.style.marginTop = '8px';
    this.root.appendChild(this.eventsEl);

    this.verdictEl = document.createElement('div');
    this.verdictEl.style.marginTop = '8px';
    this.root.appendChild(this.verdictEl);
  }

  showVerdict(text: string, ok: boolean) {
    this.verdictEl.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = `padding:8px 10px;border-radius:8px;font-weight:700;
      background:${ok ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)'};
      border:1px solid ${ok ? '#22c55e' : '#ef4444'};color:${ok ? '#86efac' : '#fca5a5'}`;
    box.textContent = text;
    this.verdictEl.appendChild(box);
  }

  clearVerdict() {
    this.verdictEl.innerHTML = '';
  }

  render(snap: DiscSnapshot, paused: boolean, camLabel: string, lastSwitch: SwitchRecord | null, events: GameEvent[]) {
    const coords = snap.coords ? `u=${snap.coords.u.toFixed(2)} v=${snap.coords.v.toFixed(2)}` : '—';
    this.statusEl.innerHTML = `
      <div style="display:grid;grid-template-columns:96px 1fr;row-gap:2px">
        <span style="color:#8fa6c6">状态</span><b style="color:${snap.mode === 'attached' ? '#7dd3fc' : '#fca5a5'}">
          ${snap.mode === 'attached' ? '● 吸附中' : '○ 脱离飞行'}</span>
        <span style="color:#8fa6c6">接触面</span><span>${snap.panelLabel}</span>
        <span style="color:#8fa6c6">面内坐标</span><span>${coords}</span>
        <span style="color:#8fa6c6">法线 n</span><span>${fmtVec(snap.normal)}</span>
        <span style="color:#8fa6c6">朝向 h</span><span>${fmtVec(snap.heading)}</span>
        <span style="color:#8fa6c6">速度 v</span><span>${fmtVec(snap.velocity)} · |v|=${snap.speed.toFixed(2)}</span>
        <span style="color:#8fa6c6">接触点</span><span>${fmtVec(snap.contactPoint)}</span>
        <span style="color:#8fa6c6">换面武装</span><span>${snap.switchArmed ? '允许（已回内部区）' : '锁定（迟滞中）'}</span>
        <span style="color:#8fa6c6">边带候选</span><span>${snap.edgeCandidates.length ? snap.edgeCandidates.join('；') : '无'}</span>
        <span style="color:#8fa6c6">镜头</span><span>${camLabel} ${paused ? '· ⏸ 已暂停' : ''}</span>
      </div>
    `;

    if (lastSwitch) {
      const s = lastSwitch;
      this.switchEl.innerHTML = `
        <div style="padding:8px 10px;border-radius:8px;background:rgba(125,211,252,0.08);border:1px solid rgba(125,211,252,0.25)">
          <b style="color:#7dd3fc">最近一次换面（t=${s.time.toFixed(2)}s）</b><br/>
          ${s.edge}<br/>
          换前速度 ${fmtVec(s.velBefore)} |v|=${s.speedBefore.toFixed(3)}<br/>
          换后速度 ${fmtVec(s.velAfter)} |v|=${s.speedAfter.toFixed(3)}<br/>
          速率保持率 <b>${(s.retention * 100).toFixed(2)}%</b>
          （正交外角基重映射，沿边分量不变）<br/>
          位置 ${fmtVec(s.posBefore)} → ${fmtVec(s.posAfter)}
        </div>`;
    } else {
      this.switchEl.textContent = '';
    }

    const recent = events.slice(-8).reverse();
    this.eventsEl.innerHTML =
      '<div style="color:#8fa6c6;margin-bottom:2px">事件日志</div>' +
      recent
        .map((e) => {
          const color =
            e.kind === 'switch' ? '#7dd3fc' :
            e.kind === 'void-reset' || e.kind === 'fail' ? '#fca5a5' :
            e.kind === 'land' || e.kind === 'pass' ? '#86efac' :
            e.kind === 'block' ? '#fcd34d' : '#cfe0f5';
          return `<div style="color:${color}">[${e.time.toFixed(2)}] ${e.text}</div>`;
        })
        .join('');
  }
}
