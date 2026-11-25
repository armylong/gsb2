import * as THREE from 'three';
import {
  DISK_RADIUS,
  FIXED_DT,
  MagneticSimulation,
  SIDE_VIEW_RIGHT,
  SIDE_VIEW_UP,
  type InputState,
} from './sim.ts';

export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export function pilotInput(sim: MagneticSimulation): InputState {
  if (sim.mode === 'switching') return { x: 0, y: 0 };
  switch (sim.panelId) {
    case 'floor':
      return { x: 1, y: 0 };
    case 'w0':
      return { x: 0, y: 1 };
    case 'top':
      return { x: 1, y: 0 };
    case 'w1':
      return { x: 0, y: -1 };
    default:
      return { x: 0, y: 0 };
  }
}

function checkRoute(): CheckResult {
  const sim = new MagneticSimulation();
  sim.reset('home');
  let enteredW1 = false;
  let missing = false;

  for (let i = 0; i < 12 / FIXED_DT; i++) {
    sim.step(FIXED_DT, pilotInput(sim), SIDE_VIEW_RIGHT, SIDE_VIEW_UP);
    if (sim.panelId === 'w1' && sim.mode === 'attached') enteredW1 = true;
    if (sim.events.some((e) => e.type === 'missing')) missing = true;
  }

  const outer = sim.switchLog.filter((r) => r.outer);
  const speedConserved = sim.switchLog.every(
    (r) => Math.abs(r.beforeSpeed - r.afterSpeed) < 1e-6,
  );
  const directions =
    outer.length === 2 &&
    outer[0].before.dot(new THREE.Vector3(0, 1, 0)) > 0.95 &&
    outer[0].after.dot(new THREE.Vector3(1, 0, 0)) > 0.95 &&
    outer[1].before.dot(new THREE.Vector3(1, 0, 0)) > 0.95 &&
    outer[1].after.dot(new THREE.Vector3(0, -1, 0)) > 0.95;

  const pass =
    outer.length === 2 &&
    outer[0].id === 'w0-top' &&
    outer[1].id === 'top-w1' &&
    enteredW1 &&
    missing &&
    speedConserved &&
    directions;

  return {
    id: 'route',
    label: '两个外角、速度旋转与缺面',
    pass,
    detail: pass
      ? `通过：${outer.map((r) => r.id).join(' → ')}；换面速度模长守恒，缺面边缘已脱离`
      : `失败：outer=${outer.length}, w1=${enteredW1}, missing=${missing}, speed=${speedConserved}, dirs=${directions}`,
  };
}

function checkDetach(): CheckResult {
  const sim = new MagneticSimulation();
  sim.reset('home');
  let perch = false;

  for (let i = 0; i < 5 / FIXED_DT; i++) {
    sim.step(FIXED_DT, pilotInput(sim), SIDE_VIEW_RIGHT, SIDE_VIEW_UP);
    if (sim.panelId === 'w0' && sim.position.y >= 2.18 && sim.mode === 'attached') {
      perch = true;
      break;
    }
  }

  if (!perch) return { id: 'detach', label: '主动脱离并落回起点', pass: false, detail: '未能到达起点上方脱离点' };

  sim.velocity.set(0, 0, 0);
  sim.detach('自检脱离', 0);

  let landed = false;
  for (let i = 0; i < 3 / FIXED_DT; i++) {
    sim.step(FIXED_DT, { x: 0, y: 0 }, SIDE_VIEW_RIGHT, SIDE_VIEW_UP);
    if (sim.isAtHome(0.45)) {
      landed = true;
      break;
    }
  }

  const yOk = Math.abs(sim.position.y - DISK_RADIUS) < 0.03;
  const pass = landed && yOk;
  return {
    id: 'detach',
    label: '主动脱离并落回起点',
    pass,
    detail: pass
      ? `通过：落点水平误差 ${sim.distanceToHome().toFixed(3)} m`
      : `失败：landed=${landed}, panel=${sim.panelId}, dist=${sim.distanceToHome().toFixed(3)}, y=${sim.position.y.toFixed(3)}`,
  };
}

function checkStability(): CheckResult {
  const sim = new MagneticSimulation();
  sim.reset('home');
  let stable = true;

  for (let i = 0; i < 120; i++) {
    sim.position.set(
      -5 - DISK_RADIUS + (i % 2 === 0 ? -0.025 : 0.025),
      DISK_RADIUS + (i % 3) * 0.006,
      i % 4 < 2 ? -0.035 : 0.035,
    );
    sim.velocity.set(0, 0, 0);
    sim.step(FIXED_DT, { x: 0, y: 0 }, SIDE_VIEW_RIGHT, SIDE_VIEW_UP);
    if (sim.stableFaceId !== 'floor' || sim.panelId !== 'floor') {
      stable = false;
      break;
    }
  }

  const blockerExcluded = !sim.scoreFaces(sim.position).some((s) => s.panelId === 'blocker');
  return {
    id: 'stability',
    label: '边缘抖动稳定 / 隔板排除',
    pass: stable && blockerExcluded,
    detail: stable && blockerExcluded ? '通过：轻微左右抖动未触发连续换面，blocker 不参与吸附' : '失败：稳定选择或隔板排除异常',
  };
}

function checkBlockerCollision(): CheckResult {
  const sim = new MagneticSimulation();
  sim.reset('home');
  sim.mode = 'free';
  sim.panelId = null;
  sim.position.copy(sim.blocker.center);
  sim.velocity.set(-2, 0, 0);
  sim.step(FIXED_DT, { x: 0, y: 0 });
  const pass = sim.blockedThisFrame && sim.blocker.attachable === false;
  return {
    id: 'blocker-collision',
    label: '禁吸隔板碰撞',
    pass,
    detail: pass ? '通过：隔板明确不可吸附且产生碰撞反馈' : '失败：隔板未正确阻挡',
  };
}

export function runAllChecks(): CheckResult[] {
  return [checkRoute(), checkDetach(), checkStability(), checkBlockerCollision()];
}
