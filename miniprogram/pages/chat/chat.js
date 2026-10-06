'use strict'

var client = require('../../core/client.js')
var theme = require('../../core/theme.js')
var markdown = require('../../core/markdown.js')
var env = require('../../core/env.js')

/**
 * chat 页 —— 一条会话渲染成「文档流」，不是一串聊天气泡。
 *
 * 五种块：
 *   turn 轮次分隔 / user 你的指令 / steps 步骤组 / text 回复正文 / note 系统提示
 *
 * 「步骤组」是这一页的核心抽象：一轮里模型「想 → 调工具 → 再想 → 再调」的过程
 * 被聚成**一条**，界面上就是「已完成 3 个步骤」一行，点开才看得到每条细节。
 * 不聚合的话，一轮调 6 次工具就是 12 个块，用户要翻 6 屏才读到那句结论 ——
 * 这正是重做这一页的原因。
 *
 * ── 关于「思考」正文（重要）─────────────────────────────────────────
 * 协议**不发给手机**。`assistant/message` 里的 `reasoning` part 在宿主侧就被丢掉，
 * 这是宿主插件的 M28 红线：思维链不得跨 E2E 边界，且有单测锁着。
 * 所以这里显示的「思考」是**阶段**：从它出现到下一条内容之间的耗时，
 * 而不是思维链文本。要做成能看到正文，先改 M28 那条安全决策，那不是我能在界面层决定的。
 *
 * ── 四件容易写错的事 ────────────────────────────────────────────────
 * 1. `assistant/message` 自带 `done: true`，但一轮里可以有好几条 —— **不能用它判
 *    "这一轮结束了"**，否则第一次工具调用之后状态条就显示空闲。运行态只认 `ev.run_state`。
 * 2. 用户自己的消息既被本地立即回显，也会被宿主用 `role:'user'` 的 delta 回传，
 *    不去重就会在屏幕上出现两遍。
 * 3. 流式 delta 逐帧 setData 会卡，先合并再按帧刷（沿用原有策略）。
 * 4. 步骤组要「封口」：一旦有正文/轮次/指令出现，就不再往这一组里塞东西
 *    （`_sealSteps`）。漏了会把新的工具调用插进上一段已经读完的过程里。
 *
 * ── 过程显示，思考中不占顶栏（SHOW_STEPS）──────────────────────────
 * 过程块（steps）默认**渲染**：一轮里「想 → 调工具 → 再想」聚成一条，
 * 收起时是一行「已完成 3 个步骤」，展开看细节（限高窗口，见 .steps-scroll）。
 * 折叠**只有组标题一行这一个入口**：顶栏那个全局开关已删（2026-10-03）——
 * 留着它等于同一个动作有两处管，而长会话里「一键全收」会顺手把正在跑的那组也收起来。
 *
 * 组内两类东西的可点性**不同**：工具条目可点开看参数与结果（那是内容，
 * 想不想看由用户定）；思考行只显示阶段与耗时，**没有展开**——思维链正文按
 * host-plugin-runtime.md 的 M28 红线不得跨 E2E 边界，宿主侧就已经丢掉了，
 * 展开只能展开出一行"没有内容"，那是界面在骗人。
 * **组内只有 think、一个工具都没调的那组（`plain`）整组都不是可展开的东西**：
 * 无箭头、不绑手势、卡片不渲染，就一行「思考中 4.0s」。长得能点却展开不出
 * 内容，比一个纯标签更像坏了。
 *
 * 「还在动」不再单独占一行：输入区上方那条「思考中…」已删。现在由两处承担 ——
 * 最新那条步骤组的实时标签（组在跑就显示"思考中"），与顶栏的中断按钮。
 * 两者都在"用户正在看的地方"，不需要额外一条浮层。
 *
 * 为什么不把落块逻辑删掉：那些块是**唯一**的真相来源。删了之后
 * ① 工具参数/结果帧无处落（`_replaceTool` 按 callId 找不到就退化成新开一组），
 * ② 历史回放里每一步的 id 对不上，正文会插到错误位置。
 * 也就是说"不显示"是渲染层的决定，"记不记"是数据层的决定，两件事要分开。
 *
 * 要临时藏过程：把 SHOW_STEPS 改成 false，落块逻辑一行不用动。
 */
var SHOW_STEPS = true
var MAX_BLOCKS = 400

/**
 * 图片附件的两条参数（与 wire 的 imageAttachment 对齐）。
 *
 * MAX_ATTACH = 4：协议层图片与文件的上限都是 4（再多对"看清楚"没帮助，只是把帧撑爆——
 * 中继 maxMessageBytes 是硬上限，超了整条帧被掐）。
 * IMAGE_QUALITY = 0.6：截图/报错这一类用途完全够。⚠️ compressImage 的 quality
 * **在 Android 上被系统忽略**（真机只会按 sizeType 压一次），所以这只是"尽力"，
 * 真正的体积纪律是 sizeType: ['compressed'] + chooseMedia 的 count 上限。
 */
/** 贴底容差（px）：差这么多以内就算还贴着底。
 *  比 0 大是因为 iOS 落底会有回弹，正好差半个像素的位置会被判成"离开了"，
 *  于是跟随莫名其妙断掉 —— 用户报的就是这个。 */
var SCROLL_BOTTOM_SLOP = 24
/** 自作滚动之后、认定回弹帧的时间窗（ms）。只覆盖我们自己触发的那次滚动。 */
var SCROLL_REBOUND_MS = 600

var MAX_ATTACH = 4
var IMAGE_QUALITY = 0.6
/**
 * 图片压到多小：长边钉死在这个像素数。
 *
 * 为什么是 1600："看清楚一张报错截图"到 1600 已经完全够（代码片段、栈帧都能读），
 * 再大只是把帧撑爆。1600 长边 + quality 0.6 出来的 jpeg 通常 100～350KB，
 * 一条消息带四张也还在中继的 1MB 硬帧上限之内。
 */
var IMAGE_LONG_EDGE = 1600
/**
 * 图片的字节预算（压完之后）——两条闸：单张、一条消息合计。
 *
 * 为什么单张是 512KB：base64 把体积撑大 4/3，再算密文封装，**一条消息**里
 * 图片原始字节超过约 540KB 就过不了中继的 1MB 硬帧上限（`DRC_MAX_MSG_BYTES`）。
 * 合计闸 512KB 留了余量给 cmdId/sessionId 等字段。单张闸等于合计闸：
 * 一张就顶格时它先说话，不至于被"合计"那条含糊过去。
 */
/**
 * 文件附件的字节预算：与图片同一组数。
 *
 * 为什么单文件也是 512KB：预算不是按文件还是图分的，是按**中继那条 1MB 硬帧上限**
 * 倒推的（base64 胀 4/3 + 密文封装 -> 一条消息的原始字节超约 540KB 就过不去）。
 * 文件没有压缩这一步，所以这个数就是一条消息能带走多少个文件的上界，
 * 超了明说该减哪一个，而不是让整条帧被掐成莫名掉线。
 */
var MAX_ATTACH_BYTES = 512 * 1024
var MAX_ATTACH_TOTAL_BYTES = 512 * 1024
var MAX_IMAGE_BYTES = 512 * 1024
var MAX_IMAGE_TOTAL_BYTES = 512 * 1024
var MAX_TEXT_PER_BLOCK = 20000
var DELTA_FLUSH_MS = 100
var DELTA_FLUSH_CHARS = 4096
var THINK_TICK_MS = 1000
var TOOL_PREVIEW_CHARS = 72

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 块的浅复制。小程序这边不依赖对象展开，统一走这里，语义也更明确 */
function copyBlock(b) {
  var c = {}
  for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) c[k] = b[k]
  return c
}

