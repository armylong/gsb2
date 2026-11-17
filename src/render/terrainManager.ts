/**
 * 地形管理器:串联任务系统、Worker 池与 three.js 块视图。
 *
 * - 每帧根据相机位置更新各块期望 LOD(带迟滞),需要时经任务系统登记并投递 Worker;
 * - Worker 回来的结果先过任务系统的过期判定,只有最新请求才能替换旧网格;
 * - 等待期间保留有效旧网格,界面通过 stats / chunk 状态反映真实情况;
 * - 换种子、换阈值、改显示模式时释放旧几何,资源不累积。
 */
import * as THREE from 'three';
import {
  CHUNK_COUNT,
  chunkKey,
  DEFAULT_FAR,
  DEFAULT_HYSTERESIS,
  DEFAULT_NEAR,
  LOD_COUNT,
} from '../terrain/config';
import type { ChunkMeshData } from '../terrain/chunkMesher';
import { chunkCenterDistance, selectLod, type LodRanges } from '../terrain/lodSelector';
import { TerrainTaskSystem, type TaskStats } from '../terrain/taskSystem';
import type { WorkerResponse } from '../terrain/protocol';
import { ChunkView, type DisplayMode } from './chunkView';
import { WorkerPool } from './workerPool';

export interface ChunkDisplayInfo {
  cx: number;
  cz: number;
  desiredLod: number | null;
  currentLod: number | null;
  inFlight: boolean;
}

export class TerrainManager {
  readonly group = new THREE.Group();
  readonly taskSystem: TerrainTaskSystem;
  ranges: LodRanges = { near: DEFAULT_NEAR, far: DEFAULT_FAR, hysteresis: DEFAULT_HYSTERESIS };
  private displayMode: DisplayMode = 'fill';

  private readonly views = new Map<string, ChunkView>();
  private pool: WorkerPool;
  private fillMat: THREE.MeshStandardMaterial;
  private wireMaterial: THREE.LineBasicMaterial;

  constructor(seed: number, workerCount = 3) {
    this.taskSystem = new TerrainTaskSystem(seed, CHUNK_COUNT, CHUNK_COUNT);

    this.fillMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: false,
      roughness: 0.95,
      metalness: 0,
      side: THREE.FrontSide,
    });
    this.wireMaterial = new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.35 });

    for (let cx = 0; cx < CHUNK_COUNT; cx++) {
      for (let cz = 0; cz < CHUNK_COUNT; cz++) {
        const view = new ChunkView(this.fillMat, this.wireMaterial);
        this.views.set(chunkKey(cx, cz), view);
        this.group.add(view.group);
      }
    }

    this.pool = new WorkerPool(
      workerCount,
      () => new Worker(new URL('../workers/terrainWorker.ts', import.meta.url), { type: 'module' }),
      {
        onResponse: (r) => this.handleWorkerResponse(r),
        isLive: (id) => this.taskSystem.isRequestLive(id),
        cancelQueued: (id) => this.taskSystem.cancelQueued(id),
      },
    );
  }

  get stats(): TaskStats {
    return this.taskSystem.stats;
  }

  get fillMaterial(): THREE.MeshStandardMaterial {
    return this.fillMat;
  }

  get queuedCount(): number {
    return this.pool.queuedCount;
  }

  get workerBusyCount(): number {
    return this.pool.busyCount;
  }

  setDelay(ms: number): void {
    this.taskSystem.setDelay(ms);
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    for (const v of this.views.values()) v.applyMode(mode);
  }

  getDisplayMode(): DisplayMode {
    return this.displayMode;
  }

  /** 每帧调用:按相机位置刷新期望层级并投递必要的构建任务 */
  update(cameraX: number, cameraZ: number): void {
    for (let cx = 0; cx < CHUNK_COUNT; cx++) {
      for (let cz = 0; cz < CHUNK_COUNT; cz++) {
        const state = this.taskSystem.getChunk(cx, cz);
        const dist = chunkCenterDistance(cx, cz, 40, cameraX, cameraZ);
        const desired = selectLod(dist, this.ranges, state.currentLod);
        this.requestChunkNow(cx, cz, desired);
      }
    }
  }

  /** 表达某块的期望层级并把新请求实际投递到 Worker 池(测试/调试可直接调用) */
  requestChunkNow(cx: number, cz: number, desiredLod: number): void {
    const descriptor = this.taskSystem.requestChunk(cx, cz, desiredLod);
    if (descriptor) this.pool.enqueue(descriptor);
  }

  private handleWorkerResponse(resp: WorkerResponse): void {
    if (resp.type !== 'build-result') return;
    const applied = this.taskSystem.handleResult<ChunkMeshData>({
      requestId: resp.requestId,
      terrainEpoch: resp.terrainEpoch,
      cx: resp.cx,
      cz: resp.cz,
      lod: resp.lod,
      payload: resp.mesh,
    });
    if (!applied) {
      // 迟到的旧层级 / 旧地形结果:直接丢弃,不触碰当前网格
      return;
    }
    const view = this.views.get(chunkKey(resp.cx, resp.cz));
    if (view) {
      view.setMesh(applied.payload);
      view.applyMode(this.displayMode);
    }
  }

  /** 换种子重建:旧代数在途结果回来后会被任务系统判过期 */
  rebuild(seed: number): void {
    this.taskSystem.rebuild(seed);
    // 旧几何立即释放,避免视觉上残留旧地形
    for (const view of this.views.values()) view.disposeGeometry();
  }

  chunkDisplayInfo(): ChunkDisplayInfo[] {
    return this.taskSystem.chunkStates().map((s) => {
      const view = this.views.get(chunkKey(s.cx, s.cz))!;
      return {
        cx: s.cx,
        cz: s.cz,
        desiredLod: s.desiredLod,
        currentLod: view.hasGeometry ? s.currentLod : null,
        inFlight: s.inFlightRequestId !== null,
      };
    });
  }

  /** 当前各块实际渲染层级直方图,用于 HUD */
  lodHistogram(): number[] {
    const hist = new Array<number>(LOD_COUNT).fill(0);
    for (const info of this.chunkDisplayInfo()) {
      if (info.currentLod !== null) hist[info.currentLod] += 1;
    }
    return hist;
  }

  isConverged(): boolean {
    return this.taskSystem.isConverged();
  }

  dispose(): void {
    this.pool.dispose();
    for (const view of this.views.values()) view.disposeGeometry();
    this.fillMat.dispose();
    this.wireMaterial.dispose();
  }
}
