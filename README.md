# apifuzz — 本机接口输入校验模糊测试工具

面向"准备对外提供的接口，先在本机验证输入校验会不会被异常数据绕过"的场景。
纯 Python 标准库实现（Python 3.8+），**无第三方依赖、不访问任何真实外部网站**。

## 一条命令运行完整演示

```sh
./run_demo.sh
```

脚本会：在后台线程启动只监听 `127.0.0.1` 的测试服务 → 执行模糊测试（含访问范围
探测、失败分组、样本缩减）→ 用记录的环境准备步骤重放全部失败分组 → 输出
JSON + Markdown 报告到 `reports/`。端口自动选择，也可用 `APIFUZZ_DEMO_PORT` 指定。

运行测试：

```sh
python3 -I run_tests.py
```

## 目录结构

```
apifuzz/            模糊测试工具
  config.py         JSON 配置加载与严格校验
  generator.py      确定性输入生成（7 类规则，固定种子可重复）
  client.py         白名单 HTTP 客户端（主机/端口/跳转/预算限制）
  runner.py         环境准备、前后置条件、目标请求、清理（清理失败即停止）
  oracle.py         判定：正常拒绝 vs 服务异常/契约违反/状态违反/传输异常
  grouping.py       失败指纹与分组（不只看状态码）
  reducer.py        失败样本缩减（删字段/缩短/拍平嵌套，严格复现验证）
  replay.py         重放：仍可复现 / 未复现 / 无法判断
  report.py         JSON + Markdown 报告，凭据默认遮盖
  cli.py            fuzz / replay 子命令
testservice/        只在本机运行的测试服务（含 4 个刻意植入的缺陷样例）
configs/demo.json   演示配置（接口说明、样本、约束、前后置条件、清理、白名单）
tests/              59 个单元/集成测试
demo.py             一条命令演示的 Python 入口
run_demo.sh         Shell 包装（python3 -I demo.py）
```

## 独立使用

```sh
# 1. 启动本机测试服务（仅监听 127.0.0.1）
python3 -I run_testservice.py --port 8765

# 2. 执行模糊测试（另一个终端）
python3 -I apifuzz_cli.py fuzz -c configs/demo.json -s 20261115 -o reports/

# 3. 按报告重放失败分组
python3 -I apifuzz_cli.py replay -c configs/demo.json \
    -r reports/fuzz_report_XXXXXXXX_XXXXXX.json
python3 -I apifuzz_cli.py replay -c configs/demo.json -r <报告> -g G002
```

## 需求与实现对照

| 需求 | 实现位置 |
| --- | --- |
| 1. 字段缺失/类型变化/边界长度/嵌套结构/字段约束，固定种子 | `generator.py`：missing/type/boundary/nested/unknown/constraint/malformed；RNG 按 `(seed, endpoint)` 独立播种 |
| 2. 只访问白名单本机服务，跳转不越界，次数/并发/耗时上限 | `client.py`：发送前与每次跳转跟随前双重校验主机+端口；`Budget` 计数与截止时间；引擎线程池限并发；不读环境代理 |
| 3. 区分正常拒绝与服务异常/契约违反/意外数据修改；前后置条件与清理可配，清理失败停止 | `oracle.py` + `runner.py`：setup/precondition/state_query/postcondition/cleanup；`CleanupFailure` 中止该接口剩余用例 |
| 4. 同类失败归组、保留代表请求响应，不只按状态码 | `grouping.py`：指纹 = endpoint+verdict+状态码+响应骨架+归一化错误消息+规则+触发路径 |
| 5. 删字段/缩短/简化嵌套，最终样本必须仍复现同类失败；恢复正常或超时不算成功 | `reducer.py`：候选只有复现同一指纹才接受；TRANSPORT_ERROR/INDETERMINATE 记为"无法判断"并拒绝；最终再独立验证一次，失败即回退原样本 |
| 6. 重放入口，区分仍可复现/未复现/无法判断 | `replay.py`：复用配置中的 setup/cleanup 与报告中的原始请求；三态结论 |
| 7. 报告保留生成规则、种子、分组、缩减前后样本、验证次数、证据，凭据遮盖 | `report.py` + `masking.py`：结构化递归遮盖 + 原始报文正则遮盖 |
| 8. 测试服务含正常拒绝、嵌套异常、状态依赖异常，测试覆盖分组/缩减/重放/范围 | `testservice/server.py` 三个植入缺陷 + `tests/` 59 个测试 |

## 判定（verdict）语义

- `REJECTED`：服务按声明正常拒绝（4xx 且符合响应契约）——不是失败
- `SERVER_ERROR`：5xx / 未捕获异常
- `CONTRACT_VIOLATION`：状态码或响应结构违反接口声明
- `STATE_VIOLATION`：响应看似正常，但后置状态检查发现数据被意外修改
- `TRANSPORT_ERROR`：连接失败/超时等传输层问题
- `SCOPE_BLOCKED`：目标超出白名单，客户端在发送前拦截
- `INDETERMINATE`：前置条件不满足等，无法判断

## 测试服务中刻意植入的缺陷

1. `POST /api/users`：嵌套字段 `profile.geo` 收到 list/dict 时抛 `AttributeError` → 500
   （正常错误输入应返回 400）。
2. `PUT /api/users/{id}`：未声明字段 `is_admin`/`role` 被静默持久化，响应仍 200，
   只有后置条件能发现（状态违反）。
3. `POST /api/accounts/{id}/transactions`：账户 closed 时非字符串 `memo` 触发
   `TypeError` → 500；同一输入在 active 账户上只得到 400（状态依赖异常）。
4. `GET /api/redirect`：302 跳转到范围外地址，用于验证跳转拦截。

## 安全边界

- 工具不使用环境代理变量，不跟随到白名单外的主机/端口/协议，拦截不消耗请求预算。
- 测试服务仅绑定 `127.0.0.1`，数据保存在内存，进程退出即清空。
- 所有凭据字段（默认匹配 password/token/secret/authorization 等名称，外加配置
  `secret_fields`）在报告中以 `***MASKED***` 遮盖，包括畸形原始报文。
