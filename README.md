# pcaprecon — 离线流量会话重组与 HTTP 还原工具

纯 Python 标准库实现的离线抓包分析工具。读取本地 pcap / pcapng 文件，把未加密
流量还原成可查证的 TCP 会话与 HTTP 请求/响应，并对乱序、重传、缺片、截断、冲突
片段等情况给出带证据位置的异常说明。**不依赖任何在线分析平台，也不修改原始抓包文件。**

## 设计边界

- 抓包文件解析（pcap classic、pcapng）、TCP 流重组、完整性判定、HTTP/1.x 解析
  全部在本仓库内手写实现；不使用 scapy / dpkt 等第三方解析库，运行时零第三方依赖。
- 只处理未加密流量。识别到 TLS / SSH 后仅报告连接元数据，不缓冲也不解码密文。
- 一切时间统计以抓包时间戳为依据（pcap 微秒/纳秒、pcapng 接口 ts_resolution）。

## 安装与运行

支持 Python 3.10+，无需第三方包。推荐用隔离模式运行，避免工作目录中被植入的
同名模块（如 `json.py`）被解释器加载：

```bash
python3 -I pcaprecon.py generate-samples samples/     # 生成小型样例抓包
python3 -I pcaprecon.py overview samples/keepalive.pcap
python3 -I run_tests.py                               # 运行全部测试
```

也可以常规安装后使用 `pcaprecon` 控制台命令：

