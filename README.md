# APNG 逐帧合成小工具

本地运行的 APNG（动画 PNG）逐帧合成器：每帧是一张 RGBA 图块，工具把图块按位置与
覆盖方式画到透明画布上，实时显示完全合成的画面，最后导出真正的 RGBA APNG 并**回读
校验**每一帧的完整画面。技术栈：Python 3.10+、PySide6、Pillow、NumPy、
[pyAPNG](https://github.com/eight04/pyAPNG)。

界面预览（`tools/screenshot.py` 离屏渲染）：

```
┌ 帧时间线 ─┬ 原始图块 │ 位置边界 │ 完整合成画面 ─┐
│ 1. …      │                                     │
│ 2. …      ├ 所选帧参数            │ 画布与循环  ┤
└───────────┴ 播放控制 ──────────────────────────┘
```

## 快速开始（macOS）

```zsh
git clone <repo> && cd repo
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m apng_editor          # 启动界面
```

或者直接双击 `run_mac.command`（首次运行会自动建 venv 并装依赖；若被 Gatekeeper
拦截，右键 → 打开，或在终端执行 `./run_mac.command`）。

依赖（`requirements.txt`）：

| 包 | 用途 |
| --- | --- |
| `PySide6` | 桌面界面 |
| `pillow` | PNG 编解码、导入普通 PNG 图块 |
| `numpy` | 合成运算与逐像素校验 |
| `apng` | APNG 容器写入（成熟库，不自实现格式编码） |

开发/验证依赖：`.venv/bin/python -m pip install -r requirements-dev.txt`。

## 界面与功能

### 帧与画布

* 画布宽/高各自 1–512 像素，最多 20 帧（`apng_editor/model.py` 中统一校验）。
* 每帧：RGBA 图块、画布内位置 `(x, y)`、显示时长（1–65535 ms）、覆盖方式、处置方式。
* 「生成图块…」在程序内生成带半透明缺口的图块；「导入 PNG…」可把普通 RGBA PNG
  当作图块导入。添加、复制、移除、上移/下移都即时刷新。
* 越界、时长为 0 或超范围、画布缩小到放不下已有图块等情况都会在窗口底部
  **红条明确报错**，并把输入控件恢复为原值，不会静默截断。

### 覆盖与处置

* 覆盖方式
  * **直接替换覆盖区域**：图块矩形内像素（含 alpha）原样写入画布。
  * **按透明度叠加**：标准 source-over 合成，`a_out = a_s + a_d(1-a_s)`，
    `c_out = (c_s·a_s + c_d·a_d(1-a_s)) / a_out`，全程 8 位整数、四舍五入。
    半透明像素保持实际透明度，不会被压成不透明。
* 处置方式（本帧显示完之后、下一帧之前执行，且**只作用于本帧图块矩形**）
  * **播放后保留**：画布不变。
  * **清空本帧区域**：把图块矩形清为透明黑 `(0,0,0,0)`。
  * **恢复到本帧之前画面**：把图块矩形恢复成画这一帧之前的画布内容。

### 三块预览

1. **原始图块**：图块本身，棋盘格表示透明；
2. **位置边界**：图块放到画布上的位置，红框标出覆盖范围与坐标；
3. **完整合成画面**：所选帧正在显示时的整幅画布，棋盘格表示透明背景。

合成函数每次都从「全透明画布 + 第 1 帧」开始顺序推进（`compose_project`），
预览不会复用浏览历史。因此从后往前跳、直接点中间帧，结果都与从头合成一致，
界面与测试都覆盖了这一点。

### 播放

* 播放/暂停、上一帧/下一帧；**暂停后时钟不再推进**。
* 每帧按自身时长显示，计时由 `PlaybackClock` 负责（与 Qt 解耦，可单测）。
* 循环次数：
  * `0` = **无限循环**，一直重复到手动暂停（界面与导出的 `acTL.num_plays = 0` 对应）；
  * `N > 0` = **有限循环**，从第 1 帧开始完整播放 N 遍后停在最后一帧。
* 暂停状态下修改早期帧的位置/时长/覆盖/处置，后续合成画面会立即按新参数重算；
  播放中修改同样生效（帧时长表会在下次显示时同步）。

### 导出与回读校验

导出使用 `apng` 库写 APNG，但采用**完整画布帧**（每帧整幅 8 位 RGBA、blend=source、
dispose=keep），不做 GIF 体积优化，也不依赖编码器的差量优化，因此每一显示时段的
画面就是一个确定性的合成结果。

点击「导出 APNG 并回读校验…」后：

1. 写入 `.png` 文件；
2. 用**独立实现的读取器** `apng_editor/apng_codec.py` 重新解析文件：自行解压、
   反 PNG 行过滤（None/Sub/Up/Average/Paeth），按 `fcTL` 的混合/处置规则重放，
   得到每个显示时段的完整画布；
3. 与导出前重新合成的画面**逐像素**比较（不跳过任何像素，因此棋盘格或红框一旦
   写进文件必然报错）；
4. 比较画布尺寸、帧数、循环次数与逐帧时长。时长以 `delay/1000` 写入，整数毫秒
   可无损表达；回读容差为 0.5 ms，仅用于吸收其它动画/重编码可能带来的毫秒舍入，
   并在结果窗口里明确说明。

结果窗口逐帧列出 `设定 ms / 回读 ms / 是否一致`，任何一项失败都会指出首个差异
像素的坐标与 RGBA 值。

## 内置样例

样例全部由代码生成（`apng_editor/samples.py`），「内置样例」下拉框可切换，
「恢复默认样例」随时回到默认的「半透明叠加」。

| 样例 | 演示内容 | 独立预期的关键像素 |
| --- | --- | --- |
| 半透明叠加 | 不透明红块 + 50% 蓝块按透明度叠加 | 重叠处 `(100, 15, 120, 255)`；红块外蓝色仍为 `(0, 0, 200, 128)` |
| 移动后清除 | 图块换位、旧区域清空、下一帧保留新位置 | 第 3 帧 `(5,5)` 仍是绿 `(30,170,80,255)`，`(45,45)` 透明，`(12,12)` = 黄 50% 叠绿 `(133,185,60,255)` |
| 恢复旧画面 | 遮盖帧用完即恢复旧内容 | 第 2 帧 `(20,20)` 为蓝，第 3 帧恢复红后叠 50% 白 = `(228,143,148,255)` |

这些期望值由测试里手写的逐像素公式 `expected_blend_over` 独立计算，
不是调用合成器再调一次。

## 验证

```zsh
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest               # 全部测试（Qt 使用 offscreen 平台）
.venv/bin/python -m apng_editor.demo     # 导出三组样例到 out/ 并逐帧回读
```

`pytest.ini` 已把 `testpaths` 设为 `tests/`；`tests/conftest.py` 在导入 Qt 前设置
`QT_QPA_PLATFORM=offscreen`，因此终端里跑 GUI 测试不需要显示器。

关键验证点（对应 `tests/`）：

* **跳帧一致性**：`test_direct_seek_equals_forward_composition`、
  `test_backwards_and_forwards_seek_are_identical`、GUI 的
  `test_direct_middle_selection_matches_forward_composition`——直接跳到中间帧、
  反复前后跳，画面都与顺序合成相同。
* **半透明叠加**：`test_alpha_overlap_sample_matches_independent_pixels`，
  以及随机图块对照浮点参考实现（误差 ≤ 1/255）的
  `test_alpha_over_matches_float_reference_on_random_tiles`。
* **移动后清除 / 恢复旧画面**：对应样例测试 + 只清本帧矩形的边界测试。
* **导出回读**：`tests/test_export_verify.py` 用独立 reader 校验三组样例的每个
  显示时段，并验证画布、时长、循环次数；`test_verify_detects_*` 确认校验器能
  发现画面、时长、循环被篡改。
* **播放语义**：`tests/test_playback_clock.py` 覆盖逐帧时长、有限循环 N 遍后
  停在最后一帧、无限循环不结束、暂停不推进、开始播放从第 1 帧起。

外部交叉检查（可选，若装了 ffmpeg）：

```zsh
.venv/bin/python -m apng_editor.demo --output /tmp/apng_out
.venv/bin/python tools/ffprobe_check.py /tmp/apng_out/*.png
```

会输出 `codec_name=apng`、`pix_fmt=rgba` 与解码帧数，与工具内回读结果一致。

## 项目结构

```
apng_editor/
  model.py       数据模型、校验、source-over 合成、逐帧合成
  exporter.py    APNG 写入（完整画布帧）+ 回读校验报告
  apng_codec.py  独立 APNG 读取器（解压/反过滤/重放混合与处置）
  playback.py    Qt 无关的播放时钟（逐帧时长、循环次数）
  imaging.py     导入 PNG、程序生成图块、棋盘格
  samples.py     三组内置样例与手写期望公式
  demo.py        CLI：导出样例并校验
  ui/            PySide6 主窗口与画布预览控件
tests/           模型、导出、播放、GUI 测试
tools/           离屏截图、ffprobe 交叉检查
```

## 已知边界

* 只编辑本工具生成的工程；不解析/编辑外部 APNG 的既有帧结构（导入的普通 PNG
  仅作为图块）。
* 不做 GIF 体积优化、局部区域压缩或动画差分编码——这是明确的设计取舍。
* 导出时每帧强制为完整画布、`blend=source`、`dispose=keep`，混合与处置语义在
  导出前已经落实为像素；因此导出的 APNG 在任何播放器里都等价于预览画面。
* 时长以整数毫秒输入、以 `n/1000` 秒写入，无舍入；回读比较容差 0.5 ms 仅用于
  解释外部重编码可能出现的毫秒级差异。
