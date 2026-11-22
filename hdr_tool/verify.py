"""成片回读校验: 从导出的 SDR 视频读代表帧, 对照预览预测的各档读数与灰阶顺序。

容差说明 (见 README):
  H.264 8bit 4:2:0 有损编码, 逐像素码值允许 ±2/255 的量化误差;
  亮度读数在码值域比较, |Δ| <= 2 判为一致; 灰阶顺序要求单调不降。
"""
import json
import subprocess

import numpy as np

from . import color
from .video import _run, VideoError

TOLERANCE_CODE = 2  # 允许的 8bit 码值误差


def readback_frame_rgb(path, t, w, h):
    """从成片解码一帧为 RGB24"""
    p = _run(["ffmpeg", "-v", "error", "-ss", f"{t:.6f}", "-i", path,
              "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    need = w * h * 3
    if len(p.stdout) < need:
        raise VideoError(f"回读 {path} @{t:.2f}s 失败: 字节数不足")
    return np.frombuffer(p.stdout[:need], dtype=np.uint8).reshape(h, w, 3)


def probe_comment(path):
    p = _run(["ffprobe", "-v", "error", "-show_entries", "format_tags=comment",
              "-of", "json", path])
    tags = json.loads(p.stdout.decode()).get("format", {}).get("tags", {})
    return tags.get("comment", "")


def sample_patch(rgb, x, y, r=6):
    """取 (x,y) 周围 (2r+1)^2 区域中位数, 抗编码噪声"""
    h, w = rgb.shape[:2]
    ya, yb = max(0, y - r), min(h, y + r + 1)
    xa, xb = max(0, x - r), min(w, x + r + 1)
    return np.median(rgb[ya:yb, xa:xb].reshape(-1, 3), axis=0)


def rel_luminance(rgb8):
    """8bit RGB -> 显示侧相对亮度 [0,1] (BT.709 反 OETF 后加权)"""
    lin = color.bt709_oetf_inv(np.asarray(rgb8, dtype=np.float64) / 255.0)
    return lin @ color.LUMA_709


def compare_points(points, preview_rgb8, back_rgb8):
    """对照一组采样点。points: testgen.chart_points() 的元素(可含 nits 标称值)。

    preview_rgb8/back_rgb8: 预览管线输出与成片回读帧 (同尺寸 8bit RGB)。
    返回行列表: dict(label, kind, nits, preview_code, back_code, delta, ok)
    """
    rows = []
    for pt in points:
        pv = sample_patch(preview_rgb8, pt["x"], pt["y"])
        bk = sample_patch(back_rgb8, pt["x"], pt["y"])
        pv_y = float(rel_luminance(pv))
        bk_y = float(rel_luminance(bk))
        pv_code = color.bt709_oetf(pv_y) * 255.0
        bk_code = color.bt709_oetf(bk_y) * 255.0
        delta = bk_code - pv_code
        rows.append({
            "kind": pt.get("kind", ""), "label": pt.get("label", ""),
            "nits": pt.get("nits"),
            "preview_rel": pv_y, "back_rel": bk_y,
            "preview_code": pv_code, "back_code": bk_code,
            "delta": delta, "ok": abs(delta) <= TOLERANCE_CODE,
        })
    return rows


def check_order(rows):
    """灰阶顺序检查: 按标称亮度排序后, 回读亮度应单调不降。返回 (是否通过, 违例描述列表)"""
    gray = [r for r in rows if r["nits"] is not None]
    gray.sort(key=lambda r: r["nits"])
    bad = []
    for a, b in zip(gray, gray[1:]):
        if b["back_rel"] < a["back_rel"] - 1e-4:
            bad.append(f"{a['label']}({a['back_rel']:.4f}) > {b['label']}({b['back_rel']:.4f})")
    return not bad, bad
