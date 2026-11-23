import { useSyncExternalStore } from 'react';
import { AudioEngine } from '../audio/engine';

/** 模块级单例：整个应用共享同一个引擎与事件台账 */
export const engine = new AudioEngine();

export function useEngineSnapshot() {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
}
