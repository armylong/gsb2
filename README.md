# Parallax Lab — 两层深度视差预览工具

一个只依赖 **Python + numpy + PySide6** 的小工具：给一张静物图和手工深度图，按深度平移像素，做成前后两层的视差预览。样例场景全部在程序里生成，不需要外部图片。

打开后默认是 Still life + baseline −24 px + **Raw** 模式，能立刻看到洋红色的新暴露空洞；切到 Background fill 即可看补全效果。三个预设都能直接跑。

---

## 1. 启动说明（本地）

```bash
cd repo
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m parallax_lab               # 打开 GUI
python -m parallax_lab --verify      # 只跑数值验证，不打开窗口
```

要求：Python ≥ 3.10（开发环境 3.12 / macOS）。PySide6 首次启动约 1–2 秒。

无显示器环境（CI / 服务器）：

```bash
QT_QPA_PLATFORM=offscreen python -m parallax_lab   # 能启动，但没有窗口可交互
```

---

## 2. 一条可运行的验证命令

```bash
python -m parallax_lab --verify
```

即 `python -m parallax_lab --verify`，纯 numpy、不需要 GUI、退出码 0 表示全过。当前输出：

```
110/110 checks passed
```

它用**已知坐标**（遮挡方片 `x∈[120,209) y∈[60,150)`、前层 0.50 m、后层 1.00 m；斜坡条带 0.45–1.15 m）验证：

| 组 | 验证内容 |
|---|---|
| projection | `dx = −b/D` 的前/后层位移；恒定深度方片是**逐像素刚性平移**；任意点 probe 回源坐标 `(x−sf, y)` |
| slab holes | 在 b = ±20 / ±40 下，整张空洞掩膜与**仅由投影公式推出的预测**逐像素一致；边界让出的条带、接缝宽度 `|sf−sb|`、接缝只落在方片所在行、接缝起点 |
| fill | 补全后空洞为 0 残留；补全区内**不出现前景色**；所有 donor 都属于背景层且深度等于背景深度；抽样 donor 与真正最近背景像素的距离误差 ≤ 5%（chamfer 近似）；填进去的颜色确实来自 donor |
| layout diff | 左右移动后前↔后、洞↔非洞四个类别的计数互洽；同一输出像素在左右布局下解析到不同源点；接缝出现在相反两侧 |
| ramp | 近边位移 > 远边；空洞列与投影预测一致；每一段空洞都是整列高；接缝宽度 ≈ `|s_near − s_back|` |
| editable depth | gain 0.5 让前层深度减半、接缝按公式变宽；局部 brush +0.25 m 只影响该区域；深度重排后前/后层胜负翻转 |

另外有 17 个单元测试：

```bash
python -m unittest discover -s tests
```

---

## 3. 界面里怎么用

### 3.1 前后两层的可编辑深度 + 相机偏移

- 左侧 **Camera offset**：`Baseline (px @1 m)` 与 `Vertical (px @1 m)`。像素位移是 `dx = −baseline / depth`，所以同一 baseline 下**近的移动多、远的移动少**；baseline 为正表示相机右移、画面左移。也可以用 ← / → 方向键以 2 px 步进。
- 左侧两个 **Layer N** 分组，每组都有：
  - `Depth gain` / `Depth bias`：整层深度按 `D' = gain·D + bias` 改，重算实时生效。
  - `Brush radius` / `Brush delta`：在下方该层的深度缩略图上**拖动**即可局部加减深度（米），带圆形衰减。这是手工修深度图的入口。
  - `Reset layer` 清空该层所有编辑。
- 默认模型是 **visible-surface 两层**：后层在前层遮挡处没有数据（`NaN`），所以移开相机才会出现真正的**新暴露区域**（disocclusion）。如果后层也有一份被遮挡处的深度，空洞就永远不可能出现——这是深度图视差的关键，程序里也按这个约定生成样例。

### 3.2 按深度移动、最近层可见、空洞标记

- 每个有效源像素按自己的深度前向平移、四舍五入到整像素，然后做 **z-buffer**：同一输出像素取深度最小（离相机最近）的源；深度相同取更靠前的层。重叠处因此一定显示最近层。
- 没有源像素落到的输出像素就是空洞。**Raw: mark holes**（默认）用洋红色 `(255, 0, 176)` 标出；切到 **Background fill** 则由邻近背景补全。
- 顶部状态栏实时显示：前/后层当前位移、空洞数、已补数、被判定为采样裂缝而闭合的像素数。

> 细节：连续斜面（ramp 预设）按整数采样再做 `rint` 平移，会在同一层相邻采样之间留下 1 px 的**采样裂缝**。这类洞不是遮挡，程序单独处理（`stats["cracks"]`）：只有洞两侧属于**同一层**且深度相对差 ≤ 1% 时才闭合，真实遮挡一侧是近层、一侧是远层，永远不会被误判。这样 ramp 上留下的就都是真实的视差空洞。

