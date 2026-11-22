"""色彩科学核心:传递函数、色域转换、两种亮部映射曲线。

预览与导出共用本模块,PIPELINE_VERSION 标识同一版本,
导出时写入成片 metadata,回读校验时比对。
"""
import numpy as np

PIPELINE_VERSION = "1.0"

# ---------------- PQ (SMPTE ST 2084) ----------------
_M1 = 2610.0 / 16384.0
_M2 = 2523.0 / 4096.0 * 32.0
_C1 = 3424.0 / 4096.0
_C2 = 2413.0 / 4096.0 * 32.0
_C3 = 2392.0 / 4096.0 * 32.0
PQ_MAX_NITS = 10000.0


def pq_eotf(v):
    """PQ 电信号 [0,1] -> 亮度 nits [0,10000]"""
    v = np.clip(np.asarray(v, dtype=np.float64), 0.0, 1.0)
    p = v ** (1.0 / _M2)
    return PQ_MAX_NITS * (np.maximum(p - _C1, 0.0) / (_C2 - _C3 * p)) ** (1.0 / _M1)


def pq_oetf(l_nits):
    """亮度 nits -> PQ 电信号 [0,1]"""
    l = np.clip(np.asarray(l_nits, dtype=np.float64) / PQ_MAX_NITS, 0.0, 1.0)
    p = l ** _M1
    return ((_C1 + _C2 * p) / (1.0 + _C3 * p)) ** _M2


# ---------------- HLG (ARIB STD-B67, 近似: 固定系统 gamma 1.2, 峰值 1000nit) ----------------
_HLG_A = 0.17883277
_HLG_B = 1.0 - 4.0 * 0.17883277
_HLG_C = 0.5 - 0.17883277 * np.log(4.0 * 0.17883277)
HLG_GAMMA = 1.2
HLG_PEAK_NITS = 1000.0


def hlg_eotf(v):
    """HLG 电信号 -> 亮度 nits(近似,系统 gamma 1.2,峰值 1000nit)"""
    v = np.clip(np.asarray(v, dtype=np.float64), 0.0, 1.0)
    e = np.where(v <= 0.5, v * v / 3.0, (np.exp((v - _HLG_C) / _HLG_A) + _HLG_B) / 12.0)
    return HLG_PEAK_NITS * np.clip(e, 0.0, 1.0) ** HLG_GAMMA


# ---------------- BT.709 / BT.1886 (SDR) ----------------
def bt709_oetf(l):
    """线性光 [0,1] -> BT.709 电信号"""
    l = np.clip(np.asarray(l, dtype=np.float64), 0.0, 1.0)
    return np.where(l < 0.018, 4.5 * l, 1.099 * np.power(l, 0.45) - 0.099)


def bt709_oetf_inv(v):
    """BT.709 电信号 -> 线性光 [0,1]"""
    v = np.clip(np.asarray(v, dtype=np.float64), 0.0, 1.0)
    return np.where(v < 0.081, v / 4.5, np.power((v + 0.099) / 1.099, 1.0 / 0.45))


# ---------------- 色域 ----------------
# 线性光 BT.2020 -> BT.709 基色转换矩阵
M_2020_TO_709 = np.array([
    [1.660491002108435, -0.587641138788550, -0.072849862319785],
    [-0.124550474521591, 1.132899897126960, -0.008349422606369],
    [-0.018150763354905, -0.100578898008007, 1.118729661362913],
])
LUMA_2020 = np.array([0.2627, 0.6766, 0.0593])
LUMA_709 = np.array([0.2126, 0.7152, 0.0722])

# YCbCr 常量 (Kr, Kb)
YCBCR = {
    "bt2020": (0.2627, 0.0593),
    "bt709": (0.2126, 0.0722),
}

TRANSFERS = ["smpte2084", "hlg", "bt709"]


def signal_to_nits(rgb, transfer):
    """电信号 RGB [0,1] -> 线性光亮度 nits"""
    if transfer == "smpte2084":
        return pq_eotf(rgb)
    if transfer == "hlg":
        return hlg_eotf(rgb)
    # bt709 / 未标记按 SDR 100nit 处理
    return bt709_oetf_inv(rgb) * 100.0


# ---------------- 亮部映射曲线 ----------------
CURVES = {
    "A": "A 平滑肩部 (Reinhard 型, 渐近到峰值)",
    "B": "B Hermite 肩部 (BT.2390 风格, 源峰处到顶)",
}


