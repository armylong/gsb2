import { SceneId } from '../core/bindings';
import { MENU_ITEMS, ARENA_W, ARENA_H } from '../core/sim';
import { World } from '../core/world';

export function drawScene(ctx: CanvasRenderingContext2D, world: World) {
  const s = world.sim.state;
  ctx.clearRect(0, 0, ARENA_W, ARENA_H);

  // 场景标签
  ctx.fillStyle = '#8a90a0';
  ctx.font = '12px sans-serif';
  ctx.fillText(world.playback ? '回放中（真实按键已屏蔽）' : s.scene === 'game' ? '游戏场景' : '菜单场景', 10, 18);

  if (world.isRecording) {
    ctx.fillStyle = '#ef6a6a';
    ctx.beginPath();
    ctx.arc(ARENA_W - 20, 14, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ef6a6a';
    ctx.fillText('REC', ARENA_W - 52, 18);
  }

  if (s.scene === 'menu') {
    drawMenu(ctx, world);
  } else {
    drawGame(ctx, world);
  }

  // 回放进度
  const pb = world.playback;
  if (pb) {
    const p = Math.min(1, s.tick / pb.rec.durationTicks);
    ctx.fillStyle = '#2b3242';
    ctx.fillRect(0, ARENA_H - 6, ARENA_W, 6);
    ctx.fillStyle = pb.done ? (pb.result?.match ? '#6fd08c' : '#ef6a6a') : '#2f5fb3';
    ctx.fillRect(0, ARENA_H - 6, ARENA_W * p, 6);
  }
}

function drawGame(ctx: CanvasRenderingContext2D, world: World) {
  const s = world.sim.state;
  // 冲刺残影
  if (s.dashTicks > 0) {
    ctx.strokeStyle = 'rgba(111, 168, 255, 0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - s.dashDX * 40, s.y - s.dashDY * 40);
    ctx.stroke();
  }
  // 角色
  ctx.fillStyle = s.paused ? '#5a6070' : '#6fa8ff';
  ctx.beginPath();
  ctx.arc(s.x, s.y, 10, 0, Math.PI * 2);
  ctx.fill();
  // 朝向指示
  ctx.strokeStyle = '#dde1e8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(s.x + s.dirX * 16, s.y + s.dirY * 16);
  ctx.stroke();

  ctx.fillStyle = '#8a90a0';
  ctx.font = '12px sans-serif';
  ctx.fillText(`位置 (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`, 10, ARENA_H - 40);
  ctx.fillText(`交互次数 ${s.interactCount}`, 10, ARENA_H - 24);

  if (s.paused) {
    ctx.fillStyle = 'rgba(10, 12, 18, 0.6)';
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
    ctx.fillStyle = '#dde1e8';
    ctx.font = '24px sans-serif';
    ctx.fillText('已暂停', ARENA_W / 2 - 36, ARENA_H / 2);
  }
}

function drawMenu(ctx: CanvasRenderingContext2D, world: World) {
  const s = world.sim.state;
  ctx.fillStyle = '#dde1e8';
  ctx.font = '16px sans-serif';
  ctx.fillText('主菜单', 40, 70);
  MENU_ITEMS.forEach((item, i) => {
    const y = 110 + i * 36;
    if (i === s.menuIndex) {
      ctx.fillStyle = '#2f5fb3';
      ctx.fillRect(30, y - 20, 200, 28);
    }
    ctx.fillStyle = i === s.menuIndex ? '#ffffff' : '#9aa2b5';
    ctx.fillText(item, 44, y);
  });
  ctx.fillStyle = '#8a90a0';
  ctx.font = '12px sans-serif';
  ctx.fillText(`确认次数 ${s.confirmCount}`, 10, ARENA_H - 24);
}
