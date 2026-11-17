"""绿幕色键抠像核心管线（纯 numpy / OpenCV，无 GUI 依赖）。

GUI 预览和离线导出都调用 :func:`process_frame`，两条路径使用完全
相同的算法，避免“预览好看、导出不一样”。

处理步骤：
  1. HSV 门限 + 归一化 RGB 距离共同度量每个像素属于背景（绿幕）的程度；
  2. 前景保护：从画面四边做连通域，只把“与外部绿幕连通”的区域当背景，
     被前景包住的近绿色区域按保护强度保留；
  3. 边缘过渡：软阈值（similarity/smoothness）+ 羽化 + choke 收边；
  4. 绿色反光抑制（despill），只在有绿色溢出的像素上动作；
  5. 与静态背景按 alpha 合成。

所有图像在模块内部统一使用 OpenCV 约定的 BGR uint8 / float32。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import cv2
import numpy as np

from . import ProcessingError


def _smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    """平滑的 0→1 过渡，edge0 以下为 0、edge1 以上为 1。"""
    if edge1 <= edge0:
        return (x >= edge1).astype(np.float32)
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _hue_distance(h: np.ndarray, center: float) -> np.ndarray:
    """OpenCV H 通道（0~180）上的环形色相距离，结果归一化到 0~1。"""
    d = np.abs(h.astype(np.float32) - float(center))
    d = np.minimum(d, 180.0 - d)
    return d / 90.0  # 最大环形距离是 90（半圈）


@dataclass
class KeyingParams:
    """抠像参数。所有强度类参数统一为 0.0~1.0，便于滑块与序列化。

    key_bgr:        取色器得到的背景色（BGR，uint8 三元组）。
    hue_width:      接受的色相宽度，越大越宽容。
    sat_min/val_min: HSV 门限，过暗/过灰的像素不会被当成绿幕。
    similarity:     背景软阈值内边界，越小去除越激进。
    smoothness:     软过渡带宽度，控制边缘柔和程度。
    edge_feather:   对 alpha 做高斯羽化的强度。
    edge_choke:     收边（侵蚀 alpha）强度，用于压掉绿边。
    spill_strength: 绿色反光抑制强度。
    protection:     前景保护强度（保护与背景颜色接近、但被前景包住的区域）。
    shadow_protect: 暗部/低饱和保护强度。发丝等细节往往色相仍接近绿幕，
                    但明显更暗、更灰；该参数据此把它们从背景判定里救回。
    despill_on / protection_on: 对应处理的开关，方便做前后对比。
    """

    key_bgr: tuple[int, int, int] = (80, 255, 80)
    hue_width: float = 0.45
    sat_min: float = 0.25
    val_min: float = 0.2
    similarity: float = 0.45
    smoothness: float = 0.35
    edge_feather: float = 0.25
    edge_choke: float = 0.1
    spill_strength: float = 0.6
    protection: float = 0.6
    shadow_protect: float = 0.8
    despill_on: bool = True
    protection_on: bool = True

    def to_dict(self) -> dict:
        d = asdict(self)
        d["key_bgr"] = list(self.key_bgr)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "KeyingParams":
        d = dict(d)
        if "key_bgr" in d:
            d["key_bgr"] = tuple(int(v) for v in d["key_bgr"])
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


def compute_background_score(frame_bgr: np.ndarray, params: KeyingParams) -> np.ndarray:
    """返回每像素“属于绿幕背景”的程度，0~1 float32，越大越像背景。"""
    if frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3:
        raise ProcessingError("画面不是 3 通道 BGR 图像，无法计算背景分数")

    f = frame_bgr.astype(np.float32) / 255.0
    b, g, r = f[:, :, 0], f[:, :, 1], f[:, :, 2]

    key = np.asarray(params.key_bgr, dtype=np.float32) / 255.0
    # 归一化 RGB 欧氏距离（按 sqrt(3) 归一到 0~1）
    dist = np.sqrt(((f - key) ** 2).sum(axis=2)) / np.sqrt(3.0)

    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    key_hsv = cv2.cvtColor(
        np.uint8([[list(params.key_bgr)]]), cv2.COLOR_BGR2HSV
    )[0, 0]

    hue_dist = _hue_distance(h, float(key_hsv[0]))
    # 色相偏离越远，背景分数越低；hue_width 控制容忍宽度
    hue_gate = 1.0 - _smoothstep(
        params.hue_width * 0.4, params.hue_width, hue_dist
    )
    # 饱和度 / 明度不足的像素不当背景（暗部、灰发、噪声）
    sat_gate = _smoothstep(params.sat_min * 0.5, params.sat_min,
                           s.astype(np.float32) / 255.0)
    val_gate = _smoothstep(params.val_min * 0.5, params.val_min,
                           v.astype(np.float32) / 255.0)

    # 距离越近分数越高；再由色相/饱和度/明度门限抑制
    score = (1.0 - _smoothstep(params.similarity,
                               params.similarity + params.smoothness, dist))
    score = score * hue_gate * sat_gate * val_gate

    # 暗部/低饱和保护：发丝等细节色相可能仍接近绿幕，但明显更暗、更灰。
    # 用“暗度 + 灰度”组成前景置信度，压低这部分像素的背景分数，
    # 鲜亮的纯绿幕（V、S 都高）不受影响。
    if params.shadow_protect > 0.0:
        v_norm = v.astype(np.float32) / 255.0
        s_norm = s.astype(np.float32) / 255.0
        darkness = 1.0 - _smoothstep(0.45, 0.85, v_norm)
        grayness = 1.0 - _smoothstep(0.35, 0.75, s_norm)
        fg_confidence = np.clip(darkness * 0.6 + grayness * 0.4, 0.0, 1.0)
        score = score * (1.0 - fg_confidence * params.shadow_protect)

    return np.clip(score, 0.0, 1.0).astype(np.float32)


def _border_connected_mask(binary_bg: np.ndarray) -> np.ndarray:
    """标记与画面四边连通的背景像素。

    用 floodFill 从所有边界背景点泛洪，得到“真正连到外部绿幕”的区域；
    前景内部孤立的近绿色块不会被标记，从而可被前景保护保留。
    """
    h, w = binary_bg.shape
    # floodFill 需要单通道 0/255 图，并在四周留一像素 padding
    work = np.zeros((h + 2, w + 2), np.uint8)
    work[1:-1, 1:-1] = (binary_bg > 0).astype(np.uint8) * 255
    seeds = []
    for x in range(w):
        seeds.append((x, 0))
        seeds.append((x, h - 1))
    for y in range(h):
        seeds.append((0, y))
        seeds.append((w - 1, y))
    for x, y in seeds:
        if work[y + 1, x + 1] == 255:
            cv2.floodFill(work, None, (x + 1, y + 1), 128)
    connected = (work[1:-1, 1:-1] == 128)
    return connected


def compute_alpha(frame_bgr: np.ndarray, params: KeyingParams) -> np.ndarray:
    """根据参数计算前景 alpha（1=完全前景，0=完全背景），float32 0~1。"""
    score = compute_background_score(frame_bgr, params)
    hard_bg = (score > 0.5).astype(np.uint8)

    if params.protection_on and params.protection > 0.0:
        connected = _border_connected_mask(hard_bg)
        # 孤立（不连外部）的近绿色像素：按保护强度恢复为前景
        isolated = (hard_bg > 0) & (~connected)
        if isolated.any():
            # protection=1 时完全保留孤立区域，=0 时退化为普通色键
            score[isolated] *= (1.0 - params.protection)

    alpha = 1.0 - score

    # choke：先轻微侵蚀，压掉发丝外的一圈绿边
    if params.edge_choke > 0.0:
        k = max(1, int(round(params.edge_choke * 6)))
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)
        )
        alpha = cv2.erode(alpha, kernel, iterations=1)

    # feather：高斯羽化让边缘过渡自然（发丝关键）
    if params.edge_feather > 0.0:
        ksize = int(round(params.edge_feather * 20)) * 2 + 1
        alpha = cv2.GaussianBlur(alpha, (ksize, ksize), 0)

    return np.clip(alpha, 0.0, 1.0).astype(np.float32)


def despill(frame_bgr: np.ndarray, alpha: np.ndarray,
            params: KeyingParams) -> np.ndarray:
    """抑制前景边缘的绿色反光（spill）。

    只在绿色通道确实高于红蓝通道的像素上，把绿通道往下拉到
    红蓝通道的最大值附近；强度由 spill_strength 控制。纯背景像素
    马上会被 alpha 清掉，因此只在半透明/前景区域加权处理。
    """
    f = frame_bgr.astype(np.float32)
    b, g, r = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    rb_max = np.maximum(b, r)
    excess = np.maximum(g - rb_max, 0.0)  # 只有绿“溢出”时才为正
    weight = np.clip(excess / 255.0 * 3.0, 0.0, 1.0)
    fg_weight = np.clip(alpha * 1.5, 0.0, 1.0)  # 前景边缘权重最高
    g_new = g - excess * weight * params.spill_strength * fg_weight
    f[:, :, 1] = np.clip(g_new, 0.0, 255.0)
    return f.astype(np.uint8)


def make_checkerboard(h: int, w: int, cell: int = 12) -> np.ndarray:
    """生成棋盘格底，用于展示抠出的前景（透明区域）。"""
    ys, xs = np.mgrid[0:h, 0:w]
    checker = (((ys // cell) + (xs // cell)) % 2).astype(np.uint8)
    board = np.where(checker == 1, 200, 245)
    return np.repeat(board[:, :, None], 3, axis=2).astype(np.uint8)


def composite(frame_bgr: np.ndarray, alpha: np.ndarray,
              background_bgr: np.ndarray) -> np.ndarray:
    """按 alpha 把前景合成到静态背景上（背景自动缩放到前景尺寸）。"""
    h, w = frame_bgr.shape[:2]
    if background_bgr.shape[:2] != (h, w):
        background_bgr = cv2.resize(background_bgr, (w, h),
                                    interpolation=cv2.INTER_AREA)
    a = alpha[:, :, None]
    fg = frame_bgr.astype(np.float32)
    bg = background_bgr.astype(np.float32)
    out = fg * a + bg * (1.0 - a)
    return np.clip(out, 0, 255).astype(np.uint8)


def process_frame(frame_bgr: np.ndarray, background_bgr: np.ndarray,
                  params: KeyingParams) -> dict[str, np.ndarray]:
    """一帧的完整处理，返回原始/前景(带棋盘格)/alpha/合成四张图。

    预览与导出共用本函数，导出时只取 ``composite`` 写盘，从而保证
    导出画面与预览逐像素一致。
    """
    if frame_bgr is None or frame_bgr.size == 0:
        raise ProcessingError("拿到的是空画面（视频可能已损坏或不支持）")
    alpha = compute_alpha(frame_bgr, params)

    if params.despill_on and params.spill_strength > 0.0:
        fg_corrected = despill(frame_bgr, alpha, params)
    else:
        fg_corrected = frame_bgr

    board = make_checkerboard(*frame_bgr.shape[:2])
    foreground = composite(fg_corrected, alpha, board)
    comp = composite(fg_corrected, alpha, background_bgr)
    alpha_vis = np.repeat((alpha * 255).astype(np.uint8)[:, :, None], 3, axis=2)
    return {
        "original": frame_bgr,
        "foreground": foreground,
        "alpha": alpha_vis,
        "composite": comp,
        "alpha_float": alpha,
    }
