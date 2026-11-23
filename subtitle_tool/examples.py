"""Bundled bilingual example: cross-cut cue and a missing translation.

The two SRT files and the cut column are written as plain text next to this
module and can be opened directly from the app (「加载示例」 also builds an
in-memory project from them, with pairing suggestions *not* applied so that
the suggestions panel has something to show).
"""

from __future__ import annotations

import os
from typing import List

from .model import Project, Track
from .pairing import apply_all_suggestions, build_pairing_suggestions
from .srt import parse_cut_list, parse_srt

EXAMPLE_DIR = os.path.join(os.path.dirname(__file__), "example_data")

EN_SRT = """1
00:00:00,500 --> 00:00:03,200
We need to move before the storm hits.

2
00:00:03,400 --> 00:00:07,000
The bridge is out, so take the north road.

3
00:00:07,200 --> 00:00:10,400
And don't stop for anything.

4
00:00:12,000 --> 00:00:15,800
I'll signal you when the gate opens.

5
00:00:16,000 --> 00:00:19,600
If the lights go out, keep going.

6
00:00:20,000 --> 00:00:22,500
Keep going, no matter what.

7
00:00:23,000 --> 00:00:26,500
We'll meet at the old mill.
"""

ZH_SRT = """1
00:00:00,900 --> 00:00:03,500
暴风雨来之前，我们必须动身。

2
00:00:03,600 --> 00:00:07,300
桥断了，走北边的路。

3
00:00:07,500 --> 00:00:10,600
什么都别停。

4
00:00:16,200 --> 00:00:19,700
如果灯灭了，就继续走。

5
00:00:20,100 --> 00:00:21,300
继续走，

6
00:00:21,300 --> 00:00:22,700
不管发生什么。

7
00:00:23,200 --> 00:00:26,700
在老磨坊碰头。
"""

CUTS_TXT = """# scene cuts — one per line (seconds, or MM:SS.mmm); editable
00:00:11,000
00:00:21,000
00:00:27,000
"""


def write_example_files(directory: str = EXAMPLE_DIR) -> List[str]:
    os.makedirs(directory, exist_ok=True)
    paths = []
    for name, content in (
        ("en.srt", EN_SRT),
        ("zh.srt", ZH_SRT),
        ("cuts.txt", CUTS_TXT),
    ):
        path = os.path.join(directory, name)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        paths.append(path)
    return paths


def example_paths(directory: str = EXAMPLE_DIR) -> dict:
    if not os.path.exists(os.path.join(directory, "en.srt")):
        write_example_files(directory)
    return {
        "en": os.path.join(directory, "en.srt"),
        "zh": os.path.join(directory, "zh.srt"),
        "cuts": os.path.join(directory, "cuts.txt"),
    }


def build_example_project(apply_pairing: bool = False) -> Project:
    """Build the bundled example project.

    The English track is the anchor.  The example deliberately contains:
    * boundary offsets of a few hundred ms between the two tracks,
    * one English cue (00:12,000–00:15,800) with no Chinese translation,
    * one English cue (00:20,000–00:22,500) split into two Chinese cues,
    * a scene cut at 00:21,000 that sits inside that cue.
    """
    project = Project(lang_order=["en", "zh"])
    project.ensure_language("en")
    project.ensure_language("zh")
    project.profiles["en"].max_cps = 17.0
    project.profiles["zh"].max_cps = 9.0
    project.profiles["zh"].max_lines = 2
    project.profiles["zh"].max_chars_per_line = 20
    project.total_lines_budget = 2
    project.min_gap_ms = 40
    project.add_track(Track.from_srt("en", "<example>/en.srt", parse_srt(EN_SRT)))
    project.add_track(Track.from_srt("zh", "<example>/zh.srt", parse_srt(ZH_SRT)))
    project.cuts = parse_cut_list(CUTS_TXT)
    if apply_pairing:
        suggestions = build_pairing_suggestions(project, "en")
        apply_all_suggestions(project, suggestions)
    return project