function clockText(ts) {
  var d = new Date(ts)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** 思考耗时：10 秒以内给一位小数（2.4s 比 2s 有信息量），再长就取整 */
function fmtMs(ms) {
  var s = Math.max(0, ms) / 1000
  if (s < 10) return s.toFixed(1) + 's'
  if (s < 60) return Math.round(s) + 's'
  return Math.floor(s / 60) + 'm' + pad2(Math.round(s % 60)) + 's'
}

/** 工具结果收成一行预览：换行压平、掐长，剩下的点开看 */
function firstLine(text) {
  var s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  return s.length > TOOL_PREVIEW_CHARS ? s.slice(0, TOOL_PREVIEW_CHARS) + '…' : s
}

/**
 * 连接态 → 顶栏那颗圆点的语义色。
 *
 * 2026-10-05 用户拍板："手机离线不要黄色，不要给用户提供焦虑"。
 * 产品定位是**临时离开电脑时的手机替身**：离线不是故障而是这件东西的常态
 * （合盖、睡觉、地铁），所以 error 也**不用红色**——红在这里说的是"你的东西坏了"，
 * 而实际要传达的只是"现在没连上"。中性灰 + 一句人话就够。
 * 全页没有 warning：真需要用户动手的状态（待审批/待回答）用品牌色。
 */
function connTheme(status) {
  if (status === 'online') return 'success'
  if (status === 'connecting' || status === 'pairing') return 'primary'
  if (status === 'error') return 'default'
  return 'default'
}

/**
 * 步骤组的展示信息全部从组内状态派生，算一次给渲染层用。
 *
 * 「还在跑」只看**组内**有没有未完成的条目，不看全局 running ——
 * 否则前面那些早已封口的老组也会跟着显示"正在执行"。
 *
 * `plain` = 组内只有 think、**一个工具都没调**。这种组没什么可展开的，
 * 所以它只该是一行状态：不给箭头、不给按压反馈、点了不响应、卡片不渲染。
 * 反过来做（留个箭头点开，里面只有一行"思考中 4.0s"）是在骗人 ——
 * 用户会以为里面还有东西没显示出来。
 */
function decorateSteps(g) {
  var tools = 0
  var thinkMs = 0
  var live = false
  var now = Date.now()
  for (var i = 0; i < g.items.length; i++) {
    var it = g.items[i]
    if (it.type === 'tool') {
      tools += 1
      if (it.phase !== 'completed' && it.phase !== 'failed') live = true
    } else {
      // 还在跑的那条 think 没有 ms（要等它结束才记），这里现算，
      // 否则标题里的耗时会停在 0，直到这一条收尾才跳一下。
      thinkMs += it.done ? it.ms || 0 : now - it.startedAt
      if (!it.done) live = true
    }
  }
  var c = copyBlock(g)
  c.tools = tools
  c.thinkMs = thinkMs
  c.live = live
  c.plain = tools ? 0 : 1
  // 组内自动滚的落点（对应 wxml 里 `id="s{{it.key}}"`）。
  // **只给还在跑的组**：跑完的组不给，否则用户回看老组时，每来一条新内容
  // 就被拽回组尾，根本读不了。live 变 false 时置空，滚动自然停住。
  c.tailId = live && g.items.length ? 's' + g.items[g.items.length - 1].key : ''
  if (live) c.label = tools ? '正在执行 ' + tools + ' 个步骤' : '思考中 ' + fmtMs(thinkMs)
  else if (tools) c.label = '已完成 ' + tools + ' 个步骤'
  else c.label = '思考了 ' + fmtMs(thinkMs)
  return c
}

Page({
  data: {
    sessionId: '',
    title: '',
    /** 块流：轮次分隔 / 用户指令 / 思考阶段 / 工具调用 / 回复正文 / 系统提示 */
    blocks: [],
    inputText: '',
    /** input 的 focus 由这里驱动：点空白要真收起键盘，就得让 focus 变成 false */
    inputFocus: false,
    running: false,
    turn: 0,
    pendingPermission: null,
    pendingQuestion: null,
    /** 同时是滚动锚点的 id 与 scroll-into-view 的目标，翻转它就等于"滚到底" */
    toView: 'anchor-a',
    /** 是否已贴底。false 时浮出「回到最新」 */
    atBottom: true,
    /**
     * 待办清单（内核 `todo/write` → `ev.todo`，全量快照）。
     * 一项：`{content, status: 'pending' | 'in_progress' | 'completed'}`。
     * 与 pending（底部、等 dsh 消化的指令）分管上下两端，互不打架。
     */
    todos: [],
    /** 分段进度条：每条待办一格，超过 8 条时前 7 格 + 一个"还有更多"。 */
    /** 待办面板默认收起：只报进度，展开是临时的（点消息区就收回）。 */
    todosOpen: false,
    /** 收起来时那一行的三个派生值：完成数 / 有没有在跑的 / 在跑的那条正文。
     * 与 modelName 同一纪律：截断与派生都在这一层做完，wxml 里不做运算。 */
    todoDone: 0,
    todoRunning: 0,
    todoRunningText: '',
    /** 输入区上方待发送的图片附件（本地压缩后的临时文件）。 */
    attachments: [],
    /** 加号角标上的数字（= attachments.length，wxml 里不做运算）。 */
    attachCount: 0,
    /** 顶栏：连接状态。模型（`modelName`）跟在它后面同一行，运行态由步骤组的实时标签说 */
    barText: '',
    barTheme: 'default',
    /**
     * 当前模型（`ev.model` 的原始字段）。**只读，不假装能切。**
     *
     * 这一代主机内核的 `agentDefaultModel` 上只有 `currentSelection`
     *（取证：status.json 的 `modelFace = no-list+no-set via=currentSelection`），
     * 既列不出候选也写不进去。所以这里**不存** `canSwitch` / `options`：
     * 它们对应的下拉与面板已经删掉，留着两个没人读的字段，
     * 下一个人会以为"只是还没接上"。
     *
     * `modelName` 是给界面看的截断结果，**截断在这一层做完**：wxml 里没有
     * 「超长就省略」的表达力，交给它自己判断就会出现「有的截断有的不截」。
     */
    modelName: '',
    /**
     * 过程块渲不渲染。见文件头 SHOW_STEPS 的说明：**数据照落，只是不显示**。
     */
    showSteps: SHOW_STEPS,
    /**
     * 历史读取的四个状态：
     *   idle    还没试过（未配对 / 未连上）
     *   loading 正在读第一页
     *   ok      读到了（哪怕内容是空的——"没有内容"与"读不到"必须分得清）
     *   error   没读到，页面上给一条可点的重试
     * 原来这一页只有一句"主机上已有的历史不会同步过来"——那是协议不支持时的诚实说法，
     * 现在支持了，就得真的去读，并且把读不到与没内容分开报。
     */
    historyState: 'idle',
    /** 还有更早的内容；点「加载更早」继续往前翻 */
    hasMore: false,
    historyLoadingMore: false,
    /** 主题。见 sessions 页同名字段的说明。 */
    themeName: 'light',
    themeClass: '',
    /**
     * **Markdown 排版结果的顶层索引**：`{ [块 key]: nodes[] }`。
     *
     * 为什么正文块上只留 `mdPending`（纯文本），nodes 却要另存一份：
     * `rich-text` 的 `nodes` **不能绑 `wx:for` 作用域里的变量** ——
     * 那样它会渲染成高度 0 的空块（正文整段消失，而 data / 单测 / e2e 全绿）。
     * 实测能绑的只有「顶层字段」与「顶层 map + **一层** `item.key` 索引」，
     * 两层索引与循环项都不行（`_withMd` 的注释里有逐档结果）。
     * 所以由 `_commit` 把块上的 `_md` 收进这个 map，wxml 按 `item.key` 取。
     *
     * 代价是同一份 nodes 在 data 里存了两处（块上 `_md` + 这个 map）；
     * `_md` 用 `_` 开头表示"给收集用的中间量"，不进 wxml。
     */
    mdBodies: {},
  },

  onLoad: function (options) {
    this.client = client.getClient()
    // 记下 markdown 是按哪个主题排的版：`_retheme` 靠它判断"要不要重排"。
    // 不在这里记住的话，首次 onShow 会误判成"主题变了"而白重排一次
    // （那时 blocks 还是空的，等于空跑；不致命但说明状态没初始化对）。
    /** 曾经断过链：用来认出"重连成功"那一刻（见 _onEvent 的 status 分支）。 */
    this._wasOffline = false
    this._mdTheme = theme.current()
    theme.applyTo(this)
    var id = decodeURIComponent(options.id || '')
    var title = decodeURIComponent(options.title || id)
    this.setData({ sessionId: id, title: title })
    wx.setNavigationBarTitle({ title: title.length > 16 ? title.slice(0, 16) + '…' : title })
    this._textIndex = {}
    this._counter = 0
    this._deltaBuf = {}
    this._deltaTimer = null
    this._thinkTimer = null
    this._autoScroll = true
    this._flip = false
    this._SCROLL_BOTTOM_SLOP = SCROLL_BOTTOM_SLOP
    this._SCROLL_REBOUND_MS = SCROLL_REBOUND_MS
    this._programmaticUntil = 0
    this._scrollH = 0
    /** 最近一次真实滚动到的位置。「回到最新」要靠它判断"还在往底部走还是用户在回拖"。 */
    this._scrollTop = 0
    this._draining = false
    this._historyBusy = false
    this._historyStarted = false
    /** 实时待办帧到过没有（实时帧优先于历史快照的判据）。 */
    this._todoLive = false
    /** 当前这一页历史里的最后一份待办快照（undefined = 这页没有）。 */
    this._replayTodos = undefined
    /** 翻页游标：由主机给，原样回传。null = 已经到最早了 */
    this._historyBefore = null
  },

  onReady: function () {
    var self = this
    // 判断"是否贴底"需要视口高度，只在就绪时量一次（面板弹出会改变布局，忽略不计）
    wx.createSelectorQuery()
      .select('.scroll')
      .boundingClientRect(function (r) {
        if (r && r.height) self._scrollH = r.height
      })
      .exec()
  },

  onShow: function () {
    this._off = this.client.on(this._onEvent.bind(this))
    this._retheme()
    this._renderBar()
    this.client.listSessions()
    this._maybeLoadHistory()
    // 排队是「以 dsh 为准」：进会话/回前台主动问一次，别等主机恰好有变化。
  },

  /**
   * 主题可能在**别的页**被改过（切换按钮在 sessions 页），而 markdown 的颜色是
   * **烘焙进 nodes 的具体色值**（`rich-text` 不认 `var()`，见 core/markdown.js）。
   * 所以 `onShow` 必须比一次：只看 `theme.applyTo` 换 class 的话，
   * 从深色切回浅色再进这一页，页面上是浅色卡片配深色字 —— 而判据全绿。
   *
   * 成本是重排全部正文块（典型长回复 1.2ms/块）。只在主题**真的变了**时才做，
   * 顺带把 `theme.applyTo` 也放进来（`onLoad` 已经调过一次，这里是幂等的）。
   */
  _retheme: function () {
    var name = theme.applyTo(this)
    if (name === this._mdTheme) return
    this._mdTheme = name
    var blocks = this.data.blocks
    var out = new Array(blocks.length)
    var changed = false
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].kind !== 'text') {
        out[i] = blocks[i]
        continue
      }
      // 只重排有正文的块：空正文块重排出来还是空，不必进 setData
      if (!blocks[i].text) {
        out[i] = blocks[i]
        continue
      }
      out[i] = this._withMd(Object.assign({}, blocks[i], { _md: null }))
      changed = true
    }
    if (changed) this._commit(out, { noScroll: true })
  },

  onHide: function () {
    if (this._deltaTimer) {
      clearTimeout(this._deltaTimer)
      this._deltaTimer = null
    }
    this._flushDelta()
    this._stopThinkTick()
    this._stopCardTick()
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  onUnload: function () {
    this._stopThinkTick()
    this._stopCardTick()
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  // ── 滚动：自动跟随 vs 用户回看 ────────────────────────────────────
  onScroll: function (e) {
    var d = e.detail || {}
    var h = this._scrollH
    if (!h || typeof d.scrollHeight !== 'number') return
    // 记住当前位置：「回到最新」要知道自己是**从哪儿**开始滚的（见 onJumpLatest）。
    // 只在这一处写，所以它始终是最近一次真正滚动到的位置。
    if (typeof d.scrollTop === 'number') this._scrollTop = d.scrollTop

    // **默认永远跟底**（2026-10-05 用户：「以滑动底部作为默认行为……避免场景确实导致不跟滑」）。
    //
    // 旧写法在这里叠了三个各自为正的判据，互相打架：
    //   1. deltaY < 0 → 立刻停跟（「提前量」）
    //   2. 点完「回到最新」后 600ms 内不认这个提前量（回弹是假的）
    //   3. 24px 的贴底容差
    // 三者各有各的边界条件，一起逛就会「跟不上」——那就是用户报的。
    //
    // 现在只保留一条规则：**用户自己滑离底部才停**，判据只看位置。
    // 自作自起的回弹帧（deltaY 为负）不能当作「用户滑起来了」，
    // 所以 _programmaticUntil 这个时间窗只覆盖**我们自己触发**的滚动，
    // 而不是「过了 600ms 就当作没人拖过」。
    var atBottom = d.scrollTop + h >= d.scrollHeight - this._SCROLL_BOTTOM_SLOP
    if (atBottom) {
      this._programmaticUntil = 0
      if (!this._autoScroll) {
        this._autoScroll = true
        this.setData({ atBottom: true })
      }
      return
    }
    // 自作自滚的尾帧回弹：屏幕滚到底了但 deltaY 还是负的那一帧。
    // 它不代表用户想回看，不能因此停跟。
    //
    // **向下滚的程序滚动也要豁免**（2026-10-06 取证）。原来这一条只挡 deltaY<0，
    // 而 `onJumpLatest` 触发的是**向下**的滚动（deltaY>0）：于是每一帧中间帧
    // （还没真的到底）都把 atBottom 打回 false，「回到最新」那颗按钮就在自己的
    // 滚动途中**反复挂载/卸载**——渲染层实测 11 个中间帧里有 7 帧重新出现，
    // 其中两帧正在播 jump-in 的 scale，肉眼是「啪一下又冒出来」。
    //
    // 判据不用「纯时间窗」而是**位置**：窗口内且 scrollTop 没有回退到起点之上，
    // 说明它还在往底部走，那就是我们自己滚的。纯时间窗会把用户在 600ms 内
    // 的真回看也吃掉（4656d70 刻意把窗口收窄过一次，别退回去）。
    if (Date.now() < (this._programmaticUntil || 0)) {
      var dy = d.deltaY || 0
      if (dy < 0) return
      if (dy >= 0 && d.scrollTop >= (this._programmaticFromTop || 0) - this._SCROLL_BOTTOM_SLOP) return
    }
    if (this._autoScroll) {
      this._autoScroll = false
      this.setData({ atBottom: false })
    }
  },

  onScrollToLower: function () {
    if (!this._autoScroll) {
      this._autoScroll = true
      this.setData({ atBottom: true })
    }
  },

  onJumpLatest: function () {
    this._autoScroll = true
    // 落底回弹的尾帧会是负 delta：给一个短窗口让它别把刚接上的跟随又关掉
    this._programmaticUntil = Date.now() + this._SCROLL_REBOUND_MS
    // 起点：onScroll 里用来判断「还在往底部走还是用户在往回拖」（见 onScroll 那条注释）
    this._programmaticFromTop = this._scrollTop || 0
    this.setData({ atBottom: true })
    this._scrollToBottom()
  },

  /**
   * scroll-into-view 只在**值变化**时才生效，所以用一个 id 在 a/b 之间翻转的
   * 尾部锚点：既保证每次刷新都真的滚到底，又不依赖"最后一个气泡会长高"这种假设。
   */
  _scrollToBottom: function () {
    this._flip = !this._flip
    this.setData({ toView: this._flip ? 'anchor-b' : 'anchor-a' })
  },

  /**
   * 折叠之后把外层滚动位置重新对一次。
   *
   * 为什么需要：折叠会让内容高度**剧烈**变化 —— 长会话里点一次收起某个组
   * 能少两千多像素（实测 4532 → 1876）。开发者工具每次都会把 scrollTop 收进
   * 新的合法范围，但真机（尤其 iOS）不是每次都重新量：视口停在旧的高度上，
   * 下面就是一段**滚不到任何内容**的空白 —— 用户看到的就是
   * 「过程内容不见了，但是所占的位置还在」。
   * 翻一次尾部锚点等于明确要求它按新的内容高度重新对齐一次。
   *
   * **只在贴底时做**：正在往回翻历史的用户不该被这一下甩到底。
   * 贴在底部时"重新对到底部"本来就是他期望的位置，所以这一步没有副作用。
   */
  _afterFold: function () {
    if (this._autoScroll) this._scrollToBottom()
  },

  // ── 键盘：点空白收起 ──────────────────────────────────────────────
  /**
   * 小程序里 input 拿到焦点后，点页面上别的地方**不会**自动收键盘，
   * 键盘会一直盖住半屏。原来那个 `hold-keyboard="{{true}}"` 更是明确要求
   * 「点页面不收起键盘」——正是要反过来的东西。
   * 现在：外层容器接 tap（子级 tap 会冒泡上来），输入区/面板用 catchtap 挡住不误收。
   */
  onTapBlank: function () {
    if (!this.data.inputFocus) return
    this.setData({ inputFocus: false })
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard({ fail: function () {} })
  },

  /** catchtap 的空实现：只用来切断冒泡，不做别的事 */
  onNoop: function () {},

  onInputFocus: function () {
    if (!this.data.inputFocus) this.setData({ inputFocus: true })
  },

  // ── 入站事件 ──────────────────────────────────────────────────────
  _onEvent: function (evt) {
    if (evt.kind === 'status') {
      this._renderBar()
      // 进这一页时可能还没连上（或刚配对完）。连上那一刻就是能取历史的时机。
      this._maybeLoadHistory()
      // **断链重连后要把落下的那一段补回来**（2026-10-05 用户：
      // 「chat 页激活时断链，重连后信息流就停止刷新」）。
      //
      // 为什么只 _maybeLoadHistory 不够：它第一句就是
      // `if (this._historyStarted …) return`，而那个标志**一辈子只置真一次**。
      // 于是重连成功时它直接返回 —— 断链期间主机上跑完的那些步骤、工具、
      // 回复一条都补不回来，而主机重连后也不会主动推历史（它只发 resync）。
      // 表现就是：页面还活着、顶栏还亮着，但消息流从此静止。
      //
      // 所以这里显式清掉"已经取过"的三个标志，让它按老路径重新读一遍。
      // 用 _historyStarted 复位而不是加一个重连专用分支，是因为复读历史
      // 这条路本来就在（进会话、首次连上），复用它才不会漏掉它的那些守卫。
      if (evt.status === 'online' && this._wasOffline) {
        this._wasOffline = false
        this._historyStarted = false
        this._historyBusy = false
        // **复位之后必须自己再触发一次**（2026-10-06 取证）。
        //
        // 开头那次 `_maybeLoadHistory()` 在这一刻还看到 `_historyStarted === true`，
        // 直接 return 了——而它全页只有两个调用点（onShow 与这里），不重新触发
        // 就**永远不会再读历史**。2026-10-05 那次"修复"只复位、不触发，整段是
        // 彻底的空操作：断链期间主机上跑完的步骤、工具、回复一条都补不回来，
        // 而主机重连后也只会发 resync（mp 按设计不处理它，docs/DESIGN.md:333），
        // 于是页面活着、顶栏亮着，**消息流从此静止**。
        //
        // 此刻三个前置条件全满足：status 已是 'online'、_historyStarted 刚复位、
        // _historyBusy 刚复位。
        this._maybeLoadHistory()
        // 断了多久不知道，但主机那边的会话状态一定变了 —— 顶栏那个
        // 「运行中」要重新问一次，否则它会一直停在上一次的值上。
        this.client.listSessions()
      }
      // 记下"曾经断过"，onHide/unload 之外的断开都走上面那条。
      if (evt.status === 'connecting' || evt.status === 'idle') this._wasOffline = true
      return
    }
    if (evt.kind === 'error') {
      wx.showToast({ title: String(evt.message || '').slice(0, 40), icon: 'none' })
      return
    }
    if (evt.kind !== 'payload') return
    var p = evt.payload

    // 会话过滤（**ev.model 也在内**）。
    //
    // 这里原来有一句「模型是全局的，必须在过滤之前判」的豁免——2026-10-05 用户
    // 实测到的串台就是它造成的：本会话跑 space-bunny-free，顶栏却显示别的会话
    // 切出来的 muse-spark，因为别的会话一推模型帧，这里就直接 setData 覆盖了。
    // 现在 ev.model 带 sessionId（wire 1.8.0），模型与其他事件走同一句过滤。
    if (p.sessionId && p.sessionId !== this.data.sessionId) return // 不是本会话

    // 老主机的 ev.model 不带 sessionId（那时它就是全局的）：只在**本会话确实还没
    // 拿到过模型**时用它兜底，绝不让别的会话的帧覆盖已有的正确值。
    if (p.t === 'ev.model') {
      if (p.sessionId || !this.data.modelName) this._onModel(p)
      return
    }
    if (p.sessionId && p.sessionId !== this.data.sessionId) return // 不是本会话

    // 会话列表是"这条会话此刻在不在跑"的权威来源。这一页原来完全没看它，
    // 于是从列表点进一条**正在跑**的会话时，顶栏会一直显示"空闲"，
    // 直到那条会话恰好又推了一次运行态。
    if (p.t === 'ev.session_changed') return this._onSessions(p)

    if (p.t === 'ev.message_delta') return this._queueDelta(p)
    if (p.t === 'ev.tool_event') return this._onTool(p)
    if (p.t === 'ev.permission_request') return this._onPermission(p)
    if (p.t === 'ev.permission_resolved') return this._onPermissionResolved(p)
    if (p.t === 'ev.question_request') return this._onQuestion(p)
    if (p.t === 'ev.question_resolved') return this._onQuestionResolved(p)
    if (p.t === 'ev.run_state') return this._onRunState(p)
    // 排队快照（2026-10-05 用户：排队要双向同步）。主机是唯一的真相源，
    // 这里整体替换——不在本地增删，本地增删就又变回一份猜的队列。
    if (p.t === 'ev.todo') return this._onTodo(p)
    if (p.t === 'ev.result') {
      if (!p.ok && p.message) wx.showToast({ title: String(p.message).slice(0, 40), icon: 'none' })
      return
    }
  },

  /** 列表里这条会话的状态同步到顶栏（只认 running，别的都在 `_renderBar` 里算）。 */
  _onSessions: function (p) {
    var rows = p.sessions || []
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id !== this.data.sessionId) continue
      var running = rows[i].running === true
      if (running === this.data.running) return
      this.setData({ running: running })
      if (running) {
        // 从会话列表进一条**正在执行**的会话时，这条帧是此刻唯一的"它在跑"信号：
        // `ev.run_state` 只在状态跳变时发，进入时不会补发。原来这里只翻了
        // `data.running`（顶栏话术变了），正文里却没有"正在执行"那一组步骤，
        // 要等下一次内核事件才补上（2026-10-05 用户实测）。所以翻牌的同时
        // 要把实时组开出来——`_ensureThinkOpen` 自带幂等守卫，重入不会开两组。
        this._commit(this._ensureThinkOpen(this.data.blocks))
      } else {
        this._stopThinkTick()
      }
      this._renderBar()
      return
    }
  },

  /**
   * 顶栏。它只由 `client.status` 决定 —— 运行态**不在这里说**：
   * 「思考中…」由最新那条步骤组的实时标签承担（组在跑它就显示"思考中"），
   * 那一块就在用户正在看的最新内容里，不需要再浮一条。
   *
   * 模型（`modelName`）也不在这里算：它是 `ev.model` 帧带来的，与连接状态无关，
   * 混进这个函数会让"状态变了要重算顶栏"与"收到模型帧要更新"两件事互相覆盖。
   */
  _renderBar: function () {
    var c = this.client
    var online = typeof c.status === 'string' && c.status === 'online'
    var text
    if (online) text = '已连接'
    else if (typeof c.status === 'string' && c.status !== 'idle') text = c.statusText || '未连接'
    else text = '未连接'
    this.setData({
      barText: text,
      barTheme: connTheme(c.status),
    })
  },

  /**
   * 待办清单（内核 `todo/write` → `ev.todo`）。
   *
   * 为什么放在这一页的顶部而不是消息流里：它是"这一轮在干什么"的索引，
   * 和步骤组是两种粒度；混进流里会互相踩，而排队消息在底部输入区上方——
   * 顶 / 底分开，两边都不挤（用户 2026-10-05 点的位置）。
   * 三个展示纪律：默认收起（只报进度）、点条子展开、点消息区自动收回。
   */
  /**
   * 把一份清单落到顶部那颗条上（实时帧与历史回放共用同一入口）。
   *
   * 三条纪律：
   * - **同一份快照不重排**：逐条比对后再 setData，每帧都 setData 会让面板白重排；
   * - 派生值（完成数 / 在进行哪条）在这里算完，wxml 里不做运算；
   * - 清单空了收回展开态：内核清空 todo 时不该留一个展开的空面板。
   */

  _setTodos: function (todos) {
    var same =
      todos.length === this.data.todos.length &&
      todos.every(
        function (item, i) {
          var old = this.data.todos[i]
          return !!old && old.content === item.content && old.status === item.status
        }.bind(this),
      )
    if (same) return
    var done = 0
    var live = ''
    for (var i = 0; i < todos.length; i++) {
      if (todos[i].status === 'completed') done++
      else if (todos[i].status === 'in_progress') live = todos[i].content
    }
    this.setData({
      todos: todos,
      todoDone: done,
      todoRunning: live ? 1 : 0,
      todoRunningText: live ? '进行中 ' + live.slice(0, 30) : '',
    })
    // 空的要收回：清单被内核清空时不该留一个展开的空面板。
    if (!todos.length) this.setData({ todosOpen: false })
  },

  /**
   * 实时待办帧。`_todoLive` 一置上，历史回放就再也不许拿过期快照盖它——
   * 实时帧后到，后到者胜（反过来：历史第一页先落地、实时帧随后到，也自然胜出）。
   */
  _onTodo: function (p) {
    // **没有真数据就不许锁死历史回放**（2026-10-06 取证）。
    //
    // `_todoLive` 是一条单向闩锁：置真之后全页再不复位，而 chat.js 的历史落地
    // 处有 `if (first && self._replayTodos && !self._todoLive)` 这道守卫。
    // 原实现在这里**无条件**置真，于是任何一帧形状不对的帧（p.todos 不是数组）
    // 都会把历史回放永久关掉——而那一帧同时还把清单清成了空的，条子也就没了。
    //
    // 形状不对 = 这一帧没有真数据，后到者胜这条规则无从谈起，不该由它裁决。
    if (!Array.isArray(p.todos)) return
    // 注意：**空数组照样置真**。内核跑完一轮会把清单清空并照发一帧空数组
    // （host 侧注释明写"空数组也发"），那是真实的"此刻清单为空"，用户拍板
    // 语义就是取最后一份——所以这里不能把它当成"没数据"。
    this._todoLive = true
    this._setTodos(p.todos)
  },

  onToggleTodos: function () {
    this.setData({ todosOpen: !this.data.todosOpen })
  },

  /** 点消息区（scroll-view 的 catchtap）就收回 —— 展开态是临时的，不该常驻。 */
  onCollapseTodos: function () {
    if (!this.data.todosOpen) return
    this.setData({ todosOpen: false })
  },

  // ── 历史：打开会话时把主机上已有的内容读进来 ───────────────────────
  /**
   * 该不该现在去读第一页。
   *
   * 三个前置条件缺一不可，缺了就**等**而不是失败：还没配对、还没连上、
   * 或者已经在读。等的那几个时刻都会有事件把我们叫回来（status 变化、配对完成）。
   */
  _maybeLoadHistory: function () {
    if (this._historyStarted || this._historyBusy) return
    if (!this.data.sessionId) return
    if (!this.client.isPaired()) return
    if (this.client.status !== 'online') return
    this._historyStarted = true
    this._loadHistory(null)
  },

  /**
   * 读一页历史（`beforeSeq` 为空 = 最新一页）并拼进块流。
   *
   * 拿到的是**与实时流同构的条目**，所以回放走的就是同一套落块函数（`_applyTool` /
   * `_applyText`）——这也是协议层刻意复用 `ev.message_delta` / `ev.tool_event` 的原因。
   */
  _loadHistory: function (beforeSeq) {
    var self = this
    if (this._historyBusy) return
    var first = beforeSeq === undefined || beforeSeq === null
    // 先记下"拼进来之前的第一块"，翻页拼完要把它滚回视口，
    // 否则往前插内容会让页面原地跳动，用户刚读到的那一行会跑掉。
    var anchor = this.data.blocks.length ? 'b' + this.data.blocks[0].key : ''
    this._historyBusy = true
    if (first) this.setData({ historyState: 'loading' })
    else this.setData({ historyLoadingMore: true })

    this.client
      .loadHistory(this.data.sessionId, first ? {} : { beforeSeq: beforeSeq })
      .then(function (page) {
        self._historyBusy = false
        if (!page) {
          // 「读不到」与「没内容」是两件事：把前者显示成后者，用户会以为会话真的是空的。
          if (first) {
            self._historyStarted = false
            self.setData({ historyState: 'error' })
          } else {
            self.setData({ historyLoadingMore: false })
            wx.showToast({ title: '更早的内容没读到', icon: 'none' })
          }
          return
        }
        var items = page.items || []
        // 第一页（此前一个块都没有）带的就是**最新**内容：必须落到底部。旧写法连第一页
        // 也静默，用户每次打开会话都停在最旧处、得自己滚一遍（2026-10-04 用户报的
        // 「自动滚动有点问题」的一半）。往前插**更早**内容时才继续静默——
        // 那会把用户从刚读到的位置甩到最下面。
        var firstPage = self.data.blocks.length === 0
        var replayed = self._replayPage(items)
        var merged = replayed.concat(self.data.blocks)
        self._historyBefore = typeof page.nextBeforeSeq === 'number' ? page.nextBeforeSeq : null
        self.setData({
          historyState: 'ok',
          hasMore: self._historyBefore !== null,
          historyLoadingMore: false,
          toView: anchor || self.data.toView,
        })
        // 第一页落地后再补一次实时组：从列表进一条空历史的执行中会话时，
        // `_onSessions` 那一次 ensureThinkOpen 面对的是空块流（"空流不补"），
        // 等历史回来才该开。幂等守卫在 `_ensureThinkOpen` 里，重入不会开两组。
        if (firstPage && self.data.running) {
          merged = self._ensureThinkOpen(merged)
        }
        self._commit(merged, { noScroll: !firstPage })
        // 待办快照：只应用**第一页**（最新一页）——更早页的快照是过期的，
        // 应用它等于把用户看到的清单往回拨。实时帧已经到过（_todoLive）就
        // 一律不应用：后到者胜，历史不许盖实时。
        if (first && self._replayTodos && !self._todoLive) {
          self._setTodos(self._replayTodos)
        }
      })
  },

  onLoadEarlier: function () {
    if (this.data.historyState === 'error') {
      // 错误的那个状态是"第一页没读到"，重试就该重来一遍第一页
      this._loadHistory(null)
      return
    }
    if (!this.data.hasMore || this._historyBefore === null) return
    this._loadHistory(this._historyBefore)
  },

  /**
   * 把一页历史条目回放进块流，返回**新增的**那些块。
   *
   * 三条与实时路径不同的规则，每一条都对应一种"历史看起来怪"的缺陷：
   * 1. **不补思考段**（`_applyTool` 的 `allowThink=false`）：历史里每一步都结束了，
   *    往回插一条还在走秒的「思考中」，屏幕上会出现一排永远走不完的秒数。
   * 2. **每个用户消息开一个新轮次**：内核日志里没有"轮的标签"，而 `user/message`
   *    就是一轮的开始。实时路径的轮次是本地发指令时自己插的，历史没有那个动作。
   * 3. **与已有块按 id 去重**：会话正在跑的时候进来，同一条消息可能实时渲染过一次、
   *    历史里又出现一次。协议层保证两条路径算出的 `messageId` 逐字相同，所以按 id 去重是可靠的。
   *    用户消息是唯一没有可对齐 id 的（本地回显是即时造的块），退化成按文本对齐。
   */
  _replayPage: function (items) {
    var existing = this.data.blocks
    // 这一页里的最后一份待办快照（全量语义：后面的覆盖前面的）。没有就是 undefined——
    // 调用方据此区分"这页没有待办"与"这页有一条空清单"。
    this._replayTodos = undefined

    /**
     * 下面这几张表**只是"屏幕上已经有的东西"的快照，回放过程中绝不往里登记自己**。
     *
     * 第一版是边回放边登记的，于是同一页里同一次工具调用的「参数」「收尾」两条
     * 被当成重复，第二条（带结果的那条）被丢掉 —— 历史里的工具行永远停在
     * 「正在执行」且结果预览是空的。而一页里同一个 `callId` 出现两次本来就是**正常**的：
     * 主机侧是一条内核事件折成一条线格式条目（`historyPageFromLog`）。
     * 同一条消息的多个 delta 也是同理。去重只该针对"实时已经渲染过、历史里又来一遍"。
     */
    var onScreenText = {}
    var onScreenTool = {}
    /** 本地回显的用户块按文本记数。用户消息没有能跨端对齐的 id，只能按文本对齐。 */
    var localEcho = {}
    for (var i = 0; i < existing.length; i++) {
      var b = existing[i]
      if (b.msgId) onScreenText[b.msgId] = true
      if (b.kind === 'user') {
        var ut = String(b.text || '').trim()
        if (ut) localEcho[ut] = (localEcho[ut] || 0) + 1
      }
      if (b.kind !== 'steps') continue
      for (var j = 0; j < b.items.length; j++) onScreenTool[b.items[j].callId] = true
    }

    var localIndex = {}
    var out = []
    for (var k = 0; k < items.length; k++) {
      var it = items[k]
      // 待办不进块流（它是"此刻的清单"，不是一条消息）：记下最后一份，
      // 由 _loadHistory 在**第一页**落地时应用（更早页的是过期快照）。
      if (it.t === 'ev.todo') {
        if (Array.isArray(it.todos)) this._replayTodos = it.todos
        continue
      }
      if (it.t === 'ev.tool_event') {
        if (it.callId && onScreenTool[it.callId]) continue
        out = this._applyTool(out, it, false)
        continue
      }
      if (it.t !== 'ev.message_delta') continue
      if (it.role === 'user') {
        // 本地已经立刻回显过的那句，历史里又来一遍。**按多重集消耗**而不是简单判相等：
        // 「继续」这种话整个会话里会出现很多次，判相等会把更早那一页里重复的那句也一起吞掉。
        var echo = String(it.delta || '').trim()
        if (echo && localEcho[echo]) {
          localEcho[echo] -= 1
          continue
        }
        out = this._append(out, { key: 'r' + this._counter++, kind: 'turn', label: '', time: '' })
        out = this._append(out, {
          key: 'u' + this._counter++,
          kind: 'user',
          text: it.delta || '',
          confirmed: true,
        })
        continue
      }
      if (it.messageId && onScreenText[it.messageId]) continue
      out = this._applyText(out, localIndex, it.messageId, it.delta || '', true)
    }
    return out
  },

  /**
   * 轮次号按"块流里第几个轮次分隔"重排。
   *
   * 历史是**从最新一页往前拼**的：先加载的那一页编号一定偏小，不重排的话
   * 「加载更早」之后会出现「第 3 轮」排在「第 1 轮」前面，而且之后自己发指令接着的号也是错的。
   */
  _renumberTurns: function (blocks) {
    var n = 0
    var out = []
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i]
      if (b.kind !== 'turn') {
        out.push(b)
        continue
      }
      n++
      var c = copyBlock(b)
      c.label = '第 ' + n + ' 轮'
      out.push(c)
    }
    return { blocks: out, turn: n }
  },

  // ── 流式 delta：先合并，按帧刷 ────────────────────────────────────
  _queueDelta: function (p) {
    var buf = this._deltaBuf
    var e = buf[p.messageId]
    if (!e) {
      e = buf[p.messageId] = { text: '', done: false, role: p.role }
      if (!this._deltaTimer) {
        var self = this
        this._deltaTimer = setTimeout(function () {
          self._deltaTimer = null
          self._flushDelta()
        }, DELTA_FLUSH_MS)
      }
    }
    e.text += p.delta || ''
    e.done = e.done || !!p.done
    if (p.role) e.role = p.role
    if (e.text.length >= DELTA_FLUSH_CHARS || p.done) this._flushDelta()
  },

  _flushDelta: function () {
    var buf = this._deltaBuf
    if (!buf) return
    for (var id in buf) {
      if (!Object.prototype.hasOwnProperty.call(buf, id)) continue
      var e = buf[id]
      if (!e.text && !e.done) continue
      this._applyDelta(id, e.text, e.done, e.role)
      delete buf[id]
    }
  },

  _applyDelta: function (messageId, text, done, role) {
    // 宿主会把用户自己的消息也回传一次（user/message → role:'user'），
    // 而本地已经立刻回显过。不再去重的话屏幕上会出现两遍。
    if (role === 'user') {
      if (text) this._onUserEcho(text)
      return
    }
    this._commit(this._applyText(this.data.blocks, this._textIndex, messageId, text, done))
  },

  /**
   * 把一段助手/系统正文落到块流上（同一个 messageId 的多次 delta 合并成一块）。
   *
   * `index` 是**这一份 blocks 自己的** messageId → 下标表，不是全局的：历史回放是在
   * 一份新数组上重建块流，拿 `this._textIndex`（指向 data.blocks）去查会写到错的位置。
   * 抽出来还有一个更重要的理由：历史与实时必须走**同一段**落块逻辑，
   * 两份实现分叉的表现是"实时看着对、历史看着怪"，很难靠肉眼发现。
   */
  _applyText: function (blocks, index, messageId, text, done) {
    var idx = index[messageId]
    if (idx === undefined || idx >= blocks.length || blocks[idx].kind !== 'text') {
      // **空正文不建块。**
      //
      // 宿主里绝大多数 `assistant/message` 带的是 `reasoning` + `tool-call`（正文是空的），
      // 按 M28 只有 `type==='text'` 的分片出站，于是每一条都会变成一帧
      // `delta:'' + done:true`。第一版照样给它建了一个空text 块，
      // 界面上就是**一排只有 padding 的空白窄条**（真机截图：回复正文下面三个空壳），
      // 而这一页的主题是"看结论"，凭空三行空白比没有更糟。
      //
      // 为什么丢掉这一帧是安全的：那帧唯一的作用是"让手机停止转圈"，
      // 而**没有块就没有转圈**。真正带字的帧随后按messageId 建块，不受影响。
      if (!text) return blocks
      var appended = this._append(blocks, this._withMd({
        key: 'm' + this._counter++,
        kind: 'text',
        msgId: messageId,
        text: text || '',
        done: !!done,
      }))
      index[messageId] = appended.length - 1
      return appended
    }
    var prev = blocks[idx]
    var next = prev.text + (text || '')
    if (next.length > MAX_TEXT_PER_BLOCK) {
      next = '…' + next.slice(next.length - MAX_TEXT_PER_BLOCK)
    }
    var out = blocks.slice()
    out[idx] = this._withMd({
      key: prev.key,
      kind: 'text',
      msgId: prev.msgId,
      text: next,
      done: prev.done || !!done,
    })
    return out
  },

  /**
   * 给一个 text 块补上 markdown 渲染结果（**流式**）。
   *
   * ── 流式的两件事 ───────────────────────────────────────────────────
   * ① **排版**：每帧都把已确定的部分渲染成 nodes。
   *    成本已量过（128 行、2741 字符的典型长回复）：全量重解析 **1.2ms/帧**，
   *    setData 单帧峰值 **22KB**（小程序上限 1MB），所以「跟着现有帧节拍
   *    全量重解析」是可行的 —— 不需要做增量 AST。
   *
   * ② **不跳变**：未闭合的 `**加粗` 会让文字倒退（实测第 7 帧 `a *粗体`，
   *    而正确应是 `a **粗体`）。`core/markdown.js` 的 `renderStream()` 负责
   *    把尾部那几个字符**扣住不渲染**，由 `mdPending` 以纯文本补在末尾。
   *    那一小段本来就是标记符号，纯文本显示它与最终态一致。
   *
   * 派生而不落库：排版结果不进 `store`、不进历史，只有渲染时算。
   * 历史回放与实时都走 `_applyText`，所以两边天然一致。
   *
   * ── 为什么结果挂 `_md` 而不是直接放块上 ──────────────────────────
   * `rich-text` 的 `nodes` **不能绑 `wx:for` 作用域里的变量**：那样它会渲染成
   * 高度 0 的空块，正文在界面上整段消失，而 data、单测、e2e 全绿
   * （这一页真踩过：截图上 `.reply` 里什么都没有，`nodes` 在 data 里却完全正常）。
   *
   * 逐档实测的规律（**只有一条，越写越窄**）：
   *   `{{probeNodes}}`（纯顶层字段）              → 能渲染
   *   `{{mdMap[item.key]}}`（顶层 map + 一层索引） → 能渲染
   *   `{{mdBodies[item.key]}}`（顶层 map + 一层）   → 能渲染
   *   `{{mdBodies[item.key][pi]}}`（**两层**索引）   → 0 高度
   *   `{{part}}`（`wx:for` 的循环项）              → 0 高度
   * 已逐个排除掉的嫌疑：自闭合标签、`wx:key="index"`、`wx:else`、wxss
   * （`line-height` 读出来是 1.65×字号，说明 wxss 生效了；同一位置换成字面量
   *  `nodes` 立刻正常，所以不是样式把它压成 0）。
   *
   * 所以：**每块只挂一份 nodes、只用一个 `rich-text`**，由 `_commit` 收进顶层
   * `mdBodies`，wxml 按 `item.key` 取一层。代价是表格不能再单独包
   * `scroll-view` 横滚（那必然要两层索引），改为列宽按容器百分比分配。
   * `mdPending` 是纯文本、不是 nodes，留在块上没问题。
   *
   * @param {object} b text 块（本函数会改它，所以调用方必须传新对象）
   * @returns {object} 带 _md（nodes）/ mdPending 的块
   */
  _withMd: function (b) {
    if (!b || b.kind !== 'text') return b
    // 正文还是空的时候不要建任何 md 字段：wxml 判 map 里没有这一块时会走
    // 「流式纯文本」那一支，而空文本那一支本来就不该渲染出东西。
    if (!b.text) {
      b._md = null
      b.mdPending = ''
      return b
    }
    try {
      var r = b.done
        ? // done 了不该还有暂扣尾巴（`renderStream` 在 done 时等价于 render）；
          // 显式走 render 分支是为了**不依赖那条性质**，万一将来缓冲规则改了，
          // 最坏也只是"尾部几个字符被当纯文本显示"，不会丢内容。
          { nodes: markdown.render(b.text, theme.current() === 'dark'), pending: '' }
        : markdown.renderStream(b.text, theme.current() === 'dark')
      // **不拆表格**：整块合成一份 nodes，由一个 `rich-text` 一次渲染。
      // 拆表就意味着「每张表一个 scroll-view + rich-text」，而那必然要在 wxml 里
      // 按段落循环，于是 `nodes` 绑到 `wx:for` 的循环项 → 渲染成 0 高度空块
      // （这一页真踩过，详见 data 里 `mdBodies` 的注释）。表格改为列宽按容器
      // 百分比分配，留在正文里一起渲染（core/markdown.js 的 `tableNode`）。
      b._md = { nodes: r.nodes }
      b.mdPending = r.pending
    } catch (e) {
      // 渲染层崩了不能连累正文：退回纯文本那一支（wxml 拿不到 nodes 时就走它）
      b._md = null
      b.mdPending = b.text
    }
    return b
  },

  /**
   * 宿主机回传的用户消息。本地已经回显过同一条，就把它标成"已确认"并丢弃这次回传；
   * 文本对不上（例如是另一个客户端发的）才作为新块追加。
   *
   * 判据是「往回找到的**最近一个未确认**的用户块」，不是「最后 N 个块」——
   * 本地回显与宿主回传之间会夹进思考段和工具块，按距离设窗口迟早会漏。
   */
  _onUserEcho: function (text) {
    var want = String(text || '').trim()
    if (!want) return
    var blocks = this.data.blocks
    for (var i = blocks.length - 1; i >= 0; i--) {
      var b = blocks[i]
      if (b.kind !== 'user' || b.confirmed) continue
      if (String(b.text || '').trim() !== want) break // 最近的一条对不上，那就是另一条消息
      var next = blocks.slice()
      var copy = copyBlock(b)
      copy.confirmed = true
      next[i] = copy
      this._commit(next)
      return
    }
    this._commit(this._append(blocks, { key: 'u' + this._counter++, kind: 'user', text: want, confirmed: true }))
  },

  // ── 工具事件：按 callId 在步骤组里找到那一条，原地更新 ─────────────
  _onTool: function (p) {
    this._commit(this._applyTool(this.data.blocks, p, true))
  },

  /**
   * 把一条工具事件落到块流上。
   *
   * `allowThink` 关掉时不补"思考中"段——历史回放走这条路：历史里的每一步都已经结束了，
   * 往回插一条还在计时的思考段，屏幕上会出现一排永远走不完的秒数。
   */
  _applyTool: function (blocks, p, allowThink) {
    var finished = p.phase === 'completed' || p.phase === 'failed'
    var found = this._findTool(blocks, p.callId)
    var prev = found ? found.item : null

    var item = {
      key: prev ? prev.key : 't' + this._counter++,
      type: 'tool',
      callId: p.callId,
      phase: p.phase,
      tool: p.tool || (prev && prev.tool) || 'tool',
      title: p.title || (prev && prev.title) || '',
      // 参数与结果各存一份：收起时只给结果的首行预览，展开时两段都看得到。
      // 两个字段的来源事件不同（args 在参数帧、result 在收尾帧），所以都要「有则更新」。
      args: p.argsPreview || (prev && prev.args) || '',
      result: finished ? p.resultPreview || '' : (prev && prev.result) || '',
      // 组内某一步的详情**默认收起**：参数与结果往往很长，铺开会让过程卡变成正文。
      // 以前这里跟着全局「展开过程」，那个按钮删了之后就没有"全局意图"可跟随了。
      open: prev ? prev.open : false,
      preview: '',
    }
    item.preview = firstLine(item.result)

    // 工具开始 = 上一段思考结束（思考的时长就是它到下一条内容之间的间隔）
    var next = this._closeThink(blocks)
    // allowThink 同时就是"这是实时还是历史"：实时新组展开（能看见工具在跑什么），
    // 历史回放收起（一屏全是过程就没法读了）。
    next = found ? this._replaceTool(next, found, item) : this._stepsPush(next, item, allowThink)

    // 结果到手了模型要接着想 —— 但两条边界：
    // ① 工具还在跑（started/args）时不补思考，那会儿在跑的是工具，不是模型；
    // ② 这一步后面已经有更新的内容时也不补，否则会插到更晚的内容之后。
    if (allowThink && finished && this._isTailItem(next, item.key)) next = this._ensureThinkOpen(next)
    return next
  },

  // ── 模型 ─────────────────────────────────────────────────────────
  /**
   * 当前模型。**只展示，不假装能切**。
   *
   * 这一代主机内核的 `agentDefaultModel` 上只有 `currentSelection`
   * （取证：status.json 的 `modelFace = no-list+no-set via=currentSelection`），
   * 既列不出候选也写不进去。原来的下拉与候选面板已经删掉：留着"点了会弹
   * 一个空列表"的入口，比没有这个入口更像坏了。
   *
   * 协议字段先立着（`ev.model` 仍带 `options` 与 `canSwitch`），等内核补上写
   * 能力再加回交互，那时协议要同步加一条 `cmd.set_model`。
   */
  _onModel: function (p) {
    var name = String(p.model || '')
    this.setData({
      // 超长截断在这一层做完：wxml 没有"省略"的表达力，交给它判断会出现不一致。
      modelName: name.length > 22 ? name.slice(0, 21) + '…' : name,
    })
  },

  // ── 审批 / 提问 ───────────────────────────────────────────────────
  /**
   * 一次审批请求。
   *
   * `deadlineAt` 用**主机给的绝对时刻减去本机时钟**，然后每tick 重算剩余秒数。
   * 为什么不在收到时就减一次算好：那样经过的秒数不会自己走，180 秒的卡会在
   * 用户眼皮底下一直是"还有 180 秒"，直到主机那边静默拒绝——而用户完全不知道
   * 自己刚才点的那个按钮已经失效了。
   */
  _onPermission: function (p) {
    this.setData({
      pendingPermission: {
        requestId: p.requestId,
        action: p.action || '操作',
        resource: p.resource || '',
        reason: p.reason || '',
        options:
          p.options && p.options.length
            ? p.options
            : [
                { id: 'approve', label: '允许' },
                { id: 'reject', label: '拒绝' },
              ],
        deadlineAt: p.expiresAt ? Date.parse(p.expiresAt) : 0,
        remainSec: 0,
      },
      running: false,
    })
    this._renderBar()
    if (wx.vibrateLong) wx.vibrateLong()
    this._startCardTick()
  },

  /**
   * 挂着的卡片（审批与提问）共用的本地倒数。
   *
   * 为什么一张表管两张卡：这两张卡**可以同时挂着**（同一条会话里一个工具在等审批、
   * 另一个在等回答），而屏幕上只有一个"还剩多久"的位置在各卡自己的头部。
   * 原来那条 tick 只读 `pendingPermission`，所以提问卡就算带了 `expiresAt`
   * 也不会有人替它走数——而主机那边 300 秒就直接判"没答上"了。
   *
   * 到点**不清空卡片**：本地先到期只说明"来不及了"，把卡撤掉会让人以为这次请求根本不存在。
   * 真正该收卡的是 `ev.permission_resolved` / `ev.question_resolved`（精确到某一张）
   * 或 `ev.run_state`（这一会话的两张一起收）。
   */
  _startCardTick: function () {
    this._stopCardTick()
    var self = this
    var keys = ['pendingPermission', 'pendingQuestion']
    var tick = function () {
      var alive = false
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i]
        var card = self.data[key]
        if (!card || !card.deadlineAt) continue
        var remain = Math.max(0, Math.round((card.deadlineAt - Date.now()) / 1000))
        if (remain !== card.remainSec) {
          // 只在**跨过整数秒**时 setData：一秒一次是对的，每帧一次会让整页重渲。
          var patch = {}
          patch[key + '.remainSec'] = remain
          self.setData(patch)
        }
        if (remain > 0) alive = true
      }
      if (!alive) {
        // 两张卡要么不在了、要么都走完：停表，否则它会永远每秒醒一次。
        self._cardTimer = null
        return
      }
      self._cardTimer = setTimeout(tick, 1000)
    }
    // **先立刻算一次**再排下一秒：否则卡片要挂整整一秒才显示数字，
    // 而那正是用户盯着"允许/拒绝"看的时候。
    tick()
  },

  _stopCardTick: function () {
    if (this._cardTimer) {
      clearTimeout(this._cardTimer)
      this._cardTimer = null
    }
  },

  _onQuestion: function (p) {
    var qs = (p.questions || []).map(function (q) {
      return {
        id: q.id,
        question: q.question,
        multi: !!q.multi,
        options: (q.options || []).map(function (o) {
          return { id: o.id, label: o.label, checked: false }
        }),
      }
    })
    this.setData({
      pendingQuestion: {
        requestId: p.requestId,
        questions: qs,
        freeText: '',
        // 主机这一侧 300 秒就直接判"没答上"了，而这张卡以前**没有任何倒计时**：
        // 用户看不见自己按的按钮什么时候作废（协议里刚补的 expiresAt，老宿主不发就是 0/不走表）。
        deadlineAt: p.expiresAt ? Date.parse(p.expiresAt) : 0,
        remainSec: 0,
      },
      running: false,
    })
    this._renderBar()
    if (wx.vibrateLong) wx.vibrateLong()
    this._startCardTick()
  },

  /**
   * 「这张审批卡不用答了」——桌面先答了，或者这次请求被撤回/超时。
   *
   * 只收**对得上 requestId 的那一张**：粗收单那条路（`ev.run_state`）会把这一会话两张卡一起收掉，
   * 这条精确帧负责"只收这一张"。两条主机都发，是因为**手机上装的老版本只认 `ev.run_state`**
   * （分发是一串 `if (p.t === …)`，认不出的 `t` 静默忽略）。
   *
   * 这里**不动 `running`**：桌面先答意味着回合还在跑，而这件事由随后那帧
   * `ev.run_state` 说（主机把两张帧都发了），两处各改一半迟早会打架。
   */
  _onPermissionResolved: function (p) {
    var perm = this.data.pendingPermission
    if (!perm) return
    if (p.requestId && p.requestId !== perm.requestId) return // 不是这一张，别误收
    this.setData({ pendingPermission: null })
    this._renderBar()
  },

  /** 提问卡那条的同款：按 requestId 收，不动运行态。 */
  _onQuestionResolved: function (p) {
    var question = this.data.pendingQuestion
    if (!question) return
    if (p.requestId && p.requestId !== question.requestId) return
    this.setData({ pendingQuestion: null })
    this._renderBar()
  },

  /**
   * 运行态**只认这里**。`ev.message_delta` 的 done 只管"这条消息写完了"，
   * 一轮里可以有好几条 —— 拿它当"这一轮结束"会让状态条在第一次工具调用后就骗人。
   */
  _onRunState: function (p) {
    var running = p.state === 'running'
    var blocks = this.data.blocks
    if (!running) blocks = this._closeThink(blocks)
    // 这条帧是"挂着的审批/提问已经作废"的唯一信号（只有 running/idle 会发），
    // 所以收起卡片的同时必须停掉那个还在走的表，否则它会一直 setData 到天荒地老。
    if (this.data.pendingPermission || this.data.pendingQuestion) this._stopCardTick()
    this.setData({ running: running, pendingPermission: null, pendingQuestion: null })
    if (running) {
      this._startThinkTick()
      blocks = this._ensureThinkOpen(blocks)
    } else {
      this._stopThinkTick()
    }
    this._renderBar()
    this._commit(blocks)
  },

  // ── 步骤组的动作 ──────────────────────────────────────────────────
  /**
   * 追加一个顶层块（轮次 / 指令 / 正文 / 提示）。任何新内容出现都意味着
   * 「这一段过程结束了」—— 收掉组尾那条没结束的思考，并给步骤组封口。
   */
  _append: function (blocks, item) {
    var next = this._closeThink(blocks)
    next = this._sealSteps(next)
    next = next.slice()
    next.push(item)
    return next
  },

  /** 给队尾的步骤组封口：之后的内容不再属于这一组 */
  _sealSteps: function (blocks) {
    var last = blocks[blocks.length - 1]
    if (!last || last.kind !== 'steps' || last.closed) return blocks
    var out = blocks.slice()
    var g = copyBlock(last)
    g.closed = true
    out[out.length - 1] = g
    return out
  },

  /**
   * 往队尾的步骤组里塞一条；没有开放的组就新开一个。
   *
   * **新组一律收起**（2026-10-05 用户：全部场景默认收起，不自动展开，
   * 除非用户自己手动展开）。
   *
   * 以前实时来的组是**展开**的，理由是"用户正是要看它在调什么工具"。但那正是
   * 招人烦的来源：长会话里每来一次工具调用就顶开一段过程，正文被推出屏幕，
   * 想看正文得先一路收回去。默认收起之后，组头那行汇总（"执行 N 步 · 最后是 Bash"）
   * 已经足够说明它在干什么，想看细节由用户点开。
   *
   * `forceOpen` 参数保留但**不再生效**（恒为 false）：两个调用点照旧显式传值，
   * 免得日后有人以为"漏传会静默展开"又把它改回去。展开与否该由用户点开决定
   * （onToggleSteps），不该由数据流决定。
   */
  _stepsPush: function (blocks, item, forceOpen) {
    var last = blocks[blocks.length - 1]
    var out = blocks.slice()
    if (last && last.kind === 'steps' && !last.closed) {
      var g = copyBlock(last)
      g.items = g.items.concat([item])
      out[out.length - 1] = g
      return out
    }
    out.push({
      key: 'x' + this._counter++,
      kind: 'steps',
      items: [item],
      // 恒为 false：默认收起（理由见上面的注释）。forceOpen 只留下来让调用点
      // 显式声明"这里本可以展开"，不再真的展开。
      open: false,
      closed: false,
    })
    return out
  },

  /** 收掉组内最后一条还没结束的思考，记下它实际等了多久 */
  _closeThink: function (blocks) {
    var last = blocks[blocks.length - 1]
    if (!last || last.kind !== 'steps') return blocks
    var items = last.items
    var tail = items[items.length - 1]
    if (!tail || tail.type !== 'think' || tail.done) return blocks
    var it = copyBlock(tail)
    it.done = true
    it.ms = Date.now() - tail.startedAt
    it.msText = fmtMs(it.ms)
    var out = blocks.slice()
    var g = copyBlock(last)
    g.items = items.slice()
    g.items[g.items.length - 1] = it
    out[out.length - 1] = g
    return out
  },

  /**
   * 还在跑、且组尾没有「未结束的思考」→ 补一条。
   * 于是「思考 → 工具 → 思考 → 工具 → 正文」这个节奏自己就出来了，
   * 不需要宿主额外告诉我们模型在想什么（M28：思维链正文根本不出站）。
   */
  _ensureThinkOpen: function (blocks) {
    if (!this.data.running) return blocks
    var last = blocks[blocks.length - 1]
    // 空流不补：那一轮还没开始，状态由顶栏表达，凭空冒出一条「思考中」反而落单
    if (!last) return blocks
    // 组已封口（后面已经有正文了）就不再往回插
    if (last.kind === 'steps' && last.closed) return blocks
    if (last.kind === 'steps') {
      var items = last.items
      var tail = items[items.length - 1]
      if (tail && tail.type === 'think' && !tail.done) return blocks
    }
    this._startThinkTick()
    // 这里只会在运行时走到（上面已 return），所以是实时新建的组 → 展开
    return this._stepsPush(
      blocks,
      {
        key: 'k' + this._counter++,
        type: 'think',
        startedAt: Date.now(),
        msText: '',
        done: false,
      },
      true,
    )
  },

  /** 按 callId 在步骤组里找那一条 */
  _findTool: function (blocks, callId) {
    for (var i = blocks.length - 1; i >= 0; i--) {
      var g = blocks[i]
      if (g.kind !== 'steps') continue
      for (var j = g.items.length - 1; j >= 0; j--) {
        if (g.items[j].type === 'tool' && g.items[j].callId === callId) {
          return { bi: i, ii: j, item: g.items[j] }
        }
      }
    }
    return null
  },

  _replaceTool: function (blocks, found, item) {
    var out = blocks.slice()
    var g = copyBlock(out[found.bi])
    g.items = g.items.slice()
    g.items[found.ii] = item
    out[found.bi] = g
    return out
  },

  /** 这一条是不是还在队尾（决定能不能在它后面补思考段） */
  _isTailItem: function (blocks, key) {
    var last = blocks[blocks.length - 1]
    if (!last || last.kind !== 'steps') return false
    var items = last.items
    var tail = items[items.length - 1]
    return !!tail && tail.key === key
  },

  /**
   * 思考的秒数每秒走一格，让「在动」这件事可见（只有队尾那一条需要动）。
   *
   * 整个组重新派生一次而不是只改 `msText`：`plain` 组的耗时写在**标题**里
   * （组内那行不渲染），只更新组内条目的话标题会一直停在 0。
   */
  _startThinkTick: function () {
    if (this._thinkTimer) return
    var self = this
    this._thinkTimer = setInterval(function () {
      var blocks = self.data.blocks
      var bi = blocks.length - 1
      var g = blocks[bi]
      if (!g || g.kind !== 'steps' || g.closed) return
      var items = g.items
      var ii = items.length - 1
      var it = items[ii]
      if (!it || it.type !== 'think' || it.done) return
      var head = copyBlock(items[ii])
      head.msText = fmtMs(Date.now() - it.startedAt)
      var nextItems = items.slice()
      nextItems[ii] = head
      var g2 = copyBlock(g)
      g2.items = nextItems
      self.setData({ ['blocks[' + bi + ']']: decorateSteps(g2) })
    }, THINK_TICK_MS)
  },

  _stopThinkTick: function () {
    if (this._thinkTimer) {
      clearInterval(this._thinkTimer)
      this._thinkTimer = null
    }
  },

  // ── 折叠：窗口管理 ────────────────────────────────────────────────
  /** 展开/收起某一个步骤组 */
  onToggleSteps: function (e) {
    var bi = Number(e.currentTarget.dataset.idx)
    var g = this.data.blocks[bi]
    if (!g || g.kind !== 'steps') return
    this.setData({ ['blocks[' + bi + '].open']: !g.open })
    this._afterFold()
  },

  /** 展开/收起某一步的细节（参数与完整结果） */
  onToggleTool: function (e) {
    var bi = Number(e.currentTarget.dataset.b)
    var ii = Number(e.currentTarget.dataset.i)
    var g = this.data.blocks[bi]
    if (!g || g.kind !== 'steps' || !g.items[ii]) return
    this.setData({ ['blocks[' + bi + '].items[' + ii + '].open']: !g.items[ii].open })
    this._afterFold()
  },

  // ── 块流提交：从头部裁剪，绝不在块中间下刀 ────────────────────────
  _trim: function (blocks) {
    if (blocks.length <= MAX_BLOCKS) return blocks
    var dropped = blocks.length - MAX_BLOCKS
    var kept = blocks.slice(dropped)
    kept.unshift({
      key: 'trim',
      kind: 'note',
      text: '…已省略较早的 ' + dropped + ' 个片段（仅保留最近 ' + MAX_BLOCKS + ' 个）',
    })
    return kept
  },

  /** 裁剪后下标全变了，重建索引表，否则后续 delta 会写到错误的位置 */
  _reindex: function (blocks) {
    this._textIndex = {}
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].msgId) this._textIndex[blocks[i].msgId] = i
    }
  },

  /** 步骤组的展示字段（label/tools/live）统一在这里派生，渲染层只管取 */
  _decorate: function (blocks) {
    return blocks.map(function (b) {
      return b.kind === 'steps' ? decorateSteps(b) : b
    })
  },

  _commit: function (blocks, opts) {
    var self = this
    // 轮次号统一在这里重排：历史往前拼、实时往后接，两种方向都会让编号漂
    var renumbered = this._renumberTurns(blocks)
    var trimmed = this._trim(this._decorate(renumbered.blocks))
    this._reindex(trimmed)
    // markdown 的 nodes 收进**顶层** map：wxml 要按 `item.key` 取，不能直接
    // 绑块上的字段（`rich-text` 那样会渲染成 0 高度空块，见 `_withMd` 的说明）。
    // 每次**整份重建**而不是增量改：块数有上限（MAX_BLOCKS），一份重建的
    // 成本就是一次遍历，而增量改要额外判断"哪一块被裁掉了"，漏一次就是
    // 一块永远留在 map 里的孤儿 nodes（会渲染出一段没人能解释的内容）。
    var bodies = {}
    for (var i = 0; i < trimmed.length; i++) {
      var b = trimmed[i]
      if (b._md) bodies[b.key] = b._md.nodes
    }
    this.setData({ blocks: trimmed, turn: renumbered.turn, mdBodies: bodies }, function () {
      // 只在用户还贴着底部时跟随；他往上翻过就让他安静地读。
      // 「加载更早」那一路显式静音：往前插内容时跟底会把他从刚读到的位置甩走。
      if (!(opts && opts.noScroll) && self._autoScroll) self._scrollToBottom()
    })
  },

  // ── 出站 ──────────────────────────────────────────────────────────
  onInput: function (e) {
    this.setData({ inputText: e.detail.value })
  },

  onSend: function () {
    var text = String(this.data.inputText || '').trim()
    var images = this.data.attachments.slice()
    var files = images.filter(function (a) { return a.kind === 'file' })
    var pics = images.filter(function (a) { return a.kind !== 'file' })
    if (!text && !images.length) return
    if (!this.data.sessionId) return
    // 执行中不许提交（2026-10-05 用户：取消排队）。
    // 这条在 wxml 上已经做了一层（发送键在跑时变成中断键），这里是兜底：
    // 键盘的 send 键走的是 bindconfirm，绕不过那颗按钮，光靠按钮拦不住。
    if (this.data.running) {
      wx.showToast({ title: '正在跑，先中断再发', icon: 'none' })
      return
    }
    this.setData({ inputText: '', attachments: [], attachCount: 0 })
    this._sendNow(text, images, files, pics)
  },

  /**
   * 本地回显 + 发出去，然后等主机回执。
   *
   * 回执只有一个用处：没发出去时说一句原因。取消排队之前这里还有一条
   * "pending 视图"要维护，现在没有了——消息要么到了主机，要么没到，
   * 不存在"收到了但还在等"这种中间态（用户：排队没有意义）。
   */
  _sendNow: function (text, images, files, pics) {
    // 轮次号交给 `_commit` 重排（它知道历史那一侧已经占了多少轮），这里只给时间
    var blocks = this._append(this.data.blocks, {
      key: 'r' + this._counter++,
      kind: 'turn',
      label: '',
      time: clockText(Date.now()),
    })
    blocks = this._append(blocks, {
      key: 'u' + this._counter++,
      kind: 'user',
      text: text,
      confirmed: false,
      // 附件跟着这条回显一起显示：本机临时文件，会话里看得见（主机存的是另一份）
      images: images,
      files: files,
      attachCount: images.length,
    })
    // 自己发的消息必须看到
    this._autoScroll = true
    this.setData({ atBottom: true })
    this._commit(blocks)
    this._dispatch(text, pics, files)
  },

  /**
   * 发给主机 + 等回执。**不碰回显块**：重发一条没收下的消息时
   * 会话里那一行已经在原地了，再画一遍就是两条。
   *
   * 2026-10-05 取消排队：回执只剩「发出去 / 没发出去」两种，没有中间态。
   * 没发出去就 toast 一句原因——用户看到的是一次失败，而不是一条撤不掉的幽灵。
   */
  _dispatch: function (text, images, files) {
    this.client
      .sendPromptReceipt(this.data.sessionId, text, images, files)
      .then(function (r) {
        if (r.ok) return
        wx.showToast({ title: String(r.message || '这条没发出去').slice(0, 40), icon: 'none' })
      })
      .catch(function () {
        wx.showToast({ title: '这条没发出去', icon: 'none' })
      })
  },












  // ── 图片附件：加号 → 相册（拍照与文件这一代先不做）───
  /**
   * 2026-10-05 用户改主意：'文件要放在加号里面，弹出选图片还是文件'。
   * 1.1.5 删掉那个二级菜单，是因为当时只有图片、多一次点击纯属浪费；
   * 现在有图片和文件两种，选哪个是用户的决定，不是我能替他定的。
   *
   * 用**原生 showActionSheet**，不自建面板：两行代码、平台一致、
   * 不用新样式也不引图标（这一页一个图标组件都没有）。
   *
   * 条数上限的提示留着：满了还弹选择是浪费一次点击，
   * 但满这件事得说清楚，不然用户会以为加号坏了。
   */
  onAttach: function () {
    var self = this
    var room = MAX_ATTACH - this.data.attachments.length
    if (room <= 0) {
      wx.showToast({ title: '一条消息最多带 ' + MAX_ATTACH + ' 个附件', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: ['图片', '文件'],
      success: function (r) {
        // 用户取消时 success 不来，什么都不做——那是"改主意了"，不是错误
        if (r.tapIndex === 1) self._pickFiles()
        else self._pickImages()
      },
    })
  },

  /** 相册选图。走 压缩 -> 缩到定长边 -> 读成 base64 那条老链。 */
  _pickImages: function () {
    var self = this
    var room = MAX_ATTACH - this.data.attachments.length
    if (room <= 0) {
      wx.showToast({ title: '一条消息最多带 ' + MAX_ATTACH + ' 个附件', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: room,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: function (r) {
        self._compressPicked(r.tempFiles || [])
      },
    })
  },

  /**
   * 逐张：压缩 → 缩到定长边 → 读成 base64。
   *
   * 三步而不是一步，是因为**压缩在两个平台上不是同一件事**：
   *   - iOS 上 `wx.compressImage` 的 quality 真的管事；
   *   - Android 上它被系统忽略（只按 sizeType 走一遍），相册给的 `compressed`
   *     仍是个一两 MB 的大文件。
   * 所以第二步用画布把长边钉死在 {@link IMAGE_LONG_EDGE}：这一步两个平台都算数，
   * 出来的 jpeg 通常 100～350KB——**这正是用户要的"压缩发过去"**（2026-10-05
   * 用户："为什么要识别，压缩发过去就行了"）。
   *
   * 每一步失败都不挡路，一路退到原文件：没有画布就用 compressImage 的结果，
   * 没有 compressImage 就用相册给的文件。最坏情况只是体积大一点，由第三步的
   * 预算明说——但不该"加不进来"。
   *
   * 2026-10-05 用户两次报"图片无法添加"。第一次根因是字段名：`f.path` 不存在，
   * 读的是个 undefined（见下面 readAsBase64 的注释）。第二次根因是 1.1.6 我加的
   * **单张 300KB 闸**——手机照片压完普遍 300～800KB，于是每张都被它挡在门外。
   * 闸要留（中继 1MB 硬帧上限，见 {@link MAX_IMAGE_TOTAL_BYTES} 的注释），
   * 但得先把图真的压小，而不是拿闸去挡用户。
   */
  /**
   * 文件附件入口（2026-10-05 用户：文件附件也支持一下）。
   *
   * 与图片入口的三处不同：
   * 1. 用 chooseMessageFile 而不是 chooseMedia——它给的是微信会话/收藏里的任意文件，
   *    type 字段就是扩展名（不带点）。
   * 2. **没有压缩**。图压完还是图，文件压完就打不开了——用户要的是把这个东西发给
   *    Agent 看，不是一张更糊的图。所以体积纪律全靠预算闸。
   * 3. 与图片共用同一条预算：中继单帧 1MB 是硬上限，超了整帧被掐、socket 1009
   *    莫名掉线。合计算不清的账不能让用户付。
   */
  /**
   * 长按复制一条聊天信息（2026-10-05 用户：chat 中的聊天信息要可以复制）。
   *
   * 三处决定：
   * 1. **只认 user / text 两种块**。步骤组不给复制——用户明说 steps 不用，
   *    而且那一条的价值在"它调了什么工具"，脱离会话复制出去没有意义。
   *    wxml 里只在那两种气泡上绑 bindlongpress，这里是第二道。
   * 2. **复制 item.text 原文，不做任何加工**。界面上 reply 那一条是渲染后的
   *    markdown，但复制的仍是模型产出的原文：用户要的是"这一条的内容"，
   *    不是一个被我猜过怎么排版的新版本。
   * 3. **空文本不动作**。只有附件的消息（item.text 为空）长按不会有反应，
   *    而不是把空串塞进剪贴板——那会覆盖掉用户原本复制的东西。
   */
  onCopyMessage: function (e) {
    var ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    var text = String(ds.text || '')
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        // 中性色，不用成功色：这是"做完了"，不是需要用户注意的事
        wx.showToast({ title: '已复制', icon: 'none' })
      },
    })
  },
  /** 微信会话/收藏里选文件。入口是加号里那一项（见 onAttach）。 */
  _pickFiles: function () {
    var self = this
    var room = MAX_ATTACH - this.data.attachments.length
    if (room <= 0) {
      wx.showToast({ title: '一条消息最多带 ' + MAX_ATTACH + ' 个附件', icon: 'none' })
      return
    }
    wx.chooseMessageFile({
      count: room,
      success: function (r) {
        self._acceptPickedFiles(r.tempFiles || [])
      },
    })
  },

  /** 逐份文件：读成 base64 -> 过预算闸 -> 进 attachments。
   *
   * 读的是 tempFilePath（chooseMessageFile 给的就是这个字段；1.1.6 踩过的坑：
   * 老代码读 f.path，那个字段从来不存在，于是每张图都读不出来）。
   */
  _acceptPickedFiles: function (files) {
    var self = this
    var out = []
    var i = 0
    var next = function () {
      if (i >= files.length) {
        var kept = self.data.attachments.concat(out).slice(0, MAX_ATTACH)
        self.setData({ attachments: kept, attachCount: kept.length })
        return
      }
      var f = files[i++]
      var filePath = f.tempFilePath
      if (!filePath) {
        wx.showToast({ title: '这个文件读不出来 换一个试试', icon: 'none' })
        next()
        return
      }
      var meta = {
        kind: 'file',
        name: f.name || f.fileName,
        type: f.type,
        size: f.size,
      }
      self._readAsBase64(filePath, meta, out, next, self)
    }
    next()
  },

  /** 过预算闸 + 进 attachments。图片那两道闸（单张/合计）原样复用。
   *
   * 名字保留扩展名：Agent 认文件靠它（主机侧 safeSegment 只收敛字符，不动点）。
   */
  _acceptFile: function (filePath, meta, base64, out, done) {
    var self = this
    if (!base64) {
      wx.showToast({ title: '这个文件读不出来 换一个试试', icon: 'none' })
      done()
      return
    }
    var bytes = Math.floor((base64.length * 3) / 4)
    var already = 0
    for (var k = 0; k < self.data.attachments.length; k++) {
      already += Math.floor((self.data.attachments[k].data.length * 3) / 4)
    }
    for (var m = 0; m < out.length; m++) {
      already += Math.floor((out[m].data.length * 3) / 4)
    }
    if (bytes > MAX_ATTACH_BYTES) {
      wx.showToast({
        title:
          '这个文件有 ' +
          Math.round(bytes / 1024) +
          'KB 超过单附件上限 ' +
          Math.round(MAX_ATTACH_BYTES / 1024) +
          'KB',
        icon: 'none',
      })
      done()
      return
    }
    if (already + bytes > MAX_ATTACH_TOTAL_BYTES) {
      wx.showToast({
        title:
          '一条消息最多 ' +
          Math.round(MAX_ATTACH_TOTAL_BYTES / 1024) +
          'KB 附件 已经带了 ' +
          Math.round(already / 1024) +
          'KB',
        icon: 'none',
      })
      done()
      return
    }
    out.push({
      kind: 'file',
      name: String(meta.name || meta.fileName || 'file-' + out.length),
      path: filePath,
      data: base64,
      mediaType: meta.type || undefined,
      size: bytes,
    })
    done()
  },
  _compressPicked: function (files) {
    var self = this
    var out = []
    var i = 0
    var next = function () {
      if (i >= files.length) {
        var kept = self.data.attachments.concat(out).slice(0, MAX_ATTACH)
        self.setData({ attachments: kept, attachCount: kept.length })
        return
      }
      var f = files[i++]
      var picked = f.tempFilePath
      wx.compressImage({
        src: picked,
        quality: IMAGE_QUALITY,
        success: function (c) {
          self._shrinkPicked(c.tempFilePath, f, out, next)
        },
        fail: function () {
          self._shrinkPicked(picked, f, out, next)
        },
      })
    }
    next()
  },

  /** 页面上那块藏起来的 2d 画布（懒建 + 缓存）。没有画布能力回 null。 */
  _shrinkCanvas: function () {
    if (this._canvasNode !== undefined) return this._canvasNode || null
    if (!env.probe().canvas) {
      this._canvasNode = null
      return null
    }
    var node = null
    wx.createSelectorQuery()
      .select('#drc-shrink')
      .fields({ node: true, size: true })
      .exec(function (res) {
        node = res && res[0] ? res[0].node : null
      })
    this._canvasNode = node
    return node
  },

  /**
   * 把长边钉死。本来就小的图原样放过——缩一张 800px 的截图只会更糊。
   *
   * 为什么不靠 compressImage 反复降 quality：Android 上 quality 被忽略，
   * 那条路在 Android 上一格都不降。
   */
  _shrinkPicked: function (path, meta, out, done) {
    var self = this
    var canvas = this._shrinkCanvas()
    if (!canvas) {
      this._readAsBase64(path, meta, out, done, this)
      return
    }
    wx.getImageInfo({
      src: path,
      success: function (info) {
        var long = Math.max(info.width, info.height)
        if (!long || long <= IMAGE_LONG_EDGE) {
          self._readAsBase64(path, meta, out, done, self)
          return
        }
        var scale = IMAGE_LONG_EDGE / long
        var w = Math.max(1, Math.round(info.width * scale))
        var h = Math.max(1, Math.round(info.height * scale))
        var ctx = canvas.getContext('2d')
        var img = canvas.createImage()
        img.onload = function () {
          canvas.width = w
          canvas.height = h
          ctx.drawImage(img, 0, 0, w, h)
          wx.canvasToTempFilePath({
            canvas: canvas,
            fileType: 'jpg',
            quality: IMAGE_QUALITY,
            success: function (r) {
              self._readAsBase64(r.tempFilePath, info, out, done, self)
            },
            fail: function () {
              self._readAsBase64(path, meta, out, done, self)
            },
          })
        }
        img.onerror = function () {
          self._readAsBase64(path, meta, out, done, self)
        }
        img.src = path
      },
      fail: function () {
        self._readAsBase64(path, meta, out, done, self)
      },
    })
  },

  /**
   * 读成 base64，然后按字节数过闸。
   *
   * 2026-10-05 用户报"选图片都是提示这张图读不出来"，根因是 `wx.chooseMedia` 回来的是
   * **`tempFilePath`** 而代码读 `f.path`——那个字段从来不存在。
   * 另有一条真机特有的坑：chooseMedia 有时给的是 `http://tmp/xxx`（本地临时服务
   * 地址）而不是 `wxfile://`，readFile 不认它。所以读失败时**再走一次 downloadFile**
   * 把它落到真正的本地文件，两条路都读不到才认输。
   */
  _readAsBase64: function (path, meta, out, done, self) {
    if (!self) self = this
    var isFile = meta && meta.kind === 'file'
    var giveUp = function () {
      wx.showToast({ title: isFile ? '换一个试试' : '这张图读不出来', icon: 'none' })
      done()
    }
    var triedDownload = false
    var readIt = function (filePath) {
      wx.getFileSystemManager().readFile({
        filePath: filePath,
        encoding: 'base64',
        success: function (r) {
          var base64 = String(r.data || '')
          if (isFile) self._acceptFile(filePath, meta, base64, out, done)
          else self._acceptImage(path, filePath, meta, base64, out, done)
        },
        fail: function () {
          // `http://tmp/...` 那条路：本地临时服务地址，readFile 不认它，
          // 但 downloadFile 认——先落到 wxfile:// 再读一次。
          if (!triedDownload && /^https?:\/\//.test(filePath)) {
            triedDownload = true
            wx.downloadFile({
              url: filePath,
              success: function (d) {
                if (d.statusCode === 200 && d.tempFilePath) readIt(d.tempFilePath)
                else giveUp()
              },
              fail: giveUp,
            })
            return
          }
          giveUp()
        },
      })
    }
    readIt(path)
  },

  /**
   * 过体积闸 + 进 attachments。拆出来是要能单测（判据直接喂 base64 长度）。
   *
   * 为什么是这两条闸：整条载荷是 JSON，图片只能 base64 进门（协议里的
   * imageAttachment 就是这么定的，主机那头没有手机上这个文件）；而中继那条
   * 连接有 1MB 的硬帧上限（`DRC_MAX_MSG_BYTES`）——超了不是"发不出去"，
   * 是**整条帧被掐、socket 1009 断开**，用户看到的是莫名掉线。而 base64
   * 会把体积撑大 4/3，再算上密文封装，一条消息里图片原始字节超过约 540KB
   * 就过不去了。所以闸是：**单张不超过 {@link MAX_IMAGE_BYTES}，一条消息
   * 合计不超过 {@link MAX_IMAGE_TOTAL_BYTES}**，超了明说该减哪一张。
   *
   * 2026-10-05：单张闸原本是 300KB，把每张手机照片都挡在门外（用户连报两次
   * "图片无法添加"）。画布缩图上线之后单张 512KB 已经够宽——缩到 1600 长边的
   * jpeg 通常 100～350KB——这道闸从此只是兜底，不再是墙。
   */
  _acceptImage: function (shownPath, realPath, meta, base64, out, done) {
    var self = this
    var bytes = Math.floor((base64.length * 3) / 4)
    var already = 0
    for (var k = 0; k < self.data.attachments.length; k++) {
      already += Math.floor((self.data.attachments[k].data.length * 3) / 4)
    }
    for (var m = 0; m < out.length; m++) {
      already += Math.floor((out[m].data.length * 3) / 4)
    }
    if (bytes > MAX_IMAGE_BYTES) {
      wx.showToast({
        title: '这张图压完还有 ' + Math.round(bytes / 1024) + 'KB 太大 换一张或截一下',
        icon: 'none',
      })
      done()
      return
    }
    if (already + bytes > MAX_IMAGE_TOTAL_BYTES) {
      wx.showToast({
        title:
          '一条消息最多 ' +
          Math.round(MAX_IMAGE_TOTAL_BYTES / 1024) +
          'KB 图片 已经带了 ' +
          Math.round(already / 1024) +
          'KB',
        icon: 'none',
      })
      done()
      return
    }
    out.push({
      name: 'img-' + Date.now() + '-' + out.length + '.jpg',
      // path 只在本机显示用（回显缩略图）；**不上线**（sendPrompt 只映射 wire 要的字段）
      path: shownPath,
      data: base64,
      width: meta.width,
      height: meta.height,
    })
    done()
  },

  /** 撤掉全部已选图片（缩略图条删了，逐个撤没有落点，整批撤就好）。 */
  onClearAttachments: function () {
    if (!this.data.attachments.length) return
    this.setData({ attachments: [], attachCount: 0 })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  /** 从队列里撤回一条（还没发出去，撤就是真撤）。 */

  onInterrupt: function () {
    if (!this.data.sessionId) return
    this.client.interrupt(this.data.sessionId)
    wx.showToast({ title: '已发送中断', icon: 'none' })
  },

  onPermissionTap: function (e) {
    var decision = e.currentTarget.dataset.decision
    var perm = this.data.pendingPermission
    if (!perm) return
    this._stopCardTick()
    this.setData({ pendingPermission: null, running: decision !== 'reject' })
    this._renderBar()
    this.client.resolvePermission(this.data.sessionId, perm.requestId, decision)
  },

  onOptionTap: function (e) {
    var qi = Number(e.currentTarget.dataset.qi)
    var oi = Number(e.currentTarget.dataset.oi)
    var q = this.data.pendingQuestion
    if (!q) return
    var questions = q.questions.map(function (x, i) {
      if (i !== qi) return x
      var opts = x.options.map(function (o, j) {
        if (x.multi) return j === oi ? { id: o.id, label: o.label, checked: !o.checked } : o
        return { id: o.id, label: o.label, checked: j === oi }
      })
      return { id: x.id, question: x.question, multi: x.multi, options: opts }
    })
    this.setData({ 'pendingQuestion.questions': questions })
  },

  onFreeText: function (e) {
    this.setData({ 'pendingQuestion.freeText': e.detail.value })
  },

  onAnswer: function () {
    var q = this.data.pendingQuestion
    if (!q) return
    var answers = []
    var missing = false
    for (var i = 0; i < q.questions.length; i++) {
      var qq = q.questions[i]
      var selected = []
      for (var j = 0; j < qq.options.length; j++) {
        if (qq.options[j].checked) selected.push(qq.options[j].id)
      }
      if (!selected.length && !q.freeText) missing = true
      answers.push({ questionId: qq.id, selected: selected, freeText: q.freeText || undefined })
    }
    if (missing) {
      wx.showToast({ title: '请先选择一项', icon: 'none' })
      return
    }
    this.setData({ pendingQuestion: null, running: true })
    this._renderBar()
    this.client.answer(this.data.sessionId, q.requestId, answers)
  },
})
