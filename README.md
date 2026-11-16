# dqtool — 可回放的本地数据质量检查工具

纯 Python 标准库实现（无第三方依赖），所有状态存在本地 SQLite 数据库中。
同一份数据可随规则版本和业务口径变化反复检查，每次结果都有完整历史依据。

## 核心概念

- **规则版本**：规则有版本号和启停状态，任何变更（导入新定义、启停）都生成新的规则集版本快照，旧版本永久保留。
- **运行（run）**：每次检查记录数据集名、输入文件 SHA-256、规则版本、起止时间、处理进度。
- **结果状态**（按 记录 × 规则 定位，不会笼统归为"失败"）：
  | 状态 | 含义 |
  |---|---|
  | `pass` | 已检查，通过 |
  | `fail` | 已检查，数据错误 |
  | `not_applicable` | 规则对该记录不适用（如可空字段为空） |
  | `corrupt` | 输入记录损坏，未能解析 |
  | `unchecked` | 运行中断，尚未检查（绝不会被报告成通过） |
- **问题台账（findings）**：按 `(数据集, 规则, 记录)` 定位，跨运行存续，承载人工确认/备注/关闭。
- **变化记录（changes）**：两次运行之间只有真正变化（新增/消失/状态迁移）才写入；相同数据重跑不产生新记录。

## 快速开始

```bash
# 规则定义 rules.json
{
  "note": "2026-11 口径",
  "rules": [
    {"id": "id_required", "type": "required", "field": "id"},
    {"id": "id_unique",   "type": "unique",   "field": "id"},
    {"id": "amount_type", "type": "type", "field": "amount", "params": {"dtype": "float"}},
    {"id": "amount_range","type": "range","field": "amount", "params": {"min": 0, "max": 100}},
    {"id": "date_order",  "type": "relation", "params": {"left": "start", "op": "<=", "right": "end"}}
  ]
}

python -m dqtool --db dq.db rules import rules.json
python -m dqtool --db dq.db run data.csv --dataset orders --key-field id --batch-size 5000
python -m dqtool --db dq.db results 1            # 查看非 pass 结果
python -m dqtool --db dq.db issues --dataset orders
```

支持 CSV、JSON 数组、NDJSON（按扩展名识别，或 `--format` 指定）。

## 规则类型

| type | 说明 | params |
|---|---|---|
| `required` | 必填（空白字符串视为空） | — |
| `type` | 字段类型 | `dtype`: int/float/string/bool/date |
| `range` | 数值范围（含端点） | `min` / `max` |
| `unique` | 全数据集唯一 | — |
| `relation` | 跨字段关系 | `left`, `op`(==/!=/</<=/>/>=), `right` 或 `right_value` |

可空字段为空时，type/range/unique/relation 记 `not_applicable` 而不是失败。

## 断点续跑与大数据

- `--batch-size` 控制分批提交，每批落库一次；中断（Ctrl-C、进程被杀）后运行状态为 `interrupted`。
- 直接对同一文件再执行 `run`（同数据集、同文件校验值、同规则版本）会自动从未完成处继续；`--fresh` 强制全新运行。
- 中断的运行 `complete=false`，未检查的记录不出现在结果中，不会被当作通过。

## 重跑、对比与回放

```bash
python -m dqtool --db dq.db run data.csv --dataset orders      # 数据变了再跑，自动生成变化记录
python -m dqtool --db dq.db compare 1 2                        # 对比两次运行，只显示真正变化
python -m dqtool --db dq.db rules import rules_v2.json         # 规则变更 → 新版本
python -m dqtool --db dq.db replay 1 --rule-version 2          # 用新规则回放历史文件（校验文件未变）
python -m dqtool --db dq.db rules diff 1 2                     # 查看规则变化
python -m dqtool --db dq.db rules disable amount_range         # 停用规则（也生成新版本）
```

回放会校验输入文件 SHA-256 与历史运行一致，防止拿错文件；旧运行和旧结果全部保留。

## 人工处理

```bash
python -m dqtool --db dq.db triage confirm 12 --note "已知问题" --by zhangsan
python -m dqtool --db dq.db triage close 12
python -m dqtool --db dq.db triage note 12 "待业务方确认"
python -m dqtool --db dq.db triage reopen 12
python -m dqtool --db dq.db triage ack 12      # 确认"数据已变化"提示
```

人工结论挂在问题台账上，重跑不会覆盖；若结论作出后该记录的数据发生变化，`data_changed=1` 提示复核。

## 导出

```bash
python -m dqtool --db dq.db export results --run 1 --out results.csv [--all]
python -m dqtool --db dq.db export issues --dataset orders --out issues.json
python -m dqtool --db dq.db export changes --dataset orders --out changes.csv
python -m dqtool --db dq.db export compare --from-run 1 --to-run 2 --out diff.csv
python -m dqtool --db dq.db export rules --version 2 --out rules_v2.json
```

## 测试

```bash
python -m unittest discover -s tests
```

覆盖：边界值（范围端点、空值、类型强转）、坏数据（CSV 列数不符、JSON 坏行）、
断点续跑（中断后续跑结果与一次性运行完全一致）、回放（规则变更影响、旧结果保留）、
重跑幂等（相同数据不产生重复变化记录）、人工结论保持与数据变化提示、导出与 CLI 端到端。

## 目录结构

```
dqtool/
  db.py       SQLite schema 与连接
  rules.py    规则定义、版本管理、求值
  ingest.py   CSV/JSON/NDJSON 流式读取，坏行识别
  runner.py   分批运行、断点续跑、findings/changes 更新、运行对比
  triage.py   人工确认/备注/关闭
  export.py   各类导出
  cli.py      命令行入口
tests/        unittest 测试
```
