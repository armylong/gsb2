import { PickResult } from '../picker/picker';

const fmt = (v: number): string => v.toFixed(3);

/** 左上帮助 + 右上调雾读数面板，全部走 DOM，不污染 3D 场景 */
export class Hud {
  readonly pickPanel: HTMLElement;
  private readonly modeLine: HTMLElement;
  private readonly phaseLine: HTMLElement;

  constructor() {
    const help = document.createElement('div');
    help.id = 'help';
    help.innerHTML = `
      <b>室内低雾调试台</b><br>
      轨道模式：拖拽旋转 · 滚轮缩放 · <b>单击画面</b>读取该射线的雾程数据<br>
      第一人称：W/A/S/D 移动 · Shift 加速 · Q/E 升降 · Esc 退出<br>
      F 键：雾开关对照　|　绿点=进入雾区　红点=离开/被表面截断　黄线=实际参与雾程
    `;
    document.body.appendChild(help);

    this.modeLine = document.createElement('div');
    this.modeLine.id = 'mode-line';
    document.body.appendChild(this.modeLine);

    this.pickPanel = document.createElement('div');
    this.pickPanel.id = 'pick-panel';
    this.pickPanel.innerHTML = '<b>射线雾程读数</b><div class="muted">轨道模式下单击画面任意位置</div>';
    document.body.appendChild(this.pickPanel);

    this.phaseLine = document.createElement('div');
    this.phaseLine.id = 'phase-line';
    document.body.appendChild(this.phaseLine);
  }

  setMode(mode: string, autoWalk: boolean): void {
    this.modeLine.textContent = autoWalk
      ? '自动穿越边界中…（观察进出雾盒时画面连续）'
      : `镜头模式：${mode === 'fps' ? '第一人称' : '轨道（可点选）'}`;
  }

  setPhaseInfo(text: string): void {
    this.phaseLine.textContent = text;
  }

  showPick(result: PickResult): void {
    if (!result.rayHitsBox) {
      this.pickPanel.innerHTML = `
        <b>射线雾程读数</b>
        <div class="row"><span>命中物体</span><span>${result.objectName}</span></div>
        <div class="row"><span>表面距离</span><span>${fmt(result.surfaceDistance)} m</span></div>
        <div class="row ok"><span>射线未碰雾盒</span><span>显示原色，雾参与长度 0</span></div>
      `;
      return;
    }
    const truncated = result.participatedLength < result.leaveDistance - result.enterDistance - 1e-3;
    this.pickPanel.innerHTML = `
      <b>射线雾程读数</b>
      <div class="row"><span>命中物体</span><span>${result.objectName}</span></div>
      <div class="row"><span>表面距离</span><span>${fmt(result.surfaceDistance)} m</span></div>
      <div class="row"><span>进入雾区距离</span><span>${fmt(result.enterDistance)} m</span></div>
      <div class="row"><span>离开雾区距离</span><span>${fmt(result.leaveDistance)} m</span></div>
      <div class="row highlight"><span>实际参与长度</span><span>${fmt(result.participatedLength)} m${
        truncated ? '（被表面截断）' : ''
      }</span></div>
      <div class="row"><span>光学厚度 τ</span><span>${fmt(result.opticalThickness)}</span></div>
      <div class="row"><span>透射率 exp(-τ)</span><span>${fmt(result.transmittance)}</span></div>
      <div class="row"><span>进入点密度</span><span>${fmt(result.densityEnter)}</span></div>
      <div class="row"><span>截断点密度</span><span>${fmt(result.densityLeave)}</span></div>
    `;
  }
}
