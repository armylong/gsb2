# 本地采集任务编排工具

几套本地采集脚本有先后依赖、共享接口额度, 手工按顺序启动容易跑乱。本工具用
**Python 标准库 + SQLite** 实现本地任务编排: 从配置读取任务与依赖, 按依赖和
资源容量自动调度, 带一个可操作的本地网页。不依赖任何外部调度平台, 命令只
来自本地配置文件, 网页仅提供启动和查看入口, 不接受远程命令。

## 快速开始

```bash
# 启动服务(只需 Python 3.8+, 无第三方依赖)
python3 run_server.py --port 8000

# 打开页面
open http://127.0.0.1:8000
```

页面上点击 demo_flow 的「启动运行」即可看到完整演示。

## 运行测试

```bash
python3 -m unittest discover -s tests -v
```

17 个用例覆盖: 配置校验(缺失依赖/环/资源不可满足)、依赖顺序、失败阻塞下游、
重试留痕、超时杀进程组、资源串行、取消清理、崩溃恢复标记未知、节点重跑与
结果继承、配置变更标记、多次运行目录隔离。

## 流程配置(flows/*.json)

```json
{
  "name": "demo_flow",
  "settings": {"max_parallel": 4},
  "resources": {"api_quota": 2},
  "tasks": [
    {
      "name": "fetch_users",
      "command": "python3 demo/collector.py ok --duration 3",
      "timeout": 30,
      "retries": 1,
      "retry_delay": 1,
      "needs": {"api_quota": 1},
      "depends_on": []
    }
  ]
}
```

- `resources`: 命名资源及容量(如接口并发额度), 全局生效
- `needs`: 任务运行期间占用的资源数量, 不够就排队
- `timeout` 秒、`retries` 重试次数、`retry_delay` 重试间隔秒
- `depends_on`: 上游任务名列表, 全部成功后本任务才可派发
- 命令中可用占位符: `{run_id}` `{run_dir}` `{task_dir}` `{attempt}`

启动前校验: **缺失依赖、依赖环、超过容量的资源需求(永远无法满足)** 都会
在页面流程列表中以红字显示, 非法配置不能启动。

## 功能与对应实现

| 需求 | 行为 |
|---|---|
| 依赖与并行 | 上游全部成功才派发下游; 独立分支并行; 全局并发 + 各资源容量同时生效 |
| 失败阻塞 | 上游失败/取消后, 下游标记「被阻塞」并显示被谁阻塞, 不算执行失败 |
| 取消 | 停止派发, 对运行中任务的**整个进程组**先 SIGTERM 再 SIGKILL, 资源正确释放, 未开始的标记「未执行」 |
| 超时与重试 | 超时同样杀整个进程组, 不留后台旧进程; 重试产生新的 attempt 记录, 不覆盖上一次 |
| 尝试留痕 | 每次尝试记录状态/起止时间/退出码/独立日志文件(`data/runs/run_<id>/<任务>/attempt_<n>.log`), 页面可增量查看进行中的日志 |
| 崩溃恢复 | 服务重启后, 上次仍标记运行中的运行→「服务中断」, 任务→「结果未知」(绝不算成功); 页面确认后才生成恢复运行重跑这些任务及下游 |
| 节点重跑 | 选失败/被阻塞/未知节点, 重跑它及受影响下游; 不相关的成功分支以「继承结果」保留并标注来源运行; 每次重跑记录当时配置, 配置与来源运行不同会标记「结果混合了不同配置」并给出警告 |
| 多次运行 | 同一流程可多次运行, 各自独立的日志/产物目录与取消操作, 页面能看到每次实际执行了哪些节点(carried 表示继承未执行) |

## 演示流程说明(flows/demo_flow.json)

- `fetch_users` / `fetch_orders`: 各占 1 份 api_quota, 并行执行
- `fetch_flaky`: 首次必失败, 重试后成功(演示失败后重跑、尝试留痕)
- `fetch_slow`: 运行 30s 但 timeout=4s, 重试 1 次仍超时(演示超时杀进程)
- `fetch_tree`: 派生子进程后长时间运行, 6s 超时(演示整棵进程树被清理)
- `hog_a` / `hog_b`: 各占 2 份 api_quota(容量只有 2), 演示资源竞争串行
- `report_slow` / `report_tree`: 上游失败, 显示「被 fetch_slow 阻塞」
- `agg_main` / `final`: 正常汇聚

想演示取消: 启动运行后几秒内点「取消」。想演示崩溃恢复: 运行中
`pkill -9 -f run_server.py`, 再重启服务, 页面上会出现「服务中断」的运行和
「确认重跑未知任务」按钮。

## 目录结构

```
run_server.py            服务入口
orchestrator/
  config.py              配置加载与校验(缺失依赖/环/资源不可满足)
  db.py                  SQLite 存储(runs / run_tasks / attempts)
  scheduler.py           调度循环: 派发、回收、超时、重试、取消、收尾
  server.py              HTTP API 与页面服务(仅本地 127.0.0.1)
  web/index.html         操作页面
demo/collector.py        模拟采集命令(ok/fail/flaky/tree)
flows/demo_flow.json     演示流程配置
tests/                   自动化测试
data/                    运行期产物(SQLite + 每次运行的日志目录)
```
