# 柱镜交错拼图校准工具（单方向直镜条）

用 Python + PySide6 + NumPy 做的本地工具：把 2–4 张同尺寸 PNG（不同视角）
按柱镜片间距交错成一张供印刷的 PNG，在电脑里预演柱镜片压上去、移动观察
位置、镜片微小倾角导致一侧正确另一侧串图的效果，并提供像素级的区段占用
统计、首/中/尾校验、校准条导出和参数复现。

> 范围：先只做**单方向竖直直镜条**。交错输出始终是竖直列；倾角是压片时
> 镜片相对印刷列的旋转误差模拟（以可选基准行对齐，向另一侧逐渐漂移）。

## 安装与启动

```bash
uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt
# 或: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

.venv/bin/python main.py
# 等价于 .venv/bin/python -m lenticular_tool
```

启动即载入 3 张内置样例（1200×800，大号数字 + 细线网格 + 1px 线对）。
左侧可以改成 2/4 张，或添加自己的同尺寸 PNG（尺寸不一致会拒绝载入）。

## 一分钟上手

1. 左侧 ③ 设置 **DPI / LPI / 起始偏移 px**，读数区会显示镜条周期
   `P = DPI / LPI`（输出像素，可以是小数）和左右边缘相位。
2. 中间图上方拖动红色观察位置（或滑块），主画面会自动切到「压镜观察模拟」，
   能看到视角 1→2→3(→4) 的过渡；分界附近是两图混合。
3. 左侧 ④ 给一个微小倾角（内置例子里有 `0.45° 倾角(顶准底串)`），
   画面顶部正确、越往下相位漂移越大并逐渐串图；基准侧可改中/底。
4. 在主图上**左键拖框**任意区段；**单击**选中贯穿全高的同一根镜条。
   右侧显示该镜条下每个视角的像素数、平均横截面宽度（px/inch）、占比、
   与理想 `P/N` 的偏差，以及参考行上的连续取样段顺序。
5. 用 ② 的上移/下移/反转调整切片顺序，所有画面与统计立即刷新 ——
   用来反查实际观察方向有没有左右颠倒。
6. ⑥ 打开「首/中/尾校验」查看数值自检和放大裁片；菜单 `校验 → 内置例子`
   可切换整数周期、半像素偏移、P=3.5 非整除、倾角串图四个例子。
7. ⑦ 导出：
   - **交错原像素 PNG**：尺寸与输入完全相同，写入 DPI 元数据；
   - **来源图层 PNG**：每个像素来自哪个视角的平涂彩色图；
   - **带刻度校准条 PNG**：切片色带 + 镜条编号/分界线 + 像素尺 + 英寸尺。
   - **保存参数 JSON / 加载参数 JSON**：参数和视角来源（内置样例或 PNG
     路径，相对路径优先）都在 JSON 里，之后可重复生成。

缩略图清晰度下拉只改变屏幕预览（观察模拟在缩小网格上计算后平滑放大），
**不改变 `interlace()` 的原生像素网格、取样和导出尺寸**。

## 命令行本地校验 / 无界面复现

```bash
# 数值自检 + 四个内置例子的首/中/尾相位报告
.venv/bin/python -m lenticular_tool.verify

# 同时导出每个例子首/中/尾的 8x 放大裁片 PNG
.venv/bin/python -m lenticular_tool.verify --crops ./check_crops

# 单元测试
QT_QPA_PLATFORM=offscreen .venv/bin/python -m unittest discover -s tests -v

# 用保存的参数 JSON 无界面重复生成
.venv/bin/python -m lenticular_tool.cli generate lenticular_project.json \
    --out interlaced.png --layer layer.png --cal calibration_strip.png
```

## 几何约定（为什么右侧相位不会“越对越偏”）

- 像素中心坐标 `(i + 0.5, j + 0.5)`，原点在左上角。
- 镜条周期 `P = DPI / LPI` 输出像素，允许小数。
- 第 `m` 根分界线在第 `y` 行的 x 坐标：

  ```
  B_m(y) = offset_px + m·P + (y − y_pivot)·tan(θ)
  ```

  相位场一次性按全局坐标计算：

  ```
  u(x,y) = ((x − offset_px) − (y − y_pivot)·tan θ) / P
  ```

  `floor(u)` 是镜条编号，`frac(u)` 是镜条内相位，
  切片号 `s = min(floor(frac(u)·N), N−1)`，实际视角为 `order[s]`。

因为不做逐根镜条的整数宽度累加，`P` 不能整除像素数时，图尾相位仍然严格
等于公式给定值；右侧相位读数和首/中/尾报告可以直接核对。两种右端修正：
- 「首尾同相位」：取离 `W/P` 最近的整数周期数，反解 `P = W/M`；
- 「锁定右端相位」：在名义 `P` 附近找最小修正，使基准行 `x = W` 相位
  恰好等于设定值。界面都会显示修正后的 P。

## 目录

```
lenticular_tool/
  params.py          参数 / JSON / 内置预设
  core.py            相位场、交错取样、观察权重、区段统计、首中尾、自检
  samples.py         内置大号数字 + 细线样例
  qtio.py            QImage/numpy 转换与 PNG 导出
  calibration.py     带刻度校准条
  crops.py           首/中/尾放大裁片
  widgets.py         占比堆叠条 + 可拖动观察位置的镜片示意
  canvas.py          缩放/框选画布
  dialogs.py         本地校验窗口
  main_window.py     主界面
  verify.py          python -m lenticular_tool.verify
  cli.py             python -m lenticular_tool.cli generate
tests/test_core.py   几何/取样/统计/持久化测试
```

## 备注 / 已知边界

- 观察模拟是**示意性的相位窗口模型**（有限观察窗与切片区间的重叠面积
  决定各视角权重），用于表现切换方向与倾角漂移/串图，不是光线追踪。
- 交错输出与来源图层始终是硬取样的原像素结果；观察模拟的柔化只存在于
  屏幕预览。
- 所有视角必须同尺寸；工具不做缩放，避免“悄悄改变实际输出像素大小”。
