import GUI from 'lil-gui';
import * as THREE from 'three';
import { CameraRig } from '../controls/cameraRig';
import { FOG_PRESETS, FogParams } from '../fog/fog';

interface GuiCallbacks {
  onFogBoxChanged: () => void;
  onDensityChanged: () => void;
  onLightChanged: () => void;
  applyPreset: (index: number) => void;
  refreshPick: () => void;
}

/**
 * 全部调参控件。
 * 控制器值与 FogParams 双向绑定，预设切换后调用 updateDisplay 回显。
 */
export function createGui(
  params: FogParams,
  rig: CameraRig,
  camera: THREE.PerspectiveCamera,
  cb: GuiCallbacks,
): { gui: GUI; updateDisplay: () => void } {
  const gui = new GUI({ title: '低雾调试台' });
  // lil-gui 根节点带行内 top/right，必须用行内样式顶掉，否则会压住读数面板
  gui.domElement.style.top = '12px';
  gui.domElement.style.right = '326px';

  // ---- 雾区几何 ----
  const boxFolder = gui.addFolder('雾区边界（可挪动的盒子）');
  boxFolder.add(params.boxCenter, 'x', -8, 8, 0.1).name('中心 X').onChange(cb.onFogBoxChanged);
  boxFolder.add(params.boxCenter, 'y', 0, 5, 0.1).name('中心 Y').onChange(cb.onFogBoxChanged);
  boxFolder.add(params.boxCenter, 'z', -8, 8, 0.1).name('中心 Z').onChange(cb.onFogBoxChanged);
  boxFolder.add(params.boxSize, 'x', 1, 16, 0.1).name('宽度 X').onChange(cb.onFogBoxChanged);
  boxFolder.add(params.boxSize, 'y', 0.5, 6, 0.1).name('高度 Y').onChange(cb.onFogBoxChanged);
  boxFolder.add(params.boxSize, 'z', 1, 16, 0.1).name('纵深 Z').onChange(cb.onFogBoxChanged);
  boxFolder.add(params, 'showBounds').name('显示边界线框');
  const presetActions: Record<string, () => void> = {};
  FOG_PRESETS.forEach((preset, i) => {
    presetActions[preset.name] = () => cb.applyPreset(i);
  });
  FOG_PRESETS.forEach((preset) => {
    boxFolder.add(presetActions, preset.name).name(`预设：${preset.name}`);
  });
  boxFolder.open();

  // ---- 密度 ----
  const densityFolder = gui.addFolder('密度与高度衰减');
  densityFolder.add(params, 'density', 0, 0.6, 0.005).name('底层密度 ρ₀').onChange(cb.onDensityChanged);
  densityFolder.add(params, 'falloff', 0.1, 6, 0.05).name('变稀速度 h（小=快）').onChange(cb.onDensityChanged);
  densityFolder.open();

  // ---- 光照 ----
  const lightFolder = gui.addFolder('平行光与环境');
  lightFolder.add(params, 'sunAzimuth', -180, 180, 1).name('方位角').onChange(cb.onLightChanged);
  lightFolder.add(params, 'sunElevation', 5, 85, 1).name('仰角').onChange(cb.onLightChanged);
  lightFolder.add(params, 'sunIntensity', 0, 3, 0.05).name('平行光强度').onChange(cb.onLightChanged);
  lightFolder.add(params, 'anisotropy', 0, 0.9, 0.01).name('方向性 g（0=无）').onChange(cb.refreshPick);
  lightFolder.addColor(params, 'sunColor').name('平行光颜色').onChange(cb.onLightChanged);
  lightFolder.addColor(params, 'ambient').name('环境亮度').onChange(cb.onLightChanged);
  lightFolder.addColor(params, 'fogTint').name('雾颜色');
  const lightActions = {
    顺光: () => {
      // 沿当前视线水平方向照来：azimuth 对齐相机朝向
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      params.sunAzimuth = THREE.MathUtils.radToDeg(Math.atan2(-dir.x, -dir.z));
      params.sunElevation = 35;
      cb.onLightChanged();
      updateDisplay();
    },
    逆光: () => {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      params.sunAzimuth = THREE.MathUtils.radToDeg(Math.atan2(dir.x, dir.z));
      params.sunElevation = 35;
      cb.onLightChanged();
      updateDisplay();
    },
    方向性归零: () => {
      params.anisotropy = 0;
      cb.refreshPick();
      updateDisplay();
    },
  };
  lightFolder.add(lightActions, '顺光').name('顺光（光从前方照来）');
  lightFolder.add(lightActions, '逆光').name('逆光（光从背后照来）');
  lightFolder.add(lightActions, '方向性归零').name('方向性归零（两侧一致）');
  lightFolder.close();

  // ---- 画面与镜头 ----
  const viewFolder = gui.addFolder('画面与镜头');
  viewFolder.add(params, 'fogEnabled').name('雾开关（F 键同效）');
  const camActions = {
    轨道视角: () => rig.setMode('orbit'),
    第一人称: () => rig.setMode('fps'),
  };
  viewFolder.add(camActions, '轨道视角');
  viewFolder.add(camActions, '第一人称');
  const walkAction = {
    run: () => {
      const on = rig.toggleAutoWalk();
      walkButton.name(on ? '■ 停止自动穿越边界' : '▶ 自动穿越边界（雾外→雾内→雾外）');
    },
  };
  const walkButton = viewFolder.add(walkAction, 'run').name('▶ 自动穿越边界（雾外→雾内→雾外）');
  const camPresets = {
    雾区外全景: () => rig.applyPreset('outside'),
    贴前边界朝外面: () => rig.applyPreset('inside-edge'),
    雾区深处回看: () => rig.applyPreset('inside-deep'),
    俯视全局: () => rig.applyPreset('overlook'),
  };
  viewFolder.add(camPresets, '雾区外全景');
  viewFolder.add(camPresets, '贴前边界朝外面');
  viewFolder.add(camPresets, '雾区深处回看');
  viewFolder.add(camPresets, '俯视全局');
  viewFolder.close();

  function updateDisplay(): void {
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  return { gui, updateDisplay };
}
