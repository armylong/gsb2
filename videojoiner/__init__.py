"""本地顺序视频拼接工具（单机，基于 ffmpeg/ffprobe）。

模块划分：
- probe:     ffprobe 读取片段元数据（时长/尺寸/帧率/声音）
- normalize: 把每个片段统一到相同的尺寸、帧率、像素格式、音频参数
- concat:    concat demuxer 对统一规格后的中间片做流拷贝拼接
- project:   时间线数据模型与导出流水线
- verify:    导出后回读文件，核对时长/尺寸/片段顺序/交界/音轨
- samples:   用 ffmpeg lavfi 源程序化生成测试样例
- server:    本地 Web UI 的 HTTP 服务（仅标准库）
- cli:       命令行入口（生成样例、导出、校验）
"""

__version__ = "1.0.0"

MAX_CLIPS = 6
