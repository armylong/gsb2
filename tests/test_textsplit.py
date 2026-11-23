"""Tests for text splitting and language-aware line wrapping."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from subtitle_tool.textsplit import (
    break_points,
    choose_break,
    split_text,
    split_text_by_weights,
)


class SplitTests(unittest.TestCase):
    def test_cjk_splits_at_punctuation(self):
        a, b = split_text("暴风雨来之前，我们必须动身。", 0.5)
        self.assertEqual(a, "暴风雨来之前，")
        self.assertTrue(b.startswith("我们必须"))

    def test_english_splits_at_word(self):
        a, b = split_text("We need to move before the storm hits.", 0.5)
        self.assertEqual(a + " " + b, "We need to move before the storm hits.")
        self.assertNotIn("bee", a)

    def test_never_breaks_contraction(self):
        a, b = split_text("And don't stop for anything.", 0.45)
        self.assertNotIn("don", (a + b).replace("don't", ""))

    def test_multiline_splits_on_lines(self):
        a, b = split_text("line one\nline two", 0.5)
        self.assertEqual((a, b), ("line one", "line two"))

    def test_empty(self):
        self.assertEqual(split_text("", 0.5), ("", ""))
        self.assertEqual(split_text("   ", 0.5), ("   ", ""))

    def test_weights_two_equal(self):
        parts = split_text_by_weights("Keep going, no matter what.", [1200, 1200])
        self.assertEqual(parts, ["Keep going,", "no matter what."])

    def test_weights_three(self):
        parts = split_text_by_weights("一二三，四五六，七八九。", [1, 1, 1])
        self.assertEqual(len(parts), 3)
        self.assertEqual("".join(p.replace(" ", "") for p in parts), "一二三，四五六，七八九。")

    def test_weights_single(self):
        self.assertEqual(split_text_by_weights("abc", [3]), ["abc"])

    def test_break_points_never_zero(self):
        self.assertNotIn(0, break_points("hello world"))
        self.assertNotIn(len("hello world"), break_points("hello world"))

    def test_choose_break_prefers_punctuation(self):
        text = "一二，三四五六七八。"
        idx = choose_break(text, 7)
        self.assertEqual(text[:idx], "一二，")

    def test_no_punctuation_cjk(self):
        a, b = split_text("这真是一段没有任何标点的中文句子", 0.5)
        self.assertEqual(a + b, "这真是一段没有任何标点的中文句子")
        self.assertTrue(a)
        self.assertTrue(b)


if __name__ == "__main__":
    unittest.main()
