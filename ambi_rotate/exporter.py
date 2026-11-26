"""导出立体声 WAV 与朝向设置, 并支持从设置文件回读重算比对。

导出内容只由参数决定, 与当前试听播放位置无关(直接调用 dsp.render_stereo)。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from .dsp import MODE_FULL, YawMarkers, render_stereo
from .wavio import read_wav, write_wav

SETTINGS_VERSION = 1


@dataclass
class ExportSettings:
    sample_rate: int
    start_time: float
    end_time: float
    speaker_angle_deg: float
    mode: str = MODE_FULL
    use_automation: bool = False
    fixed_yaw_deg: float = 0.0
    markers: list = field(default_factory=list)        # [[t, yaw_deg], ...]
    direction: str = "shortest"
    lr_order: str = "LR"                               # LR 或 RL
    subtype: str = "pcm16"
    source_sha256: str | None = None
    frames: int = 0
    version: int = SETTINGS_VERSION

    def to_markers(self) -> YawMarkers | None:
        if not self.use_automation:
            return None
        return YawMarkers(
            markers=[(float(t), float(a)) for t, a in self.markers],
            direction=self.direction)


def _sha256_of_wav(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def export_stereo(
    wav_path: str,
    settings_path: str,
    b: np.ndarray,
    sr: int,
    *,
    start_time: float,
    end_time: float,
    speaker_angle_deg: float,
    mode: str = MODE_FULL,
    fixed_yaw_deg: float = 0.0,
    automation: YawMarkers | None = None,
    lr_order: str = "LR",
    subtype: str = "pcm16",
    source_wav_path: str | None = None,
) -> ExportSettings:
    """渲染并写 WAV + 设置 JSON, 返回设置对象。"""
    use_auto = automation is not None and bool(automation.markers)
    rendered = render_stereo(
        b, sr,
        speaker_angle_deg=speaker_angle_deg,
        mode=mode,
        fixed_yaw_deg=None if use_auto else fixed_yaw_deg,
        automation=automation if use_auto else None,
        start_time=start_time,
        end_time=end_time,
        lr_flip=(lr_order == "RL"),
    )
    write_wav(wav_path, rendered, sr, subtype=subtype)
    settings = ExportSettings(
        sample_rate=sr,
        start_time=float(start_time),
        end_time=float(end_time),
        speaker_angle_deg=float(speaker_angle_deg),
        mode=mode,
        use_automation=use_auto,
        fixed_yaw_deg=float(fixed_yaw_deg),
        markers=([list(p) for p in automation.sorted_markers()] if use_auto else []),
        direction=(automation.direction if use_auto else "shortest"),
        lr_order=lr_order,
        subtype=subtype,
        source_sha256=(_sha256_of_wav(source_wav_path)
                       if source_wav_path and Path(source_wav_path).exists() else None),
        frames=int(rendered.shape[0]),
    )
    payload = asdict(settings)
    payload["wav_sha256"] = _sha256_of_wav(wav_path)
    Path(settings_path).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return settings


def verify_export(settings_path: str, b: np.ndarray, sr: int,
                  wav_path: str | None = None) -> dict:
    """按设置文件重算, 与导出的 WAV 逐样本比对。

    返回 {ok, reasons, settings, expected_frames, actual_frames,
          expected_start, expected_end, expected_order}。
    """
    path = Path(settings_path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    s = ExportSettings(**{k: v for k, v in payload.items()
                          if k in ExportSettings.__dataclass_fields__})
    if wav_path is None:
        wav_path = str(path.with_suffix(".wav"))
    wav = read_wav(wav_path)
    reasons: list[str] = []

    # 1. 起止时刻回读
    if s.sample_rate != sr:
        reasons.append(f"采样率不符: 设置 {s.sample_rate} vs 当前 {sr}")
    expect_frames = int(round((s.end_time - s.start_time) * s.sample_rate))
    if wav.data.shape[0] != expect_frames or s.frames != expect_frames:
        reasons.append(
            f"帧数/起止不符: WAV={wav.data.shape[0]}, 设置记录={s.frames}, "
            f"按起止时刻应为={expect_frames}")
    if wav.channels != 2:
        reasons.append(f"导出应为立体声, 实际通道数={wav.channels}")

    # 2. 按设置重算
    rendered = render_stereo(
        b, s.sample_rate,
        speaker_angle_deg=s.speaker_angle_deg,
        mode=s.mode,
        fixed_yaw_deg=None if s.use_automation else s.fixed_yaw_deg,
        automation=s.to_markers(),
        start_time=s.start_time,
        end_time=s.end_time,
        lr_flip=(s.lr_order == "RL"),
    )
    actual = wav.data
    m = min(actual.shape[0], rendered.shape[0])
    if m == 0:
        reasons.append("无有效样本可比对")
    else:
        tol = 1e-3 if s.subtype.startswith("pcm") else 1e-6
        max_err = float(np.max(np.abs(actual[:m] - rendered[:m])))
        if max_err > tol:
            reasons.append(f"音频内容不符: 最大误差 {max_err:.2e} > 容差 {tol:.0e}")

    # 3. 左右顺序显式校验: 同一参数下翻转列序的重算结果应与实际不符/相符
    probe = render_stereo(
        b, s.sample_rate,
        speaker_angle_deg=s.speaker_angle_deg,
        mode=s.mode,
        fixed_yaw_deg=None if s.use_automation else s.fixed_yaw_deg,
        automation=s.to_markers(),
        start_time=s.start_time,
        end_time=min(s.end_time, s.start_time + 0.05),
        lr_flip=(s.lr_order == "RL"))
    if probe.shape[0] and actual.shape[0]:
        head = actual[:probe.shape[0]]
        tol2 = 1e-3 if s.subtype.startswith("pcm") else 1e-6
        if np.max(np.abs(head - probe)) > tol2:
            reasons.append(
                f"左右声道顺序与记录 {s.lr_order} 不一致(翻转重算仍不匹配)")
        # 反向验证: 故意取反顺序, 应当不匹配(防止两耳恰好等幅时漏检)
        probe_wrong = probe[:, [1, 0]]
        if np.max(np.abs(head - probe_wrong)) <= tol2 and not np.allclose(
                head[:, 0], head[:, 1], atol=tol2):
            reasons.append("左右声道顺序校验无法区分(两耳电平异常相同)")

    # 4. 哈希
    if "wav_sha256" in payload:
        if payload["wav_sha256"] != _sha256_of_wav(wav_path):
            reasons.append("WAV sha256 与设置文件记录不一致")

    return {
        "ok": not reasons,
        "reasons": reasons,
        "settings": s,
        "expected_frames": expect_frames,
        "actual_frames": actual.shape[0],
        "expected_start": s.start_time,
        "expected_end": s.end_time,
        "expected_order": s.lr_order,
    }
