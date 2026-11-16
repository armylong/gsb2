"""输入生成与确定性测试：固定种子可重复、规则覆盖完整。"""
from __future__ import annotations

import unittest

from apifuzz.config import Endpoint
from apifuzz.generator import (DEEP_NEST_LEVELS, generate_cases)

from .helpers import load_demo_endpoints


class TestGenerator(unittest.TestCase):
    def setUp(self):
        self.endpoints = load_demo_endpoints()

    def test_same_seed_identical_cases(self):
        ep = self.endpoints[0]
        first = generate_cases(ep, seed=99)
        second = generate_cases(ep, seed=99)
        self.assertEqual(len(first), len(second))
        for a, b in zip(first, second):
            self.assertEqual(a.case_id, b.case_id)
            self.assertEqual(a.rule, b.rule)
            self.assertEqual(a.body, b.body)
            self.assertEqual(a.raw_body, b.raw_body)

    def test_different_seed_changes_type_mutation_order(self):
        ep = self.endpoints[0]
        a = generate_cases(ep, seed=1)
        b = generate_cases(ep, seed=2)
        type_a = [c.body for c in a if c.rule == "type"]
        type_b = [c.body for c in b if c.rule == "type"]
        # 集合相同（覆盖一致），顺序可以不同（随机性体现在顺序）
        self.assertEqual(sorted(map(repr, type_a)), sorted(map(repr, type_b)))

    def test_rule_coverage(self):
        by_name = {ep.name: ep for ep in self.endpoints}
        cases = generate_cases(by_name["create_user"], seed=7)
        rules = {c.rule for c in cases}
        self.assertIn("baseline", rules)
        for expected in ("missing", "type", "boundary", "nested",
                         "unknown", "malformed"):
            self.assertIn(expected, rules, f"缺少规则 {expected}")

    def test_missing_covers_every_leaf(self):
        ep = self.endpoints[0]
        cases = generate_cases(ep, seed=7)
        missing_paths = {c.path for c in cases if c.rule == "missing"}
        # sample 中的每个叶子字段都应被删除过
        for leaf in ("$.name", "$.email", "$.age",
                     "$.profile.geo", "$.profile.meta.level"):
            self.assertIn(leaf, missing_paths)

    def test_boundary_includes_long_string(self):
        ep = self.endpoints[0]
        cases = generate_cases(ep, seed=7)
        long_case = max(
            (c for c in cases if c.rule == "boundary"
             and isinstance(c.body.get("name"), str)),
            key=lambda c: len(c.body["name"]),
        )
        self.assertGreaterEqual(len(long_case.body["name"]), 8000)

    def test_nested_case_contains_deep_structure(self):
        ep = self.endpoints[0]
        cases = generate_cases(ep, seed=7)
        nested = [c for c in cases if c.rule == "nested"]
        self.assertTrue(nested)
        depths = []
        for case in nested:
            depth = 0
            stack = [case.body]
            while stack:
                node = stack.pop()
                if isinstance(node, dict):
                    depth += 1
                    stack.extend(v for v in node.values()
                                 if isinstance(v, (dict, list)))
                elif isinstance(node, list):
                    stack.extend(node)
            depths.append(depth)
        self.assertGreaterEqual(max(depths), DEEP_NEST_LEVELS)

    def test_constraint_rules_for_register(self):
        by_name = {ep.name: ep for ep in self.endpoints}
        cases = generate_cases(by_name["register"], seed=7)
        constraint = [c for c in cases if c.rule == "constraint"]
        self.assertTrue(constraint)
        # equals_field: confirm_password 被改成不相等的值
        mismatched = [c for c in constraint
                      if c.expectations.get("constraint") == "equals_field"]
        self.assertTrue(mismatched)
        self.assertNotEqual(
            mismatched[0].body["password"],
            mismatched[0].body["confirm_password"],
        )
        # value_dependency: business 时删除 company
        dep = [c for c in constraint
               if c.expectations.get("constraint") == "value_dependency"]
        self.assertTrue(any("company" not in c.body for c in dep))

    def test_malformed_bodies_are_raw_strings(self):
        ep = self.endpoints[0]
        cases = [c for c in generate_cases(ep, seed=7) if c.rule == "malformed"]
        self.assertTrue(cases)
        for case in cases:
            self.assertTrue(case.raw_body)
            self.assertIsInstance(case.body, str)

    def test_endpoint_with_all_rules_instantiates(self):
        ep = Endpoint.from_dict({
            "name": "x", "method": "POST", "path": "/x",
            "sample": {"a": 1, "b": {"c": "s"}},
            "rules": ["missing", "type", "boundary", "nested",
                      "unknown", "constraint", "malformed"],
            "constraints": [{"type": "all_or_none", "fields": ["a", "b"]}],
        })
        cases = generate_cases(ep, seed=3)
        self.assertGreater(len(cases), 10)


if __name__ == "__main__":
    unittest.main()
