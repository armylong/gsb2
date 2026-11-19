import { useEffect, useRef, useState } from 'react';

/**
 * 时间输入：编辑期间保持本地文本，失焦或回车才提交。
 * 避免每敲一个数字就触发重排、把行挪走。
 */
export function TimeInput({
  value,
  min = 0,
  max,
  step = 100,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min?: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const skipBlurCommit = useRef(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  function commit() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || draft.trim() === '') {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  }

  return (
    <input
      className="time-input"
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setFocused(false);
        if (skipBlurCommit.current) {
          skipBlurCommit.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          skipBlurCommit.current = true;
          commit();
          (event.target as HTMLInputElement).blur();
        }
        if (event.key === 'Escape') {
          skipBlurCommit.current = true;
          setDraft(String(value));
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
