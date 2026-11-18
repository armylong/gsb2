"""代理核对: 关联、结构一致性、画面内容比对。

分辨率和压缩损失属于预期差异, 内容比对在统一 32x18 灰度网格上做,
不要求像素一致; 判断依据是分布于全片的检查点 MAE 与整体错位搜索。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

import numpy as np

from .ffmedia import GRID_H, GRID_W, MediaInfo, content_digest, decode_gray_frames, probe, sha256_file
from .proxy import load_sidecar, sidecar_path_for, target_dimensions


class Status(str, Enum):
    PASS = "PASS"        # 明确通过
    WARN = "WARN"        # 可追查的警告(局部画面差异等)
    FAIL = "FAIL"        # 明确失败(少帧/错片/被替换等)
    INFO = "INFO"        # 预期内差异, 不影响结论(分辨率/压缩)
    PENDING = "PENDING"  # 缺少关联信息, 不能声称通过


@dataclass
class Check:
    id: str
    name: str
    status: Status
    detail: str
    evidence: dict = field(default_factory=dict)


@dataclass
class CheckpointEvidence:
    source_index: int
    proxy_index: int
    source_time: float
    proxy_time: float
    mae: float
    # GUI 展示用的双画面在各自文件中的帧序号。
    status: Status


@dataclass
class VerificationReport:
    source: MediaInfo
    proxy: MediaInfo
    has_sidecar: bool
    checks: list[Check]
    checkpoints: list[CheckpointEvidence]
    best_offset_frames: int | None
    content_mae: float | None
    overall: Status
    conclusion: str

    def to_dict(self) -> dict:
        return {
            "overall": self.overall.value,
            "conclusion": self.conclusion,
            "generated_at": _now(),
            "source": self.source.to_dict(),
            "proxy": self.proxy.to_dict(),
            "sidecar_present": self.has_sidecar,
            "checks": [
                {"id": c.id, "name": c.name, "status": c.status.value,
                 "detail": c.detail, "evidence": c.evidence}
                for c in self.checks
            ],
            "content_check": {
                "grid": f"{GRID_W}x{GRID_H} gray",
                "overall_mae": None if self.content_mae is None else round(self.content_mae, 5),
                "best_offset_in_source_frames": self.best_offset_frames,
                "checkpoints": [
                    {"source_frame": cp.source_index, "proxy_frame": cp.proxy_index,
                     "source_time": round(cp.source_time, 4),
                     "proxy_time": round(cp.proxy_time, 4),
                     "mae": round(cp.mae, 5), "status": cp.status.value}
                    for cp in self.checkpoints
                ],
            },
        }

    def save_json(self, path: str | Path) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, ensure_ascii=False, indent=2)


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# 内容比对阈值(在 0..1 灰度 MAE 上)。同片缩小转码实测 < 0.02。
MAE_WARN = 0.08
MAE_FAIL = 0.16
OFFSET_WARN_FRAMES = 1      # 超出一个源帧即报警
N_CHECKPOINTS = 9


def _association_checks(source: MediaInfo, proxy: MediaInfo) -> tuple[list[Check], bool]:
    checks: list[Check] = []
    sidecar = load_sidecar(proxy.path)
    if sidecar is None:
        checks.append(Check(
            "association", "代理关联信息",
            Status.PENDING,
            f"缺少关联文件 {Path(proxy.path).name}.sidecar.json, "
            "无法证明代理来自当前原片, 标记为待核对, 不能声称通过",
        ))
        return checks, False

    src_record = sidecar.get("source", {})
    proxy_record = sidecar.get("proxy", {})
    problems: list[str] = []

    if src_record.get("sha256") and src_record["sha256"] != source.sha256:
        problems.append(
            "原片文件 sha256 与关联记录不一致(原片已被替换或不是同一份文件)"
        )
    if proxy_record.get("sha256") and proxy_record["sha256"] != proxy.sha256:
        problems.append("代理文件 sha256 与关联记录不一致(代理已被替换)")
    if src_record.get("content_digest") and \
            src_record["content_digest"] != source.content_digest:
        problems.append("原片内容指纹与关联记录不一致(画面内容发生变化)")

    if problems:
        checks.append(Check(
            "association", "代理关联信息", Status.FAIL,
            "关联校验失败: " + "; ".join(problems),
            {"sidecar": str(sidecar_path_for(proxy.path))},
        ))
    else:
        checks.append(Check(
            "association", "代理关联信息", Status.PASS,
            "sidecar 记录的原片/代理 sha256 与内容指纹均与当前文件一致",
            {"sidecar": str(sidecar_path_for(proxy.path)),
             "created_at": sidecar.get("created_at")},
        ))
    return checks, True


def _structure_checks(source: MediaInfo, proxy: MediaInfo) -> list[Check]:
    checks: list[Check] = []
    src_fps, dst_fps = source.frame_rate, proxy.frame_rate

    # 1. 帧数
    if proxy.nb_video_frames == source.nb_video_frames:
        checks.append(Check(
            "frame_count", "实际帧数", Status.PASS,
            f"两边均为 {source.nb_video_frames} 帧(以 ffprobe packet 计数为准)",
            {"source": source.nb_video_frames, "proxy": proxy.nb_video_frames},
        ))
    else:
        delta = source.nb_video_frames - proxy.nb_video_frames
        checks.append(Check(
            "frame_count", "实际帧数", Status.FAIL,
            f"帧数不一致: 原片 {source.nb_video_frames} 帧, 代理 "
            f"{proxy.nb_video_frames} 帧(相差 {delta} 帧), 代理少段或被截断",
            {"source": source.nb_video_frames, "proxy": proxy.nb_video_frames,
             "delta": delta},
        ))

    # 2. 时间戳间隔(两边都必须是 CFR 且帧率一致)
    def spacing(mi: MediaInfo) -> tuple[float, float]:
        if len(mi.packet_pts) >= 2:
            d = np.diff(np.asarray(mi.packet_pts))
            return float(np.mean(d)), float(np.max(np.abs(d - 1.0 / mi.frame_rate)))
        return 1.0 / mi.frame_rate, 0.0

    src_mean, src_jitter = spacing(source)
    dst_mean, dst_jitter = spacing(proxy)
    if abs(src_fps - dst_fps) > 1e-3:
        checks.append(Check(
            "timestamps", "时间戳间隔/帧率", Status.FAIL,
            f"帧率不一致: 原片 {src_fps:.3f}fps, 代理 {dst_fps:.3f}fps",
            {"source_fps": src_fps, "proxy_fps": dst_fps},
        ))
    elif max(src_jitter, dst_jitter) > 2e-4 / src_fps + 1e-4:
        checks.append(Check(
            "timestamps", "时间戳间隔/帧率", Status.FAIL,
            f"PTS 间隔存在抖动: 原片最大偏差 {src_jitter*1000:.2f}ms, "
            f"代理 {dst_jitter*1000:.2f}ms",
            {"source_mean_spacing": src_mean, "proxy_mean_spacing": dst_mean},
        ))
    else:
        checks.append(Check(
            "timestamps", "时间戳间隔/帧率", Status.PASS,
            f"两边同为 {src_fps:.3f}fps 恒定帧率, 帧间隔 "
            f"{src_mean*1000:.2f}ms, 无明显抖动",
            {"source_mean_spacing": round(src_mean, 6),
             "proxy_mean_spacing": round(dst_mean, 6)},
        ))

    # 3. 首尾覆盖
    src_start = source.packet_pts[0] if source.packet_pts else 0.0
    dst_start = proxy.packet_pts[0] if proxy.packet_pts else 0.0
    src_end = source.video_duration
    dst_end = proxy.video_duration
    start_diff = abs(dst_start - src_start)
    end_diff = abs(dst_end - src_end)
    one_frame = 1.0 / src_fps
    if start_diff <= one_frame + 1e-3 and end_diff <= one_frame + 1e-3:
        checks.append(Check(
            "coverage", "首尾覆盖", Status.PASS,
            f"首帧 PTS {dst_start:.3f}s、末帧结束 {dst_end:.3f}s, "
            f"与原片偏差均不超过一个源帧({one_frame*1000:.1f}ms)",
            {"source_start": src_start, "proxy_start": dst_start,
             "source_end": src_end, "proxy_end": dst_end},
        ))
    else:
        checks.append(Check(
            "coverage", "首尾覆盖", Status.FAIL,
            f"首尾未对齐: 起点偏差 {start_diff*1000:.0f}ms, "
            f"末端偏差 {end_diff*1000:.0f}ms(一个源帧 {one_frame*1000:.0f}ms), "
            "代理存在错开/缺头少尾",
            {"source_start": src_start, "proxy_start": dst_start,
             "source_end": src_end, "proxy_end": dst_end,
             "start_diff": start_diff, "end_diff": end_diff},
        ))

    # 4. 音画长度
    av_problems: list[str] = []
    if source.has_audio and not proxy.has_audio:
        av_problems.append("原片有音轨但代理丢失音轨")
    elif not source.has_audio and proxy.has_audio:
        av_problems.append("原片无音轨但代理多出音轨")
    elif source.has_audio and proxy.has_audio:
        src_a = source.audio_duration or 0.0
        dst_a = proxy.audio_duration or 0.0
        gap = abs(dst_a - src_a)
        # AAC 编码/编码器填充的常规容差: 2 帧或 100ms。
        tol = max(2.0 / src_fps, 0.1)
        if gap > tol:
            av_problems.append(
                f"音轨长度差异 {gap*1000:.0f}ms 超出容差 {tol*1000:.0f}ms"
            )
        vid_gap = abs(proxy.video_duration - dst_a)
        if vid_gap > tol:
            av_problems.append(
                f"代理自身音画长度差 {vid_gap*1000:.0f}ms, 音画不同步"
            )
    if av_problems:
        checks.append(Check(
            "av_length", "音画长度", Status.FAIL, "; ".join(av_problems),
            {"source_audio": source.audio_duration,
             "proxy_audio": proxy.audio_duration},
        ))
    else:
        detail = (
            f"两边均有音轨, 时长 {source.audio_duration:.2f}s / "
            f"{proxy.audio_duration:.2f}s, 差异在 AAC 容差内"
            if source.has_audio else "两边均无音轨"
        )
        checks.append(Check("av_length", "音画长度", Status.PASS, detail,
                            {"source_audio": source.audio_duration,
                             "proxy_audio": proxy.audio_duration}))

    # 5. 分辨率(预期差异, INFO)
    exp_w, exp_h = target_dimensions(source.width, source.height)
    if proxy.width == exp_w and proxy.height == exp_h:
        checks.append(Check(
            "resolution", "代理分辨率(预期差异)", Status.INFO,
            f"{source.resolution} -> {proxy.resolution}, 保持宽高比的 "
            f"{exp_h}p 缩小, 压缩与分辨率差异不参与像素一致性判断",
            {"source": source.resolution, "proxy": proxy.resolution},
        ))
    else:
        checks.append(Check(
            "resolution", "代理分辨率(预期差异)", Status.WARN,
            f"代理 {proxy.resolution} 与按原片宽高比推算的 {exp_w}x{exp_h} 不符",
            {"source": source.resolution, "proxy": proxy.resolution,
             "expected": f"{exp_w}x{exp_h}"},
        ))
    return checks


def _mae(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a.astype(np.float32) - b.astype(np.float32))))


def _search_offset(src_grid: np.ndarray, dst_grid: np.ndarray,
                   max_shift: int) -> tuple[int, float]:
    """搜索让整体 MAE 最小的错位量。

    约定 shift>0 表示代理画面滞后(代理帧 k 对应原片帧 k+shift),
    即代理开头被裁掉 shift 帧; shift<0 表示超前。
    """
    n = min(len(src_grid), len(dst_grid))
    best_shift, best_mae = 0, float("inf")
    for shift in range(-max_shift, max_shift + 1):
        if shift >= 0:
            a = src_grid[shift:n]          # 原片帧 shift..n-1
            b = dst_grid[0:n - shift]      # 代理帧 0..n-shift-1
        else:
            a = src_grid[0:n + shift]
            b = dst_grid[-shift:n]
        m = _mae(a, b)
        if m < best_mae:
            best_mae, best_shift = m, shift
    return best_shift, best_mae


def _content_check(source: MediaInfo, proxy: MediaInfo) -> tuple[Check, list[CheckpointEvidence], int | None, float | None]:
    src_grid = decode_gray_frames(source.path, GRID_W, GRID_H)
    dst_grid = decode_gray_frames(proxy.path, GRID_W, GRID_H)
    if src_grid.shape[0] != source.nb_video_frames:
        raise RuntimeError("原片解码帧数与 packet 计数不符")
    if dst_grid.shape[0] != proxy.nb_video_frames:
        raise RuntimeError("代理解码帧数与 packet 计数不符")

    fps = source.frame_rate
    n = min(len(src_grid), len(dst_grid))
    # 允许搜到接近整段的错位, 但至少保留 3 帧用于判定内容是否相同。
    max_shift = max(n - 3, 0)
    offset, aligned_mae = _search_offset(src_grid, dst_grid, max_shift)
    direct_mae = _mae(src_grid[:n], dst_grid[:n])

    # 全片分布的检查点(含首、尾)。源帧号均匀分布, 代理帧按检测到的偏移映射。
    idx = np.linspace(0, n - 1, num=min(N_CHECKPOINTS, n), dtype=int)
    checkpoints: list[CheckpointEvidence] = []
    for i in idx:
        si = int(i)
        pi = si - offset  # offset>0(代理滞后)时代理帧号更小
        if 0 <= pi < len(dst_grid):
            mae = _mae(src_grid[si], dst_grid[pi])
            pi_show = pi
        else:
            # 落在代理覆盖范围外(补黑段/裁掉的头部), 内容必然不匹配。
            pi_show = min(max(pi, 0), len(dst_grid) - 1)
            mae = 1.0
        if mae >= MAE_FAIL:
            st = Status.FAIL
        elif mae >= MAE_WARN:
            st = Status.WARN
        else:
            st = Status.PASS
        checkpoints.append(CheckpointEvidence(
            source_index=si, proxy_index=int(pi_show),
            source_time=si / fps, proxy_time=int(pi_show) / proxy.frame_rate,
            mae=mae, status=st,
        ))

    fail_n = sum(cp.status == Status.FAIL for cp in checkpoints)
    warn_n = sum(cp.status == Status.WARN for cp in checkpoints)
    offset_frames = abs(offset)

    if aligned_mae >= MAE_FAIL or fail_n >= max(2, len(checkpoints) // 3):
        status = Status.FAIL
        detail = (
            f"多个检查点画面明显不同(最佳对齐后整体 MAE {aligned_mae:.3f}, "
            f"{fail_n} 个失败点), 代理可能来自另一份原片而非同片缩小"
        )
    elif offset_frames > OFFSET_WARN_FRAMES and aligned_mae < MAE_WARN:
        status = Status.WARN
        detail = (
            f"内容与原片一致但整体错位 {offset_frames} 帧"
            f"({offset_frames / fps:.2f}s, 代理{'滞后' if offset > 0 else '超前'}), "
            f"对齐后 MAE 仅 {aligned_mae:.3f}, 属于时间错位(起点错开)而非错片"
        )
    elif warn_n or aligned_mae >= MAE_WARN:
        status = Status.WARN
        detail = (
            f"{warn_n} 个检查点存在可追查的画面差异(整体 MAE {aligned_mae:.3f}), "
            "请查看双画面证据确认局部内容"
        )
    else:
        status = Status.PASS
        detail = (
            f"{len(checkpoints)} 点分布检查全部在同内容位置匹配, 整体 MAE "
            f"{aligned_mae:.3f}(缩小+压缩的预期残差), 无整体错位"
        )

    check = Check(
        "content", "画面内容比对(统一灰度网格)", status, detail,
        {"direct_mae": round(direct_mae, 5), "aligned_mae": round(aligned_mae, 5),
         "best_offset_frames": offset,
         "thresholds": {"warn": MAE_WARN, "fail": MAE_FAIL},
         "failed_points": fail_n, "warned_points": warn_n},
    )
    return check, checkpoints, offset, aligned_mae


def verify(source_path: str | Path, proxy_path: str | Path,
           precomputed: tuple[MediaInfo, MediaInfo] | None = None) -> VerificationReport:
    """对一对文件执行完整核对。precomputed 可复用 GUI 已探测的信息。"""
    if precomputed is None:
        source = probe(source_path)
        proxy = probe(proxy_path)
    else:
        source, proxy = precomputed
    # 指纹是关联判断的依据, 必须现算, 不能信 sidecar 里的旧值。
    if not source.sha256:
        source.sha256 = sha256_file(source.path)
    if not proxy.sha256:
        proxy.sha256 = sha256_file(proxy.path)
    if not source.content_digest:
        source.content_digest, _ = content_digest(source.path)
    if not proxy.content_digest:
        proxy.content_digest, _ = content_digest(proxy.path)

    assoc, has_sidecar = _association_checks(source, proxy)
    structure = _structure_checks(source, proxy)
    content_check, checkpoints, offset, mae = _content_check(source, proxy)
    checks = assoc + structure + [content_check]

    if any(c.status == Status.FAIL for c in checks):
        overall = Status.FAIL
    elif any(c.status == Status.PENDING for c in checks):
        overall = Status.PENDING
    elif any(c.status == Status.WARN for c in checks):
        overall = Status.WARN
    else:
        overall = Status.PASS

    conclusion = {
        Status.PASS: "代理与原片关联可信, 帧数/时间戳/首尾/音画一致, 画面内容匹配",
        Status.PENDING: "关联信息缺失, 仅完成客观结构与内容检查, 不能声称通过",
        Status.WARN: "结构基本一致但存在需追查的画面或错位警告, 请查看证据",
        Status.FAIL: "核对失败: 存在明确不一致项(见 FAIL 条目), 代理不可信",
    }[overall]
    return VerificationReport(
        source=source, proxy=proxy, has_sidecar=has_sidecar,
        checks=checks, checkpoints=checkpoints,
        best_offset_frames=offset, content_mae=mae,
        overall=overall, conclusion=conclusion,
    )
