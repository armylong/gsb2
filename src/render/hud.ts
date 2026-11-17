/**
 * HUD:展示当前块数、各层级块数、在途/排队任务数、累计请求/应用/过期/取代
 * 以及是否收敛。所有数字直接来自任务系统的真实统计。
 */
import type { TerrainManager } from './terrainManager';

export class Hud {
  private el: HTMLElement;
  constructor(el: HTMLElement, private readonly terrain: TerrainManager) {
    this.el = el;
  }

  render(): void {
    const t = this.terrain;
    const s = t.stats;
    const hist = t.lodHistogram();
    const infos = t.chunkDisplayInfo();
    const waiting = infos.filter((i) => i.inFlight).length;
    const converged = t.isConverged();
    this.el.innerHTML = `
      <div class="hud-row"><span>总块数</span><b>${infos.length}</b></div>
      <div class="hud-row"><span>LOD0(细) / LOD1 / LOD2(粗)</span><b>${hist[0]} / ${hist[1]} / ${hist[2]}</b></div>
      <div class="hud-row"><span>待处理(在途任务)</span><b>${s.pending}</b></div>
      <div class="hud-row"><span>Worker 忙碌 / 本地队列</span><b>${t.workerBusyCount} / ${t.queuedCount}</b></div>
      <div class="hud-row"><span>等待换网格的块</span><b>${waiting}</b></div>
      <div class="hud-row"><span>累计请求 / 已应用</span><b>${s.totalRequested} / ${s.totalApplied}</b></div>
      <div class="hud-row"><span>过期丢弃 / 被取代</span><b>${s.totalStale} / ${s.totalSuperseded}</b></div>
      <div class="hud-row"><span>地形代数(种子代数)</span><b>${s.terrainEpoch}</b></div>
      <div class="hud-row convergence ${converged ? 'ok' : 'busy'}">
        <span>收敛状态</span><b>${converged ? '已收敛:全部块=当前视野所需层级' : '未收敛:仍有任务在途'}</b>
      </div>`;
  }
}
