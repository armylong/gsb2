"""样例素材的音视频特征测试: 帧号/移动图形(视觉)与定时蜂鸣(听觉)。"""

import subprocess

import numpy as np

from proxy_check.ffmedia import GRID_H, GRID_W, decode_gray_frames


def _pcm_mono(path, sr=16000) -> np.ndarray:
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1",
         "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.float32)


def test_source_has_visible_frame_numbers_and_motion(paths):
    frames = decode_gray_frames(paths["source"], GRID_W, GRID_H)
    # 移动图形: 全程相邻帧存在可见变化, 不是静态图。
    diffs = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))
    assert np.mean(diffs) > 1e-3
    # 首末帧明显不同(圆形横移 + 背景变化)。
    assert np.mean(np.abs(frames[0] - frames[-1])) > 0.02


def test_source_has_periodic_beep_each_second(paths, source_info):
    sr = 16000
    pcm = _pcm_mono(paths["source"], sr)
    duration = source_info.duration
    # 每秒前 0.15s 应有声音, 0.5~0.9s 应为静默(容差留给编码)。
    for sec in range(int(duration)):
        base = sec * sr
        beep = np.max(np.abs(pcm[base: base + int(0.15 * sr)]))
        quiet = np.max(np.abs(
            pcm[base + int(0.5 * sr): base + int(0.9 * sr)]))
        assert beep > 0.05, f"第 {sec} 秒缺少蜂鸣"
        assert quiet < 0.002, f"第 {sec} 秒静默段仍有声音"


def test_proxy_keeps_audio_with_beep(paths):
    sr = 16000
    pcm = _pcm_mono(paths["good"], sr)
    # 代理保留了音轨且蜂鸣周期仍在。
    base = 2 * sr
    assert np.max(np.abs(pcm[base: base + int(0.15 * sr)])) > 0.05
    assert np.max(np.abs(
        pcm[base + int(0.5 * sr): base + int(0.9 * sr)])) < 0.002
