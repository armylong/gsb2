import type { ValidationIssue, ValidationReport } from '../engine/types';

interface ValidationPanelProps {
  report: ValidationReport;
  onFocusNode: (nodeId: string) => void;
}

function IssueRow({
  issue,
  onFocusNode,
  tone,
}: {
  issue: ValidationIssue;
  onFocusNode: (nodeId: string) => void;
  tone: 'error' | 'warning';
}) {
  return (
    <li className={`issue issue--${tone}`} data-issue-kind={issue.kind}>
      <span className="issue-dot" aria-hidden="true" />
      <div>
        <span className="issue-message">{issue.message}</span>
        {issue.nodeId ? (
          <button type="button" className="link-button" onClick={() => onFocusNode(issue.nodeId!)}>
            {issue.nodeId}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function ValidationPanel({ report, onFocusNode }: ValidationPanelProps) {
  return (
    <div className="validation" data-testid="validation-panel">
      <div className="validation-summary">
        <span className={`badge ${report.errors.length > 0 ? 'badge--error' : 'badge--ok'}`}>
          错误 {report.errors.length}
        </span>
        <span className={`badge ${report.warnings.length > 0 ? 'badge--warn' : 'badge--ok'}`}>
          警告 {report.warnings.length}
        </span>
        <span className="badge badge--info">有意循环 {report.loopNodeIds.length} 节点</span>
      </div>

      <div className="checklist">
        <p>
          <strong>缺失目标：</strong>
          {report.missingTargets.length === 0
            ? '无'
            : report.missingTargets
                .map((entry) => `${entry.nodeId}/${entry.choiceId} → ${entry.target}`)
                .join('，')}
        </p>
        <p>
          <strong>无无条件出口：</strong>
          {report.noUnconditionalExitNodeIds.length === 0
            ? '无'
            : report.noUnconditionalExitNodeIds.join('，')}
        </p>
        <p>
          <strong>从入口不可达：</strong>
          {report.unreachableNodeIds.length === 0 ? '无' : report.unreachableNodeIds.join('，')}
        </p>
        <p>
          <strong>无法抵达结局：</strong>
          {report.noPathToEndingNodeIds.length === 0 ? '无' : report.noPathToEndingNodeIds.join('，')}
        </p>
        <p>
          <strong>可到达的结局：</strong>
          {report.reachableEndingIds.length === 0 ? '无' : report.reachableEndingIds.join('，')}
        </p>
        <p>
          <strong>循环节点（非错误）：</strong>
          {report.loopNodeIds.length === 0 ? '无' : report.loopNodeIds.join('，')}
        </p>
      </div>

      {report.issues.length === 0 ? (
        <p className="empty-note">配置检查通过：没有缺失目标、死路或不可达节点。</p>
      ) : (
        <ul className="issue-list">
          {report.issues.map((issue, index) => (
            <IssueRow
              key={`${issue.kind}-${issue.nodeId ?? 'root'}-${issue.choiceId ?? index}`}
              issue={issue}
              onFocusNode={onFocusNode}
              tone={issue.severity}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
