import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { BattleCanvas } from './BattleCanvas'
import { QueueView } from './QueueView'
import { Planner } from './Planner'
import { StepList } from './StepList'
import { ComparePanel, comparisonFor } from './ComparePanel'
import { SCENARIOS, getScenario } from '../game/scenarios'
import {
  advanceRound,
  clearPlan,
  createSession,
  executeRound,
  findRecord,
  hasFreshPreview,
  makePreview,
  replayStateAt,
  resetPlanToDefault,
  resetSession,
  setCommand,
} from '../game/session'
import { compareRuns, firstDifferenceStep, planSummary } from '../game/compare'
import type { Command, GameSession, PreviewEntry, RoundRecord, Step } from '../game/types'
import { queueText } from '../game/compare'
import { impactByTarget, stepByActor } from './view'
import type { RecordComparison } from '../game/types'

type ViewMode = 'live' | 'preview' | 'replay'

const PLAY_INTERVAL = 850

function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(720)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(Math.max(440, Math.floor(entry.contentRect.width)))
    })
    observer.observe(el)
    setWidth(Math.max(440, Math.floor(el.getBoundingClientRect().width)))
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

function StatusPill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>
}

export function App() {
  const [session, setSession] = useState<GameSession>(() => createSession(SCENARIOS[0]!.id))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('live')
  const [previewIndex, setPreviewIndex] = useState(0)
  const [replay, setReplay] = useState<{ recordId: string; index: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  const [comparePreviewId, setComparePreviewId] = useState('__confirmed__')
  const [showScenarioInfo, setShowScenarioInfo] = useState(false)
  const [stageRef, stageWidth] = useElementWidth<HTMLDivElement>()

  const scenario = getScenario(session.scenarioId)
  const activeRecord: RoundRecord | null = useMemo(() => {
    if (mode !== 'replay' || !replay) return null
    return findRecord(session, replay.recordId) ?? null
  }, [mode, replay, session])

  /* ---------- 派生视图: 战场 / 队列 / 高亮步骤 ---------- */

  const viewState = useMemo(() => {
    if (mode === 'replay' && activeRecord && replay) {
      return replayStateAt(activeRecord, replay.index)
    }
    if (mode === 'preview' && session.preview) {
      const idx = Math.min(previewIndex, session.preview.result.steps.length)
      return idx <= 0
        ? session.state
        : (session.preview.result.steps[idx - 1]?.stateAfter ?? session.state)
    }
    return session.state
  }, [mode, activeRecord, replay, session, previewIndex])

  const activeStep: Step | null = useMemo(() => {
    if (mode === 'replay' && activeRecord && replay && replay.index > 0) {
      return activeRecord.steps[Math.min(replay.index, activeRecord.steps.length) - 1] ?? null
    }
    if (mode === 'preview' && session.preview && previewIndex > 0) {
      return session.preview.result.steps[Math.min(previewIndex, session.preview.result.steps.length) - 1] ?? null
    }
    return null
  }, [mode, activeRecord, replay, session, previewIndex])

  /** 队列角标: 预览看全部预计; 回放只看已结算的部分, 避免剧透 */
  const outcomeByActor = useMemo(() => {
    if (mode === 'preview' && session.preview) {
      return stepByActor(session.preview.result.steps)
    }
    if (mode === 'replay' && activeRecord && replay) {
      return stepByActor(activeRecord.steps.slice(0, replay.index))
    }
    return new Map<string, Step>()
  }, [mode, session, activeRecord, replay])

  /** 预计/回放中每个角色承受的伤害合计 */
  const impactMap = useMemo(() => {
    if (mode === 'preview' && session.preview) {
      return impactByTarget(session.preview.result.steps)
    }
    if (mode === 'replay' && activeRecord && replay) {
      return impactByTarget(activeRecord.steps.slice(0, replay.index))
    }
    return new Map<string, { hp: number; shield: number }>()
  }, [mode, session, activeRecord, replay])

  const canvasPlan = useMemo(() => {
    if (mode === 'preview' && session.preview) return session.preview.plan
    if (mode === 'replay' && activeRecord) return activeRecord.plan
    return session.plan
  }, [mode, session, activeRecord])

  /* ---------- 预览播放 (只在回放模式) ---------- */

  useEffect(() => {
    if (!playing || mode !== 'replay' || !activeRecord || !replay) return
    if (replay.index >= activeRecord.steps.length) {
      setPlaying(false)
      return
    }
    const timer = window.setTimeout(() => {
      setReplay((current) => {
        if (!current) return current
        return { ...current, index: Math.min(current.index + 1, activeRecord.steps.length) }
      })
    }, PLAY_INTERVAL)
    return () => window.clearTimeout(timer)
  }, [playing, mode, activeRecord, replay])

  useEffect(() => {
    if (mode !== 'replay') setPlaying(false)
  }, [mode])

  /* ---------- 动作 ---------- */

  const changeScenario = (id: string): void => {
    setSession(createSession(id))
    setSelectedId(null)
    setMode('live')
    setPreviewIndex(0)
    setReplay(null)
    setPlaying(false)
    setComparePreviewId('__confirmed__')
  }

  const doReset = (): void => {
    setSession((prev) => resetSession(prev))
    setSelectedId(null)
    setMode('live')
    setPreviewIndex(0)
    setReplay(null)
    setPlaying(false)
    setComparePreviewId('__confirmed__')
  }

  const applyCommand = (actorId: string, command: Command | null): void => {
    if (session.phase !== 'planning') return
    setSession((prev) => setCommand(prev, actorId, command))
    if (mode !== 'live') {
      setMode('live')
      setPreviewIndex(0)
    }
  }

  const handleSelect = (id: string): void => {
    setSelectedId(id)
    if (session.phase !== 'planning' || mode === 'replay') return
    const selected = session.state.characters.find((c) => c.id === id)
    if (!selected) return
    // 选中敌方: 若已选中的我方有指向性指令, 直接改目标
    if (selected.side === 'enemy' && selectedId) {
      const actor = session.state.characters.find((c) => c.id === selectedId)
      const command = actor ? session.plan[actor.id] : null
      if (actor && actor.side === 'ally' && command && command.type !== 'shield') {
        applyCommand(actor.id, { type: command.type, targetId: selected.id })
        return
      }
    }
  }

  const doPreview = (): void => {
    setSession((prev) => makePreview(prev))
    setMode('preview')
    setPreviewIndex(0)
  }

  const doCancelPreview = (): void => {
    setMode('live')
    setPreviewIndex(0)
  }

  const doExecute = (): void => {
    if (!hasFreshPreview(session) || !session.preview) return
    const next = executeRound(session)
    setSession(next)
    const record = next.records[next.records.length - 1]
    if (record) {
      setMode('replay')
      setReplay({ recordId: record.id, index: 0 })
      setPlaying(true)
      setComparePreviewId('__confirmed__')
    }
  }

  const doNextRound = (): void => {
    setSession((prev) => advanceRound(prev))
    setMode('live')
    setReplay(null)
    setPreviewIndex(0)
    setPlaying(false)
  }

  const openRecord = (record: RoundRecord): void => {
    setMode('replay')
    setReplay({ recordId: record.id, index: record.steps.length })
    setPlaying(false)
    setComparePreviewId('__confirmed__')
  }

  const backToCurrent = (): void => {
    setMode('live')
    setReplay(null)
    setPlaying(false)
    setPreviewIndex(0)
  }

  const jumpReplay = (index: number): void => {
    if (!activeRecord) return
    setPlaying(false)
    setReplay({ recordId: activeRecord.id, index: Math.max(0, Math.min(index, activeRecord.steps.length)) })
  }

  /* ---------- 面板数据 ---------- */

  const previewSteps = session.preview?.result.steps ?? []
  const previewFinalQueue = session.preview?.result.finalState.pending ?? []

  const latestRecord = session.records[session.records.length - 1] ?? null

  const compareRecord = activeRecord ?? latestRecord
  const altPreviews = useMemo(() => {
    if (!compareRecord) return [] as { id: string; comparison: RecordComparison; summary: string }[]
    return compareRecord.previewHistory
      .filter((entry: PreviewEntry) => entry.id !== compareRecord.previewId)
      .map((entry) => ({
        id: entry.id,
        summary: planSummary(entry.plan, compareRecord.initial),
        comparison: compareRuns(entry.result, { steps: compareRecord.steps, finalState: compareRecord.finalState }, compareRecord.initial),
      }))
  }, [compareRecord])

  const activeComparison = useMemo(() => {
    if (!compareRecord) return null
    if (comparePreviewId !== '__confirmed__') {
      const alt = altPreviews.find((a) => a.id === comparePreviewId)
      if (alt) return alt.comparison
    }
    return comparisonFor(compareRecord, compareRecord.preview)
  }, [compareRecord, comparePreviewId, altPreviews])

  const compareDiffSteps = useMemo(() => {
    if (!activeComparison) return new Set<number>()
    return new Set(activeComparison.diffs.filter((d) => d.index > 0).map((d) => d.index))
  }, [activeComparison])

  const planCount = Object.values(session.plan).filter(Boolean).length
  const fresh = hasFreshPreview(session)

  const modeLabel =
    mode === 'preview'
      ? '预览中 · 未执行'
      : mode === 'replay'
        ? activeRecord
          ? `回放 · 第 ${activeRecord.round} 回合 · 第 ${replay?.index ?? 0}/${activeRecord.steps.length} 步`
          : '回放'
        : session.phase === 'finished'
          ? `第 ${session.round} 回合已结算`
          : `第 ${session.round} 回合 · 规划中`

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>回合战斗调试台</h1>
            <p>先预览, 再执行, 逐步回看这些数值是怎么变的</p>
          </div>
        </div>

        <nav className="scenario-tabs" aria-label="选择样例">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`scenario-tab ${s.id === session.scenarioId ? 'is-active' : ''}`}
              aria-pressed={s.id === session.scenarioId}
              onClick={() => changeScenario(s.id)}
            >
              <span className="scenario-tab-name">{s.name}</span>
              <span className="scenario-tab-tag">{s.tagline}</span>
            </button>
          ))}
        </nav>

        <div className="topbar-actions">
          <StatusPill tone={mode === 'live' ? 'pill-live' : mode === 'preview' ? 'pill-preview' : 'pill-replay'}>
            {modeLabel}
          </StatusPill>
          <button type="button" className="btn btn-ghost" onClick={doReset} title="清空记录, 回到本样例的第一回合">
            重置样例
          </button>
        </div>
      </header>

      <button
        type="button"
        className="scenario-info-toggle"
        aria-expanded={showScenarioInfo}
        onClick={() => setShowScenarioInfo((v) => !v)}
      >
        {showScenarioInfo ? '收起样例说明' : `查看样例说明 · ${scenario.name}`}
      </button>
      {showScenarioInfo && (
        <section className="scenario-info">
          <p>{scenario.description}</p>
          <ul>
            {scenario.lessons.map((lesson) => (
              <li key={lesson}>{lesson}</li>
            ))}
          </ul>
        </section>
      )}

      <main className="stage-grid">
        <section className="panel battle-panel" aria-label="战场">
          <header className="panel-head">
            <h2>战场</h2>
            <span className="panel-hint">
              {mode === 'replay'
                ? '回放只读取已结算快照'
                : mode === 'preview'
                  ? '预览不会修改真实战场'
                  : '点击我方角色规划行动'}
            </span>
          </header>

          <div className="stage-canvas-wrap" ref={stageRef}>
            <BattleCanvas
              state={viewState}
              step={activeStep}
              nextActorId={viewState.pending[0] ?? null}
              plan={canvasPlan}
              selectedActorId={mode === 'live' || mode === 'preview' ? selectedId : activeStep?.targetId ?? null}
              outcomeByActor={outcomeByActor}
              impactByTarget={impactMap}
              onSelect={handleSelect}
              width={Math.min(820, Math.max(440, stageWidth - 24))}
              height={636}
              dimmed={mode === 'replay' && !!activeRecord}
            />
          </div>

          {mode === 'replay' && activeRecord && replay ? (
            <ReplayControls
              record={activeRecord}
              index={replay.index}
              playing={playing}
              onTogglePlay={() => {
                if (replay.index >= activeRecord.steps.length && !playing) {
                  setReplay({ recordId: activeRecord.id, index: 0 })
                  setPlaying(true)
                  return
                }
                setPlaying((p) => !p)
              }}
              onStep={(delta) => {
                if (replay.index >= activeRecord.steps.length && delta > 0) return
                jumpReplay(replay.index + delta)
              }}
              onJump={jumpReplay}
              onExit={backToCurrent}
            />
          ) : (
            <div className="stage-foot">
              <span>
                下一位行动: <strong>{viewState.pending[0] ? viewState.characters.find((c) => c.id === viewState.pending[0])?.name : '—'}</strong>
              </span>
              <span className="stage-foot-meta">同速次序: 速度 → 我方 → 部署序号 → id</span>
            </div>
          )}
        </section>

        <section className="panel queue-panel" aria-label="行动队列">
          <QueueView
            state={viewState}
            outcomeByActor={outcomeByActor}
            activeActorId={viewState.pending[0] ?? null}
            title={mode === 'replay' ? '回放中的队列' : mode === 'preview' ? '预览队列' : '行动队列'}
            emptyLabel={
              mode === 'replay' || session.phase === 'finished'
                ? '这一回合已全部结算'
                : '本回合没有待行动角色'
            }
            finalQueue={
              mode === 'preview' && session.preview
                ? session.preview.result.finalState.pending
                : mode === 'replay' && activeRecord
                  ? activeRecord.finalState.pending
                  : null
            }
          />
          <div className="queue-legend">
            <span className="legend-item"><span className="legend-dot side-ally" />我方</span>
            <span className="legend-item"><span className="legend-dot side-enemy" />敌方</span>
            <span className="legend-item"><span className="legend-key" />下一位</span>
          </div>
        </section>

        <section className="panel log-panel" aria-label="结算记录">
          <header className="panel-head">
            <h2>
              {mode === 'replay'
                ? `回放记录 · 第 ${activeRecord?.round} 回合`
                : mode === 'preview'
                  ? '预览步骤'
                  : latestRecord
                    ? `最近结算 · 第 ${latestRecord.round} 回合`
                    : '结算记录'}
            </h2>
            <span className="panel-hint">
              {mode === 'replay'
                ? '拖动或点击任一步, 场景与队列同步'
                : mode === 'preview'
                  ? '预览的每一步, 确认前先看清楚'
                  : latestRecord
                    ? '点击任一步进入回放; 新回合结算后这里会更新'
                    : '执行后在这里逐步回看'}
            </span>
          </header>

          {mode === 'preview' && session.preview ? (
            <StepList
              steps={previewSteps}
              initial={session.state}
              activeIndex={previewIndex}
              onSelect={setPreviewIndex}
              showQueue
            />
          ) : mode === 'replay' && activeRecord && replay ? (
            <StepList
              steps={activeRecord.steps}
              initial={activeRecord.initial}
              activeIndex={replay.index}
              onSelect={jumpReplay}
              diffSteps={compareDiffSteps}
              showQueue
            />
          ) : latestRecord ? (
            <StepList
              steps={latestRecord.steps}
              initial={latestRecord.initial}
              activeIndex={latestRecord.steps.length}
              onSelect={(index) => {
                openRecord(latestRecord)
                setReplay({ recordId: latestRecord.id, index })
              }}
              showQueue
            />
          ) : (
            <div className="empty-state">
              <p>还没有结算记录。</p>
              <p className="empty-hint">在下方安排指令, 生成预览并确认执行后, 这里会出现逐步记录。</p>
            </div>
          )}
        </section>
      </main>

      <section className="panel planner-panel" aria-label="方案编辑">
        <header className="panel-head">
          <h2>{mode === 'replay' && activeRecord ? `记录中的方案 · 第 ${activeRecord.round} 回合` : '本回合方案'}</h2>
          <div className="planner-actions">
            <span className="panel-hint">
              {mode === 'replay'
                ? '回看中不能修改; 返回当前回合后再编辑'
                : `已安排 ${planCount} 人 · 修改未确认的方案不会消耗任何资源`}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={mode === 'replay' || session.phase !== 'planning'}
              onClick={() => setSession((prev) => resetPlanToDefault(prev))}
            >
              填充默认方案
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={mode === 'replay' || session.phase !== 'planning'}
              onClick={() => setSession((prev) => clearPlan(prev))}
            >
              清空方案
            </button>
          </div>
        </header>
        <Planner
          state={
            mode === 'replay' && activeRecord
              ? activeRecord.initial
              : session.phase === 'finished' && latestRecord
                ? latestRecord.finalState
                : session.state
          }
          plan={
            mode === 'replay' && activeRecord
              ? activeRecord.plan
              : session.phase === 'finished' && latestRecord
                ? latestRecord.plan
                : session.plan
          }
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCommand={applyCommand}
          outcomeByActor={mode === 'preview' && session.preview ? stepByActor(session.preview.result.steps) : new Map()}
          disabled={mode === 'replay' || session.phase !== 'planning'}
          disabledNote={
            mode === 'replay' && activeRecord
              ? `回看第 ${activeRecord.round} 回合的记录; 返回当前后才能编辑`
              : `第 ${session.round} 回合已结算, 进入下一回合后可继续安排`
          }
        />
        <div className="planner-foot">
          <div className="planner-foot-text">
            {mode === 'replay' ? (
              '记录中的方案只读, 用于核对当时的指令'
            ) : session.phase === 'finished' ? (
              '本回合已结算; 点下方「进入下一回合」打开新的规划'
            ) : session.preview ? (
              <>
                <span className="dot dot-preview" /> 预览已生成, 对应方案 #{session.preview.id}
              </>
            ) : (
              '修改方案后预览会失效, 需要重新生成'
            )}
          </div>
          <div className="planner-foot-actions">
            {session.phase === 'finished' && mode !== 'replay' ? (
              <button type="button" className="btn btn-primary" onClick={doNextRound}>
                进入第 {session.round + 1} 回合
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={mode === 'replay' || session.phase !== 'planning'}
                  onClick={doPreview}
                >
                  {session.preview ? '重新生成预览' : '生成预览'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!fresh || mode === 'replay'}
                  onClick={doExecute}
                  title={fresh ? '按预览的方案真实结算' : '先为当前方案生成预览'}
                >
                  确认执行
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      {mode === 'preview' && session.preview ? (
        <section className="panel preview-panel" aria-label="执行前预览">
          <header className="panel-head">
            <h2>执行前预览 · 第 {session.round} 回合</h2>
            <span className="panel-hint">预览不消耗资源, 不改变真实战场; 连续修改后以最后确认的方案为准</span>
          </header>

          <div className="preview-summary">
            <div className="preview-block">
              <h3>预期结局</h3>
              <div className="preview-queue">
                <span className="preview-queue-label">剩余队列</span>
                {previewFinalQueue.length === 0 ? (
                  <span className="muted">(空)</span>
                ) : (
                  previewFinalQueue.map((id, i) => {
                    const c = session.preview!.result.finalState.characters.find((x) => x.id === id)
                    return (
                      <span key={id} className={`queue-chip side-${c?.side}`}>
                        {i + 1}. {c?.name ?? id}
                      </span>
                    )
                  })
                )}
              </div>
              <div className="preview-stats">
                {(['ally', 'enemy'] as const).map((side) => {
                  const chars = session.preview!.result.finalState.characters.filter((c) => c.side === side)
                  return (
                    <div key={side} className="preview-stat">
                      <span className={`side-dot side-${side}`} />
                      <span>{side === 'ally' ? '我方' : '敌方'}</span>
                      <span className="muted">
                        {chars.filter((c) => c.hp > 0).length}/{chars.length} 存活 · 生命合计{' '}
                        {chars.reduce((sum, c) => sum + c.hp, 0)} · 护盾合计{' '}
                        {chars.reduce((sum, c) => sum + c.shield, 0)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="preview-block">
              <h3>逐项预期</h3>
              <ol className="preview-steps">
                {previewSteps.map((step) => (
                  <li key={step.index} className={`preview-step tone-${step.outcome}`}>
                    <button type="button" onClick={() => setPreviewIndex(step.index)}>
                      <span className="preview-step-no">{step.index}</span>
                      <span className="preview-step-text">{step.message}</span>
                      <span className="preview-step-ap">
                        {step.apCost > 0 ? `-${step.apCost} AP` : '无消耗'}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>

            <div className="preview-block preview-scrub">
              <h3>预览时间线</h3>
              <input
                type="range"
                min={0}
                max={previewSteps.length}
                value={previewIndex}
                onChange={(e) => setPreviewIndex(Number(e.target.value))}
                aria-label="预览步进"
              />
              <div className="scrub-labels">
                <span>回合开始</span>
                <span>
                  第 {previewIndex}/{previewSteps.length} 步
                </span>
                <span>终态</span>
              </div>
              <p className="preview-scrub-note">
                拖动只查看预览快照, 不会执行任何动作; 战场与队列会同步到该步。
              </p>
            </div>
          </div>

          <div className="planner-foot">
            <button type="button" className="btn btn-ghost" onClick={doCancelPreview}>
              返回修改
            </button>
            <button type="button" className="btn btn-primary" disabled={!fresh} onClick={doExecute}>
              确认执行这份方案
            </button>
          </div>
        </section>
      ) : latestRecord ? (
        <ComparePanel
          record={compareRecord ?? latestRecord}
          altPreviews={altPreviews}
          activePreviewId={comparePreviewId}
          onActivePreviewChange={setComparePreviewId}
          onJumpActual={(index) => {
            const target = compareRecord ?? latestRecord
            if (!target) return
            openRecord(target)
            setReplay({ recordId: target.id, index })
          }}
          activeActualIndex={mode === 'replay' && replay ? replay.index : 0}
        />
      ) : null}

      <section className="panel history-panel" aria-label="回合历史">
        <header className="panel-head">
          <h2>回合历史</h2>
          <div className="planner-actions">
            <span className="panel-hint">每条记录保留执行时的初始快照, 后续回合不会改写它</span>
            {mode === 'replay' && (
              <button type="button" className="btn btn-ghost btn-small" onClick={backToCurrent}>
                返回当前
              </button>
            )}
            {session.phase === 'finished' && mode === 'replay' && (
              <button type="button" className="btn btn-primary btn-small" onClick={doNextRound}>
                进入第 {session.round + 1} 回合
              </button>
            )}
          </div>
        </header>

        {session.records.length === 0 ? (
          <div className="empty-state">
            <p>还没有执行过回合。</p>
          </div>
        ) : (
          <ul className="history-list">
            {session.records
              .slice()
              .reverse()
              .map((record) => {
                const comparison = comparisonFor(record, record.preview)
                const firstDiff = firstDifferenceStep(comparison)
                const isActive = activeRecord?.id === record.id
                return (
                  <li key={record.id}>
                    <button
                      type="button"
                      className={`history-item ${isActive ? 'is-active' : ''}`}
                      onClick={() => openRecord(record)}
                    >
                      <span className="history-round">R{record.round}</span>
                      <span className="history-body">
                        <span className="history-title">
                          {planSummary(record.plan, record.initial)}
                        </span>
                        <span className="history-meta">
                          {record.steps.length} 步 · 预览 #{record.previewId} ·{' '}
                          {comparison.differingSteps === 0
                            ? '与预览逐步一致'
                            : `${comparison.differingSteps} 步不同, 首处第 ${firstDiff} 步`}
                        </span>
                      </span>
                      <span className={`history-badge ${comparison.differingSteps === 0 ? 'is-good' : 'is-bad'}`}>
                        {comparison.differingSteps === 0 ? '一致' : '有差异'}
                      </span>
                    </button>
                  </li>
                )
              })}
          </ul>
        )}

      </section>

      <footer className="app-footer">
        <span>
          纯确定性引擎: 无随机数, 同速次序固定; 预览与执行调用同一个 <code>simulateRound</code>。
        </span>
        <span>
          {scenario.lessons.length} 条观察要点 · {session.records.length} 条回合记录
        </span>
      </footer>
    </div>
  )
}

/* ---------------- 回放控制 ---------------- */

interface ReplayControlsProps {
  record: RoundRecord
  index: number
  playing: boolean
  onTogglePlay: () => void
  onStep: (delta: number) => void
  onJump: (index: number) => void
  onExit: () => void
}

function ReplayControls({ record, index, playing, onTogglePlay, onStep, onJump, onExit }: ReplayControlsProps) {
  const atEnd = index >= record.steps.length
  const current = index > 0 ? record.steps[index - 1] : null
  return (
    <div className="replay-controls" aria-label="回放控制">
      <div className="replay-buttons">
        <button type="button" className="btn btn-ghost btn-small" onClick={onExit}>
          返回当前
        </button>
        <button
          type="button"
          className="btn btn-icon"
          onClick={() => onJump(0)}
          aria-label="回到回合开始"
          title="回到回合开始"
        >
          ⏮
        </button>
        <button type="button" className="btn btn-icon" onClick={() => onStep(-1)} aria-label="上一步" title="上一步">
          ◀
        </button>
        <button type="button" className="btn btn-primary btn-play" onClick={onTogglePlay}>
          {playing ? '暂停' : atEnd ? '重新播放' : '播放'}
        </button>
        <button
          type="button"
          className="btn btn-icon"
          onClick={() => onStep(1)}
          aria-label="下一步"
          title="下一步"
          disabled={atEnd}
        >
          ▶
        </button>
        <button
          type="button"
          className="btn btn-icon"
          onClick={() => onJump(record.steps.length)}
          aria-label="跳到终态"
          title="跳到终态"
        >
          ⏭
        </button>
        <span className="replay-counter">
          {index}/{record.steps.length}
        </span>
      </div>
      <input
        className="replay-scrub"
        type="range"
        min={0}
        max={record.steps.length}
        value={index}
        onChange={(e) => onJump(Number(e.target.value))}
        aria-label="回放进度"
      />
      <div className="replay-caption">
        {current
          ? current.message
          : `回合开始 · 队列 ${queueText(record.initial, record.initial.pending)}`}
      </div>
      <div className="replay-note">
        回放只读取已结算快照, 前后拖动不会重复扣血, 也不会再次触发推迟效果。
      </div>
    </div>
  )
}
