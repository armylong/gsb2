# 装配三维标注（Assembly Labeler）

用 **TypeScript + Three.js** 从零搭的本地网页：给装配说明的三维示意图加注释。
机构全部由简单几何体拼出，重点不在建模，而在标注系统本身——

- 锚点固定在零件表面，**随父部件一起移动**（摆臂摆动、零件显隐都跟随）；
- 一批锚点挤近时，标签**互相避让并避开窗口边缘**，空间不足时按「锁定 > 优先级」
  保留，其余**收起并在侧栏报告**；
- 镜头绕到背面时用射线**识别被实体挡住的锚点**，贴在自己表面的锚点不会误判；
  被挡标记可开关，样式（虚线 + 斜纹 + 橙色）与可见标注明显区分；
- 缓慢旋转镜头时标签**保持稳定**（粘滞位 + 同侧优先），不会左右反复互换；
  突然换视角（预设、瞬移、快速拖拽）时**重新选位**；
- **点击标签选中对应零件**（零件高亮 + 脉冲标记）；隐藏零件、改优先级、缩窄窗口
  都会走同一套重排规则。

内置一个**刻意挤满一角的样例**（角座 + 5 颗螺栓 + 螺母 + 2 根销 + 垫片），
点「拥挤角落验收」即可观察收起与优先级行为。

---

## 运行

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

本地构建与预览：

```bash
npm run build      # tsc + vite build → dist/
npm run preview
```

单元测试（纯逻辑，无需浏览器）：

```bash
npm test
```

浏览器端自动化验收脚本（需要本机有 Playwright 的 Chromium；见下文）：

```bash
node tests/browser-check.mjs     # 截图 + 结构化报告 → /tmp/assembly-shots/
node tests/smoke.mjs             # 交互冒烟（点击标签/零件、锁定、隐藏、窄窗）
```

> 脚本默认访问 `http://127.0.0.1:5173/`，可用 `URL=...` 覆盖。

---

## 操作

| 操作 | 说明 |
| --- | --- |
| 拖拽 / 滚轮 / 右键 | 旋转 / 缩放 / 平移 |
| 点击标签 | 选中对应零件（侧栏行高亮、三维里显示包围盒与脉冲点） |
| 点击三维零件 | 同样选中；点空白处取消 |
| 标签右下角 🔒 / 侧栏锁按钮 | 锁定该标注（空间不足时最优先保留） |
| 侧栏 5 格优先级 | 1（参考）→ 5（关键+），数值越大越先保留 |
| 零件勾选框 | 隐藏/显示零件；隐藏后其锚点不参与遮挡与排布 |
| 「显示被遮挡的标注」 | 开关被挡标记；关闭后这些锚点不占排布空间 |
| 摆臂滑杆 / 自动缓慢摆动 | 验证锚点随父部件移动 |
| 「窄窗模拟」 | 把三维视口压到 360px，走与拖动窗口相同的重排路径 |
| 视角：正面 / 背面 / 侧面 / 拥挤角落 | 平滑球面过渡；过渡期间按「突然换视角」处理，重新选位 |

---

## 设计要点

### 1. 锚点与零件绑定

`src/scene/assembly.ts` 中的标注用**零件局部坐标**定义（`local`），
`AnchorSystem` 每帧通过 `part.group.localToWorld()` 解析世界坐标——
因此摆臂组里的夹头、连杆锚点会随摆臂一起转动，无需额外同步逻辑。

### 2. 标签排布 `src/core/layout.ts`

- 每个锚点生成 8 个方向 × 4 圈距离的候选位（环绕距离由近到远）。
- 按 **锁定 > 优先级 > 数据顺序** 排序，依次放置，先到先得。
- 因此空间不足时被收起的必然是排序靠后的项；结果里带 `stowed` 列表
  （含 `reason`），侧栏「已收起」面板直接展示。
- 标签矩形必须完整落在视口内且不压住 HUD 等固定区域。

