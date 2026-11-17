"""uvcheck — 本地贴图坐标（UV）检查工具。

模块组成：
- parser:  三角网格 OBJ / 贴图坐标解析（容错，逐问题记录）
- analyzer: 越界、重叠、拉伸、退化、缺 UV 分析
- server:  仅依赖标准库的本地 HTTP 服务
- png:     最小 PNG 编码器（生成程序贴图样例）
- samples: 程序化生成带已知缺陷的 OBJ 与贴图
"""

__version__ = "1.0.0"
