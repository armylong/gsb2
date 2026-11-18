"""动态压缩 DSP 核心。

口径声明（界面与 README 与本实现保持一致）：

* 峰值检测：逐采样检测。立体声取左右通道瞬时峰值的较大值（link，共同增益），
  不做左右独立压缩，避免声像漂移。
* 硬拐点：门限 threshold_db 以上按 ratio 收窄，门限以下不产生衰减。
* 目标增益衰减（dB，正数表示衰减量）::

      gr_target = max(0, (envelope_db - threshold_db) * (1 - 1 / ratio))

  ratio == 1 时 gr_target 恒为 0，即不压缩。
* 平滑只做一次，是 dB 域峰值跟随器（peak follower，attack/release
  分支），这是峰值检测器的经典结构：
  - 检测峰值 >= 当前包络（新峰值、衰减需加深）：按一阶 RC 的
    attack 系数向检测峰值爬升，env += a_att*(det-env)；
  - 检测峰值 < 当前包络：进入峰值保持，按固定每样本 dB 量释放
    env -= a_rel，不追随正弦过零点，稳态包络稳定等于信号峰值。
  系数按一阶 RC 口径换算 coeff = 1 - exp(-1 / (fs * t_seconds))。
  向上电平阶跃后经过一个 attack 时间，包络与目标的 dB 差距缩小到
  初始差距的 1/e (≈36.8%)；向下阶跃的恢复是 dB 线性下行，其每样本
  释放量等于同一 coeff（测试在长时段电平阶跃上按此口径验证）。
  增益衰减由包络按硬拐点逐点直接算出，不再二次平滑，听到的衰减与
  显示曲线一致。
* 无前视、无自动补偿；补偿增益 makeup_db 是线性后级固定增益。
* 静音：仅当线性振幅严格为 0（真正的数字静音，而非正弦过零点）时，
  dB 记为 -inf。检测器对单个零样本不清空保持值（避免把两段信号
  拼接处的过零点误判为静音），只有连续零样本超过 5ms 才确认为
  真静音段并把包络清回 -inf、衰减清回 0，不产生 NaN 等无效数值。
  从静音进入有信号时按 attack 重新爬升。
"""

from __future__ import annotations

import ctypes
from dataclasses import dataclass

import numpy as np

from . import _native


def _native_lib():
    """延迟加载 C 加速；任何异常都回退纯 Python，保证可运行。"""
    try:
        return _native.get_lib()
    except Exception:  # pragma: no cover - 环境无编译器时
        return None

# 数值口径：低于该 dB 值的样本视为静音，用 -inf 表示
SILENCE_DB = -200.0
EPS_LINEAR = 10.0 ** (SILENCE_DB / 20.0)


def amp_to_db(x: np.ndarray) -> np.ndarray:
    """线性振幅 -> dBFS；严格为 0 的位置得到 -inf（静音）。"""
    with np.errstate(divide="ignore"):
        db = 20.0 * np.log10(np.maximum(np.asarray(x, dtype=np.float64), 0.0))
    return db


def db_to_amp(db: np.ndarray) -> np.ndarray:
    """dBFS -> 线性振幅；-inf 位置得到 0。"""
    return np.power(10.0, np.asarray(db, dtype=np.float64) / 20.0)


def time_constant_coeff(fs: int, t_seconds: float) -> float:
    """一阶 RC 口径：t 秒为一个时间常数 tau。"""
    t = max(float(t_seconds), 1.0e-6)
    return float(1.0 - np.exp(-1.0 / (fs * t)))


def linked_peak_db(x: np.ndarray) -> np.ndarray:
    """逐采样 link 峰值（dB）。

    Parameters
    ----------
    x : (n,) 或 (n, ch) float 数组，振幅范围 [-1, 1] 附近。
    """
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        peak = np.abs(x)
    else:
        peak = np.max(np.abs(x), axis=1)
    db = amp_to_db(peak)
    # 只有严格为 0 的样本才算数字静音（-inf）；正弦过零点不受影响
    db[peak == 0.0] = -np.inf
    return db


