# audiostretch — 短环境音粒子拉伸试验台

把很短的 wav 环境音片段用粒子( granular )重叠相加的方式拉长，用来试听纹理是否会断。
纯 numpy 引擎 + PySide6 桌面界面，另附命令行自检。

## 安装与启动

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 桌面工具
.venv/bin/python -m audiostretch.app

# 一条可运行的验证命令(生成样例 -> 拉伸 -> 导出 -> 校验时长/主频/声道/削波)
.venv/bin/python -m audiostretch.cli --out /tmp/stretch_check.wav --demo-out /tmp/stretch_demo.wav
```

验证命令会打印 4 项 PASS/FAIL：导出时长(±一个窗口)、主频(目标 220Hz ±2%)、立体声声道数、无削波，全部通过退出码为 0。

## 功能对照

1. **选段与参数**：打开 WAV 或点「生成示例音 (220Hz)」；在时间图上拖动选段，窗口(ms)、重叠(%)、拉伸倍率均可调。
2. **时间图**：上图显示原音波形与选段高亮，点击任意位置定位试听原音；渲染后下图显示输出波形与粒子分布(橙线)，同样可点击定位试听结果。
3. **随机与边缘**：固定随机种子(同种子输出逐采样一致)，抖动只加在源取音位置、幅度可调；分析粒子等距铺满选段(末粒子对齐选段尾，全段覆盖)，输出两端加短余弦淡入淡出。
4. **具体限制**：窗口 < 64 采样、选段短于窗口、重叠导致分析步进 < 32 采样(约重叠 > 1−32/窗口)都会给出含具体数值和调整建议的提示；左右声道共用同一取音位置，立体声对应关系不变。
5. **导出与样例**：按指定时长导出 16bit WAV(超过自然拉伸长度时循环取粒子)；内置 220Hz 固定音高样例用于校验时间与主频。

## 文件

- `audiostretch/core.py` — 粒子拉伸引擎与参数校验
- `audiostretch/synth.py` — 样例合成、主频测量
- `audiostretch/wavio.py` — WAV 读写(标准库 wave)
- `audiostretch/app.py` — PySide6 桌面界面
- `audiostretch/cli.py` — 命令行自检
