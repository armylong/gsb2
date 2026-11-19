import { useEffect, useRef, useState } from 'react';
import { ActionId, SceneId } from '../core/bindings';
import { World } from '../core/world';
import { Chord, MODIFIERS, Modifier, isModifierCode } from '../core/keys';
import { drawScene } from './draw';
import { BindingsPanel } from './BindingsPanel';
import { RecordPanel } from './RecordPanel';
import { DemosPanel } from './DemosPanel';
import { LivePanel } from './LivePanel';

export interface CaptureRequest {
  scene: SceneId;
  action: ActionId;
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return !!t.closest('input, textarea, select, [contenteditable="true"]');
}

export function App() {
  const worldRef = useRef<World>();
  if (!worldRef.current) worldRef.current = new World();
  const world = worldRef.current;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [capture, setCapture] = useState<CaptureRequest | null>(null);
  const captureRef = useRef<CaptureRequest | null>(null);
  captureRef.current = capture;
  const [, setFrame] = useState(0);

  // 捕获状态下按键只用于设置绑定，不进入输入引擎
  const handleCaptureKey = (e: KeyboardEvent) => {
    const cap = captureRef.current;
    if (!cap) return;
    if (e.code === 'Escape') {
      setCapture(null); // 取消：保留旧绑定
      return;
    }
    if (isModifierCode(e.code)) return; // 等待主键
    const modifiers: Modifier[] = MODIFIERS.filter((m) => {
      if (m === 'Shift') return e.shiftKey;
      if (m === 'Ctrl') return e.ctrlKey;
      if (m === 'Alt') return e.altKey;
      return e.metaKey;
    });
    const chord: Chord = { code: e.code, modifiers };
    setCapture(null);
    // 通过事件告知 BindingsPanel 完成捕获
    window.dispatchEvent(new CustomEvent('sandbox:captured', { detail: { ...cap, chord } }));
  };

  useEffect(() => {
    const w = worldRef.current!;
    const down = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return; // 输入框打字不触发游戏动作
      if (captureRef.current) {
        e.preventDefault();
        handleCaptureKey(e);
        return;
      }
      if (shouldPreventDefault(w, e.code)) e.preventDefault();
      w.engine.keyDown(e.code); // 引擎内部会忽略系统重复事件
    };
    const up = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      w.engine.keyUp(e.code);
    };
    const blur = () => {
      w.handleBlur();
      setCapture(null);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const w = worldRef.current!;
      w.tick();
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx) drawScene(ctx, w);
      setFrame((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div>
      <h1>输入调试沙盒</h1>
      <div className="layout">
        <div>
          <canvas ref={canvasRef} width={480} height={360} />
          <LivePanel world={world} />
        </div>
        <div>
          <BindingsPanel world={world} capture={capture} onCaptureChange={setCapture} />
          <RecordPanel world={world} />
          <DemosPanel world={world} />
        </div>
      </div>
    </div>
  );
}

/** 已绑定的键 / 方向键 / 空格阻止浏览器默认行为（滚动等） */
function shouldPreventDefault(world: World, code: string): boolean {
  if (code.startsWith('Arrow') || code === 'Space' || code === 'Tab') return true;
  for (const scene of Object.values(world.engine.bindings)) {
    for (const chord of Object.values(scene)) {
      if (chord && chord.code === code) return true;
    }
  }
  return false;
}
