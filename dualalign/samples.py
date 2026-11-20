"""生成带已知时间关系的参考素材与对照素材.

参考素材由若干互不重复的乐音/噪声/打击事件组成, 并包含一段严格重复的
节奏 (用来制造相似候选)。对照素材在参考素材基础上加入:

* 起点偏移 (待对齐录音比参考晚开始)
* 缓慢时间漂移 (速度随时间轻微变化, 末端累积明显)
* 中间缺失 (去掉一段参考内容)
* 重复节奏 (参考素材中已经包含)
* 静音与底噪

生成时同时写出 ``manifest.json`` 与 ``known_relation.txt``, 记录精确的
参考时间 <-> 待对齐时间关系、缺失区间与有效区间, 供自动验证核对。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal


@dataclass
class SampleSpec:
    name: str = "demo"
    ref_duration_s: float = 45.0
    ref_sample_rate: int = 48_000
    take_sample_rate: int = 44_100
    seed: int = 20_261_120
    start_ref_s: float = 1.37
    base_speed: float = 1.009
    drift_rate: float = 0.00022  # 每秒速度变化, 末端额外漂移约 1%
    missing_ref_s: tuple[float, float] = (23.0, 25.6)
    repeated_region_s: tuple[float, float] = (10.0, 17.0)
    silence_ref_s: tuple[tuple[float, float], ...] = ((21.0, 21.4), (39.5, 40.0))
    noise_snr_db: float = 28.0
    repeated_only: bool = False  # 仅用于低置信场景: 全片都是重复节奏


@dataclass
class Manifest:
    spec: dict
    mapping: list[dict]
    missing_ref_regions: list[list[float]]
    valid_ref_regions: list[list[float]]
    expected_start_offset_s: float
    expected_end_drift_s: float
    end_ref_s: float
    files: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# 参考素材合成
# ---------------------------------------------------------------------------


def _envelope(n: int, sr: int, attack: float, decay: float, sustain: float,
              release: float, rng: np.random.Generator) -> np.ndarray:
    env = np.ones(n, dtype=np.float64) * sustain
    na = max(1, int(attack * sr))
    nd = max(1, int(decay * sr))
    nr = max(1, int(release * sr))
    env[:na] = np.linspace(0.0, 1.0, na, endpoint=False)
    if na + nd < n:
        env[na:na + nd] = np.linspace(1.0, sustain, nd, endpoint=False)
    if nr < n:
        env[-nr:] *= np.linspace(1.0, 0.0, nr)
    # 轻微抖动, 避免完全机械
    env *= 1.0 + 0.02 * rng.standard_normal(n)
    return np.clip(env, 0.0, 1.0)


def synthesize_reference(spec: SampleSpec) -> tuple[np.ndarray, list[dict]]:
    sr = spec.ref_sample_rate
    duration = spec.ref_duration_s
    n = int(round(duration * sr))
    rng = np.random.default_rng(spec.seed)
    x = np.zeros(n, dtype=np.float64)

    # 低频底噪垫
    bed = rng.standard_normal(n)
    sos = signal.butter(4, [80 / (sr / 2), 6000 / (sr / 2)], btype="band", output="sos")
    bed = signal.sosfilt(sos, bed)
    x += 0.0010 * bed / (np.max(np.abs(bed)) + 1e-12)

    events: list[dict] = []

    def add_event(start_s: float, dur_s: float, kind: str, gain: float,
                  base_freq: float | None = None) -> None:
        i0 = int(round(start_s * sr))
        ln = int(round(dur_s * sr))
        if i0 < 0 or ln <= 0 or i0 + ln > n:
            return
        t = np.arange(ln) / sr
        env = _envelope(
            ln, sr,
            attack=float(rng.uniform(0.002, 0.04)),
            decay=float(rng.uniform(0.01, 0.25)),
            sustain=float(rng.uniform(0.2, 0.8)),
            release=float(rng.uniform(0.02, 0.15)),
            rng=rng,
        )
        if kind == "chirp":
            f0 = float(rng.uniform(180, 1400))
            f1 = float(rng.uniform(200, 1900))
            phase = 2 * np.pi * (f0 * t + (f1 - f0) / max(dur_s, 1e-6) * t ** 2)
            sig = np.sin(phase) + 0.35 * np.sin(1.997 * phase + 0.3) + 0.2 * np.sin(0.5 * phase)
        elif kind == "tone":
            f = float(base_freq if base_freq else rng.uniform(150, 2600))
            vib = 1.0 + 0.01 * np.sin(2 * np.pi * float(rng.uniform(4, 7)) * t)
            sig = (
                np.sin(2 * np.pi * f * t * vib)
                + 0.4 * np.sin(2 * np.pi * f * 2.01 * t)
                + 0.25 * np.sin(2 * np.pi * f * 3.03 * t)
            )
        elif kind == "noise":
            w = rng.standard_normal(ln)
            lo = float(rng.uniform(200, 3200))
            hi = float(np.clip(lo + rng.uniform(400, 4400), lo + 200, 7000))
            s2 = signal.butter(4, [lo / (sr / 2), hi / (sr / 2)], btype="band", output="sos")
            sig = signal.sosfilt(s2, w)
            sig /= np.max(np.abs(sig)) + 1e-12
        elif kind == "perc":
            f = float(base_freq if base_freq else rng.uniform(120, 900))
            sig = (
                np.sin(2 * np.pi * f * t)
                + 0.7 * rng.standard_normal(ln) * np.exp(-t / 0.010)
            ) * np.exp(-t / 0.05)
        else:  # chord
            base = float(base_freq if base_freq else rng.uniform(200, 500))
            sig = sum(
                np.sin(2 * np.pi * base * ratio * t + rng.uniform(0, 6.28))
                for ratio in (1.0, 1.25, 1.5, 2.0)
            ) / 4.0
        x[i0:i0 + ln] += gain * sig * env
        events.append({"start_s": round(start_s, 4), "duration_s": round(dur_s, 4), "kind": kind})

    def motif_at(start_s: float, gain: float = 0.11) -> None:
        """严格重复的 4 击节奏 (用于制造相似候选)。"""

        offsets = (0.0, 0.13, 0.29, 0.42)
        for off in offsets:
            ln = int(round(0.055 * sr))
            i0 = int(round((start_s + off) * sr))
            if i0 + ln > n:
                continue
            t = np.arange(ln) / sr
            sig = (np.sin(2 * np.pi * 880.0 * t) + 0.5 * np.sin(2 * np.pi * 1760.0 * t))
            sig *= np.exp(-t / 0.012)
            env = _envelope(ln, sr, 0.001, 0.010, 0.2, 0.010, rng)
            x[i0:i0 + ln] += gain * sig * env
            events.append({"start_s": round(start_s + off, 4), "duration_s": 0.055, "kind": "motif"})

    if spec.repeated_only:
        t = 0.4
        while t < duration - 0.8:
            motif_at(t)
            t += 0.5
    else:
        rep0, rep1 = spec.repeated_region_s
        t = rep0
        while t < rep1:
            motif_at(t)
            t += 0.5
        # 重复区间之外安排不规则、各不相同的声事件
        t = 0.5
        kind_cycle = ["chirp", "tone", "noise", "perc", "chord", "chirp", "tone", "noise"]
        idx = 0
        while t < duration - 1.0:
            if rep0 - 0.6 < t < rep1 + 0.6:
                t += 0.37
                continue
            kind = kind_cycle[idx % len(kind_cycle)]
            idx += 1
            dur = float(rng.uniform(0.08, 0.7))
            add_event(t, dur, kind, gain=float(rng.uniform(0.08, 0.17)))
            if rng.random() < 0.38:
                add_event(
                    t + float(rng.uniform(0.02, 0.15)),
                    float(rng.uniform(0.1, 0.5)),
                    ["tone", "chirp", "noise", "chord"][int(rng.integers(0, 4))],
                    gain=float(rng.uniform(0.05, 0.12)),
                )
            t += float(rng.uniform(0.18, 0.75))
    # 指定静音区间
    for (s0, s1) in spec.silence_ref_s:
        i0, i1 = int(round(s0 * sr)), int(round(s1 * sr))
        if 0 <= i0 < i1 <= n:
            x[i0:i1] *= 0.0005

    peak = float(np.max(np.abs(x))) + 1e-12
    x = 0.85 * x / peak
    # 两声道: 轻微时间差与声像差异, 保持内容相同
    delay = int(round(0.0007 * sr))
    left = x.copy()
    right = x.copy()
    if delay > 0:
        right[delay:] = 0.85 * right[delay:] + 0.15 * x[:-delay]
    stereo = np.stack([left, 0.98 * right], axis=1).astype(np.float32)
    return stereo, events


# ---------------------------------------------------------------------------
# 待对齐素材: 起点偏移 + 时间漂移 + 缺失
# ---------------------------------------------------------------------------


@dataclass
class WarpMap:
    """参考时间 -> 待对齐录音时间 的精确映射。"""

    ref_knots: np.ndarray
    take_knots: np.ndarray
    missing: list[tuple[float, float]]
    start_ref: float

    def take_time(self, ref_time: np.ndarray | float):
        r = np.asarray(ref_time, dtype=np.float64)
        t = np.interp(r, self.ref_knots, self.take_knots)
        return t if np.ndim(ref_time) else float(t)

    def ref_time(self, take_time: np.ndarray | float):
        t = np.asarray(take_time, dtype=np.float64)
        r = np.interp(t, self.take_knots, self.ref_knots)
        return r if np.ndim(take_time) else float(r)

    @property
    def take_duration(self) -> float:
        return float(self.take_knots[-1])


def build_warp(spec: SampleSpec) -> WarpMap:
    """速度随时间线性变化: speed(r) = base + drift * (r / duration)。

    参考结束处的速度比开头快 ``drift_rate * duration``, 例如 0.00022*45 ≈ 0.99%,
    叠加基础 0.9% 偏差, 末端累计误差约 0.8 秒。
    """

    sr = 1000.0
    duration = spec.ref_duration_s
    grid = np.arange(0.0, duration + 1e-9, 1.0 / sr)
    speed = spec.base_speed + spec.drift_rate * (grid / duration)
    # take_time(r) = ∫_start^r dr'/speed(r') - 已缺失内容的时长
    seg = 1.0 / speed
    cum = np.concatenate([[0.0], np.cumsum(0.5 * (seg[1:] + seg[:-1]) / sr)])
    # 参考 0 处的累计值
    i0 = int(round(spec.start_ref_s * sr))
    cum = cum - cum[i0]
    m0, m1 = spec.missing_ref_s
    # 允许素材较短时把缺失区间自动收进参考范围内; 完全无效则视为无缺失
    m0 = float(np.clip(m0, 0.0, duration))
    m1 = float(np.clip(m1, 0.0, duration))
    if m1 - m0 < 0.2:
        m0, m1 = 0.0, 0.0
    missing: list[tuple[float, float]] = []
    if m1 > m0:
        im0 = int(round(m0 * sr))
        im1 = int(round(m1 * sr))
        missing_take = cum[im1] - cum[im0]
        take = cum.copy()
        take[im1:] -= missing_take
        # 缺失区间内部: 前后接缝之间的 take 线性过渡 (生成时不会使用)
        take[im0:im1] = np.linspace(take[im0 - 1], take[im1], im1 - im0)
        missing_mask = (grid >= m0) & (grid < m1)
        missing = [(float(m0), float(m1))]
    else:
        take = cum.copy()
        missing_mask = np.zeros_like(grid, dtype=bool)
    take[:i0] = np.interp(
        grid[:i0], [grid[0], grid[i0]],
        [take[i0] - (grid[i0] - grid[0]) / spec.base_speed, take[i0]],
    )
    ref_knots = grid[~missing_mask]
    take_knots = take[~missing_mask]
    # 起点之前不存在对应声音: 用负的待对齐时间表示
    return WarpMap(ref_knots=ref_knots, take_knots=take_knots,
                   missing=missing, start_ref=spec.start_ref_s)


def make_take(reference: np.ndarray, ref_sr: int, spec: SampleSpec,
              warp: WarpMap) -> np.ndarray:
    """由参考素材按精确映射生成待对齐素材 (含重采样与噪声)。"""

    take_sr = spec.take_sample_rate
    dur = warp.take_duration
    n = max(1, int(round(dur * take_sr)))
    tau = np.arange(n, dtype=np.float64) / take_sr
    # 反查每个待对齐采样时刻对应的参考时间
    ref_t = np.interp(tau, warp.take_knots, warp.ref_knots)
    # 缺失接缝处 (tau 落在平台) 用最近有效值; 该段随后会被抹掉
    mono = reference.mean(axis=1).astype(np.float64)
    ref_index = np.clip(ref_t * ref_sr, 0, len(mono) - 1)
    from scipy.interpolate import CubicSpline

    left_sp = CubicSpline(np.arange(len(mono)), reference[:, 0].astype(np.float64), extrapolate=False)
    right_sp = CubicSpline(np.arange(len(mono)), reference[:, -1].astype(np.float64), extrapolate=False)
    left = left_sp(ref_index)
    right = right_sp(ref_index)
    left = np.where(np.isfinite(left), left, 0.0)
    right = np.where(np.isfinite(right), right, 0.0)
    # 待对齐录音的缺失: 把接缝附近非常短的一段 (对应缺失内容) 置静音,
    # 实际上 warp 已经跳过了缺失内容, 这里只防止接缝处出现一个采样毛刺。
    out = np.stack([left, right], axis=1)
    # 噪声
    rng = np.random.default_rng(spec.seed + 1)
    rms = float(np.sqrt(np.mean(out ** 2))) + 1e-12
    out += rng.standard_normal(out.shape) * rms * (10 ** (-spec.noise_snr_db / 20.0))
    peak = float(np.max(np.abs(out)))
    if peak > 0.98:
        out *= 0.98 / peak
    return out.astype(np.float32), n


def write_sample(spec: SampleSpec, out_dir: str | Path) -> Manifest:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    reference, events = synthesize_reference(spec)
    warp = build_warp(spec)
    take, take_frames = make_take(reference, spec.ref_sample_rate, spec, warp)

    ref_path = out / f"{spec.name}_reference.wav"
    take_path = out / f"{spec.name}_take.wav"
    sf.write(str(ref_path), reference, spec.ref_sample_rate, subtype="PCM_16")
    sf.write(str(take_path), take, spec.take_sample_rate, subtype="PCM_16")

    # 精确映射表 (每 0.5 s)
    ref_end = min(spec.ref_duration_s, float(warp.ref_knots[-1]))
    rows = []
    for r in np.arange(0.0, ref_end + 1e-9, 0.5):
        missing = any(m0 <= r < m1 for m0, m1 in warp.missing)
        if r < spec.start_ref_s:
            t = None
        else:
            t = float(warp.take_time(r)) if not missing else None
            if t is not None and (t < 0 or t > warp.take_duration):
                t = None
        rows.append({"ref_s": round(float(r), 3),
                     "take_s": None if t is None else round(t, 4),
                     "missing": missing})
    # 有效参考区间
    missing = list(warp.missing)
    valid: list[list[float]] = []
    cursor = spec.start_ref_s
    for m0, m1 in missing:
        if m0 > cursor:
            valid.append([round(cursor, 4), round(m0, 4)])
        cursor = max(cursor, m1)
    if cursor < spec.ref_duration_s:
        valid.append([round(cursor, 4), round(spec.ref_duration_s, 4)])
    end_drift = float(warp.take_time(spec.ref_duration_s)) - (spec.ref_duration_s - spec.start_ref_s) - (
        -sum(m1 - m0 for m0, m1 in missing)
    )
    manifest = Manifest(
        spec=asdict(spec),
        mapping=rows,
        missing_ref_regions=[[round(a, 4), round(b, 4)] for a, b in missing],
        valid_ref_regions=valid,
        expected_start_offset_s=round(spec.start_ref_s, 4),
        expected_end_drift_s=round(end_drift, 4),
        end_ref_s=round(spec.ref_duration_s, 4),
        files={
            "reference": ref_path.name,
            "take": take_path.name,
            "reference_sample_rate": spec.ref_sample_rate,
            "take_sample_rate": spec.take_sample_rate,
            "reference_duration_s": round(len(reference) / spec.ref_sample_rate, 4),
            "take_duration_s": round(take_frames / spec.take_sample_rate, 4),
            "reference_sha256": _sha256(ref_path),
            "take_sha256": _sha256(take_path),
        },
    )
    (out / f"{spec.name}_manifest.json").write_text(
        json.dumps(manifest.as_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out / f"{spec.name}_known_relation.txt").write_text(
        _known_relation_text(spec, manifest), encoding="utf-8"
    )
    return manifest


def _sha256(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _known_relation_text(spec: SampleSpec, m: Manifest) -> str:
    lines = [
        f"素材: {spec.name}",
        f"参考: {m.files['reference']}  {m.files['reference_duration_s']:.3f}s @ {m.files['reference_sample_rate']}Hz",
        f"待对齐: {m.files['take']}  {m.files['take_duration_s']:.3f}s @ {m.files['take_sample_rate']}Hz",
        "",
        "已知时间关系 (待对齐时间 = f(参考时间)):",
        "  起点偏移: 待对齐录音从参考 %.3f s 处开始" % spec.start_ref_s,
        "  速度: 基础 %.4f, 每秒额外变化 %.6f (末端累计漂移 %.3f s)"
        % (spec.base_speed, spec.drift_rate, m.expected_end_drift_s),
        "  缺失 (参考时间): " + ", ".join(f"{a:.3f}-{b:.3f}s" for a, b in m.missing_ref_regions),
        "",
        "参考 -> 待对齐 对应表 (缺失处为 --):",
    ]
    for row in m.mapping:
        t = "--" if row["take_s"] is None else f"{row['take_s']:.3f}"
        lines.append(f"  {row['ref_s']:8.3f} -> {t}")
    lines.append("")
    lines.append("说明: 该素材用于自动验证, 不依赖任何外部录音。")
    return "\n".join(lines) + "\n"


def generate_all(out_dir: str | Path) -> dict[str, Manifest]:
    """默认生成两个场景: 完整场景与低置信 (重复节奏) 场景。"""

    out = Path(out_dir)
    base = SampleSpec(name="demo")
    repeat = SampleSpec(
        name="repeat_heavy",
        ref_duration_s=24.0,
        start_ref_s=0.8,
        base_speed=1.004,
        drift_rate=0.0001,
        repeated_region_s=(3.0, 21.0),
        missing_ref_s=(12.0, 12.8),
        silence_ref_s=(),
        repeated_only=True,
        noise_snr_db=22.0,
    )
    return {
        "demo": write_sample(base, out),
        "repeat_heavy": write_sample(repeat, out),
    }
