/**
 * 主线程 <-> WebWorker 通信协议。
 * 每条请求带 requestId;主线程通过 terrainEpoch 区分地形代数(换种子/重建),
 * Worker 原样回传,过期代数的结果在主线程被丢弃。
 */
import type { ChunkMeshData } from './chunkMesher';

export interface BuildRequest {
  type: 'build';
  requestId: number;
  terrainEpoch: number;
  cx: number;
  cz: number;
  lod: number;
  seed: number;
  /** 人为延迟(ms),用于复现慢任务场景 */
  delayMs: number;
}

export type WorkerRequest = BuildRequest;

export interface BuildResponse {
  type: 'build-result';
  requestId: number;
  terrainEpoch: number;
  cx: number;
  cz: number;
  lod: number;
  seed: number;
  mesh: ChunkMeshData;
}

export type WorkerResponse = BuildResponse;
