# 精灵图集工具（Sprite Atlas Tool）

一个在 macOS 上本地运行的精灵图集工具：把一组透明 PNG 打包成可供二维游戏使用的**多页图集**，并且真正保留「裁边 → 旋转 → 原始画布 → 动画」之间的几何关系。导出的数据足以脱离原图重建动画，而不是只给出一张排满图片的预览图。

- 前端：React + TypeScript + Canvas
- 后端（本地）：Node.js + Express、图片处理用 `sharp`
- 共享几何 / 像素代码：TypeScript，前后端复用同一份还原与校验逻辑
- 校验：Vitest 单元/集成测试 + 无头端到端脚本 + 浏览器实测

---

## 快速开始

```bash
npm install

# 开发模式：API (4173) + Vite UI (5173)
npm run dev
# 打开 http://localhost:5173

# 生产模式：构建 UI 后由同一个进程托管 UI 和 API
npm run build
npm start          # http://localhost:4173
```

进入页面后：

1. 点「载入示例素材」（自动生成，不需要任何外部图片），或「选择 PNG（可多选）」「导入整个目录」。
2. 调整页面尺寸、帧间距、页面边距、边缘扩展、是否允许旋转，点右上角「打包」。
3. 「图集预览与对比」查看分页、缩放、点选帧、原图与还原结果对比。
4. 「动画」把帧加入序列、设置每帧时长、循环播放。
5. 「导出与独立预览」一次性导出全部页面 PNG + 帧描述 + 动画描述，并可只加载导出文件做独立预览。

---

## 本地验证命令（核心）

```bash
npm run verify          # = typecheck + 全部测试（边界/重叠/稳定标识/逐帧像素一致性）
npm run typecheck       # tsc --noEmit
npm test                # Vitest：identity-import / pack / roundtrip / animation
npm run headless-check  # 打印式端到端检查：导入→打包→导出→重新载入→逐帧还原
npm run cli -- --out ./out --width 160 --height 160
                        # 同一条流水线的命令行版本，输出图集目录 + sprite-atlas.zip
npm run samples:write   # 重新生成 samples/ 下的确定性示例 PNG
npm run e2e             # 可选：真实 Chrome 点击完整流程，需先 npm run build && npm start
```

浏览器端到端脚本（`npm run e2e`）会自动完成：载入示例 → 设小页面打包 → 选中带旋转的帧比对像素 →
设置动画时长并确认确实在换帧 → 导出 → 下载 ZIP → 只加载 ZIP 做独立预览 → 再按散装文件加载一次。
`BASE_URL` 可覆盖默认的 `http://localhost:4173`，`CHROME` 可指定浏览器路径。

`npm run headless-check` 与 `npm test` 会自动检查并逐项打印：