def map_luminance(y_nits, target_peak, knee_frac, curve, src_peak):
    """亮度映射。输入/输出均为 nits(显示侧,峰值 = target_peak)。

    target_peak: 目标峰值亮度 (nit)
    knee_frac:   亮部压缩开始位置, 占目标峰值的比例 (0..1)
    curve:       "A" 或 "B"
    src_peak:    源内容峰值 (nit), 曲线 B 用它定 Hermite 终点
    """
    y = np.asarray(y_nits, dtype=np.float64) / target_peak
    k = float(knee_frac)
    if curve == "B":
        m = max(src_peak / target_peak, k + 1e-3)
        u = np.clip((y - k) / (m - k), 0.0, 1.0)
        s = u + u * u - u * u * u  # s(0)=0,s(1)=1,s'(0)=1,s'(1)=0
        out = np.where(y <= k, y, k + (1.0 - k) * s)
    else:  # "A": y' = k + (1-k)*(y-k)/(y-k+1-k), 连续导数, 渐近 1.0
        d = np.maximum(y - k + (1.0 - k), 1e-9)
        out = np.where(y <= k, y, k + (1.0 - k) * (y - k) / d)
    return out * target_peak


def tonemap_frame(rgb_nits, src_primaries, target_peak, knee_frac, curve, src_peak):
    """整帧映射。rgb_nits: HxWx3 线性光 nits(源基色)。返回 SDR 线性光 [0,1](BT.709 基色)。"""
    luma = LUMA_2020 if src_primaries == "bt2020" else LUMA_709
    y = rgb_nits @ luma
    ym = map_luminance(y, target_peak, knee_frac, curve, src_peak)
    ratio = ym / np.maximum(y, 1e-6)
    rgb = rgb_nits * ratio[..., None]
    if src_primaries == "bt2020":
        rgb = rgb @ M_2020_TO_709.T
    rgb = rgb / target_peak
    # 超色域处理: 越界像素向自身亮度方向去饱和, 直到落回 [0,1]
    y709 = rgb @ LUMA_709
    for _ in range(3):
        lo = rgb.min(axis=-1)
        hi = rgb.max(axis=-1)
        bad = (lo < 0.0) | (hi > 1.0)
        if not bad.any():
            break
        t_lo = np.where(lo < 0.0, y709 / np.maximum(y709 - lo, 1e-9), 1.0)
        t_hi = np.where(hi > 1.0, (1.0 - y709) / np.maximum(hi - y709, 1e-9), 1.0)
        t = np.where(bad, np.clip(np.minimum(t_lo, t_hi), 0.0, 1.0), 1.0)
        rgb = y709[..., None] + (rgb - y709[..., None]) * t[..., None]
    return np.clip(rgb, 0.0, 1.0)


def sdr_encode(rgb_lin):
    """SDR 线性光 [0,1] -> 8bit RGB"""
    return np.round(bt709_oetf(rgb_lin) * 255.0).astype(np.uint8)


def sdr_decode_nits(rgb8, sdr_peak=100.0):
    """8bit RGB -> 显示亮度 nits(假定 SDR 参考峰值 100nit)"""
    return bt709_oetf_inv(np.asarray(rgb8, dtype=np.float64) / 255.0) * sdr_peak


# ---------------- 亮部告警 ----------------
def _local_range(a, size=5):
    """5x5 邻域 (max-min), 纯 numpy 实现"""
    pad = size // 2
    p = np.pad(a, pad, mode="edge")
    mx = np.zeros_like(a)
    mn = np.full_like(a, 255)
    for dy in range(size):
        for dx in range(size):
            w = p[dy:dy + a.shape[0], dx:dx + a.shape[1]]
            mx = np.maximum(mx, w)
            mn = np.minimum(mn, w)
    return mx - mn


def highlight_classes(src_nits, sdr8_rgb, knee_nits):
    """返回 (classes, stats)。classes: 0 普通 / 1 亮部仍可细分(黄) / 2 挤到上限(红)"""
    y8 = np.round(sdr8_rgb @ (LUMA_709 * 1.0)).astype(np.uint8)  # 近似输出亮度码值
    highlight = src_nits > knee_nits
    clipped = y8 >= 254
    rng = _local_range(y8, 5)
    crushed = highlight & ~clipped & (rng < 2)
    separable = highlight & ~clipped & ~crushed
    cls = np.zeros(src_nits.shape, dtype=np.uint8)
    cls[separable] = 1
    cls[clipped | crushed] = 2
    total = src_nits.size
    stats = {
        "highlight_pct": 100.0 * highlight.sum() / total,
        "separable_pct": 100.0 * separable.sum() / total,
        "clipped_pct": 100.0 * (clipped | crushed).sum() / total,
    }
    return cls, stats
