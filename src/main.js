import { App } from './app.js';

const app = new App();
app.init();

// 对比模式下的编辑组切换
document.querySelectorAll('input[name="active-side"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    app.setActiveSide(e.target.value);
  });
});

// 暴露给控制台做手动验证
window.__shadowBench = app;
