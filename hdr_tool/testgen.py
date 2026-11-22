"""程序生成 PQ 测试片(灰阶图 / 亮度梯度+移动亮块), 布局常量供采样探针共用。

灰阶图布局 (相对坐标):
  - 上部: 12 个已知亮度灰阶方块 (6列 x 2行)
  - 中部: 16 级边界细灰阶条 (30..150nit, 跨默认拐点 60nit)
  - 下部: 6 条饱和彩带 (R/G/B/C/M/Y, 75% 饱和, 亮度纵向 100->1000nit 渐变)
"""
import subprocess

import numpy as np

from . import color

W, H, FPS = 1280, 720, 30

CHART_NITS = [0.1, 1, 5, 10, 25, 50, 100, 203, 400, 1000, 2000, 4000]
FINE_NITS = list(np.linspace(30.0, 150.0, 16))
BAND_HUES = [  # (名字, 纯色 RGB)
    ("R", (1, 0, 0)), ("G", (0, 1, 0)), ("B", (0, 0, 1)),
    ("C", (0, 1, 1)), ("M", (1, 0, 1)), ("Y", (1, 1, 0)),
]
BAND_SAT = 0.75
BAND_LO_NITS, BAND_HI_NITS = 100.0, 1000.0

# 区域 (相对坐标 x0, y0, x1, y1)
CHART_REGION = (0.03, 0.03, 0.97, 0.42)
FINE_REGION = (0.03, 0.47, 0.97, 0.60)
BAND_REGION = (0.03, 0.65, 0.97, 0.95)


def _cells(region, cols, rows):
    x0, y0, x1, y1 = region
    cw, ch = (x1 - x0) / cols, (y1 - y0) / rows
    for r in range(rows):
        for c in range(cols):
            yield (x0 + c * cw, y0 + r * ch, x0 + (c + 1) * cw, y0 + (r + 1) * ch)


def chart_points(w=W, h=H):
    """返回采样点列表: dict(kind, label, nits, x, y), 坐标为像素"""
    pts = []
    for (x0, y0, x1, y1), nits in zip(_cells(CHART_REGION, 6, 2), CHART_NITS):
        pts.append({"kind": "灰阶", "label": f"{nits:g}nit", "nits": nits,
                    "x": int((x0 + x1) / 2 * w), "y": int((y0 + y1) / 2 * h)})
    for (x0, y0, x1, y1), nits in zip(_cells(FINE_REGION, 16, 1), FINE_NITS):
        pts.append({"kind": "细阶", "label": f"{nits:.0f}nit", "nits": nits,
                    "x": int((x0 + x1) / 2 * w), "y": int((y0 + y1) / 2 * h)})
    return pts


def _fill(frame, cell, rgb_nits, margin=0.06):
    h, w = frame.shape[:2]
    x0, y0, x1, y1 = cell
    xa, xb = int((x0 + margin * (x1 - x0)) * w), int((x1 - margin * (x1 - x0)) * w)
    ya, yb = int((y0 + margin * (y1 - y0)) * h), int((y1 - margin * (y1 - y0)) * h)
    frame[ya:yb, xa:xb] = rgb_nits


def chart_frame(w=W, h=H):
    """一帧灰阶图, 返回 RGB 线性光 nits (BT.2020 基色)"""
    frame = np.full((h, w, 3), 2.0)  # 底色 2nit
    for cell, nits in zip(_cells(CHART_REGION, 6, 2), CHART_NITS):
        _fill(frame, cell, (nits, nits, nits))
    for cell, nits in zip(_cells(FINE_REGION, 16, 1), FINE_NITS):
        _fill(frame, cell, (nits, nits, nits), margin=0.02)
    x0, y0, x1, y1 = BAND_REGION
    for cell, (name, hue) in zip(_cells(BAND_REGION, 6, 1), BAND_HUES):
        hidx0, hidx1 = int(y0 * h), int(y1 * h)
        ramp = np.linspace(BAND_LO_NITS, BAND_HI_NITS, hidx1 - hidx0)[:, None]
        hue = np.array(hue)
        rgb = (1.0 - BAND_SAT) + BAND_SAT * hue  # 向灰方向去饱和 25%
        band = ramp[:, :, None] * rgb[None, None, :]
        xa, xb = int((cell[0] + 0.02) * w), int((cell[2] - 0.02) * w)
        frame[hidx0:hidx1, xa:xb] = band
    return frame


def gradient_block_frame(t, dur, w=W, h=H):
    """亮度梯度背景 (横向对数 0.05->4000nit) + 2000nit 移动亮块"""
    xs = np.linspace(0, 1, w)
    ramp = 0.05 * (4000.0 / 0.05) ** xs  # 对数梯度
    frame = np.repeat(ramp[None, :, None], h, axis=0).repeat(3, axis=2).copy()
    frame[:, :, 1] *= 0.98  # 轻微偏色便于观察通道处理
    frame[:, :, 2] *= 0.95
    bw = int(0.15 * w)
    x = int((w - bw) * min(max(t / dur, 0.0), 1.0))
    y0, y1 = int(0.4 * h), int(0.4 * h) + bw
    frame[y0:y1, x:x + bw] = 2000.0  # 移动亮块
    frame[int(0.05 * h):int(0.15 * h), int(0.85 * w):int(0.95 * w)] = 4000.0  # 固定极亮块
    return frame


def _rgb_nits_to_yuv420p10(frame_nits):
    """RGB nits (BT.2020) -> PQ 编码 -> yuv420p10le 字节"""
    v = color.pq_oetf(frame_nits)
    kr, kb = color.YCBCR["bt2020"]
    y = v @ color.LUMA_2020
    cb = (v[..., 2] - y) / (2 - 2 * kb)
    cr = (v[..., 0] - y) / (2 - 2 * kr)
    y10 = np.clip(np.round(64 + 876 * y), 0, 1023).astype("<u2")
    cb10 = np.clip(np.round(512 + 896 * cb), 0, 1023).astype("<u2")
    cr10 = np.clip(np.round(512 + 896 * cr), 0, 1023).astype("<u2")
    h, w = y10.shape
    cb_s = cb10.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3)).round().astype("<u2")
    cr_s = cr10.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3)).round().astype("<u2")
    return y10.tobytes() + cb_s.tobytes() + cr_s.tobytes()


def _encode(frames_iter, n_frames, out_path, w=W, h=H, fps=FPS):
    cmd = ["ffmpeg", "-v", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-s", f"{w}x{h}",
           "-r", str(fps), "-i", "-",
           "-frames:v", str(n_frames),
           "-c:v", "libx265", "-preset", "fast", "-crf", "14",
           "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
           "-color_primaries", "bt2020", "-color_trc", "smpte2084",
           "-colorspace", "bt2020nc", "-color_range", "tv",
           "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:"
                           "colormatrix=bt2020nc:max-cll=4000,400:"
                           "master-display=G(13250,34500)B(7500,3000)"
                           "R(34000,16000)WP(15635,16450)L(10000000,1)",
           out_path]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames_iter:
        proc.stdin.write(_rgb_nits_to_yuv420p10(f))
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg 编码失败: {out_path}")
    return out_path


def make_gray_chart(out_path, secs=4.0):
    n = int(secs * FPS)
    frame = chart_frame()
    return _encode((frame for _ in range(n)), n, out_path)


def make_gradient_block(out_path, secs=6.0):
    n = int(secs * FPS)
    return _encode((gradient_block_frame(i / FPS, secs) for i in range(n)), n, out_path)
