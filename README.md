# 漏洞复现证据工作台

一个**纯本地、纯静态**的漏洞复现证据整理/比对/导出工具。用于把安全同事收到的
复现材料（请求样本、响应、日志、配置片段、说明文档）结构化地管理起来，
在**不执行任何危险内容、不发起任何网络请求**的前提下完成证据整理与脱敏交付。

## 安全红线

- **零网络出站**：代码不 import 任何主动连接库（无 `urllib.request`、`http.client`、
  `requests`、`socket.connect` 等）。Web 界面只绑定 `127.0.0.1`，并拒绝非回环对端。
- **零命令执行**：不使用 `subprocess`、`os.system`、`eval`、`exec`、`pickle`。
  导入文件一律按不可信数据做文本/字节解析，绝不执行其中的命令或脚本。
- **零第三方依赖**：仅使用 Python 标准库，离线可运行，无供应链风险。
- **zip 攻击防护**：校验成员路径，拒绝绝对路径与 `..` 跳转（zip slip），
  全程不落地解压；单文件/整包均有体量上限。
- **脱敏兜底**：导出时做「正则脱敏 + 结构化字段脱敏」双重处理，并对最终产物
  再跑一次泄露自检，确认命中数为 0 才允许导出。

`tests/test_safety.py` 以 AST 静态扫描整个包，自动守护上述红线。

## 功能与需求对照

| # | 需求 | 实现位置 |
|---|------|----------|
| 1 | 导入多个复现包，识别请求/响应/日志/配置/说明，保留校验值与来源路径 | `importer.py`、`classifier.py`（sha256+md5、`source_path`） |
| 2 | 结构化解析+语法高亮；单文件损坏不影响其他文件；整包不可读保留当前工程 | `parser.py`（fallback 状态）、`importer.py`、前端 `app.js` 高亮 |
| 3 | 时间/地址/编号跨证据关联；重复证据标识而非覆盖 | `correlation.py`、`importer.py`（`duplicate_of` 标记，两份都保留） |
| 4 | 记录步骤/预期/实际/结论；结论变更保留历史 | `project.py`（`conclusion_history` 只增不删） |
| 5 | 默认隐藏凭据/密钥/PII；导出前显示待脱敏项；导出不带原文 | `masking.py`、`export.py`（导出前泄露自检） |
| 6 | 两包文件差异+关键字段差异，区分缺失/修改/仅顺序变化 | `diff.py`（added/removed/modified/order_only/renamed/unchanged） |
| 7 | 工程保存/重开，含证据索引、标注、脱敏设置、操作记录；坏工程不清空当前 | `project.py`（原子写、格式校验、先加载后替换） |
| 8 | 本地样例与测试，覆盖损坏文件/重复证据/脱敏导出/工程恢复 | `scripts/make_samples.py`、`tests/` |

## 目录结构

```
vuln_workbench/
  safety.py        安全常量、zip 路径校验、体量限制
  models.py        数据模型 (dataclass, 全部可 JSON 序列化)
  classifier.py    文件大类识别 (扩展名 + 内容嗅探)
  parser.py        HTTP/JSON/日志/配置/Markdown 解析, 失败退化不抛异常
  masking.py       脱敏规则、文本/结构化脱敏、泄露扫描
  correlation.py   时间/IP/URL/编号跨文件关联
  importer.py      目录/zip 导入, 逐文件容错, 重复证据标记
  diff.py          两包差异比较
  project.py       工程原子保存/打开、标注与结论历史
  export.py        脱敏导出 (JSON/Markdown) + 泄露自检
  server.py        127.0.0.1 本地 HTTP API 与静态界面
  cli.py           命令行入口
  static/          原生 HTML/CSS/JS 界面 (无 CDN, 离线)
tests/             48 个 unittest 用例
scripts/make_samples.py  本地样例生成器
```

## 快速开始

需要 Python 3.10+，无需安装任何依赖。

### 方式一：Web 界面

```bash
python -m vuln_workbench serve --port 8811
# 浏览器打开 http://127.0.0.1:8811
```

界面中通过**本机绝对路径**导入目录或 zip（服务端本地读取，不上传文件）。

### 方式二：命令行

```bash
# 生成样例（含损坏文件、截断zip、重复证据、顺序变化等场景）
python scripts/make_samples.py --out samples

# 导入一个或多个复现包到工程（工程不存在会自动创建）
python -m vuln_workbench import work/demo.json samples/sample_pkg_a samples/sample_pkg_b

# 比较工程内两个包
python -m vuln_workbench compare work/demo.json sample_pkg_a sample_pkg_b

# 脱敏导出（.json 或 .md，自动做泄露自检）
python -m vuln_workbench export work/demo.json work/exported.json

# 查看工程摘要
python -m vuln_workbench info work/demo.json
```

## 运行测试

```bash
python -I -m unittest discover -s tests -v
```

`-I` 以隔离模式运行，忽略环境变量与当前目录隐式导入，配合 `tests/_bootstrap.py`
显式加入仓库路径，避免不可信目录下的同名模块（如伪造的 `json.py`）被加载。

## 工程文件格式

工程为单个 UTF-8 JSON，顶层带格式魔数 `vuln-workbench-project` 与版本号。
保存采用「同目录临时文件 + `os.replace` 原子替换」，不会写出半截工程。
打开时先完整加载并校验，**成功后才替换当前工程**——任何坏工程都不会清空正在使用的工程。

## 脱敏机制说明

1. **文本规则**：内置密码/口令（含中文「口令/密码」）、Bearer/Basic 凭据、
   AWS Key、JWT、PEM 私钥、通用 token、身份证、手机号、邮箱等规则，支持自定义正则。
2. **结构化脱敏**：HTTP 头数组、`header_lookup`、解析出的 JSON 树等，
   按字段名（`authorization`、`x-api-key`、`password` 等）上下文整体占位，
   避免敏感值藏在结构里绕过文本规则。
3. **查看原文需登记原因**，写入审计日志与操作记录。
4. **导出泄露自检**：对最终导出 JSON 重新全规则扫描，残留命中即拒绝导出。
