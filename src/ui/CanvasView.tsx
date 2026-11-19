import { useEffect, useRef } from 'react';
import type { SimulationController } from '../state/useSimulation';
import { CANVAS_H, CANVAS_W, drawScene, hitConnection, hitNode } from './drawing';

interface Props {
  sim: SimulationController;
}

export function CanvasView({ sim }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 渲染循环：引擎按 tick 突变，画布按帧插值，二者解耦。
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const state = sim.getState();
      drawScene(ctx, state, {
        selectedNodeId: sim.selectedNodeId,
        selectedConnectionId: sim.selectedConnectionId,
        interp: sim.getInterp(),
      });
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [sim]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const py = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    const state = sim.getState();
    const nodeId = hitNode(state, px, py);
    if (nodeId) {
      sim.selectNode(nodeId);
      return;
    }
    const connId = hitConnection(state, px, py);
    if (connId) sim.selectConnection(connId);
    else {
      sim.selectNode(null);
      sim.selectConnection(null);
    }
  };

  return (
    <div className="canvas-wrap">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        onClick={handleClick}
        aria-label="产线画布"
      />
    </div>
  );
}
