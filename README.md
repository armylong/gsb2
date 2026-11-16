# eventreplay

本地业务事件日志重放与统计工具。把按天导出、字段名/时间格式/到达顺序不一致的多来源事件文件，按**业务时间**重放成可查询、可解释的窗口统计结果。纯 Python 标准库 + SQLite，无外部服务依赖。

## 安装与运行

```bash
python3 -m venv .venv && .venv/bin/pip install pytest   # 仅测试需要 pytest
cd examples
PYTHONPATH=.. python3 -m eventreplay run --config config.json
PYTHONPATH=.. python3 -m eventreplay query --key shopA
```

数据库路径默认取配置文件中的 `db`，也可用全局参数 `--db` 覆盖。

## 配置（JSON，见 examples/config.json）

```json
{
  "db": "eventreplay.db",
  "window": "1d",
  "sources": [
    {
      "name": "pay",
      "path": "data/pay/*.csv",
      "format": "csv",
      "mapping": {"event_id": "order_id", "biz_time": "pay_time",
                  "biz_key": "merchant", "amount": "amount", "status": "state"},
      "time_formats": ["%Y-%m-%d %H:%M:%S", "iso"]
    }
  ]
}
```

- `format`: `csv` / `jsonl`；`path` 支持 glob，相对路径基于配置文件所在目录
- `mapping`: `event_id`/`biz_time`/`biz_key` 必填，`amount`/`status` 可选
- `time_formats`: 依次尝试，`iso`、`epoch`、`epoch_ms` 或任意 strftime 格式；统一归一到 UTC
- `window`: `15m` / `1h` / `1d` 等，窗口边界从 epoch 对齐，与到达顺序无关

## 命令

| 命令 | 说明 |
|---|---|
| `run --config c.json [--from-date D] [--to-date D] [--from-event ID] [--no-checkpoints]` | 读取来源文件并处理；已完整处理且内容未变的文件按断点跳过 |
| `reprocess --config c.json --start D --end D` | 忽略断点重读全部文件（拾取迟到数据），重算指定范围；旧结果在范围处理完整前保持可查询，完成后原子发布并记录前后差异 |
| `query [--key K] [--start D] [--end D]` | 查询已发布的窗口统计 |
| `explain --key K --window-start ISO` | 列出该统计值的全部来源事件（含 `文件:行号`），并重算核对 |
| `export --what results\|anomalies\|replay\|diffs --out FILE [--format csv\|json]` | 导出结果 / 异常（冲突+跳过+坏文件）/ 重放记录 / 发布差异 |
| `status` | 运行、文件与异常概览 |

## 语义约定

- **去重与冲突**：按 `(event_id, 内容哈希)` 去重，重复运行不会重复计入；同编号不同内容记入 `conflicts`，不计入统计
- **结算**：只有完整跑完的运行才发布窗口结果；处理中断的运行标记为 `failed`，其窗口不结算，已发布结果不受影响
- **容错**：单文件损坏或单行字段缺失只记录到 `files`/`skipped`（含文件与行号），其余文件照常处理
- **可解释**：每个已发布统计值都能通过 `explain` 反查到贡献它的原始事件位置，导出文件可用于审计

## 测试

```bash
.venv/bin/python -m pytest tests/ -q
```

覆盖：乱序、窗口边界对齐、重复去重、冲突隔离、坏行/坏文件定位、重复运行幂等、中断不结算与断点续跑、`--from-event` 续跑、迟到文件范围重算与差异保留、统计值溯源。
