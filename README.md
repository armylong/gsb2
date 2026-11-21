# 视锥剔除验证台 · Frustum Culling Lab

用 TypeScript + Three.js 搭的可交互实验台，回答一个具体问题：
**镜头外的摆件，是否真的不会被提交绘制（draw call）？**

不依赖 Three.js 自带的黑盒剔除，自己实现一套视锥/包围体判定，并保留
Three.js 原生 `frustumCulled` 作为对照，再用一套独立推导的视锥数学交叉校验。

---

## 它验证了什么

1. **多组可移动摆件 + 可调视锥观察相机**
   - 6 个组、共 24 个摆件（盒/球/锥/八面体/环面），由固定随机种子 `14373` 程序生成，无外部资源。
   - 观察相机的 `fov / near / far` 用滑杆实时调整；位置可被固定路径驱动。
2. **第二台总览相机**
   - 从外部同时看到「观察相机的视锥线框」「每个组/摆件的包围球与包围盒」「剔除状态与原因标签」。
   - 绿 = 完全可见，琥珀 = 边界交叉，红 = 出界（并标注被哪一个面拒绝：`left/right/top/bottom/near/far`）。
3. **逐物件判定 vs 按组判定**
   - 逐物件：每个 mesh 用自己的包围球独立判定。
   - 按组：组整体 `out` 直接跳过子筛选；组 `in` 整组提交；**组 `intersect`（局部可见）时对每个子对象再做一次筛选**，保证跨过边界的成员不漏画、界外成员不白画。
   - 两种策略的应绘制数在固定路径的每一帧都必须相等。
4. **变换实时更新 + 边界不漏画**
   - 用 TransformControls 拖动任意摆件/组，或固定路径驱动旋转平移，包围体每帧重算。
   - 无头验证里有「边界抖动」专项：把边界交叉的实体沿视锥面法线双向推，跨进必须保留、跨出必须剔除。
5. **固定路径 + 可复现对照**
   - 180 帧确定性路径（相机平动/扫视/变焦/拉近拉远 + 摆件漂移自转）。
   - 无头验证逐帧记录提交数，与 `verify/baseline.json` 逐字节比对；浏览器端也可导出报告 JSON。

---

## 目录结构

```
src/
  culling/
    frustum.ts        # 视锥/球/盒判定（产品代码，基于 THREE.Frustum）
    cullController.ts # 逐物件 / 按组 / 原生 三策略，layer 开关模拟提交
  scene/
    sampleScene.ts    # 固定种子生成 6 组 24 摆件 + 世界包围体重算
    fixedPath.ts      # 180 帧确定性相机/摆件路径
  view/debugView.ts   # 总览相机里的视锥、包围球/盒、状态着色
  ui/panel.ts         # 控制面板（滑杆、模式、统计表）
  ui/labels.ts        # 3D→HTML 悬浮状态/原因标签
  report/report.ts    # 逐帧记录与报告导出
  selfcheck.ts        # 无头浏览器探针（?selfcheck=1）
  main.ts             # 入口：双相机、双视口、渲染循环、交互
verify/
  independentFrustum.ts # 不依赖 THREE.Frustum 的 Gribb-Hartmann 独立实现
  runVerify.ts          # 无头验证编排（11 条断言 + 基线对照）
  baseline.json         # 已保存的可复现基线
```

### 两套独立视锥数学为什么可信

- `src/culling/frustum.ts` 走 Three.js 的 `Frustum.setFromProjectionMatrix`。
- `verify/independentFrustum.ts` 直接从 view-projection 矩阵按 Gribb-Hartmann
  提取六个面（注意 `Matrix4.elements` 是**列主序**），球面/盒面测试各自独立实现。
- 固定路径全部 180 帧、所有组与摆件上，两套结论逐实体一致（0 分歧）才算通过。

---

## 本地启动

需要 Node.js 18+（开发机验证用的是 Node 20）。

```bash
npm install
npm run dev
```

打开终端提示的地址（默认 http://127.0.0.1:5173/ ）。

- 鼠标左键拖动总览视角旋转，滚轮缩放，右键平移。
- 点击场景中的摆件或右侧表格行可选中，出现变换 Gizmo，拖动即改变换、包围体实时重算。
- 右下角画中画是**观察相机视角**，即「实际提交绘制」的内容；左侧大画面是总览调试视角。
- 右侧面板切换剔除策略、调视锥参数、播放/步进固定路径、导出报告。

其它脚本：

```bash
npm run build      # 类型检查 + 生产构建到 dist/
npm run preview    # 预览构建产物
npm run typecheck  # 仅类型检查
```

---

## 一条可运行的验证命令

```bash
npm install && npm run verify
```

它在 Node（tsx，无需浏览器）里跑完整 180 帧固定路径，执行 11 条断言：

- 固定路径确实覆盖到组级边界交叉帧；
- 逐物件与按组的总提交数、逐帧提交数都相等；
- 按组策略确实发生了「整组 out 跳过」；
- 两套独立视锥数学结论 0 分歧；球判定与盒判定没有 in/out 互斥分歧；
- 存在被剔除帧（镜头外摆件确实不提交）；
- 边界抖动：跨进视锥不漏画、跨出视锥不误留；
- 收紧 near/far 后出现 near/far 拒绝；
- 与已保存 `verify/baseline.json` 逐字节一致。

期望结尾输出 `== 结果：11/11 通过 ==`，退出码 0。

更新基线（仅在有意修改判定逻辑并复核后）：

```bash
npm run verify:update
```

### 浏览器内真实 WebGL 自检（可选）

`npm run build && npm run preview` 后，用 Chrome 打开
`http://127.0.0.1:4173/?selfcheck=1`，页面会自动逐帧跑三种剔除策略各 180 帧，
通过后在页面底部写入一段 `{"ok":true,...}`。它核对的是**真实 renderer 的 draw call**，
与无头的纯数学判定互为印证。

> 说明：无头 Chrome 的 SwiftShader 软件渲染对「带偏移的小 viewport」支持有限，
> 画中画在纯软件渲染截图里可能是黑的；这是渲染后端限制，不影响剔除结论——
> draw call 计数、NDC 投影与原点 viewport 渲染均正常，带 GPU 的真实浏览器无此现象。

---

## 判定口径

- 球面测试：任一视锥面到球心距离 `< -radius` 判 `out` 并记录拒绝面；
  否则只要存在 `|distance| < radius` 判 `intersect`；其余为 `in`。
- 盒面测试（p-顶点法）：取盒上离面负侧最近/最远的两个角点，
  最大侧 `< 0` 判该面外 `out`，最小侧 `< 0` 记为相交。
- 「是否提交绘制」在自定义策略里通过开关 mesh 的 layer 0 模拟（layer 1 的调试体
  总览相机始终可见），原生策略则交给 Three.js 自己的 `frustumCulled`，并读取
  `renderer.info.render.calls` 统计真实提交数。
