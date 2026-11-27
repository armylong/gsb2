import './styles.css';
import { FabricScene } from './weave/scene';
import { Panel } from './weave/panel';
import { defaultState } from './weave/presets';
import type { WeaveState } from './weave/weaveMath';

const init = defaultState();
const state: WeaveState = {
  model: init.model,
  yarn: init.yarn,
  repsX: 3,
  repsZ: 3,
};

const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const panelHost = document.querySelector<HTMLElement>('#panel')!;

const scene = new FabricScene(viewport, state);
const panel = new Panel(panelHost, scene, state);

// 测试/调试入口：读取当前应用状态
(window as unknown as { __weave: unknown }).__weave = {
  getState: (): WeaveState => panel.getState(),
  yarnCount: (): number => scene.yarnCount(),
};

// 点击与轨道拖动区分：按下记下位置，抬起时位移很小才算点击拾取
const dom = scene.renderer.domElement;
let downX = 0;
let downY = 0;
dom.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
dom.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
  const pick = scene.pick(e.clientX, e.clientY);
  if (pick) panel.handlePick(pick);
  else panel.pickMissed();
});

// 导出弹窗点击遮罩关闭
document.querySelector('#modal')!.addEventListener('click', (e) => {
  const modal = e.currentTarget as HTMLElement;
  if (e.target === modal) {
    modal.classList.add('hidden');
    modal.innerHTML = '';
  }
});
