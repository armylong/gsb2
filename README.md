# tileviewer — 本地单帧 RGB 影像分块预览器

用 Python + PySide6 写的本地展板/大幅面影像查看工具：先生成无损预览金字塔，
每层再按固定边长切块；查看时可从全图缩放到原始像素，并始终以**原图坐标**
为准。适合核对"缩小图和原图坐标是否对得上"，再决定如何分块处理。

只接受**单张、单帧、8-bit RGB** 的本地文件（PNG / TIFF / JPEG / BMP / WebP…）。
灰度、RGBA、16-bit、多页 TIFF、动画会直接报错，而不是悄悄转换。

## 快速开始

```bash
python3 -m venv .venv
.venv/bin/pip install PySide6 pillow tifffile numpy pytest

# 生成示例图（4001×2501，奇数尺寸 + 1px 细网格 + 角点编号）
.venv/bin/python -m tileviewer.sample --out samples/sample_grid_4001x2501.png

# 打开示例图
.venv/bin/python -m tileviewer samples/sample_grid_4001x2501.png

# 无显示器环境 / CI 自检：生成、切块、拼接比对、跨块导出
.venv/bin/python -m tileviewer.selfcheck

# 测试
QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest -q
```

缓存默认位于 `~/Library/Caches/tileviewer`（Linux: `~/.cache/tileviewer`），
可用 `--cache DIR` 或环境变量 `TILEVIEWER_CACHE` 覆盖。

## 需求与实现对照

### 1. 多层预览 + 固定边长切块，奇数尺寸保住全部像素

* `tileviewer/geometry.py: level_sizes()` 用**向上取整**逐层减半：
  `nw = ceil(w/2)`，所以 4001 宽的图最后一层是 10 而不是 9，最右一列
  不会被丢；每层宽度严格是上一层的 `ceil` 值。
* 每层切块同样用向上取整：`cols = ceil(width / tile_size)`，
  最后一行/列只包含有效像素（`LevelGeometry.core_rect()`），
  块尺寸可以小于 `tile_size`。
* 所有块的核心矩形**恰好不重不漏**地覆盖整层：
  `tests/test_geometry.py::test_core_tiles_cover_level_exactly`、
  `tests/test_alignment.py::test_odd_tail_pixels_are_kept_in_every_level`
  对每层每个像素计数验证。

### 2. 从全图缩放到原始像素，按鼠标处的原图坐标切换层级

* 视图状态只保存**原图坐标**下的中心点与缩放（屏幕像素 / 原图像素），
  见 `ViewerWidget.center` / `zoom`。层级只决定"画哪一层块"，
  不参与坐标换算，因此 `set_level()` 不需要改动视图，
  鼠标下的原图坐标在换层后完全不变。
* `ViewerWidget._apply_auto_level()` 用 `choose_display_level()`：
  在已完整生成的层里选缩放比例最接近当前缩放的一层。
* 可手动锁层（关闭"自动选层"、在弹出的图层面板双击、或用 `当前层` 微调）。
* **参照点**：工具栏"锁定参照点"把当前光标位置钉成一个原图坐标十字准星，
  换层时它仍停在原图的同一处特征上，并在标签里同时显示该层的层内坐标，
  见 `tests/test_viewer.py::test_probe_stays_on_the_same_screen_point_across_levels`。
* 网格线（`显示网格线`）：块边界（橙）+ 原图像素刻度（浅蓝，间隔随缩放
  自动取 1/2/5×10ⁿ，并标注原图坐标）+ 图像外框。
* 缩放全部以光标为锚点：`zoom_by(factor, anchor)` 保持
  `anchor` 下的原图坐标不变。

### 3. 每块保留邻边，区分正式范围 / 重叠边，并能与整层参考比对

* `CacheConfig.margin` 给每块额外保留邻边；磁盘上的块 PNG 存的是
  **含边全块**（`TileSpec.full`），层级清单里同时记录 `core` 与 `full`。
* 渲染时只使用核心区域作"正式范围"；缩小时改为从含边全块采样并按核心裁剪
  （`viewer.py` 的 `if minifying and tile.full != tile.core`），
  既用上了邻边又不会重复绘制。
* "显示邻边"把重叠区涂成粉色并勾出核心边界；状态栏/侧栏给出
  左/上/右/下邻边的实际像素数（在图像边缘处邻边会自动收缩）。
