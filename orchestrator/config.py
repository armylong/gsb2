"""流程配置加载与校验。

配置为 JSON 文件, 结构示例::

    {
      "name": "demo_flow",
      "settings": {"max_parallel": 4},
      "resources": {"api_quota": 2},
      "tasks": [
        {
          "name": "fetch_a",
          "command": "python3 demo/collector.py ok --duration 3",
          "timeout": 30,
          "retries": 1,
          "retry_delay": 1.0,
          "needs": {"api_quota": 1},
          "depends_on": []
        }
      ]
    }

加载时校验: 缺失依赖、依赖环、永远无法满足的资源需求。
"""

import hashlib
import json


class ConfigError(Exception):
    """配置非法时抛出, 信息面向用户。"""


class Task:
    def __init__(self, name, command, timeout, retries, retry_delay, needs, depends_on):
        self.name = name
        self.command = command
        self.timeout = timeout
        self.retries = retries
        self.retry_delay = retry_delay
        self.needs = needs
        self.depends_on = depends_on

    def snapshot(self):
        return {
            "name": self.name,
            "command": self.command,
            "timeout": self.timeout,
            "retries": self.retries,
            "retry_delay": self.retry_delay,
            "needs": dict(self.needs),
            "depends_on": list(self.depends_on),
        }


class Flow:
    def __init__(self, name, max_parallel, resources, tasks, raw):
        self.name = name
        self.max_parallel = max_parallel
        self.resources = resources          # 资源名 -> 容量
        self.tasks = tasks                  # 任务名 -> Task
        self.raw = raw                      # 原始配置 dict, 用于快照
        # 直接下游: 任务名 -> [下游任务名]
        self.downstream = {n: [] for n in tasks}
        for t in tasks.values():
            for dep in t.depends_on:
                self.downstream[dep].append(t.name)

    def config_hash(self):
        blob = json.dumps(self.raw, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()[:16]

    def affected_set(self, roots):
        """roots 及其全部传递下游。"""
        affected = set()
        stack = [r for r in roots if r in self.tasks]
        while stack:
            cur = stack.pop()
            if cur in affected:
                continue
            affected.add(cur)
            stack.extend(self.downstream.get(cur, ()))
        return affected


def _err(source, msg):
    return ConfigError("%s: %s" % (source, msg))


def validate_flow(data, source="<config>"):
    if not isinstance(data, dict):
        raise _err(source, "配置必须是 JSON 对象")
    name = data.get("name")
    if not name or not isinstance(name, str):
        raise _err(source, "缺少流程名称 name")

    settings = data.get("settings") or {}
    try:
        max_parallel = int(settings.get("max_parallel", 4))
    except (TypeError, ValueError):
        raise _err(source, "settings.max_parallel 必须是正整数")
    if max_parallel <= 0:
        raise _err(source, "settings.max_parallel 必须是正整数")

    resources = {}
    for rname, cap in (data.get("resources") or {}).items():
        try:
            cap = int(cap)
        except (TypeError, ValueError):
            raise _err(source, "资源 %s 的容量必须是正整数" % rname)
        if cap <= 0:
            raise _err(source, "资源 %s 的容量必须是正整数" % rname)
        resources[rname] = cap

    raw_tasks = data.get("tasks")
    if not raw_tasks or not isinstance(raw_tasks, list):
        raise _err(source, "至少需要一个任务 (tasks 为非空数组)")

    tasks = {}
    for i, t in enumerate(raw_tasks):
        where = "%s 第 %d 个任务" % (source, i + 1)
        if not isinstance(t, dict):
            raise ConfigError(where + ": 任务必须是对象")
        tname = t.get("name")
        if not tname or not isinstance(tname, str):
            raise ConfigError(where + ": 缺少任务名 name")
        if tname in tasks:
            raise ConfigError(where + ": 任务名 %s 重复" % tname)
        command = t.get("command")
        if not command or not isinstance(command, str):
            raise ConfigError("任务 %s: 缺少执行命令 command" % tname)
        try:
            timeout = float(t.get("timeout", 60))
            retries = int(t.get("retries", 0))
            retry_delay = float(t.get("retry_delay", 1.0))
        except (TypeError, ValueError):
            raise ConfigError("任务 %s: timeout/retries/retry_delay 必须是数字" % tname)
        if timeout <= 0:
            raise ConfigError("任务 %s: timeout 必须大于 0" % tname)
        if retries < 0:
            raise ConfigError("任务 %s: retries 不能为负" % tname)
        if retry_delay < 0:
            raise ConfigError("任务 %s: retry_delay 不能为负" % tname)

        needs = {}
        for rname, amount in (t.get("needs") or {}).items():
            try:
                amount = int(amount)
            except (TypeError, ValueError):
                raise ConfigError("任务 %s: 资源 %s 的占用量必须是正整数" % (tname, rname))
            if amount <= 0:
                raise ConfigError("任务 %s: 资源 %s 的占用量必须是正整数" % (tname, rname))
            if rname not in resources:
                raise ConfigError("任务 %s: 需要未定义的资源 %s" % (tname, rname))
            if amount > resources[rname]:
                raise ConfigError(
                    "任务 %s: 需要资源 %s x%d, 超过容量 %d, 永远无法满足"
                    % (tname, rname, amount, resources[rname]))
            needs[rname] = amount

        depends_on = t.get("depends_on") or []
        if not isinstance(depends_on, list) or not all(isinstance(d, str) for d in depends_on):
            raise ConfigError("任务 %s: depends_on 必须是任务名数组" % tname)
        depends_on = list(dict.fromkeys(depends_on))  # 去重保序
        if tname in depends_on:
            raise ConfigError("任务 %s: 不能依赖自身" % tname)

        tasks[tname] = Task(tname, command, timeout, retries, retry_delay, needs, depends_on)

    # 缺失依赖
    for t in tasks.values():
        for dep in t.depends_on:
            if dep not in tasks:
                raise _err(source, "任务 %s 依赖了不存在的任务 %s" % (t.name, dep))

    # 依赖环检测 (三色 DFS)
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in tasks}
    stack = []

    def dfs(node):
        color[node] = GRAY
        stack.append(node)
        for dep in tasks[node].depends_on:
            if color[dep] == GRAY:
                cycle = stack[stack.index(dep):] + [dep]
                raise _err(source, "依赖存在环: " + " -> ".join(cycle))
            if color[dep] == WHITE:
                dfs(dep)
        stack.pop()
        color[node] = BLACK

    for n in tasks:
        if color[n] == WHITE:
            dfs(n)

    return Flow(name, max_parallel, resources, tasks, data)


def load_flow(path):
    with open(path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            raise ConfigError("%s: JSON 解析失败: %s" % (path, e))
    return validate_flow(data, source=path)
