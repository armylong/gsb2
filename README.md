# 本地口述音频停顿整理工具

一个纯本地（无网络、无外部服务）的停顿整理工具：读一条短 WAV 和一份带**原录音位置**
的标注，在真实波形上手调修改区，给每处写上**想保留的停顿长度**，只对**手工确认过**
的区间做缩短，并保留原声 ↔ 成品的完整位置对照。

技术栈：Python 3.10+ / PySide6 / numpy，WAV 只用标准库 `wave` 读写，不依赖 scipy。

---

## 1. 它保证什么（对应需求）

1. **真实波形 + 手调区间 + 每处保留长度**
   - 按像素列抽 min/max 峰绘制真实波形（不是示意图），滚轮缩放、中键/Shift 拖动平移。
   - 拖区间两边的手柄改起止、拖区间整体平移、空白处框选新建、Delete 删除。
   - 每个区间可单独填写「保留(ms)」，也可在右侧表格直接改采样坐标。

2. **冲突可见且不会扣两遍**
   - 两个修改区**首尾挨住（end == start）或相互重叠**即判冲突，相关区间整体冻结
     （红色「冲突·不动」），状态栏列出每一对，拼接时整段跳过。
   - 区间长度**不足想保留的长度**时原样放过（黄色「太短·放过」），不做任何处理。

3. **只在选中的停顿里合接，过渡不吃响声**
   - 等功率交叉淡变（equal-power crossfade）的两个源块**严格限制在选中区间内部**：
     区间外的样本逐帧原样复制，不会被淡变吃掉。
   - 过渡长度受保留段可用空间限制，超限时自动缩短并在告警列/tooltip 说明；
     保留 0ms 时硬切（成品视图用红三角标出），没有过渡空间时保留样本原样相接。

4. **原声与成品都能在指针附近试听，并双向定位**
   - 两个视图各自「试听指针附近」按钮（默认前 1s 到后 1.5s 的窗口），双击波形同义。
   - 点成品：普通帧映射回**一个**原声位置；落在交叉淡变上时映射回**两个**原声位置，
     原声视图绿色虚线框高亮来源。
   - 点原声：落在被删段里时，原声与成品视图都给出**红色**反馈，并指向对应拼接点；
     成品视图里被删标注点画成红色虚线 + 叉号 +「标签(已删)」。

5. **导出 WAV + 重写标注 + 位置对照**
   - `<base>.wav`：成品（16-bit PCM，采样率/声道与原声一致）。
   - `<base>.annotations.json`：未删标注按成品坐标重写；落在被删段里的点单列
     `deleted_marks` 供核对，**邻近未删的点不会跟着删**。
   - `<base>.map.json` / `<base>.map.csv`：逐段位置账本（原样段 / 交叉淡变 / 删除段，
     含原声与成品两侧的采样序号和秒数）。

---

## 2. 安装与运行

```bash
# 一次性建环境 + 装依赖 + 生成示例 + 跑全部验证
./scripts/setup_and_test.sh

# 启动 GUI（不带参数开空窗口，工具栏打开 WAV；同目录有同名 .annotations.json 会自动带上）
./scripts/run_gui.sh
./scripts/run_gui.sh examples/short_gap.wav examples/short_gap.annotations.json

# 只（重新）生成内置示例
.venv/bin/python -I -m pause_editor --make-examples examples
```

> 关于隔离模式：脚本统一用 `python -I` 运行，并把本包以可编辑方式装进 venv
> （`.pth` 位于 venv 的 site-packages 内，`-I` 仍会读取）。这样处理来自其它目录的
> WAV/标注时，不会把数据目录塞进 `sys.path`，避免数据目录里出现同名模块
> （如 `json.py`）被误导入。

---

## 3. 标注文件格式

UTF-8 JSON，位置以**采样序号**为权威值，`time_s` 仅作人读校验；只给 `time_s` 也能加载
（按 WAV 采样率换算）。标注里的 `sample_rate` 必须与 WAV 一致，否则报错。

