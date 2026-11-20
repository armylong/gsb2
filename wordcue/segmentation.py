"""把一段文本切成「词」和「停顿」.

规则很朴素, 目的只是给用户一个可以直接调时间的起点:
  * 标点符号单独成为 ``pause``;
  * 连续的中文字符每 2 个切一刀 (诗歌/朗读稿的常见节奏), 单字尾部保留;
  * 拉丁字母/数字按单词切, 遇到空白断开;
  * 其余符号各自成词。
"""

from __future__ import annotations

import re

PUNCTUATION = set("，。！？；：、,.!?;:…—～~·\"'“”‘’「」『』（）()【】[]《》<>")
_SPACE = re.compile(r"\s+")


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (0x3400 <= code <= 0x4DBF or 0x4E00 <= code <= 0x9FFF
            or 0xF900 <= code <= 0xFAFF or 0x3040 <= code <= 0x30FF)


def segment_text(text: str, cjk_chunk: int = 2) -> list[tuple[str, str]]:
    """返回 [(文本, "word"|"pause"), ...], 按原顺序。"""
    tokens: list[tuple[str, str]] = []
    cjk_buf: list[str] = []
    latin_buf: list[str] = []

    def flush_cjk() -> None:
        while cjk_buf:
            piece = "".join(cjk_buf[:cjk_chunk])
            del cjk_buf[:cjk_chunk]
            if piece:
                tokens.append((piece, "word"))

    def flush_latin() -> None:
        if latin_buf:
            tokens.append(("".join(latin_buf), "word"))
            latin_buf.clear()

    def flush_all() -> None:
        flush_cjk()
        flush_latin()

    for ch in text:
        if ch.isspace():
            flush_all()
        elif ch in PUNCTUATION:
            flush_all()
            tokens.append((ch, "pause"))
        elif _is_cjk(ch):
            flush_latin()
            cjk_buf.append(ch)
            if len(cjk_buf) >= cjk_chunk:
                flush_cjk()
        elif ch.isalnum() or ch in "'-_":
            flush_cjk()
            latin_buf.append(ch)
        else:
            flush_all()
            tokens.append((ch, "word"))
    flush_all()
    return tokens


def weight_of(token: tuple[str, str]) -> float:
    text, kind = token
    if kind == "pause":
        return 3.0
    return max(1.0, float(len(text)))
