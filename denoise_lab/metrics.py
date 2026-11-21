"""对照已知干净参考的客观评估。

隔离约定：
- 本模块是整个项目中唯一允许读取 Sample.clean 的计算模块；
- noise_estimation.py 与 processing.py 的函数签名都不含 clean，
  处理过程中无法读到干净参考（tests/test_pipeline.py 会静态检查这一点）。
- 噪声“估计”（noise_estimation，仅用带噪图）与对参考的“评估”（本模块）
  在 UI 上也是两个独立面板，数字来源互不混用。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

Rect = tuple[int, int, int, int]

FLAT_ZONES = ("flat_dark", "flat_mid", "flat_bright", "flat_dark2")
TEXTURE_ZONES = ("checker", "stripes", "dots", "lines")
CHROMA_ZONE = "chroma"


def _luma(img01: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img01.astype(np.float32), cv2.COLOR_RGB2YCrCb)[..., 0]


def _crop(arr: np.ndarray, rect: Rect) -> np.ndarray:
    y0, y1, x0, x1 = rect
    return arr[y0:y1, x0:x1]


@dataclass
class ZoneReport:
    name: str
    noisy_std: float          # 带噪图 luma 标准差
    processed_std: float      # 处理后 luma 标准差
    clean_std: float          # 干净参考 luma 标准差
    noise_drop_db: float      # 20*log10(noisy_std / processed_std)
    residual_rmse: float      # sqrt(mean((processed-clean)^2))，luma


@dataclass
class EdgeReport:
    grad_corr: float          # 与干净参考 Sobel 梯度的相关系数
    amplitude_keep: float     # 边缘幅度保持率 mean(|Gp|)/mean(|Gc|)
    epi: float                # 经典 EPI = sum|Gp| / sum|Gn|（越大越接近无平滑）


@dataclass
class TextureReport:
    zone: str
    energy_keep: float        # 处理后纹理能量 / 干净纹理能量（1 为满分，明显 <1 即被抹）
    noisy_energy: float
    processed_energy: float
    clean_energy: float


@dataclass
class ChromaReport:
    cr_keep: float            # Cr 通道细节能量保持率（相对干净参考，封顶 1.0）
    cb_keep: float            # Cb 通道细节能量保持率（相对干净参考，封顶 1.0）
    cr_raw: float             # 未封顶原始比值（>1 说明残余色度噪声仍明显）
    cb_raw: float


@dataclass
class FullReport:
    flat: list[ZoneReport]
    flat_noise_drop_db: float     # 平坦区汇总（加权平均）
    edge: EdgeReport
    textures: list[TextureReport]
    chroma: ChromaReport


def _flat_report(name: str, rect: Rect, clean: np.ndarray,
                 noisy: np.ndarray, processed: np.ndarray) -> ZoneReport:
    lc, ln, lp = (_crop(_luma(im), rect) for im in (clean, noisy, processed))
    s_c, s_n, s_p = (float(np.std(x)) for x in (lc, ln, lp))
    drop = 20.0 * np.log10(s_n / max(s_p, 1e-8))
    rmse = float(np.sqrt(np.mean((lp - lc) ** 2)))
    return ZoneReport(name, s_n, s_p, s_c, drop, rmse)


def _sobel_mag(luma: np.ndarray) -> np.ndarray:
    gx = cv2.Sobel(luma, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(luma, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def _edge_report(edge_rects: list[Rect], clean: np.ndarray,
                 noisy: np.ndarray, processed: np.ndarray) -> EdgeReport:
    mc, mn, mp = (_sobel_mag(_luma(im)) for im in (clean, noisy, processed))
    masks = np.zeros(mc.shape, bool)
    for r in edge_rects:
        y0, y1, x0, x1 = r
        masks[y0:y1, x0:x1] = True
    # 只在干净参考本身有边缘的位置评估
    strong = mc > (np.mean(mc[masks]) + 0.5 * np.std(mc[masks]))
    sel = masks & strong
    if sel.sum() < 10:
        sel = masks
    a, b = mc[sel].ravel(), mp[sel].ravel()
    corr = float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else 0.0
    keep = float(np.mean(mp[sel]) / max(np.mean(mc[sel]), 1e-8))
    epi = float(np.sum(mp[sel]) / max(np.sum(mn[sel]), 1e-8))
    return EdgeReport(corr, keep, epi)


def _texture_energy(patch_luma: np.ndarray) -> float:
    """高通能量：纹理区去掉局部均值后的方差。"""
    base = cv2.GaussianBlur(patch_luma, (0, 0), sigmaX=5.0)
    return float(np.mean((patch_luma - base) ** 2))


def _texture_report(name: str, rect: Rect, clean: np.ndarray,
                    noisy: np.ndarray, processed: np.ndarray) -> TextureReport:
    lc, ln, lp = (_crop(_luma(im), rect) for im in (clean, noisy, processed))
    ec, en, ep = (_texture_energy(x) for x in (lc, ln, lp))
    keep = ep / max(ec, 1e-12)
    return TextureReport(name, keep, en, ep, ec)


def _chroma_report(rect: Rect, clean: np.ndarray,
                   noisy: np.ndarray, processed: np.ndarray) -> ChromaReport:
    def chan_energy(img, idx):
        ycrcb = cv2.cvtColor(img.astype(np.float32), cv2.COLOR_RGB2YCrCb)
        p = ycrcb[y0:y1, x0:x1, idx]
        base = cv2.GaussianBlur(p, (0, 0), sigmaX=5.0)
        return float(np.mean((p - base) ** 2))

    y0, y1, x0, x1 = rect
    raws = []
    for idx in (1, 2):  # Cr, Cb，相对干净参考：1.0 = 色度细节完整保留
        ec = chan_energy(clean, idx)
        ep = chan_energy(processed, idx)
        raws.append(ep / max(ec, 1e-12))
    cr_raw, cb_raw = raws
    return ChromaReport(min(cr_raw, 1.0), min(cb_raw, 1.0), cr_raw, cb_raw)


def evaluate(clean: np.ndarray, noisy: np.ndarray, processed: np.ndarray,
             zones: dict[str, Rect]) -> FullReport:
    """对一份处理结果生成完整评估报告。"""
    flat = [_flat_report(z, zones[z], clean, noisy, processed)
            for z in FLAT_ZONES if z in zones]
    weights = np.array([z.noisy_std ** 2 for z in flat], np.float32)
    if weights.sum() <= 0:
        weights = np.ones(len(flat), np.float32)
    flat_drop = float(np.average([z.noise_drop_db for z in flat], weights=weights))

    edge_rects = [zones[z] for z in ("lines",) if z in zones]
    edge = _edge_report(edge_rects, clean, noisy, processed)

    textures = [_texture_report(z, zones[z], clean, noisy, processed)
                for z in TEXTURE_ZONES if z in zones]
    chroma = _chroma_report(zones[CHROMA_ZONE], clean, noisy, processed)
    return FullReport(flat, flat_drop, edge, textures, chroma)
