# 可重新生成的图声对照样例

重新生成：

```bash
.venv/bin/python generate_sample.py
```

课堂标定：行间距 0.050 mm，走片速度 400.0 mm/s。10 mm 对应 200 行、25.00 ms。

- 正常窗：1 行 · 0.05 mm · 0.125 ms
- 过宽窗：31 行 · 1.55 mm · 3.875 ms
- 短断线回读使用：3 行 · 0.15 mm · 0.375 ms

## 文件

- `comparison.png`：正常、过宽、短断线总对照图
- `soundtrack_normal.png` / `soundtrack_short_break.png`：可在应用中用“重开导出的 PNG”回读
- `sample_source.wav`：源音
- `readback_normal.wav` / `readback_too_wide.wav` / `readback_short_break.wav`：三种回读

## 指标

| 指标 | 源音 | 正常 | 过宽 |
|---|---:|---:|---:|
| 440 Hz 恢复电平 | -10.5 dBFS | -10.6 dBFS 99% | -27.1 dBFS 15% |
| 1320 Hz 恢复电平 | -12.4 dBFS | -13.3 dBFS 90% | -46.0 dBFS 2% |
| 静音底 RMS | -41.9 dBFS | -45.7 dBFS  | -58.6 dBFS  |
| 脉冲峰值 / 半高宽 | -1.0 dB / 1.81 ms | -1.0 dB / 1.77 ms  | -8.3 dB / 3.95 ms  |

短断线检测区间：

- `review` break: 1.811–1.895 s，保留待查时间 84.1 ms；脏点散布/断线羽化使边界证据不连续，已保留待查外延与对应时间
