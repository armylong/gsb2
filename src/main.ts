import './style.css';
import { defaultParams } from './params';
import { SceneLab } from './sceneLab';
import { Panel } from './ui';

const viewport = document.getElementById('viewport')!;
const panelRoot = document.getElementById('panel')!;

const lab = new SceneLab(viewport, defaultParams());
new Panel(panelRoot, lab);
// 测试钩子（生产环境无副作用）
(window as unknown as { __lab: typeof lab }).__lab = lab;

// 分屏标签
const labelA = document.createElement('div');
labelA.className = 'split-label left';
labelA.textContent = 'A 组';
labelA.style.display = 'none';
const labelB = document.createElement('div');
labelB.className = 'split-label right';
labelB.textContent = 'B 组';
labelB.style.display = 'none';
viewport.append(labelA, labelB);

// 轻提示
const toast = document.createElement('div');
toast.id = 'toast';
viewport.append(toast);
let toastTimer: number | undefined;
function showToast(msg: string): void {
  toast.textContent = msg;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === 'w' || e.key === 'W') {
    lab.setTransformMode('translate');
    showToast('手柄：移动（拖动灯板，5cm 安全间距自动生效）');
  } else if (e.key === 'e' || e.key === 'E') {
    lab.setTransformMode('rotate');
    showToast('手柄：旋转（转到背面可观察照明变化）');
  } else if (e.key === 'r' || e.key === 'R') {
    lab.setTransformMode('scale');
    showToast('手柄：缩放（灯板尺寸建议改用左侧滑块，保持物理面积正确）');
  }
});

// 用一个轻量观察器同步分屏标签：监听分屏按钮
const observer = new MutationObserver(() => {
  const splitBtn = [...panelRoot.querySelectorAll('button')].find(
    (b) => b.textContent === '分屏 A | B',
  );
  const on = splitBtn?.classList.contains('active') ?? false;
  labelA.style.display = on ? 'block' : 'none';
  labelB.style.display = on ? 'block' : 'none';
});
observer.observe(panelRoot, { subtree: true, attributes: true, attributeFilter: ['class'] });

showToast('点击物体放置亮度探针；W/E/R 切换灯板手柄模式');