### 3. 遮挡 `src/core/visibility.ts` + `src/scene/anchors.ts`

- 从镜头向锚点投射射线，**终点截到「锚点前一个表面容差」**：
  - 锚点正好贴在自己的表面：射线到不了表面，不会自遮挡 → `visible`；
  - 镜头绕到背面：先打到外壳 → 命中距离明显小于锚点距离 → `occluded`；
  - 锚点在镜头背后 → `behind`，不参与排布。
- 隐藏的零件会从遮挡体列表中移除，不会继续挡标注。
- 被挡标注：虚线边框 + 斜纹底 + 橙色引线；可在「显示规则」里整体关闭。

### 4. 稳定性 `src/core/stability.ts` + 粘滞位

- `ViewChangeTracker` 依据相机绕目标的朝向变化、平移、缩放和时间间隔，
  把每帧分类为 `none / smooth / jump`。
- **smooth**：沿用上一帧的 slot（粘滞）。沿用的 slot 若轻微出界，会先夹回视口内侧；
  必须换位时优先保持**同侧**（左/右不互换），再按引线长度选最近位置。
- **jump**（预设视角、快速拖拽、瞬移、缩放突变）：清空粘滞位，
  下一帧按新视角从零选位。
- 布局引擎是纯函数，`stickySlots` 由调用方决定是否传入，因而「是否重排」
  这一策略完全集中在一处。

### 5. 统一的规则入口

隐藏零件、改优先级、锁定、切换「显示被挡」、窗口尺寸变化，全部调用同一个
`resetLayout()` → `refreshLayout()` 管线；同一套排序与避让逻辑，不会出现
「某条路径漏排」的情况。

---

## 目录

```
index.html
src/
  main.ts                 应用装配、主循环、交互、调试接口 window.__assembly
  styles.css
  core/
    layout.ts             标签排布（纯函数，含优先级/收起/粘滞）
    visibility.ts         遮挡分类（纯函数）
    stability.ts          视角变化分类（纯函数）
  scene/
    assembly.ts           简单几何体拼出的机构 + 标注定义
    anchors.ts            锚点世界坐标/投影/遮挡
    cameraDirector.ts     预设视角与球面插值飞行
  ui/
    overlay.ts            DOM 标签 + SVG 引线
    sidebar.ts            侧栏（零件、标注、收起清单）
tests/
  layout.test.ts          排布：避让、边界、优先级、收起、粘滞、障碍
  visibility.test.ts      遮挡与视角分类
  browser-check.mjs       浏览器验收：截图 + 重叠/出界/收起统计
  smoke.mjs               浏览器交互冒烟
```

## 自动化验收接口

页面暴露 `window.__assembly`（仅用于调试/验收）：

```js
__assembly.snapshot()          // 每个锚点的 state / screen / rect / slot / placed / stowed
__assembly.setView('back')     // 'front' | 'back' | 'side' | 'crowd'
__assembly.setArmAngle(30)     // 摆臂角度（度）
__assembly.setNarrow(true)     // 窄窗模拟
__assembly.setShowOccluded(false)
__assembly.setPriority('corner_bolt_c', 5)
__assembly.setLock('corner_bolt_b', true)
__assembly.setPartVisible('housing', false)
__assembly.clickLabel('clamp_torque')
__assembly.clickPartAt(x, y)   // 视口像素坐标
__assembly.probe('shaft_clip') // 遮挡射线的命中零件与距离
```

`tests/browser-check.mjs` 会对每个视角检查：

- 已放置标签两两不重叠、全部落在视口内；
- 记录每个视角的 `placed / stowed / occluded` 数量；
- 模拟缓慢拖拽 90 帧，检查 slot 不出现 A→B→A 往返；
- 验证点击标签后 `#hud-selected` 与零件行高亮；
- 验证摆臂转动时锚点世界坐标与屏幕坐标同步变化。
