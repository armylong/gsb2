"""核心信号处理。

物理模型
--------
旧录音机的带速漂移等价于一个时变重采样。设真实时间为 t, 磁带上录到的
位置(录音机自己看到的时间)为 τ, 文件采样按 τ 均匀排列:

    dt/dτ = 1 + e(τ)          # e: 相对带速偏差, 慢漂+快抖动
    参考音瞬时频率 f(τ) = f_nom * (1 + e(τ))

所以从参考音测出的相对频率偏差就是 e。校正即按映射把文件时间 τ 重采样
回真实时间 t, 让内容轨的音高与事件间距恢复。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.signal import butter, filtfilt, hilbert, find_peaks


# ---------------------------------------------------------------------------
# 参考音分析
# ---------------------------------------------------------------------------
@dataclass
class ReferenceAnalysis:
    """一帧一帧的参考音分析结果, 所有数组等长(帧数 N)。"""

    frame_time: np.ndarray          # 各帧中心在文件时间轴上的位置 (s)
    freq: np.ndarray                # 瞬时频率 (Hz), 无效帧为 nan
    deviation: np.ndarray           # 相对偏差 (f - f_nom) / f_nom
    level_db: np.ndarray            # 窄带电平 (dBFS)
    broadband_db: np.ndarray        # 宽带电平 (dBFS)
    purity: np.ndarray             # 窄带功率占比 0..1
    valid: np.ndarray               # True=可信, False=弱/噪声
    weak: np.ndarray                # True=有东西但太弱/太脏, False=纯噪声
    f_nom: float
    sr: int
    hop: int
    frame_len: int

    @property
    def cents(self) -> np.ndarray:
        """以音分表示的偏差(100 音分 = 一个半音)。"""
        with np.errstate(invalid="ignore"):
            return 1200.0 * np.log2(1.0 + self.deviation)


def _zero_phase_filter(x: np.ndarray, cutoff, sr: int,
                       btype: str, order: int = 4) -> np.ndarray:
    """零相位 Butterworth 滤波, 对实部虚部分别处理(filtfilt 不支持复数)。

    cutoff 为标量(高/低通)或 [lo, hi](带通)。避免用归一化频率趋近 0 的
    极窄带通 —— 高阶滤波器在该尺度下系数会数值失稳。
    """
    nyq = sr / 2.0
    if isinstance(cutoff, (list, tuple, np.ndarray)):
        wn = [max(cutoff[0] / nyq, 1e-3), min(cutoff[1] / nyq, 1.0 - 1e-3)]
    else:
        wn = min(max(cutoff / nyq, 1e-3), 1.0 - 1e-3)
    b, a = butter(order, wn, btype=btype)
    if np.iscomplexobj(x):
        return filtfilt(b, a, x.real).astype(np.float64) + \
            1j * filtfilt(b, a, x.imag).astype(np.float64)
    return filtfilt(b, a, x)


def analyze_reference(ref: np.ndarray, sr: int, f_nom: float,
                      frame_ms: float = 80.0, hop_ms: float = 20.0,
                      level_db_thresh: float = -55.0,
                      snr_db_thresh: float = -12.0,
                      purity_thresh: float = 0.25) -> ReferenceAnalysis:
    """分析参考轨, 输出逐帧频率偏差轨迹与可信度标记。

    思路: 以 f_nom 做外差搬移到基带, 窄带低通后得到解析基带信号 z(n)。
    其瞬时频率 f = f_nom + (1/2π) d(angle z)/dt; 窄带幅度给出参考音电平,
    与宽带电平对比得到纯度, 从而区分 可信 / 太弱 / 变成噪声 三种帧。
    """
    ref = np.asarray(ref, dtype=np.float64)
    n = ref.size
    if n < sr // 4:
        raise ValueError("参考轨太短(不足 0.25 s), 无法分析")
    if not (20.0 <= f_nom <= sr / 2.0 - 20.0):
        raise ValueError(f"标称频率 {f_nom} 超出可分析范围")

    frame_len = max(16, int(round(sr * frame_ms / 1000.0)))
    hop = max(8, int(round(sr * hop_ms / 1000.0)))

    # 先在真实域高通掉直流/低频干扰, 再外差到基带做温和低通。
    # 不用极窄带通: 高阶滤波器在归一化频率趋近 0 时系数会数值失稳。
    ref_hp = _zero_phase_filter(ref, max(20.0, 0.25 * f_nom), sr, "high",
                                order=3)
    n_idx = np.arange(n)
    mixed = ref_hp * np.exp(-1j * 2.0 * np.pi * f_nom * n_idx / sr)
    z = _zero_phase_filter(mixed, 0.12 * f_nom, sr, "low", order=3)

    inst_phase = np.unwrap(np.angle(z))
    # 每点瞬时频率(基带频偏 + 标称), 用瞬时斜率避免帧级相位缠绕
    inst_f = f_nom + np.gradient(inst_phase, 1.0 / sr) / (2.0 * np.pi)

    narrow_rms = np.abs(z)
    broad_rms = np.abs(ref_hp) + 1e-12

    eps = 1e-12
    frames = list(range(0, max(1, n - frame_len + 1), hop))
    nf = len(frames)
    ft = np.empty(nf)
    freq = np.full(nf, np.nan)
    dev = np.full(nf, np.nan)
    lvl = np.empty(nf)
    blvl = np.empty(nf)
    pur = np.empty(nf)
    valid = np.zeros(nf, dtype=bool)
    weak = np.zeros(nf, dtype=bool)

    win = np.hanning(frame_len)
    win_sum = win.sum()

    for i, start in enumerate(frames):
        sl = slice(start, start + frame_len)
        w = win
        ft[i] = (start + frame_len / 2.0) / sr

        nb = float(np.sqrt(np.sum((w * narrow_rms[sl]) ** 2) / win_sum))
        bb = float(np.sqrt(np.sum((w * broad_rms[sl]) ** 2) / win_sum))
        lvl[i] = 20.0 * np.log10(nb + eps)
        blvl[i] = 20.0 * np.log10(bb + eps)
        # 窄带功率 / 宽带功率: 纯音接近 1, 宽带噪声远小于 1
        pur[i] = float(np.clip((nb / (bb + eps)) ** 2, 0.0, 1.0))

        enough_level = lvl[i] >= level_db_thresh
        enough_snr = (lvl[i] - blvl[i]) >= snr_db_thresh
        enough_purity = pur[i] >= purity_thresh

        if enough_level and enough_snr and enough_purity:
            # 帧内对瞬时频率做幅度加权均值, 离群帧由可信度门限挡住
            weights = w * narrow_rms[sl] + eps
            f_hat = float(np.sum(inst_f[sl] * weights) / weights.sum())
            # 物理上偏差不可能太离谱, 超出视为跟踪失败
            if abs(f_hat - f_nom) / f_nom < 0.25:
                freq[i] = f_hat
                dev[i] = (f_hat - f_nom) / f_nom
                valid[i] = True
                continue
            weak[i] = True   # 有音但频率跟踪不可信, 归入弱/脏
        elif enough_level:
            weak[i] = True    # 电平够但被噪声淹没
        # 电平过低: 既不 valid 也不 weak —— 纯噪声/丢失

    return ReferenceAnalysis(
        frame_time=ft, freq=freq, deviation=dev,
        level_db=lvl, broadband_db=blvl, purity=pur,
        valid=valid, weak=weak, f_nom=f_nom, sr=sr,
        hop=hop, frame_len=frame_len,
    )


# ---------------------------------------------------------------------------
# 无效区间(掉参考)检测
# ---------------------------------------------------------------------------
@dataclass
class Gap:
    start: float          # 文件时间 (s)
    end: float
    kind: str             # "short"(可平滑跨过) / "long"(必须保留)
    reason: str = ""

    @property
    def duration(self) -> float:
        return self.end - self.start


def find_gaps(an: ReferenceAnalysis, max_bridge_s: float = 0.5) -> list[Gap]:
    """把无效帧聚成连续区间, 按长度分成可桥接/过长两类。"""
    gaps: list[Gap] = []
    bad = ~an.valid
    if not bad.any():
        return gaps

    # 区间边界直接取无效帧的帧时刻(逐帧对齐, 与重采样掩码保持一致)
    edges = np.diff(bad.astype(np.int8))
    starts = list(np.where(edges == 1)[0] + 1)
    ends = list(np.where(edges == -1)[0] + 1)
    if bad[0]:
        starts = [0] + starts
    if bad[-1]:
        ends = ends + [len(bad)]

    for s, e in zip(starts, ends):
        t0 = float(an.frame_time[s])
        t1 = float(an.frame_time[e - 1])
        weak_in = bool(an.weak[s:e].any())
        kind = "short" if (t1 - t0) <= max_bridge_s else "long"
        if kind == "short":
            reason = "参考短暂丢失, 可平滑跨过" + ("(含弱/脏帧)" if weak_in else "")
        else:
            reason = "参考缺失过长, 不插值、保留原样" + ("(含弱/脏帧)" if weak_in else "")
        gaps.append(Gap(t0, t1, kind, reason))
    return gaps


# ---------------------------------------------------------------------------
# 校正曲线构建: 慢漂/快抖动分别控制, 分段处理避免"凭空曲线"
# ---------------------------------------------------------------------------
def _piecewise_lowpass(x: np.ndarray, t: np.ndarray, cutoff_s: float,
                       sr: int) -> np.ndarray:
    """对含 nan 的曲线按有效段分别零相位低通, nan 位置保持 nan。

    段与段之间互不影响 —— 长缺口两侧绝不互相"猜测"。
    """
    out = np.full_like(x, np.nan, dtype=np.float64)
    valid = ~np.isnan(x)
    if not valid.any():
        return out
    edges = np.diff(valid.astype(np.int8))
    starts = [0] if valid[0] else []
    starts += list(np.where(edges == 1)[0] + 1)
    ends = list(np.where(edges == -1)[0] + 1)
    if valid[-1]:
        ends.append(len(valid))

    # 截止频率 1/(2π τ) 的一阶低通, 用零相位双向滤波近似
    tau = max(cutoff_s, 1.0 / sr)
    alpha = 1.0 / (1.0 + tau * sr)
    b = [alpha]
    a = [1.0, -(1.0 - alpha)]
    min_len = 32
    for s, e in zip(starts, ends):
        seg = x[s:e]
        if seg.size >= min_len:
            # filtfilt 对一阶/短序列可能不稳, 用足够长的段才启用
            try:
                out[s:e] = filtfilt(b, a, seg, method="gust")
            except (ValueError, np.linalg.LinAlgError):
                out[s:e] = seg
        else:
            out[s:e] = seg
    return out


def build_correction(an: ReferenceAnalysis, gaps: list[Gap],
                     slow_tau_s: float, fast_tau_s: float,
                     fast_amount: float,
                     bridge_short: bool = True,
                     edge_mode: str = "zero") -> dict:
    """构建逐帧校正曲线。

    slow_tau_s: 慢漂平滑时间常数; 越大越只跟很慢的漂移。
    fast_tau_s: 快抖动平滑时间常数(通常远小于 slow)。
    fast_amount: 0..1, 快抖动跟随程度; 0=只修慢漂, 1=慢漂+全部快抖动。
    bridge_short: 短缺口是否平滑跨过; False 时短缺口也保持 nan(不校正)。
    edge_mode: 头/尾无参考时的处理 —— "zero"=不校正(推荐), "hold"=保持末值。

    返回 dict: frame_time, dev_slow, dev_fast, dev_total, valid_curve(bool)。
    """
    dev = an.deviation.copy()
    t = an.frame_time

    # 1) 短缺口: 仅在允许时做线性插值跨过; 长缺口始终是 nan
    if bridge_short:
        for g in gaps:
            if g.kind != "short":
                continue
            m = (t >= g.start) & (t <= g.end)
            idx = np.where(m)[0]
            lo, hi = idx[0] - 1, idx[-1] + 1
            if lo >= 0 and hi < len(t) and not np.isnan(dev[lo]) \
                    and not np.isnan(dev[hi]):
                dev[idx] = np.linspace(dev[lo], dev[hi], idx.size + 2)[1:-1]

    # 2) 分段低通: 慢分量与快分量。nan 段各自隔离
    slow = _piecewise_lowpass(dev, t, slow_tau_s, an.sr)
    smoothed_all = _piecewise_lowpass(dev, t, fast_tau_s, an.sr)
    fast = dev - smoothed_all
    fast[np.isnan(slow)] = np.nan

    total = slow + fast_amount * fast

    # 3) 头尾无参考(曲线为 nan 的边缘段)
    valid_curve = ~np.isnan(total)
    if edge_mode == "hold" and valid_curve.any():
        first = int(np.argmax(valid_curve))
        last = len(valid_curve) - 1 - int(np.argmax(valid_curve[::-1]))
        total[:first] = total[first]
        total[last + 1:] = total[last]
        slow[:first] = slow[first]
        slow[last + 1:] = slow[last]
        # 边缘帧也纳入校正, 重采样才会使用保持下来的速率
        valid_curve = np.ones_like(valid_curve)
    # edge_mode == "zero": nan 保持, 重采样时按 0(不校正)处理

    return {
        "frame_time": t,
        "dev_slow": slow,
        "dev_fast": fast,
        "dev_total": total,
        "valid_curve": valid_curve,
    }


# ---------------------------------------------------------------------------
# 重采样校正: 严格单调向前的时间映射
# ---------------------------------------------------------------------------
def uncorrected_intervals(an: ReferenceAnalysis, gaps: list[Gap],
                          bridge_short: bool, edge_mode: str,
                          duration_s: float) -> list[tuple[float, float]]:
    """汇总所有必须原样保留(速率=1)的时间区间。"""
    out: list[tuple[float, float]] = []
    head_end = 0.0     # 贴着起点的缺口(头无参考)的末端
    tail_start = duration_s
    for g in gaps:
        touches_head = g.start <= an.frame_time[0] + 1e-9
        touches_tail = g.end >= an.frame_time[-1] - 1e-9
        if touches_head:
            head_end = max(head_end, g.end)
        if touches_tail:
            tail_start = min(tail_start, g.start)
        if g.kind == "long" or not bridge_short:
            out.append((g.start, g.end))

    # 帧覆盖范围之外的头尾 + 贴着边界的缺口, 按边缘模式处理。
    # 仅当首/尾帧本身无效(真的没有参考)时才生成边缘区间。
    if edge_mode == "zero":
        if np.isnan(an.deviation[0]):
            head_end = max(head_end, float(an.frame_time[0]))
            if head_end > 0.0:
                out.append((0.0, head_end))
        if np.isnan(an.deviation[-1]):
            tail_start = min(tail_start, float(an.frame_time[-1]))
            if tail_start < duration_s:
                out.append((tail_start, duration_s))
    return out


def resample_correct(content: np.ndarray, sr: int,
                     frame_time: np.ndarray, dev_total: np.ndarray,
                     valid_curve: np.ndarray,
                     uncorrected_intervals: list | None = None) -> dict:
    """按校正曲线对内容轨做时变重采样。

    输出时长与输入相同(同一时间基准 τ)。映射 t_out(τ) 由
    累积 ∫(1+e)dτ 得到, 再反解每个输出样本对应的输入分数位置做线性插值。
    uncorrected_intervals 内的样本速率恒为 1(不校正), 用于长缺口、未桥接
    的短缺口与 zero 模式的头尾; 相邻样本速率变化率做限幅, 数学上保证
    t_out 严格递增 —— 时间顺序永远向前。

    返回 dict: out(校正后波形), map_in_to_out(每输入样本的输出时间),
    speed(每样本使用的 1+e), corrected_mask(bool, 该样本是否被校正)。
    """
    content = np.asarray(content, dtype=np.float64)
    n = content.size
    tt = np.arange(n) / sr

    # 帧曲线 -> 每样本。帧索引映射(不做帧间数值插值, 避免 nan 被吃掉);
    # 帧覆盖范围之外的头尾按 0 / 未校正处理。
    frame_idx = np.searchsorted(frame_time, tt) - 1
    frame_idx = np.clip(frame_idx, 0, frame_time.size - 1)
    in_frame_range = (tt >= frame_time[0]) & (tt <= frame_time[-1])
    valid_samples = in_frame_range & valid_curve[frame_idx]

    # 显式未校正区间(缺口/边缘)优先于帧掩码, 边界按时间精确切分
    for t0, t1 in (uncorrected_intervals or []):
        valid_samples[(tt >= t0) & (tt <= t1)] = False

    speed = np.ones(n, dtype=np.float64)
    speed[valid_samples] = 1.0 + dev_total[frame_idx[valid_samples]]

    # 限幅: 只在两侧都在校正区、且速率确实在变化的相邻样本之间限制(0.5%)。
    # 未校正区间内部恒速 1; hold 模式的边缘保持区速率恒定 —— 都不做斜坡,
    # 保证缺口与保持区真的原样/恒速, 同时映射仍然严格递增。
    max_step = 0.005
    for k in range(1, n):
        if valid_samples[k] and valid_samples[k - 1] \
                and speed[k] != speed[k - 1]:
            d = speed[k] - speed[k - 1]
            if d > max_step:
                speed[k] = speed[k - 1] + max_step
            elif d < -max_step:
                speed[k] = speed[k - 1] - max_step
    speed = np.clip(speed, 0.5, 2.0)

    # 输入样本 k 对应的(校正后)真实时间位置
    map_in_to_out = np.concatenate(([0.0], np.cumsum(speed[:-1]) / sr))

    # 反解: 输出样本 j 在输入轴上的分数位置 src[j]
    # 先兜底任何非有限值(正常路径不会出现), 再插值, 避免 nan 转整数告警
    map_in_to_out = np.nan_to_num(map_in_to_out, nan=0.0,
                                  posinf=n / sr, neginf=0.0)
    out_time = tt
    src = np.interp(out_time, map_in_to_out, np.arange(n).astype(np.float64))
    src = np.clip(src, 0.0, n - 1.0001)
    i0 = np.floor(src).astype(np.int64)
    frac = src - i0
    out = (1.0 - frac) * content[i0] + frac * content[np.minimum(i0 + 1, n - 1)]

    corrected_mask = valid_samples.copy()
    return {
        "out": out.astype(np.float32),
        "map_in_to_out": map_in_to_out,
        "speed": speed,
        "corrected_mask": corrected_mask,
    }


# ---------------------------------------------------------------------------
# 打点(事件)检测: 用于对照校正前后事件间距
# ---------------------------------------------------------------------------
def detect_events(x: np.ndarray, sr: int,
                  rel_height: float = 0.25,
                  min_distance_s: float = 0.08) -> np.ndarray:
    """基于包络峰值检测打点/瞬态事件, 返回事件时刻(秒)。"""
    x = np.asarray(x, dtype=np.float64)
    env = np.abs(hilbert(x))
    # 轻度平滑去毛刺
    k = max(3, int(sr * 0.005))
    kernel = np.ones(k) / k
    env = np.convolve(env, kernel, mode="same")
    if env.max() <= 0:
        return np.array([])
    env_db = 20.0 * np.log10(env / env.max() + 1e-9)
    dist = max(1, int(min_distance_s * sr))
    peaks, _ = find_peaks(env_db, height=20.0 * np.log10(rel_height + 1e-9),
                          distance=dist)
    return peaks / sr


def map_event_times(event_in_s: np.ndarray,
                    map_in_to_out: np.ndarray, sr: int) -> np.ndarray:
    """把输入时间轴上的事件时刻, 经时间映射换算到校正后时间轴。"""
    idx = np.clip(np.round(np.asarray(event_in_s) * sr).astype(int),
                  0, map_in_to_out.size - 1)
    return map_in_to_out[idx]
