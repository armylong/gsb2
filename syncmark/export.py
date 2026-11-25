"""把报告导出成可以离线重新打开的 HTML 和 Markdown 对照表."""

from __future__ import annotations

import html
import json
import os
import tempfile
from typing import Any


_STATUS_LABEL = {
    "matched": "已匹配",
    "matched_with_issue": "匹配(有问题)",
    "video_only": "仅画面",
    "audio_only": "仅声音",
    "missing": "未找到",
    "unplanned": "计划外",
}

_STATUS_COLOR = {
    "matched": "#1f9d55",
    "matched_with_issue": "#c77700",
    "video_only": "#2563c9",
    "audio_only": "#7a3fb8",
    "missing": "#c62b33",
    "unplanned": "#c62b33",
}


def _esc(v: Any) -> str:
    return html.escape("" if v is None else str(v))


def _status_label(e: dict[str, Any]) -> str:
    return _STATUS_LABEL.get(e.get("status", ""), str(e.get("status")))


def _status_color(e: dict[str, Any]) -> str:
    c = _STATUS_COLOR.get(e.get("status", ""), "#555555")
    if e.get("source") == "extra":
        c = "#c62b33"
    return c


def _ms(v: float | None) -> str:
    if v is None:
        return "-"
    return f"{v * 1000.0:+.1f}"


