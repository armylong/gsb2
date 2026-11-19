import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // jsdom 中通常可用；忽略异常即可。
  }
});
