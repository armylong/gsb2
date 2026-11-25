from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .content import packet_stream_hash
from .edits import ExpectedStream, ExportPlan
from .media import SourceInfo, probe_file

_OFFSET_TOLERANCE = 0.080  # ms-level muxer rounding plus one video frame at 12.5 fps.


@dataclass
class StreamVerification:
    output_index: int
    expected: ExpectedStream
    actual_language: str = ""
    actual_title: str = ""
    actual_default: bool = False
    actual_forced: bool = False
    actual_relative_offset: float | None = None
    packet_hash: str | None = None
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


@dataclass
class VerificationReport:
    output_path: Path
    actual: SourceInfo | None
    checks: list[StreamVerification]
    errors: list[str]

    @property
    def ok(self) -> bool:
        return self.actual is not None and not self.errors and all(c.ok for c in self.checks)

    def summary_lines(self) -> list[str]:
        lines = [f"复核：{self.output_path}"]
        if not self.actual:
            return lines + self.errors
        for check in self.checks:
            e = check.expected
            status = "OK" if check.ok else "不符"
            offset = (
                f"{check.actual_relative_offset:+.3f}s"
                if check.actual_relative_offset is not None
                else "—"
            )
            flags = f"D={int(check.actual_default)} F={int(check.actual_forced)}"
            lines.append(
                f"  [{status}] 输出#{check.output_index} <- 源#{e.source_index} "
                f"{e.codec_type}/{e.codec_name} lang={check.actual_language or '∅'} "
                f"title={check.actual_title or '∅'} {flags} offset={offset}"
            )
            lines.extend(f"      ! {err}" for err in check.errors)
        lines.extend(f"! {err}" for err in self.errors)
        return lines


def verify_output(
    path: str | Path,
    plan: ExportPlan,
    *,
    check_content: bool | None = None,
) -> VerificationReport:
    output = Path(path)
    errors: list[str] = []
    try:
        actual = probe_file(output, ffprobe=plan.ffprobe)
    except Exception as exc:  # noqa: BLE001 - verification must report, not fake success
        return VerificationReport(
            output_path=output, actual=None, checks=[], errors=[f"无法重新探测输出：{exc}"]
        )

    if len(actual.streams) != len(plan.expected):
        errors.append(
            f"实际流数量 {len(actual.streams)} 与预期 {len(plan.expected)} 不一致；"
            "可能有目标未保留或多出未映射流。"
        )

    checks: list[StreamVerification] = []
    do_hash = plan.verify_content if check_content is None else check_content

    for expected in plan.expected:
        i = expected.output_index
        if i >= len(actual.streams):
            errors.append(f"预期输出 #{i}（源 #{expected.source_index}）不存在，目标没有保留。")
            continue
        stream = actual.streams[i]
        check = StreamVerification(
            output_index=i,
            expected=expected,
            actual_language=stream.language,
            actual_title=stream.title,
            actual_default=stream.default,
            actual_forced=stream.forced,
            actual_relative_offset=actual.relative_offset(stream),
        )

        def fail(message: str) -> None:
            check.errors.append(message)

        if stream.codec_type != expected.codec_type:
            fail(f"种类应为 {expected.codec_type}，实际为 {stream.codec_type}")
        if stream.codec_name != expected.codec_name:
            fail(f"编码应为 {expected.codec_name}，实际为 {stream.codec_name}")
        if stream.language != expected.language:
            fail(f"语言应为 {expected.language or '空'}，实际为 {stream.language or '空'}")
        if stream.title != expected.title:
            fail(f"标题应为 {expected.title!r}，实际为 {stream.title!r}")
        if stream.default != expected.default:
            fail(f"default 标记应为 {int(expected.default)}，实际为 {int(stream.default)}")
        if stream.forced != expected.forced:
            fail(f"forced 标记应为 {int(expected.forced)}，实际为 {int(stream.forced)}")

        if expected.relative_offset is not None and check.actual_relative_offset is not None:
            delta = abs(check.actual_relative_offset - expected.relative_offset)
            if delta > _OFFSET_TOLERANCE:
                fail(
                    "时间偏移未保留："
                    f"预期 {expected.relative_offset:+.3f}s，"
                    f"实际 {check.actual_relative_offset:+.3f}s"
                )
        elif expected.relative_offset is not None:
            fail("输出流缺少 start_time，无法核对时间位置")

        if do_hash and expected.packet_hash:
            try:
                actual_hash = packet_stream_hash(output, i, ffmpeg=plan.ffmpeg)
                check.packet_hash = actual_hash
                if actual_hash != expected.packet_hash:
                    fail("编码包内容哈希与源目标不一致，可能映射到了错误的流")
            except Exception as exc:  # noqa: BLE001
                fail(f"内容哈希核对失败：{exc}")

        checks.append(check)

    return VerificationReport(output_path=output, actual=actual, checks=checks, errors=errors)
