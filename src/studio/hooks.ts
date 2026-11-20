import { useSyncExternalStore } from 'react';
import { studio } from './store';

export function useStudio() {
  return useSyncExternalStore(studio.subscribe, studio.getSnapshot);
}

export { studio };
