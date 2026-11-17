"""旁白驱动音乐自动闪避核心引擎。

预览与导出共用同一套函数，保证两者结果一致：
  detect_speech   能量法语音段检测(VAD)
  merge_segments  短停顿合并
  build_gain_curve 生成作用在音乐上的逐样本增益曲线
  process         应用闪避 + 叠加旁白 + 峰值保护
"""
import numpy as np

EPS = 1e-12


# ---------------- 读写 ----------------

def load_wav(path):
    """返回 (float32 [-1,1] 数组, 采样率)。单声道返回 (n,)，多声道 (n, ch)。"""
    import soundfile as sf
    data, sr = sf.read(path, dtype='float32', always_2d=False)
    return data, sr


def write_wav(path, data, sr):
    """写 16-bit PCM WAV。"""
    import soundfile as sf
    sf.write(path, np.asarray(data, dtype=np.float32), sr,
             subtype='PCM_16', format='WAV')


def to_mono(x):
    return x if x.ndim == 1 else x.mean(axis=1)


def to_stereo(x):
    if x.ndim == 1:
        return np.stack([x, x], axis=1)
    if x.shape[1] == 1:
        return np.repeat(x, 2, axis=1)
    return x[:, :2]


def resample_linear(x, sr_from, sr_to):
    """简单线性重采样（仅在两轨采样率不一致时对音乐使用）。"""
    if sr_from == sr_to:
        return x
    n_new = int(round(len(x) * sr_to / sr_from))
    t_old = np.arange(len(x)) / sr_from
    t_new = np.arange(n_new) / sr_to
    if x.ndim == 1:
        return np.interp(t_new, t_old, x).astype(np.float32)
    return np.stack([np.interp(t_new, t_old, x[:, c])
                     for c in range(x.shape[1])], axis=1).astype(np.float32)


# ---------------- 语音段检测 ----------------

