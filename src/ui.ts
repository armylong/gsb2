import type { CameraKind, CameraPose } from './cameraRig';
import type { FaceMode } from './orientation';
import type { SafetyState, Sign } from './Sign';
import type { SizeMode } from './Sign';
import { SIGN_CONFIGS } from './signs';

const FACE_LABELS: Record<FaceMode, string> = {
  FIXED: '固定朝向',
  BILLBOARD: '始终面向镜头',
  Y_LOCKED: '仅绕竖轴',
};

const SIZE_LABELS: Record<SizeMode, string> = {
  WORLD: '固定世界尺寸',
  SCREEN: '固定屏幕尺寸',
};

const SAFETY_LABELS: Record<SafetyState, string> = {
  OK: '正常',
  NEAR: '近裁面淡入中',
  CLIPPED: '已进入近裁面（隐藏）',
  BEHIND: '在相机背后（隐藏）',
  CLAMPED: '已钳制最大屏幕占比',
};

export interface UiCallbacks {
  onFaceMode: (id: string, mode: FaceMode) => void;
  onSizeMode: (id: string, mode: SizeMode) => void;
  onCameraKind: (kind: CameraKind) => void;
  onPose: (pose: CameraPose) => void;
  onToggleReferences: (on: boolean) => void;
  onToggleShelf: (on: boolean) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class LabUI {
  private panel: HTMLElement;
  private hud: HTMLElement;
  private rows = new Map<string, HTMLElement>();
  private selectedId: string | null = null;

  constructor(
    poses: CameraPose[],
    callbacks: UiCallbacks,
    initialReferences: boolean,
    initialShelf: boolean,
  ) {
    this.panel = document.getElementById('panel')!;
    this.hud = document.getElementById('hud')!;
    this.buildPanel(poses, callbacks, initialReferences, initialShelf);
  }

  private buildPanel(
    poses: CameraPose[],
    cb: UiCallbacks,
    initialReferences: boolean,
    initialShelf: boolean,
  ): void {
    const h1 = el('h1', undefined, '指示牌朝向试验场');
    this.panel.appendChild(h1);

    // ---- 相机类型 ----
    this.panel.appendChild(el('h2', undefined, '相机类型'));
    const kindRow = el('div', 'row');
    for (const kind of ['perspective', 'orthographic'] as CameraKind[]) {
      const btn = el('button', undefined, kind === 'perspective' ? '透视' : '正交');
      btn.dataset.kind = kind;
      btn.classList.add('active');
      btn.addEventListener('click', () => {
        this.setActiveKind(kind);
        cb.onCameraKind(kind);
      });
      kindRow.appendChild(btn);
    }
    this.panel.appendChild(kindRow);

    // ---- 预设姿态 ----
    this.panel.appendChild(el('h2', undefined, '可复现姿态'));
    const poseList = el('div', 'pose-list');
    for (const pose of poses) {
      const btn = el('button', 'pose', pose.label);
      btn.title = pose.note;
      btn.dataset.poseId = pose.id;
      btn.addEventListener('click', () => {
        document
          .querySelectorAll('.pose')
          .forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.setActiveKind(pose.kind);
        cb.onPose(pose);
      });
      poseList.appendChild(btn);
    }
    this.panel.appendChild(poseList);

    // ---- 全局开关 ----
    this.panel.appendChild(el('h2', undefined, '调试显示'));
    const refLabel = el('label', 'check');
    const refCb = el('input') as HTMLInputElement;
    refCb.type = 'checkbox';
    refCb.checked = initialReferences;
    refCb.addEventListener('change', () => cb.onToggleReferences(refCb.checked));
    refLabel.append(refCb, document.createTextNode(' 参考线/锚点/竖轴/法线'));
    this.panel.appendChild(refLabel);

    const shelfLabel = el('label', 'check');
    const shelfCb = el('input') as HTMLInputElement;
    shelfCb.type = 'checkbox';
    shelfCb.checked = initialShelf;
    shelfCb.addEventListener('change', () => cb.onToggleShelf(shelfCb.checked));
    shelfLabel.append(shelfCb, document.createTextNode(' 架子转动+缩放动画'));
    this.panel.appendChild(shelfLabel);

    // ---- 每张牌的控制 ----
    this.panel.appendChild(el('h2', undefined, '每张牌的约束'));
    for (const cfg of SIGN_CONFIGS) {
      const card = el('div', 'card');
      card.dataset.signId = cfg.id;
      card.appendChild(el('div', 'card-title', cfg.label));

      const faceSel = el('select') as HTMLSelectElement;
      for (const mode of ['FIXED', 'BILLBOARD', 'Y_LOCKED'] as FaceMode[]) {
        const opt = el('option') as HTMLOptionElement;
        opt.value = mode;
        opt.textContent = FACE_LABELS[mode];
        if (mode === cfg.faceMode) opt.selected = true;
        faceSel.appendChild(opt);
      }
      faceSel.addEventListener('change', () => {
        cb.onFaceMode(cfg.id, faceSel.value as FaceMode);
      });

      const sizeSel = el('select') as HTMLSelectElement;
      for (const mode of ['WORLD', 'SCREEN'] as SizeMode[]) {
        const opt = el('option') as HTMLOptionElement;
        opt.value = mode;
        opt.textContent = SIZE_LABELS[mode];
        if (mode === cfg.sizeMode) opt.selected = true;
        sizeSel.appendChild(opt);
      }
      sizeSel.addEventListener('change', () => {
        cb.onSizeMode(cfg.id, sizeSel.value as SizeMode);
      });

      const selRow = el('div', 'row');
      selRow.append(faceSel, sizeSel);
      card.appendChild(selRow);

      const status = el('div', 'status', '');
      card.appendChild(status);
      this.rows.set(cfg.id, status);

      this.panel.appendChild(card);
    }
  }

  private setActiveKind(kind: CameraKind): void {
    document.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => {
      b.classList.toggle('active', b.dataset.kind === kind);
    });
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    document.querySelectorAll('.card').forEach((c) => {
      c.classList.toggle('selected', (c as HTMLElement).dataset.signId === id);
    });
  }

  /** 每帧刷新 HUD 与卡片状态。 */
  refresh(signs: Sign[], cameraKind: CameraKind): void {
    for (const sign of signs) {
      const node = this.rows.get(sign.id);
      if (!node) continue;
      const flags: string[] = [];
      if (sign.undecidable) flags.push('⚠ 竖轴奇点：朝向无法决定，已冻结');
      if (sign.safety !== 'OK') flags.push(SAFETY_LABELS[sign.safety]);
      node.textContent = flags.length ? flags.join('｜') : `状态：${SAFETY_LABELS.OK}`;
      node.classList.toggle('warn', sign.undecidable || sign.safety !== 'OK');
    }

    const selected = signs.find((s) => s.id === this.selectedId);
    const undecided = signs.filter((s) => s.undecidable).map((s) => s.label);
    const unsafe = signs.filter((s) => s.safety !== 'OK').map((s) => s.label);

    this.hud.innerHTML = [
      `相机：${cameraKind === 'perspective' ? '透视 Perspective' : '正交 Orthographic'}`,
      `拖拽旋转 · 滚轮缩放 · 右键平移 · 点击牌面点选（墙体遮挡不可选）`,
      selected ? `选中：${selected.label}（红色虚线连到锚点）` : '未选中任何牌',
      undecided.length ? `⚠ 奇点冻结：${undecided.join('、')}` : '',
      unsafe.length ? `安全处理：${unsafe.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('<br>');
  }
}