* 拼接校验：`CacheManager.compare_level()` 逐块读取核心、与
  `build_level_array()` 直接从原图缩放得到的参考图逐像素比对，
  返回不一致像素数与最大通道差；UI 里"校验选中层/全部完整层级"。
  `stitch_tiles()` 也提供整层拼回接口，供测试与外部脚本使用。
* `python -m tileviewer.selfcheck` 会打印每层比对结果，全部为
  "match reference exactly" 才算通过。

### 4. 任意矩形选区导出原图区域（跨块、跨图边仍按原图定义）

* 左键拖动划选，选区以**原图连续坐标**保存，释放时向外取整为像素矩形
  （`selection_pixel_rect()`），因此可以跨任意多块、甚至跨出图外。
* `tileviewer/exporter.py: export_region()` 直接读原图数组，不经过任何块：
  * `exact` 模式（默认）：输出尺寸 = 选区尺寸，图外部分按填充色补；
  * `clip` 模式：裁到图内交集，尺寸随交集变化。
* 导出 PNG/TIFF 为无损；透明补边只能存 PNG/TIFF，选 JPEG 会明确拒绝。
  导出文件名默认带 `x_y_w_h`，日志里记录选区与图外像素数。
* `tests/test_export.py` 覆盖了跨块、跨四边、完全在图外、两种尺寸模式。

### 5. 可取消、未齐层有状态、可续传，同名不同内容不沿用旧块

* 生成在 `QThread` 里跑（`workers.py`），`CacheManager.generate()` 每个块
  开始前检查取消标志；取消后已完成的块保留，`level.json` 不写，
  该层显示为**未完成 (n/m 块)**，再次点击"生成缺失层级"从缺的块继续。
* 层级状态：`完整 / 未完成 / 未生成 / 已过期`，表格里每层一行，
  双击即可查看该层（缺块会涂灰标出）。
* 缓存目录以**文件内容 SHA-256** 命名：`<root>/<sha256>/t512_m16_lanczos/`。
  同名但内容变了 → 新目录、旧块完全不复用；"重新读取当前文件"会立即
  重新计算哈希并重新列出状态。
* 另有块级完整性校验：清单记录每块字节数与 SHA-256，磁盘上被改动/截断的
  块会让该层变为**已过期**，重新生成时整层重写而不是混用新旧块
  （`tests/test_cache.py` 覆盖篡改、缺块、续传、强制重建）。

## 示例样图

`python -m tileviewer.sample`（或 UI 的"生成并打开示例图像"）生成
4001×2501 的确定性样图：

* 奇数宽高，每层都会出现"最后一块尺寸不整"的情况；
* 每 10px 一条细网格，50px 中网格，100px 粗网格；
* 四角有编号标记 `TL 0,0` / `TR 4000,0` / `BL 0,2500` / `BR 4000,2500`，
  角像素颜色固定且最后落笔，不会被文字底衬盖住；
* 内部 6 个编号控制点带坐标文字，便于验证导出裁剪位置；
* 顶部/左侧有原图坐标标尺。

## 代码结构

```
tileviewer/
  geometry.py   矩形、层级尺寸、切块几何、层级选择（纯函数，无 Qt）
  source.py     单帧 RGB 加载与校验、内容哈希、缓存目录
  cache.py      金字塔生成/取消/续传/状态/拼接比对（无 Qt）
  exporter.py   按原图坐标导出（无 Qt）
  sample.py     确定性示例图
  selfcheck.py  无界面端到端自检
  viewer.py     可缩放画布：层级切换、网格、邻边、选区、参照点
  workers.py    生成/校验的后台线程
  main_window.py 主窗口与侧栏
  __main__.py   入口：python -m tileviewer [image] [--cache DIR]
tests/          83 个测试用例（几何、加载、缓存、导出、对齐、UI、主窗口）
```

## 操作系统与依赖

macOS / Linux 桌面（Qt offscreen 也可在无显示器环境跑测试）。
依赖：PySide6、Pillow、tifffile、numpy；测试另需 pytest。

## 已知边界

* 不支持多页 TIFF、动画、灰度/16-bit/带 alpha 的源图；
  EXIF orientation ≠ 1 时只提示、不自动旋转，坐标始终是文件里的原始像素网格。
* 预览层是"从原图直接缩放"的参考金字塔，块只是它的切片；
  若后续需要与真正分块处理的结果对比，请以 `compare_level()` 的参考图为准。
* 缓存不自动清理；"清空缓存"只删当前图像 + 当前分块设置。