```json
{
  "sample_rate": 16000,
  "marks": [
    {"label": "M1", "sample": 800, "time_s": 0.05}
  ],
  "regions": [
    {"start": 3200, "end": 4800, "keep_ms": 80.0,
     "enabled": true, "note": "第一处停顿"}
  ]
}
```

导出的标注把存活点放进 `marks`（带 `src_sample` 原位置），被删点放进
`deleted_marks`（含 `in_region_index`）。

---

## 4. 内置示例与本地验证

`examples/` 由固定随机种子合成，三个场景覆盖关键路径：

| 示例 | 场景 | 预期 |
|---|---|---|
| `short_gap` | 短间隔：正常缩短 / 保留需求超区间而放过 / 保留 0ms 硬切；M2 落在被删段 | 状态 `edit/too_short/edit`，M2 进 `deleted_marks` |
| `adjacent` | 四个区间两两重叠或首尾挨住 | 全部 `conflict` 冻结，成品与原声**逐帧相同、等长** |
| `stereo_onsets` | 左右声道响点错开，只删双声道都静音的段 | 全部高能量帧逐帧保留，双声道不变 |

验证命令（期望值在 `verify.py` 里**独立计算**，不拿引擎输出自证）：

```bash
# 无界面核心验证：冲突、覆盖完备性、逐帧保留、能量守恒、采样数、标注时刻、WAV 往返、导出
.venv/bin/python -I -m pause_editor.verify --examples examples

# 追加 Qt offscreen GUI 冒烟（主窗口载入 + 导出）
QT_QPA_PLATFORM=offscreen .venv/bin/python -I -m pause_editor.verify --examples examples --gui-smoke

# GUI 交互冒烟：模拟框选/拖边/冲突/双向定位/表格编辑/Delete 键
QT_QPA_PLATFORM=offscreen .venv/bin/python -I -m pause_editor.gui_smoke
```

验证会显式核对：成品采样数 == 独立估算值、账本对原声无遗漏且无重叠覆盖、
标注点映射后样本逐帧相等、等功率淡变中点能量守恒、被删标注单独列出而邻近点保留。

---

## 5. 拼接模型（为什么响声不会被吃掉）

对一个状态为「执行」的区间 `[start, end)`、保留 `keep` 帧、单侧淡变 `k` 帧：

```
原声:  ...[start |<-- 头部保留 half 帧 -->|<-- 删除 -->|<-- 尾部保留 -->| end]...
                          \ 末 k 帧 fade-out /      \ 首 k 帧 fade-in /
成品:  ... 头部保留(去末k) + [fade-out ⊕ fade-in](等功率叠加, 共 k 帧) + 尾部保留(去首k) ...
```

- 淡变块全部取自区间内部，区间边界外的样本走 `keep` 段逐帧复制；
- `k = min(请求过渡, half, keep-half)`，所以过渡永远放得进保留段；
- 删除段 `[head_end, tail_start)` 与原样段、淡变块三者不相交且并集铺满整个原声，
  这是双向映射正确性的根基，验证里有专门的覆盖完备性检查。

---

## 6. 代码结构

```
pause_editor/
├── wavfile.py      # WAV 读写 (8/16/24/32-bit PCM), 内部统一 float64 [-1,1]
├── model.py        # 冲突检测、计划裁决、拼接引擎、原声<->成品双向映射 (无 Qt)
├── annotations.py  # 标注 JSON、重写标注、位置对照 JSON/CSV
├── examples.py     # 三个内置示例的固定种子合成
├── player.py       # QAudioSink 拉模式试听 (只播指针附近窗口)
├── waveform.py     # 波形/区间/标注/反馈绘制与鼠标交互
├── main_window.py  # 主窗口: 载入、编辑、拼接、联动、导出
├── verify.py       # 无界面核心验证 (70 项断言)
└── gui_smoke.py    # Qt offscreen 交互冒烟
```
