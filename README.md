# 离线 SQL 字段血缘分析工具

在**不连接任何数据库**的前提下，解析本地 sqlite 查询文件和表结构说明，计算每个
输出字段的来源，并支持从原始表字段反查下游影响。附带一个零依赖的本地网页查看器。

## 能力范围

### 支持的查询（sqlite 方言）

- 表别名、多表连接（`JOIN ... ON` / `USING` / 逗号连接）、`LEFT/RIGHT/CROSS JOIN`
- 子查询：`FROM` 内派生表、标量子查询、`EXISTS`
- CTE（`WITH ... AS`），包括嵌套作用域中的**同名遮蔽**（内层 CTE 不会与外层串关系）
- 多段查询引用：同一文件内 `CREATE [TEMP] VIEW` / `CREATE TABLE AS` 注册的名字可被后续语句引用
- 集合查询：`UNION [ALL]` / `INTERSECT` / `EXCEPT`，各分支**按输出位置对应**
- 别名重命名、计算表达式、聚合（含 `count(*)`）、`CASE WHEN`、窗口函数、`DISTINCT`、`GROUP BY` / `HAVING` / `ORDER BY`
- 星号 `*` / `t.*`：结合输入的表结构或派生表输出展开

### 两类依赖关系严格区分

| 关系 | 含义 | 示例 |
| --- | --- | --- |
| **值来源（value）** | 真正生成字段值 | `SELECT a + b` 中 `a`、`b` |
| **条件依赖（predicate）** | 只影响筛选/连接/分组/去重/窗口帧，不产生值 | `WHERE`、`JOIN ON`、`USING`、`GROUP BY`、`HAVING`、`CASE WHEN` 条件、窗口 `PARTITION BY/ORDER BY`、`DISTINCT`、`ORDER BY` |

反向查询某个原始字段时，两类影响分别成组展示。

### 明确不支持 / 报错而不猜测

- `WITH RECURSIVE` 递归 CTE：标记为 `recursive_cte`，不跟随循环
- 歧义的同名字段、未知表、未知列、无法解析的语法、未知别名上的星号：定位到**文件 + 行列号 + SQL 片段**
- 未解析项作为一类一等输出保留在血缘树里，**绝不会被统计成“没有依赖”**
- `INSERT ... SELECT` / `UPDATE` / `DELETE`：报告为不支持（只读查询范围之外）
- 单个查询/语句解析失败不影响同文件其它语句和其它文件的结果

## 目录结构

```
src/sql_lineage/
  models.py      # 血缘节点、查询块、未解析项、反向影响等数据结构
  locations.py   # sqlglot AST → 源码行列/片段定位；按词法切分多条语句
  schema.py      # sqlite DDL / JSON 表结构输入（SchemaCatalog）
  analyzer.py    # 核心：作用域绑定、列归属计算、表达式血缘、CTE/子查询/集合查询
  impact.py      # 反向影响：原始字段 → 受影响查询/输出列（value/predicate 分开）
  runner.py      # 文件编排、语句级失败隔离、位置重映射
  exporter.py    # lineage.json / lineage_edges.csv / unresolved.csv / summary.csv
  cli.py         # 命令行入口
  web/           # stdlib http.server + 原生 HTML/CSS/JS 单页查看器
examples/
  schema/        # 示例 sqlite DDL 与 JSON 目录
  queries/       # 覆盖别名/多来源/星号/UNION/CTE 遮蔽/跨视图的查询
  queries/errors/05_error_cases.sql  # 故意制造的 7 类未解析场景
  run_queries_in_sqlite.py           # 在内存 sqlite 中执行所有受支持示例
tests/           # 37 个 pytest 用例
```

## 快速开始

需要 Python 3.10+（开发验证使用 3.12）。

```bash
# 1. 建立虚拟环境并安装依赖（仅 sqlglot + pytest）
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. 运行分析并启动本地网页
.venv/bin/python -m sql_lineage.cli analyze \
  --schema examples/schema/schema.sql \
  --json-catalog examples/schema/extra_catalog.json \
  --queries examples/queries \
  --out build/lineage \
  --serve --port 8000
# 浏览器打开 http://127.0.0.1:8000/
```

只导出不启动网页时去掉 `--serve`。`--queries` 可以传任意多个 `.sql` 文件或目录
（目录会递归查找 `*.sql`），`--schema` / `--json-catalog` 均可传多个文件。

### 验证示例确实是合法 sqlite SQL

```bash
.venv/bin/python -I examples/run_queries_in_sqlite.py
```

脚本在内存 sqlite 中建表、灌种子数据并执行 `examples/queries/` 下除 `errors/` 外的全部文件。

### 运行测试

```bash
.venv/bin/python -m pytest tests/ -q
```

### 作为库调用

```python
from sql_lineage import LineageRunner, SchemaCatalog, ImpactAnalyzer

catalog = SchemaCatalog()
catalog.load_ddl_file("schema.sql")

result = LineageRunner(catalog).run(query_paths=["queries"])

# 正向：某个查询块每个输出列的完整来源路径
block = result.blocks["queries/q.sql#select:q@1"]
print(block.output_columns[0].lineage)

# 反向：修改 orders.amount 会影响哪些查询/输出列
impact = ImpactAnalyzer(result.blocks).impact_of("orders", "amount")
print([(p.block_name, p.output_column) for p in impact.value_impacts])
print([(p.block_name, p.output_column) for p in impact.predicate_impacts])
```

## 表结构输入格式

1. sqlite DDL：`CREATE TABLE name (col TYPE, ...)`（可含 `PRIMARY KEY` / `NOT NULL` 等约束）
2. JSON 目录：

```json
{
  "tables": [
    {"name": "users", "columns": ["id", "name"]},
    {"name": "main.orders", "columns": ["id", "user_id", "total"]}
  ]
}
```

名称按 sqlite 语义大小写不敏感；查询里写限定名 `main.users` 可以匹配目录里的裸名 `users`。

## 导出产物

| 文件 | 内容 |
| --- | --- |
| `lineage.json` | 全部查询块、输出列、带中间步骤与源码位置的血缘树、未解析项、反向影响索引 |
| `lineage_edges.csv` | 拍平后的 value/predicate 边，每个中间一跳一行 |
| `unresolved.csv` | 所有未解析项：类型、说明、文件行列、SQL 片段 |
| `summary.csv` | 每个查询块的输出数、值/条件基础字段集合、未解析计数 |

## 设计要点

- **真实计算而非调用解析器自带 lineage**：sqlglot 只负责词法/语法解析与 AST；作用域、
  列归属、跨查询关系全部在 `analyzer.py` 中显式计算（sqlglot 自带 `lineage` 模块依赖
  `qualify` 优化过程且不区分 value/predicate，不满足需求）。
- **词法作用域**：每个查询块一个 `Scope`，父指针串联；CTE 重名时内层绑定遮蔽外层，
  每个块有全局唯一 `block_id`，物理上不可能串关系。
- **路径即树**：输出列挂一棵 `LineageNode` 树，多来源表达式（`a || b`、`CASE`、
  聚合、UNION 多分支）保留全部来源；跨块引用时深拷贝内层输出树并按引用点重标角色。
- **位置推导**：sqlglot 30 仅在叶子节点（Identifier/Literal/Star）记录行列，复合节点
  的源码区间取其全部带位置后代的并集；语句级位置再由 runner 重映射回整文件坐标。
- **语句切分**：先用 sqlite tokenizer 按顶层分号切词，字符串字面量/注释中的 `;` 不会误切。
