# 合同关键字段抽取工具

本地运行的合同字段抽取与人工核对工具：规则可配置、结果可回溯到原文位置、
支持扫描件本地 OCR，**不依赖任何在线识别服务**。

## 功能

- **文档导入**：文本型 PDF / DOCX / TXT 直接解析；扫描 PDF 与图片走本地
  tesseract OCR。每个文档单独显示读取状态，无法识别的文件给出具体原因。
- **规则配置**：字段名称、匹配方式（正则 / 关键词 / 区域限定）、多值字段均可
  配置。规则内容哈希即版本号，修改规则生成新版本，旧结果不会被误认为新规则结果。
- **来源回溯**：每个字段结果记录页码、行号和坐标（扫描件为图片区域），
  点击结果跳回原文并高亮对应行 / 区域。
- **格式校验**：日期、金额、编号内置校验。缺失（missing）、多候选（multiple）、
  格式错误（invalid）严格区分，多候选全部保留，**绝不自动选第一个**。
- **人工修正**：保留原始值、修正值、操作者、时间；重新抽取不丢已确认修正。
- **批处理**：批量处理、暂停 / 恢复（进度落库，重启可续）、只重试失败文档。
- **筛选导出**：按字段状态筛选；导出已确认结果与异常清单 CSV，
  每行含文档 ID、文件名、页码、规则版本，可完整追溯。

## 运行

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# 扫描件 OCR 需要本地 tesseract（含 chi_sim 语言包）：
#   macOS: brew install tesseract tesseract-lang
.venv/bin/python run.py            # 打开 http://127.0.0.1:5000
```

## 样例与测试

```bash
# 生成虚构样例（版式变化 / 重复候选 / 扫描件 / 损坏文件，无真实隐私）
.venv/bin/python -m sample_data.make_samples
# 运行测试（覆盖版式变化、重复候选、识别失败、人工修正、暂停恢复、导出追溯）
.venv/bin/python -m pytest tests/ -q
```

## 规则配置示例

```json
{
  "name": "采购合同规则",
  "fields": [
    {"name": "合同编号", "kind": "id", "multi": false,
     "match": {"method": "keyword", "keywords": ["合同编号", "协议编号"],
               "pattern": "[A-Za-z]{2,4}-\\d{4}-\\d{3,4}"}},
    {"name": "签订日期", "kind": "date", "multi": false,
     "match": {"method": "keyword", "keywords": ["签订日期"],
               "pattern": "\\d{4}年\\d{1,2}月\\d{1,2}[日号]?|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}"}},
    {"name": "合同总金额", "kind": "amount", "multi": false,
     "match": {"method": "keyword", "keywords": ["总金额"],
               "pattern": "[¥￥]?\\s?\\d[\\d,]*(\\.\\d{1,2})?\\s?元?"}},
    {"name": "付款批次", "kind": "text", "multi": true,
     "match": {"method": "keyword", "keywords": ["付款批次"],
               "pattern": "第?[一二三四五六七八九十\\d]+[期批]"}}
  ]
}
```

- `method`: `regex`（正则）/ `keyword`（关键词+可选正则）/ `region`（配合
  `page`、`line_range`、`bbox` 限定区域；区域参数也可叠加在其他方式上）
- `kind`: `text` / `date` / `amount` / `id`（id 可用 `validate.id_pattern` 自定义）
- `multi: true` 表示多值字段，收集全部有效候选

## 目录结构

```
extractor/          应用包（ingest 读取 / extract 抽取 / jobs 批处理 / export 导出 / app 网页）
sample_data/        虚构样例生成器
tests/              pytest 测试
run.py              启动入口
data/               运行数据（SQLite、上传原件、页面图像，不入库）
```
