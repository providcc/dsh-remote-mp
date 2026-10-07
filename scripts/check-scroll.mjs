#!/usr/bin/env node
/**
 * scroll-policy 判据 —— `core/scroll-policy.js`。
 *
 * 为什么**纯函数层也要测**，而页面层（伞仓 `e2e/mp-chat-blocks.test.mjs`）已经测了同一批行为：
 * 页面那层要 wx shim、要 setData、一次要几十毫秒，而且失败时看不出是**哪条判据**错了——
 * "按钮又冒出来了"这句话对应到代码里是三个分支的组合。这里能一条条钉：
 * 每条判据一个用例，失败信息直接写明是哪一条。
 *
 * 这些用例也是 2026-10-06 抽 `core/scroll-policy.js` 的**验收条件**：抽之前，下面每一条
 * 都只能靠真机观察（"回弹是不是负 delta"、"中间帧会不会把按钮弄出来"），
 * 一轮几分钟且不可复现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const MP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniprogram')
const { ScrollPolicy, BOTTOM_SLOP, REBOUND_MS } = require(path.join(MP, 'core', 'scroll-policy.js'))

/** 夹具：视口 800 高的滚动容器，时钟可拨。 */
function harness() {
  let now = 1_000_000
  const scroll = new ScrollPolicy(() => now, { bottomSlop: BOTTOM_SLOP, reboundMs: REBOUND_MS })
  scroll.setViewportHeight(800)
  return {
    scroll,
    advance: (ms) => {
      now += ms
      return now
    },
    /** 滚到离底 `fromBottom` 像素处。 */
    frame: (fromBottom, deltaY = 0) => ({
      scrollLeft: 0,
      scrollTop: 3000 - 800 - fromBottom,
      scrollHeight: 3000,
      deltaY,
    }),
  }
}

test('贴底：停跟随的唯一条件是"用户自己滑离底部"，判据只看位置', () => {
  const h = harness()
  assert.equal(h.scroll.following, true, '初始就是跟随态')

  // 容差内不算滑走：真机上差几像素不是"用户想回看"。
  h.scroll.onScroll(h.frame(BOTTOM_SLOP - 1))
  assert.equal(h.scroll.following, true, `${BOTTOM_SLOP - 1}px 还在容差里，不该停`)

  h.scroll.onScroll(h.frame(BOTTOM_SLOP + 1))
  assert.equal(h.scroll.following, false, '出了容差就是用户滑走了')
  assert.equal(h.scroll.scrollTop, 3000 - 800 - (BOTTOM_SLOP + 1), 'scrollTop 要记下来：「回到最新」要知道从哪儿起滚')
})

test('往上拖哪怕 deltaY 是正的也停（位置是唯一判据，deltaY 只用于识别"我们自己的滚动"）', () => {
  const h = harness()
  h.scroll.onScroll(h.frame(200, +30)) // deltaY 为正，但人已经离开底部 200px
  assert.equal(h.scroll.following, false, '停在底部附近才是跟，deltaY 的符号不代表意图')
})

test('回到底部就无条件接回跟随（用户改主意了）', () => {
  const h = harness()
  h.scroll.onScroll(h.frame(500))
  assert.equal(h.scroll.following, false)
  h.scroll.onScroll(h.frame(0))
  assert.equal(h.scroll.following, true, '回到底部就该接上')
})

test('onScrollToLower：无条件接回（scroll-view 的触底事件）', () => {
  const h = harness()
  h.scroll.onScroll(h.frame(400))
  h.scroll.onScrollToLower()
  assert.equal(h.scroll.following, true)
})

test('视口高度未知时不做任何判断（首帧那几帧不能把跟随关掉）', () => {
  const scroll = new ScrollPolicy(() => 0)
  assert.equal(scroll.viewportHeight, 0)
  const r = scroll.onScroll({ scrollTop: 10, scrollHeight: 3000, deltaY: -50 })
  assert.equal(r.following, true, '高度 0 时连"贴底"都判不了，更不该停跟随')
})

test('点「回到最新」：接回跟随 + 开一个回弹豁免窗口，并记住起点', () => {
  const h = harness()
  h.scroll.onScroll(h.frame(600))
  h.scroll.onJumpLatest()
  assert.equal(h.scroll.following, true)
  assert.ok(h.scroll._programmaticUntil > h.advance(0), '窗口必须已经开着')
  assert.equal(h.scroll._programmaticFromTop, 3000 - 800 - 600, '起点要记下来：窗口内按位置判断方向')
})

