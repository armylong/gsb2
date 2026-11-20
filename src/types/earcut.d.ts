declare module 'earcut' {
  /** Mapbox earcut 三角剖分：输入扁平坐标，返回三角形索引 */
  export default function earcut(data: number[], holes?: number[], dim?: number): number[];
}
