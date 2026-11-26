"""本地数值校验: 正左/正右、转半圈、转一圈回到原状态、跨界方向、能量与电平。

全部为纯 numpy 计算, 不依赖 GUI, 可直接在测试中调用。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .dsp import (
    IDX_W,
    IDX_X,
    IDX_Y,
    DIR_CCW,
    DIR_CW,
    YawMarkers,
    decode_stereo,
    fuma_to_ambix,
    intensity_azimuth,
    level_db,
    plane_wave,
    render_stereo,
    rotate_yaw,
)


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str


def _power(x: np.ndarray) -> float:
    return float(np.mean(np.asarray(x) ** 2))


def run_all_checks(sr: int = 48000) -> list[CheckResult]:
    results: list[CheckResult] = []
    rng = np.random.default_rng(7)
    n = sr // 2
    sig = rng.standard_normal(n) * 0.5

    # 1. 正左(+90°): 解码后能量主要落在 L
    b_l = plane_wave(90.0, sig)
    st = decode_stereo(b_l, 90.0)
    pl, pr = _power(st[:, 0]), _power(st[:, 1])
    ok = pl > 4 * pr and pr < 1e-6
    results.append(CheckResult(
        "正左 (+90°) 声像落左声道", ok,
        f"L 功率={pl:.4e}, R 功率={pr:.4e}, L/R={pl / max(pr, 1e-30):.1f} 倍"))

    # 2. 正右(-90°): 解码后能量主要落在 R
    b_r = plane_wave(-90.0, sig)
    st = decode_stereo(b_r, 90.0)
    pl, pr = _power(st[:, 0]), _power(st[:, 1])
    ok = pr > 4 * pl and pl < 1e-6
    results.append(CheckResult(
        "正右 (-90°) 声像落右声道", ok,
        f"L 功率={pl:.4e}, R 功率={pr:.4e}, R/L={pr / max(pl, 1e-30):.1f} 倍"))

    # 3. 转半圈: +90° 声源经 yaw=180° 旋转后表观方位为 -90°, 声像由左翻右
    rot = rotate_yaw(b_l, math.radians(180.0))
    az = intensity_azimuth(rot)
    st = decode_stereo(rot, 90.0)
    pl, pr = _power(st[:, 0]), _power(st[:, 1])
    ok = az is not None and abs(math.degrees(az) - (-90.0)) < 0.5 and pr > 4 * pl
    results.append(CheckResult(
        "转半圈 (yaw=180°): 左源变右侧", ok,
        f"旋转后强度方位={math.degrees(az):.2f}° (期望 -90°), L={pl:.3e}, R={pr:.3e}"))

    # 4. 转一圈回到同一状态: yaw=360° 与 yaw=0 数值严格一致
    b = plane_wave(37.0, sig)
    full = rotate_yaw(b, math.radians(360.0))
    err = float(np.max(np.abs(full - b)))
    results.append(CheckResult(
        "转一圈回到同一状态 (360° ≡ 0°)", err < 1e-12,
        f"最大通道偏差={err:.2e}"))

    # 5. 经过 0/360 刻度起点按选定方向走, 不反绕; 整圈标记不被取模吞掉
    mk = YawMarkers(markers=[(0.0, 350.0), (1.0, 10.0)], direction=DIR_CCW)
    ok_ccw = abs(mk.yaw_at(0.5) - 0.0) < 1e-9       # +20° 跨 0, 中点 0
    mk_cw = YawMarkers(markers=[(0.0, 10.0), (1.0, 350.0)], direction=DIR_CW)
    ok_cw = abs(mk_cw.yaw_at(0.5) - 0.0) < 1e-9     # -20° 跨 0, 中点 0
    mk_full = YawMarkers(markers=[(0.0, 0.0), (2.0, 360.0)], direction=DIR_CCW)
    ok_full = abs(mk_full.yaw_at(1.0) - 180.0) < 1e-9
    results.append(CheckResult(
        "刻度跨界不反绕 + 整圈标记有效 (CCW/CW)",
        ok_ccw and ok_cw and ok_full,
        f"CCW 350→10 中点={mk.yaw_at(0.5):.1f}°, "
        f"CW 10→350 中点={mk_cw.yaw_at(0.5):.1f}°, "
        f"0→360 中点={mk_full.yaw_at(1.0):.1f}° (均期望 0/0/180)"))

    # 6. 全向/指向分量试听与电平: W 分量旋转不变; 指向分量 W=0; 电平 dB 正确
    b2 = rotate_yaw(b, math.radians(123.0))
    w_err = float(np.max(np.abs(b2[:, IDX_W] - b[:, IDX_W])))
    omni = decode_stereo(b2, 90.0, "omni")
    rms_db, peak_db = level_db(omni[:, 0])
    expect_rms = 20 * math.log10(math.sqrt(_power(omni[:, 0])))
    ok = w_err < 1e-12 and abs(rms_db - expect_rms) < 1e-6
    dir_only = decode_stereo(b2, 90.0, "directional")
    ok = ok and _power(dir_only) > 0
    results.append(CheckResult(
        "全向/指向分量与电平计量正确", ok,
        f"W 旋转偏差={w_err:.1e}, L(RMS)={rms_db:.2f} dBFS, 指向分量功率={_power(dir_only):.3e}"))

    # 7. 导出确定性: 同一参数两次渲染一致, 且不受其他渲染调用影响
    r1 = render_stereo(b, sr, speaker_angle_deg=60.0, fixed_yaw_deg=30.0,
                       start_time=0.1, end_time=0.4, lr_flip=False)
    r2 = render_stereo(b, sr, speaker_angle_deg=60.0, fixed_yaw_deg=30.0,
                       start_time=0.1, end_time=0.4, lr_flip=True)
    r3 = render_stereo(b, sr, speaker_angle_deg=60.0, fixed_yaw_deg=30.0,
                       start_time=0.1, end_time=0.4, lr_flip=False)
    flip_ok = np.allclose(r1[:, [1, 0]], r2) and np.allclose(r1, r3)
    frames_ok = r1.shape[0] == int(round(0.3 * sr))
    results.append(CheckResult(
        "导出确定性与左右声道顺序可回读", flip_ok and frames_ok,
        f"渲染帧数={r1.shape[0]} (期望 {int(round(0.3 * sr))}), "
        f"翻转/重复渲染一致={flip_ok}"))

    # 8. FuMa -> AmbiX 往返: 转换后方位估计不变
    fuma = np.empty_like(b)
    fuma[:, 0] = b[:, IDX_W] / math.sqrt(2.0)
    fuma[:, 1] = b[:, IDX_X] / math.sqrt(3.0)
    fuma[:, 2] = b[:, IDX_Y] / math.sqrt(3.0)
    fuma[:, 3] = 0.0
    back = fuma_to_ambix(fuma)
    conv_err = float(np.max(np.abs(back - b)))
    results.append(CheckResult(
        "FuMa→AmbiX 通道与增益换算", conv_err < 1e-12,
        f"最大偏差={conv_err:.1e}"))

    return results


CHANNEL_EXPLANATION = [
    ("W (ACN 0)", "全向分量, 等效声压麦克风, 与方向无关; FuMa 中需除以 √2 才等于这里的 SN3D W。"),
    ("Y (ACN 1)", "8 字形指向, 正瓣朝左(+Y); 左声源为正、右声源为负, 前后声源为零。"),
    ("Z (ACN 2)", "8 字形指向, 正瓣朝上; 水平声源恒为 0, 水平旋转中保持不变。"),
    ("X (ACN 3)", "8 字形指向, 正瓣朝前(+X); 前声源为正、后声源为负, 左右声源为零。"),
]


DECODER_EXPLANATION = (
    "立体声采用虚拟扬声器投影解码: 扬声器位于头部 yaw±φ 方向(φ 可调), "
    "每路增益 0.5·W + 1/(2√3)·(Y·sinφ_s + X·cosφ_s), "
    "对单位平面波等于 0.5·(1+cos(θ-φ_s)), 因此正左声源在右扬声器输出为 0。"
)
