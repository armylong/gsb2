import { App } from './app.js';
import { LightEngine } from './engine.js';
import { QUALITY_SPECS } from './scene.js';

const app = new App();
// 暴露到 window 便于在控制台调试与自动化测试（不影响正常使用）
declare global {
  interface Window {
    diffuseLab: App;
    __Engine: typeof LightEngine;
    __Specs: typeof QUALITY_SPECS;
  }
}
window.diffuseLab = app;
window.__Engine = LightEngine;
window.__Specs = QUALITY_SPECS;
