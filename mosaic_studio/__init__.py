"""照片马赛克工坊：本地照片马赛克工具（Python + PySide6 + Pillow）。

模块划分：
- config:   参数与常量
- features: 图像特征（颜色 / 空间布局 / 纹理）与距离
- imaging:  底图、样块读取与统一裁切（记录实际使用范围）
- engine:   带相邻限制、全局配额、固定格、种子的分配求解器
- session:  一次马赛克制作的完整状态（素材、参数、固定格、结果）
- render:   Pillow 预览图 / 成品渲染
- report:   CSV / JSON 使用记录导出、方案存取
- generator:程序化生成样块与示例底图（含同色异纹样块、配额冲突例子）
- gui:      PySide6 界面
"""

__version__ = "1.0.0"
APP_NAME = "照片马赛克工坊"
