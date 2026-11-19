import { useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { Character, Command, RoundState, Step } from '../game/types'
import { C, factionColor, hpColor, sigilSeed } from './theme'

export interface CanvasHit {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasProps {
  state: RoundState
  /** 当前预览/回放高亮的一步; 用于在角色卡上叠加变化箭头 */
  step: Step | null
  /** 下一次行动的角色的 id (实时场景用) */
  nextActorId: string | null
  plan: Record<string, Command | null>
  selectedActorId: string | null
  /** 预览模式下每个行动者的预期结果, 用来在卡片上打角标 */
  outcomeByActor: Map<string, Step>
  /** 每个角色预计/已承受的伤害 (来自其他角色的行动) */
  impactByTarget: Map<string, { hp: number; shield: number }>
  onSelect: (id: string) => void
  width: number
  height: number
  /** 回放旧记录时压暗 */
  dimmed?: boolean
}

const CARD_W = 168
const CARD_H = 188
const GAP_X = 16

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** 程序化头像: 圆 + 由 id 确定的对称符文, 无外部素材 */
function drawSigil(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  seed: number,
  color: string,
  alive: boolean,
): void {
  ctx.save()
  ctx.globalAlpha = alive ? 1 : 0.35
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.5

  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.globalAlpha = alive ? 0.16 : 0.08
  ctx.fill()
  ctx.globalAlpha = alive ? 0.9 : 0.3
  ctx.stroke()

  // 三到五条对称折线, 由 id 哈希决定
  const arms = 3 + (seed % 3)
  const rings = 1 + ((seed >> 3) % 2)
  for (let ring = 0; ring < rings; ring++) {
    const rr = r * (0.38 + ring * 0.28)
    const phase = ((seed >> (4 + ring * 3)) % 16) / 16
    ctx.beginPath()
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2
      const wobble = 0.22 + (((seed >> 7) % 7) / 20)
      const rad = rr * (1 + Math.sin(t * arms + phase * Math.PI * 2) * wobble)
      const x = cx + Math.cos(t) * rad
      const y = cy + Math.sin(t) * rad
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.globalAlpha = alive ? 0.55 : 0.2
    ctx.stroke()
  }

  // 中心刻点
  ctx.globalAlpha = alive ? 0.95 : 0.3
  ctx.beginPath()
  ctx.arc(cx, cy, 2.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  ratio: number,
  color: string,
  track: string,
): void {
  ctx.fillStyle = track
  roundRect(ctx, x, y, w, h, h / 2)
  ctx.fill()
  const clamped = Math.max(0, Math.min(1, ratio))
  if (clamped > 0) {
    ctx.fillStyle = color
    roundRect(ctx, x, y, Math.max(h, w * clamped), h, h / 2)
    ctx.fill()
  }
}

function drawPips(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  total: number,
  filled: number,
  color: string,
  grid: string,
): void {
  const size = 7
  const gap = 3
  for (let i = 0; i < total; i++) {
    const px = x + i * (size + gap)
    ctx.fillStyle = i < filled ? color : grid
    roundRect(ctx, px, y, size, size, 2)
    ctx.fill()
  }
}

function drawCharacterCard(
  ctx: CanvasRenderingContext2D,
  character: Character,
  x: number,
  y: number,
  opts: {
    selected: boolean
    isNext: boolean
    outcome: Step | null
    impact: { hp: number; shield: number } | null
    step: Step | null
    dimmed: boolean
  },
): void {
  const alive = character.hp > 0
  const accent = factionColor(character.side)
  const { selected, isNext, outcome, impact, step, dimmed } = opts

  ctx.save()
  ctx.globalAlpha = dimmed ? 0.55 : 1

  // 卡体
  ctx.fillStyle = C.surfaceRaised
  roundRect(ctx, x, y, CARD_W, CARD_H, 10)
  ctx.fill()
  ctx.lineWidth = selected ? 2 : 1
  ctx.strokeStyle = selected ? C.ink : isNext ? accent : C.hairline
  roundRect(ctx, x, y, CARD_W, CARD_H, 10)
  ctx.stroke()

  // 阵营色条
  ctx.fillStyle = accent
  ctx.globalAlpha = (dimmed ? 0.55 : 1) * (alive ? 1 : 0.4)
  roundRect(ctx, x, y, 4, CARD_H, 2)
  ctx.fill()
  ctx.globalAlpha = dimmed ? 0.55 : 1

  // 头像
  const seed = sigilSeed(character.id)
  drawSigil(ctx, x + 40, y + 40, 22, seed, accent, alive)

  // 名字 / 定位
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = alive ? C.ink : C.muted
  ctx.font = '600 15px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.fillText(character.name, x + 72, y + 32)
  ctx.fillStyle = C.muted
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.fillText(`${character.role} · 速 ${character.speed}`, x + 72, y + 48)

  // HP 数值
  const hpY = y + 74
  ctx.fillStyle = C.ink2
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'left'
  const hpText = alive ? `${character.hp}/${character.maxHp}` : '阵亡'
  ctx.fillText(hpText, x + 12, hpY)
  ctx.textAlign = 'right'
  ctx.fillStyle = C.muted
  ctx.fillText('HP', x + CARD_W - 12, hpY)
  ctx.textAlign = 'left'

  drawBar(ctx, x + 12, hpY + 6, CARD_W - 24, 7, character.hp / character.maxHp, hpColor(character.hp, character.maxHp), C.grid)

  // 护盾
  const shY = hpY + 26
  ctx.fillStyle = C.ink2
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`${character.shield}/${character.maxShield}`, x + 12, shY)
  ctx.textAlign = 'right'
  ctx.fillStyle = C.muted
  ctx.fillText('护盾', x + CARD_W - 12, shY)
  ctx.textAlign = 'left'
  drawBar(
    ctx,
    x + 12,
    shY + 6,
    CARD_W - 24,
    5,
    character.maxShield > 0 ? character.shield / character.maxShield : 0,
    C.shield,
    C.grid,
  )

  // 行动点
  const apY = shY + 26
  ctx.fillStyle = C.ink2
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`${character.ap}/${character.maxAp}`, x + 12, apY)
  ctx.textAlign = 'right'
  ctx.fillStyle = C.muted
  ctx.fillText('AP', x + CARD_W - 12, apY)
  ctx.textAlign = 'left'
  drawPips(ctx, x + 12, apY + 7, character.maxAp, character.ap, C.ap, C.grid)

  // 角标: 该角色自己的行动结果 (不是它承受的伤害)
  if (outcome) {
    const dealt = outcome.hpLost + outcome.shieldAbsorbed
    const absorbed = outcome.outcome === 'damage' ? outcome.shieldAbsorbed : 0
    const label =
      outcome.outcome === 'damage'
        ? absorbed > 0
          ? `打 ${dealt} · 吸 ${absorbed}`
          : `打 ${dealt}`
        : outcome.outcome === 'shield'
          ? outcome.shieldGained > 0
            ? `+${outcome.shieldGained} 盾`
            : '盾已满'
          : outcome.outcome === 'delay'
            ? '推迟'
            : outcome.outcome === 'skip'
              ? '跳过'
              : '待机'
    const tone =
      outcome.outcome === 'damage'
        ? { bg: 'rgba(230,103,103,0.18)', fg: C.attack }
        : outcome.outcome === 'shield'
          ? { bg: 'rgba(57,135,229,0.18)', fg: C.shield }
          : outcome.outcome === 'delay'
            ? { bg: 'rgba(201,133,0,0.18)', fg: C.delay }
            : { bg: 'rgba(137,135,129,0.16)', fg: C.muted }
    ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif'
    const tw = ctx.measureText(label).width + 12
    const bx = x + CARD_W - tw - 10
    const by = y + 10
    ctx.fillStyle = tone.bg
    roundRect(ctx, bx, by, tw, 18, 9)
    ctx.fill()
    ctx.fillStyle = tone.fg
    ctx.fillText(label, bx + 6, by + 12.5)
  }

  // 角标: 该角色预计承受的伤害 (来自别人的行动), 与自己的行动角标区分
  if (impact && (impact.hp > 0 || impact.shield > 0)) {
    const parts: string[] = []
    if (impact.shield > 0) parts.push(`盾 -${impact.shield}`)
    if (impact.hp > 0) parts.push(`HP -${impact.hp}`)
    const label = parts.join('  ')
    ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif'
    const tw = ctx.measureText(label).width + 12
    const bx = x + 10
    const by = y + CARD_H - 28
    ctx.fillStyle = 'rgba(208,59,59,0.2)'
    roundRect(ctx, bx, by, tw, 18, 9)
    ctx.fill()
    ctx.fillStyle = '#f09090'
    ctx.fillText(label, bx + 6, by + 12.5)
  }

  // 正在结算的一步: 在卡上叠一层描边
  if (step && step.actorId === character.id) {
    ctx.strokeStyle = C.ink
    ctx.lineWidth = 2
    ctx.setLineDash([5, 4])
    roundRect(ctx, x - 3, y - 3, CARD_W + 6, CARD_H + 6, 12)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (step && step.targetId === character.id && step.actorId !== character.id) {
    ctx.strokeStyle =
      step.outcome === 'damage' ? C.attack : step.outcome === 'delay' ? C.delay : C.ink2
    ctx.lineWidth = 2
    ctx.setLineDash([2, 4])
    roundRect(ctx, x - 3, y - 3, CARD_W + 6, CARD_H + 6, 12)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // 阵亡遮罩
  if (!alive) {
    ctx.fillStyle = 'rgba(13,13,13,0.55)'
    roundRect(ctx, x, y, CARD_W, CARD_H, 10)
    ctx.fill()
    ctx.strokeStyle = C.hpCrit
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x + 12, y + 12)
    ctx.lineTo(x + CARD_W - 12, y + CARD_H - 12)
    ctx.moveTo(x + CARD_W - 12, y + 12)
    ctx.lineTo(x + 12, y + CARD_H - 12)
    ctx.stroke()
  }

  // 下一个行动标记
  if (isNext && alive) {
    ctx.fillStyle = C.ap
    ctx.beginPath()
    ctx.moveTo(x + CARD_W - 14, y - 8)
    ctx.lineTo(x + CARD_W - 4, y + 2)
    ctx.lineTo(x + CARD_W - 14, y + 12)
    ctx.closePath()
    ctx.fill()
  }

  ctx.restore()
}

function drawTargetLine(
  ctx: CanvasRenderingContext2D,
  from: CanvasHit,
  to: CanvasHit,
  color: string,
  dashed: boolean,
): void {
  const x1 = from.x + from.w / 2
  const y1 = from.y + from.h / 2
  const x2 = to.x + to.w / 2
  const y2 = to.y + to.h / 2
  const dx = x2 - x1
  const dir = Math.sign(dx) || 1
  const sx = x1 + (from.w / 2 + 6) * dir
  const ex = x2 - (to.w / 2 + 6) * dir
  const mid = (sx + ex) / 2

  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.globalAlpha = 0.8
  if (dashed) ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(sx, y1)
  ctx.bezierCurveTo(mid, y1, mid, y2, ex, y2)
  ctx.stroke()
  ctx.setLineDash([])
  // 箭头
  const angle = Math.atan2(y2 - y1, ex - sx)
  ctx.beginPath()
  ctx.moveTo(ex, y2)
  ctx.lineTo(ex - 7 * Math.cos(angle - 0.4), y2 - 7 * Math.sin(angle - 0.4))
  ctx.lineTo(ex - 7 * Math.cos(angle + 0.4), y2 - 7 * Math.sin(angle + 0.4))
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

export function BattleCanvas(props: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hitsRef = useRef<CanvasHit[]>([])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = props.width * dpr
    canvas.height = props.height * dpr
    canvas.style.width = `${props.width}px`
    canvas.style.height = `${props.height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, props.width, props.height)

    const { state, step, plan, selectedActorId, outcomeByActor, impactByTarget, nextActorId, dimmed } = props
    const allies = state.characters.filter((c) => c.side === 'ally').sort((a, b) => a.slot - b.slot)
    const enemies = state.characters.filter((c) => c.side === 'enemy').sort((a, b) => a.slot - b.slot)
    const rows = Math.max(allies.length, enemies.length)
    const totalH = rows * CARD_H + (rows - 1) * GAP_X
    const startY = Math.max(30, (props.height - 140 - totalH) / 2 + 24)

    // 中线与阵营标签
    const midX = props.width / 2
    ctx.save()
    ctx.strokeStyle = C.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(midX, 24)
    ctx.lineTo(midX, props.height - 48)
    ctx.stroke()
    ctx.fillStyle = C.muted
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('我方', 12 + CARD_W + 16, props.height - 24)
    ctx.textAlign = 'center'
    ctx.fillText('敌方', props.width - 12 - CARD_W - 16, props.height - 24)
    ctx.textAlign = 'left'
    ctx.restore()

    const hits: CanvasHit[] = []
    const leftX = 12
    const rightX = props.width - 12 - CARD_W

    allies.forEach((c, i) => {
      const y = startY + i * (CARD_H + GAP_X)
      const outcome = outcomeByActor.get(c.id) ?? null
      drawCharacterCard(ctx, c, leftX, y, {
        selected: selectedActorId === c.id,
        isNext: nextActorId === c.id,
        outcome,
        impact: impactByTarget.get(c.id) ?? null,
        step,
        dimmed: !!dimmed,
      })
      hits.push({ id: c.id, x: leftX, y, w: CARD_W, h: CARD_H })
    })

    enemies.forEach((c, i) => {
      const y = startY + i * (CARD_H + GAP_X)
      const outcome = outcomeByActor.get(c.id) ?? null
      drawCharacterCard(ctx, c, rightX, y, {
        selected: selectedActorId === c.id,
        isNext: nextActorId === c.id,
        outcome,
        impact: impactByTarget.get(c.id) ?? null,
        step,
        dimmed: !!dimmed,
      })
      hits.push({ id: c.id, x: rightX, y, w: CARD_W, h: CARD_H })
    })

    const byId = new Map(hits.map((h) => [h.id, h]))

    // 已安排的指向线 (虚线) + 当前结算的实际指向 (实线)
    for (const c of state.characters) {
      const command = plan[c.id]
      if (!command || command.type === 'shield' || !command.targetId) continue
      if (c.hp <= 0) continue
      const from = byId.get(c.id)
      const to = byId.get(command.targetId)
      if (!from || !to) continue
      drawTargetLine(ctx, from, to, command.type === 'delay' ? C.delay : C.attack, true)
    }
    if (step) {
      const from = byId.get(step.actorId)
      const to = step.targetId && step.targetId !== step.actorId ? byId.get(step.targetId) : null
      if (from && to) {
        const color = step.outcome === 'delay' ? C.delay : step.outcome === 'shield' ? C.shield : C.attack
        drawTargetLine(ctx, from, to, color, false)
      }
    }

    hitsRef.current = hits
  })

  const handleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * props.width
    const y = ((event.clientY - rect.top) / rect.height) * props.height
    const hit = hitsRef.current.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h)
    if (hit) props.onSelect(hit.id)
  }

  const hover = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * props.width
    const y = ((event.clientY - rect.top) / rect.height) * props.height
    const hit = hitsRef.current.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h)
    canvas.style.cursor = hit ? 'pointer' : 'default'
  }

  return (
    <canvas
      ref={canvasRef}
      className="battle-canvas"
      width={props.width}
      height={props.height}
      onClick={handleClick}
      onMouseMove={hover}
      aria-label="战场: 左右两列角色, 显示生命、护盾、速度与行动点"
      role="img"
    />
  )
}
