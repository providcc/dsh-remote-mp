/**
 * scroll-policy — 会话页"自动跟底 vs 用户回看"的**唯一**决策处。
 *
 * ## 为什么把它从页面里抽出来（2026-10-06）
 *
 * 原来这套状态摊在页面实例上 **9 个字段**里（`_autoScroll` / `_scrollTop` / `_scrollH` /
 * `_programmaticUntil` / `_programmaticFromTop` / `_pendingScrollBottom` / `_flip` 加两个
 * 常量副本），而判据全部内联在 `onScroll` 一个方法里：
 *
 * ```js
 * var atBottom = ...
 * if (atBottom) { ...; return }
 * if (Date.now() < this._programmaticUntil) { var dy = ...; if (dy < 0) return; if (...) return }
 * if (this._autoScroll) { ... }
 * ```
 *
 * 三个问题叠在一起，于是每一次调整都像在拆一颗雷：
 * 1. **一个字段在几个地方被写**（`_autoScroll` 出现在 onScroll / onScrollToLower /
 *    onJumpLatest / _commit / _onEvent 重连分支 / onSend 六处），读代码要横着扫整页才能
 *    判断"此刻到底跟不跟"；
 * 2. **判据之间的相互作用只能靠注释记忆**（`_programmaticUntil` 那段注释有 14 行，
 *    记的是 2026-10-05 与 2026-10-06 两次真机观察）；
 * 3. **判据本身测不到**——它长在页面方法里，要 wx shim、要 setData 才能跑，
 *    于是"负 delta 是回弹还是用户回拖"这种问题只能靠真机观察，而真机观察一轮几分钟。
 *
 * 抽出来之后：状态只有这一个对象，判据只有这几个方法，**全部纯函数**（时钟注入、
 * 不碰 wx、不碰 setData、不碰页面），所以每一条判据都能单测。
 * 页面只负责"把结果画到 data 上"。
 *
 * ## 行为保持不变
 *
 * 这是**重构**，不是改需求：所有阈值与判据逐条搬过来，判据的先后顺序也照搬。
 * 变的是"它们住在哪、能不能测"，不是"它们判什么"。
 */
'use strict'

/** 贴底容差（像素）。24 是实测值：真机上差几像素不算用户滑走了。 */
var BOTTOM_SLOP = 24
/** 自触发滚动后的回弹豁免窗口（毫秒）。只覆盖**我们自己触发**的滚动。 */
var REBOUND_MS = 600

/**
 * @param {() => number} now 毫秒时钟（注入是为了单测能直接拨时间）
 * @param {{ bottomSlop?: number, reboundMs?: number }} [options]
 */
function ScrollPolicy(now, options) {
  options = options || {}
  this._now = now || function () { return Date.now() }
  this._bottomSlop = options.bottomSlop === undefined ? BOTTOM_SLOP : options.bottomSlop
  this._reboundMs = options.reboundMs === undefined ? REBOUND_MS : options.reboundMs

  /** 正在跟底吗。false = 用户回看中，此时新内容不许把他甩走。 */
  this.following = true
  /** 最近一次真实滚动到的位置。"回到最新"要知道自己是**从哪儿**开始滚的。 */
  this.scrollTop = 0
  /** 视口高度；0 = 还没量到（第一帧 onScroll 之前不判贴底）。 */
  this.viewportHeight = 0
  /** 自触发滚动的豁免截止时刻。 */
  this._programmaticUntil = 0
  /** 自触发滚动开始时的 scrollTop。 */
  this._programmaticFromTop = 0
  /** 重连补读完后要强制回底部（读完即消费）。 */
  this.pendingBottom = false
  /** `scroll-into-view` 只在值变化时生效，用 a/b 翻转的尾部锚点反复触发它。 */
  this._flip = false
}

/** 视口高度变了（首帧 / 折叠后）。高度未知时**不**做任何贴底判断。 */
ScrollPolicy.prototype.setViewportHeight = function (height) {
  if (typeof height === 'number' && isFinite(height) && height > 0) this.viewportHeight = height
}

/**
 * 收到一帧滚动。**返回渲染层要用的两个值**，其余状态自己收好。
 *
 * 规则只有一条：**用户自己滑离底部才停跟**，判据只看位置
 * （2026-10-05 用户：「以滑动底部作为默认行为……避免场景确实导致不跟滑」）。
 *
 * 自作自起的回弹帧（屏幕已到底、deltaY 还是负）不算"用户想回看"；`programmaticUntil`
 * 这个窗口只覆盖**我们自己触发**的滚动，不是"过了 600ms 就当作没人拖过"。
 *
 * 窗口内按**位置**而不是纯时间判断：窗口内且 scrollTop 没有回退到起点之上，
 * 说明它还在往底部走，那就是我们自己滚的。纯时间窗会把用户在这 600ms 里的真回看也吃掉
 * （4656d70 刻意把窗口收窄过一次，别退回去）。
 *
 * @param {{scrollTop?: number, scrollHeight?: number, deltaY?: number}} detail
 * @returns {{following: boolean, atBottom: boolean}} **页面该画什么**，见下面这段——
 *
 *   `following` = 还跟不跟底（新内容要不要把他拽走）
 *   `atBottom`   = 「回到最新」那颗按钮**该不该出现**
 *
 * ⚠️ 这两个**不是同一件事**，中间帧就是它们分叉的地方：程序滚动正在往下走时
 * `following` 仍是 true，而物理上确实"还没到底"。那一段 `atBottom` 必须**保持 true**
 * （按钮不出现），否则按钮会在自己的滚动途中反复挂载/卸载——肉眼是"啪一下又冒出来"。
 * 抽出来时这里一度写成"物理上在不在底部"，被既有判据当场抓住（见下面那两条分支的注释）。
 */
