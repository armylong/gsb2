"""内置样例: 一首短诗 + 自动生成的朗读音轨.

优先用 macOS 的 ``say`` 合成逐词语音 (每个词单独合成再拼接, 所以词的时间
是已知的); 没有可用中文语音时退回到合成的「音节脉冲」音轨。两条路径都会
返回已经打好轴的 ``Timeline``, 直接就能播放和导出。
"""

from __future__ import annotations

import array
import math
import os
import re
import shutil
import subprocess
import tempfile
import wave

from .audio import SAMPLE_RATE, write_wav
from .model import Cue, Timeline

SAMPLE_TITLE = "春晓 · 样例"
SAMPLE_WORDS: list[tuple[str, str]] = [
    ("春眠", "word"),
    ("不觉", "word"),
    ("晓", "word"),
    ("，", "pause"),
    ("处处", "word"),
    ("闻", "word"),
    ("啼鸟", "word"),
    ("。", "pause"),
    ("夜来", "word"),
    ("风雨", "word"),
    ("声", "word"),
    ("，", "pause"),
    ("花落", "word"),
    ("知", "word"),
    ("多少", "word"),
    ("。", "pause"),
]

WORD_GAP_MS = 90
PAUSE_MS = 280
LEAD_MS = 260
TAIL_MS = 420


def sample_text() -> str:
    return "".join(w for w, _ in SAMPLE_WORDS)


# --------------------------------------------------------------------- TTS
def find_chinese_voice() -> str | None:
    if not shutil.which("say"):
        return None
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    voices: list[tuple[str, str]] = []
    for line in out.splitlines():
        m = re.match(r"^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#", line)
        if m:
            voices.append((m.group(1).strip(), m.group(2)))
    preferred = ["Tingting", "Meijia", "Li-mu", "Yu-shu", "Sinji"]
    by_name = {name: voice for voice, name in voices}
    for name in preferred:
        if name in by_name:
            return by_name[name]
    for locale in ("zh_CN", "zh_TW", "zh_HK"):
        for voice, loc in voices:
            if loc == locale:
                return voice
    return None


def _trim_silence(pcm: array.array, threshold: int = 260, window: int = 240) -> array.array:
    if not pcm:
        return pcm
    peak = max(abs(min(pcm)), abs(max(pcm)))
    if peak == 0:
        return array.array("h")
    level = max(threshold, int(peak * 0.035))
    start = 0
    while start < len(pcm) and abs(pcm[start]) < level:
        start += 1
    end = len(pcm)
    while end > start and abs(pcm[end - 1]) < level:
        end -= 1
    if end <= start:
        return array.array("h")
    pad = min(len(pcm), window)
    return pcm[max(0, start - pad):min(len(pcm), end + pad)]


def _say_token(voice: str, text: str, workdir: str) -> array.array:
    path = os.path.join(workdir, f"tok_{abs(hash(text))}_{len(os.listdir(workdir))}.wav")
    cmd = ["say", "-v", voice, "-r", "165", "-o", path,
           "--data-format=LEI16@48000", text]
    subprocess.run(cmd, check=True, timeout=30,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if width != 2:
        raise RuntimeError("say 输出不是 16-bit")
    data = array.array("h")
    data.frombytes(frames)
    if channels == 2:
        data = array.array("h", data[0::2])
    if rate != SAMPLE_RATE:
        ratio = SAMPLE_RATE / rate
        resampled = array.array("h", [0]) * max(1, int(len(data) * ratio))
        for i in range(len(resampled)):
            src = min(len(data) - 1, int(i / ratio))
            resampled[i] = data[src]
        data = resampled
    return _trim_silence(data)


# ---------------------------------------------------------------- 合成音轨
def _synth_token(text: str) -> array.array:
    """把词读成若干带音高的音节; 只求可听、时长可预期。"""
    if not text:
        return array.array("h")
    syllables = max(1, len(text))
    syl_ms = 185
    gap_ms = 35
    out = array.array("h")
    for k in range(syllables):
        code = ord(text[k % len(text)]) if text else 0
        base = 196.0 + (code % 11) * 9 + k * 6
        n = int(SAMPLE_RATE * syl_ms / 1000)
        for i in range(n):
            t = i / SAMPLE_RATE
            env = min(1.0, i / (SAMPLE_RATE * 0.025), (n - i) / (SAMPLE_RATE * 0.035))
            f = base * (1.0 + 0.035 * math.sin(2 * math.pi * 3.1 * t))
            sample = (math.sin(2 * math.pi * f * t)
                      + 0.32 * math.sin(2 * math.pi * f * 2 * t)
                      + 0.12 * math.sin(2 * math.pi * f * 3 * t))
            out.append(int(max(-1.0, min(1.0, sample * env * 0.28)) * 32767))
        out.extend([0] * int(SAMPLE_RATE * gap_ms / 1000))
    return out


def _silence(ms: int) -> array.array:
    return array.array("h", [0]) * int(SAMPLE_RATE * ms / 1000)


def _build_timeline(pcm: array.array, sample_rate: int = SAMPLE_RATE) -> Timeline:
    return Timeline(
        text=sample_text(),
        title=SAMPLE_TITLE,
        duration=int(round(len(pcm) / sample_rate * 1000)),
        sample_rate=sample_rate,
    )


def build_sample(out_dir: str, *, use_tts: bool | str = "auto",
                 audio_name: str = "sample_poem.wav") -> Timeline:
    """生成样例音频并返回打好轴的 Timeline; 音频写到 out_dir/audio_name."""
    os.makedirs(out_dir, exist_ok=True)
    voice: str | None = None
    if use_tts is True or use_tts == "auto":
        voice = find_chinese_voice()
    if use_tts is True and not voice:
        raise RuntimeError("没有找到可用的中文 say 语音")

    pcm = _silence(LEAD_MS)
    timeline = _build_timeline(pcm)
    timeline.sample_rate = SAMPLE_RATE
    next_id = 1
    workdir = tempfile.mkdtemp(prefix="wordcue-tts-")
    try:
        for index, (text, kind) in enumerate(SAMPLE_WORDS):
            if kind == "pause":
                start = len(pcm)
                pcm.extend(_silence(PAUSE_MS))
                end = len(pcm)
                timeline.cues.append(Cue(next_id, text, _ms(start), _ms(end), "pause"))
                next_id += 1
                continue
            if voice:
                try:
                    speech = _say_token(voice, text, workdir)
                except (RuntimeError, OSError, subprocess.SubprocessError, wave.Error):
                    voice = None
                    speech = _synth_token(text)
            else:
                speech = _synth_token(text)
            start = len(pcm)
            pcm.extend(speech)
            end = len(pcm)
            timeline.cues.append(Cue(next_id, text, _ms(start), _ms(end), "word"))
            next_id += 1
            gap = PAUSE_MS if index + 1 < len(SAMPLE_WORDS) and SAMPLE_WORDS[index + 1][1] == "pause" else WORD_GAP_MS
            pcm.extend(_silence(gap))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    pcm.extend(_silence(TAIL_MS))
    audio_path = os.path.join(out_dir, audio_name)
    write_wav(audio_path, pcm)
    timeline.audio_path = audio_path
    timeline.duration = _ms(len(pcm))
    timeline.reading_order = [c.id for c in timeline.cues]
    timeline._next_id = next_id
    return timeline


def _ms(frames: int) -> int:
    return int(round(frames / SAMPLE_RATE * 1000))
