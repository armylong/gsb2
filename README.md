# blockvid — 块式录屏草稿回放实验

把视频编码成自定义 `.bvd` 格式(完整关键帧 + 变化小块), 再无损还原回放,
用于验证"录屏草稿只存鼠标附近变化区域"的思路。Python + PySide6 + ffmpeg。

## 安装

```sh
python3 -m venv .venv
.venv/bin/pip install PySide6 numpy
# 需要系统已安装 ffmpeg / ffprobe
```

## 格式说明 (.bvd)

- 文件头: 宽高、帧率、块尺寸、关键帧间隔、帧数, 像素统一为 RGBA8
- 每帧一条记录: `FRM0` magic + 帧号 + pts(毫秒) + 类型 + payload + CRC32
  - 关键帧: 整幅 RGBA 的 zlib 压缩
  - 增量帧: 若干 `(x, y, w, h)` 小块, 右/下边缘不足一块时按实际尺寸记录
- 解码端逐条校验 magic/长度/CRC, 失败即标记损坏并扫描下一个 `FRM0` 重新同步;
  从损坏点到下一个完好关键帧之间的帧标记为受影响, 之后照常解码

## 命令行

```sh
# 生成合成测试片(移动小方块, 可用非对齐尺寸测边缘块)
.venv/bin/python -m blockvid.cli synth -o synth.mp4 --width 646 --height 366 --seconds 5

# 编码(块尺寸、关键帧间隔可调, 限 30 秒内)
.venv/bin/python -m blockvid.cli encode synth.mp4 -o synth.bvd --block-w 64 --block-h 64 --keyint 30

# 存储对照(完整帧 / 变化内容分开计)
.venv/bin/python -m blockvid.cli stats synth.bvd

# 与源视频逐像素核对(无损校验)
.venv/bin/python -m blockvid.cli verify synth.bvd synth.mp4

# 导出还原帧 PNG, 可同时导出源帧对比
.venv/bin/python -m blockvid.cli export synth.bvd -o out/ --frames 0,10,50-55 --src synth.mp4

# 生成损坏副本做故障演示(zero=填零, truncate=截断)
.venv/bin/python -m blockvid.cli corrupt synth.bvd --mode zero

# 图形界面
.venv/bin/python -m blockvid.cli play [synth.bvd]
```

## 图形界面功能

- 打开视频编码 / 打开 .bvd / 一键生成合成测试片 / 一键生成损坏副本
- 按原片帧时刻(pts)回放; 暂停后可前后单步; 拖动时间轴从最近关键帧恢复
- 时间轴上绿色刻度=关键帧, 红色段=损坏影响范围
- "显示已保存小块"叠加当前帧实际存储的块矩形, 右侧面板逐块列出坐标尺寸
- 存储对照: 完整帧字节数 / 变化内容字节数 / 原始 RGBA / 压缩比
- 导出任意帧 PNG, 或与源视频全片逐像素核对
