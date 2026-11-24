"""帧源：ffmpeg 本地文件解码 + 内置合成样片。

统一接口：
    source.width / source.height / source.fps / source.n_frames
    source.declared_range   # 'tv' | 'pc' | None（文件声明缺失）
    source.title
    source.frame(i) -> (Y, U, V)  三个 uint8 全分辨率平面 (yuv444)
"""
from __future__ import annotations

import json
import subprocess

import numpy as np

from .colorutil import rgb_to_yuv_u8


# ---------------------------------------------------------------- ffprobe

def probe(path: str) -> dict:
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_streams", "-show_format", "-of", "json", path,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    st = info["streams"][0]
    num, den = st.get("avg_frame_rate", "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    if fps <= 0:
        fps = 30.0
    n_frames = st.get("nb_frames")
    if n_frames and n_frames != "N/A":
        n_frames = int(n_frames)
    else:
        dur = float(info.get("format", {}).get("duration", 0) or 0)
        n_frames = max(1, int(round(dur * fps))) if dur else 0
    cr = st.get("color_range")  # 'tv' / 'pc' / None(未知)
    if cr not in ("tv", "pc"):
        cr = None
    return {
        "width": int(st["width"]),
        "height": int(st["height"]),
        "fps": fps,
        "n_frames": n_frames,
        "declared_range": cr,
        "pix_fmt": st.get("pix_fmt", "?"),
        "codec": st.get("codec_name", "?"),
    }


# ---------------------------------------------------------------- ffmpeg 文件源

class FFmpegSource:
    """顺序解码；跳帧时重开管道用 -ss 精确seek后向前解码。"""

    def __init__(self, path: str):
        meta = probe(path)
        self.path = path
        self.width = meta["width"]
        self.height = meta["height"]
        self.fps = meta["fps"]
        self.n_frames = meta["n_frames"]
        self.declared_range = meta["declared_range"]
        self.meta = meta
        self.title = path.rsplit("/", 1)[-1]
        self._proc = None
        self._next = 0  # 管道里下一帧的序号
        self._frame_bytes = self.width * self.height * 3  # yuv444p

    # -- 内部 ----------------------------------------------------------
    def _close(self):
        if self._proc is not None:
            try:
                self._proc.stdout.close()
                self._proc.kill()
                self._proc.wait(timeout=2)
            except Exception:
                pass
            self._proc = None

    def _open(self, start_frame: int):
        self._close()
        cmd = ["ffmpeg", "-v", "error"]
        if start_frame > 0:
            cmd += ["-ss", f"{start_frame / self.fps:.6f}"]
        cmd += [
            "-i", self.path,
            "-an", "-sn", "-f", "rawvideo", "-pix_fmt", "yuv444p",
            "pipe:1",
        ]
        self._proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=self._frame_bytes * 2,
        )
        self._next = start_frame

    def _read_exact(self, n: int) -> bytes | None:
        buf = bytearray()
        while len(buf) < n:
            chunk = self._proc.stdout.read(n - len(buf))
            if not chunk:
                return None
            buf.extend(chunk)
        return bytes(buf)

    # -- 接口 ----------------------------------------------------------
    def frame(self, i: int):
        if self.n_frames:
            i = max(0, min(i, self.n_frames - 1))
        if self._proc is None or i < self._next:
            self._open(i)
        while self._next < i:  # 向前丢弃
            if self._read_exact(self._frame_bytes) is None:
                self._close()
                self._open(i)
                break
            self._next += 1
        raw = self._read_exact(self._frame_bytes)
        if raw is None:  # EOF：重开一次，仍失败则报错
            self._close()
            self._open(i)
            raw = self._read_exact(self._frame_bytes)
            if raw is None:
                raise EOFError(f"无法读取第 {i} 帧")
        self._next = i + 1
        w, h = self.width, self.height
        a = np.frombuffer(raw, dtype=np.uint8)
        Y = a[: w * h].reshape(h, w).copy()
        U = a[w * h: 2 * w * h].reshape(h, w).copy()
        V = a[2 * w * h:].reshape(h, w).copy()
        return Y, U, V

    def close(self):
        self._close()


