// 悬挂压缩曲线图：当前运行 + 可选对照曲线 A
import { TRAVEL } from './sim';

export interface RunRecord {
  t: number[];   // 模拟时间 s
  cL: number[];  // 左轮压缩 m
  cR: number[];  // 右轮压缩 m
}

export function emptyRecord(): RunRecord {
  return { t: [], cL: [], cR: [] };
}

const WINDOW_SEC = 8; // 显示最近 8 秒

export function drawChart(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  cur: RunRecord,
  ref: RunRecord | null,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#14181d';
  ctx.fillRect(0, 0, w, h);

  const yMax = TRAVEL * 1.3;
  const tEnd = Math.max(WINDOW_SEC, cur.t.length ? cur.t[cur.t.length - 1] : WINDOW_SEC);
  const tStart = tEnd - WINDOW_SEC;
  const xOf = (t: number) => ((t - tStart) / WINDOW_SEC) * w;
  const yOf = (c: number) => h / 2 - (c / yMax) * (h / 2 - 6);

  // 网格：零线 + 行程限制线
  ctx.strokeStyle = '#3a4552';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, yOf(0)); ctx.lineTo(w, yOf(0)); ctx.stroke();
  ctx.strokeStyle = '#5a3a3a';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, yOf(TRAVEL)); ctx.lineTo(w, yOf(TRAVEL)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, yOf(-TRAVEL)); ctx.lineTo(w, yOf(-TRAVEL)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#8a95a5';
  ctx.textAlign = 'left';
  ctx.fillText(`+${(TRAVEL * 1000).toFixed(0)}mm`, 4, yOf(TRAVEL) - 2);
  ctx.fillText(`-${(TRAVEL * 1000).toFixed(0)}mm`, 4, yOf(-TRAVEL) + 10);
  ctx.textAlign = 'right';
  ctx.fillText(`${tStart.toFixed(1)}s`, xOf(tStart) + 34, h - 4);
  ctx.fillText(`${tEnd.toFixed(1)}s`, w - 4, h - 4);

  const plot = (rec: RunRecord, idx: 'cL' | 'cR', color: string, dash: number[] = []) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < rec.t.length; i++) {
      if (rec.t[i] < tStart) continue;
      const x = xOf(rec.t[i]), y = yOf(rec[idx][i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };

  if (ref) {
    plot(ref, 'cL', 'rgba(150,150,150,0.8)', [5, 4]);
    plot(ref, 'cR', 'rgba(150,150,150,0.45)', [5, 4]);
  }
  plot(cur, 'cL', '#4aa3ff');
  plot(cur, 'cR', '#ff9a4a');
}
