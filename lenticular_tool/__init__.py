"""单方向直镜条柱镜交错拼图 / 校准预览工具。

模块划分:
- params:  参数模型、内置预设、JSON 存取
- core:    纯 numpy 几何/取样/统计/校验逻辑(不依赖 Qt)
- samples: 内置带大号数字与细线的样例图(Qt 绘制)
- qtio:    QImage <-> numpy 互转与 PNG 读写
- calibration: 带刻度的校准条导出
- preview: 观察位置 / 倾角串图的示意预览
- verify:  本地校验与命令行
- main_window / canvas / widgets: PySide6 界面
"""

__version__ = "1.0.0"
