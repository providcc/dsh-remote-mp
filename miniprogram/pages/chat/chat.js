'use strict'

var client = require('../../core/client.js')
var theme = require('../../core/theme.js')

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

/** 连接态 → 顶栏胶囊的语义色 */
function connTheme(status) {
  if (status === 'online') return 'success'
  if (status === 'connecting' || status === 'pairing') return 'primary'
  if (status === 'error') return 'danger'
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
  },

  onLoad: function (options) {
    this.client = client.getClient()
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
    this._scrollH = 0
    this._historyBusy = false
    this._historyStarted = false
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
    this._renderBar()
    this.client.listSessions()
    this._maybeLoadHistory()
  },

  onHide: function () {
    if (this._deltaTimer) {
      clearTimeout(this._deltaTimer)
      this._deltaTimer = null
    }
    this._flushDelta()
    this._stopThinkTick()
    this._stopPermTick()
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  onUnload: function () {
    this._stopThinkTick()
    this._stopPermTick()
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  // ── 滚动：自动跟随 vs 用户回看 ────────────────────────────────────
  onScroll: function (e) {
    var d = e.detail || {}
    // 往上滑（内容下移）= 回看历史，立刻停止自动跟随，否则每一帧都会把他拽回来
    if ((d.deltaY || 0) < 0) {
      if (this._autoScroll) {
        this._autoScroll = false
        this.setData({ atBottom: false })
      }
      return
    }
    var h = this._scrollH
    if (!h || typeof d.scrollHeight !== 'number') return
    var atBottom = d.scrollTop + h >= d.scrollHeight - 24
    if (atBottom !== this._autoScroll) {
      this._autoScroll = atBottom
      this.setData({ atBottom: atBottom })
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
      return
    }
    if (evt.kind === 'error') {
      wx.showToast({ title: String(evt.message || '').slice(0, 40), icon: 'none' })
      return
    }
    if (evt.kind !== 'payload') return
    var p = evt.payload

    // 模型是**全局**的，必须在下面那句会话过滤**之前**判。
    // 协议上 `ev.model` 不带 sessionId，所以那句现在对它不成立；但一旦有人
    // 为了排障给它补上 sessionId（或者帧里混进了别的字段），模型名就会静默
    // 变成空白 —— 而"模型名空白"看着像主机没给模型，排查方向会被带偏。
    if (p.t === 'ev.model') return this._onModel(p)

    if (p.sessionId && p.sessionId !== this.data.sessionId) return // 不是本会话

    // 会话列表是"这条会话此刻在不在跑"的权威来源。这一页原来完全没看它，
    // 于是从列表点进一条**正在跑**的会话时，顶栏会一直显示"空闲"，
    // 直到那条会话恰好又推了一次运行态。
    if (p.t === 'ev.session_changed') return this._onSessions(p)

    if (p.t === 'ev.message_delta') return this._queueDelta(p)
    if (p.t === 'ev.tool_event') return this._onTool(p)
    if (p.t === 'ev.permission_request') return this._onPermission(p)
    if (p.t === 'ev.question_request') return this._onQuestion(p)
    if (p.t === 'ev.run_state') return this._onRunState(p)
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
      if (!running) this._stopThinkTick()
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
        var replayed = self._replayPage(items)
        var merged = replayed.concat(self.data.blocks)
        self._historyBefore = typeof page.nextBeforeSeq === 'number' ? page.nextBeforeSeq : null
        self.setData({
          historyState: 'ok',
          hasMore: self._historyBefore !== null,
          historyLoadingMore: false,
          toView: anchor || self.data.toView,
        })
        // 往前插内容时**不许**自动跟底：那会把用户从刚读到的位置甩到最下面
        self._commit(merged, { noScroll: true })
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
      var appended = this._append(blocks, {
        key: 'm' + this._counter++,
        kind: 'text',
        msgId: messageId,
        text: text || '',
        done: !!done,
      })
      index[messageId] = appended.length - 1
      return appended
    }
    var prev = blocks[idx]
    var next = prev.text + (text || '')
    if (next.length > MAX_TEXT_PER_BLOCK) {
      next = '…' + next.slice(next.length - MAX_TEXT_PER_BLOCK)
    }
    var out = blocks.slice()
    out[idx] = {
      key: prev.key,
      kind: 'text',
      msgId: prev.msgId,
      text: next,
      done: prev.done || !!done,
    }
    return out
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
    this._startPermTick()
  },

  /** 审批卡的本地倒数。宿主超时会自动拒绝，所以这里只负责"让人看见时间在走"。 */
  _startPermTick: function () {
    this._stopPermTick()
    var self = this
    var tick = function () {
      var perm = self.data.pendingPermission
      if (!perm || !perm.deadlineAt) {
        self._stopPermTick()
        return
      }
      var remain = Math.max(0, Math.round((perm.deadlineAt - Date.now()) / 1000))
      // 只在**跨过整数秒**时 setData：一秒一次是对的，每帧一次会让整页重渲。
      if (remain === perm.remainSec) {
        // 数字没变不代表没事干：到期后要停表，否则它会永远每秒醒一次。
        if (remain <= 0) self._stopPermTick()
        return
      }
      self.setData({ 'pendingPermission.remainSec': remain })
      if (remain <= 0) {
        self._stopPermTick()
        // 不清空卡片：主机那边还在等一个决定，本地先到期只说明"来不及了"，
        // 直接把卡撤掉会让人以为请求根本不存在。
        return
      }
      self._permTimer = setTimeout(tick, 1000)
    }
    // **先立刻算一次**再排下一秒：否则卡片要挂整整一秒才显示数字，
    // 而那正是用户盯着"允许/拒绝"看的时候。
    tick()
  },

  _stopPermTick: function () {
    if (this._permTimer) {
      clearTimeout(this._permTimer)
      this._permTimer = null
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
    this.setData({ pendingQuestion: { requestId: p.requestId, questions: qs, freeText: '' }, running: false })
    this._renderBar()
    if (wx.vibrateLong) wx.vibrateLong()
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
    if (this.data.pendingPermission || this.data.pendingQuestion) this._stopPermTick()
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
   * `forceOpen` 决定新组是展开还是收起：实时来的组**默认展开** —— 用户正是要看
   * "它现在在调什么工具"，只给一行"正在执行 1 个步骤"会让人以为没有工具列表。
   * 历史回放给 false（一屏全是过程就没法读了）。
   * **两个调用点都显式传值**：顶栏那个全局开关已删，不再有"缺省继承全局意图"
   * 这条隐含约定（漏传会静默变成收起，实时组就看不出在调什么工具了）。
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
      // `forceOpen` 就是「实时 or 历史」：实时新组展开（能看见工具在跑什么），
      // 历史回放收起（一屏全是过程就没法读正文了）。两个调用点都显式传值，
      // 不再有"缺省等于全局开关"这条隐含约定 —— 那个开关已经删了。
      open: !!forceOpen,
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
    this.setData({ blocks: trimmed, turn: renumbered.turn }, function () {
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
    if (!text) return
    if (!this.data.sessionId) return
    // 轮次号交给 `_commit` 重排（它知道历史那一侧已经占了多少轮），这里只给时间
    var blocks = this._append(this.data.blocks, {
      key: 'r' + this._counter++,
      kind: 'turn',
      label: '',
      time: clockText(Date.now()),
    })
    blocks = this._append(blocks, { key: 'u' + this._counter++, kind: 'user', text: text, confirmed: false })
    // 自己发的消息必须看到
    this._autoScroll = true
    this.setData({ inputText: '', atBottom: true })
    this._commit(blocks)
    this.client.sendPrompt(this.data.sessionId, text)
  },

  onInterrupt: function () {
    if (!this.data.sessionId) return
    this.client.interrupt(this.data.sessionId)
    wx.showToast({ title: '已发送中断', icon: 'none' })
  },

  onPermissionTap: function (e) {
    var decision = e.currentTarget.dataset.decision
    var perm = this.data.pendingPermission
    if (!perm) return
    this._stopPermTick()
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
