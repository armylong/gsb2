# 本地 SQLite 客户/订单增量同步工具

把一份**初始快照**和按序号编号的**变更文件**同步到另一个本地 SQLite 库。
纯 Python 标准库实现，不需要任何真实数据库服务，支持断点续传、跨文件事务
原子生效、异常阻塞定位和同位置一致性校验。

## 1. 目录结构

```
sync_tool/
  config.py    配置加载、来源表/字段映射
  storage.py   目标库连接与元数据结构
  engine.py    同步引擎(快照、接收、事务应用、断点续传、阻塞)
  verify.py    同一已提交位置上的两端比对
  datagen.py   本地测试数据生成器
  cli.py       命令行入口
tests/         自动化测试(18 个用例)
examples/      示例配置
```

## 2. 数据与配置格式

### 2.1 初始快照 `snapshot/`

- `manifest.json`：`{"snapshot_seq": 4, "tables": {"customer": "customers.jsonl", "order": "orders.jsonl"}}`
- 每个表一个 JSONL，每行一条完整记录。
- `snapshot_seq` 表示快照已经包含源端 `1..snapshot_seq` 的全部效果。

### 2.2 变更文件 `changes/NNNNN.jsonl`

文件名按序号编号（只决定读取顺序，进度以事件 `seq` 为准），每行一个事件：

```json
{"seq": 8, "txn_id": "T008", "op_order": 1, "kind": "row", "table": "customer", "op": "DELETE", "payload": {"id": 3, "name": "王五", "city": "广州"}}
{"seq": 10, "txn_id": "T008", "kind": "commit"}
```

- `seq`：全局严格连续递增的事件序号，出现缺口即阻塞。
- `txn_id`：业务事务编号，可跨文件；只有收到 `kind=commit` 才整体生效。
- `op_order`：事务内操作顺序，从 1 开始严格连续。
- `op`：`INSERT` / `UPDATE` / `DELETE`，`payload` 为完整行。

### 2.3 配置 `config.json`

见 `examples/config.example.json`。相对路径相对配置文件目录解析；
字段通过 `columns` 做来源列 → 目标列/类型映射，`key` 声明主键列。

## 3. 快速开始（完整可复现流程）

在**仓库根目录**执行（数据目录与代码目录分开，避免数据里的同名模块被导入）：

```bash
# 0. 跑自动化测试
python3 -I -m unittest discover -v

# 1. 生成一套演示数据(clean 场景含跨文件事务)
python3 -m sync_tool generate --root /tmp/sync_demo --mode clean

# 2. 装载初始快照(只允许一次)
python3 -m sync_tool load-snapshot --config /tmp/sync_demo/config.json

# 3. 同步(可重复执行; --watch 可轮询)
python3 -m sync_tool sync --config /tmp/sync_demo/config.json

# 4. 查看进度: 源端/已接收/已应用位置、暂存事务、当前阻塞
python3 -m sync_tool status --config /tmp/sync_demo/config.json

# 5. 核对一条目标记录由哪笔事务最后修改
python3 -m sync_tool trace --config /tmp/sync_demo/config.json --table order --key 103

# 6. 同一已提交位置上的两端记录数与内容比对(退出码 0=一致, 4=有差异)
python3 -m sync_tool verify --config /tmp/sync_demo/config.json
```

### 3.1 模拟断点续传

```bash
# 先只投递前两个文件(跨文件事务 T008 的提交标记在第三个文件里)
mkdir /tmp/sync_demo/held
mv /tmp/sync_demo/changes/0000[345].jsonl /tmp/sync_demo/held/
python3 -m sync_tool sync --config /tmp/sync_demo/config.json
python3 -m sync_tool status --config /tmp/sync_demo/config.json   # 看到 T008 暂存

# 强杀进程后重启(kill -9 也安全), 再把剩余文件放回来
mv /tmp/sync_demo/held/*.jsonl /tmp/sync_demo/changes/
python3 -m sync_tool sync --config /tmp/sync_demo/config.json      # 自动续传
python3 -m sync_tool sync --config /tmp/sync_demo/config.json      # 再跑: 0 文件 0 事件
python3 -m sync_tool verify --config /tmp/sync_demo/config.json
```

### 3.2 异常场景

生成器内置六种模式：`clean / gap / dup_conflict / dup_same / missing_row / overlap`。

```bash
python3 -m sync_tool generate --root /tmp/sync_gap --mode gap
python3 -m sync_tool load-snapshot --config /tmp/sync_gap/config.json
python3 -m sync_tool sync --config /tmp/sync_gap/config.json   # 退出码 3, 打印具体位置
```

退出码：`0` 成功；`2` 配置/用法错误；`3` 同步阻塞；`4` 校验发现差异；`130` watch 被中断。

## 4. 关键设计：需求是如何保证的

### 4.1 先快照、后变更，快照内变化不重复生效

快照在单个事务里装载，并把 `1..snapshot_seq` 以 `covered` 状态登记到 `_events`。
之后这些序号的事件再送达时直接跳过，效果不会应用第二次（`overlap` 场景覆盖）。
未装载快照时 `sync` 直接拒绝执行。

