/**
 * 网格生成 WebWorker:
 * 收到请求后按 delayMs 模拟慢任务,再执行纯函数网格构建并回传。
 * Worker 不做取消判断(已发出的任务无法真正中断),过期识别全部由主线程
 * 基于 requestId / terrainEpoch 完成,逻辑可在 Node 测试中直接验证。
 */
import { buildChunkMesh } from '../terrain/chunkMesher';
import type { WorkerRequest, WorkerResponse } from '../terrain/protocol';

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'build') return;

  const run = () => {
    const mesh = buildChunkMesh(req.cx, req.cz, req.lod, req.seed);
    const res: WorkerResponse = {
      type: 'build-result',
      requestId: req.requestId,
      terrainEpoch: req.terrainEpoch,
      cx: req.cx,
      cz: req.cz,
      lod: req.lod,
      seed: req.seed,
      mesh,
    };
    self.postMessage(res);
  };

  if (req.delayMs > 0) {
    // 慢任务:延迟期间主线程可能已经发出新请求,本结果回来后会被判定为过期
    setTimeout(run, req.delayMs);
  } else {
    run();
  }
};
