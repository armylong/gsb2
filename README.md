# 低光降噪实验室（denoise_lab）

本地运行的低光静物降噪对比窗口：**普通平滑（高斯）vs 保边降噪（双边）**，
样例全部在程序内生成，不需要任何外部图片或联网。Python + PySide6 + OpenCV。

## 本地启动

```bash
# 1. 建虚拟环境并安装依赖（只需一次）
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. 启动 GUI
.venv/bin/python -m denoise_lab
```

## 一条可运行的验证命令

```bash
.venv/bin/python -m pytest tests/ -v
```

无显示器环境也能跑：GUI 冒烟测试通过 `QT_QPA_PLATFORM=offscreen` 离屏执行，
共 21 个用例（纯计算管线 + 离屏界面），全部通过即代表需求点可用。

## 功能与需求对照

| # | 需求 | 实现位置 / 操作方式 |
|---|------|--------------------|
| 1 | 内置含平坦块、细线、规律纹理的带噪样例，噪声强度可控 | `synthetic.py`：三级亮度平坦块、梯度带、细线、点阵、棋盘、正弦条纹、低饱和彩条；面板 1 调 sigma / 信号系数 / 随机种子 |
| 2 | 普通平滑 vs 保边，同一缩放与选区 | 四视图共享同一套 `RegionParams`；任意视图滚轮缩放四图联动，左键拖拽选区四图同步，中键平移 |
| 3 | 差值图 + 选区变化 + 纹理抹除标记 | 下排两张 `|带噪-结果|×增益` 差值图，黄虚线选区同步；红框为“疑似纹理抹除”块（只看带噪图与结果，不读参考），阈值可调 |
| 4 | 只处理选中部分，边缘过渡可见、区外不修改 | `processing.process()` 对区外像素原样返回（测试逐像素断言）；羽化用 smoothstep alpha，视图上以半透明颜色直接画出过渡带 |
| 5 | 已知干净参考 + 平坦区噪声下降 / 边缘保留报告 | 面板 5 按钮显式触发 `metrics.evaluate`：每块平坦区 σ 与 dB 下降、对参考 RMSE、Sobel 梯度相关/幅度保持/EPI、纹理能量保持率、Cr/Cb 色度保持 |
| 6 | 亮度相关 / 固定两种合成模式；多手选平坦区逐级估计；估计与评估分开，处理中读不到干净参考 | 面板 1 切模式；面板 2 管理手选框（默认三块不同亮度），MAD 稳健估计 + `σ(y)=a+b·√y` 拟合。**隔离是强制的**：`noise_estimation.py`/`processing.py` 的 AST 中不允许出现 clean 引用（测试守护），干净参考只在 `metrics.py` 和面板 5 的按钮回调里出现 |
| 7 | 两个可重叠范围、各自强度、明确重叠优先级；操作顺序无关；低光色度单独抽查 | 面板 3 两个独立范围编辑器 + 优先级下拉；重叠处高优先级 alpha 保持、低优先级乘以 `(1-a高)`。`process()` 是纯函数，最终设置相同则输出逐像素一致（测试覆盖两条操作路径）。面板 4 通道切换 RGB/Luma/Cr/Cb，四视图同时切换 |

## 模块划分

```
denoise_lab/
├── synthetic.py          # 干净参考 + 两种噪声合成（sigma_map 仅供评估）
├── noise_estimation.py   # 手选平坦区 → 逐级 sigma / 拟合噪声模型（只用 noisy）
├── processing.py         # 高斯/双边、羽化 alpha、重叠合成、差值图、纹理抹除检测（只用 noisy）
├── metrics.py            # 唯一允许读取 clean 的模块：客观评估报告
└── app.py                # PySide6 四视图窗口
tests/
├── test_pipeline.py      # 计算管线 + 干净参考隔离的 AST 守护
└── test_gui_smoke.py     # 离屏 GUI 冒烟（offscreen Qt）
```

## 关键设计说明

- **干净参考不泄漏**：处理与估计模块的函数签名和语法树都不能出现 `clean`，
  由 `test_clean_reference_not_reachable_from_processing_modules` 静态守护；
  UI 上评估按钮也是唯一接触参考的入口，评估结果不回流行处理。
- **顺序无关性**：`process(noisy, algo, regions, winner)` 是无状态纯函数，
  内部不保存“先选了哪个区域”，所以“先编辑后切算法”和“先切算法后编辑”
  在最终设置相同时输出完全一致（`test_order_independence_*`）。
- **噪声口径**：合成噪声加在 RGB 三通道，估计在 luma 域进行；
  独立通道噪声经 `Y'=0.299R+0.587G+0.114B` 后 sigma 收缩约 0.668 倍，属预期。
- **纹理抹除判据**：块内带噪图梯度能量超过噪声基底（存在真实结构），
  且处理后高频能量保留率 < 0.25 才标红，因此平坦区去噪不会被误报。
