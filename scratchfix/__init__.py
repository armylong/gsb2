"""scratchfix - 老照片划痕局部修补工具.

模块:
  synth    生成带已知损伤的合成纹理图(含 ground truth)
  inpaint  邻域插值(扩散式)与纹理式(样本块)修补算法
  session  可撤销的逐块提交会话
  metrics  遮罩内误差 / 选区外不变性 / 结构连续性指标
  verify   无界面验证命令: python -m scratchfix.verify
  app      PySide6 图形界面
"""

__version__ = "0.1.0"