def smooth_envelope(det_db: np.ndarray, fs: int, attack_s: float,
                    release_s: float,
                    silence_hold_ms: float = 5.0) -> np.ndarray:
    """峰值保持 / 独立释放检测器（dB 域标量状态机）。

    维护保持电平 ``held``，逐样本更新：

    * 检测峰值 >= held：出现新峰值，held 按一阶 RC 的 attack 系数向
      检测峰值爬升 ``held += a_att*(det-held)``；
    * 检测峰值 < held：held 以固定每样本 dB 量独立释放
      ``held -= a_rel``，不追随正弦过零点；在它衰减到低于新的信号
      峰值前，周期波峰不会把它拉回（峰值保持），因此稳态正弦的
      包络稳定等于信号峰值、无纹波。

    数字静音：单个零样本（如两段正弦拼接处的过零点）不清空保持值，
    仍按 release 释放；只有连续零样本超过 ``silence_hold_ms`` 才判定
    为真静音段，held 立即回 -inf，保证静音段不保留悬空数值、无 NaN。

    系数按一阶 RC 口径：``coeff = 1 - exp(-1/(fs*t))``。向上电平
    阶跃后经过一个 attack 时间，held 与目标的 dB 差距走完 1-1/e；
    向下阶跃后 held 以 a_rel dB/样本线性下行。
    起始为静音 -inf，文件开头的真实信号按 attack 爬升。
    """
    n = det_db.shape[0]
    a_att = time_constant_coeff(fs, attack_s)
    a_rel = time_constant_coeff(fs, release_s)
    zero_limit = max(1, int(round(silence_hold_ms / 1000.0 * fs)))

    env = np.empty(n, dtype=np.float64)
    lib = _native_lib()
    if lib is not None:
        det_c = np.ascontiguousarray(det_db, dtype=np.float64)
        out_c = np.empty(n, dtype=np.float64)
        ptr = ctypes.POINTER(ctypes.c_double)
        lib.peak_follower(
            det_c.ctypes.data_as(ptr), out_c.ctypes.data_as(ptr),
            ctypes.c_long(n), ctypes.c_double(a_att),
            ctypes.c_double(a_rel), ctypes.c_long(zero_limit))
        return out_c

    held = -np.inf
    zero_run = 0
    for i in range(n):
        d = det_db[i]
        if np.isneginf(d):
            zero_run += 1
            if np.isneginf(held):
                env[i] = -np.inf
                continue
            held -= a_rel  # 瞬时零样本：照常释放，不清空
            env[i] = held
            if zero_run >= zero_limit:  # 连续静音 => 真静音段
                held = -np.inf
                env[i] = -np.inf
            continue
        zero_run = 0
        if np.isneginf(held):
            held = d
        elif d >= held:
            held += a_att * (d - held)
        else:
            held -= a_rel
        env[i] = held
    return env


def target_gain_reduction(env_db: np.ndarray, threshold_db: float,
                          ratio: float) -> np.ndarray:
    """硬拐点衰减量（dB，>=0），由平滑后包络逐点直接计算。

    ratio==1 时恒为 0；门限以下与静音（-inf）位置均为 0 衰减。
    """
    if ratio <= 1.0:
        return np.zeros_like(env_db, dtype=np.float64)
    over = env_db - threshold_db
    gr = (1.0 - 1.0 / ratio) * over
    # 静音（-inf）与门限以下均为 0 衰减
    gr = np.where(np.isfinite(gr), gr, 0.0)
    return np.maximum(gr, 0.0)


@dataclass
class CompressorParams:
    threshold_db: float = -18.0
    ratio: float = 4.0
    attack_ms: float = 10.0
    release_ms: float = 150.0
    makeup_db: float = 0.0


@dataclass
class ProcessResult:
    """一次完整压缩处理的全部结果（同长度、同采样率）。"""

    input: np.ndarray          # (n,) 或 (n, ch)
    output: np.ndarray         # 形状与 input 相同
    detected_db: np.ndarray    # 逐采样 link 峰值检测，dBFS，静音为 -inf
    envelope_db: np.ndarray    # 平滑后检测包络，dBFS
    gain_reduction_db: np.ndarray  # 平滑后衰减量，dB，>=0
    params: CompressorParams
    fs: int
    clipped: bool
    output_peak_db: float

    @property
    def n(self) -> int:
        return self.input.shape[0]

    @property
    def channels(self) -> int:
        return 1 if self.input.ndim == 1 else self.input.shape[1]


def process(x: np.ndarray, fs: int, params: CompressorParams) -> ProcessResult:
    """对单条音频做完整压缩处理。

    流程：link 峰值检测 -> dB 包络 attack/release 平滑（唯一一次平滑）->
    硬拐点衰减量（逐点直接计算）-> 线性增益 -> 固定补偿增益。
    输出长度/采样率与输入一致。
    """
    x = np.asarray(x, dtype=np.float64)
    if fs not in (44100, 48000):
        raise ValueError(f"仅支持 44.1kHz / 48kHz，收到 {fs} Hz")

    attack_s = params.attack_ms / 1000.0
    release_s = params.release_ms / 1000.0

    detected = linked_peak_db(x)
    envelope = smooth_envelope(detected, fs, attack_s, release_s)
    gr = target_gain_reduction(envelope, params.threshold_db, params.ratio)

    # 实际施加的线性增益（衰减 + 固定补偿），立体声两侧同一条增益曲线
    gain_db = -gr + params.makeup_db
    gain_lin = db_to_amp(gain_db)
    if x.ndim == 1:
        output = x * gain_lin
    else:
        output = x * gain_lin[:, None]

    out_peak = float(np.max(np.abs(output))) if output.size else 0.0
    out_peak_db = float(amp_to_db(np.array(max(out_peak, EPS_LINEAR))))
    clipped = out_peak > 1.0

    return ProcessResult(
        input=x,
        output=output,
        detected_db=detected,
        envelope_db=envelope,
        gain_reduction_db=gr,
        params=params,
        fs=fs,
        clipped=clipped,
        output_peak_db=out_peak_db,
    )
