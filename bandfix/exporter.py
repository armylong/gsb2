"""整片导出:流式读取 -> 条带修复 -> 无损编码 -> 拷回音轨。"""
from __future__ import annotations

from collections import deque

import cv2

from .core import detect_cuts, repair_spatial, repair_temporal, shot_of
from .pipeline import encode_lossless


def export_video(src: str, dst: str, y0: int, y1: int, *,
                 method: str = "temporal", strength: float = 0.85,
                 radius: int = 2, cut_thresh: float = 0.15,
                 audio: bool = True, progress=None) -> dict:
    """处理 src 全部帧,仅改写 [y0,y1) 行带,结果写入 dst(无损 mkv)。

    时域上下文只取同一镜头内的帧(由 detect_cuts 切分)。
    progress(done, total) 为可选回调。返回导出信息字典。
    """
    cuts = detect_cuts(src, thresh=cut_thresh)

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        raise IOError(f"无法打开视频: {src}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    def frames_out():
        past: deque = deque(maxlen=radius)   # 当前帧之前、同镜头候选帧
        buf: deque = deque()                 # buf[0]=当前帧, 后面是未来帧
        for _ in range(radius + 1):
            ok, fr = cap.read()
            if not ok:
                break
            buf.append(fr)
        idx = 0
        while buf:
            cur = buf[0]
            if method == "spatial":
                yield repair_spatial(cur, y0, y1, strength)
            else:
                start, end = shot_of(idx, cuts)
                past_list = list(past)
                ctx = []
                for k in range(idx - radius, idx + radius + 1):
                    f = None
                    if k == idx:
                        f = cur
                    elif k < idx:
                        off = k - (idx - len(past_list))
                        if 0 <= off < len(past_list):
                            f = past_list[off]
                    else:
                        off = k - idx
                        if off < len(buf):
                            f = buf[off]
                    # 跨镜头的一律置空,repair_temporal 会跳过
                    ctx.append(f if (f is not None and start <= k < end) else None)
                yield repair_temporal(ctx, y0, y1, strength)
            idx += 1
            if progress:
                progress(idx, total)
            past.append(buf.popleft())
            ok, fr = cap.read()
            if ok:
                buf.append(fr)
        cap.release()

    encode_lossless(frames_out(), dst, fps, (w, h), audio_src=src if audio else None)
    return {"dst": dst, "frames": total, "fps": fps, "cuts": cuts,
            "band": (y0, y1), "method": method, "strength": strength}
