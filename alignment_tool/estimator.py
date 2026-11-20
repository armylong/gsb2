"""亚像素平移估计：相位相关（多候选峰）+ ECC 交叉验证 + 可信度评估。

设计要点
--------
1. 相位相关面 ifft2(F_b·conj(F_a)/|·|) 给出整数像素候选峰，亚像素精化采用
   OpenCV 官方 phaseCorrelate（峰邻域加权重心），实测比亚像素抛物线拟合更准；
2. ECC（MOTION_TRANSLATION）以相位结果为初值迭代，仅作交叉验证，不覆盖相位结果
   （低纹理/条纹下 ECC 会因孔径问题陷入局部极值）；
3. 低纹理、重复条纹会产生多个能量接近的候选峰或方向性歧义，本模块汇总
   纹理强度、梯度各向异性、峰间能量比、响应强度、ECC 一致性给出可信度等级，
   并逐条给出判定依据，提示人工复核。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Candidate:
    dx: float
    dy: float
    peak: float          # 相位相关峰能量（归一化后约 0~1）


@dataclass
class EstimateResult:
    dx: float                       # 最终采用的位移估计（向右为正）
    dy: float
    method: str                     # phase_correlate / failed
    candidates: list[Candidate] = field(default_factory=list)
    confidence: float = 0.0         # 0~1 综合分
    level: str = "unknown"          # high / medium / low
    reasons: list[str] = field(default_factory=list)
    texture_score: float = 0.0      # 参考图纹理强度（归一化梯度能量）
    anisotropy: float = 0.0         # 梯度方向各向异性 0~1，越大越接近单向条纹
    peak_ratio: float = 0.0         # 次峰 / 主峰能量比，越大越可疑
    response: float = 0.0           # phaseCorrelate 返回的响应强度
    ecc_available: bool = False
    ecc_dx: float = 0.0
    ecc_dy: float = 0.0
    ecc_corr: float = 0.0           # ECC 最终相关系数
    ecc_agrees: bool = False        # ECC 与相位结果是否一致（<1 px）
    hann: bool = True


def _window_2d(h: int, w: int) -> np.ndarray:
    """汉宁窗，抑制频谱泄漏导致的边缘伪峰。"""
    return np.outer(np.hanning(h), np.hanning(w)).astype(np.float64)


def _fft_shift_index(idx: int, n: int) -> int:
    """把 fftfreq 风格的非负索引换算为带符号位移（支持负方向）。"""
    return idx if idx <= n // 2 else idx - n


def cross_phase_surface(
    ref_gray: np.ndarray, moving_gray: np.ndarray, use_hann: bool = True
) -> np.ndarray:
    """计算归一化互功率谱的逆 FFT（相位相关面）。"""
    a = ref_gray.astype(np.float64)
    b = moving_gray.astype(np.float64)
    if use_hann:
        win = _window_2d(*a.shape)
        a = a * win
        b = b * win
    fa = np.fft.fft2(a)
    fb = np.fft.fft2(b)
    r = fb * np.conjugate(fa)
    mag = np.abs(r)
    mag[mag < 1e-12] = 1e-12
    return np.fft.ifft2(r / mag).real


def _local_maxima(p: np.ndarray, min_distance: int = 3) -> list[tuple[int, int, float]]:
    """取相位相关面上的局部极大值点（按 FFT 环绕距离做峰间距抑制）。"""
    h, w = p.shape
    kernel = np.ones((2 * min_distance + 1,) * 2, np.uint8)
    dilated = cv2.dilate(p, kernel)
    peaks_mask = (p == dilated) & (p > 0)
    ys, xs = np.nonzero(peaks_mask)
    vals = p[ys, xs]
    order = np.argsort(vals)[::-1]
    picked: list[tuple[int, int, float]] = []
    for idx in order:
        y, x, v = int(ys[idx]), int(xs[idx]), float(vals[idx])
        ok = True
        for py, px, _ in picked:
            ddx = abs(x - px)
            ddy = abs(y - py)
            ddx = min(ddx, w - ddx)
            ddy = min(ddy, h - ddy)
            if ddx < min_distance and ddy < min_distance:
                ok = False
                break
        if ok:
            picked.append((y, x, v))
        if len(picked) >= 8:
            break
    return picked


def _texture_metrics(ref_gray: np.ndarray) -> tuple[float, float]:
    """返回 (纹理强度分, 梯度各向异性)。

    纹理强度：Sobel 梯度能量，归一化到约 0~1；
    各向异性：结构张量 λmax/(λmax+λmin) 风格的度量，接近 1 表示图像只有
    单一方向的纹理（竖/横条纹），垂直于条纹方向的位移无法可靠定位（孔径问题）。
    """
    g = ref_gray.astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    energy = float(np.mean(gx**2 + gy**2))
    texture = float(np.clip(energy / 400.0, 0.0, 1.0))

    # 结构张量分量（先平滑，抑制逐像素噪声）
    jxx = cv2.GaussianBlur(gx * gx, (0, 0), 2.0)
    jyy = cv2.GaussianBlur(gy * gy, (0, 0), 2.0)
    jxy = cv2.GaussianBlur(gx * gy, (0, 0), 2.0)
    tr = jxx + jyy
    det = jxx * jyy - jxy * jxy
    disc = np.sqrt(np.maximum(tr * tr - 4.0 * det, 0.0))
    lambda_max = (tr + disc) / 2.0
    lambda_min = (tr - disc) / 2.0
    denom = lambda_max + np.maximum(lambda_min, 1e-6)
    aniso_map = lambda_max / denom          # 0.5=各向同性, 1=单向
    # 只在有梯度的地方统计各向异性，避免平坦区拉高
    weight = np.clip(tr / (np.mean(tr) + 1e-6), 0.0, 3.0)
    if weight.sum() < 1e-6:
        anisotropy = 0.5
    else:
        anisotropy = float(np.sum(aniso_map * weight) / np.sum(weight))
    # 映射到 0~1：各向同性 0.5 -> 0
    anisotropy = float(np.clip((anisotropy - 0.5) * 2.0, 0.0, 1.0))
    return texture, anisotropy


def _ecc_translation(
    ref_gray: np.ndarray,
    moving_gray: np.ndarray,
    init_dx: float,
    init_dy: float,
) -> tuple[float, float, float] | None:
    """以相位估计为初值的 ECC 平移精修。返回 (dx, dy, 相关系数)。

    ECC 从零初值在低纹理/重复纹理上极易陷入局部极值，因此必须传入相位初值；
    返回的 warp 满足 moving(x) = ref(x - t)，t 即 moving 相对 ref 的位移。
    """
    a = ref_gray.astype(np.float32)
    b = moving_gray.astype(np.float32)
    warp = np.array([[1.0, 0.0, init_dx], [0.0, 1.0, init_dy]], dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    try:
        cc, warp = cv2.findTransformECC(
            a, b, warp, cv2.MOTION_TRANSLATION, criteria, None, 5
        )
    except cv2.error:
        return None
    return float(warp[0, 2]), float(warp[1, 2]), float(cc)


def _grade(score: float) -> str:
    if score >= 0.75:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"


def estimate_shift(
    ref_gray: np.ndarray,
    moving_gray: np.ndarray,
    use_hann: bool = True,
    use_ecc: bool = True,
) -> EstimateResult:
    """估计 moving 相对 ref 的亚像素位移 (dx, dy)，并评估可信度。"""
    if ref_gray.shape != moving_gray.shape:
        raise ValueError("两张图必须同尺寸才能估计平移")
    h, w = ref_gray.shape
    reasons: list[str] = []

    texture, anisotropy = _texture_metrics(ref_gray)
    surface = cross_phase_surface(ref_gray, moving_gray, use_hann)
    maxima = _local_maxima(surface)

    candidates: list[Candidate] = []
    for y, x, v in maxima:
        candidates.append(
            Candidate(dx=float(_fft_shift_index(x, w)),
                      dy=float(_fft_shift_index(y, h)), peak=v)
        )

    if not candidates:
        return EstimateResult(
            dx=0.0, dy=0.0, method="failed", confidence=0.0, level="low",
            reasons=["相位相关面未找到有效峰，配准失败"],
            texture_score=texture, anisotropy=anisotropy,
        )

    # 亚像素精化：OpenCV 官方实现（峰邻域加权重心）
    a = ref_gray.astype(np.float64)
    b = moving_gray.astype(np.float64)
    if use_hann:
        win = _window_2d(h, w)
        (sub_dx, sub_dy), response = cv2.phaseCorrelate(a * win, b * win)
    else:
        (sub_dx, sub_dy), response = cv2.phaseCorrelate(a, b)
    sub_dx, sub_dy = float(sub_dx), float(sub_dy)
    response = float(response)

    # 若官方亚像素峰与我们找到的整数主峰环绕距离 >1px，以整数主峰为准
    top = candidates[0]
    wrap_dx = abs(sub_dx - top.dx)
    wrap_dy = abs(sub_dy - top.dy)
    wrap_dx = min(wrap_dx, w - wrap_dx)
    wrap_dy = min(wrap_dy, h - wrap_dy)
    if wrap_dx > 1.5 or wrap_dy > 1.5:
        reasons.append("亚像素精化峰与主峰位置不一致，回退到整数主峰")
        final_dx, final_dy = top.dx, top.dy
    else:
        final_dx, final_dy = sub_dx, sub_dy

    second = candidates[1] if len(candidates) > 1 else None
    peak_ratio = (second.peak / top.peak) if second and top.peak > 1e-12 else 0.0

    # ECC 交叉验证（带相位初值），只验证不覆盖
    ecc_dx = ecc_dy = ecc_cc = 0.0
    ecc_ok = False
    ecc_agrees = False
    if use_ecc:
        ecc_out = _ecc_translation(ref_gray, moving_gray, final_dx, final_dy)
        if ecc_out is not None:
            ecc_dx, ecc_dy, ecc_cc = ecc_out
            ecc_ok = True
            ecc_agrees = np.hypot(ecc_dx - final_dx, ecc_dy - final_dy) < 1.0
            if not ecc_agrees:
                reasons.append(
                    f"ECC 估计 ({ecc_dx:+.2f}, {ecc_dy:+.2f}) 与相位结果偏差 ≥1px，"
                    "保留相位结果，建议人工复核"
                )

    # ---------- 可信度评分（0~1） ----------
    score = 1.0

    if texture < 0.25:
        score -= (0.25 - texture) / 0.25 * 0.55
        reasons.append(f"低纹理场景（纹理分 {texture:.2f}），相位相关不可靠")
    elif texture < 0.45:
        score -= 0.15
        reasons.append(f"纹理偏弱（纹理分 {texture:.2f}）")

    if anisotropy > 0.85:
        score -= 0.35
        reasons.append(
            f"强方向性纹理/条纹（各向异性 {anisotropy:.2f}），"
            "垂直条纹方向的位移存在孔径歧义，候选可能不唯一"
        )
    elif anisotropy > 0.65:
        score -= 0.15
        reasons.append(f"纹理有一定方向性（各向异性 {anisotropy:.2f}）")

    if peak_ratio > 0.9:
        score -= 0.4
        reasons.append(f"多个能量接近的候选峰（次峰/主峰={peak_ratio:.2f}），疑似重复纹理")
    elif peak_ratio > 0.7:
        score -= 0.2
        reasons.append(f"次峰能量较高（次峰/主峰={peak_ratio:.2f}），存在歧义")

    if response < 0.05:
        score -= 0.25
        reasons.append(f"相位相关响应偏低（{response:.3f}），可能存在强噪声或内容不一致")

    if ecc_ok:
        if not ecc_agrees:
            score -= 0.15
        elif ecc_cc < 0.8:
            score -= 0.1
            reasons.append(f"ECC 相关系数偏低（{ecc_cc:.3f}）")
    else:
        score -= 0.05
        reasons.append("ECC 未收敛，仅使用相位相关结果")

    score = float(np.clip(score, 0.0, 1.0))
    level = _grade(score)
    if level == "high":
        reasons.append("主峰突出、纹理充分且 ECC 交叉验证一致，结果可信")
    elif level == "low":
        reasons.append("可信度低，请人工修正位移后再导出")
    else:
        reasons.append("结果基本可用，建议结合残差图与候选峰确认")

    return EstimateResult(
        dx=final_dx,
        dy=final_dy,
        method="phase_correlate",
        candidates=candidates,
        confidence=score,
        level=level,
        reasons=reasons,
        texture_score=texture,
        anisotropy=anisotropy,
        peak_ratio=peak_ratio,
        response=response,
        ecc_available=ecc_ok,
        ecc_dx=ecc_dx,
        ecc_dy=ecc_dy,
        ecc_corr=ecc_cc,
        ecc_agrees=ecc_agrees,
        hann=use_hann,
    )
