"""核心音频处理:WAV 读取、路由矩阵、极性、延时、峰值保护、量化导出。

约定:
- 采样率固定 48kHz,16 位整数 PCM,最多 6 声道,样例不超过 10 秒。
- 内部一律用 float64,取值范围 [-1.0, 1.0),即 int16 / 32768。
- 输出长度恒等于输入长度:延时在开头补静音,超出末尾的内容舍去。
- 处理是整段确定性渲染,与播放位置无关,同一设置结果永远一致。
"""
import wave

import numpy as np

SAMPLE_RATE = 48000
MAX_CHANNELS = 6
MAX_SECONDS = 10
MAX_DELAY = 960
INT16_FULL = 32768.0
INT16_MAX = 32767.0
FULL_SCALE = INT16_MAX / INT16_FULL  # 正满幅(16 位可表示的最大正值)


def read_wav(path):
    """读取 WAV,返回 (data, sample_rate),data 形状 (N, C),float64。"""
    with wave.open(path, "rb") as w:
        nch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise ValueError(f"仅支持 16 位整数 PCM,当前采样位宽为 {sw * 8} 位")
    if sr != SAMPLE_RATE:
        raise ValueError(f"仅支持 48kHz,当前为 {sr} Hz")
    if not 1 <= nch <= MAX_CHANNELS:
        raise ValueError(f"声道数须为 1-{MAX_CHANNELS},当前为 {nch}")
    if n > SAMPLE_RATE * MAX_SECONDS:
        raise ValueError(
            f"样例长度不能超过 {MAX_SECONDS} 秒,当前 {n / SAMPLE_RATE:.2f} 秒"
        )
    data = np.frombuffer(raw, dtype="<i2")
    data = data.reshape(-1, nch).astype(np.float64) / INT16_FULL
    return data, sr


def quantize(data):
    """float [-1,1) -> int16,四舍五入并截断到可表示范围。"""
    return np.clip(np.rint(data * INT16_FULL), -INT16_FULL, INT16_MAX).astype("<i2")


def write_wav(path, data):
    """写出 48kHz/16bit PCM WAV,data 形状 (N, C)。返回量化后的 int16 数组。"""
    data = np.asarray(data, dtype=np.float64)
    if data.ndim == 1:
        data = data[:, None]
    q = quantize(data)
    with wave.open(path, "wb") as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(q.tobytes())
    return q


def _delay(sig, d):
    """正延时 d 个采样:开头补 d 个静音,末尾舍去 d 个采样,长度不变。"""
    d = int(d)
    if d <= 0:
        return sig
    n = len(sig)
    out = np.zeros(n)
    if d < n:
        out[d:] = sig[: n - d]
    return out


def process(samples, channels, protect=False):
    """按路由矩阵/极性/延时合成立体声。

    samples: (N, C) float64
    channels: 长度为 C 的列表,每项:
        {"invert": bool, "delay": int,
         "L": {"on": bool, "gain": 0..1}, "R": {"on": bool, "gain": 0..1}}
    protect: 峰值保护开关。开启时若峰值超过满幅,整体统一衰减
             (左右乘同一个系数,相对电平不变),保证不削波。

    返回 (out, info),out 形状 (N, 2);info 含保护前后各侧峰值与衰减量。
    """
    samples = np.asarray(samples, dtype=np.float64)
    n, c = samples.shape
    out = np.zeros((n, 2))
    for i in range(min(c, len(channels))):
        cfg = channels[i]
        sig = samples[:, i]
        if cfg.get("invert"):
            sig = -sig
        sig = _delay(sig, cfg.get("delay", 0))
        for side, col in (("L", 0), ("R", 1)):
            link = cfg.get(side) or {}
            gain = float(link.get("gain", 0.0))
            if link.get("on") and gain != 0.0:
                out[:, col] += gain * sig
    pre_l = float(np.abs(out[:, 0]).max()) if n else 0.0
    pre_r = float(np.abs(out[:, 1]).max()) if n else 0.0
    peak_pre = max(pre_l, pre_r)
    atten = 1.0
    if protect and peak_pre > FULL_SCALE:
        atten = FULL_SCALE / peak_pre
        out = out * atten
    post_l = float(np.abs(out[:, 0]).max()) if n else 0.0
    post_r = float(np.abs(out[:, 1]).max()) if n else 0.0
    info = {
        "peak_pre_l": pre_l,
        "peak_pre_r": pre_r,
        "peak_pre": peak_pre,
        "atten": atten,
        "atten_db": 20.0 * float(np.log10(atten)) if atten > 0 else float("-inf"),
        "peak_post_l": post_l,
        "peak_post_r": post_r,
        "peak_post": max(post_l, post_r),
        "clipping": peak_pre > FULL_SCALE,
    }
    return out, info


def correlation(left, right):
    """左右声道皮尔逊相关系数。任一侧静音/直流(无有效变化)时返回 None。"""
    left = np.asarray(left, dtype=np.float64)
    right = np.asarray(right, dtype=np.float64)
    if left.size == 0 or left.std() == 0.0 or right.std() == 0.0:
        return None
    return float(np.corrcoef(left, right)[0, 1])
