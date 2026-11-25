"""工程保存/打开与电平设置导出。

工程文件 (.cuelab.json): 单个 JSON, 音频以 base64 内嵌 16-bit wav,
重新打开即可完整重现同一次比较 (声源、时刻、增益、区间全部保留)。
电平设置 (.levels.json): 只含各路增益与时刻, 方便贴到别的系统里复现。
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np

from . import audio_io
from .mixer import ProjectState, CueState

PROJECT_MAGIC = "cuelab-project"
PROJECT_VERSION = 1


def _encode_audio(x: np.ndarray, sr: int) -> str:
    return base64.b64encode(audio_io.wav_to_bytes(x, sr)).decode("ascii")


def _decode_audio(b64: str, target_sr: int) -> np.ndarray:
    raw = base64.b64decode(b64.encode("ascii"))
    x, sr = audio_io.read_wav_from_bytes(raw)
    if sr != target_sr:
        x = audio_io.resample_linear(x, sr, target_sr)
    return x


def save_project(path: str, state: ProjectState) -> None:
    payload = {
        "format": PROJECT_MAGIC,
        "version": PROJECT_VERSION,
        "sr": state.sr,
        "bg_gain_db": state.bg_gain_db,
        "background": (
            {"name": "背景声", "wav_b64": _encode_audio(state.background, state.sr)}
            if state.background is not None and state.background.size
            else None
        ),
        "cues": [
            {
                "name": c.name,
                "start": c.start,
                "gain_db": c.gain_db,
                "wav_b64": _encode_audio(c.audio, state.sr),
            }
            for c in state.cues
        ],
        "test_start": state.test_start,
        "test_end": state.test_end,
        "seg_start": state.seg_start,
        "seg_dur": state.seg_dur,
        "selected_band": state.selected_band,
        "current_cue": state.current_cue,
        "mode": state.mode,
    }
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_project(path: str) -> ProjectState:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("format") != PROJECT_MAGIC:
        raise ValueError("不是 cue lab 工程文件")
    sr = int(payload["sr"])
    bg_payload = payload.get("background")
    background = _decode_audio(bg_payload["wav_b64"], sr) if bg_payload else None
    cues = []
    for item in payload.get("cues", [])[:3]:
        audio = _decode_audio(item["wav_b64"], sr)
        cues.append(
            CueState(
                name=str(item.get("name", "提示音")),
                audio=audio,
                start=float(item["start"]),
                gain_db=float(item.get("gain_db", 0.0)),
            )
        )
    state = ProjectState(
        sr=sr,
        background=background,
        bg_gain_db=float(payload.get("bg_gain_db", 0.0)),
        cues=cues,
        test_start=float(payload.get("test_start", 0.0)),
        test_end=float(payload.get("test_end", 6.0)),
        seg_start=float(payload.get("seg_start", 0.8)),
        seg_dur=float(payload.get("seg_dur", 2.0)),
        selected_band=int(payload.get("selected_band", 3)),
        current_cue=int(payload.get("current_cue", 0)),
        mode=payload.get("mode", "mix"),
    )
    state.clamp_segment()
    return state


def export_levels(path: str, state: ProjectState) -> None:
    """导出各路电平/时刻设置 (不含音频本体)。"""
    payload = {
        "format": "cuelab-levels",
        "version": PROJECT_VERSION,
        "sample_rate": state.sr,
        "background": {
            "gain_db": state.bg_gain_db,
            "duration_sec": (
                round(len(state.background) / state.sr, 6)
                if state.background is not None
                else None
            ),
        },
        "cues": [
            {
                "name": c.name,
                "start_sec": round(c.start, 6),
                "end_sec": round(c.end_time(state.sr), 6),
                "gain_db": c.gain_db,
                "duration_sec": round(len(c.audio) / state.sr, 6),
            }
            for c in state.cues
        ],
        "test_interval": [state.test_start, state.test_end],
        "audition_segment": [state.seg_start, state.seg_end()],
    }
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
