import type { IORSet, Reading, TraceResult } from '../physics/tracer';
import { mediumLabel, shiftText } from '../physics/tracer';

const STATUS_TEXT: Record<TraceResult['status'], { text: string; cls: string }> = {
  'ruler-back': { text: '✓ 到达后标尺，取得刻度读数', cls: 'ruler' },
  'ruler-front': { text: '✓ 到达前标尺（视线未经过水槽，直接读数）', cls: 'ruler' },
  'blocked-frame': { text: '■ 被不透明槽框挡住（玻璃边缘之外的正常遮挡）', cls: 'blocked' },
  'blocked-block': { text: '■ 击中水中不透明方块，路径终止', cls: 'blocked' },
  'out-of-range': { text: '✕ 折射超出槽体可用范围：该画面位置没有标尺读数', cls: 'oor' },
};

function readingRow(label: string, r: Reading | undefined, cls = ''): string {
  if (!r) return `<div class="k">${label}</div><div class="v">无读数</div>`;
  return `<div class="k">${label}</div><div class="v ${cls}">x=${r.x.toFixed(1)}，y=${r.y.toFixed(1)} cm</div>`;
}

function explain(result: TraceResult, iors: IORSet): string {
  const refr = result.events.filter((e) => e.kind === 'refract');
  const tir = result.events.find((e) => e.kind === 'tir');
  const lines: string[] = [];

  if (refr.length > 0) {
    lines.push(`<div>视线依次穿过 <b>${refr.length}</b> 个介质边界（见下表）。每次穿过界面都按斯涅尔定律 ` +
      `n₁·sinθ₁ = n₂·sinθ₂ 改变方向，因此<b>斜着看时，视线在水中的落点与直线预期不一致</b>，刻度读数随之偏移。</div>`);
    const denser = refr.filter((e) => (e.n2 ?? 1) > (e.n1 ?? 1));
    const sparser = refr.filter((e) => (e.n2 ?? 1) < (e.n1 ?? 1));
    if (denser.length) lines.push(`<div>进入光密介质（如空气→玻璃/水）时折射角<b>变小</b>，光线向法线靠拢；` +
      `回到光疏介质时角度恢复。</div>`);
    if (sparser.length) lines.push(`<div>进入光疏介质（玻璃/水→空气）时折射角变大，` +
      `当前 n 配置下临界角 = arcsin(n₂/n₁)，角度再大就全反射。</div>`);
  }

  if (tir) {
    lines.push(
      `<div class="tir-text"><b>全反射：</b>在「${tir.surface}」处入射角 ${tir.thetaI?.toFixed(1)}° ≥ 临界角 ` +
      `${tir.critical?.toFixed(1)}°（${mediumLabel(tir.medium1!)} n=${tir.n1?.toFixed(3)} → ` +
      `${mediumLabel(tir.medium2!)} n=${tir.n2?.toFixed(3)}）。光线被完全反射回${mediumLabel(tir.medium1!)}，` +
      `不能穿过该界面，所以该方向<b>看不到界面另一侧的刻度</b>。侧扫时相机小幅转动跨过临界角，就能看到折射路径与全反射路径的切换。</div>`,
    );
  }

  if (result.status === 'out-of-range') {
    lines.push(`<div class="warn-text">红色虚线端表示折射后的路径已超出玻璃/槽体的可用范围，` +
      `物理上这束光不会落在任何刻度上——画面中以红叉明确标出，而不是给出一个虚假读数。</div>`);
  }
  if (result.status === 'blocked-frame') {
    lines.push(`<div>槽框是不透明物体，按普通深度遮挡处理：玻璃边缘之外的视线不会被“折射”进槽内，` +
      `而是被框条截断，这与真实水槽的遮挡一致。</div>`);
  }

  if (result.reading && result.baseline?.reading) {
    const shift = shiftText(result.reading, result.baseline.reading);
    const dx = result.reading.x - result.baseline.reading.x;
    const dy = result.reading.y - result.baseline.reading.y;
    lines.push(
      `<div><b>同一套刻度核对：</b>实际折射路径读数与 n=1 直线基线的偏差为 ${shift}。` +
      `白色虚线是“如果所有介质折射率都等于 1”时视线应走的直线，两条线在标尺上的差距就是折射造成的表观位置变化 ` +
      `（${Math.abs(dx) >= 0.05 ? '水平' : ''}${Math.abs(dx) >= 0.05 && Math.abs(dy) >= 0.05 ? '、' : ''}` +
      `${Math.abs(dy) >= 0.05 ? '竖直' : ''}方向）。</div>`,
    );
  }
  if (result.apparentPoint && result.reading) {
    lines.push(
      `<div>青色点线是视线进入介质前的<b>原始方向延长线</b>：眼睛沿直线“以为”目标在该方向上，` +
      `而实际光线经多次偏折后落在另一刻度，这就是方块/刻度看起来“歪了”的原因。</div>`,
    );
  }
  if (iors.glass === iors.water && iors.glass !== 1) {
    lines.push(`<div>当前 n<sub>玻璃</sub> = n<sub>水</sub> = ${iors.glass.toFixed(3)}：玻璃与水的界面上 ` +
      `θ₁=θ₂、光线不偏折，事件表中这几行的入射角与折射角相等，可与不等折射率结果逐项核对。</div>`);
  }
  return lines.join('');
}

