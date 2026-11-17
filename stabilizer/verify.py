"""独立核验: 对防抖输出做像素级复测, 并与 ground_truth 对照。

本脚本会重新打开输出视频独立估计运动, 不读取防抖处理时的中间矩阵;
ground_truth.json 仅在本脚本中作为评分基准使用。
输出结构化 PASS/FAIL 报告, 任一硬性检查失败则退出码为 1。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np
from scipy.io import wavfile

from . import geometry as geom
from . import pipeline
from .media import probe
from .motion import estimate_motions, validate_cuts

BAND = 2                        # 黑边检查只看最外圈像素
CAPTION_BOX = (0, 0, 300, 60)   # 样例自带的帧号字幕区, 不计入黑边
BLACK_LIMIT = 8
BLACK_RATIO_LIMIT = 0.02
JITTER_REDUCTION_MIN = 0.60     # 高频残余抖动至少降低 60%
PAN_RETENTION_MIN = 0.60        # 缓慢运镜至少保留 60%
FREEZE_RATIO_MAX = 0.25         # 输出低频位移不得小于参考的该比例
CUT_TOL = 2                     # 切点检测容差帧
EDGE_CORRECTION_TX = 15.0       # 镜头首帧校正量容差(px)
EDGE_CORRECTION_ANGLE = 0.5     # 度
ZOOM_SHOT_DIFF_MAX = 0.15


class Report:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def check(self, name: str, ok: bool, detail: str) -> None:
        self.rows.append({"check": name, "ok": bool(ok), "detail": detail})

    @property
    def passed(self) -> bool:
        return all(r["ok"] for r in self.rows)

    def print(self) -> None:
        width = max(len(r["check"]) for r in self.rows)
        for r in self.rows:
            tag = "PASS" if r["ok"] else "FAIL"
            print(f"[{tag}] {r['check'].ljust(width)}  {r['detail']}")
        n_fail = sum(not r["ok"] for r in self.rows)
        print(f"\n合计 {len(self.rows)} 项, 失败 {n_fail} 项 -> "
              f"{'全部通过' if self.passed else '存在失败项'}")


def _read_all(path: str) -> np.ndarray:
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        frames.append(fr)
    cap.release()
    return np.stack(frames)


def _cumulative_paths(affines: np.ndarray, starts: list[int], n: int
                      ) -> dict[str, np.ndarray]:
    M = np.zeros((n, 3, 3))
    bounds = starts + [n]
    for s, e in zip(bounds[:-1], bounds[1:]):
        acc = np.eye(3)
        M[s] = acc
        for i in range(s + 1, e):
            a = np.eye(3)
            a[:2, :] = affines[i]
            acc = acc @ a
            M[i] = acc
    return {
        "tx": M[:, 0, 2], "ty": M[:, 1, 2],
        "angle": np.degrees(np.arctan2(M[:, 1, 0], M[:, 0, 0])),
    }


def _detrend_rms(x: np.ndarray) -> float:
    t = np.arange(len(x))
    coef = np.polyfit(t, x, 1)
    return float(np.sqrt(np.mean((x - np.polyval(coef, t)) ** 2)))


def _span(x: np.ndarray) -> float:
    return float(np.ptp(x))


def black_border_ratio(frames: np.ndarray) -> float:
    """最外圈 2px 环带的近黑像素占比; 字幕角标区域剔除。"""
    h, w = frames.shape[1:3]
    gray = np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames])
    mask = np.zeros((h, w), bool)
    mask[:BAND, :] = True
    mask[-BAND:, :] = True
    mask[:, :BAND] = True
    mask[:, -BAND:] = True
    x1, y1, x2, y2 = CAPTION_BOX
    mask[y1:y2, x1:x2] = False
    border_vals = gray[:, mask]
    return float(np.mean(border_vals < BLACK_LIMIT))


def extract_wav(video: str, wav: str) -> None:
    res = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", video, "-ac", "1",
         "-ar", "44100", "-f", "wav", wav],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        raise RuntimeError(f"音频解码失败: {res.stderr[:200]}")


def verify(source: str, output: str, sidecar_path: str, gt_path: str) -> Report:
    rep = Report()
    sidecar = json.loads(Path(sidecar_path).read_text(encoding="utf-8"))
    gt = json.loads(Path(gt_path).read_text(encoding="utf-8"))
    src_info, out_info = probe(source), probe(output)
    n = src_info.frame_count

    # ---- 1. 容器/分辨率/帧率/帧数/时长 ----
    rep.check("输出分辨率与源一致",
              (out_info.width, out_info.height) == (src_info.width, src_info.height),
              f"src={src_info.width}x{src_info.height} "
              f"out={out_info.width}x{out_info.height}")
    rep.check("输出帧率与源一致", abs(out_info.fps - src_info.fps) < 0.02,
              f"src={src_info.fps:.3f} out={out_info.fps:.3f}")
    rep.check("输出帧数与源一致", out_info.frame_count == n,
              f"src={n} out={out_info.frame_count}")
    rep.check("输出时长与源一致",
              abs(out_info.duration - src_info.duration) < 0.05,
              f"src={src_info.duration:.3f}s out={out_info.duration:.3f}s")
    rep.check("sidecar 帧数条目完整",
              len(sidecar["frames"]) == n,
              f"sidecar={len(sidecar['frames'])} 期望={n}")

    # ---- 2. 独立重新读取输出全部帧 (重开核对) ----
    out_frames = _read_all(output)
    rep.check("可重开输出并顺序读全帧", len(out_frames) == n,
              f"实际读取 {len(out_frames)} 帧")
    cap = cv2.VideoCapture(output)
    cap.set(cv2.CAP_PROP_POS_FRAMES, n // 2)
    ok, mid = cap.read()
    cap.release()
    rep.check("可按帧定位重开输出", ok and mid.shape == out_frames[0].shape,
              f"定位帧 {n // 2} 读取 {'成功' if ok else '失败'}")

    # ---- 3. 黑边 ----
    ratio = black_border_ratio(out_frames)
    rep.check("输出无黑边", ratio < BLACK_RATIO_LIMIT,
              f"边缘近黑像素占比 {ratio:.4%} (阈值 {BLACK_RATIO_LIMIT:.2%})")

    # ---- 4. 独立运动估计: 源与输出 ----
    src_m = estimate_motions(source, n)
    out_m = estimate_motions(output, out_info.frame_count)
    cut_gt = gt["hard_cut_frame"]
    detect = src_m.auto_cuts
    hit = any(abs(c - cut_gt) <= CUT_TOL for c in detect)
    rep.check("自动硬切检测位置正确", hit,
              f"GT={cut_gt} 检测={detect} 容差±{CUT_TOL}")
    # 输出仍保留硬切 (画面内容确实切换), 但不应产生额外切点
    extra = [c for c in out_m.auto_cuts if abs(c - cut_gt) > CUT_TOL]
    rep.check("输出未引入额外异常切换", not extra, f"额外切点={extra}")

    cuts = sidecar["params"]["cut_frames"]
    rep.check("sidecar 切点与 GT 一致",
              any(abs(c - cut_gt) <= CUT_TOL for c in cuts)
              and validate_cuts(cuts, n) == cuts,
              f"sidecar cuts={cuts}")
    starts = [0] + cuts
    P_src = _cumulative_paths(src_m.affines, starts, n)
    P_out = _cumulative_paths(out_m.affines, starts, n)
    bounds = starts + [n]
    zooms = np.array([s["uniform_zoom"] for s in sidecar["shots"]])

    # ---- 5. 残余抖动 / 缓动保留, 分镜头统计 ----
    gt_by_shot = {0: gt["intentional_motion"]["shot0"],
                  1: gt["intentional_motion"]["shot1"]}
    for k, (s, e) in enumerate(zip(bounds[:-1], bounds[1:])):
        S = float(zooms[k])
        for key in ("tx", "ty", "angle"):
            e_src = _detrend_rms(P_src[key][s:e])
            e_out = _detrend_rms(P_out[key][s:e]) / (1.0 if key == "angle" else S)
            reduction = 1 - e_out / e_src if e_src > 1e-9 else 1.0
            rep.check(
                f"镜头{k} {key} 高频抖动降低>={JITTER_REDUCTION_MIN:.0%}",
                reduction >= JITTER_REDUCTION_MIN,
                f"源RMS={e_src:.3f} 输出RMS(归一化)={e_out:.3f} 降低={reduction:.1%}",
            )
        gtspan = gt_by_shot[k]
        span_map = {"tx": "tx_span_px", "ty": "ty_span_px",
                    "angle": "angle_span_deg"}
        for key, gtkey in span_map.items():
            ref = abs(gtspan[gtkey])
            if ref < 1e-9:
                continue
            norm = S if key != "angle" else 1.0
            kept = _span(P_out[key][s:e]) / norm / ref
            rep.check(
                f"镜头{k} {key} 缓动保留>={PAN_RETENTION_MIN:.0%}",
                kept >= PAN_RETENTION_MIN and kept <= 1.6,
                f"输出跨度={_span(P_out[key][s:e]) / norm:.2f} "
                f"参考={ref:.2f} 保留比={kept:.1%}",
            )
            # 防定格: 输出路径不能近似常量
            frozen = _span(P_out[key][s:e]) / norm < FREEZE_RATIO_MAX * ref
            rep.check(f"镜头{k} {key} 未被整段定格", not frozen,
                      f"输出跨度占参考比 "
                      f"{(_span(P_out[key][s:e]) / norm / ref):.1%}")

    # ---- 6. 硬切附近: 镜头首帧校正量与两镜头缩放差 ----
    for k, s in enumerate(starts):
        fr = sidecar["frames"][s]
        off = np.hypot(fr["path_smooth"]["tx"], fr["path_smooth"]["ty"])
        ang = abs(fr["path_smooth"]["angle"])
        rep.check(
            f"镜头{k} 首帧无跨镜头甩动",
            off <= EDGE_CORRECTION_TX and ang <= EDGE_CORRECTION_ANGLE,
            f"首帧平滑路径偏移={off:.2f}px 旋转={ang:.3f}°",
        )
    zoom_diff = abs(zooms[1] - zooms[0]) / max(zooms[0], 1e-9)
    rep.check("硬切两侧缩放无异常跳变", zoom_diff <= ZOOM_SHOT_DIFF_MAX,
              f"zoom 镜头0={zooms[0]:.4f} 镜头1={zooms[1]:.4f} 差异={zoom_diff:.2%}")

    # ---- 7. 裁切一致性: sidecar 数字自洽且与画面相符 ----
    for k, shot in enumerate(sidecar["shots"]):
        x1, y1, x2, y2 = shot["safe_crop_rect"]
        # safe_crop_rect 是输出帧坐标, 全帧填满即占满整帧;
        # 保留面积比应等于统一缩放平方的倒数 (源帧采样面积 / 源帧面积)
        area_ratio = ((x2 - x1) * (y2 - y1)
                      / (src_info.width * src_info.height))
        expect_retain = 1.0 / shot["uniform_zoom"] ** 2
        # 设计上安全框铺满整个输出帧 (缩放后的有效区域交集 >= 全帧)
        rep.check(
            f"镜头{k} 安全框面积比自洽",
            abs(area_ratio - 1.0) <= 0.03
            and abs(expect_retain - shot["retained_area_ratio"]) < 0.02
            and x1 <= 1.0 and y1 <= 1.0
            and x2 >= src_info.width - 1.0
            and y2 >= src_info.height - 1.0,
            f"框占输出={area_ratio:.4f} 1/zoom²={expect_retain:.4f} "
            f"记录保留={shot['retained_area_ratio']:.4f}",
        )
    # 抽样核对: sidecar 记录的有效四边形必须包住安全框
    for idx in range(0, n, 25):
        quad = np.array(sidecar["frames"][idx]["valid_quad"], np.float32)
        rect = np.array(sidecar["frames"][idx]["safe_crop_rect"], np.float32)
        # 安全框是缩放后坐标, 需除回缩放前再比较
        shot = sidecar["frames"][idx]["shot"]
        s_inv = 1.0 / zooms[shot]
        cx, cy = src_info.width / 2, src_info.height / 2
        pts = (rect.reshape(2, 2) - np.array([cx, cy])) * s_inv + np.array([cx, cy])
        inside = all(cv2.pointPolygonTest(quad, (float(x), float(y)), False) >= 0
                     for x, y in pts)
        if not inside:
            rep.check("安全框始终位于有效画面内", False, f"帧 {idx} 越界")
            break
    else:
        rep.check("安全框始终位于有效画面内", True,
                  f"抽样 {len(range(0, n, 25))} 帧全部通过")

    # ---- 7b. 预览/导出同源: 用 sidecar 参数重算, 数字必须与 sidecar 一致 ----
    cache = pipeline.analyze_video(source)
    sigma = float(sidecar["params"]["sigma_frames"])
    sc_cuts = validate_cuts(sidecar["params"]["cut_frames"], n)
    _, re_geo = pipeline.compute(cache, sc_cuts, sigma)
    max_quad_err = 0.0
    for idx in range(0, n, 10):
        recorded = np.array(sidecar["frames"][idx]["valid_quad"])
        max_quad_err = max(max_quad_err,
                           float(np.abs(recorded - re_geo.valid_quads[idx]).max()))
    zoom_match = np.allclose(re_geo.shot_zoom, zooms, rtol=0, atol=1e-3)
    rep.check(
        "sidecar 与重算几何一致(预览/导出同源)",
        max_quad_err < 0.05 and zoom_match,
        f"有效四边形最大偏差={max_quad_err:.4f}px, 缩放一致={zoom_match}",
    )

    # ---- 7c. 切点处累积矩阵确实重置为单位阵 (不跨镜头继承运动) ----
    starts = [0] + sc_cuts
    M_reset = geom.cumulative_matrices(cache.motions.affines, starts, n)
    reset_ok = all(np.allclose(M_reset[s], np.eye(3), atol=1e-9)
                   for s in sc_cuts)
    rep.check("硬切处运动累积已重置", reset_ok,
              f"切点 {sc_cuts} 的累积矩阵均为单位阵: {reset_ok}")

    # ---- 8. 音频: 解码后波形一致, 长度一致 ----
    if src_info.has_audio:
        with tempfile.TemporaryDirectory() as td:
            wav_s, wav_o = f"{td}/s.wav", f"{td}/o.wav"
            extract_wav(source, wav_s)
            extract_wav(output, wav_o)
            _, a = wavfile.read(wav_s)
            _, b = wavfile.read(wav_o)
            length_ok = abs(len(a) - len(b)) <= 4410  # 0.1s 容差
            m = min(len(a), len(b))
            exact = np.array_equal(a[:m], b[:m])
            if exact:
                detail = "PCM 逐样本一致 (流拷贝)"
                corr = 1.0
            else:
                corr = float(np.corrcoef(a[:m].astype(float),
                                         b[:m].astype(float))[0, 1])
                detail = f"PCM 非完全一致, 波形相关系数={corr:.5f}"
            rep.check("音频保留且音画同步", length_ok and (exact or corr >= 0.99),
                      detail + f", 样本数 src={len(a)} out={len(b)}")
    else:
        rep.check("音频保留且音画同步", not out_info.has_audio, "源无音频, 输出亦无")

    # ---- 9. 输出可再次被工具分析 (重开闭环) ----
    rep.check("输出可重新分析(闭环复核)", len(out_m.affines) == n,
              f"对输出重新运动估计得到 {len(out_m.affines)} 帧")
    return rep


def main() -> None:
    ap = argparse.ArgumentParser(description="防抖结果独立核验")
    ap.add_argument("--source", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--sidecar", required=True)
    ap.add_argument("--gt", required=True)
    args = ap.parse_args()
    rep = verify(args.source, args.output, args.sidecar, args.gt)
    rep.print()
    raise SystemExit(0 if rep.passed else 1)


if __name__ == "__main__":
    main()
