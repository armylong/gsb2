# drop-pity-lab — 掉落表保底模拟器

一个零依赖、纯本地的 TypeScript 小工具，用来回答"这张掉落表真实抽起来是什么分布"。
直接在 Node 里运行 `.ts`（依赖 Node ≥ 22.18 的原生类型剥离），不需要打包、不需要数据库。

所有样例配置都在程序里生成（`src/samples.ts`），仓库里没有任何数据文件。

---

## 本地启动

```bash
# 在仓库根目录执行
npm install          # 只装 TypeScript 与 @types/node（纯开发依赖）
node src/cli.ts demo # 或: npm run demo
```

`npm install` 会拉 `typescript` / `@types/node`（只有 `npm run typecheck` / `npm run verify` 用到）。
如果只想跑模拟，`node src/cli.ts ...` 一个命令就能跑，**不需要先 install**。

### 一条可运行的验证命令

```bash
npm run verify
```

它会依次执行：`tsc --noEmit` → 4 个测试文件共 51 个单元测试 → 62 条端到端场景断言
（配置校验、确定性、多角色隔离、分段/最长未中/版本统计、边界用例、共享组、断点续跑、中点分叉）。
全部通过时退出码 0。也可以只跑场景断言：`node scripts/verify.ts --no-tests`。

> 要求 Node ≥ 22.18（原生 TypeScript 类型剥离）。已在 Node 22.23 / TypeScript 5.9 上验证。

---

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `node src/cli.ts demo` | 演示全部 7 项需求，每个小节都可单独跑 (`--section 1..7`) |
| `node src/cli.ts run` | 按配置跑完整模拟并打印报告 |
| `node src/cli.ts step` | 逐次试抽，打印每一抽的随机状态 / 版本 / 命中原因 |
| `node src/cli.ts resume` | 从 `session.json` 快照续跑 |
| `node src/cli.ts export` | 只导出配置与结果 |
| `node src/cli.ts keys` | 列出进度归属 key（谁和谁共享保底进度） |

常用参数：`--seed <s>`、`--passes N`、`--mode round-robin|pool-blocks`、
`--draws-per-block N`、`--characters a,b`、`--pools x,y`、`--config file.json`、`--export dir`。

```bash
# 固定种子跑 200 轮, 只看标准池 + 限定池
node src/cli.ts run --seed my-seed --passes 200 --pools standard,featured

# 逐次试抽 10 次, 每抽都打印随机状态、池版本、组进度和保底原因
node src/cli.ts step --count 10 --seed s1

# 先导出一个检查点, 之后再续跑 (结果与一次跑完逐条一致)
node src/cli.ts run --passes 200 --export .output
node src/cli.ts resume --session .output/run-session.json
```

---

## 模型

- **稀有度**：每个物品池最多 3 种（R / SR / SSR 之类），每种独立配置
  - `weight` 基础权重
  - `bonusPerMiss` 每次连续未中后追加的权重（软保底，线性）
  - `pityThreshold` 硬保底阈值：距上次命中最多 N 抽，第 N 抽必中；`null` 表示无
- **有效权重** = `weight + bonusPerMiss × 连续未中次数`
- **命中规则**：有稀有度达到阈值时，只在达到阈值的候选里按权重分配（候选权重全为 0 时等概率，保证保底一定生效）；
  否则在全体稀有度里按有效权重轮盘。每抽记录 `weighted / pity / empty` 与具体原因。
- **进度隔离**：按「角色 × 进度作用域 × 稀有度」独立累计连续未中数。
  作用域默认是物品池本身；把多个池加入同一个**共享保底组**后，它们对同一角色共用一份进度。
- **权重版本**：调权重不会覆盖旧值，而是生成新版本。抽卡记录带实际使用的版本号与标签，
  所以调表之后仍能解释历史结果，也能随时 `activateVersion` 回退。

### 边界语义

| 情况 | 行为 |
| --- | --- |
| 空池（0 种稀有度） | 每抽 `empty`，**不消耗随机数** |
| 全零权重且无加成/无保底 | 每抽 `empty`，**不消耗随机数**，但连续未中照常累加 |
| 全零权重 + 有加成 | 加成从第 2 抽起生效（`bonus × streak`） |
| 全零权重 + 达到硬保底 | 在保底候选里等概率命中 |
| 版本中临时删除某稀有度 | 该稀有度进度**冻结**，回退旧版本后原样接上 |

---

## 需求对照

1. **最多三种稀有度，可设权重 / 加成 / 阈值** — `src/config.ts` 的 `RarityConfig`；
   超过 3 种、权重为负、阈值 < 1 都会被 `validateConfig` 拒绝。
2. **固定种子多轮 + 逐次试抽，展示保底前后的抽中原因** — `run` / `step` 命令；
   每抽记录带权重计算明细和 `实际触发规则: 基础权重 / 权重 + 软保底加成 / 硬保底 / 无`。
3. **多角色独立进度，调权重后清空或继承** — 进度 key 形如 `alpha|pool:standard`；
   `progressPolicyOnVersionChange: 'inherit' | 'reset'`，记录里写明沿用了什么、丢弃了什么。
4. **分段命中率 / 最长未中 / 实际命中的权重版本** — `buildReport`：
   按抽前最大连续未中分段统计每个稀有度命中率；最长未中按进度 key 计算（共享组跨池合并）；
   版本表按 `池 × 版本` 分别统计抽数与命中。
5. **导出配置与结果，测试必定保底 / 空池 / 零权重** — `export` 命令与 demo 第 5 节；
   边界池见 `edgeCaseConfig()`。
6. **跨池共享保底组，未共享的池仍独立** — `sharedGroupId` + `pity-group`；
   切池或回退版本时，记录的 `progress.strategy` 与 `notes` 会说明
   `shared-group / continued / inherited / reset` 以及本次实际触发的规则。
7. **每抽记录随机状态 / 池版本 / 组进度；断点续跑；中点分叉对照** —
   `DrawRecord` 含 `rngBefore` / `rngAfter` / `poolVersion` / `progress`；
   `sessionToJson` + `sessionFromJson` 续跑；`forkSession` 深拷贝检查点，
   用 `addWeightVersion` 改副本配置做对照，原记录字节不变（`verify` 有断言）。

---

## 目录

```
src/
  config.ts    配置模型 + 校验
  builder.ts   纯函数式配置编辑（改权重生成新版本、改共享组、改策略）
  progress.ts  保底进度、权重计算、命中规则
  rng.ts       可快照的 mulberry32
  engine.ts    抽卡引擎（计划、逐抽记录、快照/恢复、分叉）
  stats.ts     报告、分段、最长未中、版本统计、记录比对
  samples.ts   内置样例与边界用例
  render.ts    终端表格渲染
  export.ts    JSON 导出
  cli.ts       命令行入口
scripts/
  verify.ts    一键验证（类型检查 + 测试 + 场景断言）
test/          单元测试 (node --test)
```

## 测试

```bash
npm test            # 单元测试
npm run typecheck   # tsc --noEmit
npm run verify      # 全部
```
