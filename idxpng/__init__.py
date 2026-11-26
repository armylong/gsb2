"""索引色 PNG 编辑器核心包。

模块划分:
- model: 逐像素索引 + RGBA 色表的数据模型、历史快照、重排运算
- png_io: 索引色 PNG 读取(Pillow) / 写出(自带编码器) / 回读核对
- sample: 自带样本(奇数宽、重复色号、半透明色号)
- render: 把索引图按当前色表渲染成 RGBA, 支持按索引精确高亮
- widgets: 平移缩放同步的像素画布
- main_window: PySide6 主窗口
"""

__version__ = "1.0.0"
