/** 笔画样式参数（全部以场景长度单位表达） */

export type CapStyle = 'butt' | 'square' | 'round';
export type JoinStyle = 'miter' | 'bevel' | 'round';

export interface StrokeOptions {
  /** 笔画宽度（直径），场景单位 */
  width: number;
  cap: CapStyle;
  join: JoinStyle;
  /** 尖角延伸限制（miter limit），以 miterLength / width 计；超过则退化为削平 */
  miterLimit: number;
  /** 圆角端帽/转角的分段数（每 π 弧度） */
  arcSegments: number;
}

export const DEFAULT_STROKE: StrokeOptions = {
  width: 1,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
  arcSegments: 16,
};
