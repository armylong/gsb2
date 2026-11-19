import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cloneConfig, createSim, step } from '../engine/engine';
import type { SimConfig, SimState } from '../engine/types';
import { TICK_SECONDS } from '../engine/types';

export type Speed = 0 | 1 | 2 | 4 | 8;

const SPEED_TICKS_PER_SEC: Record<Exclude<Speed, 0>, number> = {
  1: 2, // 实时：1 tick = 0.5s
  2: 4,
  4: 8,
  8: 16,
};

export interface SimulationController {
  subscribe: (fn: () => void) => () => void;
  getState: () => SimState;
  running: boolean;
  speed: Speed;
  play: () => void;
  pause: () => void;
  /** 固定时间单步：推进固定 tick 数（默认 1 tick = 0.5s），与倍率无关。 */
  stepOnce: (ticks?: number) => void;
  setSpeed: (s: Speed) => void;
  reset: (config?: SimConfig) => void;
  applyConfig: (config: SimConfig) => void;
  getConfig: () => SimConfig;
  toggleNodePaused: (nodeId: string) => void;
  setConnectionEnabled: (connectionId: string, enabled: boolean) => void;
  selectedNodeId: string | null;
  selectedConnectionId: string | null;
  selectNode: (id: string | null) => void;
  selectConnection: (id: string | null) => void;
  /** 画布插值用：当前帧内已累计但尚未构成整 tick 的秒数。 */
  getInterp: () => number;
}

export function useSimulation(initialConfig: SimConfig): SimulationController {
  const stateRef = useRef<SimState>(createSim(initialConfig));
  const configRef = useRef<SimConfig>(cloneConfig(initialConfig));
  const listenersRef = useRef(new Set<() => void>());
  const versionRef = useRef(0); // 仅在 emit 时递增，作为 useSyncExternalStore 的稳定快照
  const runningRef = useRef(false);
  const speedRef = useRef<Speed>(2);
  const accRef = useRef(0); // 累计秒数
  const lastTsRef = useRef<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  // running/speed 镜像到 state 以驱动按钮重渲染
  const [running, setRunning] = useState(false);
  const [speed, setSpeedState] = useState<Speed>(2);

  const emit = useCallback(() => {
    versionRef.current += 1;
    listenersRef.current.forEach((fn) => fn());
  }, []);

  const subscribe = useCallback((fn: () => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const getState = useCallback(() => stateRef.current, []);
  const getConfig = useCallback(() => configRef.current, []);
  const getInterp = useCallback(() => {
    const s = speedRef.current;
    if (s === 0 || !runningRef.current) return 0;
    const tickRate = SPEED_TICKS_PER_SEC[s];
    return Math.min(accRef.current * tickRate, 1);
  }, []);

  // 固定步长时钟：requestAnimationFrame 只负责累积真实时间，整数 tick 交给引擎。
  useEffect(() => {
    let raf = 0;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (lastTsRef.current === null) {
        lastTsRef.current = ts;
        return;
      }
      let dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      if (dt > 0.25) dt = 0.25; // 标签页切走后回来，不追补巨量时间
      if (!runningRef.current || speedRef.current === 0) return;

      accRef.current += dt;
      const tickRate = SPEED_TICKS_PER_SEC[speedRef.current];
      const interval = 1 / tickRate;
      let advanced = false;
      while (accRef.current >= interval) {
        accRef.current -= interval;
        step(stateRef.current);
        advanced = true;
      }
      if (advanced) emit();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [emit]);

  const play = useCallback(() => {
    runningRef.current = true;
    accRef.current = 0;
    lastTsRef.current = null;
    setRunning(true);
  }, []);

  const pause = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
  }, []);

  const stepOnce = useCallback(
    (ticks = 1) => {
      runningRef.current = false;
      setRunning(false);
      for (let i = 0; i < ticks; i++) step(stateRef.current);
      accRef.current = 0;
      emit();
    },
    [emit],
  );

  const setSpeed = useCallback((s: Speed) => {
    speedRef.current = s;
    accRef.current = 0;
    setSpeedState(s);
  }, []);

  const reset = useCallback(
    (config?: SimConfig) => {
      if (config) configRef.current = cloneConfig(config);
      stateRef.current = createSim(configRef.current);
      runningRef.current = false;
      accRef.current = 0;
      lastTsRef.current = null;
      setRunning(false);
      setSelectedNodeId(null);
      setSelectedConnectionId(null);
      emit();
    },
    [emit],
  );

  const applyConfig = useCallback(
    (config: SimConfig) => {
      configRef.current = cloneConfig(config);
      stateRef.current = createSim(configRef.current);
      runningRef.current = false;
      accRef.current = 0;
      setRunning(false);
      setSelectedNodeId(null);
      setSelectedConnectionId(null);
      emit();
    },
    [emit],
  );

  const toggleNodePaused = useCallback(
    (nodeId: string) => {
      const cfg = configRef.current.nodes.find((n) => n.id === nodeId);
      if (!cfg) return;
      cfg.paused = !cfg.paused;
      // 暂停/恢复属于热操作：直接作用于当前引擎配置，不重置模拟进度。
      stateRef.current.config.nodes.find((n) => n.id === nodeId)!.paused = cfg.paused;
      emit();
    },
    [emit],
  );

  const setConnectionEnabled = useCallback(
    (connectionId: string, enabled: boolean) => {
      const draft = configRef.current.connections.find((c) => c.id === connectionId);
      if (draft) draft.enabled = enabled;
      const live = stateRef.current.config.connections.find((c) => c.id === connectionId);
      if (live) live.enabled = enabled; // 在途货物不动，只影响新发货
      emit();
    },
    [emit],
  );

  const selectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    if (id) setSelectedConnectionId(null);
  }, []);
  const selectConnection = useCallback((id: string | null) => {
    setSelectedConnectionId(id);
    if (id) setSelectedNodeId(null);
  }, []);

  // 让 Canvas 之外的 React 组件（面板、账目表）在每次 emit（tick/操作）后重渲染。
  // 快照只在 emit 时变化，避免 useSyncExternalStore 的无限重渲染告警。
  useSyncExternalStore(subscribe, () => versionRef.current);

  return {
    subscribe,
    getState,
    running,
    speed,
    play,
    pause,
    stepOnce,
    setSpeed,
    reset,
    applyConfig,
    getConfig,
    toggleNodePaused,
    setConnectionEnabled,
    selectedNodeId,
    selectedConnectionId,
    selectNode,
    selectConnection,
    getInterp,
  };
}

export { TICK_SECONDS };
