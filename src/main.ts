/**
 * 应用入口: 装配 Store / Viewer / Panel, 驱动播放循环与导出。
 * 播放用真实墙钟时间换算归一化 t, 姿态只由 t 决定 => 帧率/速度变化不影响姿态。
 */
import './styles.css';
import { Store } from './state/store';
import { Viewer, type ViewMode } from './three/Viewer';
import { Panel } from './ui/Panel';
import { buildCollisionCSV, buildPlanSVG, downloadText } from './core/export';
import { deg } from './core/kinematics';

const panelEl = document.getElementById('panel');
const viewportEl = document.getElementById('viewport');
if (!panelEl || !viewportEl) throw new Error('缺少 #panel / #viewport 容器');

const store = new Store('clear');
const viewer = new Viewer(viewportEl);

const panel = new Panel(panelEl, store, {
  onView: (v: ViewMode) => viewer.setView(v),
  onExportSVG: (plane) => {
    const s = store.getState();
    const svg = buildPlanSVG({
      mechanism: s.mechanism,
      obstacles: s.obstacles,
      plane,
      range: s.range,
      samples: s.sweepSamples,
      title: `开门余量检查图 · ${s.scenarioName} · ${plane === 'top' ? '俯视' : '侧视'}`,
    });
    downloadText(
      `clearance-${plane}-${s.scenarioId}.svg`,
      svg,
      'image/svg+xml;charset=utf-8',
    );
  },
  onExportCSV: () => {
    const s = store.getState();
    const csv = buildCollisionCSV({
      events: s.events,
      mechanism: s.mechanism,
      range: s.range,
    });
    downloadText(`collision-list-${s.scenarioId}.csv`, csv, 'text/csv;charset=utf-8');
  },
});

viewer.setObstacleDragHandler((id, center) => {
  store.moveObstacle(id, center);
});

// ---- 状态 -> 视图 ----
let lastSweepKey = '';
store.subscribe((s) => {
  const pose = store.currentPose();
  viewer.updatePose(s.mechanism, pose);
  viewer.syncObstacles(s.obstacles, s.selectedObstacleId);
  viewer.selectObstacle(s.selectedObstacleId);
  viewer.setSweepVisible(s.showSweep);
  viewer.updateContacts(s.liveContacts);

  // 只在影响扫掠的参数变化时重建几何
  const key = JSON.stringify({
    pivot: s.mechanism.door.pivot,
    doorRange: s.mechanism.door.angleRange,
    trayRange: s.mechanism.tray.angleRange,
    seq: s.mechanism.sequence,
    range: s.range,
    samples: s.sweepSamples,
    trayHinge: s.mechanism.tray.hingeInDoor,
    doorSize: s.mechanism.door.size,
    traySize: s.mechanism.tray.size,
  });
  if (key !== lastSweepKey) {
    lastSweepKey = key;
    viewer.updateSweep(s.mechanism, s.range, s.sweepSamples);
  }
});

// ---- 播放循环 (墙钟时间驱动, 与帧率解耦) ----
let lastWall = performance.now();
function tick(now: number): void {
  const dt = (now - lastWall) / 1000;
  lastWall = now;
  const s = store.getState();
  if (s.playing) {
    let next = s.t + dt / s.cycleSeconds;
    if (next >= 1) {
      // 到结尾停住 (避免循环掩盖结尾碰撞), 再按播放才重新开始
      next = 1;
      store.setPlaying(false);
    }
    store.setT(next);
  }
  viewer.render();
  requestAnimationFrame(tick);
}
requestAnimationFrame((t) => {
  lastWall = t;
  requestAnimationFrame(tick);
});

// 暴露给 README 验证脚本/控制台使用
(window as unknown as { __clearanceApp: unknown }).__clearanceApp = {
  store,
  viewer,
  panel,
  version: '1.0.0',
  doorDeg: () => deg(store.currentPose().doorAngle),
};