# ---------------------------------------------------------------- 内置合成样片

class SyntheticSource:
    """内置样片：彩条 / 偏蓝灰阶 / 局部溢出。声明为有限范围。"""

    KINDS = ("bars", "blueramp", "overflow")
    TITLES = {
        "bars": "内置彩条 (SMPTE 75%)",
        "blueramp": "样片：偏蓝灰阶",
        "overflow": "样片：局部溢出",
    }

    def __init__(self, kind: str, width=640, height=360, fps=30.0, n_frames=120):
        assert kind in self.KINDS
        self.kind = kind
        self.width, self.height = width, height
        self.fps = fps
        self.n_frames = n_frames
        self.declared_range = "tv"
        self.title = self.TITLES[kind]

    def frame(self, i: int):
        i = max(0, min(i, self.n_frames - 1))
        R, G, B = getattr(self, f"_rgb_{self.kind}")(i)
        return rgb_to_yuv_u8(R, G, B, "tv")

    # -- 各样片（RGB uint8） ------------------------------------------
    def _rgb_bars(self, i):
        w, h = self.width, self.height
        # SMPTE 75% 彩条
        cols = [  # R,G,B (0-1)
            (0.75, 0.75, 0.75), (0.75, 0.75, 0.0), (0.0, 0.75, 0.75),
            (0.0, 0.75, 0.0), (0.75, 0.0, 0.75), (0.75, 0.0, 0.0),
            (0.0, 0.0, 0.75),
        ]
        img = np.zeros((h, w, 3), np.float32)
        bw = w / len(cols)
        for k, c in enumerate(cols):
            img[:, int(k * bw): int((k + 1) * bw)] = c
        # 底部加一行 0%/50%/100% 灰块，便于看暗部/亮部边界
        img[int(h * 0.8):, : w // 3] = 0.0
        img[int(h * 0.8):, w // 3: 2 * w // 3] = 0.5
        img[int(h * 0.8):, 2 * w // 3:] = 1.0
        # 一个移动的黑色小方块，让播放/逐帧有可观察的变化
        s = h // 6
        x = int((i * 7) % max(1, (w - s)))
        y = int((i * 3) % max(1, (h - s)))
        img[y: y + s, x: x + s] = 0.0
        return _split(img)

    def _rgb_blueramp(self, i):
        w, h = self.width, self.height
        ramp = np.linspace(0.0, 1.0, w, dtype=np.float32)[None, :].repeat(h, 0)
        # 蓝通道整体抬高并随时间轻微摆动 —— 整体偏色而非局部溢出
        lift = 0.10 + 0.04 * np.sin(i / 15.0)
        r = ramp
        g = ramp
        b = np.clip(ramp + lift, 0.0, 1.0)
        # 上半部分灰阶，下半部分纯色参考块
        img = np.stack([r, g, b], axis=-1)
        img[int(h * 0.75):, :] = (0.5, 0.5, 0.5 + lift)
        return _split(img)

    def _rgb_overflow(self, i):
        w, h = self.width, self.height
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        # 柔和背景渐变
        base = 0.25 + 0.35 * (xx / w) + 0.1 * np.sin(yy / 40.0)
        img = np.stack([base, base * 0.95, base * 0.9], axis=-1)
        # 一个过曝“太阳”：中心亮度远超 1.0，clip 后整片顶在输出上限
        cx, cy = w * (0.3 + 0.4 * i / self.n_frames), h * 0.4
        rad = h * 0.28
        d2 = ((xx - cx) ** 2 + (yy - cy) ** 2) / (rad * rad)
        sun = np.clip(2.8 - 2.2 * d2, 0.0, None)  # 中心 ~2.8，远超 1.0
        img[..., 0] += sun
        img[..., 1] += sun * 0.9
        img[..., 2] += sun * 0.75
        # 左下角一块死黑区域（暗部压边界）
        img[int(h * 0.7):, : w // 8] = 0.0
        img = np.clip(img, 0.0, 1.0)
        return _split(img)

    def close(self):
        pass


def _split(img):
    a = np.clip(img * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return a[..., 0].copy(), a[..., 1].copy(), a[..., 2].copy()
