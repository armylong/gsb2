# Demosaic Lab — 马赛克采样与斜边彩点实验工具

观察相机 CFA(Bayer) 马赛克采样后斜边/细线冒彩点的成因：每个像素只采 R/G/B 之一，
重建时缺失通道靠邻域猜测，跨边缘插值就产生伪色彩点。

## 本地启动

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install numpy PySide6
python demosaic_lab.py
```

界面功能：

- 场景：黑白斜边 / 彩色细条纹 / 纯色；CFA 排列 RGGB/BGGR/GRBG/GBRG；采样起点偏移 X/Y
- 视图：原图、马赛克(CFA 着色)、双线性重建、边缘方向重建、两种方法的彩色误差图(×6)
- 边界放大：对图像中心边界区域单独裁剪放大查看，内容可切换
- 点击任意视图像素：显示该点 CFA 采样颜色、实测 raw 值、真值与两种重建估算值
- “保存重建图”按钮导出边缘方向法重建结果 PNG

## 验证命令（无界面自检）

```bash
python demosaic_lab.py --selftest
```

验证内容：纯色在 4 种排列 × 4 种起点偏移下两种方法均精确重建；斜边上边缘方向法
平均彩色误差低于双线性；奇数宽高(101×103、63×65)形状与数值正确；细条纹复现彩色误差。
全部通过退出码为 0。
