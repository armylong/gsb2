export const TIMELINE_DURATION_SEC = 29.7;
export const SIM_STEP_SEC = 1 / 120;

export const OFFLINE_CONFIRM_SEC = 0.45;
export const STALL_CONFIRM_SEC = 0.65;
export const RECOVERY_STABLE_SEC = 1.15;
export const SWITCH_HOLD_SEC = 0.8;

export const SYNC_TOLERANCE_SEC = 0.16;
export const EMERGENCY_SYNC_SEC = 0.8;
export const NEARBY_LIMIT_SEC = 1.0;

export const CATCHUP_RATE = 4;
export const CATCHUP_DEADLINE_SEC = 2.5;
/** At 4x while the master runs at 1x, gap closes at 3 seconds per second. */
export const CATCHUP_MAX_RECOVERABLE_GAP_SEC =
  (CATCHUP_RATE - 1) * CATCHUP_DEADLINE_SEC;

export const MEDIA_SOURCES = {
  A: '/media/program-a.mp4',
  B: '/media/backup-b.mp4',
} as const;
