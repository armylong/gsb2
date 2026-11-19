import type { RecordComparison, RoundRecord, RoundState } from '../game/types'
import { compareRuns, firstDifferenceStep } from '../game/compare'
import { stateAt } from './view'

interface CompareViewProps {
  record: RoundRecord
  /** 可选对照: 本回合规划期间的旧预览 */
  altPreviews: { id: string; comparison: RecordComparison; summary: string }[]
  activePreviewId: string
  onActivePreviewChange: (id: string) => void
  /** 跳到某一步在实战回放中的位置 */
  onJumpActual: (index: number) => void
  activeActualIndex: number
}

export function comparisonFor(
  record: RoundRecord,
  previewResult: RoundRecord['preview'],
): RecordComparison {
  return compareRuns(previewResult, { steps: record.steps, finalState: record.finalState }, record.initial)
}

export function ComparePanel({
  record,
  altPreviews,
  activePreviewId,
  onActivePreviewChange,
  onJumpActual,
  activeActualIndex,
}: CompareViewProps) {
  const activeAltEntry = altPreviews.find((a) => a.id === activePreviewId) ?? null
  const activeAlt = activeAltEntry?.comparison ?? null
  const comparison = activeAlt ?? comparisonFor(record, record.preview)
  const firstDiff = firstDifferenceStep(comparison)

  return (
    <section className="panel compare" aria-label="预览与实战对照">
      <header className="panel-head">
        <h2>预览 vs 实战</h2>
        <span className="panel-hint">
          无随机因素, 同一方案的预览与执行应逐步一致; 旧预览对应的是当时还没确认的其它方案
        </span>
      </header>

      {altPreviews.length > 0 && (
        <div className="compare-switch" role="tablist" aria-label="选择要对照的预览">
          <button
            type="button"
            role="tab"
            aria-selected={activePreviewId === '__confirmed__'}
            className={`compare-tab ${activePreviewId === '__confirmed__' ? 'is-active' : ''}`}
            onClick={() => onActivePreviewChange('__confirmed__')}
          >
            确认执行的那份
            <span className="compare-tab-meta">#{record.previewId}</span>
          </button>
          {altPreviews.map((alt) => (
            <button
              key={alt.id}
              type="button"
              role="tab"
              aria-selected={activePreviewId === alt.id}
              className={`compare-tab ${activePreviewId === alt.id ? 'is-active' : ''}`}
              onClick={() => onActivePreviewChange(alt.id)}
            >
              旧预览 {alt.id}
              <span className="compare-tab-meta">
                {alt.comparison.differingSteps > 0
                  ? `${alt.comparison.differingSteps} 步不同`
                  : '完全一致'}
              </span>
            </button>
          ))}
        </div>
      )}

      {activeAltEntry && (
        <p className="compare-alt-plan">
          这份预览对应的方案: {activeAltEntry.summary}
        </p>
      )}

      <div className="compare-summary">
        <div className={`compare-verdict ${comparison.differingSteps === 0 && comparison.finalSame ? 'is-good' : 'is-bad'}`}>
          {comparison.differingSteps === 0 && comparison.finalSame ? (
            <>
              <strong>逐步一致</strong>
              <span>{comparison.previewSteps} 步全部对上, 终态一致</span>
            </>
          ) : (
            <>
              <strong>存在差异</strong>
              <span>
                {comparison.differingSteps} 步不同
                {comparison.previewSteps !== comparison.actualSteps &&
                  ` · 步数 ${comparison.previewSteps} vs ${comparison.actualSteps}`}
              </span>
            </>
          )}
        </div>
        {firstDiff !== null && (
          <button type="button" className="btn btn-small" onClick={() => onJumpActual(firstDiff)}>
            跳到第一处差异 · 第 {firstDiff} 步
          </button>
        )}
      </div>

      <div className="compare-table-wrap">
        <table className="compare-table">
          <thead>
            <tr>
              <th scope="col">步</th>
              <th scope="col">预览</th>
              <th scope="col">实战</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <tr
                key={row.index}
                className={[
                  row.same ? '' : 'row-diff',
                  activeActualIndex === row.index ? 'is-focused' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <td className="cell-index">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => onJumpActual(row.index)}
                    title="在实战回放中查看这一步"
                  >
                    {row.index}
                  </button>
                </td>
                <td>{row.previewMessage}</td>
                <td>
                  {row.actualMessage}
                  {!row.same && <span className="cell-diff-count">{row.diffCount} 处</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {comparison.diffs.length > 0 && (
        <details className="diff-details" open={comparison.differingSteps > 0}>
          <summary>逐字段差异 ({comparison.diffs.length})</summary>
          <table className="diff-table">
            <thead>
              <tr>
                <th scope="col">步</th>
                <th scope="col">字段</th>
                <th scope="col">预览</th>
                <th scope="col">实战</th>
              </tr>
            </thead>
            <tbody>
              {comparison.diffs.map((diff, i) => (
                <tr key={`${diff.index}-${diff.field}-${i}`}>
                  <td>{diff.index === 0 ? '终态' : diff.index}</td>
                  <td>{diff.field}</td>
                  <td className="cell-preview">{diff.preview}</td>
                  <td className="cell-actual">{diff.actual}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <FinalStates record={record} />
    </section>
  )
}

function FinalStates({ record }: { record: RoundRecord }) {
  const previewFinal: RoundState = record.preview.finalState
  return (
    <div className="final-states">
      <h3>回合终态</h3>
      <table className="final-table">
        <thead>
          <tr>
            <th scope="col">角色</th>
            <th scope="col">预览 HP</th>
            <th scope="col">实战 HP</th>
            <th scope="col">预览 盾</th>
            <th scope="col">实战 盾</th>
            <th scope="col">预览 AP</th>
            <th scope="col">实战 AP</th>
          </tr>
        </thead>
        <tbody>
          {record.finalState.characters.map((actual) => {
            const preview = previewFinal.characters.find((c) => c.id === actual.id)
            const changed =
              !preview ||
              preview.hp !== actual.hp ||
              preview.shield !== actual.shield ||
              preview.ap !== actual.ap
            return (
              <tr key={actual.id} className={changed ? 'row-diff' : ''}>
                <th scope="row">{actual.name}</th>
                <td>{preview?.hp ?? '—'}</td>
                <td>{actual.hp}</td>
                <td>{preview?.shield ?? '—'}</td>
                <td>{actual.shield}</td>
                <td>{preview?.ap ?? '—'}</td>
                <td>{actual.ap}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function previewStepState(record: RoundRecord, index: number): RoundState {
  return stateAt(record.preview.steps, record.initial, index)
}