```bash
pip install .
pcaprecon overview capture.pcap
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `overview` | 时间范围、端点、协议/传输分布、异常汇总 |
| `sessions` | 列出重组后的会话（含缺口、重传、截断、加密标记） |
| `messages` | 列出 HTTP 请求/响应及配对关系、完整性标记 |
| `anomalies` | 异常清单，每条带帧号、文件偏移、流偏移 |
| `trace` | 双向溯源：帧→会话，或消息/字节→原始帧与文件偏移 |
| `export` | 导出 JSON（`.json`）或文本（其他后缀）报告 |
| `generate-samples` | 本地生成 9 个覆盖各类异常的 pcap 样例 |

通用筛选参数（各查询命令均支持）：
`--endpoint`、`--start-after`、`--start-before`、`--method`、`--path`、
`--anomaly`、`--encrypted`。

```bash
python3 -I pcaprecon.py messages cap.pcap --method POST --path /login
python3 -I pcaprecon.py anomalies cap.pcap --anomaly STREAM_GAP
python3 -I pcaprecon.py trace cap.pcap --frame 42
python3 -I pcaprecon.py trace cap.pcap --message s000001-c2s-1
python3 -I pcaprecon.py export cap.pcap report.json
python3 -I pcaprecon.py --show-secrets export cap.pcap raw.json   # 显式关闭脱敏
```

## 重组与完整性规则（关键实现）

### TCP 流重组（`reassembly.py`）

- 以 SYN（或抓包中途连接的首个数据段）为相对偏移 0，32 位序列号按 RFC 793
  模 2³² 比较，支持序号回绕。
- **乱序**：未来段先挂起到 `pending`，缺口补齐后自动提升为连续前缀。
- **重复 / 重传**：与已重组字节完全一致的段计入 `duplicate_segments` /
  `retransmissions`，不重复占内存。
- **部分重叠重传**：首见字节优先；重叠区只追加新字节。
- **冲突片段**：同序列号携带不同字节时保留首见内容，记录 `TCP_CONFLICT`
  （含帧号与流偏移），绝不覆盖。
- **缺失片段**：未覆盖区间在 `finalize` 时物化为 `Gap` 与 `STREAM_GAP` 异常，
  缺口不做任何猜测填充。
- FIN / RST 决定连接关闭；抓包结束时仍打开的连接标记 `SESSION_TRUNCATED` /
  `CAPTURE_CUT_OPEN`。

### 会话划分（`sessions.py`）

会话是一条 TCP 连接的完整生命周期。同一端点组合重新发起 SYN 会生成**新的
session id**；连接内的 HTTP 流水线/keep-alive 复用仍属于同一会话。无 SYN 的
中途连接标记 `SESSION_NO_SYN`，偏移从首个捕获字节起算。

### HTTP 解析（`http_parser.py`）

- 手写 HTTP/1.x 状态机，仅读取流的**连续前缀**；遇到缺口或 EOF 时消息一定带
  `complete=false` 与明确的 `incomplete_reason`，不会拼出看似完整的请求。
- 支持一条连接上的连续/流水线请求、分段响应、`Content-Length`、
  `chunked` 传输编码（含 trailer）、无长度响应的 until-close 边界。
- 请求与响应按 HTTP/1.x 顺序配对；孤儿响应、无响应请求分别标记
  `HTTP_ORPHAN_RESPONSE` / `HTTP_UNPAIRED_REQUEST`。

## 脱敏（`redact.py`）

默认开启，终端展示与文件导出共用同一套代码路径，导出内容不可能比屏幕显示更多。

- 请求头：`Authorization`、`Cookie`、`Set-Cookie`、`X-Api-Key` 等整体遮蔽
- URL：userinfo、敏感 query 参数（token/password/secret/key 等）
- 请求体：`application/json` 与表单字段按敏感键遮蔽
- PII：邮箱、手机号、身份证号、银行卡号（保留后四位）

只有显式传入 `--show-secrets` 才输出原文。

## 来源追溯（`trace.py`）

- 每个重组字节区间都记录来源帧号与该帧记录在抓包文件中的字节偏移（`Fragment`）。
- `trace --frame N`：原始帧 → 所属会话、方向、角色（SYN/FIN/data…）。
- `trace --message ID` / `--bytes SESSION DIR OFFSET`：会话内容 → 贡献过字节的
  全部原始帧及偏移。

## 处理上限（`config.py` / `errors.py`）

文件大小、内存、帧数、会话数都有可配置上限（`--max-*`）。触限时抛出
`LimitExceeded` 并以退出码 2 **明确停止**，不会悄悄丢包；加 `--allow-partial`
才会输出带 `aborted` 标记的部分报告。

## 样例场景（`samplegen.py`，全部本地生成）

| 样例 | 覆盖点 |
| --- | --- |
| `reorder_retransmit` | 乱序、重复重传、字节级精确重组 |
| `keepalive` | 连接复用、流水线请求、请求/响应配对 |
| `missing_segment` | 缺片 → 显式 Gap，请求保持不完整 |
| `truncated_capture` | 文件中途截断、连接仍打开 |
| `chunked` | 分段到达的 chunked 响应 |
| `encrypted` | TLS 识别，仅展示连接信息 |
| `reconnect` | 同端点组合重连拆成两个会话 |
| `conflict` | 同序列号冲突，首见字节保留 |
| `unsupported_and_bad` | ARP/未知 ethertype 计数、坏帧不影响其他包 |

## 模块结构

```
pcaprecon/
  capture.py     pcap/pcapng 读取（含大端 pcapng），损坏记录带偏移计数
  decode.py      链路层/IP/TCP/UDP 解码，单包隔离错误
  reassembly.py  TCP 序列号空间重组引擎（含 FIN 缺尾判定、乱序溯源）
  sessions.py    连接生命周期、重连拆分会话、加密识别
  http_parser.py 缺口感知的 HTTP/1.x 解析与配对（含 1xx、负 CL 防护）
  redact.py      凭据/PII 脱敏（展示与导出共用）
  filters.py     端点/时间/方法/地址/异常筛选
  trace.py       会话↔原始帧双向溯源
  analyzer.py    流水线编排与全局统计
  report.py      JSON / 文本报告
  samplegen.py   本地 pcap 样例生成器
  tests/         39 个单元/集成/回归测试
```

## 已知限制

- **TCP 同时打开（simultaneous open）**：两端几乎同时发纯 SYN 的罕见场景会
  建立两个会话。常规客户端/服务器模型不触发；常规重连（含半开超时、复用端口
  与 ISN）均正确拆分。
- **IP 分片**：不做 IP 层分片重组，非首片记录 `IP_FRAGMENTED` 后跳过其传输层
  解析，不影响其他包。
- 仅实现 HTTP/1.x 明文解析；HTTP/2、HTTP/3（QUIC）与 TLS/SSH 仅报告连接元数据。

