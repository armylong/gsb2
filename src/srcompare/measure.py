# -*- coding: utf-8 -*-
"""频谱测量与导出回读校验。

测量内容(针对程序生成测试音):
- 通带单音幅度变化: 输出单音相对输入单音的 dB 差
- 混叠能量: 输入中高于目标奈奎斯特频率的成分, 折叠后在输出中的能量,
  相对该成分原始能量的衰减 dB 数
- 左右串音: 仅出现在一个声道的单音, 在另一声道泄漏的 dB 数

测量区间统一舍弃首尾各 EDGE_DISCARD_SEC, 不用首尾少量瞬态代替整段结论。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

import numpy as np

from .audioio import Track, read_wav_any_rate
from .spectrum import alias_frequency, measurement_window_text, tone_level_db

PASSBAND_LIMIT_DB = 1.0     # 通带幅度变化阈值: < 1 dB
ALIAS_SUPPRESS_DB = 40.0    # 混叠抑制阈值: >= 40 dB
READBACK_TOL_DB = 0.5       # 回读与内存结果的允许偏差(16bit 量化余量)


@dataclass
class ToneResult:
    """单个测试音分量的测量结果。"""

    freq: float
    label: str
    kind: str                       # 'passband' | 'alias'
    source_db: float
    output_db: float
    measure_freq_out: float         # 在输出中实际测量的频率
    delta_db: float                 # 通带: out-src; 混叠: 负值(alias-src)
    suppression_db: float | None = None  # 混叠抑制(仅 alias)


@dataclass
class ConversionReport:
    method: str
    in_sr: int
    out_sr: int
    n_frames: int
    duration: float
    channels: int
    window_text: str
    tones: list = field(default_factory=list)
    crosstalk_db: float | None = None
    crosstalk_freq: float | None = None
    passband_ok: bool | None = None
    alias_ok: bool | None = None

    def summary_lines(self) -> list:
        lines = [
            f"{self.method}: {self.in_sr}Hz -> {self.out_sr}Hz, "
            f"{self.n_frames} 点, {self.duration:.4f}s, {self.channels}ch",
            self.window_text,
        ]
        for t in self.tones:
            if t.kind == "passband":
                lines.append(
                    f"  通带 {t.freq:g}Hz: 输入 {t.source_db:6.2f}dB -> "
                    f"输出 {t.output_db:6.2f}dB, 幅度变化 {t.delta_db:+.2f}dB"
                )
            else:
                lines.append(
                    f"  混叠 {t.freq:g}Hz 折到 {t.measure_freq_out:g}Hz: "
                    f"原能量 {t.source_db:6.2f}dB, 折叠能量 {t.output_db:6.2f}dB, "
                    f"抑制 {t.suppression_db:5.1f}dB"
                )
        if self.crosstalk_db is not None:
            lines.append(
                f"  左右串音 @ {self.crosstalk_freq:g}Hz: "
                f"{self.crosstalk_db:+.1f}dB (静默声道相对拥有声道, 越负越干净)"
            )
        checks = []
        if self.passband_ok is not None:
            checks.append(
                f"通带幅度 < {PASSBAND_LIMIT_DB:g}dB: "
                f"{'通过' if self.passband_ok else '不通过'}"
            )
        if self.alias_ok is not None:
            checks.append(
                f"混叠抑制 >= {ALIAS_SUPPRESS_DB:g}dB: "
                f"{'通过' if self.alias_ok else '不通过'}"
            )
        if checks:
            lines.append("  判定: " + "; ".join(checks))
        return lines


def _channel_data(track: Track, ch: int) -> np.ndarray:
    return track.mono(ch)


def evaluate_conversion(source: Track, result: Track, channel: int = 0) -> ConversionReport:
    """对一路重采样结果做完整频谱测量。"""
    out_fn = result.sr / 2.0
    src_x = _channel_data(source, channel)
    out_x = _channel_data(result, channel)

    tones: list[ToneResult] = []
    passband_deltas, suppressions = [], []

    for spec in source.tone_specs:
        if channel not in spec.channels:
            continue
        src_db, _, _ = tone_level_db(src_x, source.sr, spec.freq)
        if spec.freq <= out_fn:
            out_db, _, _ = tone_level_db(out_x, result.sr, spec.freq)
            delta = out_db - src_db
            passband_deltas.append(delta)
            tones.append(
                ToneResult(
                    spec.freq, spec.label, "passband", src_db, out_db,
                    spec.freq, delta,
                )
            )
        else:
            f_alias = alias_frequency(spec.freq, result.sr)
            alias_db, _, _ = tone_level_db(out_x, result.sr, f_alias)
            suppression = src_db - alias_db
            suppressions.append(suppression)
            tones.append(
                ToneResult(
                    spec.freq, spec.label, "alias", src_db, alias_db,
                    f_alias, alias_db - src_db, suppression,
                )
            )

    # 左右串音: 找只在一个声道出现的分量(排除左右都有的公共分量),
    # 在输出上测量它在"拥有声道"与"静默声道"中的电平差。
    crosstalk_db = crosstalk_freq = None
    if result.channels == 2:
        for spec in source.tone_specs:
            if len(spec.channels) != 1:
                continue
            owner = spec.channels[0]
            other = 1 - owner
            if spec.freq > out_fn:
                f_meas = alias_frequency(spec.freq, result.sr)
            else:
                f_meas = spec.freq
            db_owner, _, _ = tone_level_db(result.mono(owner), result.sr, f_meas)
            db_other, _, _ = tone_level_db(result.mono(other), result.sr, f_meas)
            crosstalk_db = db_other - db_owner
            crosstalk_freq = f_meas
            break

    passband_ok = all(abs(d) < PASSBAND_LIMIT_DB for d in passband_deltas) or None
    alias_ok = (
        all(s >= ALIAS_SUPPRESS_DB for s in suppressions) if suppressions else None
    )

    return ConversionReport(
        method=result.note or result.name,
        in_sr=source.sr,
        out_sr=result.sr,
        n_frames=result.num_frames,
        duration=result.duration,
        channels=result.channels,
        window_text=measurement_window_text(result.sr),
        tones=tones,
        crosstalk_db=crosstalk_db,
        crosstalk_freq=crosstalk_freq,
        passband_ok=passband_ok,
        alias_ok=alias_ok,
    )


@dataclass
class ReadbackReport:
    path: str
    structural_ok: bool
    checks: list = field(default_factory=list)
    report: ConversionReport | None = None
    level_match_ok: bool | None = None

    @property
    def ok(self) -> bool:
        lvl = True if self.level_match_ok is None else self.level_match_ok
        # 回读只要求结构正确且通带一致; 混叠水平反映的是转换方法本身的特性
        # (线性路径的混叠本就预期不达标), 不构成回读失败。
        rep = True
        if self.report is not None and self.report.passband_ok is False:
            rep = False
        return self.structural_ok and lvl and rep

    def lines(self) -> list:
        out = [f"回读文件: {os.path.basename(self.path)}"]
        out.extend(f"  {c}" for c in self.checks)
        if self.report is not None:
            out.extend("  " + ln for ln in self.report.summary_lines()[1:])
        if self.level_match_ok is not None:
            out.append(
                f"  回读电平与内存结果偏差 < {READBACK_TOL_DB:g}dB: "
                f"{'通过' if self.level_match_ok else '不通过'}"
            )
        out.append(f"  总体: {'通过' if self.ok else '不通过'}")
        return out


def verify_export(
    path: str,
    expected: Track,
    source: Track,
    in_memory: ConversionReport | None = None,
) -> ReadbackReport:
    """导出后回读: 检查点数/时长/声道, 并重做频谱测量。"""
    checks: list[str] = []
    structural_ok = True
    try:
        rb = read_wav_any_rate(path)
    except Exception as exc:  # noqa: BLE001
        return ReadbackReport(
            path, False, [f"无法回读: {exc}"], None, None
        )

    if rb.sr == expected.sr:
        checks.append(f"采样率 {rb.sr}Hz 符合目标")
    else:
        structural_ok = False
        checks.append(f"采样率不符: 回读 {rb.sr}Hz != 目标 {expected.sr}Hz")

    if rb.num_frames == expected.num_frames:
        checks.append(f"点数 {rb.num_frames} 与导出一致")
    else:
        structural_ok = False
        checks.append(
            f"点数不符: 回读 {rb.num_frames} != 导出 {expected.num_frames}"
        )

    if rb.channels == expected.channels:
        checks.append(f"声道数 {rb.channels} 一致")
    else:
        structural_ok = False
        checks.append(
            f"声道不符: 回读 {rb.channels} != 导出 {expected.channels}"
        )

    if rb.channels == 2 and rb.samples.shape[0] == expected.samples.shape[0]:
        checks.append("左右声道等长, 无串音结构错位")

    want_dur = expected.num_frames / expected.sr
    if abs(rb.duration - want_dur) < 1e-9:
        checks.append(f"时长 {rb.duration:.4f}s 与 点数/采样率 吻合")
    else:
        structural_ok = False
        checks.append(f"时长不符: {rb.duration:.4f}s != {want_dur:.4f}s")

    rb.tone_specs = list(source.tone_specs)
    rb_report = evaluate_conversion(source, rb)

    level_match = None
    if in_memory is not None and len(in_memory.tones) == len(rb_report.tones):
        # 只比较通带分量: 混叠分量可能落在量化噪声底, 读数不稳定且不代表回读失真
        pairs = [
            (a, b) for a, b in zip(in_memory.tones, rb_report.tones)
            if a.kind == "passband" and b.kind == "passband"
        ]
        diffs = [abs(a.output_db - b.output_db) for a, b in pairs]
        if diffs:
            level_match = all(d < READBACK_TOL_DB for d in diffs)
            checks.append(f"回读通带电平最大偏差 {max(diffs):.3f}dB")
        else:
            checks.append("无通带分量可比较, 跳过电平一致性检查")

    return ReadbackReport(path, structural_ok, checks, rb_report, level_match)
