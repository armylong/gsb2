import { Input, SnapshotPayload, SNAPSHOT_EVERY_TICKS, SERVER_MAX_INPUTS_PER_TICK, Vec2, WorldDef } from './protocol';
import { applyPushZone, moveStep } from './world';

/**
 * 权威端：
 * - 维护严格输入顺序 expectedSeq，按序应用、每个序号最多应用一次；
 * - 重复送达（seq < expected）或乱序（seq > expected 先到）都不会导致多走一步；
 *   乱序输入先缓存，等缺序号补齐后按序消费；
 * - 周期性发送带 lastProcessedSeq 的快照。
 */
export class AuthorityServer {
  epoch: number;
  tick = 0;
  pos: Vec2;
  private expectedSeq = 1;
  private buffer = new Map<number, Input>();
  appliedInputs = 0;
  duplicateRejected = 0;
  staleEpochRejected = 0;
  snapshotsSent = 0;
  /** 权威推挤区开关：开启后权威端位置会偏离客户端预测，用于制造真实纠正 */
  pushZoneEnabled = true;

  constructor(
    private world: WorldDef,
    epoch: number,
  ) {
    this.epoch = epoch;
    this.pos = { ...world.spawn };
  }

  reset(epoch: number): void {
    this.epoch = epoch;
    this.tick = 0;
    this.pos = { ...this.world.spawn };
    this.expectedSeq = 1;
    this.buffer.clear();
    this.appliedInputs = 0;
    this.duplicateRejected = 0;
    this.staleEpochRejected = 0;
    this.snapshotsSent = 0;
    // pushZoneEnabled 由 Harness 在 reset 后按当前设置重新下发
  }

  get lastProcessedSeq(): number {
    return this.expectedSeq - 1;
  }

  /** 接收一个输入包（可能是重传的重复包，也可能乱序先到） */
  receive(input: Input): 'applied-later' | 'duplicate' | 'stale-epoch' | 'buffered' {
    if (input.epoch !== this.epoch) {
      this.staleEpochRejected++;
      return 'stale-epoch';
    }
    if (input.seq < this.expectedSeq) {
      // 重复送达：已应用过，直接拒绝，绝不移动
      this.duplicateRejected++;
      return 'duplicate';
    }
    if (!this.buffer.has(input.seq)) this.buffer.set(input.seq, input);
    return input.seq === this.expectedSeq ? 'applied-later' : 'buffered';
  }

  /**
   * 推进一个权威 tick：按序号从 expectedSeq 起顺序消费，
   * 每 tick 最多消费 SERVER_MAX_INPUTS_PER_TICK 个（追赶保护），
   * 缺序号时停下等待，绝不会跳过任何输入。
   */
  advance(sendSnapshot: (snap: SnapshotPayload) => void): void {
    let consumed = 0;
    while (consumed < SERVER_MAX_INPUTS_PER_TICK) {
      const input = this.buffer.get(this.expectedSeq);
      if (!input) break; // 序号空洞：等待重传/迟到包
      this.pos = moveStep(this.world, this.pos, input.keys);
      this.buffer.delete(this.expectedSeq);
      this.expectedSeq++;
      this.appliedInputs++;
      consumed++;
    }
    // 权威端独有外力（客户端不模拟），无输入的 tick 同样生效——这正是预测误差的来源
    if (this.pushZoneEnabled) {
      this.pos = applyPushZone(this.world, this.pos);
    }
    this.tick++;
    if (this.tick % SNAPSHOT_EVERY_TICKS === 0) {
      sendSnapshot({
        kind: 'snapshot',
        epoch: this.epoch,
        serverTick: this.tick,
        lastProcessedSeq: this.lastProcessedSeq,
        pos: { ...this.pos },
      });
      this.snapshotsSent++;
    }
  }

  bufferedCount(): number {
    return this.buffer.size;
  }
}
