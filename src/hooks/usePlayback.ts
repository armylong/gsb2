import { useCallback, useEffect, useRef, useState } from 'react';
import { nextArrival, previousArrival } from '../lib/engine';
import type { CaptionEvent } from '../lib/types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export interface Playback {
  time: number;
  playing: boolean;
  speed: number;
  setSpeed: (speed: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  restart: () => void;
  seek: (time: number) => void;
  toEnd: () => void;
  stepBack: () => void;
  stepForward: () => void;
  nudge: (delta: number) => void;
}

export function usePlayback(events: readonly CaptionEvent[], end: number): Playback {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const lastFrame = useRef<number | null>(null);

  // 换样例时回到起点，避免把上一个样例的进度带过来。
  useEffect(() => {
    setTime(0);
    setPlaying(false);
  }, [events]);

  useEffect(() => {
    if (!playing) {
      lastFrame.current = null;
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      const last = lastFrame.current ?? now;
      lastFrame.current = now;
      const delta = Math.min(0.25, Math.max(0, (now - last) / 1000)) * speed;
      setTime((current) => clamp(current + delta, 0, end));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);

  useEffect(() => {
    if (playing && time >= end) setPlaying(false);
  }, [playing, time, end]);

  const seek = useCallback(
    (value: number) => {
      setPlaying(false);
      setTime(clamp(value, 0, end));
    },
    [end],
  );

  const toggle = useCallback(() => {
    setTime((current) => (current >= end ? 0 : current));
    setPlaying((value) => !value);
  }, [end]);

  const restart = useCallback(() => {
    setPlaying(false);
    setTime(0);
  }, []);

  const toEnd = useCallback(() => {
    setPlaying(false);
    setTime(end);
  }, [end]);

  const stepForward = useCallback(() => {
    setPlaying(false);
    setTime((current) => {
      const next = nextArrival(events, current);
      return next === null ? end : clamp(next, 0, end);
    });
  }, [events, end]);

  const stepBack = useCallback(() => {
    setPlaying(false);
    setTime((current) => {
      const previous = previousArrival(events, current);
      return previous === null ? 0 : clamp(previous, 0, end);
    });
  }, [events, end]);

  const nudge = useCallback(
    (delta: number) => {
      setPlaying(false);
      setTime((current) => clamp(current + delta, 0, end));
    },
    [end],
  );

  return {
    time,
    playing,
    speed,
    setSpeed,
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    toggle,
    restart,
    seek,
    toEnd,
    stepBack,
    stepForward,
    nudge,
  };
}
