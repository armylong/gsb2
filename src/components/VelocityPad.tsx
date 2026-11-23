import { useEffect, useRef, useState } from 'react';
import { Mapping } from '../model/types';

interface Props {
  mapping: Mapping;
  velocity: number;
  onVelocityChange: (v: number) => void;
  onTrigger: (v: number) => number | null;
  onRelease: (pressId: number | null) => void;
  engineReady: boolean;
  onInit: () => void;
}

const QUICK = [16, 40, 64, 76, 95, 120];

/**
 * 试听垫：
 * - pointerdown 触发、pointerup 松键；每次按下生成独立 pressId
 * - 键盘自动 repeat 被 e.repeat 挡掉，不会重复触发
 * - 横向拖动垫面可直接改变力度
 */
export function VelocityPad({ mapping, velocity, onVelocityChange, onTrigger, onRelease, engineReady, onInit }: Props) {
  const [pressed, setPressed] = useState(false);
  const pressRef = useRef<number | null>(null);
  const padRef = useRef<HTMLDivElement>(null);

  const fire = (v: number): void => {
    if (!engineReady) {
      onInit();
      return;
    }
    pressRef.current = onTrigger(v);
    setPressed(true);
  };

  const end = (): void => {
    if (pressRef.current !== null) onRelease(pressRef.current);
    pressRef.current = null;
    setPressed(false);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== mapping.triggerCode || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      e.preventDefault();
      fire(velocity);
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code !== mapping.triggerCode) return;
      end();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping.triggerCode, velocity, engineReady]);

  const pointerVelocity = (clientX: number): number => {
    const el = padRef.current;
    if (!el) return velocity;
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(1 + p * 126);
  };

  return (
    <div className="panel">
      <h2>{mapping.keyLabel}（触发垫）</h2>
      <div
        ref={padRef}
        className={`pad ${pressed ? 'pressed' : ''}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const v = pointerVelocity(e.clientX);
          onVelocityChange(v);
          fire(v);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) onVelocityChange(pointerVelocity(e.clientX));
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="vel-big">{velocity}</div>
        <div className="hint">
          按 {mapping.triggerCode === 'Space' ? '空格键' : mapping.triggerCode} 或点击垫面触发 · 按住左右拖动改力度 · 松键结束本次声音
        </div>
      </div>

      <label className="field" style={{ marginTop: 10 }}>
        <span>力度 1..127</span>
        <input
          type="range"
          min={1}
          max={127}
          value={velocity}
          onChange={(e) => onVelocityChange(Number(e.target.value))}
        />
      </label>

      <div className="vel-quick">
        {QUICK.map((v) => (
          <button key={v} onClick={() => onVelocityChange(v)} className={v === velocity ? 'primary' : ''}>
            {v}
          </button>
        ))}
        <button
          onClick={() => fire(velocity)}
          disabled={!engineReady}
          title="用当前力度触发一次（松键事件无对应声音时不会报错）"
        >
          触发
        </button>
      </div>
    </div>
  );
}
