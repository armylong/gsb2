# 小地图标记色觉检查工具

本地运行的配色检查窗口，用于验证一组小地图色块 / 半透明图标在红绿色觉差异
模拟下是否仍然可区分。纯 Python：PySide6 做界面，numpy 做全部图像与色彩计算。

## 功能与需求对应

| 需求 | 实现 |
| --- | --- |
| 导入透明 PNG + 一组测试颜色，可点图取色；源颜色与两种红绿模拟画面，模拟程度可调 | `app.py` 三视图（普通/protan/deutan），`cvd.py` Machado 2009 矩阵 0–100% 连续插值；点击取色，Shift+点击直接新增类别；测试颜色走「导入测试颜色」JSON |
| 浅底/深底切换，半透明边缘按实际合成色参与检查 | `analysis.composite_image` 先按 alpha 合成再模拟；`pixel_color` 对边缘像素给出源 RGBA、alpha 与合成显示色；所有配对读数都基于合成后的颜色 |
| 指定必须成对区分，分别看模拟色差与背景亮度反差，调色时提示给另一组带来的新问题 | `palette.Palette.pairs`；配对表给出 ΔE2000（均值+最小）和两类各自的 WCAG 反差；候选评分里未配对类别的新增冲突与两底色反差劣化都会列入预警 |
| 可锁定/可改颜色，候选建议逐个接受比较，取样范围外像素不受影响 | 类别表锁定勾选；OKLCH 空间生成候选，可逐个接受并在「已接受调色预览」中对比；`recolor.recolor_image` 按 soft 权重改色，范围外像素与全部 alpha 原样保留 |
| 保存调色方案、模拟设置、前后对照图；带透明边样例验证两底色读数不同 | 「保存方案 / 载入方案 / 导出前后对照图」；`samples/` 生成 6 个带抗锯齿透明边的标记和精灵表；`samples/verify_readings.py` 输出两底色读数对照并给出 PASS/FAIL |

## 运行

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 生成带透明边的标记样例
.venv/bin/python -m samples.make_samples

# 启动界面
.venv/bin/python -m colorcheck
# 或 .venv/bin/python main.py

# 无界面的读数验收脚本
.venv/bin/python -m samples.verify_readings

# 全部测试 (45 个, 含 offscreen GUI 冒烟测试)
QT_QPA_PLATFORM=offscreen .venv/bin/python -m unittest discover -s tests
```

样例图片生成在 `samples/data/`，测试颜色清单见
`samples/data/test_colors.json`。

## 界面操作要点

1. 「导入透明 PNG」载入精灵表或单个标记；「导入测试颜色」载入类别清单。
2. 拖动「模拟程度」滑杆，三视图与右侧读数联动；切换「浅底/深底」。
3. 在「必须区分的配对」里建组，查看 ΔE2000 与亮度反差判定；
   勾选「高亮冲突热点」可把低于 ΔE 阈值的像素标紫。
4. 在「候选建议」里选一个可改类别 → 生成候选 → 看预警 → 逐个接受；
   锁定类别不会被改色。视图切到「已接受调色预览」与原图比较。
5. 满意后「保存方案」（JSON，含模拟设置、锁定状态、每条接受的改动），
   「导出前后对照图」生成两底色 × 原图/调色 × 三种视觉的对照 PNG。

## 判定参考（可在「底色与阈值」里改）

- ΔE2000 < 10：通常难以区分，配对表标「不足」。
- WCAG 亮度反差 < 3：非文字图形在该底色上辨识度不足。
- 注意 Machado 模型下 deutan 的最大混淆点常在中等程度（约 40–60%），
  全盲模拟反而会把红绿推向两个色相极端，所以滑杆要在中间区间多观察。

## 目录结构

```
colorcheck/
  colorio.py    sRGB/Lab/OKLCH、CIEDE2000、WCAG 反差、alpha 合成
  cvd.py        protan/deutan 模拟矩阵与程度插值
  analysis.py   图像合成、模拟帧、配对像素读数、冲突热点
  recolor.py    取样权重改色, 范围外像素不动
  palette.py    类别/配对模型、候选评分、跨组冲突预警、方案序列化
  pngio.py      标准库 PNG 读写 (离线脚本/测试用)
  qtutil.py     numpy <-> QImage
  app.py        PySide6 主窗口
samples/        透明边标记生成器、读数验收脚本、测试颜色 JSON
tests/          38 个 numpy 核心测试 + 7 个 offscreen GUI 测试
```