test('回弹的负帧不关跟随（屏幕已到底、deltaY 还是负的那一帧）', () => {
  const h = harness()
  h.scroll.onJumpLatest()
  const r = h.scroll.onScroll(h.frame(120, -40))
  assert.equal(r.following, true, '回弹不是用户想回看，关掉它之后就再也不跟了')
  // `atBottom` 也要保持：回弹帧若报 false，「回到最新」按钮会在刚落底时又冒出来。
  // （第一版只断言 following，于是把这条改成 false 的变异**没有变红**——已补。）
  assert.equal(r.atBottom, true, '回弹帧不该让「回到最新」按钮重新出现')
})

test('程序滚动途中的向下中间帧：不关跟随，**也不许把按钮弄出来**', () => {
  const h = harness()
  h.scroll.onScroll(h.frame(600))
  h.scroll.onJumpLatest()
  // 起点是 fromBottom=600（scrollTop=1600）；程序滚动是**向下**的，所以后面的帧必须
  // 比起点更靠近底部（fromBottom 更小）。第一版把 700 排在最前，那一帧其实把用户
  // 往上带了——policy 判它"真回看"是对的，**用例自己的方向写反了**。
  for (const fromBottom of [500, 300, 100, 40]) {
    const r = h.scroll.onScroll(h.frame(fromBottom, +25))
    assert.equal(r.following, true, `离底 ${fromBottom}px：还在往底部走`)
    assert.equal(
      r.atBottom,
      true,
      `离底 ${fromBottom}px 不该报 atBottom=false：那会让「回到最新」按钮在自己的滚动途中` +
        '反复挂载/卸载（肉眼是"啪一下又冒出来"，2026-10-06 真机取证）',
    )
  }
})

test('窗口过期后负 delta 恢复本义：那就是用户回拖了', () => {
  const h = harness()
  h.scroll.onJumpLatest()
  h.advance(REBOUND_MS + 1)
  h.scroll.onScroll(h.frame(300, -40))
  assert.equal(h.scroll.following, false, '窗口外面还豁免，就变成永远不跟了')
})

test('窗口内真的往回拖仍然停跟（位置判据不能吃掉真回看）', () => {
  const h = harness()
  h.scroll.onScroll(h.frame(600))
  h.scroll.onJumpLatest()
  // scrollTop 明显低于起点：这是用户在回看，不管窗口开着没有。
  h.scroll.onScroll({ scrollTop: 300, scrollHeight: 3000, deltaY: +30 })
  assert.equal(h.scroll.following, false, '位置回退了就是用户，窗口不能替它说话')
})

test('afterFold：只在跟随时重新对齐（正在翻历史的用户不该被甩到底）', () => {
  const h = harness()
  assert.equal(h.scroll.afterFold(), 'anchor-b', '跟随中：翻一次锚点')

  h.scroll.onScroll(h.frame(500)) // 切到回看
  assert.equal(h.scroll.afterFold(), null, '回看中：对齐到底就是甩人')
})

test('scrollToBottom 在 a/b 之间翻转（scroll-into-view 只在值变化时生效）', () => {
  const h = harness()
  assert.equal(h.scroll.scrollToBottom(), 'anchor-b')
  assert.equal(h.scroll.scrollToBottom(), 'anchor-a')
  assert.equal(h.scroll.scrollToBottom(), 'anchor-b')
})

test('shouldFollowNewContent：翻更早一页（noScroll）一律不跟', () => {
  const h = harness()
  assert.equal(h.scroll.shouldFollowNewContent(), true)
  assert.equal(h.scroll.shouldFollowNewContent({ noScroll: true }), false, '往前插内容时跟底会把人甩走')
  h.scroll.onScroll(h.frame(500))
  assert.equal(h.scroll.shouldFollowNewContent(), false, '回看中不该被新内容拽走')
})

test('pendingBottom 读完即消费：不清的话下一页也会被当成重连拖到底', () => {
  const h = harness()
  h.scroll.onReconnect()
  assert.equal(h.scroll.consumePendingBottom(false), true, '重连补读（不是第一页）要拖到底')
  assert.equal(h.scroll.consumePendingBottom(false), false, '读完即消费：不能拖到下一次翻页')
})