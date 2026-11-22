"""斜边法分析核心: 直边拟合 -> ESF -> LSF -> MTF, 全部基于 numpy/scipy。

坐标约定: 点 x = (col, row), 单位为原图像素; 直边方程 n·x = rho,
单位法向 n 始终由黑侧指向白侧(ESF 随有符号距离 d=n·x-rho 上升)。
所有计算只使用图像像素坐标, 与界面的缩放/旋转预览完全无关。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage, signal, stats

# 超采样 bin 宽(原图像素的 1/4), 对应 4 倍超采样
BIN_WIDTH = 0.25


@dataclass
class Flag:
    """一条可信度提示。level: error(低可信) / warn(需注意) / info(参考)。"""

    code: str
    level: str
    message: str


@dataclass
class EdgeFit:
    nx: float
    ny: float
    rho: float                      # n·x = rho, 全局图像坐标
    angle_deg: float                # 边缘与最近像素轴的夹角(度)
    residual_rms_px: float
    bins_used: int
    bins_total: int
    outlier_fraction: float

    @property
    def normal(self) -> np.ndarray:
        return np.array([self.nx, self.ny], dtype=float)


@dataclass
class AnalysisResult:
    roi: tuple[int, int, int, int]          # x0, y0, w, h(全局图像像素)
    edge: EdgeFit
    fit_half_width: float                   # 拟合范围 ±R(原图像素)
    inverted: bool
    # 全部 ROI 原像素样本
    sample_dist: np.ndarray                 # 每个像素到直边的有符号距离
    sample_value: np.ndarray                # 对应灰度(0..1, 反转时取负)
    sample_used: np.ndarray                 # 是否进入拟合范围
    # ESF(binned)
    esf_dist: np.ndarray
    esf_mean: np.ndarray
    esf_std: np.ndarray
    esf_count: np.ndarray
    # LSF / MTF
    lsf_dist: np.ndarray
    lsf: np.ndarray
    mtf_freq: np.ndarray                    # 周期/原图像素
    mtf: np.ndarray
    # 读数
    dark_level: float
    light_level: float
    contrast: float
    noise_est: float
    mtf50: float | None                     # 周期/像素, 找不到为 None
    mtf_nyquist: float                      # MTF @ 0.5 周期/像素
    ringing_pct: float                      # LSF 负瓣相对主峰
    overshoot_pct: float                    # ESF 越过平台的比例
    flags: list[Flag] = field(default_factory=list)

    @property
    def confidence(self) -> str:
        if any(f.level == "error" for f in self.flags):
            return "低"
        if any(f.level == "warn" for f in self.flags):
            return "中"
        return "高"

    def flag_dicts(self) -> list[dict]:
        return [{"code": f.code, "level": f.level, "message": f.message}
                for f in self.flags]


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

def to_gray(image: np.ndarray) -> np.ndarray:
    """任意常见 dtype/通道的图像转 float64 灰度, 归一化到 0..1。"""
    img = np.asarray(image)
    if img.dtype == np.uint8:
        img = img.astype(np.float64) / 255.0
    elif img.dtype == np.uint16:
        img = img.astype(np.float64) / 65535.0
    else:
        img = img.astype(np.float64)
        m = max(abs(img.min()), abs(img.max()), 1.0)
        if m > 1.5:
            img = img / m
    if img.ndim == 3:
        if img.shape[2] == 4:
            img = img[..., :3]
        w = np.array([0.2126, 0.7152, 0.0722])
        img = img @ w
    return img


def edge_segment(roi: tuple[int, int, int, int], edge: EdgeFit
                 ) -> tuple[np.ndarray, np.ndarray] | None:
    """求直线 n·x=rho 与 ROI 矩形的两个交点(全局坐标), 供界面绘制。"""
    x0, y0, w, h = roi
    n = edge.normal
    candidates: list[np.ndarray] = []
    # 四条边 x=x0 / x=x0+w / y=y0 / y=y0+h
    if abs(n[0]) > 1e-12:
        for x in (x0, x0 + w):
            y = (edge.rho - n[0] * x) / n[1] if abs(n[1]) > 1e-12 else None
            if y is not None and y0 - 1e-9 <= y <= y0 + h + 1e-9:
                candidates.append(np.array([x, y]))
    if abs(n[1]) > 1e-12:
        for y in (y0, y0 + h):
            x = (edge.rho - n[1] * y) / n[0] if abs(n[0]) > 1e-12 else None
            if x is not None and x0 - 1e-9 <= x <= x0 + w + 1e-9:
                candidates.append(np.array([x, y]))
    if len(candidates) < 2:
        return None
    pts = np.unique(np.round(np.array(candidates), 6), axis=0)
    if len(pts) < 2:
        return None
    # 取距离最远的两点
    d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=-1
                       ).reshape(-1)
    i, j = divmod(int(np.argmax(d)), len(pts))
    return pts[i], pts[j]


# --------------------------------------------------------------------------
# 直边鲁棒拟合
# --------------------------------------------------------------------------

def fit_edge(gray: np.ndarray, roi: tuple[int, int, int, int]) -> EdgeFit:
    """在 ROI 内用梯度加权 PCA 定初值 + 切向分箱 + Theil-Sen 稳健拟合直边。"""
    x0, y0, w, h = roi
    sub = gray[y0:y0 + h, x0:x0 + w]
    if min(sub.shape) < 4:
        raise ValueError("选区太小(每边至少 4 像素)")

    gx = ndimage.sobel(sub, axis=1)
    gy = ndimage.sobel(sub, axis=0)
    mag = np.hypot(gx, gy)

    med = float(np.median(mag))
    mad = float(np.median(np.abs(mag - med))) + 1e-12
    thr = max(0.12 * float(mag.max()), med + 4.0 * 1.4826 * mad)
    wt = np.where(mag > thr, mag, 0.0)
    if wt.sum() <= 1e-12:
        raise ValueError("选区里找不到足够强的边缘(对比过小或没有直边)")

    rows, cols = np.nonzero(np.ones_like(sub))
    xs = cols.astype(float) + 0.5          # 局部坐标
    ys = rows.astype(float) + 0.5
    wt = wt.ravel()
    W = wt.sum()
    mx = float((wt * xs).sum() / W)
    my = float((wt * ys).sum() / W)
    cx, cy = xs - mx, ys - my
    cov = np.array([
        [(wt * cx * cx).sum(), (wt * cx * cy).sum()],
        [(wt * cx * cy).sum(), (wt * cy * cy).sum()],
    ]) / W
    eigvals, eigvecs = np.linalg.eigh(cov)
    tangent = eigvecs[:, int(np.argmax(eigvals))]
    n0 = np.array([-tangent[1], tangent[0]])

    s = tangent[0] * cx + tangent[1] * cy
    d0 = n0[0] * cx + n0[1] * cy

    # 沿切向每 ~1 像素分箱, 箱内做梯度加权的法向质心(亚像素)
    span = float(s.max() - s.min())
    nb = max(5, int(np.ceil(span)))
    edges = np.linspace(s.min(), s.max() + 1e-9, nb + 1)
    idx = np.clip(np.digitize(s, edges) - 1, 0, nb - 1)
    sum_w = np.zeros(nb)
    sum_wd = np.zeros(nb)
    np.add.at(sum_w, idx, wt)
    np.add.at(sum_wd, idx, wt * d0)
    ok = sum_w > 0.05 * W / nb
    if ok.sum() < 4:
        raise ValueError("有效边缘点过少, 无法拟合直边")
    s_centers = 0.5 * (edges[:-1] + edges[1:])[ok]
    d_bar = (sum_wd / np.maximum(sum_w, 1e-12))[ok]
    bin_w = sum_w[ok]

    # Theil-Sen 稳健直线 + 残差剔除 + 加权最小二乘精修
    a0, b0 = stats.theilslopes(d_bar, s_centers)[:2]
    resid = d_bar - (a0 * s_centers + b0)
    sigma = 1.4826 * np.median(np.abs(resid - np.median(resid))) + 1e-9
    keep = np.abs(resid) < max(1.0, 3.0 * sigma)
    if keep.sum() < 3:
        keep = np.ones_like(resid, dtype=bool)
    sw = bin_w[keep]
    A = np.column_stack([s_centers[keep], np.ones(keep.sum())])
    (a, b), *_ = np.linalg.lstsq(A * np.sqrt(sw)[:, None],
                                 d_bar[keep] * np.sqrt(sw), rcond=None)
    resid_fit = d_bar[keep] - (a * s_centers[keep] + b)
    rms = float(np.sqrt(np.sum(sw * resid_fit**2) / np.sum(sw)))

    n_raw = n0 - a * tangent
    norm = float(np.linalg.norm(n_raw))
    n_unit = n_raw / norm
    mu = np.array([mx, my])
    rho_local = (b + n_raw @ mu) / norm
    # 转到全局图像坐标
    rho = rho_local + float(n_unit @ np.array([x0, y0]))

    # 方向: n 由黑侧指向白侧
    gvals = sub.ravel()
    dist_local = (n_unit @ np.vstack([xs, ys])) - rho_local
    side_plus = gvals[dist_local > 0].mean()
    side_minus = gvals[dist_local < 0].mean()
    if side_plus < side_minus:
        n_unit = -n_unit
        rho = -rho

    angle = float(np.degrees(np.arccos(np.clip(
        max(abs(n_unit[0]), abs(n_unit[1])), 0, 1))))
    outlier_frac = 1.0 - float(keep.sum()) / float(ok.sum())

    return EdgeFit(
        nx=float(n_unit[0]), ny=float(n_unit[1]), rho=float(rho),
        angle_deg=angle, residual_rms_px=rms,
        bins_used=int(keep.sum()), bins_total=int(ok.sum()),
        outlier_fraction=outlier_frac,
    )


# --------------------------------------------------------------------------
# ESF / LSF / MTF
# --------------------------------------------------------------------------

def default_half_width(roi: tuple[int, int, int, int],
                       edge: EdgeFit) -> float:
    """ROI 内可用于测量的最大法向半宽(原图像素)。

    对宽矩形 ROI, 沿法向能覆盖的距离远大于短边的一半;
    取四角到直边距离的最小值, 留 0.5px 余量保证两侧都有平台。
    """
    x0, y0, w, h = roi
    corners = np.array([
        [x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]
    ], dtype=float)
    d = corners @ edge.normal - edge.rho
    reach = min(abs(d.min()), abs(d.max()))
    return max(2.0, float(reach) - 0.5)


def _bin_esf(dist: np.ndarray, values: np.ndarray, half_width: float
             ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float]:
    edges = np.arange(-half_width, half_width + BIN_WIDTH, BIN_WIDTH)
    idx = np.clip(np.digitize(dist, edges) - 1, 0, len(edges) - 2)
    n = len(edges) - 1
    cnt = np.zeros(n)
    sm = np.zeros(n)
    sq = np.zeros(n)
    np.add.at(cnt, idx, 1.0)
    np.add.at(sm, idx, values)
    np.add.at(sq, idx, values**2)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = sm / cnt
        std = np.sqrt(np.maximum(sq / cnt - mean**2, 0))
    centers = 0.5 * (edges[:-1] + edges[1:])
    # 空箱线性插值, 并统计覆盖率
    finite = np.isfinite(mean)
    coverage = float(finite.sum()) / n
    if finite.sum() >= 2:
        mean = np.interp(centers, centers[finite], mean[finite])
        std = np.where(np.isfinite(std), std, 0.0)
    return centers, mean, std, cnt, coverage


def _mtf_from_esf(esf_dist: np.ndarray, esf_mean: np.ndarray
                  ) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """ESF -> Savitzky-Golay 平滑 -> 微分 LSF -> Hann 加窗 FFT -> 归一化 MTF。"""
    m = len(esf_mean)
    win = 5 if m >= 7 else (3 if m >= 3 else m)
    if win % 2 == 0:
        win -= 1
    smoothed = signal.savgol_filter(esf_mean, win, polyorder=2, mode="interp")
    lsf = np.gradient(smoothed, BIN_WIDTH)

    # 以 LSF 主峰为中心对齐, 保证加窗对称、相位近似为零
    peak_i = int(np.argmax(np.abs(lsf)))
    center_i = m // 2
    lsf_c = np.roll(lsf, center_i - peak_i)
    lsf_d = np.roll(esf_dist, center_i - peak_i)
    window = signal.windows.hann(m)
    nfft = max(256, int(2 ** np.ceil(np.log2(4 * m))))
    spec = np.fft.rfft(lsf_c * window, n=nfft)
    mtf = np.abs(spec)
    mtf = mtf / mtf[0]
    freq = np.fft.rfftfreq(nfft, d=BIN_WIDTH)
    return freq, mtf, lsf_d, lsf


def _mtf50(freq: np.ndarray, mtf: np.ndarray) -> float | None:
    """首个从上方穿过 0.5 的频率, 线性插值; 到 Nyquist 仍未降到一半则 None。"""
    sel = freq <= 0.5
    f, m = freq[sel], mtf[sel]
    for i in range(len(m) - 1):
        if m[i] >= 0.5 >= m[i + 1] and f[i + 1] > f[i]:
            return float(f[i] + (0.5 - m[i]) * (f[i + 1] - f[i])
                         / (m[i + 1] - m[i]))
    return None


def measure(gray: np.ndarray, roi: tuple[int, int, int, int],
            edge: EdgeFit, fit_half_width: float | None = None,
            inverted: bool = False) -> AnalysisResult:
    """依据已拟合直边做 ESF/LSF/MTF 测量。改拟合范围只需重跑本函数。"""
    x0, y0, w, h = roi
    sub = gray[y0:y0 + h, x0:x0 + w].astype(np.float64)
    rows, cols = np.mgrid[0:h, 0:w]
    gx = cols.ravel() + 0.5 + x0
    gy = rows.ravel() + 0.5 + y0
    dist = edge.nx * gx + edge.ny * gy - edge.rho
    values = sub.ravel().copy()
    if inverted:
        values = -values

    if fit_half_width is None:
        fit_half_width = default_half_width(roi, edge)
    fit_half_width = float(np.clip(
        fit_half_width, 1.5, default_half_width(roi, edge)))
    used = np.abs(dist) <= fit_half_width
    if used.sum() < 16:
        raise ValueError("拟合范围内样本太少")

    d_in, v_in = dist[used], values[used]
    esf_d, esf_m, esf_s, esf_c, coverage = _bin_esf(d_in, v_in, fit_half_width)
    freq, mtf, lsf_d, lsf = _mtf_from_esf(esf_d, esf_m)

    # 平台电平 / 对比 / 噪声
    outer = 0.5 * fit_half_width
    # 平台电平取最外侧 30% 距离带的中位数, 避开振铃过冲区
    far = 0.7 * fit_half_width
    dark = float(np.median(esf_m[esf_d <= -far]))
    light = float(np.median(esf_m[esf_d >= far]))
    contrast = light - dark
    plateau = (esf_d <= -outer) | (esf_d >= outer)
    noise = float(np.median(esf_s[plateau][esf_c[plateau] > 1])) \
        if np.any(plateau) else float(np.median(esf_s))

    # 振铃度量: 只看主峰附近 ±3bin 之外、且在数组内缩 3 个边界 bin
    # 的区域, 排除 Savitzky-Golay 边界伪影
    peak = float(np.max(lsf))
    peak_i = int(np.argmax(np.abs(lsf)))
    m = len(lsf)
    inner = np.ones(m, dtype=bool)
    inner[:3] = inner[-3:] = False
    # 主峰本体(±2 bin)不算负瓣
    inner[max(0, peak_i - 2):peak_i + 3] = False
    if inner.any():
        neg = -float(np.min(lsf[inner]))
    else:
        neg = 0.0
    ringing = max(0.0, neg / max(peak, 1e-12) * 100.0)
    if abs(contrast) > 1e-9:
        # 过冲: 平台带之外的 ESF 极值相对平台电平
        trans = np.abs(esf_d) < 0.6 * fit_half_width
        overshoot = max(0.0,
                        (float(esf_m[trans].max()) - light) / contrast,
                        (dark - float(esf_m[trans].min())) / contrast) * 100.0
    else:
        overshoot = 0.0

    mtf50 = _mtf50(freq, mtf)
    mtf_ny = float(np.interp(0.5, freq, mtf))

    flags: list[Flag] = []
    full_scale = 1.0
    # 1) 对比太小
    if abs(contrast) < max(0.03 * full_scale, 4.0 * noise):
        flags.append(Flag("low_contrast", "error",
                          f"黑白对比过小(对比={abs(contrast):.4f}, "
                          f"噪声≈{noise:.4f}), 读数不可靠"))
    elif abs(contrast) < max(0.06 * full_scale, 8.0 * noise):
        flags.append(Flag("low_contrast", "warn",
                          f"对比偏低(对比={abs(contrast):.4f}, "
                          f"噪声≈{noise:.4f}), 建议加大选区或换更实的边"))
    # 2) 边缘贴近选区边界 / 一侧缺少平台
    frac_plus = float(np.mean(dist > outer))
    frac_minus = float(np.mean(dist < -outer))
    if min(frac_plus, frac_minus) < 0.05:
        flags.append(Flag("edge_near_border", "error",
                          "直边紧贴选区边界, 一侧缺少过渡平台, "
                          "请把选区向该侧扩大"))
    elif min(frac_plus, frac_minus) < 0.12:
        flags.append(Flag("edge_near_border", "warn",
                          "直边离选区边界较近, 平台样本偏少, 可信度下降"))
    # 3) 拟合残差 / 离群(可能两条轮廓混在一起)
    if edge.residual_rms_px > 1.5:
        flags.append(Flag("edge_not_straight", "error",
                          f"边缘拟合残差 {edge.residual_rms_px:.2f} px, "
                          "不像单一直边(可能两条轮廓交叠)"))
    elif edge.residual_rms_px > 0.7:
        flags.append(Flag("edge_not_straight", "warn",
                          f"边缘拟合残差 {edge.residual_rms_px:.2f} px 偏大, "
                          "直线假设可能不成立"))
    if edge.outlier_fraction > 0.3:
        flags.append(Flag("mixed_edges", "warn",
                          f"有 {edge.outlier_fraction * 100:.0f}% 边缘分箱被离群剔除, "
                          "可能混入了第二条边或轮廓"))
    # LSF 次级峰: 两条边混叠的直接证据
    if peak > 0:
        peaks, _ = signal.find_peaks(lsf, height=0.22 * peak,
                                     distance=max(2, int(2.0 / BIN_WIDTH)))
        peaks = peaks[np.abs(peaks - int(np.argmax(lsf))) >
                      int(1.5 / BIN_WIDTH)]
        if len(peaks):
            flags.append(Flag("mixed_edges", "warn",
                              "LSF 出现明显次级峰, 疑似两条轮廓混在一起, "
                              "MTF50 会偏乐观"))
    # 4) 边缘与像素轴夹角过小 -> 超采样相位不足
    if edge.angle_deg < 2.0:
        flags.append(Flag("angle_too_small", "error",
                          f"边缘与像素轴夹角仅 {edge.angle_deg:.1f}°, "
                          "超采样相位不足, 请让边再斜一些"))
    elif edge.angle_deg < 4.0:
        flags.append(Flag("angle_too_small", "warn",
                          f"边缘与像素轴夹角 {edge.angle_deg:.1f}° 偏小, "
                          "建议 ≥5° 以保证超采样质量"))
    # 5) 空箱 / 样本量
    if coverage < 0.7:
        flags.append(Flag("sparse_samples", "warn",
                          f"过渡曲线有 {(1 - coverage) * 100:.0f}% 的空箱, "
                          "样本覆盖不足"))
    if used.sum() < 64:
        flags.append(Flag("sparse_samples", "warn",
                          f"进入测量的像素仅 {used.sum()} 个, 建议选大一点"))
    # 6) 过锐振铃: 真实振铃同时表现为 LSF 负瓣与 ESF 过冲。
    #    柔边 LSF 峰值低, 噪声的随机负瓣占比天然偏大, 因此负瓣门槛按
    #    噪声/对比自适应; 单纯噪声不会产生 ESF 过冲, 用过冲作硬判据。
    noise_ratio = float(np.clip(noise / max(abs(contrast), 1e-9), 0.0, 0.2))
    lobe_warn = 8.0 + 60.0 * noise_ratio      # 噪声越大, 负瓣门槛越高
    if ringing >= lobe_warn and overshoot >= 4.0:
        flags.append(Flag("ringing", "warn",
                          f"检测到过锐振铃: LSF 负瓣 {ringing:.1f}%, "
                          f"ESF 过冲 {overshoot:.1f}%; MTF50 可能被锐化抬高, "
                          "不代表真实细节保留"))
    elif overshoot >= 3.0:
        # 噪声微分只会产生随机 LSF 负瓣, 不会产生 ESF 过冲;
        # 故 info 级也以过冲为必要条件
        flags.append(Flag("ringing", "info",
                          f"轻微振铃: LSF 负瓣 {ringing:.1f}%, "
                          f"ESF 过冲 {overshoot:.1f}%"))
    # 7) MTF50 超出 Nyquist
    if mtf50 is None:
        flags.append(Flag("mtf50_unresolved", "warn",
                          "在 0.5 周期/像素(Nyquist)内 MTF 未降到一半, "
                          "MTF50 超出可测范围(边缘极锐或有强锐化)"))

    return AnalysisResult(
        roi=tuple(map(int, roi)), edge=edge,
        fit_half_width=float(fit_half_width), inverted=bool(inverted),
        sample_dist=dist, sample_value=values, sample_used=used,
        esf_dist=esf_d, esf_mean=esf_m, esf_std=esf_s, esf_count=esf_c,
        lsf_dist=lsf_d, lsf=lsf, mtf_freq=freq, mtf=mtf,
        dark_level=dark, light_level=light, contrast=contrast,
        noise_est=noise, mtf50=mtf50, mtf_nyquist=mtf_ny,
        ringing_pct=ringing, overshoot_pct=overshoot, flags=flags,
    )


def analyze(gray: np.ndarray, roi: tuple[int, int, int, int],
            fit_half_width: float | None = None,
            inverted: bool = False) -> AnalysisResult:
    """一步完成拟合 + 测量(界面里通常拆成 fit_edge / measure 以便复用)。"""
    edge = fit_edge(gray, roi)
    return measure(gray, roi, edge, fit_half_width, inverted)
