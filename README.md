# bandview — 多波段同机位合成查看器

本地、离线的多波段单通道图像合成与对照工具。只依赖 **numpy + PySide6**,
用于回答这类问题: *树叶和灰路在某个波段原本数值就不同, 还是我把显示范围拉得太狠?*

## 核心特性

1. **任意三波段 → RGB 屏幕通道**。原始数值全程保留 (uint8/uint16/uint32/float),
   拉伸只发生在渲染层; 每个波段带独立的无值像素掩码, 无值不参与统计与拉伸。
2. **显示范围可对照**。可对全图或框出的参考区取范围; 共同拉伸与各通道单独拉伸可切换;
   被范围挤到同色的点用独立覆盖色标出 (青=低于下界, 红=高于上界, 品红=无值),
   状态栏实时显示各波段裁剪像素占比。
3. **归一化差值 `(a−b)/(a+b)`**。无值与分母过小 (`|a+b| < ε`, 蓝色) 独立显示;
   一键交换 a/b, 读数应整体反号, 可直接核对。
4. **状态保持 + 联动坐标**。通道替换或参考区改变后, 其它视图和手动范围保留;
   所有视图共享同一图像坐标, 缩放平移完全联动; 场景坐标即原像素坐标, 边缘与参考区
   均为原像素整数量, 放大到单像素时显示整数网格。
5. **自带测试数据集**。同一套轮廓 (树冠 / 灰路 / 水体 / 无值区), 四个波段反差不同,
   一键生成并加载; 可导出全分辨率合成图 PNG 和设置 JSON, 并从 JSON 还原。

## 安装

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 启动

```bash
# 不带数据, 进界面后点「生成自带测试图到目录…」
.venv/bin/python -m bandview

# 或直接传入同尺寸的单通道文件 (.npy/.npz/png/tif/bmp...)
.venv/bin/python -m bandview /path/b1.png /path/b2.png /path/b3.png /path/b4.png
```

## 操作

| 操作 | 方式 |
|---|---|
| 缩放 / 平移 | 滚轮 / 左键拖拽 (或中键) |
| 框参考区 | 工具栏「框选参考区 (R)」或面板按钮, 在任一视图拖拽 |
| 适应窗口 | 工具栏「适应窗口 (F)」 |
| 读原始数值 | 鼠标移到像素上, 右侧面板显示各波段原始值、dtype、映射后的显示值与裁剪状态 |
| 交换差值顺序 | 归一化差值面板「交换 a / b」 |

## 输入格式

- `.npy` / `.npz`: 任意 dtype 的二维数组, 完整保留高位深; 浮点图自动把 NaN/Inf 当无值。
- Qt 支持的图片: 16 位灰度 PNG/TIFF 按原始位深读取; 索引图取调色板索引;
  彩色图可按 R/G/B 或亮度提取单通道。
- 无值标记: 加载时可指定一个数值 (如 0), 等于该值的像素标记为无值。

## 测试与核对

```bash
# 纯数值单元测试 + GUI 冒烟测试 (离屏)
QT_QPA_PLATFORM=offscreen .venv/bin/python -m unittest discover -s tests -v

# 无界面端到端核对: 生成测试图并验证测试点数值、颜色、归一化差值
QT_QPA_PLATFORM=offscreen .venv/bin/python -m bandview.verify [目录]

# 离屏截图, 人工核对视觉效果
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/manual_screenshot.py
```

`bandview.verify` 覆盖: 高位深保留、无值掩码、窄范围裁剪覆盖色、合成图树叶/灰路可分、
差值交换反号、分母过小独立显示、16 位 PNG 与 npy 像素级一致。

## 包结构

```
bandview/
  model.py       BandData 与区域统计 (无值安全)
  io_utils.py    图像/数组读写, 16 位灰度往返
  rendering.py   数值→uint8 拉伸、合成、归一化差值、覆盖色
  canvas.py      共享图像坐标的联动画布 (缩放/平移/参考区/十字线)
  widgets.py     侧边控制面板
  app.py         主窗口与渲染管线
  generate.py    自带测试数据集
  verify.py      无界面端到端核对
tests/           单元测试、GUI 冒烟测试、截图脚本
```

## 已知平台说明

本机 Qt 6.12 从内存字节流 (`QBuffer`) 读取图片会触发段错误, 因此加载统一走文件路径;
`.npy` 等 numpy 格式不受影响。
