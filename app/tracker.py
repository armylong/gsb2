"""单目标模板跟踪核心:支持有限平移与缩放,逐帧输出框与置信度。

设计约束(与需求对应):
- 不做人脸识别,不承诺任意物体跟踪:仅适用于纹理较清楚、
  无明显旋转/形变的目标,以及有限的平移和缩放。
- 结果确定性:同一组关键帧下,无论播放/访问顺序如何,
  任意一帧的框与置信度都相同(每帧结果只取决于它所属
  关键帧分段,从关键帧单向传播计算)。
- 跟不住时绝不把静止旧框显示为可靠:匹配置信度低的帧
  一律标记为 low(待检查)。
"""
from __future__ import annotations

import cv2
import numpy as np

HIGH_SCORE = 0.60   # >= 高置信
MED_SCORE = 0.45    # >= 中置信; 低于此为低置信(待检查)
SCALES = (0.95, 0.975, 1.0, 1.025, 1.05)  # 相邻帧允许的尺度变化
EDGE_PX = 2         # 贴边判定像素(目标可能正在离开画面)


def level_of(score: float) -> str:
    if score >= HIGH_SCORE:
        return "high"
    if score >= MED_SCORE:
        return "medium"
    return "low"


def _crop_tpl(gray: np.ndarray, box) -> np.ndarray:
    x, y, w, h = [int(round(v)) for v in box]
    return gray[y:y + h, x:x + w].copy()


def _match_step(gray: np.ndarray, tpl: np.ndarray, prev_box):
    """在 prev_box 邻域内做多尺度模板匹配,返回 (new_box, score)。"""
    fh, fw = gray.shape[:2]
    px, py, pw, ph = prev_box
    best = None
    for s in SCALES:
        nw = int(round(pw * s))
        nh = int(round(ph * s))
        if nw < 8 or nh < 8 or nw >= fw or nh >= fh:
            continue
        interp = cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR
        t = cv2.resize(tpl, (nw, nh), interpolation=interp)
        mx = int(pw * 0.45) + 14
        my = int(ph * 0.45) + 14
        x0 = max(0, int(px) - mx)
        y0 = max(0, int(py) - my)
        x1 = min(fw, int(px + pw) + mx)
        y1 = min(fh, int(py + ph) + my)
        if x1 - x0 < nw or y1 - y0 < nh:
            # 搜索窗比模板还小(目标贴边),退化为整帧搜索
            x0, y0, x1, y1 = 0, 0, fw, fh
            if x1 - x0 < nw or y1 - y0 < nh:
                continue
        roi = gray[y0:y1, x0:x1]
        res = cv2.matchTemplate(roi, t, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(res)
        if best is None or score > best[0]:
            best = (float(score), x0 + loc[0], y0 + loc[1], nw, nh)
    if best is None:
        return tuple(prev_box), 0.0
    score, bx, by, bw, bh = best
    return (float(bx), float(by), float(bw), float(bh)), score


def _touches_edge(box, fw, fh) -> bool:
    x, y, w, h = box
    return x <= EDGE_PX or y <= EDGE_PX or x + w >= fw - EDGE_PX or y + h >= fh - EDGE_PX


def track_range(get_gray, kf_frame: int, kf_box, lo: int, hi: int):
    """从关键帧向两端逐帧传播,覆盖 [lo, hi]。

    返回 ({frame: (box, score)}, (frame_w, frame_h))。
    """
    gray0 = get_gray(kf_frame)
    fh, fw = gray0.shape[:2]
    tpl = _crop_tpl(gray0, kf_box)
    out = {kf_frame: (tuple(kf_box), 1.0)}
    prev = tuple(kf_box)
    for f in range(kf_frame + 1, hi + 1):
        prev, s = _match_step(get_gray(f), tpl, prev)
        out[f] = (prev, s)
    prev = tuple(kf_box)
    for f in range(kf_frame - 1, lo - 1, -1):
        prev, s = _match_step(get_gray(f), tpl, prev)
        out[f] = (prev, s)
    return out, (fw, fh)


class MaskTrack:
    """管理遮挡起止范围与人工关键帧,产出每帧框与置信度。

    关键帧把 [start, end] 切成若干分段,每个分段由它起点处的
    关键帧负责(首个关键帧还向前覆盖到 start)。修正某帧只会
    重算该关键帧负责的分段,其他人工关键帧及其分段不受影响。
    """

    def __init__(self, get_gray, nframes: int):
        self.get_gray = get_gray
        self.nframes = nframes
        self.start = 0
        self.end = nframes - 1
        self.keyframes: dict[int, tuple] = {}  # frame -> (x,y,w,h)
        self.results: dict[int, dict] = {}     # frame -> {x,y,w,h,score,level,keyframe}

    def set_region(self, start: int, end: int, kf_frame: int, box):
        start = max(0, int(start))
        end = min(self.nframes - 1, int(end))
        if not (start <= kf_frame <= end):
            raise ValueError("框选帧必须位于遮挡起止范围内")
        self.start, self.end = start, end
        self.keyframes = {int(kf_frame): tuple(float(v) for v in box)}
        self.results = {}

    def add_keyframe(self, frame: int, box):
        frame = int(frame)
        if not (self.start <= frame <= self.end):
            raise ValueError("修正帧必须位于遮挡起止范围内")
        self.keyframes[frame] = tuple(float(v) for v in box)

    def remove_keyframe(self, frame: int) -> bool:
        frame = int(frame)
        if frame in self.keyframes and len(self.keyframes) > 1:
            del self.keyframes[frame]
            return True
        return False

    def clear(self):
        self.keyframes = {}
        self.results = {}

    def compute(self):
        """按当前关键帧全量重算 [start, end] 的每帧结果(确定性)。"""
        self.results = {}
        kfs = sorted(self.keyframes)
        if not kfs:
            return
        for i, kf in enumerate(kfs):
            lo = self.start if i == 0 else kf
            hi = self.end if i == len(kfs) - 1 else kfs[i + 1] - 1
            seg, (fw, fh) = track_range(self.get_gray, kf, self.keyframes[kf], lo, hi)
            for f, (box, s) in seg.items():
                lvl = level_of(s)
                if lvl != "low" and _touches_edge(box, fw, fh):
                    lvl = "medium"  # 贴边:目标可能正在离开画面,降一级提示
                self.results[f] = {
                    "x": box[0], "y": box[1], "w": box[2], "h": box[3],
                    "score": round(s, 4), "level": lvl,
                    "keyframe": f in self.keyframes,
                }

    def low_intervals(self):
        """连续低置信帧合并为待检查区间 [(a, b), ...](含端点, 帧号)。"""
        ivs = []
        a = None
        for f in range(self.start, self.end + 1):
            r = self.results.get(f)
            low = r is not None and r["level"] == "low"
            if low and a is None:
                a = f
            elif not low and a is not None:
                ivs.append((a, f - 1))
                a = None
        if a is not None:
            ivs.append((a, self.end))
        return ivs
