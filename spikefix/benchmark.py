"""合成对照测试: 干净打击音 + 注入脉冲, 量化检测/修复指标.

用法:
    python -m spikefix.benchmark            # 文本报告
    python -m spikefix.benchmark --json     # JSON 报告
    python -m spikefix.benchmark --write-dir samples   # 同时导出对照 wav
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from .dsp import DetectParams, detect, merge_spans, repair, to_db
from .wavio import WavData, save_wav

SR = 48000


@dataclass
class Hit:
    start: int
    kind: str
    amp: float
    gains: tuple[float, float]


@dataclass
class Injection:
    channel: int
    start: int
    end: int
    amp: float
    note: str = ""


@dataclass
class ScenarioReport:
    name: str
    duration_s: float
    injected: int = 0
    detected_spike: int = 0
    detected_protected: int = 0
    matched: int = 0
    missed: int = 0
    false_marks: int = 0
    false_protected: int = 0
    hit_marks: int = 0                 # 落在真实敲击活动窗内的标记数
    repair_region_rms_db: float = -200.0
    repair_region_max_db: float = -200.0
    repair_global_rms_db: float = -200.0
    outside_changed_samples: int = 0
    hit_region_changed_samples: int = 0
    notes: list[str] = field(default_factory=list)


@dataclass
class BenchmarkReport:
    sample_rate: int
    seed: int
    params: dict
    scenarios: list[ScenarioReport]
    analysis_paths: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "sample_rate": self.sample_rate,
            "seed": self.seed,
            "params": self.params,
            "scenarios": [asdict(s) for s in self.scenarios],
            "analysis_paths": self.analysis_paths,
        }

    def summary_text(self) -> str:
        lines = [f"合成对照测试  sr={self.sample_rate}  seed={self.seed}", ""]
        header = (
            f"{'场景':<16}{'注入':>4}{'自动修':>6}{'保护标':>6}{'命中':>5}{'漏检':>5}"
            f"{'误标':>5}{'误保护':>7}{'区RMS':>9}{'区峰值':>9}{'越界改动':>9}"
        )
        lines.append(header)
        lines.append("-" * 92)
        for s in self.scenarios:
            lines.append(
                f"{s.name:<16}{s.injected:>4}{s.detected_spike:>6}{s.detected_protected:>6}"
                f"{s.matched:>5}{s.missed:>5}{s.false_marks:>5}{s.false_protected:>7}"
                f"{s.repair_region_rms_db:>9.1f}{s.repair_region_max_db:>9.1f}"
                f"{s.outside_changed_samples:>9}"
            )
            for note in s.notes:
                lines.append(f"    · {note}")
        lines.append("")
        lines.append("自动修 = 标记为可自动修复的孤立跳点; 保护标 = 已标记但需人工确认(不自动改).")
        lines.append("误标/误保护 = 附近没有任何注入脉冲, 却被标为跳点 / 受保护点.")
        lines.append("区RMS/区峰值 = 修复后与干净原声在已修复区间内的误差 (dBFS).")
        lines.append("越界改动 = 修复区间之外被改动的采样数, 必须为 0.")
        return "\n".join(lines)


# --------------------------------------------------------------------------
# 合成素材
# --------------------------------------------------------------------------

def _env(n: int, tau_s: float, sr: int = SR) -> np.ndarray:
    t = np.arange(n) / float(sr)
    return np.exp(-t / max(tau_s, 1e-5))


def _synth_hit(kind: str, rng: np.random.Generator) -> np.ndarray:
    """带真实起振、衰减与噪声成分的打击音 (不是孤立跳点)."""
    if kind == "kick":
        n = int(0.32 * SR)
        t = np.arange(n) / SR
        f = 55.0 + 145.0 * np.exp(-t / 0.028)
        phase = 2 * np.pi * np.cumsum(f) / SR
        body = np.sin(phase) * _env(n, 0.11)
        click = rng.standard_normal(n) * _env(n, 0.0015) * 0.25
        return 0.9 * np.tanh((body + click) * 1.2)
    if kind == "snare":
        n = int(0.22 * SR)
        t = np.arange(n) / SR
        noise = rng.standard_normal(n)
        lp = np.zeros(n)
        for i in range(1, n):
            lp[i] = 0.62 * lp[i - 1] + 0.38 * noise[i]
        snap = np.diff(np.concatenate([[0.0], lp])) * _env(n, 0.055)
        body = np.sin(2 * np.pi * 188.0 * t) * _env(n, 0.045) * 0.55
        return 0.72 * (snap * 1.4 + body)
    n = int(0.09 * SR)
    noise = rng.standard_normal(n)
    hp = np.diff(np.concatenate([[0.0], noise]))
    return 0.32 * hp * _env(n, 0.018)


HIT_LENGTH = {"kick": int(0.30 * SR), "snare": int(0.19 * SR), "hat": int(0.07 * SR)}


def make_clean_percussion(seed: int = 7, duration_s: float = 4.0) -> tuple[WavData, list[Hit]]:
    rng = np.random.default_rng(seed)
    n = int(duration_s * SR)
    data = np.zeros((n, 2), dtype=np.float64)
    hits: list[Hit] = []
    pos = int(0.18 * SR)
    kinds = ["kick", "snare", "hat", "snare", "hat", "kick"]
    for i in range(64):
        if pos >= n - int(0.25 * SR):
            break
        kind = kinds[i % len(kinds)]
        amp = float(rng.uniform(0.55, 0.95)) * (0.7 if kind == "hat" else 1.0)
        gains = (float(rng.uniform(0.85, 1.0)), float(rng.uniform(0.85, 1.0)))
        hit = _synth_hit(kind, rng)
        for ch in range(2):
            start = pos + (0 if ch == 0 else int(round(rng.uniform(0.0, 0.0004) * SR)))
            seg = hit * amp * gains[ch]
            end = min(n, start + len(seg))
            data[start:end, ch] += seg[: end - start]
        hits.append(Hit(start=pos, kind=kind, amp=amp, gains=gains))
        pos += int(rng.uniform(0.27, 0.42) * SR)
    data += rng.standard_normal(data.shape) * 1e-4  # 底噪
    peak = float(np.max(np.abs(data)))
    if peak > 0:
        data *= 0.82 / peak
    return WavData(data, SR, 16, 1), hits


def hit_active_windows(hits: list[Hit]) -> list[tuple[int, int]]:
    return [(h.start, h.start + HIT_LENGTH[h.kind]) for h in hits]


def make_degraded(
    clean: WavData,
    hits: list[Hit],
    seed: int = 11,
    isolated_count: int = 8,
) -> tuple[WavData, list[Injection]]:
    """在安静处注入孤立脉冲, 并故意在真实敲击尾音内放两个难题样本."""
    rng = np.random.default_rng(seed)
    data = clean.samples.copy()
    n = clean.frames
    inactive = np.ones(n, dtype=bool)
    for a, b in hit_active_windows(hits):
        inactive[max(0, a - 24): min(n, b + 24)] = False
    injections: list[Injection] = []
    used: list[int] = []

    def pick(width: int) -> int:
        for _ in range(4000):
            p = int(rng.integers(int(0.03 * SR), n - 32))
            if not inactive[p] or not inactive[min(n - 1, p + width - 1)]:
                continue
            if any(abs(p - q) <= 32 for q in used):
                continue
            return p
        raise RuntimeError("找不到足够的安静位置")

    placements: list[tuple[int, int]] = []
    for _ in range(max(1, isolated_count - 4)):
        placements.append((pick(1), 1))
    for _ in range(2):
        placements.append((pick(2), 2))       # 两采样脉冲
    for p, width in placements:
        ch = int(rng.integers(0, 2))
        amp = float(rng.choice([-1.0, 1.0]) * rng.uniform(0.25, 0.7))
        for k in range(width):
            data[p + k, ch] += amp * (1.0 - 0.35 * k)
        injections.append(Injection(ch, p, p + width - 1, amp))
        used.append(p)

    # 两个位于真实敲击尾音内部的脉冲: 期望被标记为"保护"但不自动修复
    tails = sorted(h.start + int(0.030 * SR) for h in hits if h.kind in ("snare", "kick"))
    rng.shuffle(tails)
    for p in tails[:2]:
        ch = int(rng.integers(0, 2))
        amp = float(rng.choice([-1.0, 1.0]) * rng.uniform(0.25, 0.5))
        data[p, ch] += amp
        injections.append(Injection(ch, p, p, amp, note="真实敲击尾音内"))

    return WavData(data, clean.sample_rate, clean.bits_per_sample, clean.audio_format), injections


# --------------------------------------------------------------------------
# 指标
# --------------------------------------------------------------------------

def _match(injections: list[Injection], detections, tol: int = 2) -> tuple[int, list[Injection]]:
    remaining = list(injections)
    matched = 0
    for d in detections:
        for idx, inj in enumerate(remaining):
            if inj.channel == d.channel and d.start - tol <= inj.end and d.end + tol >= inj.start:
                remaining.pop(idx)
                matched += 1
                break
    return matched, remaining


def _spans_from(project, dets) -> dict[int, list[tuple[int, int]]]:
    out: dict[int, list[tuple[int, int]]] = {}
    for d in dets:
        if d.kind != "spike":
            continue
        out.setdefault(d.channel, []).append((d.start, d.end))
    for ch in out:
        out[ch] = merge_spans(out[ch], gap=0)[0]
    return out


def _outside_changed(a: np.ndarray, b: np.ndarray, spans: dict[int, list[tuple[int, int]]]) -> int:
    mask = np.zeros(a.shape[0], dtype=bool)
    for ch_spans in spans.values():
        for s, e in ch_spans:
            mask[max(0, s): min(a.shape[0], e + 1)] = True
    kept = ~mask
    return int(np.count_nonzero(np.any(a[kept] != b[kept], axis=1)))


def _hit_mask(hit_windows: list[tuple[int, int]], n: int) -> np.ndarray:
    mask = np.zeros(n, dtype=bool)
    for a, b in hit_windows:
        mask[max(0, a): min(n, b + 1)] = True
    return mask


def run_benchmark(seed: int = 7, params: DetectParams | None = None,
                  method: str = "linear") -> tuple[BenchmarkReport, dict[str, WavData]]:
    params = params or DetectParams()
    clean, hits = make_clean_percussion(seed=seed)
    degraded, injections = make_degraded(clean, hits, seed=seed + 4)
    windows = hit_active_windows(hits)
    hmask = _hit_mask(windows, clean.frames)

    def on_hit(frame: int) -> bool:
        return bool(hmask[min(max(frame, 0), clean.frames - 1)])

    def evaluate(name: str, source: WavData, inj: list[Injection],
                 ref: WavData, do_repair: bool) -> tuple[ScenarioReport, np.ndarray]:
        dets = detect(source.samples, params).detections()
        rep = ScenarioReport(name=name, duration_s=ref.duration,
                             injected=len(inj) if inj else 0)
        spikes = [d for d in dets if d.kind == "spike"]
        protected = [d for d in dets if d.kind == "protected"]
        rep.detected_spike = len(spikes)
        rep.detected_protected = len(protected)
        # 命中/漏检只统计"安静区注入"的脉冲
        quiet = [i for i in inj if not i.note]
        m1, rem = _match(quiet, [d for d in dets if d.kind == "spike"])
        m2, rem = _match(rem, [d for d in dets if d.kind == "protected"])
        rep.matched = m1 + m2
        rep.missed = len(rem)
        # 误标/误保护: 不与任何注入点重叠的标记
        for d in spikes:
            if not any(d.channel == i.channel and d.start - 2 <= i.end and d.end + 2 >= i.start
                       for i in inj):
                rep.false_marks += 1
        for d in protected:
            if not any(d.channel == i.channel and d.start - 2 <= i.end and d.end + 2 >= i.start
                       for i in inj):
                rep.false_protected += 1
        rep.hit_marks = sum(1 for d in dets if on_hit(d.peak_frame))
        if not do_repair:
            return rep, source.samples
        spans = _spans_from(None, spikes)
        repaired = repair(source.samples, spans, method)
        if spans:
            mask = np.zeros(ref.frames, dtype=bool)
            for ch_spans in spans.values():
                for a, b in ch_spans:
                    mask[a:b + 1] = True
            err = np.abs(repaired[mask] - ref.samples[mask])
            if err.size:
                rep.repair_region_rms_db = to_db(float(np.sqrt(np.mean(err ** 2))))
                rep.repair_region_max_db = to_db(float(np.max(err)))
        rep.repair_global_rms_db = to_db(float(np.sqrt(np.mean((repaired - ref.samples) ** 2))))
        rep.outside_changed_samples = _outside_changed(repaired, source.samples, spans)
        if spans:
            hm = _hit_mask(windows, ref.frames)
            if np.any(hm):
                rep.hit_region_changed_samples = int(np.count_nonzero(
                    np.any(repaired[hm] != source.samples[hm], axis=1)))
        return rep, repaired

    # 场景 1: 干净真实打击音
    clean_rep, _ = evaluate("真实打击音(干净)", clean, [], clean, False)
    clean_rep.notes.append(
        "自动修标记为 0: 真实敲击未被误判为跳点" if clean_rep.detected_spike == 0
        else "注意: 干净真实敲击上仍有自动修复标记 (见误标)"
    )
    if clean_rep.detected_protected:
        clean_rep.notes.append(
            f"{clean_rep.detected_protected} 个真实瞬态被列为待确认, 默认不自动改"
        )

    # 场景 2: 注入脉冲
    inj_rep, repaired_samples = evaluate("原声+注入脉冲", degraded, injections, clean, True)
    repaired_wav = WavData(repaired_samples, degraded.sample_rate,
                           degraded.bits_per_sample, degraded.audio_format)
    quiet = [i for i in injections if not i.note]
    inj_rep.notes.append(f"安静区注入 {len(quiet)} 个脉冲; 另在真实敲击尾音内注入 {len(injections) - len(quiet)} 个")
    tail_marked = sum(
        1 for i in injections if i.note and
        any(i.channel == d.channel and d.start - 2 <= i.end and d.end + 2 >= i.start
            for d in detect(degraded.samples, params).detections())
    )
    inj_rep.notes.append(f"敲击尾音内脉冲: {tail_marked} 个被标记 (保护或修复)")
    if inj_rep.false_marks:
        inj_rep.notes.append(f"警告: {inj_rep.false_marks} 个非注入点被标为自动修复")
    if inj_rep.hit_region_changed_samples == 0:
        inj_rep.notes.append("真实敲击区间内 0 个采样被改动")
    else:
        inj_rep.notes.append(
            f"注意: 真实敲击区间内改动了 {inj_rep.hit_region_changed_samples} 个采样 (来自注入点)")

    # 场景 3: 高灵敏度 -> 误标风险展示
    sensitive = DetectParams(**{**params.__dict__,
                                "abs_threshold_db": max(-160.0, params.abs_threshold_db - 18.0),
                                "z_threshold": max(1.0, params.z_threshold * 0.6),
                                "background_db": -200.0})
    sens_dets = detect(clean.samples, sensitive).detections()
    sens_rep = ScenarioReport(name="真实音(高灵敏)", duration_s=clean.duration)
    sens_rep.detected_spike = sum(1 for d in sens_dets if d.kind == "spike")
    sens_rep.detected_protected = sum(1 for d in sens_dets if d.kind == "protected")
    sens_rep.false_marks = sens_rep.detected_spike
    sens_rep.false_protected = sens_rep.detected_protected
    sens_rep.hit_marks = sum(1 for d in sens_dets if on_hit(d.peak_frame))
    sens_rep.notes.append("故意降低门限并关闭背景保护后的误标数, 说明默认保护项的必要性")

    report = BenchmarkReport(
        sample_rate=SR, seed=seed,
        params={k: v for k, v in params.normalized().__dict__.items()},
        scenarios=[clean_rep, inj_rep, sens_rep],
    )
    wavs = {"clean": clean, "degraded": degraded, "repaired": repaired_wav}
    return report, wavs


def write_benchmark_wavs(out_dir: str | Path, seed: int = 7,
                         params: DetectParams | None = None) -> dict[str, Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    _, wavs = run_benchmark(seed=seed, params=params)
    names = {"clean": "bench_clean.wav", "degraded": "bench_degraded.wav",
             "repaired": "bench_repaired.wav"}
    paths: dict[str, Path] = {}
    for key, wav in wavs.items():
        p = out / names[key]
        save_wav(p, wav)
        paths[key] = p
    return paths


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="spikefix 合成对照测试")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--write-dir", type=str, default=None, help="导出对照 wav 的目录")
    args = ap.parse_args(argv)
    report, _ = run_benchmark(seed=args.seed)
    if args.write_dir:
        report.analysis_paths = {
            k: str(v) for k, v in write_benchmark_wavs(args.write_dir, args.seed).items()
        }
    if args.json:
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(report.summary_text())
        if report.analysis_paths:
            print("\n对照 wav:")
            for k, v in report.analysis_paths.items():
                print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
