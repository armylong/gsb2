import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { engine } from './state/useEngine';
import { planSequence, planTrigger, validateMapping } from './model/mapping';

// 本地工具的调试/自动化句柄（e2e 冒烟脚本通过它直接断言引擎行为）
Object.assign(window, {
  __sampler: { engine, planTrigger, planSequence, validateMapping },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
