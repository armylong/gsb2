#!/usr/bin/env python3
"""生成测试样片:12s 720p30,静态 + 纹理运动 + 一次硬切,烧录时间与帧号,带测试音。

用法: python gen_sample.py [输出路径]   (默认 work/sample.mp4)
"""
import os
import sys

import core

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("work", "sample.mp4")
out = os.path.abspath(out)
os.makedirs(os.path.dirname(out), exist_ok=True)
core.gen_sample(out)
info = core.probe_input(out)
print("已生成:", out)
print("时长 %.2f s, %dx%d, %.2f fps, 音频 %s" % (
    info["duration"], info["width"], info["height"], info["fps"], info.get("acodec")))
