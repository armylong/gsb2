import type { Health, SwitchReason } from './types';

export const HEALTH_LABEL: Record<Health, string> = {
  ok: '正常',
  stalled: '停顿',
  offline: '掉线',
};

export const REASON_LABEL: Record<SwitchReason, string> = {
  startup: '启动选主路',
  'primary-unavailable': '主路不可用，切备路',
  'route-unavailable': '在播路不可用，紧急切换',
  'both-unavailable': '主备均不可用',
  'signal-restored': '路由恢复，紧急恢复画面',
  'recovery-primary': '主路稳定恢复，按主优先回切',
  'both-recovered-election': '主备同时恢复，规则选主路',
  'manual-lock': '手动锁定一路',
  'lock-released': '取消锁定后重新自动选路',
  'manual-align': '手动对齐',
};

export const REASON_RULE: Record<SwitchReason, string> = {
  startup: '初始输出固定为主路 A。',
  'primary-unavailable': `确认掉线后，以主路最后有效 PTS 为目标寻找同内容时间附近的备帧。`,
  'route-unavailable': '在播路确认故障后，选择唯一可用且最接近目标 PTS 的一路。',
  'both-unavailable': '没有健康路由；保留最后一帧并明确提示 NO SIGNAL，不伪装成正常画面。',
  'signal-restored': '无输出期间任一路由恢复到可播状态时立即恢复画面，并尽量跳转到当前内容时间。',
  'recovery-primary': '备路在播时，主路必须同步且连续稳定达到阈值，并经过切换保持窗，才回切 A。',
  'both-recovered-election': '同一时刻恢复时：锁定路优先；否则当前在播路优先；仍并列则固定主路 A 优先。',
  'manual-lock': '手动锁优先于自动策略；锁定路故障时不自动逃走，由操作员决定解锁。',
  'lock-released': '解除锁定后立即执行一次自动选举；若当前路健康则尽量不产生额外切换。',
  'manual-align': '操作员要求硬跳转到参考内容时间。',
};