export function renderResult(panel: HTMLElement, result: TraceResult, iors: IORSet): void {
  const st = STATUS_TEXT[result.status];
  const hasTir = result.events.some((e) => e.kind === 'tir');

  const rows: string[] = [];
  rows.push(`<div class="status ${st.cls}">${st.text}${hasTir ? '<br/>（路径中包含全反射段，见紫色标记）' : ''}</div>`);

  // 读数区
  rows.push('<h3>刻度读数（同一套标尺）</h3><div class="kv">');
  rows.push(readingRow('实际折射路径', result.reading));
  rows.push(readingRow('n=1 直线基线', result.baseline?.reading, 'shift-pos'));
  if (result.reading && result.baseline?.reading) {
    const dx = result.reading.x - result.baseline.reading.x;
    const dy = result.reading.y - result.baseline.reading.y;
    const cls = dx > 0 || dy > 0 ? 'shift-pos' : 'shift-neg';
    rows.push(`<div class="k">折射位移</div><div class="v ${cls}">${shiftText(result.reading, result.baseline.reading)}</div>`);
  }
  if (result.blockName) rows.push(`<div class="k">命中方块</div><div class="v">${result.blockName}</div>`);
  if (result.blockerName && result.status === 'blocked-frame')
    rows.push(`<div class="k">遮挡物</div><div class="v">${result.blockerName}</div>`);
  rows.push('</div>');

  // 事件表
  if (result.events.length) {
    rows.push('<h3>介质边界与路径事件</h3>');
    rows.push('<table class="event-table"><thead><tr><th>#</th><th>事件</th><th>界面</th><th>θ₁</th><th>θ₂</th><th>临界角</th></tr></thead><tbody>');
    result.events.forEach((e, i) => {
      const cls = e.kind === 'tir' ? 'tir-row' : '';
      const kindText =
        e.kind === 'refract' ? '折射' : e.kind === 'tir' ? '全反射' : e.kind === 'ruler' ? '到标尺' : e.kind === 'blocked' ? '遮挡' : '超范围';
      const iface = e.medium1 ? `${mediumLabel(e.medium1)}→${mediumLabel(e.medium2!)}` : e.surface;
      rows.push(
        `<tr class="${cls}"><td>${i + 1}</td><td>${kindText}</td><td title="${e.surface}">${iface}</td>` +
          `<td>${e.thetaI?.toFixed(1) ?? '—'}°</td><td>${e.thetaT?.toFixed(1) ?? '—'}°</td>` +
          `<td>${e.critical != null ? e.critical.toFixed(1) + '°' : '—'}</td></tr>`,
      );
    });
    rows.push('</tbody></table>');
    rows.push('<p class="hint">θ₁ 入射角、θ₂ 折射角（相对界面法线）。把鼠标放在界面列可看完整名称。</p>');
  }

  // 解释
  rows.push('<h3>物理解释</h3>');
  rows.push(`<div class="explain">${explain(result, iors)}</div>`);

  panel.innerHTML = rows.join('');
}

export function renderIdle(panel: HTMLElement): void {
  panel.innerHTML =
    '<div class="status">在画面中点击任意位置，追踪该视线经过的全部介质边界，并给出最终刻度读数。</div>' +
    '<div class="explain">建议先点「正视样例 / 斜视样例」，再拖动折射率滑条或开启侧扫全反射。</div>';
}
