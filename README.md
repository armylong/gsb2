# 色域对照工具 (gamut-compare)

本地色域对照工具: 解决"屏幕上鲜绿色分得开, 输出到较小目标色域后几块绿看成一个色"的问题.
纯 Python + numpy + PySide6, 不依赖 Pillow; PNG 与 ICC 读写均为自实现.

## 运行

```bash
python3 -m venv .venv
.venv/bin/pip install numpy PySide6
.venv/bin/python app.py          # GUI
.venv/bin/python test_core.py    # 核心自测 (无 GUI)
.venv/bin/python verify_export.py 文件.png [参照.png]   # 命令行验证导出
```

## 功能对照

1. **来源/目标色域与点读** — 导入 PNG(或内置样图)后指定来源色域(sRGB / Display P3),
   切换目标色域即重算; 色域外像素用品红棋盘纹明确遮盖(不伪装成原色);
   单击图像点读: 输入编码/线性值、目标理想值、目标输出编码、色域判定、ΔE76.
2. **两种映射对比** — 逐通道截断 vs 保持大致色相的压缩(CIELAB D65 中固定 L*/h,
   二分压缩 C* 到色域边界); 内置样图: 中性色阶、6 色相 × 8 级饱和度递进、
   鲜绿组合(高色度绿 4×4, 复现"几块绿并成一色": P3→sRGB 截断后 16 色并为 4 色).
3. **色域内核对** — 选区统计给出"色域内像素 ΔE 最大"(应 ≈0, 证明可表示色块未被改动);
   界面常驻显示转换路径(源 → XYZ(D65) → 目标)与映射所用色彩空间.
4. **软打样基准** — 预览把目标编码值直接上屏(Qt 按 sRGB 解释), 界面明示该基准;
   外部屏幕能力未知时, 以点读数值、色域外标记与 ΔE 热力图为准;
   选区统计全部按图像实际像素(numpy 数组)计算, 与屏幕缩放无关.
5. **导出与验证** — 导出 PNG 带目标色域说明(sRGB 写 sRGB/gAMA 块, P3 内嵌自生成
   ICC v2 剖面, 另有 tEXt: Target Gamut / Mapping / Source Gamut);
   "重新载入验证"逐像素比对编码值并输出报告; "不映射"模式下存在色域外像素时
   拒绝导出并说明原因(无法原样编码, 强行写入会把截断色伪装成原色).

## 文件

- `gamut_core.py` — 色彩换算、映射、PNG/ICC 读写、样图、验证
- `app.py` — PySide6 GUI
- `verify_export.py` — 命令行验证
- `test_core.py` — 自测(转换恒等、超界判定、保 hue、色块合并、导出往返)

## 说明与限制

- PNG 载入支持 8/16bit、灰度/RGB/RGBA/调色板、非隔行; 不支持的情形(如 Adam7 隔行)
  会给出具体原因. alpha 通道丢弃并提示.
- ΔE 为 CIE76(CIELAB D65); "保持色相"是 CIELAB 意义下的近似.
- 16bit PNG 取高字节载入.