### 3.3 空洞原样 / 邻近背景补全，且前景边色不流入

- `Raw`：空洞保留洋红标记。
- `Background fill`：对每个空洞像素，在**背景层（layer ≥ 1）已可见的像素**里找最近的一个（两遍 3-4 chamfer 距离变换：水平步精确、对角用 √2，属欧氏最近邻的有界近似；见 `nearest_donor`），把该背景像素的颜色填进去。
- **前景永远不做 donor**：donor 掩膜是 `winner & (layer_map >= 1)`，所以前景边缘的颜色不可能流进补全区。前后层之间的遮挡洞里填的一定是背景。
- 每个被补像素都记录了 `fill_source_flat`，probe 时能指出它来自哪个背景像素。

### 3.4 查看某个输出像素来自哪一点，左右移动后对比布局

- 鼠标在左上方 **output** 视图上移动：底部状态行显示 `output (x, y) — visible | layer=… | source=(sx, sy) | depth=… | shift=…`。点击会把十字准星和浮层贴在该像素上。
- 对补全区点击会显示 `hole -> filled from layer=back | donor=(…) | depth=…`；对未补的洞显示 `hole | no source`。这就是「某个输出像素来自哪一点」的完整溯源。
- **对比布局**：把相机停到左边（例如 baseline −60），点 **Pin current camera as left reference**；再拖到右边（+60）。右侧 **layout diff vs pinned** 视图按类别着色：
  - 黄 `front→back`、蓝 `back→front`（同一输出像素换了层）
  - 洋红 `→hole`、绿 `hole→`（原来有内容现在成洞 / 反之）
  - 下方 `Compare` 分组给出各类像素数。左右移动后接缝从方片一侧换到另一侧，diff 会直接显示出来。
- 同一输出像素 probe 两次（钉住前 / 移动后）即可看到 `source` 的变化。

### 3.5 预设遮挡方片与斜坡深度（已知坐标验证）

预设下拉框三项：

| 预设 | 已知坐标 | 用途 |
|---|---|---|
| Still life | 640×360，前层全部 0.50 m（碗 r = 0.20H 圆心 (0.45H, 0.32W)、书 x[0.60W,0.73W) y[0.55H,0.72H)、花瓶 x[0.82W,0.88W) y[0.22H,0.70H)），后层 1.00 m | 静物样例：多个轮廓、明显的前景边色、丰富遮挡洞 |
| Occluding square | 360×240，方片 `x[120,209) y[60,150)`，前 0.50 m / 后 1.00 m | 解析验证：刚性平移、接缝位置与宽度、左右布局差异 |
| Sloped depth strip | 360×240，条带 `x[72,288)`，深度随 x 从 0.45 m 线性到 1.15 m，后墙 1.55 m | 解析验证：近边位移 > 远边；空洞宽度随局部深度变化 |

几何信息也会显示在左侧 `Scene` 分组中，便于对着 `--verify` 的数字核对。

---

## 4. 结构

```
parallax_lab/
  scene.py    # 三个程序化静物/几何场景 + Layer/Scene 数据结构
  core.py     # 前向平移 + z-buffer + 裂缝闭合 + 背景最近邻补全 + probe + layout diff
  widgets.py  # Qt 视图：图像/叠加层/探针十字、深度图与画笔
  app.py      # PySide6 主窗口
  verify.py   # 已知坐标的数值验证（--verify）
tests/
  test_parallax.py
```

### 一些约定

- 深度单位是米、**离相机的距离**，数值越小越近；无数据为 `NaN`。
- 相机模型只有平移：`dx = −baseline/D`、`dy = −vertical/D`。`baseline` 的单位是「1 m 处的像素位移」。
- 平移取整用 `np.rint`（与验证脚本的预测一致）。
- 补全用的是**已可见**的背景像素；不做图像修复/扩散，只做「邻近背景直接搬过来」。需求里要的是标记 + 邻近背景补全，不是 inpainting。

## 5. 已知限制

- 只有两层，最近层获胜；层内不会自遮挡（同一层的斜面上按深度排序是逐像素的，不会出现层内前后关系错乱）。
- 补全是最近邻复制，斜面上会出现拉丝；这是「邻近背景补全」的固有形态，没有做滤波。
- 最近背景 donor 用 3-4 chamfer 距离变换求得，是欧氏最近邻的近似（实测误差 ≤ 3%，`--verify` 里卡 5%）而不是精确欧氏最近点；换来的是整帧补全仍只要 10 ms 量级、界面可实时拖动。
- `Vertical` 方向位移是同样的模型，但预设几何主要按水平方向设计，解析验证也只覆盖水平。
