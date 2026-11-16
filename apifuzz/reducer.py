"""失败样本缩减（delta debugging 风格）。

对每个失败分组的代表样本尝试：

1. 删除无关字段（任意层级）
2. 缩短字符串内容（长字符串逐档缩短）
3. 简化嵌套（深层嵌套逐层拍平、容器退化为标量）

接受候选的唯一标准：**用缩减后的请求重新执行，仍得到同一指纹的失败**。
服务恢复正常（verdict 改变/变 OK）、超时或任何传输异常都不接受——
超时不是"成功缩小"，而是无法判断，候选被拒绝并在记录中注明原因。

每次缩减都会留下 before/after 与尝试次数，最终样本再做一次独立复现验证。
"""
from __future__ import annotations

import copy
from typing import Any, Callable, Dict, List, Optional, Tuple

from .config import Endpoint
from .grouping import fingerprint
from .models import Case, CaseResult

TrialFn = Callable[[Case], CaseResult]

_STRING_STEPS = (8193, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 1, 0)
_MAX_PASSES = 8
_MAX_TRIALS = 120


class Reducer:
    def __init__(self, trial: TrialFn):
        self.trial = trial

    def reduce(self, ep: Endpoint, representative: CaseResult) -> Dict[str, Any]:
        original = representative.case
        target_fp = representative.fingerprint or fingerprint(representative)
        stages: List[Dict[str, Any]] = []
        accepted = 0
        rejected = 0
        inconclusive = 0

        if original.raw_body:
            current, s_stats = self._reduce_raw(ep, original, target_fp)
        else:
            current, s_stats = self._reduce_structured(ep, original, target_fp)
        accepted += s_stats["accepted"]
        rejected += s_stats["rejected"]
        inconclusive += s_stats["inconclusive"]
        stages.extend(s_stats["stages"])

        # 最终样本必须独立再验证一次，仍复现同一指纹才算缩减成功。
        # 最终验证本身超时/传输异常属于"无法判断"，不得视为缩减成功。
        final_result = self.trial(current)
        final_inconclusive = final_result.verdict in (
            "TRANSPORT_ERROR", "INDETERMINATE", "SCOPE_BLOCKED")
        final_fp = final_result.fingerprint or fingerprint(final_result)
        reproduced = (not final_inconclusive
                      and final_fp == target_fp
                      and final_result.is_anomaly())
        if not reproduced or inconclusive > 0:
            # 最终验证未通过，或缩减过程中出现过无法判断的候选：
            # 回退到原始样本，绝不把未被完整证实的样本当结果
            current = original
            final_result = representative
            reproduced = False

        return {
            "target_fingerprint": target_fp,
            "final_fingerprint": final_fp,
            "reproduced": reproduced,
            "final_verdict": final_result.verdict,
            "trials_accepted": accepted,
            "trials_rejected": rejected,
            "trials_inconclusive": inconclusive,
            "trials_total": accepted + rejected + inconclusive,
            "stages": stages,
            "before": self._case_snapshot(original),
            "after": self._case_snapshot(current),
            "final_evidence": final_result.evidence.to_dict(),
        }

    # ---------- 结构化 JSON 缩减 ----------

    def _reduce_structured(self, ep: Endpoint, original: Case, target_fp: str
                           ) -> Tuple[Case, Dict[str, Any]]:
        current = copy.deepcopy(original)
        stats = {"accepted": 0, "rejected": 0, "inconclusive": 0, "stages": []}
        seen: set = set()

        for pass_no in range(1, _MAX_PASSES + 1):
            changed = False
            candidates = self._candidates(current)
            for desc, candidate_body in candidates:
                key = repr(candidate_body)
                if key in seen:
                    continue
                seen.add(key)
                trial_case = Case(
                    case_id=f"{current.case_id}#reduce",
                    endpoint=current.endpoint, rule=current.rule,
                    path=current.path, body=candidate_body,
                    raw_body=False, url_params=dict(current.url_params),
                    headers=dict(current.headers),
                    expectations=dict(current.expectations),
                )
                outcome = self._evaluate(trial_case, target_fp)
                if outcome == "accepted":
                    stats["accepted"] += 1
                    changed = True
                    current = trial_case
                    stats["stages"].append({
                        "pass": pass_no, "action": desc,
                        "result": "accepted",
                        "size": self._size(candidate_body),
                    })
                    break  # 重新从新样本生成候选
                if outcome == "inconclusive":
                    stats["inconclusive"] += 1
                    stats["stages"].append({
                        "pass": pass_no, "action": desc,
                        "result": "inconclusive",
                        "reason": "传输异常/超时，无法判断，候选已拒绝",
                    })
                else:
                    stats["rejected"] += 1
                if stats["accepted"] + stats["rejected"] + stats["inconclusive"] >= _MAX_TRIALS:
                    return current, stats
            if not changed:
                break
        return current, stats

    def _candidates(self, case: Case) -> List[Tuple[str, Any]]:
        out: List[Tuple[str, Any]] = []
        body = case.body
        # 1) 删除任意层级的键
        for path in self._all_dict_paths(body):
            candidate = copy.deepcopy(body)
            try:
                self._delete(candidate, path)
            except (KeyError, TypeError):
                continue
            out.append((f"delete {path}", candidate))
        # 2) 缩短长字符串
        for path, value in self._all_strings(body):
            if len(value) <= 1:
                continue
            for length in _STRING_STEPS:
                if length < len(value):
                    candidate = copy.deepcopy(body)
                    self._set(candidate, path, "A" * length)
                    out.append((f"shorten {path} -> len {length}", candidate))
                    break
        # 3) 简化嵌套
        for path, value in self._all_containers(body):
            if isinstance(value, dict) and value:
                candidate = copy.deepcopy(body)
                first_val = next(iter(value.values()))
                self._set(candidate, path, first_val)
                out.append((f"flatten dict {path}", candidate))
            if isinstance(value, list) and value:
                candidate = copy.deepcopy(body)
                self._set(candidate, path, value[0])
                out.append((f"shrink list {path}", candidate))
        return out

    # ---------- 畸形报文缩减 ----------

    def _reduce_raw(self, ep: Endpoint, original: Case, target_fp: str
                    ) -> Tuple[Case, Dict[str, Any]]:
        stats = {"accepted": 0, "rejected": 0, "inconclusive": 0, "stages": []}
        current = copy.deepcopy(original)
        text = current.body
        while len(text) > 1:
            cut = max(1, len(text) // 2)
            new_text = text[:-cut]
            trial_case = Case(
                case_id=f"{current.case_id}#reduce", endpoint=current.endpoint,
                rule=current.rule, path=current.path, body=new_text,
                raw_body=True, url_params=dict(current.url_params),
                headers=dict(current.headers),
                expectations=dict(current.expectations),
            )
            outcome = self._evaluate(trial_case, target_fp)
            action = f"truncate raw body {len(text)} -> {len(new_text)}"
            if outcome == "accepted":
                stats["accepted"] += 1
                text = new_text
                current = trial_case
                stats["stages"].append({"pass": 1, "action": action,
                                        "result": "accepted", "size": len(text)})
            elif outcome == "inconclusive":
                stats["inconclusive"] += 1
                stats["stages"].append({"pass": 1, "action": action,
                                        "result": "inconclusive",
                                        "reason": "传输异常/超时，候选已拒绝"})
                break
            else:
                stats["rejected"] += 1
                break
        return current, stats

    # ---------- 候选评估 ----------

    def _evaluate(self, trial_case: Case, target_fp: str) -> str:
        result = self.trial(trial_case)
        if result.verdict in ("TRANSPORT_ERROR", "INDETERMINATE", "SCOPE_BLOCKED"):
            return "inconclusive"
        fp = result.fingerprint or fingerprint(result)
        return "accepted" if fp == target_fp and result.is_anomaly() else "rejected"

    # ---------- 路径遍历工具 ----------

    def _all_dict_paths(self, obj: Any, prefix: str = "$") -> List[str]:
        paths = []
        if isinstance(obj, dict):
            for key in obj:
                paths.append(f"{prefix}.{key}")
                paths.extend(self._all_dict_paths(obj[key], f"{prefix}.{key}"))
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                paths.extend(self._all_dict_paths(item, f"{prefix}[{i}]"))
        return paths

    def _all_strings(self, obj: Any, prefix: str = "$") -> List[Tuple[str, str]]:
        out = []
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, str):
                    out.append((f"{prefix}.{k}", v))
                else:
                    out.extend(self._all_strings(v, f"{prefix}.{k}"))
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                out.extend(self._all_strings(item, f"{prefix}[{i}]"))
        return out

    def _all_containers(self, obj: Any, prefix: str = "$"
                        ) -> List[Tuple[str, Any]]:
        out = []
        if isinstance(obj, dict):
            for k, v in obj.items():
                p = f"{prefix}.{k}"
                if isinstance(v, (dict, list)) and v:
                    out.append((p, v))
                    out.extend(self._all_containers(v, p))
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                p = f"{prefix}[{i}]"
                if isinstance(item, (dict, list)) and item:
                    out.append((p, item))
                    out.extend(self._all_containers(item, p))
        return out

    @staticmethod
    def _navigate(obj: Any, path: str) -> Tuple[Any, Any]:
        """返回 (父容器, 最后一段 key/index)。"""
        tokens = path[2:].split(".") if path.startswith("$.") else path.split(".")
        cur = obj
        for token in tokens[:-1]:
            if "[" in token:
                name, idx = token[:-1].split("[")
                cur = cur[name][int(idx)]
            else:
                cur = cur[token]
        last = tokens[-1]
        if "[" in last:
            name, idx = last[:-1].split("[")
            return cur[name], int(idx)
        return cur, last

    def _get(self, obj: Any, path: str) -> Any:
        parent, key = self._navigate(obj, path)
        return parent[key]

    def _set(self, obj: Any, path: str, value: Any) -> None:
        parent, key = self._navigate(obj, path)
        parent[key] = value

    def _delete(self, obj: Any, path: str) -> None:
        parent, key = self._navigate(obj, path)
        if isinstance(key, int):
            parent.pop(key)
        else:
            parent.pop(key)

    @staticmethod
    def _size(body: Any) -> int:
        import json
        try:
            return len(json.dumps(body, ensure_ascii=False))
        except (TypeError, ValueError):
            return len(str(body))

    @staticmethod
    def _case_snapshot(case: Case) -> Dict[str, Any]:
        return {
            "case_id": case.case_id,
            "rule": case.rule,
            "path": case.path,
            "raw_body": case.raw_body,
            "body": case.body,
            "url_params": case.url_params,
            "headers": case.headers,
        }
