import { EDGE_NEIGHBOURS, hexCornersAt, hexCentre, hexVertex, inMap } from './hex';
import { worldToScreen, type Camera } from './camera';
import { computeLineOfSight } from './vision';
import type { Sandbox } from './sandbox';
import type { CellKey, ExplorerState, Vec2 } from './types';

export interface RenderOverlay {
  hovered: { q: number; r: number } | null;
  pendingEdits: Set<CellKey>;
  selectedEnemyId: number | null;
}

/**
 * Palette. The three vision states are deliberately far apart in both hue and
 * luminance so they read at a glance, and the map stays legible at low zoom.
 */
const PALETTE = {
  backdropTop: '#0a0f16',
  backdropBottom: '#05080c',
  unexplored: '#0b1017',
  exploredFloor: '#151d26',
  exploredWall: '#39424c',
  exploredWallTop: '#444e58',
  visibleFloor: '#31503c',
  visibleWall: '#8d7a55',
  visibleWallTop: '#c2ab7c',
  doorClosed: '#b4633f',
  doorClosedDark: '#7c422a',
  doorOpen: '#3f9b7c',
  doorOpenDark: '#256452',
  unitA: '#5cc8ff',
  unitB: '#c2a8ff',
  unitAOverlay: 'rgba(92,200,255,0.055)',
  unitBOverlay: 'rgba(194,168,255,0.055)',
  enemy: '#ff5f6d',
  selected: '#ffd36b',
  hover: 'rgba(255,255,255,0.92)',
  reachable: 'rgba(255,211,107,0.62)',
  hatch: 'rgba(150,180,210,0.09)',
  border: 'rgba(160,190,220,0.22)',
  gridUnexplored: 'rgba(255,255,255,0.028)',
  gridExplored: 'rgba(255,255,255,0.075)',
  gridVisible: 'rgba(255,255,255,0.15)',
  textMuted: '#9fb3c8',
};

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  /**
   * World-space silhouettes per (cell, scale). Panning and zooming only change
   * the camera transform, so the geometry itself is computed once per cell.
   */
  private worldCorners = new Map<string, Vec2[]>();

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not available');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  render(sandbox: Sandbox, camera: Camera, overlay: RenderOverlay): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintBackdrop(camera);

    const stateOf = (q: number, r: number): ExplorerState => {
      if (sandbox.vision.isVisible(q, r)) return 'visible';
      if (sandbox.vision.isExplored(q, r)) return 'explored';
      return 'unexplored';
    };

    // 1. Cell bodies and terrain. Explored cells draw the terrain as it was
    //    last seen, so edits made outside vision do not leak through memory.
    for (const cell of sandbox.map.all()) {
      const state = stateOf(cell.q, cell.r);
      const corners = this.screenCorners(camera, cell.q, cell.r, 1);
      if (state === 'unexplored') {
        this.fillPolygon(corners, PALETTE.unexplored);
        this.strokePolygon(corners, PALETTE.gridUnexplored, 1);
        continue;
      }
      this.fillPolygon(corners, state === 'visible' ? PALETTE.visibleFloor : PALETTE.exploredFloor);
      if (state === 'explored') this.drawHatch(corners);
      if (state === 'visible') {
        this.drawTerrain(cell.terrain, cell.doorOpen, cell.q, cell.r, state, camera);
      } else {
        const remembered = sandbox.vision.remembered(cell.q, cell.r);
        if (remembered) {
          this.drawTerrain(remembered.terrain, remembered.doorOpen, cell.q, cell.r, state, camera);
        }
      }
      this.strokePolygon(corners, state === 'visible' ? PALETTE.gridVisible : PALETTE.gridExplored, 1);
    }

    // 2. Faint per-scout wash so the shared-vision frontier is visible.
    for (const unit of sandbox.units) {
      const tint = unit.id === 'A' ? PALETTE.unitAOverlay : PALETTE.unitBOverlay;
      for (const cell of sandbox.map.all()) {
        if (!sandbox.vision.visibleBy(unit.id, cell.q, cell.r)) continue;
        this.fillPolygon(this.screenCorners(camera, cell.q, cell.r, 1), tint);
      }
    }

    // 3. Pending edits: dashed amber outline means "not yet in the vision model".
    for (const key of overlay.pendingEdits) {
      const [q, r] = key.split(',').map(Number) as [number, number];
      this.strokePolygon(this.screenCorners(camera, q, r, 0.88), PALETTE.selected, 2, [4, 3]);
    }

    // 4. Debug-only helpers (never drawn in player view).
    if (sandbox.mode === 'debug' && overlay.hovered) {
      this.drawDebugHelpers(sandbox, camera, overlay.hovered);
    }

    // 5. Reachable-step affordances for the selected scout.
    const selected = sandbox.selected();
    if (selected && sandbox.mode !== 'debug') {
      for (const dir of [
        { q: 1, r: 0 },
        { q: 1, r: -1 },
        { q: 0, r: -1 },
        { q: -1, r: 0 },
        { q: -1, r: 1 },
        { q: 0, r: 1 },
      ]) {
        const q = selected.q + dir.q;
        const r = selected.r + dir.r;
        if (!sandbox.map.isWalkable(q, r)) continue;
        this.strokePolygon(this.screenCorners(camera, q, r, 0.86), PALETTE.reachable, 1.5, [5, 4]);
      }
    }

    // 6. Enemies: player/edit see only currently visible markers.
    for (const enemy of sandbox.enemies) {
      const visible = sandbox.vision.isVisible(enemy.q, enemy.r);
      if (!visible && sandbox.mode !== 'debug') continue;
      const centre = worldToScreen(camera, hexCentre(enemy.q, enemy.r).x, hexCentre(enemy.q, enemy.r).y);
      this.drawEnemy(centre, camera.zoom, !visible, enemy.id, overlay.selectedEnemyId === enemy.id);
    }

    // 7. Units.
    for (const unit of sandbox.units) {
      const centre = worldToScreen(camera, hexCentre(unit.q, unit.r).x, hexCentre(unit.q, unit.r).y);
      const colour = unit.id === 'A' ? PALETTE.unitA : PALETTE.unitB;
      this.drawUnit(centre, camera.zoom, colour, unit.id, unit.radius, sandbox.selectedUnit === unit.id);
    }

    // 8. Hover outline last.
    if (overlay.hovered) {
      this.strokePolygon(
        this.screenCorners(camera, overlay.hovered.q, overlay.hovered.r, 0.94),
        PALETTE.hover,
        2,
      );
    }

    this.drawMapBorder(sandbox, camera);
    this.drawScaleBadge(camera);
  }

  private paintBackdrop(camera: Camera): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, camera.viewport.width, camera.viewport.height);
    const gradient = ctx.createRadialGradient(
      camera.viewport.width * 0.5,
      camera.viewport.height * 0.42,
      80,
      camera.viewport.width * 0.5,
      camera.viewport.height * 0.5,
      Math.max(camera.viewport.width, camera.viewport.height) * 0.8,
    );
    gradient.addColorStop(0, PALETTE.backdropTop);
    gradient.addColorStop(1, PALETTE.backdropBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, camera.viewport.width, camera.viewport.height);
  }

  private drawTerrain(
    terrain: 'floor' | 'wall' | 'door',
    doorOpen: boolean | undefined,
    q: number,
    r: number,
    state: ExplorerState,
    camera: Camera,
  ): void {
    const ctx = this.ctx;
    if (terrain === 'floor') {
      if (state === 'visible') {
        const c = worldToScreen(camera, hexCentre(q, r).x, hexCentre(q, r).y);
        ctx.fillStyle = 'rgba(220,255,220,0.045)';
        ctx.beginPath();
        ctx.arc(c.x, c.y, Math.max(1, camera.zoom * 0.05), 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    if (terrain === 'wall') {
      const visible = state === 'visible';
      const lift = Math.max(2, camera.zoom * (visible ? 0.18 : 0.11));
      const top = this.screenCorners(camera, q, r, visible ? 0.86 : 0.82);
      // Extruded side: shift the lower half down, then draw the top cap over it.
      const lower = top.map((p) => ({ x: p.x, y: p.y + lift }));
      this.fillPolygon(
        [top[2]!, top[3]!, top[4]!, lower[4]!, lower[3]!, lower[2]!],
        visible ? '#6b5c3e' : '#272e36',
      );
      this.fillPolygon(
        [top[0]!, top[1]!, top[2]!, lower[2]!, lower[1]!, lower[0]!],
        visible ? '#5b4e35' : '#222930',
      );
      this.fillPolygon(top, visible ? PALETTE.visibleWallTop : PALETTE.exploredWallTop);
      this.strokePolygon(top, visible ? 'rgba(255,240,205,0.35)' : 'rgba(255,255,255,0.05)', 1);
      return;
    }

    // Door.
    const open = doorOpen === true;
    const body = open ? PALETTE.doorOpenDark : PALETTE.doorClosedDark;
    const accent = open ? PALETTE.doorOpen : PALETTE.doorClosed;
    this.fillPolygon(this.screenCorners(camera, q, r, 0.74), body);
    const centre = worldToScreen(camera, hexCentre(q, r).x, hexCentre(q, r).y);
    const size = Math.max(3, camera.zoom * 0.2);
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = Math.max(2, camera.zoom * 0.1);
    ctx.lineCap = 'round';
    if (open) {
      ctx.beginPath();
      ctx.moveTo(centre.x - size * 1.7, centre.y + size * 0.9);
      ctx.lineTo(centre.x - size * 0.7, centre.y - size * 0.7);
      ctx.moveTo(centre.x + size * 1.7, centre.y + size * 0.9);
      ctx.lineTo(centre.x + size * 0.7, centre.y - size * 0.7);
      ctx.stroke();
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, size * 1.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(centre.x - size * 1.25, centre.y);
      ctx.lineTo(centre.x + size * 1.25, centre.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, size * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawHatch(corners: Vec2[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(corners[0]!.x, corners[0]!.y);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = PALETTE.hatch;
    ctx.lineWidth = 1;
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const minX = Math.min(...xs) - 20;
    const maxX = Math.max(...xs) + 20;
    const minY = Math.min(...ys) - 20;
    const maxY = Math.max(...ys) + 20;
    const step = 8;
    ctx.beginPath();
    for (let x = minX; x < maxX + (maxY - minY); x += step) {
      ctx.moveTo(x, minY);
      ctx.lineTo(x - (maxY - minY), maxY);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawDebugHelpers(sandbox: Sandbox, camera: Camera, hovered: { q: number; r: number }): void {
    const ctx = this.ctx;
    const target = worldToScreen(camera, hexCentre(hovered.q, hovered.r).x, hexCentre(hovered.q, hovered.r).y);
    for (const unit of sandbox.units) {
      const origin = worldToScreen(camera, hexCentre(unit.q, unit.r).x, hexCentre(unit.q, unit.r).y);
      const los = computeLineOfSight(sandbox.map, { q: unit.q, r: unit.r }, hovered);
      const colour = unit.id === 'A' ? PALETTE.unitA : PALETTE.unitB;
      ctx.save();
      ctx.setLineDash(los.visible ? [7, 4] : [6, 5]);
      ctx.strokeStyle = los.visible ? colour : 'rgba(255,110,120,0.8)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      if (los.blocker) {
        const b = worldToScreen(
          camera,
          hexCentre(los.blocker.q, los.blocker.r).x,
          hexCentre(los.blocker.q, los.blocker.r).y,
        );
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(b.x, b.y, Math.max(3.5, camera.zoom * 0.1), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,110,120,0.92)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawEnemy(centre: Vec2, zoom: number, ghost: boolean, id: number, selected: boolean): void {
    const ctx = this.ctx;
    const size = Math.max(6, zoom * 0.25);
    ctx.save();
    ctx.globalAlpha = ghost ? 0.5 : 1;
    if (!ghost) {
      ctx.shadowColor = 'rgba(255,60,80,0.5)';
      ctx.shadowBlur = 8;
    }
    ctx.fillStyle = PALETTE.enemy;
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y - size);
    ctx.lineTo(centre.x + size, centre.y);
    ctx.lineTo(centre.x, centre.y + size);
    ctx.lineTo(centre.x - size, centre.y);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = selected ? PALETTE.selected : 'rgba(0,0,0,0.5)';
    ctx.lineWidth = selected ? 2.5 : 1;
    ctx.stroke();
    ctx.fillStyle = '#210709';
    ctx.font = `700 ${Math.max(9, zoom * 0.22)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(id), centre.x, centre.y + 0.5);
    ctx.restore();
  }

  private drawUnit(
    centre: Vec2,
    zoom: number,
    colour: string,
    id: string,
    radius: number,
    selected: boolean,
  ): void {
    const ctx = this.ctx;
    const size = Math.max(7, zoom * 0.3);
    ctx.save();
    ctx.strokeStyle = `${colour}3d`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, zoom * radius * 0.98, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.shadowColor = selected ? 'rgba(255,211,107,0.75)' : 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = selected ? 14 : 6;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, size, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.strokeStyle = selected ? PALETTE.selected : 'rgba(5,10,16,0.75)';
    ctx.stroke();
    ctx.fillStyle = '#06111a';
    ctx.font = `800 ${Math.max(10, zoom * 0.3)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(id, centre.x, centre.y + 0.5);
    ctx.restore();
  }

  private drawMapBorder(sandbox: Sandbox, camera: Camera): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(120,180,230,0.25)';
    ctx.shadowBlur = 10;
    for (const cell of sandbox.map.all()) {
      for (let i = 0; i < 6; i++) {
        const dir = EDGE_NEIGHBOURS[i]!;
        if (inMap(cell.q + dir.q, cell.r + dir.r)) continue;
        const a = worldToScreen(camera, hexVertex(cell.q, cell.r, i).x, hexVertex(cell.q, cell.r, i).y);
        const b = worldToScreen(camera, hexVertex(cell.q, cell.r, i + 1).x, hexVertex(cell.q, cell.r, i + 1).y);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawScaleBadge(camera: Camera): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(8,12,18,0.78)';
    ctx.strokeStyle = 'rgba(120,160,200,0.18)';
    ctx.lineWidth = 1;
    const label = `缩放 ${(camera.zoom / 28).toFixed(1)}×`;
    ctx.font = '11.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    const width = ctx.measureText(label).width + 18;
    const x = 14;
    const y = camera.viewport.height - 40;
    roundRect(ctx, x, y, width, 24, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = PALETTE.textMuted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 9, y + 12.5);
    ctx.restore();
  }

  private screenCorners(camera: Camera, q: number, r: number, size: number): Vec2[] {
    const key = `${q},${r},${size}`;
    let world = this.worldCorners.get(key);
    if (!world) {
      world = hexCornersAt(q, r, size);
      this.worldCorners.set(key, world);
    }
    return world.map((p) => worldToScreen(camera, p.x, p.y));
  }

  private fillPolygon(points: Vec2[], colour: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
  }

  private strokePolygon(points: Vec2[], colour: string, width: number, dash: number[] = []): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
    ctx.closePath();
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

export { PALETTE };
