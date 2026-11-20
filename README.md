# 亚像素平移对齐工具

两张尺寸相同、只差不到一个像素（也支持整数像素）平移的小图，肉眼很难比较。
本工具用 Python + OpenCV + PySide6 做一套**带可信度提示的平移对齐工作台**：

1. 程序内生成带**可控亚像素平移、亮度/对比度扰动、高斯噪声**的配对图，也可导入同尺寸的两张图；
2. 用**相位相关（多候选峰 + 抛物线亚像素拟合）+ ECC 精修**估计横纵偏移，支持人工微调，移动量实时显示；
3. 残差只在两张图的**实际重叠区域**统计，边缘填充像素单独计数并在图中标红；
4. 对**低纹理、重复条纹**导致的多候选峰场景，输出候选峰列表与可信度等级（HIGH / MEDIUM / LOW）及判定依据；
5. 用已知位移做批量回归，并导出带有效区域掩码的对齐图、残差图、红绿叠加图。

## 目录结构

```
alignment_tool/
├── synthetic.py      # 程序化纹理 + 合成配对图（平移/亮度/噪声）
├── estimator.py      # 相位相关、候选峰、ECC、可信度评分
├── geometry.py       # 位移/warp、重叠掩码、填充标记、残差统计
├── io_utils.py       # 灰度图导入导出、对齐产物打包
├── regression.py     # 已知位移批量回归
├── cli.py            # 命令行：selftest / regress / demo
├── app.py            # PySide6 GUI 入口
└── gui/              # 主窗口与图像显示控件
```

## 本地启动

需要 Python 3.10+（开发验证用 3.12）。

```bash
# 1. 建虚拟环境并安装依赖
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. 启动图形界面
python -m alignment_tool.app
```

GUI 操作流程：左侧设置纹理/位移/亮度/噪声 → **生成配对图** → **估计位移**
（结果自动填入“当前 dx/dy”）→ 可用 `±0.1` 按钮或直接改数值做人工修正，
右侧三视图与残差数字随动更新 → 选输出目录 → **导出**。

## 一条可运行的验证命令（无需 GUI，样例全部程序内生成）

```bash
python -m alignment_tool.cli selftest
```

它会完成：合成 → 估计 → 人工修正演示 → 重叠区残差 → 低纹理/条纹可信度演示
→ 导出 4 张产物到 `tmp/selftest_out/` → 断言检查（正常纹理配准误差 < 0.5 px）。

其他验证命令：

```bash
# 20 项核心正确性测试（几何方向/残差区域/精度/歧义降级/ECC 一致性）
python tests/test_core.py

# 8 组已知位移回归（含条纹/棋盘/低纹理/强噪声），纹理充分用例误差应 < 1px
python -m alignment_tool.cli regress

# GUI 无头冒烟（CI/无显示环境，用 Qt offscreen 平台）
QT_QPA_PLATFORM=offscreen python tests/gui_smoke.py

# 单组样例并导出
python -m alignment_tool.cli demo --kind blobs --dx 0.7 --dy -0.4 --out tmp/demo_out
```

## 方法与约定

- **位移符号**：`dx > 0` 表示 moving 相对 ref 向右，`dy > 0` 向下；对齐时对 moving
  施加反向 warp。
- **相位相关**：`ifft2(F_b · conj(F_a) / |·|)`，汉宁窗抑制频谱泄漏；整数峰位按
  FFT 环绕索引换算为带符号位移并提取多个候选峰；亚像素精化直接用 OpenCV 官方
  `cv2.phaseCorrelate`（峰邻域加权重心，实测误差 ≤0.13px，优于手写抛物线拟合）。
- **ECC**：`cv2.findTransformECC` 的 `MOTION_TRANSLATION`，**以相位估计为初值**
  （零初值在低纹理上会陷入局部极值），只作交叉验证、不覆盖相位结果；偏差 ≥1px
  时保留相位结果并提示人工复核。
- **可信度**（0~1，阈值 0.75 / 0.45 分 HIGH/MEDIUM/LOW）综合五个信号：
  参考图 Sobel 梯度能量（纹理强弱）、结构张量**梯度各向异性**（单向条纹的孔径歧义）、
  次峰/主峰能量比（重复纹理歧义）、相位相关响应强度（噪声/内容不一致）、
  ECC 是否收敛且与相位一致。所有扣分点都会逐条显示在界面的判定依据里。
- **重叠区与填充**：对齐图满足 `aligned(x)=moving(x+dx)`，有效区间
  `[-dx, W-dx) × [-dy, H-dy)` 与画面取交集；边界用 ceil/floor 保守取整——
  `warpAffine` 线性插值会把填充值混进边界像素，这些插值污染像素一并排除，
  保证残差只统计两张图都有真实内容的区域。`warpAffine` 边缘统一用填充值 0
  （`BORDER_CONSTANT`），导出的 `valid_mask.png` 中 255=有效、0=填充。
- **残差指标**：MAE、RMSE、最大绝对误差、残差均值（正=moving 更亮），
  以及扣除亮度均值差后的 RMSE，便于区分“没对齐”和“只是亮度不同”。

## 导出产物

| 文件 | 含义 |
| --- | --- |
| `aligned.png` | moving 反向 warp 后的对齐图，边缘为填充值 0 |
| `valid_mask.png` | 实际重叠区域掩码（255 有效 / 0 填充） |
| `residual.png` | 残差幅值伪彩图，填充区纯黑 |
| `overlay.png` | ref 红通道 + aligned 绿通道叠加，对齐良好处呈黄/灰，填充区标红 |
