# 边界检查器 (pathcheck)

把一个二值小图描成**可缩放的闭合路径**：提取每条外边和内洞，显示每条边属于哪个组件，
交互调节简化参数，画出最大偏离区域并检查洞/细桥/连通性有没有被简化破坏，最后导出
可重新加载的路径 JSON 与栅格预览。

- 二进制前景按 **4 连通** 判定，背景洞按 **8 连通** 判定（Jordan 一致）
- 边界在**像素缝**上追踪（不是 OpenCV `findContours` 的像素中心），
  因此未简化时按奇偶规则栅格化可以**逐像素**复原原图
- 触图边的结构会保留贴边闭合段，并在悬停/详情里说明贴哪条边、哪个坐标区间
- 简化后自动做闭环 / 自交 / 嵌套 / 细壁 / 连通块 / 洞数 / 欧拉数 / 面积比对，
  非法简化一律给出 error 级提示

## 本地启动

```bash
cd repo
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt      # opencv-python-headless + PySide6
.venv/bin/python -m pathcheck                  # 打开 GUI
```

Linux 无桌面环境时可以用 `QT_QPA_PLATFORM=offscreen` 做冒烟检查；正常桌面
直接运行上面的命令即可。样例都在程序内生成，不需要任何图片素材。

### GUI 用法（从左到右）

1. **输入**：选内置样例（有洞/细桥/独立块、细桥与单像素洞、圆角环+岛屿、块状噪声）
   或导入黑白图片（≥127 视为前景）。
2. **简化**：选方法（RDP / `approxPolyDP` / 仅合并共线点），拖 `epsilon`。
   "丢弃小洞"默认 0（不丢），且必须勾选"明确允许按策略丢弃洞"才不会报错。
   "细壁预警"是该厚度以下会预警的阈值。
3. 画布：滚轮缩放、右键/中键拖动平移、`F` 适应窗口、`1` 1:1；
   点击环或列表项可选中，黄色虚线框 + 红/蓝两点标出该环的**最大偏离**，
   右下角状态栏给出 ms 耗时与连通性/面积/IoU。
4. 右侧页签：**环/组件**（每条外边、内洞、对角凹口归属 C#）、
   **校验问题**（error/warning/info，点击可定位到环）、**完整报告**、**选中环详情**
   （原始/简化顶点坐标、面积、贴边段、偏离数值与 bbox）。
5. **扫描首个失败 epsilon**：自动从 0.5px 起扫到 8px，找到第一个出现 error 的值并切过去。
6. **导出路径 + 预览…**：写出 `*.paths.json` + `*.reference.png` + `*.rebuild.png`
   + `*.diff.png`；**重新加载 JSON 校验…** 读回 JSON、重新栅格化、再和参考图对比。

## 无界面用法

```bash
# 所有样例完整跑一遍, 写 out/*.paths.json / *.report.txt / *.png
.venv/bin/python -m pathcheck --cli selftest --out out

# 单个样例/图片, 指定方法与容差
.venv/bin/python -m pathcheck --cli check --sample bridges --eps 1.5 --out out

# 重新加载导出的 JSON 并与参考图对比 (可重新加载 + 面积/连通性变化)
.venv/bin/python -m pathcheck --cli verify out/bridges.paths.json \
    --mask out/bridges.reference.png

# 扫描每个样例/方法的首个失败 epsilon
.venv/bin/python -m pathcheck --cli scan --max-eps 8
```

`selftest` 在有 error 级问题时返回 2，可直接用于 CI。默认 `--eps 0.5` 是保守值
（会损失一点最尖锐的角）；`--eps 1.5` 起就能看到细桥被切断的报错，这正是要检查的
非法简化。

## 一条可运行的验证命令

```bash
.venv/bin/python -m pytest tests -q
```

（等价、无需 pytest：`.venv/bin/python tests/test_core.py`）

这条命令覆盖：像素缝边界逐像素复原、环方向/闭合、`epsilon=0` 恒等、
细桥被简化切断时报错、洞被抹平时报错、触边环仍闭合且简化破坏时报 `border.lost`、
JSON 导出→读回→栅格化零差异、最大偏离不超过 epsilon。

## 导出格式（自包含，可重新加载）

