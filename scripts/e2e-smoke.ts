/**
 * 端到端冒烟：驱动真实页面走一遍五条核心规则。
 * 运行：node scripts/e2e-smoke.ts（Node 22 可直接剥离 TS 类型）
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5174/'

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`❌ ${message}`)
    process.exitCode = 1
  } else {
    console.log(`✅ ${message}`)
  }
}

async function holdingQty(page: import('playwright').Page, itemName: string): Promise<string> {
  return page
    .locator('.holding-cell', { hasText: itemName })
    .locator('.holding-qty')
    .innerText()
}

async function queueOffer(page: import('playwright').Page, offerTitle: string): Promise<void> {
  await page
    .locator('.offer-card', { hasText: offerTitle })
    .getByRole('button', { name: '排入换物队列' })
    .click()
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await page.goto(BASE)

// ---------- 1. 成功路线：两笔连换拿藏宝图 ----------
await page.getByRole('button', { name: '载入成功路线' }).click()
await page.waitForSelector('.step-row.step-ok')
assert((await page.locator('.step-row.step-ok').count()) === 2, '成功路线预演两步均可行')

const stepText = await page.locator('.step-list').innerText()
assert(stepText.includes('猎人绳'), '预演中出现第一笔产物猎人绳')
assert(stepText.includes('藏宝图'), '预演中出现目标物藏宝图')
assert((await page.locator('.holdings-panel').innerText()).includes('藏宝图'), '持有量面板预演包含藏宝图')

await page.getByRole('button', { name: /确认整队换物/ }).click()
await page.waitForSelector('.banner-ok')
assert(
  (await page.locator('.banner-ok').innerText()).includes('一次性成交'),
  '成功成交横幅出现',
)
assert((await page.locator('.history-row').count()) === 2, '成交历史记录两笔')
assert((await page.locator('.history-panel').innerText()).includes('成交于 v1'), '历史保留成交版本 v1')

// ---------- 2. 失败路线：香草差 1，整队拒绝 ----------
await page.getByRole('button', { name: '载入失败路线' }).click()
await page.waitForSelector('.step-fail')
const failText = await page.locator('.step-list').innerText()
assert(failText.includes('herb 差 1'), '失败步骤报出 herb 差 1')
assert(failText.includes('套装'), '失败原因标明套装原子性')
assert(
  await page.getByRole('button', { name: /确认整队换物/ }).isDisabled(),
  '预演失败时确认按钮禁用',
)
assert(
  (await page.locator('.holdings-panel').innerText()).includes('贝壳'),
  '预演持有量里保留了第一步换到的贝壳',
)

// ---------- 3. 取消回位（只比数字，不含预演增减角标） ----------
const voucherBefore = await holdingQty(page, '纸券')
await page.getByRole('button', { name: /全部取消/ }).click()
const voucherAfter = await holdingQty(page, '纸券')
assert(voucherBefore === voucherAfter, '取消前后纸券持有量数字不变（预演从未扣料）')
assert((await page.locator('.cart-entry').count()) === 0, '队列已清空')

// ---------- 4. 次日改价、旧预览过时、历史价格保留（先重置拿到新鲜库存） ----------
await page.getByRole('button', { name: '重置试验' }).click()
await page.getByRole('button', { name: '载入成功路线' }).click()
await page.getByRole('button', { name: '进入次日' }).click()
await page.waitForSelector('.banner-day')
assert(
  (await page.locator('.banner-day').innerText()).includes('2 券 → 3 券'),
  '次日横幅列出藏宝图涨价',
)
assert((await page.locator('.stale-badge').count()) >= 1, '跨日残留排队条目标记为过时')
assert(
  (await page.locator('.step-list').innerText()).includes('报价已过时'),
  '预演拦截过时条目并说明原因',
)
assert(
  await page.getByRole('button', { name: /确认整队换物/ }).isDisabled(),
  '存在过时条目时确认禁用',
)
assert((await page.locator('.stalls-panel').innerText()).includes('v2'), '改动过的报价版本升到 v2')
assert(
  (await page.locator('.history-panel').innerText()).includes('今天还没有成交'),
  '重置后历史为空，旧日试验不串档',
)

// ---------- 5. 按次日新价排队，涨价在预演里咬人 ----------
// 新鲜次日库存：纸券 4、兽皮 2。先花 2 券换香草（新价），再搓绳、再换藏宝图（新价 3 券）
await page.getByRole('button', { name: /全部取消/ }).click()
await queueOffer(page, '纸券换香草')
await queueOffer(page, '兽皮搓绳')
await queueOffer(page, '藏宝图套装')
const newFail = await page.locator('.step-list').innerText()
assert(newFail.includes('voucher 差 1'), '按次日新价预演：纸券差 1，证明涨价生效')

// ---------- 6. 额度限制：次日贝壳限额只剩 1 次 ----------
await page.getByRole('button', { name: /全部取消/ }).click()
await queueOffer(page, '纸券换贝壳')
await queueOffer(page, '纸券换贝壳')
assert(
  (await page.locator('.step-list').innerText()).includes('额度已用尽'),
  '超过次日限额的步骤报出额度用尽',
)

await page.screenshot({ path: '/tmp/market-e2e-final.png', fullPage: true })
await browser.close()

if (process.exitCode === 1) {
  console.error('\n存在失败断言')
} else {
  console.log('\n全部端到端断言通过')
}
