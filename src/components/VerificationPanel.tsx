import { useMemo, useState } from 'react';
import { runVerification } from '../engine/verification';
import type { VerificationGroup } from '../engine/verification';

export function VerificationPanel() {
  const groups = useMemo(() => runVerification(), []);
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((group) => [group.id, true])),
  );
  const total = groups.reduce((sum, group) => sum + group.checks.length, 0);
  const passed = groups.reduce((sum, group) => sum + group.checks.filter((check) => check.pass).length, 0);
  const allPassed = passed === total;

  return (
    <div className="verify">
      <div className="verify-head">
        <div>
          <h2>结算验证</h2>
          <p className="muted">
            用已知预期数值核对到期边界、刷新节奏、来源隔离、属性恢复与时间跳转一致性。全部检查直接调用与界面相同的结算引擎。
          </p>
        </div>
        <div className={`verify-score ${allPassed ? 'ok' : 'bad'}`}>
          <strong>{passed}</strong>
          <span>/ {total} 通过</span>
        </div>
      </div>

      <div className="verify-body">
        {groups.map((group) => {
          const groupPassed = group.checks.every((check) => check.pass);
          const isOpen = open[group.id] ?? true;
          return (
            <section key={group.id} className={`verify-group ${groupPassed ? 'ok' : 'bad'}`}>
              <button
                className="verify-group-head"
                onClick={() => setOpen((state) => ({ ...state, [group.id]: !isOpen }))}
                aria-expanded={isOpen}
              >
                <span className="verify-status">{groupPassed ? '✓' : '✗'}</span>
                <span className="verify-title">{group.title}</span>
                <span className="muted tiny">
                  {group.checks.filter((check) => check.pass).length}/{group.checks.length}
                </span>
                <span className="chevron">{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <table className="verify-table">
                  <thead>
                    <tr>
                      <th>检查</th>
                      <th>预期</th>
                      <th>实际</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.checks.map((check) => (
                      <tr key={check.id} className={check.pass ? 'pass' : 'fail'}>
                        <td>{check.title}</td>
                        <td>
                          <code>{check.expected}</code>
                        </td>
                        <td>
                          <code>{check.actual}</code>
                        </td>
                        <td>
                          <span className={`badge ${check.pass ? 'ok' : 'danger'}`}>{check.pass ? '通过' : '失败'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>

      <div className="verify-foot">
        <p>
          命令行同样可运行：<code>npm test</code>。测试用例与上方检查共用同一份引擎；界面里的验证只是把同样的断言可视化。
        </p>
        <p className="muted tiny">
          提示：若修改了引擎规则，请同步更新 <code>src/engine/verification.ts</code> 与 <code>tests/simulator.test.ts</code> 里的预期值。
        </p>
      </div>
    </div>
  );
}

export type { VerificationGroup };