| 检查 | 含义 |
| --- | --- |
| `bounds` / `margin` | 所有帧都在页面内，且不侵入页面边距 |
| `overlap` / `spacing` | 任意两帧不重叠，帧间距 ≥ 设定值 |
| `extrusion` | `contentRect` 恰好是 `packedRect` 每边收进 `extrude` 像素 |
| `rotation` | 每帧记录顺时针 0°/90°，没有隐式旋转 |
| `ids-unique` | 稳定标识唯一、格式固定、与导入顺序无关 |
| `empty-frames` | 全透明帧仍有标识且被放置，不被丢弃 |
| `pixel-roundtrip` | 从导出的 PNG 逐帧还原后与原图逐像素比较 |
| `bundle-*` | 只读导出文件（atlas.json / pages/*.png / animation.json）重新验证 |

**像素比较规则**：alpha 必须完全一致；alpha 不为 0 处 RGB 必须一致。唯一忽略的是「双方 alpha 都为 0 的像素的 RGB」——这些颜色在正常合成下不可见。测试中有专门用例证明：alpha 差 1 会失败、可见像素 RGB 差 1 会失败，而全透明像素的隐藏 RGB 不同会通过并计入 `ignoredTransparentPixels`。

---

## 设计要点（与需求逐条对应）

### 1. 导入与稳定标识

- 记录**原始画布尺寸**、透明边界 `trim`、内容哈希、稳定标识 `id`。
- `id = f_<16 hex>`，由「解码后 RGBA 像素 + 尺寸」的内容哈希与**相对路径**共同决定：
  - 改变导入顺序、增删别的图片：已有帧 `id` 不变；
  - 同名文件来自不同目录：相对路径不同 → 不同 `id`，不会静默覆盖；
  - 完全重复的导入会被识别为 `duplicate` 并在 UI 中提示「未覆盖」。
- **全透明图片**：`empty=true`、`trim = 0×0`，仍然被放置到页面上的 1×1 透明槽位，拥有 `id`、`page`、`packedRect`，完整写入 `atlas.json`。既不会被丢弃，也不会导致后续帧编号变化。
- 16 位 PNG 会被明确拒绝并提示（因为逐像素校验基于 8 位 RGBA）。

### 2. 打包设置与多页

- `pageWidth` / `pageHeight` 同时是页面尺寸和上限；`spacing` 是帧之间的**纯空白**；`margin` 是页面四边留空；`extrude` 是防串色的**边缘扩展**；`allowRotation` 控制是否允许顺时针 90° 打包。
- 采用确定性的 MaxRects 式排布：按（最长边、最短边、稳定 id）排序，与输入顺序无关。
- 空间不足自动开新页，页面文件名为 `atlas_000.png`、`atlas_001.png`……
- **放不下的单张大图**：记录 `FRAME_TOO_LARGE` 问题，`status="unplaced"`、`page=null`、`packedRect=null`，并给出「裁边内容 / 含扩展边槽位 / 可用区域」的具体数字；不缩放、不拆碎、不静默丢弃。
- 所有尺寸单位为像素（px）。

### 3. 内容间距 vs. 边缘扩展

- `spacing`：帧与帧之间的空白，只影响布局。
- `extrude`：在每帧内容四周做 clamp-to-edge 复制，防止双线性采样时把边缘和透明黑混在一起（黑色描边/暗边）。复制只使用**已有边缘像素**，不会引入新颜色，也因此不会产生黑边。
- `packedRect`（含扩展）与 `contentRect`（纯内容，且是**旋转后**的尺寸）在页面坐标系中都有明确值；`contentRect = packedRect` 每边收进 `extrude`。
- 旋转方向固定为**顺时针**并逐帧记录在 `rotation`，导出 README 与 JSON 出处一致，消费端无需猜测。

### 4. 确定性

- 相同帧集合 + 相同设置 → 相同布局、相同 `id`、相同页面、相同导出内容（ZIP 使用固定时间戳，排序固定）。
- 改变导入顺序：布局与标识不变（有专门测试与 `headless-check` 校验）。
- 增加/移除图片允许重新排版，但**已有帧的 `id` 仍可被动画引用**，动画重排后仍能播放。

### 5. 预览与对比

- 逐页查看、缩放（25%–400%）、点选帧（画布点击或列表点击）。
- 同时显示：原始画布轮廓（虚线）、裁后内容 `contentRect`（蓝）、槽位含扩展 `packedRect`（黄）、页面边距。
- 选中帧左右并排：左「原图（原始画布）」，右「从图集还原」，并显示像素一致性结论、裁边、页面位置、旋转方向、扩展边、槽位尺寸。旋转打包不会改变最终呈现方向（右侧是反向旋转放回原画布的结果）。

### 6. 动画

- 按稳定标识添加帧、调整顺序、设置每帧时长（ms）、循环开关、统一基准点（0–1 归一化，锚点在**原始画布**内）。
- 播放时每帧先按 `trim` 放回自己的原始画布，再把各帧的基准点对齐到同一位置；**不使用图集页面坐标对齐**，因此透明边界不同、位于不同页面的帧不会出现裁边引起的跳动。
- 可以暂停/重播，并显示当前帧与总时长。

### 7. 导出

一次导出包含：

```
atlas.json        # 格式标识、设置、页面列表、逐帧描述（含 trim / rotation / extrude / packedRect / contentRect / empty / 未放置原因）
animation.json    # 动画名称、循环、基准点、逐帧 { id, durationMs }
pages/atlas_*.png # 全部页面
README.txt        # 坐标约定与还原步骤说明
sprite-atlas.zip  # 以上内容的确定性 ZIP
```

「从导出文件独立预览」只读取上述导出文件（页面 PNG + JSON），不使用任何原图，用来证明导出数据本身足够还原动画。`npm run headless-check` 同样走这条路径。

---

## 数据契约摘要

```
sourceSize  : 原始画布尺寸（裁边不改变它）
trim        : 原图中的透明边界（全透明帧为 0×0）
rotation    : 打包时对裁后内容施加的顺时针旋转（0 / 90）
extrude     : 槽位内每边的边缘复制像素数
packedRect  : 页面坐标中的槽位（含扩展边）
contentRect : 页面坐标中的有效内容 = packedRect 每边内收 extrude，尺寸为旋转后的尺寸
```

还原一帧：

1. 从页面裁出 `contentRect`（不是 `packedRect`）；
2. 逆时针转回 `rotation` 指定的角度；
3. 画到 `sourceSize` 大小的透明画布上，位置为 `trim.x, trim.y`。

动画对齐：把每个原始画布按归一化基准点对齐，与页面位置无关。

完整说明也会随导出写入 `README.txt`。

---

## 示例素材

`samples/` 下已提交由 `server/samples.ts` 生成的 PNG（确定性算法，不使用随机数；`npm run samples:write` 可重建），覆盖需求中的边界情况：

- 不规则透明形状（英雄、斩击特效）
- **完全透明的占位帧**
- 不同画布尺寸（64×96、128×64、8×8、220×220…）
- 适合旋转的长条（16×300、260×14）
- 同名的 `hero_idle.png` 放在 `characters/` 与 `alternate/` 下，像素不同
- 透明像素下带有不可见 RGB 的图片（用来演示唯一允许忽略的规则）

---

## 目录结构

```
shared/     前后端共享：类型、几何、像素运算、打包器、还原、动画组合、结构校验
server/     本地服务：sharp 编解码、导入分析、源码存储、导出与逐帧像素校验、HTTP API、
            示例素材生成、导出包加载器（bundle.ts）
src/        React UI：图集预览、帧对比、动画播放器、导出与独立预览、ZIP 载入
scripts/    atlas-cli.ts（命令行流水线）、headless-check.ts（打印式端到端校验）、
            e2e.mjs（真实浏览器）、write-samples.ts（生成 samples/）
samples/    已提交的示例 PNG（含全透明帧、同名不同目录、长条、大图）
tests/      Vitest：identity-import / pack / roundtrip / animation
```

## 开发接口（本地）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/import` | 批量导入 PNG（base64） |
| POST | `/api/frames/samples` | 载入内置示例素材 |
| GET | `/api/frames` | 帧列表（尺寸、裁边、标识） |
| POST | `/api/pack` | `{ settings, frameIds? }` → 清单 + 页面 + 校验报告 |
| POST | `/api/export` | `{ buildId, animation }` → 导出文件清单与校验 |
| GET | `/api/export/:id/zip` | 下载确定性 ZIP |
| GET | `/api/export/:id/file/*` | 读取单个导出文件 |

## 范围说明

不追求兼容某个具体游戏引擎的全部图集格式，也不包含绘图、骨骼动画或在线素材管理；导出为自描述的 JSON + PNG，便于自行转换。
