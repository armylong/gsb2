// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

// UI 冒烟测试：App 能完整渲染，载入样例后画布出现路径，
// 切换显示模式不崩溃。（jsdom 无 canvas 2D 上下文，这里打桩绕过 paper 的初始化；
// 几何正确性由 verify.test.ts 在 node 环境中覆盖。）

describe('App 冒烟测试', () => {
  it('渲染并载入样例', async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => new Proxy({}, { get: () => () => {} }),
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext

    const { default: App } = await import('../src/App')

    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(App))
    })
    expect(container.querySelector('svg')).toBeTruthy()

    // 载入「环形区域」样例
    const buttons = Array.from(container.querySelectorAll('button'))
    const loadBtn = buttons.find((b) => b.textContent === '载入样例')!
    await act(async () => {
      loadBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const paths = container.querySelectorAll('svg path')
    expect(paths.length).toBeGreaterThan(0)

    // 切换显示模式
    const outlineBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '仅轮廓')!
    await act(async () => {
      outlineBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('svg')).toBeTruthy()

    await act(async () => {
      root.unmount()
    })
  })
})