### 4.2 跨文件事务的原子性与不可见性

- 行事件先进 `_staging` 暂存表，**不动业务表**；外部查询永远看不到半成品。
- `commit` 到达时，同一 `txn_id` 的客户和订单变更在**一个 SQLite 事务**里
  按 `op_order` 整体执行，任何一条失败（如修改不存在的记录）整笔回滚，
  同事务里合法的那条也不会生效。
- `op_order` 缺口/重复在提交时即阻塞，不允许带洞提交。

### 4.3 进度与数据一致、强杀可续传、重复不重放

- 每个变更文件在一个 SQLite 事务内完成「接收事件 + 推进 received_seq +
  文件登记」；业务 DML 与 applied_seq 推进也在同一事务。事务提交前进程被杀，
  SQLite 自动回滚，重启后整个文件重来，不存在进度与数据互相矛盾的状态。
- `_files` 记录已接收文件名与内容哈希：原样重复的文件直接跳过；
  已处理文件内容被篡改则阻塞（文件不可变约束）。
- 事件以 `seq` 为主键去重：重复序号必须内容哈希完全一致，否则 `duplicate_conflict`。
- 测试用 `SYNC_TOOL_CRASH=before_commit:<txn>` 触发 `os._exit(137)` 模拟 `kill -9`，
  另有用例在文件之间崩溃，验证文件级原子性。

### 4.4 异常一律阻塞，不跳过、不假装成功

| 情况 | reason | 定位信息 |
| --- | --- | --- |
| 序号缺口 | `seq_gap` | file/line/seq、缺失区间 missing_from..to |
| 重复序号内容不一致 | `duplicate_conflict` | file/line/seq/txn_id |
| 修改/删除不存在的记录 | `modify_missing` | file/line/table/key/txn_id |
| INSERT 已存在主键 | `insert_existing` | file/line/table/key |
| 事务编号提交后复用 | `txn_reused` | file/line/txn_id |
| op_order 重复/缺口 | `op_order_conflict` / `op_order_gap` | file/line/txn_id/op_order |
| 未映射字段/缺字段/类型不符 | `unknown_column` / `missing_column` / `type_mismatch` | file/line/table/column |
| JSON 行无法解析 | `bad_json` | file/line |

阻塞写入 `_blocked` 表并通过 `status` 暴露；同步停在阻塞点之前的已提交位置，
重新执行会重新评估，不会自动跳过问题文件。

### 4.5 四个进度入口

`status` 同时给出：

- **源进度**：扫描变更目录得到的最大 `seq`、文件数、待处理文件；
- **已接收进度** `received_seq`：已进入目标库（含暂存）的最大连续序号；
- **已应用进度** `applied_seq`：已提交事务的最大序号；
- **当前阻塞事务**：`_blocked` 明细 + 暂存区未提交事务列表。

`trace --table T --key ...` 返回目标记录的最后修改事务、事件序号与事务内操作号
（业务表上的 `_last_txn_id/_last_seq/_last_op` 审计列）。

### 4.6 运行期一致性校验的时间点安全

`verify` 在目标库上开启**一个只读事务**，在同一事务内读取 `applied_seq`
和全部业务表——SQLite 的快照隔离保证同步进程并发写入时，校验拿到的始终是
同一个时间点的一致视图，不会用新进度配旧数据（或反过来）给出通过结论。

期望值的计算：以快照为基线，重放变更文件中所有 `seq <= applied_seq`
且大于 `snapshot_seq` 的**已提交**事务（未提交事务天然不生效），再逐表比对
记录数、主键集合、字段内容以及最后修改事务归属。

## 5. 目标库元数据表

| 表 | 作用 |
| --- | --- |
| `_meta` | snapshot_seq / received_seq / applied_seq 三个高水位 |
| `_events` | 事件流水（seq 唯一）、内容哈希、staged/committed/covered 状态 |
| `_staging` | 未提交事务暂存区，提交后清空 |
| `_files` | 已接收文件及内容哈希，支持重复/篡改检测 |
| `_blocked` | 当前阻塞原因与精确定位（最多一条） |

业务目标表额外带 `_last_txn_id/_last_seq/_last_op` 三列审计信息。

## 6. 测试覆盖

`python3 -I -m unittest discover -v`，共 18 个用例：

- 正常全流程、跨文件事务提交前不可见、重启续传与幂等；
- 原样重复文件、快照重叠事件不二次应用、trace 归属查询；
- 序号缺口、重复内容冲突、修改不存在记录的整事务回滚、未映射字段、坏 JSON；
- 进程内钩子与子进程 `os._exit` 两种强杀恢复、文件间崩溃的原子性；
- 校验发现缺行/内容漂移、未提交期间按已提交位置校验、并发写入下的快照一致性。

## 7. 安全注意

- 读取外部数据目录中的文件时，解释器工作目录应保持在代码仓库（文档中的命令
  均把数据放在 `/tmp` 并用绝对路径传参），自动化测试的子进程统一使用 `python -I`，
  防止数据目录中被植入的同名模块（如 `json.py`）被导入。
- 表名/列名来自配置并经过标识符校验，参数全部走 SQLite 绑定，不做字符串拼接值。
