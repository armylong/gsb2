/**
 * Marquee —— 拖框矩形覆盖层
 *
 * 覆盖层与 canvas 同尺寸、同原点（position:absolute, inset:0），
 * 矩形直接使用画布本地 CSS 像素坐标，与 Picker 的判定坐标系完全一致。
 */
export class Marquee {
  /** @param {HTMLElement} el */
  constructor(el) {
    this.el = el;
    this.active = false;
  }

  /** @param {{x:number,y:number}} start 画布本地 CSS 像素 */
  begin(start) {
    this.active = true;
    this.start = start;
    this.el.hidden = false;
    this.update(start);
  }

  /** @param {{x:number,y:number}} current */
  update(current) {
    if (!this.active) return;
    const x = Math.min(this.start.x, current.x);
    const y = Math.min(this.start.y, current.y);
    const w = Math.abs(current.x - this.start.x);
    const h = Math.abs(current.y - this.start.y);
    this.el.style.transform = `translate(${x}px, ${y}px)`;
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
  }

  /** 结束并返回规范化矩形（画布本地 CSS 像素） */
  end(current) {
    const rect = {
      x0: this.start.x,
      y0: this.start.y,
      x1: current.x,
      y1: current.y,
    };
    this.cancel();
    return rect;
  }

  cancel() {
    this.active = false;
    this.el.hidden = true;
    this.el.style.width = '0px';
    this.el.style.height = '0px';
  }
}
