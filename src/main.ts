import * as THREE from 'three';
import { createClips } from './core/clips';
import { AnimationBlender } from './core/blender';
import { createPresetMask, type MaskPresetId } from './core/mask';
import { createDemoStates, type DemoState } from './core/demos';
import { getBoneSpec, getParent } from './core/skeleton';
import { wrap01 } from './core/math';
import type { BoneName } from './core/types';
import { createCharacter } from './three/character';
import { createScene } from './three/scene';
import { applyPose, SkeletonOverlay } from './three/poseApplier';
import { Trajectory } from './three/trajectory';
import { buildJointSelect, buildMaskControls, getHandles, syncMaskSliders } from './ui/controls';

const STEP_SECONDS = 1 / 60;

function defaultConfig() {
  return {
    fadeDuration: 0.6,
    mask: createPresetMask('all'),
    applyRootMotion: true,
    timeScale: 1,
  };
}

function main(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const handles = getHandles();
  const clips = createClips();
  const defaults = defaultConfig();
  const blender = new AnimationBlender(clips.walk, clips.sneak, {
    fadeDuration: defaults.fadeDuration,
    mask: new Map(defaults.mask),
    applyRootMotion: defaults.applyRootMotion,
    timeScale: defaults.timeScale,
  });
  const demos = createDemoStates();

  const character = createCharacter();
  const sceneCtx = createScene(canvas, character);

  const overlay = new SkeletonOverlay(character);
  sceneCtx.scene.add(overlay.group);
  const trajectory = new Trajectory();
  sceneCtx.scene.add(trajectory.line);

  /* ---------------- 遮罩控件 ---------------- */
  const { sliders, presetButtons } = buildMaskControls(
    blender.mask,
    (id: MaskPresetId) => {
      blender.mask = createPresetMask(id);
      syncMaskSliders(sliders, blender.mask);
      for (const [pid, btn] of presetButtons) btn.classList.toggle('active', pid === id);
    },
    (name, w) => {
      blender.mask.set(name, w);
      // 手动调整任一关节后，预设高亮取消（不再严格匹配预设）
      for (const btn of presetButtons.values()) btn.classList.remove('active');
    },
  );
  presetButtons.get('all')!.classList.add('active');

  const jointSelect = buildJointSelect((name) => selectJoint(name));
  let selectedJoint: BoneName | null = null;
  function selectJoint(name: BoneName | null): void {
    selectedJoint = name;
    overlay.setSelected(name);
    jointSelect.value = name ?? '';
    if (!name) {
      handles.jointPose.innerHTML = '<span class="muted">未选择关节</span>';
    }
  }
  sceneCtx.onPick((name) => selectJoint(name));

  /* ---------------- 演示状态按钮 ---------------- */
  const demoButtons = new Map<string, HTMLButtonElement>();
  for (const demo of demos) {
    const btn = document.createElement('button');
    btn.textContent = demo.label;
    btn.addEventListener('click', () => loadDemo(demo));
    handles.demoButtonRoot.appendChild(btn);
    demoButtons.set(demo.id, btn);
  }

  function loadDemo(demo: DemoState): void {
    // 演示状态需要确定的起点：先复位，再应用演示动作
    blender.reset({
      fadeDuration: defaults.fadeDuration,
      mask: new Map(defaults.mask),
      applyRootMotion: defaults.applyRootMotion,
      timeScale: defaults.timeScale,
    });
    blender.mask = new Map(demo.mask);
    blender.fadeDuration = demo.fadeDuration;
    blender.applyRootMotion = demo.applyRootMotion;
    demo.apply(blender);
    trajectory.clear();
    syncMaskSliders(sliders, blender.mask);
    handles.rootChk.checked = blender.applyRootMotion;
    handles.fadeDuration.value = String(blender.fadeDuration);
    handles.fadeDurationVal.textContent = `${blender.fadeDuration.toFixed(2)}s`;
    handles.demoDesc.textContent = demo.description;
    for (const [id, b] of demoButtons) b.classList.toggle('active', id === demo.id);
  }

  /* ---------------- 播放控制 ---------------- */
  handles.playBtn.addEventListener('click', () => {
    blender.playing = !blender.playing;
    handles.playBtn.textContent = blender.playing ? '暂停' : '继续';
  });

  handles.stepBtn.addEventListener('click', () => {
    blender.playing = false;
    handles.playBtn.textContent = '继续';
    const sample = blender.singleStep(STEP_SECONDS);
    applyPose(character, sample.pose, blender.applyRootMotion ? blender.rootPosition : 0);
    if (blender.applyRootMotion) recordTrajectory();
  });

  handles.resetBtn.addEventListener('click', () => resetAll());

  function resetAll(): void {
    blender.reset({
      fadeDuration: defaults.fadeDuration,
      mask: new Map(defaults.mask),
      applyRootMotion: defaults.applyRootMotion,
      timeScale: defaults.timeScale,
    });
    syncMaskSliders(sliders, blender.mask);
    handles.playBtn.textContent = '暂停';
    handles.timeScale.value = String(defaults.timeScale);
    handles.timeScaleVal.textContent = `${defaults.timeScale.toFixed(2)}×`;
    handles.scrub.value = '0';
    handles.scrubVal.textContent = '0.00s';
    handles.fadeDuration.value = String(defaults.fadeDuration);
    handles.fadeDurationVal.textContent = `${defaults.fadeDuration.toFixed(2)}s`;
    handles.rootChk.checked = defaults.applyRootMotion;
    handles.demoDesc.textContent = '点击按钮载入一个确定性演示状态。';
    for (const b of demoButtons.values()) b.classList.remove('active');
    for (const btn of presetButtons.values()) btn.classList.remove('active');
    presetButtons.get('all')!.classList.add('active');
    selectJoint(null);
    jointSelect.value = '';
    trajectory.clear();
  }

  handles.timeScale.addEventListener('input', () => {
    blender.timeScale = Number(handles.timeScale.value);
    handles.timeScaleVal.textContent = `${blender.timeScale.toFixed(2)}×`;
  });

  /* ---------------- 时间拖动（姿态预览，不累计位移、不改播放头） ---------------- */
  let scrubbing = false;
  // 拖动开始前的播放头快照：松手后恢复，保证“继续当前循环”而非跳到预览时间
  let playheadSnapshot: { timeA: number; timeB: number } | null = null;

  handles.scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
    playheadSnapshot = { timeA: blender.timeA, timeB: blender.timeB };
  });
  handles.scrub.addEventListener('pointerup', () => {
    endScrub();
  });
  handles.scrub.addEventListener('pointercancel', () => {
    endScrub();
  });
  function endScrub(): void {
    if (!scrubbing) return;
    scrubbing = false;
    // 恢复拖动前的播放头与姿态；位移从未被改动
    if (playheadSnapshot) {
      blender.scrub(playheadSnapshot.timeA, playheadSnapshot.timeB);
      playheadSnapshot = null;
    }
  }
  handles.scrub.addEventListener('input', () => {
    const tA = Number(handles.scrub.value);
    // B 的拖动时间按两动作时长比例映射，使两者相位一致，便于对比同一步态瞬间
    const tB = (tA / clips.walk.duration) * clips.sneak.duration;
    // scrub 只写播放头用于姿态采样，不累计根位移；松手即恢复真实播放头
    const sample = blender.scrub(tA, tB);
    applyPose(character, sample.pose, blender.applyRootMotion ? blender.rootPosition : 0);
    handles.scrubVal.textContent = `${tA.toFixed(2)}s`;
  });

  /* ---------------- 交叉淡入 ---------------- */
  handles.fadeB.addEventListener('click', () => blender.startFade('sneak'));
  handles.fadeA.addEventListener('click', () => blender.startFade('walk'));
  handles.fadeDuration.addEventListener('input', () => {
    blender.fadeDuration = Number(handles.fadeDuration.value);
    handles.fadeDurationVal.textContent = `${blender.fadeDuration.toFixed(2)}s`;
  });

  /* ---------------- 根位移 / 显示开关 ---------------- */
  handles.rootChk.addEventListener('change', () => {
    blender.applyRootMotion = handles.rootChk.checked;
    // 模式切换后旧拖尾的坐标系语义已变（原地 vs 位移），清空避免混淆
    trajectory.clear();
  });
  handles.skeletonChk.addEventListener('change', () => overlay.setVisible(handles.skeletonChk.checked));
  handles.trajectoryChk.addEventListener('change', () => trajectory.setVisible(handles.trajectoryChk.checked));

  /* ---------------- 轨迹记录（仅真实播放时） ---------------- */
  const hipsWorld = new THREE.Vector3();
  function recordTrajectory(): void {
    const hips = character.bones.get('hips')!;
    hips.getWorldPosition(hipsWorld);
    trajectory.addPoint(hipsWorld.x, hipsWorld.y, hipsWorld.z);
  }

  /* ---------------- 关节局部姿态检视 ---------------- */
  const euler = new THREE.Euler();
  function updateJointInspector(): void {
    if (!selectedJoint) return;
    const bone = character.bones.get(selectedJoint)!;
    euler.setFromQuaternion(bone.quaternion, 'YXZ');
    const parent = getParent(selectedJoint);
    const rad2deg = 180 / Math.PI;
    handles.jointPose.innerHTML = `
      <div><b>${getBoneSpec(selectedJoint).label}</b> <span class="muted">${selectedJoint}</span></div>
      <div class="muted">父关节：${parent ?? '—'}</div>
      <div>局部旋转 (欧拉角 °)</div>
      <div><span class="axis">X</span>${(euler.x * rad2deg).toFixed(1)}°
           <span class="axis">Y</span>${(euler.y * rad2deg).toFixed(1)}°
           <span class="axis">Z</span>${(euler.z * rad2deg).toFixed(1)}°</div>
      <div>局部位移 (m)
           <span class="axis">x</span>${bone.position.x.toFixed(3)}
           <span class="axis">y</span>${bone.position.y.toFixed(3)}
           <span class="axis">z</span>${bone.position.z.toFixed(3)}</div>
      <div class="muted">遮罩权重：${(blender.mask.get(selectedJoint) ?? 0).toFixed(2)}</div>
    `;
  }

  /* ---------------- HUD ---------------- */
  function updateHud(): void {
    handles.phaseA.textContent = wrap01(blender.timeA / clips.walk.duration).toFixed(3);
    handles.phaseB.textContent = wrap01(blender.timeB / clips.sneak.duration).toFixed(3);
    handles.loopA.textContent = `循环 ${Math.floor(blender.timeA / clips.walk.duration)}`;
    handles.loopB.textContent = `循环 ${Math.floor(blender.timeB / clips.sneak.duration)}`;
    handles.weight.textContent = blender.globalWeight.toFixed(3);
    handles.fadeDir.textContent =
      blender.fadeDirection === 'idle'
        ? `空闲（${blender.base.label}）`
        : blender.fadeDirection === 'A_to_B'
          ? '淡入 A→B'
          : '反向 B→A';
    handles.root.textContent = `${blender.rootPosition.toFixed(3)} m`;
    handles.loopTotal.textContent = `累计循环 ${blender.loopCount}`;
    if (!scrubbing && blender.playing) {
      const phaseTimeA = blender.timeA % clips.walk.duration;
      handles.scrub.value = String(phaseTimeA);
      handles.scrubVal.textContent = `${phaseTimeA.toFixed(2)}s`;
    }
  }

  /* ---------------- 主循环 ---------------- */
  const clock = new THREE.Clock();
  let frameCount = 0;

  function tick(): void {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (blender.playing && !scrubbing) {
      const sample = blender.step(dt);
      applyPose(character, sample.pose, blender.applyRootMotion ? blender.rootPosition : 0);
      frameCount++;
      if (frameCount % 3 === 0) recordTrajectory(); // 约 20Hz 采样，控制拖尾密度
    } else {
      // 暂停/拖动时仍按当前状态重算一次姿态，保证改遮罩/淡入参数即时可见
      const sample = blender.computeSample(0);
      applyPose(character, sample.pose, blender.applyRootMotion ? blender.rootPosition : 0);
    }

    overlay.update();
    updateHud();
    updateJointInspector();
    sceneCtx.controls.update();
    sceneCtx.renderer.render(sceneCtx.scene, sceneCtx.camera);
    requestAnimationFrame(tick);
  }

  // 初始化一次姿态与 HUD
  const initial = blender.computeSample(0);
  applyPose(character, initial.pose, 0);
  updateHud();
  tick();

  // 暴露给自动化验证（浏览器控制台/E2E 可选）
  (window as unknown as { __blender: AnimationBlender }).__blender = blender;
}

main();