ScrollPolicy.prototype.onScroll = function (detail) {
  var d = detail || {}
  var h = this.viewportHeight

  // ── 第 0 相：量不到视口高度 ──────────────────────────────────────
  // scroll 事件里没有视口高度（见 chat.js `onReady` 的注释），而它只有在 `onReady`
  // 量到之后才有值。这几帧**什么也不判**：判不了"贴底"却把跟随关掉，是最坏的一种错。
  if (!h || typeof d.scrollHeight !== 'number') return this._view()

  // 只在这一处写，所以它始终是最近一次真正滚动到的位置。
  if (typeof d.scrollTop === 'number') this.scrollTop = d.scrollTop

  // ── 第 1 相：真的到底了 ──────────────────────────────────────────
  // 唯一无条件接回跟随的地方。顺带清掉回弹窗口：已经到底了，之后的帧不再有豁免的意义。
  if (d.scrollTop + h >= d.scrollHeight - this._bottomSlop) {
    this._programmaticUntil = 0
    this.following = true
    return { following: true, atBottom: true }
  }

  // ── 第 2 相：还没到底，但可能正**我们自己**在滚 ────────────────────
  // 窗口内按**位置**而不是纯时间判断：scrollTop 没有回退到起点之上 ⇒ 它还在往底部走
  // ⇒ 这是我们自己的滚动中间帧，不是用户想回看。
  // 纯时间窗会把用户在这 REBOUND_MS 里的真回看也吃掉（4656d70 刻意把窗口收窄过一次）。
  //
  // ⚠️ 这一相 `atBottom` 必须**保持 true**（= `following`），不是"物理上在不在底部"：
  // 「回到最新」是向下滚的，这些帧还没真的到底，若报 false，页面就会把那颗按钮在
  // 自己的滚动途中反复挂载/卸载——肉眼是"啪一下又冒出来"
  // （2026-10-06 真机取证：11 个中间帧里 7 帧重新出现，其中两帧正在播 jump-in 的 scale）。
  // 抽出来时这里一度写成 `false`，被既有判据「FAB：向下滚的中间帧不许把它重新挂上」当场抓住。
  if (this._now() < this._programmaticUntil) {
    var dy = d.deltaY || 0
    var notOverscrolledBack = d.scrollTop >= this._programmaticFromTop - this._bottomSlop
    if (dy < 0 || notOverscrolledBack) return this._view()
  }

  // ── 第 3 相：出窗了、位置也回退了，这就是用户在回看 ──────────────
  this.following = false
  return { following: false, atBottom: false }
}

/**
 * "什么都不用改"时给页面的答案：`atBottom` 跟 `following` 走。
 *
 * 「回到最新」按钮的可见性是**跟随状态**的函数，不是位置的函数——按钮的语义是
 * "你不在最新，往下走"，而"正在往下滚"这件事本身不算"不在最新"。
 */
ScrollPolicy.prototype._view = function () {
  return { following: this.following, atBottom: this.following }
}

/** 用户滑到最底端（scroll-view 的 `onScrollToLower`）：无条件接回跟随。 */
ScrollPolicy.prototype.onScrollToLower = function () {
  this.following = true
  return { following: true, atBottom: true }
}

/** 点「回到最新」：接回跟随，并开一个回弹豁免窗口。 */
ScrollPolicy.prototype.onJumpLatest = function () {
  this.following = true
  this._programmaticUntil = this._now() + this._reboundMs
  this._programmaticFromTop = this.scrollTop || 0
  return { following: true, atBottom: true }
}

/**
 * 请求滚到底。
 *
 * @returns {string} 这一次要写进 `data.toView` 的锚点 id（a/b 翻转，见 `_scrollToBottom` 的注释）
 */
ScrollPolicy.prototype.scrollToBottom = function () {
  this._flip = !this._flip
  return this._flip ? 'anchor-b' : 'anchor-a'
}

/** 新的内容到了：此刻跟不跟？`noScroll`（翻更早一页）一律不跟。 */
ScrollPolicy.prototype.shouldFollowNewContent = function (opts) {
  return !(opts && opts.noScroll) && this.following
}

/** 折叠之后重新对齐一次（只在贴底时做——正在回翻历史的人不该被甩到底）。 */
ScrollPolicy.prototype.afterFold = function () {
  if (!this.following) return null
  return this.scrollToBottom()
}

/** 断链重连：强制回底部（这一页的约定是"最新在最底"，不记住"读到哪儿"）。 */
ScrollPolicy.prototype.onReconnect = function () {
  this.following = true
  this.pendingBottom = true
  return { following: true, atBottom: true }
}

/**
 * 读完一页历史之后取"这次要不要强制回底"。
 *
 * ⚠️ 必须**同时**把 pending 消费掉（`readUntil === true` 时）：
 * `onReconnect` 只置标记、真正翻底发生在 `_commit`，而标记不清就会被**下一次**
 * 翻页也当成重连来拖到底——那时用户正在读更早的历史。
 *
 * @param {boolean} isFirstPage 第一页（最新一页）不算"翻更早"，不该拖到底
 */
ScrollPolicy.prototype.consumePendingBottom = function (isFirstPage) {
  var force = !!(this.pendingBottom && !isFirstPage)
  this.pendingBottom = false
  return force
}

module.exports = { ScrollPolicy: ScrollPolicy, BOTTOM_SLOP: BOTTOM_SLOP, REBOUND_MS: REBOUND_MS }