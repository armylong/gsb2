"""本地视频防抖工具包。

模块划分:
- media:     ffprobe/ffmpeg 封装、输入校验、音频处理
- motion:    帧间运动估计与硬切检测
- geometry:  路径平滑、有效区域/安全裁切计算、渲染用变换矩阵
- pipeline:  分析与渲染主流程、sidecar 元数据
- samplegen: 带已知答案的合成样例生成(答案只写入 ground_truth.json)
- verify:    独立核验, 读取输出视频与 ground_truth.json
- webapp:    Flask 本地网页
"""

__version__ = "1.0.0"
