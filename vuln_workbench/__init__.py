"""本地漏洞复现证据工作台 (vuln_workbench)。

只做静态整理与展示:
- 不发起任何网络请求 (仅绑定 127.0.0.1 的本地 HTTP 界面)
- 不执行导入文件中的任何命令 (无 subprocess/eval/exec/pickle)
- 导入的复现包一律按不可信数据处理
"""

__version__ = "1.0.0"
PROJECT_FORMAT = "vuln-workbench-project"
PROJECT_VERSION = 1