```json
{
  "format": "pathcheck.boundaries", "version": 1,
  "image": {"width": 96, "height": 96, "origin": "pixel corners, x right, y down",
            "fill_rule": "even-odd"},
  "params": {"method": "rdp", "epsilon": 1.0, "describe": "rdp epsilon=1px"},
  "validations": {"ok": true, "missing": 0, "extra": 0, "iou": 1.0,
                  "components_ref": 5, "components_new": 5,
                  "holes_ref": 3, "holes_new": 3, "issues": []},
  "rings": [
    {"comp": 1, "kind": "outer", "index": 0, "closed": true,
     "points": [[x, y], ...], "border_spans": [["top", 36, 57]]},
    {"comp": 1, "kind": "hole", "index": 1, "closed": true, "points": [[x, y], ...]},
    {"comp": 5, "kind": "notch", "index": 1, "closed": true, "points": [[x, y], ...]}
  ],
  "meta": {"generator": "pathcheck", "reference": {"png": "xxx.reference.png"}}
}
```

- 坐标是像素角点；`closed: true` 表示最后一点自动连回第一点，因此**不重复**首点。
- `kind`：`outer` 外边（屏幕上顺时针，`signed_area > 0`）、`hole` 内洞（逆时针）、
  `notch` 对角凹口——它只是为了让奇偶填充复原图像而必须减掉的负向环，
  **不计入洞数量**（背景是 8 连通时它属于外部区域）。
- `border_spans` 给出该环贴合图边的区间，供重新加载后核对"触边结构仍闭合"。

## 校验规则一览

| 代码 | 级别 | 含义 |
| --- | --- | --- |
| `ring.open` / `ring.too-few` / `ring.zero-edge` / `ring.repeat-vertex` | error | 路径没闭合 / 顶点不足 / 零长边 / 夹点 |
| `ring.self-intersection` | error | 简化后环自交、边重叠或自接触 |
| `hole.outside-outer` / `hole.overlap` / `hole.cross*` | error | 洞跑出外环、洞互相重叠、环边界交叉 |
| `comp.outer-count` / `comp.outer-shrunk` | error | 组件外环数量异常 / 外环被洞吞掉 |
| `hole.dropped` | error | 洞被策略丢掉但未勾选"明确允许" |
| `border.lost` / `border.shorter` | error / warning | 触边环不再贴边 / 贴边段变短 |
| `raster.components` / `raster.holes` | error | 重建后连通块数 / 洞数变化（欧拉数一并给出） |
| `component.area-change` | warning | 哪个原组件被削掉/补上了多少像素、在哪个 bbox |
| `wall.thin` | warning | 细桥/薄壁区域像素数，epsilon 接近厚度时会断/填 |
| `raster.area-drift` | info | 简化导致的像素移动量（结构未变） |
| `raster.missing` / `raster.extra` | warning | 设了 `tol_missing`/`tol_extra` 后的面积容差超限 |

## 目录

```
pathcheck/
  geometry.py   精确整数几何: 鞋带面积、自交/相交分类、点在内、距离、规范化定向
  extract.py    像素缝边界追踪: 4 连通组件 + 外边/内洞/对角凹口 + 触边区间 + 嵌套
  simplify.py   RDP(闭合环) / approxPolyDP / 仅合并共线点, 可丢弃小洞策略
  deviation.py  单向 Hausdorff 最大偏离 + 对应点 + bbox
  validate.py   闭环/简单性/嵌套/细壁/连通性/洞数/欧拉数/面积 的完整校验
  render.py     奇偶扫描填充(精确) / 多边形填充 / 差异图 / 组件着色
  export.py     自包含 JSON 读写 + 栅格预览
  pipeline.py   一条 `analyse()` 串起全部步骤, GUI/CLI/测试共用
  samples.py    程序内生成 4 个样例 (metaballs/bridges/grid/noise) + 图片导入
  report.py     文本报告
  cli.py        无界面子命令 selftest/check/verify/scan
  gui/          PySide6 界面 (canvas.py + main_window.py)
tests/test_core.py  回归测试 (pytest 或直接运行)
```

## 已知边界情况

- 前景用 4 连通、背景用 8 连通。对角相邻的两个前景像素算**两个组件**，
  它们的边界只共用一个角点；对角缝隙不会把洞"封"成真实洞。
- 单像素岛、单像素洞、1px 细桥都会原样保留；`epsilon >= 1.5px` 时
  细桥/细壁很容易被 RDP 的弦跨过，检查器会给出 `raster.components` /
  `component.area-change` / `wall.thin` 提示，而不是静默通过。
- 简化方法不保证"epsilon 越大越先坏"的严格单调性，所以 "扫描首个失败 epsilon"
  返回的是**第一个**失败值，不代表所有更大的值都失败。