def export_html(report: dict[str, Any], out_path: str, *, thumbnails: dict[str, str] | None = None) -> str:
    """导出 HTML. thumbnails 可以是 {"data:image/png;base64,..."} 形式的内嵌图."""
    film = report.get("film") or {}
    sync = report.get("sync") or {}
    summ = report.get("summary") or {}
    bnd = report.get("boundary") or {}
    events = report.get("events") or []
    thumbs = thumbnails or {}

    fonts = ("-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',"
             "'Hiragino Sans GB','Microsoft YaHei',sans-serif")

    v = film.get("video") or {}
    a = film.get("audio") or {}
    plan_v = (report.get("plan") or {}).get("video") or {}

    def badge(text: str, color: str) -> str:
        return (f"<span class='badge' style='background:{color}'>{_esc(text)}</span>")

    rows_xml = []
    for i, e in enumerate(events, 1):
        vid = e.get("video")
        aud = e.get("audio")
        vtxt = "-" if not vid else (
            f"#{vid['start_frame']}–{vid['end_frame']}<br>"
            f"t={vid['start_time']:.3f}s<br>"
            f"{vid['frame_count']} 帧"
            + (f"<br><small>含 {vid['duplicate_frames']} 帧重复</small>"
               if vid.get("duplicate_frames") else "")
        )
        atxt = "-" if not aud else (
            f"采样 {aud['start_sample']}–{aud['end_sample']}<br>"
            f"t={aud['start_time']:.3f}s<br>"
            f"{aud['freq_hz']:.0f} Hz · {aud['duration_ms']:.0f} ms"
        )
        tags = " ".join(badge(t, "#a1582f" if "个别" in t else "#8a6a1f")
                        for t in (e.get("sync_tags") or []))
        probs = " ".join(badge(p, "#c62b33") for p in (e.get("problems") or []))
        key = f"e{i}"
        thumb = thumbs.get(key)
        img = (f"<img class='thumb' src='{thumb}' alt='前/后帧'>" if thumb else
               "<span class='dim'>未附帧图</span>")
        plan_txt = "—" if e.get("plan_time") is None else (
            f"t={e['plan_time']:.3f}s<br><small>帧 #{e.get('plan_frame')}</small>")
        rows_xml.append(f"""
<tr>
  <td class='num'>{i}</td>
  <td>{badge(_status_label(e), _status_color(e))}<br>{tags}{probs}</td>
  <td class='mono'>{_esc(e.get('id'))}</td>
  <td class='mono'>{plan_txt}</td>
  <td class='mono'>{vtxt}</td>
  <td class='mono'>{atxt}</td>
  <td class='mono'>{_esc(_ms(e.get('video_residual')))}</td>
  <td class='mono'>{_esc(_ms(e.get('audio_residual')))}</td>
  <td class='mono'>{_esc(_ms(e.get('video_adjusted')))}</td>
  <td class='mono'>{_esc(_ms(e.get('audio_adjusted')))}</td>
  <td>{img}</td>
</tr>""")

    def sync_row(name: str, d: dict[str, Any]) -> str:
        if not d:
            return ""
        ok = d.get("applicable")
        return (f"<tr><td>{_esc(name)}</td>"
                f"<td class='mono'>{_esc(_ms(d.get('seconds')))} ms</td>"
                f"<td>{badge('整体偏移' if ok else '无', '#c77700' if ok else '#1f9d55')}</td>"
                f"<td>{_esc(d.get('support'))}</td>"
                f"<td class='mono'>{_esc(_ms(d.get('mad')))} ms</td>"
                f"<td>{_esc(d.get('reason'))}</td></tr>")

    boundary_xml = []
    for item in bnd.get("items", []) or []:
        color = "#1f9d55" if item.get("passed") else "#c62b33"
        boundary_xml.append(
            f"<tr><td>{_esc(item.get('name'))}</td>"
            f"<td>{badge('通过' if item.get('passed') else '异常', color)}</td>"
            f"<td class='mono'>{_esc(item.get('mode', ''))}</td>"
            f"<td>{_esc(item.get('detail', ''))}</td></tr>")

    doc = f"""<!DOCTYPE html>
<html lang='zh-CN'><head><meta charset='utf-8'>
<title>SyncMark 对照报告 · {_esc(os.path.basename(film.get('path') or ''))}</title>
<style>
  :root {{ color-scheme: light; }}
  body {{ margin:0; padding:28px 32px 60px; font-family:{fonts}; color:#1c1c1e; background:#f6f6f8; }}
  h1 {{ font-size:22px; margin:0 0 6px; }}
  h2 {{ font-size:15px; margin:26px 0 10px; color:#333; border-left:3px solid #8a8a8f; padding-left:8px; }}
  .sub {{ color:#707078; font-size:12.5px; }}
  .cards {{ display:flex; gap:12px; flex-wrap:wrap; margin-top:16px; }}
  .card {{ background:#fff; border:1px solid #e3e3e8; border-radius:10px; padding:12px 16px; min-width:132px; }}
  .card .k {{ font-size:11.5px; color:#70707a; letter-spacing:.03em; }}
  .card .v {{ font-size:19px; font-weight:600; margin-top:4px; font-variant-numeric:tabular-nums; }}
  table {{ border-collapse:collapse; width:100%; background:#fff; border:1px solid #e3e3e8; border-radius:10px; overflow:hidden; font-size:12.5px; }}
  th, td {{ padding:8px 10px; text-align:left; vertical-align:top; border-bottom:1px solid #eeeef2; }}
  th {{ background:#fafafc; font-weight:600; color:#4a4a52; font-size:12px; }}
  td.mono, .mono {{ font-family:ui-monospace,'SF Mono',Menlo,monospace; font-variant-numeric:tabular-nums; }}
  .badge {{ display:inline-block; color:#fff; border-radius:999px; padding:1px 8px; font-size:11px; margin:1px 2px 1px 0; white-space:nowrap; }}
  .num {{ color:#9a9aa2; font-variant-numeric:tabular-nums; }}
  .thumb {{ display:block; max-width:190px; border-radius:6px; border:1px solid #ddd; }}
  .dim {{ color:#a0a0a8; font-size:11.5px; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }}
  .kv {{ background:#fff; border:1px solid #e3e3e8; border-radius:10px; padding:10px 14px; font-size:12.5px; }}
  .kv b {{ display:inline-block; min-width:104px; color:#50505a; font-weight:600; }}
  .kv div {{ padding:2px 0; }}
  footer {{ margin-top:28px; color:#98989f; font-size:11.5px; }}
</style></head><body>
<h1>SyncMark 对照报告</h1>
<div class='sub'>片子: <span class='mono'>{_esc(film.get('path') or '')}</span> · 生成于 {_esc(report.get('created_utc') or '')}</div>
<div class='sub'>本文件是自包含的, 双击即可重新打开; 全部数据内嵌在文件里.</div>

<div class='cards'>
  <div class='card'><div class='k'>计划标记</div><div class='v'>{_esc(summ.get('planned_markers'))}</div></div>
  <div class='card'><div class='k'>已匹配</div><div class='v' style='color:#1f9d55'>{_esc(summ.get('matched'))}</div></div>
  <div class='card'><div class='k'>未找到</div><div class='v' style='color:#c62b33'>{_esc(summ.get('missing'))}</div></div>
  <div class='card'><div class='k'>只检出一半</div><div class='v' style='color:#2563c9'>{_esc(summ.get('partial'))}</div></div>
  <div class='card'><div class='k'>计划外</div><div class='v' style='color:#c62b33'>{_esc(summ.get('extra'))}</div></div>
  <div class='card'><div class='k'>整体偏移</div><div class='v' style='font-size:15px'>{_esc('是' if summ.get('has_global_offset') else '否')}</div></div>
  <div class='card'><div class='k'>个别事件问题</div><div class='v' style='font-size:15px'>{_esc('有' if summ.get('has_local_issue') else '无')}</div></div>
</div>

<h2>同步判定</h2>
<table><tr><th>通道</th><th>整体偏移</th><th>结论</th><th>样本</th><th>离散度(MAD)</th><th>说明</th></tr>
{sync_row('声音', sync.get('audio') or {})}
{sync_row('画面', sync.get('video') or {})}
</table>
<div class='sub'>整体偏移 = 该通道所有事件一起平移的距离; 扣掉它之后仍超过 ±{int((sync.get('event_tolerance_s') or 0) * 1000)} ms 的, 记为个别事件问题.</div>

<h2>首尾边界</h2>
<table><tr><th>检查项</th><th>结果</th><th>形态</th><th>实际</th></tr>
{''.join(boundary_xml) or "<tr><td colspan=4 class='dim'>无</td></tr>"}
</table>

<h2>逐标记对照</h2>
<table>
<tr><th>#</th><th>状态</th><th>编号</th><th>计划</th><th>实际画面</th><th>实际声音</th>
<th>画面残差<br><small>ms</small></th><th>声音残差<br><small>ms</small></th>
<th>画面去除整体偏移后<br><small>ms</small></th><th>声音去除整体偏移后<br><small>ms</small></th><th>前后帧</th></tr>
{''.join(rows_xml) or "<tr><td colspan=11 class='dim'>没有事件</td></tr>"}
</table>

<h2>片子信息</h2>
<div class='grid'>
  <div class='kv'>
    <div><b>文件</b><span class='mono'>{_esc(os.path.basename(film.get('path') or ''))}</span></div>
    <div><b>时长</b>{_esc(film.get('duration'))} s</div>
    <div><b>画面</b>{_esc(v.get('width'))}×{_esc(v.get('height'))} · {_esc(v.get('fps'))} fps · {_esc(v.get('codec'))}</div>
    <div><b>画面流起点</b>{_esc(v.get('start_time'))} s</div>
  </div>
  <div class='kv'>
    <div><b>声音</b>{_esc(a.get('sample_rate'))} Hz · {_esc(a.get('channels'))} 声道 · {_esc(a.get('codec'))}</div>
    <div><b>声音流起点</b>{_esc(a.get('start_time'))} s</div>
    <div><b>解码帧数</b>{_esc((report.get('stats') or {}).get('video', {}).get('decoded_frames'))}</div>
    <div><b>解码采样数</b>{_esc((report.get('stats') or {}).get('audio', {}).get('samples'))}</div>
  </div>
  <div class='kv'>
    <div><b>计划视频</b>{_esc((plan_v or {}).get('frames'))} 帧 · {_esc((plan_v or {}).get('duration'))} s</div>
    <div><b>注入故障</b><span class='mono'>{_esc(json.dumps((report.get('plan') or {}).get('faults', {}), ensure_ascii=False))}</span></div>
    <div><b>匹配窗口</b>±{_esc(sync.get('match_window_s'))} s</div>
    <div><b>报告版本</b>{_esc(report.get('schema'))}</div>
  </div>
</div>

<footer>SyncMark · 生成器自带编号闪光与音高提示声 · 识别阶段不读取计划 · 本次导出不含原始音频</footer>
<script type='application/json' id='syncmark-report'>{json.dumps(_strip_big(report), ensure_ascii=False).replace("</", "<\\/")}</script>
</body></html>
"""
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    tmp_fd, tmp = tempfile.mkstemp(prefix=".syncmark-html-", suffix=".html",
                                   dir=os.path.dirname(os.path.abspath(out_path)) or ".")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as fh:
            fh.write(doc)
        os.chmod(tmp, 0o644)
        os.replace(tmp, out_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return out_path


def _strip_big(report: dict[str, Any]) -> dict[str, Any]:
    """导出内嵌 JSON 时去掉不适合再嵌入的大字段."""
    out = dict(report)
    out.pop("analysis_tmpdir", None)
    out.pop("readme", None)
    return out


def export_markdown(report: dict[str, Any], out_path: str) -> str:
    film = report.get("film") or {}
    summ = report.get("summary") or {}
    sync = report.get("sync") or {}
    bnd = report.get("boundary") or {}
    events = report.get("events") or []

    def ms(v):
        return "-" if v is None else f"{v * 1000.0:+.1f}"

    lines = [
        "# SyncMark 对照报告",
        "",
        f"- 片子: `{film.get('path')}`",
        f"- 生成于: {report.get('created_utc')}",
        f"- 计划标记: {summ.get('planned_markers')} · 已匹配 {summ.get('matched')} · "
        f"未找到 {summ.get('missing')} · 仅一半 {summ.get('partial')} · 计划外 {summ.get('extra')}",
        f"- 整体偏移: {'是' if summ.get('has_global_offset') else '否'} · "
        f"个别事件问题: {'有' if summ.get('has_local_issue') else '无'}",
        "",
        "## 同步判定",
        "",
        "| 通道 | 整体偏移 | 结论 | 样本 | MAD | 说明 |",
        "|---|---:|---|---:|---:|---|",
    ]
    for name, key in (("声音", "audio"), ("画面", "video")):
        d = sync.get(key) or {}
        lines.append(f"| {name} | {ms(d.get('seconds'))} ms | "
                     f"{'整体偏移' if d.get('applicable') else '无'} | {d.get('support')} | "
                     f"{ms(d.get('mad'))} ms | {d.get('reason')} |")
    lines += ["", "## 首尾边界", ""]
    for item in bnd.get("items", []) or []:
        lines.append(f"- **{item.get('name')}**: {'通过' if item.get('passed') else '异常'} — "
                     f"{item.get('mode', '')} · {item.get('detail', '')}")
    lines += [
        "",
        "## 逐标记对照",
        "",
        "| # | 状态 | 编号 | 计划 | 实际画面 | 实际声音 | 画面残差(ms) | 声音残差(ms) | 画面去偏移(ms) | 声音去偏移(ms) |",
        "|---:|---|---:|---:|---|---|---:|---:|---:|---:|",
    ]
    for i, e in enumerate(events, 1):
        vid = e.get("video")
        aud = e.get("audio")
        vtxt = "-" if not vid else (f"#{vid['start_frame']}–{vid['end_frame']} @ {vid['start_time']:.3f}s "
                                    + (f"(含{vid['duplicate_frames']}重复帧)" if vid.get("duplicate_frames") else ""))
        atxt = "-" if not aud else f"采样 {aud['start_sample']} @ {aud['start_time']:.3f}s ({aud['freq_hz']:.0f}Hz)"
        plan_txt = "—" if e.get("plan_time") is None else f"{e['plan_time']:.3f}s"
        status = _status_label(e) + ((" · " + "/".join(e.get("sync_tags") or [])) if e.get("sync_tags") else "")
        lines.append(f"| {i} | {status} | {e.get('id')} | {plan_txt} | {vtxt} | {atxt} | "
                     f"{ms(e.get('video_residual'))} | {ms(e.get('audio_residual'))} | "
                     f"{ms(e.get('video_adjusted'))} | {ms(e.get('audio_adjusted'))} |")
    lines.append("")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    return out_path
