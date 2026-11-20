import { useEffect, useRef } from 'react';
import { drawCharacter, drawStage } from '../render/pose';
import type { PreviewFrame } from '../engine/preview';
import type { MachineSnapshot } from '../engine/types';

interface StageProps {
  machine: MachineSnapshot | null;
  preview: PreviewFrame | null;
  mode: 'runtime' | 'preview';
}

/**
 * Canvas 画面。运行时用状态机快照; 预览模式只使用纯函数生成的帧,
 * 且明确关闭攻击窗口等运行时特效。
 */
export function Stage({ machine, preview, mode }: StageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let frameHandle = 0;
    const render = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStage(ctx, width, height);

      if (mode === 'preview' && preview) {
        drawCharacter(ctx, width, height, {
          visual: preview.state.visual,
          progress: preview.progress,
          elapsedMs: preview.elapsedMs,
          showRuntimeFx: false,
          windowOpen: false,
        });
        drawPreviewBadge(ctx, width, height, preview.state.name);
      } else if (machine) {
        drawCharacter(ctx, width, height, {
          visual: machine.state.visual,
          progress: machine.progress,
          elapsedMs: machine.elapsedMs,
          showRuntimeFx: true,
          windowOpen: machine.attackWindowOpen,
        });
        drawRuntimeBadge(ctx, width, height);
        if (machine.attackWindowOpen) {
          drawWindowBadge(ctx, width - 16, height - 16);
        }
      }
    };

    const schedule = () => {
      cancelAnimationFrame(frameHandle);
      frameHandle = requestAnimationFrame(render);
    };

    render();
    const observer = new ResizeObserver(schedule);
    observer.observe(wrap);
    return () => {
      cancelAnimationFrame(frameHandle);
      observer.disconnect();
    };
  }, [mode, machine, preview]);

  return (
    <div className="stage" ref={wrapRef}>
      <canvas ref={canvasRef} aria-label="几何角色动作画面" />
    </div>
  );
}

function drawPreviewBadge(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  stateName: string,
) {
  ctx.save();
  ctx.fillStyle = 'rgba(56,189,248,0.14)';
  ctx.strokeStyle = 'rgba(56,189,248,0.75)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  rounded(ctx, 14, 54, 172, 28, 7);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#7dd3fc';
  ctx.font = '600 12px "PingFang SC", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`预览 · ${stateName} · 无副作用`, 26, 68);
  ctx.restore();
  void width;
  void height;
}

function drawRuntimeBadge(ctx: CanvasRenderingContext2D, width: number, _height: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(74,222,128,0.12)';
  ctx.strokeStyle = 'rgba(74,222,128,0.6)';
  ctx.lineWidth = 1.5;
  rounded(ctx, width - 136, 14, 122, 28, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#86efac';
  ctx.font = '600 12px "PingFang SC", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('● 运行时', width - 122, 28);
  ctx.restore();
  void _height;
}

function drawWindowBadge(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(248,113,113,0.18)';
  ctx.strokeStyle = 'rgba(248,113,113,0.8)';
  ctx.lineWidth = 1.5;
  rounded(ctx, x - 120, y - 32, 120, 28, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fca5a5';
  ctx.font = '600 12px "PingFang SC", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('攻击窗口开启', x - 108, y - 18);
  ctx.restore();
}

function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
