import { validateMapping } from '../model/mapping';
import { Mapping } from '../model/types';

/** 实时校验：交叉区配置、空洞、素材引用、并发数等 */
export function ValidationPanel({ mapping }: { mapping: Mapping }) {
  const issues = validateMapping(mapping);
  if (issues.length === 0) {
    return (
      <div className="panel">
        <h2>映射校验</h2>
        <span className="badge ready">配置有效</span>
      </div>
    );
  }
  return (
    <div className="panel">
      <h2>映射校验 · {issues.length} 条</h2>
      {issues.map((it, i) => (
        <div key={i} className={`issue ${it.level}`}>
          <b>{it.level === 'error' ? '错误' : '提示'}</b>：{it.message}
        </div>
      ))}
    </div>
  );
}
