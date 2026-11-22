"""WAV / CSV / JSON 的读写与导出。"""
from __future__ import annotations

import csv
import json
import wave
from dataclasses import asdict
from pathlib import Path

import numpy as np

from .core import SAMPLE_RATE, SimResult, params_to_dict


def write_wav(path, samples: np.ndarray, sr: int = SAMPLE_RATE):
    """写成 16-bit PCM 单声道 WAV。"""
    x = np.clip(np.asarray(samples, dtype=float), -1.0, 1.0)
    pcm = (x * 32767.0).round().astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def read_wav(path, target_sr: int = SAMPLE_RATE):
    """读 WAV,转单声道 float[-1,1],必要时线性重采样到 target_sr。"""
    with wave.open(str(path), "rb") as w:
        nch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(float) / 32768.0
    elif sw == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(float) - 128.0) / 128.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(float) / 2147483648.0
    else:
        raise ValueError(f"不支持的采样位宽: {sw} 字节")
    if nch > 1:
        data = data.reshape(-1, nch).mean(axis=1)
    if sr != target_sr and len(data) > 1:
        n_out = int(round(len(data) * target_sr / sr))
        data = np.interp(np.linspace(0, len(data) - 1, n_out),
                         np.arange(len(data)), data)
        sr = target_sr
    return np.clip(data, -1.0, 1.0), sr


def export_all(directory, result: SimResult, source_desc: str):
    """导出本次模拟:实际输出 WAV + 包处理记录 CSV + 配置/统计 JSON。"""
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    wav_path = d / "actual_output.wav"
    csv_path = d / "packet_log.csv"
    json_path = d / "run_config.json"

    write_wav(wav_path, result.output, result.sr)

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["index", "send_ms", "arrival_ms", "sched_play_ms",
                    "status", "slot_samples", "concealed", "gap_id"])
        for p in result.packets:
            w.writerow([p.index, f"{p.send_ms:.3f}",
                        "" if p.arrival_ms != p.arrival_ms else f"{p.arrival_ms:.3f}",
                        f"{p.sched_play_ms:.3f}", p.status,
                        p.slot_samples, int(p.concealed), p.gap_id])

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "source": source_desc,
            "sample_rate": result.sr,
            "params": params_to_dict(result.params),
            "stats": result.stats,
            "gaps": result.gaps,
        }, f, ensure_ascii=False, indent=2)

    return wav_path, csv_path, json_path
