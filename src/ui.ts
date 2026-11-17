export interface UIHandlers {
  onPreset(name: string): void;
  onResetCamera(): void;
  onPortalPose(id: 'A' | 'B', x: number, z: number, ry: number): void;
}

export interface UI {
  setPose(id: 'A' | 'B', x: number, z: number, ry: number): void;
  setDebug(text: string): void;
}

export function createUI(h: UIHandlers): UI {
  const left = document.getElementById('panel-left')!;
  left.innerHTML = `
    <div class="title">门洞空间演示</div>
    <div class="row">
      <button data-preset="face">正对</button>
      <button data-preset="offset">错位</button>
      <button data-preset="right">直角</button>
    </div>
    <div class="row"><button id="resetCam">重置相机</button></div>
    <div class="row">编辑门户:
      <button id="selA" class="sel">A</button>
      <button id="selB">B</button>
    </div>
    <div class="row"><label>X <input id="inX" type="range" min="-12" max="12" step="0.1"><span id="vX"></span></label></div>
    <div class="row"><label>Z <input id="inZ" type="range" min="-12" max="12" step="0.1"><span id="vZ"></span></label></div>
    <div class="row"><label>旋转 <input id="inR" type="range" min="-180" max="180" step="1"><span id="vR"></span></label></div>
    <div class="hint">
      点击画面锁定鼠标后:<br>
      W/S 前后 · A/D 左右平移<br>
      Shift 加速 · 鼠标观察 · Esc 释放<br>
      从门户正面走入开口即穿越
    </div>
  `;

  const debugEl = document.getElementById('debug')!;
  const inX = left.querySelector<HTMLInputElement>('#inX')!;
  const inZ = left.querySelector<HTMLInputElement>('#inZ')!;
  const inR = left.querySelector<HTMLInputElement>('#inR')!;
  const vX = left.querySelector<HTMLSpanElement>('#vX')!;
  const vZ = left.querySelector<HTMLSpanElement>('#vZ')!;
  const vR = left.querySelector<HTMLSpanElement>('#vR')!;
  const selA = left.querySelector<HTMLButtonElement>('#selA')!;
  const selB = left.querySelector<HTMLButtonElement>('#selB')!;

  let selected: 'A' | 'B' = 'A';
  const poses = {
    A: { x: -4, z: 0, ry: 90 },
    B: { x: 4, z: 0, ry: -90 },
  };

  function refreshSliders(): void {
    const p = poses[selected];
    inX.value = String(p.x);
    inZ.value = String(p.z);
    inR.value = String(p.ry);
    vX.textContent = p.x.toFixed(1);
    vZ.textContent = p.z.toFixed(1);
    vR.textContent = `${p.ry.toFixed(0)}°`;
  }

  function emitPose(): void {
    const p = poses[selected];
    p.x = parseFloat(inX.value);
    p.z = parseFloat(inZ.value);
    p.ry = parseFloat(inR.value);
    refreshSliders();
    h.onPortalPose(selected, p.x, p.z, p.ry);
  }

  inX.addEventListener('input', emitPose);
  inZ.addEventListener('input', emitPose);
  inR.addEventListener('input', emitPose);

  function select(id: 'A' | 'B'): void {
    selected = id;
    selA.classList.toggle('sel', id === 'A');
    selB.classList.toggle('sel', id === 'B');
    refreshSliders();
  }
  selA.addEventListener('click', () => select('A'));
  selB.addEventListener('click', () => select('B'));

  left.querySelectorAll<HTMLButtonElement>('button[data-preset]').forEach((b) => {
    b.addEventListener('click', () => h.onPreset(b.dataset.preset!));
  });
  left.querySelector<HTMLButtonElement>('#resetCam')!.addEventListener('click', () => h.onResetCamera());

  refreshSliders();

  return {
    setPose(id, x, z, ry) {
      poses[id] = { x, z, ry };
      if (id === selected) refreshSliders();
    },
    setDebug(text) {
      debugEl.textContent = text;
    },
  };
}
