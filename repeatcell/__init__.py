"""repeatcell – 本地重复单元测量窗 (平面图像, 像素为单位)。

模块划分:
* :mod:`repeatcell.geometry`  – 基矢/平行四边形/图内完整单元
* :mod:`repeatcell.estimator` – 自相关估计两个重复方向与步长, 半步/整步提示
* :mod:`repeatcell.sampler`   – 单元采样、样本叠图、干净单元拼接
* :mod:`repeatcell.tiling`    – 平铺、比对图、导出 (含小数角点)
* :mod:`repeatcell.synth`     – 可重复生成的示例纹理
"""

__version__ = "0.1.0"