def frame_rms(x, sr, frame_ms=25.0, hop_ms=10.0):
    fl = max(1, int(sr * frame_ms / 1000))
    hl = max(1, int(sr * hop_ms / 1000))
    n_frames = max(1, 1 + (len(x) - fl) // hl) if len(x) >= fl else 1
    rms = np.empty(n_frames, dtype=np.float64)
    for i in range(n_frames):
        seg = x[i * hl: i * hl + fl]
        rms[i] = np.sqrt(np.mean(seg ** 2) + EPS) if len(seg) else 0.0
    times = (np.arange(n_frames) * hl + fl / 2) / sr
    return times, rms


def detect_speech(x, sr, thresh_offset_db=12.0, abs_floor_db=-45.0,
                  min_dur_ms=120.0, hangover_ms=350.0):
    """能量法 VAD。返回 [(start_s, end_s), ...]，按时间排序、互不重叠。

    阈值 = max(底噪分位 + thresh_offset_db, abs_floor_db)。
    """
    x = to_mono(np.asarray(x, dtype=np.float64))
    hop_ms = 10.0
    times, rms = frame_rms(x, sr)
    db = 20 * np.log10(rms + EPS)
    noise = np.percentile(db, 20)
    thresh = max(noise + thresh_offset_db, abs_floor_db)
    speech = db > thresh

    # 滞后：语音帧之后 hangover 内仍算语音
    hang = int(round(hangover_ms / hop_ms))
    if hang > 0:
        ext = speech.copy()
        c = 0
        for i in range(len(speech)):
            if speech[i]:
                c = hang
            elif c > 0:
                ext[i] = True
                c -= 1
        speech = ext

    segs = []
    i = 0
    n = len(speech)
    while i < n:
        if speech[i]:
            j = i
            while j < n and speech[j]:
                j += 1
            segs.append([times[i], times[j - 1]])
            i = j
        else:
            i += 1

    # 过滤过短段
    min_d = min_dur_ms / 1000.0
    segs = [s for s in segs if s[1] - s[0] >= min_d]
    # 段边界裁剪到音频范围
    dur = len(x) / sr
    return [(max(0.0, s), min(dur, e)) for s, e in segs if e > s]


def merge_segments(segs, gap_s):
    """间隔 <= gap_s 的相邻段合并为一段。"""
    segs = sorted((float(s), float(e)) for s, e in segs)
    if not segs:
        return []
    out = [list(segs[0])]
    for s, e in segs[1:]:
        if s - out[-1][1] <= gap_s:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


# ---------------- 增益曲线 ----------------

def build_gain_curve(n_samples, sr, segs, duck_db=-12.0,
                     lookahead_ms=300.0, release_ms=600.0):
    """生成逐样本音乐增益曲线（1.0 = 不压，duck = 全压）。

    每段语音 [s, e]：
      - 从 s - lookahead 开始余弦下坡，恰好在 s 到达全压（提前压低）；
      - [s, e] 保持全压；
      - 从 e 开始余弦上坡，release 后回到 1（自然恢复）。
    语音从 0 开始时曲线起点即为全压；语音到结尾时保持全压到末尾。
    多段之间取最小值，重叠区域依然连续无爆音。
    """
    duck = float(10 ** (duck_db / 20.0))
    gain = np.ones(n_samples, dtype=np.float64)
    look = int(round(lookahead_ms / 1000.0 * sr))
    rel = int(round(release_ms / 1000.0 * sr))
    min_ramp = max(1, int(0.005 * sr))  # 至少 5ms，防止 0 参数产生爆音

    for s, e in segs:
        si = int(round(s * sr))
        ei = int(round(e * sr))
        si = max(0, min(n_samples, si))
        ei = max(si, min(n_samples, ei))

        down_len = min(look, si)  # 语音太靠近开头时缩短下坡
        if si == 0:
            down_len = 0
        elif down_len < min_ramp:
            down_len = min(min_ramp, si)
        d0 = si - down_len

        up_len = rel if ei < n_samples else 0
        if up_len > 0:
            up_len = max(up_len, min_ramp)
        u1 = min(n_samples, ei + up_len)

        env = np.ones(u1 - d0, dtype=np.float64)
        # 下坡：d0..si
        if down_len > 0:
            t = np.arange(down_len) / down_len
            env[:down_len] = duck + (1 - duck) * 0.5 * (1 + np.cos(np.pi * t))
        # 平台：si..ei
        env[down_len: ei - d0] = duck
        # 上坡：ei..u1
        if u1 > ei:
            t = np.arange(u1 - ei) / (u1 - ei)
            env[ei - d0:] = duck + (1 - duck) * 0.5 * (1 - np.cos(np.pi * t))
        gain[d0:u1] = np.minimum(gain[d0:u1], env)
    return gain


# ---------------- 处理 ----------------

DEFAULTS = dict(duck_db=-12.0, lookahead_ms=300.0,
                release_ms=600.0, merge_gap_ms=400.0)
CEILING = 0.98  # 峰值保护上限（约 -0.18 dBFS）


def process(music, narration, sr, segs, params):
    """music: (n,2) float；narration: (n,) float。返回 dict。"""
    p = dict(DEFAULTS)
    p.update(params or {})
    n = len(narration)
    music = to_stereo(np.asarray(music, dtype=np.float64))
    if len(music) >= n:
        music = music[:n]
    else:  # 音乐不足时补零（规格要求等长或更长，这里兜底）
        pad = np.zeros((n - len(music), 2))
        music = np.vstack([music, pad])
    narration = np.asarray(narration, dtype=np.float64)

    merged = merge_segments(segs, p['merge_gap_ms'] / 1000.0)
    gain = build_gain_curve(n, sr, merged, p['duck_db'],
                            p['lookahead_ms'], p['release_ms'])
    ducked = music * gain[:, None]
    mix = ducked + narration[:, None]  # 旁白不被压低

    peak = float(np.max(np.abs(mix))) if n else 0.0
    triggered = peak > CEILING
    protect = CEILING / peak if triggered else 1.0
    out = mix * protect
    final_peak = float(np.max(np.abs(out))) if n else 0.0

    return dict(
        out=out.astype(np.float32),
        gain=gain,
        merged=merged,
        peak=peak,
        protection_triggered=bool(triggered),
        protection_gain_db=float(20 * np.log10(protect)) if triggered else 0.0,
        final_peak=final_peak,
        final_peak_db=float(20 * np.log10(final_peak + EPS)),
        n_samples=n,
        sr=sr,
    )


def downsample_curve(gain, points=1500):
    """增益曲线抽稀成前端绘图用点列。"""
    if len(gain) <= points:
        return gain.tolist()
    idx = np.linspace(0, len(gain) - 1, points).astype(int)
    return gain[idx].tolist()


def waveform_peaks(x, points=1500):
    """波形 min/max 抽稀，返回 [[min, max], ...]。"""
    x = to_mono(np.asarray(x, dtype=np.float64))
    if len(x) == 0:
        return []
    points = min(points, len(x))
    edges = np.linspace(0, len(x), points + 1).astype(int)
    out = []
    for i in range(points):
        seg = x[edges[i]:edges[i + 1]]
        if len(seg):
            out.append([float(seg.min()), float(seg.max())])
        else:
            out.append([0.0, 0.0])
    return out
