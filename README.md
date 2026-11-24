# 滚动快门 / 全局快门合成模拟器

本地用 Python + numpy + PySide6 模拟滚动快门（rolling shutter）与全局快门
（global shutter）对同一段匀速运动的成像差异，包括长曝光拖尾、逐行读出剪切、
短闪光只照亮部分行等现象。全部渲染为确定性的解析式计算，无随机采样。

## 安装与启动

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run_gui.py
```

## 目录结构

```
rolling_shutter/
  model.py          时序模型与逐像素渲染（纯 numpy，可独立测试/复用）
  presets.py        两个内置可复现实验：快移、短闪光
  export.py         自写 PNG 编码器 + zip 导出与重新打开校验
  cli.py            命令行导出/校验
  gui/              PySide6 界面
run_gui.py          图形界面入口
tests/              20 个数值/导出/GUI 测试（GUI 测试离屏运行）
```

## 时间模型（可逐行查询）

所有时间为相对短片起点的绝对秒，第 n 帧名义起点 `t0 = n / fps`。

- **全局快门**：所有行共用曝光窗 `[t0, t0+E]`，读出在曝光结束后排队，
  成像与读出过程无关。
- **滚动快门**：第 r 行在读出时刻采样，曝光窗 `[readout(r)-E, readout(r)]`；
  `readout(r)` 在 `[t0, t0+R]` 内按读出方向线性分布，R 为总读出时间。

每个像素在曝光窗内被运动物体覆盖的时间占比用常数速度下的解析解求出，
物体部分移出画面时由区间裁剪自然处理，不会越界。

## 界面功能对照需求

1. **两个不同速度物体 + 固定标尺**：两个色条各自可设初始位置、速度、宽度、
   行范围；画面上下边缘有固定像素标尺。读出方向、总读出时间 R、曝光时间 E
   均可调。
2. **按真实帧时间生成两种短片**：两种模式共用同一份 `SimParams` 与帧时间；
   每行曝光窗/读出时刻保存在 `Clip.windows`、`Clip.readout_starts`，
   在时序图上点任意行即可查询。
3. **短闪光模式**：闪光是绝对时刻区间，时序图以黄色竖带显示；滚动快门下
   只有曝光窗与闪光相交的行被照亮，行均值曲线与画面像素一一对应
   （`row_means` 直接由帧像素求均值）。
4. **逐帧对比与陈旧标记**：左右两画面可“锁定同一时刻”联动；取消勾选后
   两侧可停在不同帧时刻，重新勾选会对齐回滚动侧。参数一旦改动，旧帧
   立即叠加“旧帧·参数已改动”遮罩并停止播放，直到重新生成；迟到的过期
   渲染结果会按令牌丢弃。每次渲染带 SHA-256 参数指纹（画面左下角显示），
   防止把旧结果错标为当前设置。
5. **导出与自检**：导出任一组短片为 zip（无损 PNG 帧 + manifest.json +
   逐行 `row_windows.csv`），导出后自动重新打开校验；命令行也可复核。

## 内置实验

| key | 实验 | 关键设置 | 预期现象 |
|---|---|---|---|
| `fast_motion` | 快移 | R=33.3ms 满帧读出，E=30ms，物体 600/260 px/s | 长曝光拖尾；滚动快门下物体上下行错位（剪切），全局快门无错位 |
| `flash` | 短闪光 | 3ms 闪光始于 0.410s，E=20ms | 滚动快门仅中部约 2/3 行被照亮，全局快门整帧均匀照亮 |

## 命令行

```bash
# 导出（fast 是 fast_motion 的别名）
.venv/bin/python -m rolling_shutter.cli export fast  --mode rolling -o /tmp/fast.zip
.venv/bin/python -m rolling_shutter.cli export flash --mode global  -o /tmp/flash.zip

# 重新打开导出包核对：zip 完整性、PNG 尺寸、帧数、帧时间单调、曝光时长、指纹
.venv/bin/python -m rolling_shutter.cli verify /tmp/fast.zip
```

`manifest.json` 内含 fps、帧周期、总时长、曝光/读出时间、每帧起点、
像素宽高与帧数，时间与尺寸均可由文件本身核对。

## 测试

```bash
.venv/bin/python -m unittest discover -s tests -v
```

覆盖：两种快门的时序几何、读出方向、闪光部分照亮与逐行几何一致性、
边缘出入画裁剪、拖尾宽度随曝光增长、滚动剪切、确定性与参数指纹、
导出包往返与篡改检测。
