// 全部规则常量。改规则只改这里，引擎与界面都从这里读。

export const RULES = {
  /** 普通跨格耗时（刻） */
  MOVE_TICKS: 3,
  /** 携带重信片时的跨格耗时（刻） */
  HEAVY_MOVE_TICKS: 5,
  /** 被潮水打断后，退回安全格需要的时间（刻） */
  RETREAT_TICKS: 2,
  /** 重信片禁止通行的路面高程上限：height <= 该值的路不能走 */
  HEAVY_MIN_EDGE_HEIGHT: 1,
  /** 轻信片随携带者被淹没多少刻后损毁 */
  LIGHT_RUIN_WET_TICKS: 3,
  /** 连续被淹没多少刻后爬虫被困（本局失败） */
  STRANDED_WET_TICKS: 6,
  /** 单次等待上限（刻） */
  MAX_WAIT: 20,
  /** 路线提示的搜索视野（刻，约两个潮周期） */
  HINT_HORIZON: 120,
} as const;
