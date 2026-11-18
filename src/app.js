// 应用入口：组装 Store / 三维场景 / 音频引擎 / 控制面板，驱动渲染循环。
import { Store } from './store.js';
import { AudioEngine } from './audio-engine.js';
import { SceneView } from './scene.js';
import { ControlPanel } from './ui.js';

const store = new Store();
const audioEngine = new AudioEngine(store);
const sceneView = new SceneView(document.getElementById('scene'), store);
const panel = new ControlPanel(store, audioEngine);
panel.bindNumericInputs(sceneView);

// 页面任意位置点击时若音频处于挂起状态则尝试恢复（仍由用户手势触发，符合自动播放策略）
document.addEventListener('pointerdown', () => {
  if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
    audioEngine.ctx.resume().catch(() => {});
  }
});

// 键盘：Q/E 转向听者，R 重置；输入框聚焦时不拦截
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'q' || e.key === 'Q') sceneView.rotateListener(-15);
  if (e.key === 'e' || e.key === 'E') sceneView.rotateListener(15);
  if (e.key === 'r' || e.key === 'R') store.reset();
});

function loop() {
  sceneView.render();
  requestAnimationFrame(loop);
}
loop();

// 供自动化测试访问内部组件
window.__app = { store, audioEngine, sceneView };
export { store, audioEngine, sceneView };
