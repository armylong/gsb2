// 无头浏览器冒烟测试：直接装配物理与场景模块，验证真实运行逻辑
import * as THREE from 'three';
import { Autopilot } from '../src/autopilot';
import { Disc } from '../src/disc';
import { buildWorld } from '../src/world';

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
}

const DT = 1 / 120;
const ZERO = new THREE.Vector3(0, 0, 0);

/** 脚本路线固定前进方向：floor/wall 沿 +v，ceiling 沿 -v（与 autopilot 一致） */
function routeForward(d: Disc): THREE.Vector3 {
  if (d.mode !== 'attached') return new THREE.Vector3(0, 0, 1);
  const sign = d.panel.id === 'ceiling' ? -1 : 1;
  return d.panel.vAxis.clone().multiplyScalar(sign);
}

// 真实构建一次场景（含 CanvasTexture / 几何体），排除渲染装配错误
buildWorld();

const disc = new Disc();
disc.reset();
const auto = new Autopilot();

// 1. 邻接边几何自检
const adjErrors = Disc.validateAdjacencies();
check('邻接公共边几何重合', adjErrors.length === 0, adjErrors.join('; ') || '4 条邻接全部重合');

// 2. 内置路线：两次外角换面 + 缺面脱离 + 落回起点
disc.reset();
const panelSequence: string[] = [disc.panel.id];
const eventsAtStart = disc.events.length;
let switches = 0;
let sawDetach = false;
let sawVoidReset = false;
let retentionMin = 1;
for (let i = 0; i < 1500; i++) {
  const beforeSwitchCount = disc.events.filter((e) => e.kind === 'switch').length;
  disc.update(DT, routeForward(disc));
  const switchNow = disc.events.filter((e) => e.kind === 'switch').length;
  if (switchNow > beforeSwitchCount) {
    switches += switchNow - beforeSwitchCount;
    panelSequence.push(disc.mode === 'attached' ? disc.panel.id : 'detached');
    if (disc.lastSwitch) retentionMin = Math.min(retentionMin, disc.lastSwitch.retention);
  }
  const fresh = disc.events.slice(eventsAtStart);
  if (fresh.some((e) => e.kind === 'detach')) sawDetach = true;
  if (fresh.some((e) => e.kind === 'void-reset')) { sawVoidReset = true; break; }
}
check('路线发生 2 次外角换面', switches === 2,
  `实际 ${switches} 次，经过面板: ${panelSequence.join(' → ')}`);
check('换面速率保持率 ≥99%', retentionMin >= 0.99, `最低 ${(retentionMin * 100).toFixed(2)}%`);
check('缺面处脱离', sawDetach, sawDetach ? '检测到 detach 事件' : '未检测到脱离');
check('坠落后落回起点', sawVoidReset, sawVoidReset ? '检测到 void-reset' : '未重置');

// 3. 主动脱离后重新吸附
disc.reset();
for (let i = 0; i < 60; i++) disc.update(DT, routeForward(disc));
const posBefore = disc.position.clone();
disc.detach();
const landEventsAtStart = disc.events.filter((e) => e.kind === 'land').length;
let landed = false;
for (let i = 0; i < 400; i++) {
  disc.update(DT, ZERO);
  if (disc.events.filter((e) => e.kind === 'land').length > landEventsAtStart) {
    landed = true;
    break;
  }
}
check('主动脱离后重新吸附', landed && disc.mode === 'attached',
  landed ? `重新吸附到 ${disc.panel.id}` : '未重新吸附');
check('脱离后仍在场地附近', posBefore.distanceTo(disc.position) < 6,
  `距脱离点 ${posBefore.distanceTo(disc.position).toFixed(2)}`);

// 4. 隔板绝不吸附：在隔板正后方朝 +v 推进，应被 block 且面板保持 floor
disc.reset();
disc.coords = { u: -2, v: 0.2 };
let blocked = false;
for (let i = 0; i < 500; i++) {
  disc.update(DT, new THREE.Vector3(0, 0, 1));
  if (disc.events.some((e) => e.kind === 'block')) blocked = true;
  if (blocked || disc.panel.id !== 'floor') break;
}
check('隔板阻挡且不吸附', blocked && disc.panel.id === 'floor',
  `block=${blocked}, 当前面板=${disc.panel.id}, v=${disc.coords.v.toFixed(2)}`);

// 5. 迟滞防抖：边带内高频左右抖动，不产生来回横跳
disc.reset();
for (let i = 0; i < 170; i++) disc.update(DT, routeForward(disc));
const switchesBefore = disc.events.filter((e) => e.kind === 'switch').length;
for (let i = 0; i < 500; i++) {
  const lateral = Math.sin(i * 0.35) * 0.95;
  disc.update(DT, new THREE.Vector3(lateral, 0, 0.7));
}
const switchesDuring = disc.events.filter((e) => e.kind === 'switch').length - switchesBefore;
check('边带抖动无来回换面', switchesDuring <= 1, `抖动期间换面 ${switchesDuring} 次`);

// 6. 自动驾驶 route 用例可独立完成
auto.start('route', disc);
let autoDone = false;
for (let i = 0; i < 1500; i++) {
  const intent = auto.update(DT, disc);
  disc.update(DT, intent ?? ZERO);
  if (!auto.isRunning) { autoDone = true; break; }
}
check('自动驾驶路线跑完', autoDone, autoDone ? 'verdict 已产生' : '超时未完成');

const passed = results.filter((r) => r.ok).length;
console.log('TEST_RESULT ' + JSON.stringify({ passed, total: results.length, results }));
document.title = `TESTS ${passed}/${results.length}`;
const el = document.createElement('pre');
el.id = 'test-output';
el.textContent = JSON.stringify({ passed, total: results.length, results }, null, 2);
el.style.cssText = 'padding:16px;font-size:14px;color:#9fe7b0;white-space:pre-wrap';
document.body.appendChild(el);
