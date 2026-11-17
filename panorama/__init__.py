"""Mac 本地照片全景拼接工具（平面 / 远景假设）。

模块划分：
- config:     阈值与上限等可调参数
- geometry:   单应矩阵工具、尺度合理性检查、角点映射
- features:   特征检测 / 匹配 / RANSAC 几何估计 + 拒绝逻辑
- control:    手动控制点的增删改与合并估计
- layout:     连通分量、全局布局（含首尾闭环约束）、误差度量
- blend:      增益补偿、羽化融合、鬼影提示、有效区域与裁剪
- engine:     编排整条流水线并保存“上次有效结果”用于回退
- synthetic:  自生成带已知真值的宽幅测试场景
"""

__all__ = [
    "config",
    "geometry",
    "features",
    "control",
    "layout",
    "blend",
    "engine",
    "synthetic",
]
