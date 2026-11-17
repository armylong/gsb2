/**
 * 固定大小的 Worker 池 + 本地 FIFO 队列。
 * 出队时检查请求是否仍有效;失效请求直接在本地丢弃,不占用 Worker,
 * 这样快速往返移动产生的无用任务不会持续堆积。
 */
import type { WorkerRequest, WorkerResponse } from '../terrain/protocol';
import type { RequestDescriptor } from '../terrain/taskSystem';

export class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly free: Worker[] = [];
  private readonly queue: Array<{ req: WorkerRequest; descriptor: RequestDescriptor }> = [];
  private readonly liveness: (requestId: number) => boolean;
  private readonly onCancelQueued: (requestId: number) => void;

  constructor(
    size: number,
    workerFactory: () => Worker,
    handlers: {
      onResponse: (resp: WorkerResponse) => void;
      isLive: (requestId: number) => boolean;
      cancelQueued: (requestId: number) => void;
    },
  ) {
    this.liveness = handlers.isLive;
    this.onCancelQueued = handlers.cancelQueued;
    for (let i = 0; i < size; i++) {
      const w = workerFactory();
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        handlers.onResponse(ev.data);
        this.release(w);
      };
      this.workers.push(w);
      this.free.push(w);
    }
  }

  enqueue(descriptor: RequestDescriptor): void {
    const req: WorkerRequest = {
      type: 'build',
      requestId: descriptor.requestId,
      terrainEpoch: descriptor.terrainEpoch,
      cx: descriptor.cx,
      cz: descriptor.cz,
      lod: descriptor.lod,
      seed: descriptor.seed,
      delayMs: descriptor.delayMs,
    };
    this.queue.push({ req, descriptor });
    this.pump();
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get busyCount(): number {
    return this.workers.length - this.free.length;
  }

  private pump(): void {
    while (this.free.length > 0 && this.queue.length > 0) {
      // 从队首剔除已失效的请求
      let next = this.queue.shift();
      while (next && !this.liveness(next.descriptor.requestId)) {
        this.onCancelQueued(next.descriptor.requestId);
        next = this.queue.shift();
      }
      if (!next) return;
      const w = this.free.pop();
      if (!w) return;
      w.postMessage(next.req);
    }
  }

  private release(w: Worker): void {
    this.free.push(w);
    this.pump();
  }

  dispose(): void {
    this.queue.length = 0;
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.free.length = 0;
  }
}
