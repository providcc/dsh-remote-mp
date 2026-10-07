'use strict'

var client = require('../../core/client.js')
var codec = require('../../core/codec.js')
var env = require('../../core/env.js')
var theme = require('../../core/theme.js')

/**
 * 工作区别名：目录的最后一段（`/Users/linbin/dsh-remote-control` → `dsh-remote-control`）。
 *
 * 为什么要有它：会话按工作区排序之后，“属于哪间屋子”是**分组依据**，
 * 而完整路径太长、一行放不下还容易把标题挤掉。chip 里放短名，
 * 完整路径弱化在第二行当补充（2026-10-04 用户要的"工作区 tag + 目录弱化"）。
 * 空目录返回 ''——调用方据此不渲染这个 chip（会话没挂目录时第二行退化成 id）。
 */
function workspaceTagOf(path) {
  var raw = String(path || '').replace(/\/+$/, '')
  if (!raw) return ''
  var parts = raw.split('/')
  var last = ''
  for (var i = 0; i < parts.length; i++) {
    if (parts[i]) last = parts[i]
  }
  return last.slice(0, 24)
}

/**
 * 会话排序（2026-10-04 用户拍板的四级）：**工作区 → 状态（运行中在前）→
 * 最后活动时间（新的在前）→ 名称**。
 *
 * 第三级取的是 `ev.session_changed[].updatedAt`。⚠️ 2026-10-06 之前它取的是会话的
 * **创建时刻**（主机侧一直发 `headerTime = header.createdAt`），于是"三天前建、今天刚用过"
 * 的会话会排到自己分组的最下面；主机侧那一轮已改成记真实最后活动时刻，字段形状不变。
 *
 * 工作区打头是因为人在用的时候心里想的是"那个项目的会话"，
 * 先按状态排会把同一个项目的会话打散到屏幕两端；空目录排最后——
 * 没挂目录的会话自成一组，不该抢在正经分组前面。
 * 四级缺一个都还能撞：两个项目同名会话在同一秒更新，就按名字定序，
 * 免得每次刷新列表都在跳。
 */
function sessionRank(a, b) {
  var aw = a.workspace || ''
  var bw = b.workspace || ''
  if (aw !== bw) {
    if (!aw) return 1
    if (!bw) return -1
    var byWs = aw.localeCompare(bw)
    if (byWs !== 0) return byWs
  }
  if (a.running !== b.running) return a.running ? -1 : 1
  var at = a.sortAt || 0
  var bt = b.sortAt || 0
  if (at !== bt) return bt - at
  return (a.title || '').localeCompare(b.title || '')
}

/**
 * 会话徽标：状态不可混淆，尤其是「已归档」——
 * 主机会拒绝归档会话的每一步，必须一眼可辨（旧版漏了这个）。
 */
function badgeFor(state, running) {
  // 待审批 / 待回答用品牌色而不是警示黄：它是"该你了"，不是"出错了"。
  // 2026-10-05 用户："不要黄色，不要给用户提供焦虑"——这一代整页没有 warning。
  if (state === 'awaiting-permission') return { text: '待审批', theme: 'primary' }
  if (state === 'awaiting-answer') return { text: '待回答', theme: 'primary' }
  if (state === 'archived') return { text: '已归档', theme: 'default' }
  if (state === 'detached') return { text: '未加载', theme: 'default' }
  if (state === 'running' || running) return { text: '运行中', theme: 'primary' }
  return { text: '空闲', theme: 'default' }
}

/**
 * 连接态 → 顶栏那颗胶囊。
 *
 * 2026-10-05 用户拍板："手机离线不要黄色，不要给用户提供焦虑"。
 * 产品定位是**临时离开电脑时的手机替身**——离线不是故障，是这件东西的常态：
 * 电脑合上盖、睡一觉、地铁里，都会离线，回来自己就接上了。所以：
 *
 * - `error`（配对失败 / 会话失效）原来是**红色**danger。红色在这件产品里的语义是
 *   "你的东西坏了"，而这里要说的只是"现在没连上，点一下就能恢复"。降成中性灰，
 *   文案也从"异常"改成"离线中"——说状态，不评判状态。
 * - 全程没有 warning（黄/橙）：这一页原来只有"待审批 / 待回答"会用黄，但那两个
 *   是**有人等你点一下**，用品牌色更贴切（它是"该你了"，不是"出错了"）。
 *   留给真需要警示的场景，而这一代没有。
 */
function statusView(status) {
  switch (status) {
    case 'online':
      return { label: '在线', theme: 'success' }
    case 'connecting':
    case 'pairing':
      return { label: '连接中', theme: 'primary' }
    case 'error':
      // 当前**不可达**：client.js 的状态枚举里有 error，但没有任何
      // `_setStatus('error', …)` 调用点。留着它是"枚举的一半"——删掉的话将来真出现
      // error 时会被 default 吞成"未连接"，而那正是这里已经说好的一句错话
      // （用户离线不等于没配对过）。文案与颜色都按"不报警"的产品口径定过。
      return { label: '离线中', theme: 'default' }
    default:
      return { label: '未连接', theme: 'default' }
  }
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/**
 * 距上一帧多久（G5 显示用，前导空格由调用方拼在 host-sub 那行后面）。
 * 从不说内容，只说时间——零知识承诺下这是唯一能说的。
 */
function linkAge(ms) {
  if (!(ms >= 0)) return ''
  if (ms < 10000) return ' · 刚刚有消息'
  if (ms < 60000) return ' · ' + Math.floor(ms / 1000) + '秒前有消息'
  return ' · ' + Math.floor(ms / 60000) + '分钟前有消息'
}

/**
 * 会话摘要下发的是 ISO 字符串（DESIGN.md F7）。原来直接 `slice(11,19)` 只显示
 * 时分秒 —— 昨天和今天的 `14:32` 长得一模一样，看不出这个会话多久没动了。
 * 按「今天 / 昨天 / 今年 / 更早」分档，长度可控且一眼能判断新旧。
 */
function formatTime(iso) {
  if (!iso) return ''
  var d = new Date(iso)
  var t = d.getTime()
  if (isNaN(t)) return String(iso).slice(11, 19) // 认不出来的原样截一段，别把整页搞崩
  var now = new Date()
  var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  var sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return hm
  var yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
  var isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  if (isYesterday) return '昨天 ' + hm
  if (d.getFullYear() === now.getFullYear()) return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

Page({
  data: {
    paired: false,
    sessions: [],
    /** G1 待办优先：在等你处理的会话（点开即进那条会话），没有时整区不占地方 */
    pending: [],
    pendingCount: 0,
    status: 'idle',
    statusText: '',
    statusLabel: '未连接',
    statusTheme: 'default',
    /** G5：最近一帧什么时候到的（只说时间不说内容），拼在主机卡那行后面 */
    linkAgeText: '',
    hostLabel: '',
    /** 正在连/正在配对：主机卡上要有可见的动静，别让用户以为卡死了 */
    connecting: false,
    /**
     * 归档会话（2026-10-07）。原来它们被**直接丢掉**，只在底部留一句
     * 「已隐藏 N 个归档会话」——于是"归档"这件事在小程序上不可逆：
     * 主机那边明明有 `cmd.archive_session`，列表也真的收到了那些行。
     * 现在单独成一组、默认折叠，展开后每行都能取消归档。
     */
    archivedSessions: [],
    archivedCount: 0,
    /** 归档区的折叠状态。页面自己的界面状态，不随列表刷新重置。 */
    archivedOpen: false,
    /** 正在归档/取消归档的会话 id。空串 = 没有正在进行的那一次。 */
    archivingId: '',
    /** 正在让主机新建会话。没有这个状态，连点会真的造出好几条空会话 */
    creating: false,
    /**
     * 配对相关。原来这些在单独的 pair 页，现在内联到首页 ——
     * 「首页直接扫码」比「首页点一下再跳一页」少一次导航。
     * 只有 `manualOpen` 为真时下面那些输入控件才渲染，平时不占版面。
     */
    manualOpen: false,
    busy: false,
    scanReady: true,
    socketReady: true,
    pasteText: '',
    token: '',
    psk: '',
    hasPsk: false,
    server: '',
    diag: '',
    diagGlobal: 'wx',
    /** 主题。themeName 用来选文案（"切换到深色" vs "切换到浅色"），
        themeClass 挂在根容器上（深色时是 theme-dark，浅色时是空串）。 */
    themeName: 'light',
    themeClass: '',
  },

  onLoad: function () {
    this.client = client.getClient()
    theme.applyTo(this)
    var p = env.probe()
    this.setData({
      server: this.client.server || '',
      psk: this.client.psk || '',
      hasPsk: !!this.client.psk,
      diag: env.summary(),
      diagGlobal: p.global,
      socketReady: !!p.connectSocket,
      scanReady: !!p.scanCode,
    })
  },

  onShow: function () {
    // 系统栏要在**每次 onShow** 重设一次：setNavigationBarColor 是每页实例一次性生效的，
    // 从别的页返回时微信会用 page json / app.json 的静态配色（#ffffff）把顶栏冲掉 ——
    // 深色下就是" sessions 页头顶一条白、chat 页正常"（chat 页的 onShow 一直在重设，
    // 2026-10-04 用户实测报了这个不一致）。onLoad 只保证首屏。
    theme.applyTo(this)
    this._off = this.client.on(this._onEvent.bind(this))
    this._sync()
    if (!this.client.isPaired()) {
      this.setData({ paired: false })
      return
    }
    this.setData({ paired: true })
    this._startLinkTick()
    if (this.client.status === 'online') {
      this.refresh()
    } else if (!this.client.sock) {
      /**
       * **只在真的没有 socket 时才重连**（2026-10-07 修）。
       *
       * 原来这里是 `else { this.client.connect() }`，而 `connect()` 会先
       * `close()` 掉旧 socket 再造一个新的、**退避重置为 0** 的。
       *
       * 症状：退避被反复打回零。在 会话列表↔聊天 之间来回切时（每次切换
       * 都走一遍 onShow），只要当前不在线就重连一次 ⇒ 指数退避（1s→30s）
       * 永远顶格在 1s。这不只是"重连勤了一点"：退避存在的意义就是别在中继
       * 拒收时 hammer 它，而顶格退避恰好把它变成 hammer。
       *
       * `app.js` 的 `onShow` 早就写对了（`&& !this.drc.sock`），唯独这里没有 ——
       * 两处不一致正是它一直没被发现的原因。
       *
       * ⚠️ 判据是 `!sock` 而不是 `status === 'connecting'`：正在重连时
       **已经有** socket 了（`createSocket` 立刻赋值），所以这一支自然不走。
       * 用 status 判会在"socket 在、状态是 connecting"时**再**造一个 ——
       * 那正是原来那个 bug 的另一条路径。
       */
      this.client.connect()
    }
  },

  onHide: function () {
    this._stopLinkTick()
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  onUnload: function () {
    this._stopLinkTick()
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  onPullDownRefresh: function () {
    this.refresh()
    setTimeout(function () {
      wx.stopPullDownRefresh()
    }, 800)
  },

  _onEvent: function (evt) {
    // 每一帧载荷都摸一下链路活跃度（G5）：只记时间不记内容。
    if (evt.kind === 'payload') this._touchLink()
    if (evt.kind === 'payload' && evt.payload.t === 'ev.session_changed') {
      this._renderSessions(this.client.sessions)
    } else if (evt.kind === 'payload' && evt.payload.t === 'ev.question_request') {
      // 停在列表页时 chat 页不在（小程序一次只活一页），提问卡没有地方弹。
      // 静默吞掉 = 主机阻塞等回答而手机毫无痕迹（与 chat 页跨会话那句同因）。
      // 不弹卡（卡属于某条会话），但必须让人知道：点进对应会话即收原卡。
      wx.showToast({ title: '主机在另一条会话里提问', icon: 'none' })
    } else if (evt.kind === 'payload' && evt.payload.t === 'ev.permission_request') {
      // 审批与提问同一性质（主机阻塞等决定，180 秒超时自动拒绝），对称处理。
      wx.showToast({ title: '主机在另一条会话里等审批', icon: 'none' })
    } else if (evt.kind === 'payload' && evt.payload.t === 'ev.result' && evt.payload.ok === false) {
      /**
       * 列表页发起的命令失败时，这一句是**唯一**的出口（2026-10-07 补，§5-10）。
       *
       * `cmd.list_sessions` 是 fire-and-forget（回执有 waiter 时不往下派，没有时才走这里，
       * 见 `client.js` 的 `_onEncrypted`）。chat 页有一个 `ok:false` 分支会弹，本页**没有**，
       * 于是"列表没刷出来"与"主机拒了这次刷新"长得一模一样——而后者往往意味着
       * 主机那一代还认不出这条指令（见 `runtime.handleInvalidCommand`）。
       *
       * 只弹失败：`ok:true` 的回执是成功路径的正常噪音，弹它会把这里变成噪声源。
       */
      wx.showToast({ title: String(evt.payload.message || '主机没能完成这条指令').slice(0, 40), icon: 'none' })
    } else if (evt.kind === 'status') {
      this._renderStatus(evt.status, evt.text)
      // 配对成功：状态一变，wxml 的 `wx:if` 分支自己就切到会话列表了。
      // 原来在 pair 页要 navigateBack 回首页，现在就在首页，不需要任何跳转。
      if (evt.status === 'online') {
        if (this.data.busy && wx.vibrateShort) wx.vibrateShort({ type: 'light' })
        this.setData({ paired: true, busy: false, manualOpen: false })
        // **首页扫码当场配对成功这条路不经过 onShow 的那次 `_startLinkTick()`**：
        // onShow 跑的时候还没配对，它在上面 `!isPaired()` 那一支就 return 了，
        // 于是 tick 永不启动 —— 主机卡那行"· N 秒前有消息"从第一帧起就冻着。
        // 这里（状态真的变成 online）是这条路上唯一能起表的地方。
        this._startLinkTick()
        this.refresh()
      } else if (evt.status === 'needs-pair') {
        // 配对在服务端已经失效（主机重启过 / 会话被回收）—— 客户端丢了自己的 pairing，
        // 但页面若还留着 `paired: true`，用户看到的就是一张**永远空着、且「＋新建会话」
        // 点了只会超时的列表**，没有任何地方能重新扫码。这一支就是把界面带回扫码页。
        //
        // 为什么以前没暴露：那时恢复路径在验证之前就宣布了 online（见 client.js
        // _onHelloOk 的注释），于是这个 needs-pair 几乎永远到不了。
        this.setData({
          paired: false,
          busy: false,
          creating: false,
          sessions: [],
          /**
           * 归零**每一个**"这一页从主机读来的量"（2026-10-07 补）。
           *
           * 原来这里只清了 sessions / hiddenArchived / hiddenText，而这三个
           * 里 hiddenArchived / hiddenText 在 2026-10-07 那轮已经**不再被写**
           * （归档改成单独一组，见 _renderSessions）—— 于是这一支实际上只清了
           * sessions，而 `archivedSessions` / `archivedCount` / `pending` /
           * `pendingCount` / `archivingId` 全部留着上一台主机的数据。
           *
           * 今天看不出来，只因为 wxml 靠 `wx:if="{{paired}}"` 把它们遮住了。
           * 而那一层遮蔽是**巧合**而不是设计：模板分支一改（或者将来加一个
           * 不在 paired 块里的只读区），就是"已解配却还列着上一台主机的会话"。
           *
           * 规则：**解配 = 这一页归零**。凡是"从主机读来的量"都在这张单子里，
           * 而这张单子要能被一条判据数出来（见 e2e 的 needs-pair 归零那条）。
           */
          archivedSessions: [],
          archivedCount: 0,
          archivingId: '',
          pending: [],
          pendingCount: 0,
          // **不自动展开手动输入**（2026-10-05 用户：全部场景默认收起）。
          // 原来这里写死 manualOpen:true，于是"解配后重新连"必然顶开一整片
          // 输入控件——用户说的就是这条。
        })
        wx.showToast({ title: String(evt.text || '会话已失效，请重新扫码配对').slice(0, 40), icon: 'none' })
      }
    } else if (evt.kind === 'error') {
      // 配对失败要回到可重试的状态，否则「正在配对…」会一直停在那儿
      this.setData({ busy: false })
      var msg = String(evt.message || '')
      // 重新采集一次：失败原因常常就是环境能力，页面上那行必须是最新的
      var p = env.probe(true)
      this.setData({
        diag: env.summary(),
        diagGlobal: p.global,
        socketReady: !!p.connectSocket,
        scanReady: !!p.scanCode,
      })
      // toast 只显示有限字数；「环境缺能力」这种必须完整看到，
      // 否则用户只知道失败了，不知道下一步做什么
      if (!p.connectSocket || msg.indexOf('SOCKET_UNAVAILABLE') >= 0 || msg.length > 40) {
        wx.showModal({ title: '连接失败', content: msg, showCancel: false })
      } else {
        wx.showToast({ title: msg.slice(0, 40), icon: 'none' })
      }
    }
  },

  _sync: function () {
    this._renderStatus(this.client.status, this.client.statusText)
    this._renderSessions(this.client.sessions)
    this.setData({ hostLabel: this.client.hostLabel })
  },

  _renderStatus: function (status, text) {
    var v = statusView(status)
    var patch = {
      status: status,
      statusText: text || '',
      statusLabel: v.label,
      statusTheme: v.theme,
      connecting: status === 'connecting' || status === 'pairing',
    }
    // 离线后"几秒前" frozen 在那里就是假事实：帧已经不来了，"5 秒前有消息"会一直
    // 停在 5 秒。状态走掉就清掉它，连上后第一帧自然会重建。
    if (status !== 'online') patch.linkAgeText = ''
    this.setData(patch)
  },

  /**
   * 链路活跃度（PRODUCT.md G5：手机"连接状态"那一页要能回答"我远程还管得住吗"）。
   *
   * 只记"最近一帧什么时候到的"，**不含任何正文**——零知识承诺下这是诊断面允许说的
   * 全部。`_touchLink` 在每一帧载荷上盖戳；`_startLinkTick` 每 15 秒按戳重算一次
   * 显示（"· 5 秒前有消息"），拼在主机卡那行后面。没有帧时戳是空的，显示空；
   * 状态走掉（离线/解配）时显示清掉——frozen 的"5 秒前"等于假事实。
   * tick 在 onHide/onUnload 停掉，不许带到别的页。
   */
  _touchLink: function () {
    this._lastPayloadAt = Date.now()
    this._paintLinkAge()
  },

  _paintLinkAge: function () {
    if (this.data.status !== 'online' || !this._lastPayloadAt) {
      if (this.data.linkAgeText) this.setData({ linkAgeText: '' })
      return
    }
    var text = linkAge(Date.now() - this._lastPayloadAt)
    if (text !== this.data.linkAgeText) this.setData({ linkAgeText: text })
  },

  _startLinkTick: function () {
    this._stopLinkTick()
    var self = this
    this._linkTimer = setInterval(function () {
      self._paintLinkAge()
    }, 15000)
  },

  _stopLinkTick: function () {
    if (this._linkTimer) {
      clearInterval(this._linkTimer)
      this._linkTimer = null
    }
  },

  /**
   * 归档会话**不显示**：主机对它们的每一步都直接拒绝，列出来只会让人点了才发现没用。
   * 但也不能悄无声息地消失 —— 底部留一句「已隐藏 N 个」，否则用户会以为会话丢了。
   *
   * G1 待办优先（PRODUCT.md §5）：挂起的审批/提问是唯一值得抢首屏的东西——
   * 它阻塞着远端一条正在跑的回合。所以 `awaiting-permission` / `awaiting-answer`
   * 的会话在列表上方另起一区「等你处理」，每件一张行并带是哪条会话，点开即进
   * 那条会话的上下文（onOpen 同一套）。下面完整列表照旧，两边是同一批数据，
   * 不是两份真相。
   */
  /**
   * 渲染会话列表。
   *
   * **归档会话单独成一组**（2026-10-07）：原来这里把它们**直接丢掉**，只在底部留
   * 一句「已隐藏 N 个归档会话」——而主机那边明明有一条 `cmd.archive_session` 可用、
   * 列表也**真的收到了**那些行。丢掉它们的后果是"归档了却再也找不回来、也没法取消"：
   * 用户只能回工作台。
   *
   * 为什么是"折叠的一组"而不是"平铺在列表里"：归档会话大多数是**故意收起来的**
   * （做完了、暂时不想看见），平铺会让日常列表变长。折叠保留可逆性——
   * 一次点击就展开，展开后每行都能取消归档。
   *
   * 两个区共用同一批数据（`rows` 一次遍历分开），不是两份真相：
   * 排序口径、徽标、标题、时间全部走同一个 `toRow`。
   */
  _renderSessions: function (list) {
    var rows = []
    var all = list || []
    for (var i = 0; i < all.length; i++) {
      var s = all[i]
      var b = badgeFor(s.state, s.running)
      rows.push({
        id: s.id,
        title: s.title || s.id,
        workspace: s.workspace || '',
        badgeText: b.text,
        badgeTheme: b.theme,
        running: b.theme === 'primary',
        pending: s.state === 'awaiting-permission' || s.state === 'awaiting-answer',
        archived: s.state === 'archived',
        // sortAt 只参与排序，不进 setData（渲染层用不到，别让它两处口径）
        sortAt: new Date(s.updatedAt).getTime() || 0,
        updatedAt: formatTime(s.updatedAt),
      })
    }
    rows.sort(sessionRank)
    var items = []
    var archived = []
    var pending = []
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j]
      var row = {
        id: r.id,
        title: r.title,
        workspace: r.workspace,
        workspaceTag: workspaceTagOf(r.workspace),
        badgeText: r.badgeText,
        badgeTheme: r.badgeTheme,
        running: r.running,
        updatedAt: r.updatedAt,
      }
      if (r.archived) archived.push(row)
      else items.push(row)
      if (r.pending) pending.push({ id: r.id, title: r.title, badgeText: r.badgeText, workspace: r.workspace })
    }
    // 折叠状态是**页面自己的**界面状态，不是会话的属性：它不参与渲染层的数据口径，
    // 也不该随列表刷新被重置（刷新时用户刚展开的折叠区又合上，是最烦人的那类）。
    this.setData({
      sessions: items,
      archivedSessions: archived,
      archivedCount: archived.length,
      pending: pending,
      pendingCount: pending.length,
      // 保留这两个字段：wxml 里还有别处在读它们吗？——没有。但删掉它们会让
      // 「已隐藏 N 个」这句话**整个消失**，而那个 strip 掉的分支正是本次要修的东西，
      // 留着两个新字段比留一个孤零零的计数好判断。
      hiddenArchived: 0,
      hiddenText: '',
    })
  },

  refresh: function () {
    this.client.listSessions()
  },

  onOpen: function (e) {
    var id = e.currentTarget.dataset.id
    var title = e.currentTarget.dataset.title || id
    // 记下"最后点开的那条会话的工作区"——新建会话的默认值取自这里（见 onNewSession）。
    // 为什么记在**点开**而不是"最近更新"：那是会话自己的属性，而用户点开列表
    // 常常只是看一眼就走；真正表达"我接下来要在哪个项目里干活"的是点开哪一条。
    // 只取会话摘要里那个 `workspace` 原样透传，不做任何换算（两侧不可能对不上）。
    var ws = e.currentTarget.dataset.workspace
    this._lastWorkspace = ws || this._lastWorkspace || ''
    wx.navigateTo({
      url: '/pages/chat/chat?id=' + encodeURIComponent(id) + '&title=' + encodeURIComponent(title),
    })
  },

  /**
   * 新建会话该用哪个工作区（长按那条路显式给了的话不算）。
   *
   * 三级取值，与主机侧 `carrier-services.newSession` 的那三级同构：
   * ① 最后点开的那条会话的工作区（`onOpen` 记的）；
   * ② 列表里第一个非空分组 —— 列表已按工作区分组并把空目录排最后，所以第一个非空的就是
   *    "屏幕上方那些会话所在的那个项目"；
   * ③ 都没有 = 返回空串，调用点据此**不带** `workspace` 字段，行为与接线之前完全一致。
   *
   * ⚠️ ② 有个分不出��情况：用户只有一个项目时它必然等于 ①，那没问题；
   * 而"用户有多个项目但从没点开过任何一条"时，② 只是屏幕顺序上的猜测 —— 这时候
   * **猜错与不猜的代价相同**（都落到主机推断的目录），所以不值得为它多问一句。
   * 想确定的用户有长按那条路。
   */
  _currentWorkspace: function () {
    if (this._lastWorkspace) return this._lastWorkspace
    var all = this.data.sessions || []
    for (var i = 0; i < all.length; i++) {
      if (all[i].workspace) return all[i].workspace
    }
    return ''
  },

  /**
   * 扫主机的二维码。**首页直接扫** —— 不再跳到另一个页面。
   *
   * 主路径只有这一条：二维码里带了密钥 + 配对码，扫完即连，用户不用再手输。
   * 容器没有 scanCode（比如某些模拟器）时给一句人话并把手动输入展开，
   * 而不是让用户点了必然报错的按钮。
   */
  onScan: function () {
    if (!env.probe().scanCode) {
      // 不自动展开（2026-10-05 用户：默认收起）。说清去哪儿点，让用户自己展开。
      wx.showModal({
        title: '当前环境无法扫码',
        content: '这个运行环境没有扫码能力。请点下面的「手动输入」，把主机显示的「二维码内容」粘进去。',
        showCancel: false,
      })
      return
    }
    var self = this
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: function (res) {
        var text = res.result || ''
        var parsed = codec.parsePairingQr(text)
        if (!parsed) {
          // 「不是 DSH 的二维码」与「是 DSH 的二维码、但里面某一项不合法」要分开说：
          // 前者要换一张，后者要让主机重新生成。用同一句"无法识别"会把用户支错方向。
          var why = codec.pairingQrError(text)
          wx.showModal({
            title: why ? '二维码里的信息不合法' : '无法识别',
            content: why || '这不是 DSH 远程控制的配对二维码。二维码应以 dshr:/p? 开头。',
            showCancel: false,
          })
          return
        }
        self._applyParsed(parsed)
      },
      fail: function () {
        /* user cancelled */
      },
    })
  },

  /** 手动输入区（粘贴 / 6 位码 / 高级设置）的开关。 */
  onToggleManual: function () {
    this.setData({ manualOpen: !this.data.manualOpen })
  },

  /**
   * 粘贴框只记值，不立刻解析。
   * 原生 input 的 bindinput 是「每次敲键都触发」，在上面直接解析会
   * 把半截内容当失败、反复弹提示；读取动作留给失焦/回车。
   */
  onPasteInput: function (e) {
    this.setData({ pasteText: String((e.detail && e.detail.value) || '') })
  },

  /** 原生 input 没有 TDesign 的 change 事件，用 blur + confirm 兜住 */
  onPasteCommit: function () {
    this.onPaste({ detail: { value: this.data.pasteText } })
  },

  onPasteClear: function () {
    this.setData({ pasteText: '' })
  },

  /**
   * 读剪贴板。主机打印的是整段 `dshr:/p?…`，手敲不现实、长按输入框再选粘贴也绕，
   * 点一下直接取。能力缺失时给一句人话，别让它抛 TypeError。
   */
  onPasteClipboard: function () {
    var api = typeof wx !== 'undefined' ? wx : null
    if (!api || typeof api.getClipboardData !== 'function') {
      wx.showToast({ title: '当前环境不支持读取剪贴板，请长按输入框粘贴', icon: 'none' })
      return
    }
    var self = this
    api.getClipboardData({
      success: function (res) {
        var text = String((res && res.data) || '').trim()
        if (!text) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' })
          return
        }
        self.setData({ pasteText: text })
        self.onPaste({ detail: { value: text } })
      },
      fail: function () {
        wx.showToast({ title: '读取剪贴板失败，请长按输入框粘贴', icon: 'none' })
      },
    })
  },

  /**
   * 粘贴主机打印的整段 `dshr:/p?…`。
   * 模拟器没有摄像头：扫码不可能，也不该有人手敲 24 字符的 base64 PSK。
   */
  onPaste: function (e) {
    var text = String((e.detail && e.detail.value) || '').trim()
    if (!text) return
    var parsed = codec.parsePairingQr(text)
    if (!parsed) {
      // 是 DSH 的二维码但某一项不合法（地址不是 ws(s) / 密钥不是 base64）：
      // 说清是哪一项，别让用户以为"再粘一次就好了"。
      var why = codec.pairingQrError(text)
      if (why) {
        wx.showToast({ title: why.slice(0, 40), icon: 'none' })
        return
      }
      // 也接受直接粘 6 位配对码 —— 人们就是这么试的
      var digits = text.replace(/\D/g, '')
      if (/^\d{6}$/.test(digits)) {
        this.setData({ token: digits, pasteText: '' })
        wx.showToast({ title: '已填入配对码', icon: 'none' })
      }
      return
    }
    this.setData({ pasteText: text })
    this._applyParsed(parsed)
  },

  /**
   * 二维码里已经有密钥了，**能不能连只差配对码**。
   * 带了配对码就直接连；没带就把输入区展开、聚焦到配对码上，
   * 而不是让用户在一堆控件里自己找"还差什么"。
   */
  _applyParsed: function (parsed) {
    this.client.hostLabel = parsed.hostLabel || ''
    var next = {
      server: parsed.server,
      psk: parsed.psk,
      hasPsk: true,
      hostLabel: parsed.hostLabel || '',
    }
    if (parsed.token) next.token = parsed.token
    this.setData(next)
    if (parsed.token) {
      this.setData({ busy: true })
      this.client.connect({ server: parsed.server, psk: parsed.psk, token: parsed.token })
      return
    }
    // 不自动展开（2026-10-05 用户：默认收起）；说清去哪儿输入。
    wx.showToast({ title: '已读取密钥，请点「手动输入」填配对码', icon: 'none' })
  },

  onTokenInput: function (e) {
    // 只留数字，最多 6 位
    var v = String((e.detail && e.detail.value) || '').replace(/\D/g, '').slice(0, 6)
    this.setData({ token: v })
  },

  // ── 配对 ──────────────────────────────────────────────────────────
  onPair: function () {
    var server = String(this.data.server || '').trim()
    var token = String(this.data.token || '').trim()
    var psk = String(this.data.psk || '').trim()

    if (!/^wss?:\/\//.test(server)) {
      wx.showToast({ title: '服务地址需以 ws:// 或 wss:// 开头', icon: 'none' })
      return
    }
    if (!psk) {
      wx.showToast({ title: '缺少配对密钥，请先扫码', icon: 'none' })
      return
    }
    if (!/^\d{6}$/.test(token)) {
      wx.showToast({ title: '请输入主机显示的 6 位配对码', icon: 'none' })
      return
    }
    this.client.hostLabel = this.data.hostLabel
    this.setData({ busy: true })
    this.client.connect({ server: server, psk: psk, token: token })
  },

  /** 把环境自检整行复制走 —— 出问题时这一行就能定位原因。 */
  onCopyDiag: function () {
    wx.setClipboardData({
      data: this.data.diag || env.summary(),
      success: function () {
        wx.showToast({ title: '已复制环境自检', icon: 'none' })
      },
    })
  },

  /** 解除配对。确认框里说清后果：之后要重新扫码。 */
  onUnpair: function () {
    var self = this
    wx.showModal({
      title: '解除配对',
      content: '解除后需要重新扫码配对。确定继续？',
      success: function (r) {
        if (r.confirm) {
          self.client.unpair()
          self.setData({
            paired: false,
            token: '',
            psk: '',
            hasPsk: false,
            hostLabel: '',
            pasteText: '',
            server: self.client.server || '',
          })
        }
      },
    })
  },

  /**
   * 切换浅色 / 深色。
   *
   * 存不下的时候**必须说一句**：界面已经变了，但下次启动会跳回浅色。不提示的话，
   * 用户会以为设置没生效、或者以为自己记错了。安静地失败是这个功能最坏的形态。
   */
  onToggleTheme: function () {
    var r = theme.toggle(this)
    if (!r.saved) {
      wx.showToast({ title: '已切换，但没存住，下次启动会变回浅色', icon: 'none', duration: 2500 })
    }
  },

  /**
   * 让主机新建一条会话。
   *
   * 三条纪律：
   * 1. **不许静默**：每一种失败都要有可读原因（没配对 / 还没连上 / 主机那一代没有这个能力 /
   *    创建失败 / 超时）。"点了什么都没发生"是这一页最难查的那种坏。
   * 2. **按钮进入"正在新建"**：创建要往主机跑一个来回，没有可见动静就会被连点，
   *    而连点会真的造出好几条空会话（主机侧没有去重）。
   * 3. **成功就直接进去**：新建就是为了马上发第一条指令，停在列表上再点一次是多余的。
   *    跳过去之后 chat 页会照常去读历史 —— 空会话读到空内容，是正常的。
   */
  /**
   * 展开 / 收起归档区。
   *
   * 单独一个方法而不是在 wxml 里写 `!archivedOpen` 取反：那种写法在
   * `setData` 的异步视图更新里会连点两次落到同一个值上（两次都读到 false）。
   */
  onToggleArchived: function () {
    this.setData({ archivedOpen: !this.data.archivedOpen })
  },

  /**
   * 归档一条会话（长按列表里那一行）。
   *
   * **长按而不是加一颗按钮**：一行里已经有色条、标题、徽标、项目名、时间，
   * 再加一颗"归档"就把"读这一行"变成了"在五样东西里找那颗按钮"。
   * 长按是零版面成本的动作，而这一行的主作用（点开）仍然是单击。
   *
   * 确认走 `wx.showActionSheet` 而不是 `showModal`：归档**可逆**（能取消回来），
   * 不需要"确定/取消"那种郑重的二选一；ActionSheet 一行就是那个动作本身。
   */
  onSessionLongPress: function (e) {
    var self = this
    var id = e.currentTarget.dataset.id
    var title = e.currentTarget.dataset.title || id
    if (!id || this.data.archivingId) return
    if (this.data.status !== 'online') {
      wx.showToast({ title: '还没连上主机，稍后再试', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: ['归档「' + String(title).slice(0, 12) + '」'],
      success: function () {
        self._doArchive(id, true)
      },
    })
  },

  /** 取消归档（归档区里那一行的长按）。与归档同一个出口，方向相反。 */
  onArchivedLongPress: function (e) {
    var self = this
    var id = e.currentTarget.dataset.id
    var title = e.currentTarget.dataset.title || id
    if (!id || this.data.archivingId) return
    if (this.data.status !== 'online') {
      wx.showToast({ title: '还没连上主机，稍后再试', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: ['取消归档「' + String(title).slice(0, 12) + '」'],
      success: function () {
        self._doArchive(id, false)
      },
    })
  },

  /**
   * 点归档区里的一行 → **取消归档**（而不是打开它）。
   *
   * 为什么点开不是"进会话"：主机对归档会话的每一步都直接拒绝
   * （`ensureRunnable` 会先恢复它，但手机这边发指令的路径是 chat 页，
   * 那里没有任何"这条已归档"的提示）——用户会进去、输一段话、发出去、
   * 然后拿到一句"主机没有回应"。所以归档行**不给"打开"这条路**。
   *
   * 取消归档是可逆动作里最容易判断的一个（用户点它就是想拿回来），所以
   * 单击直接做，长按那条 ActionSheet 入口保留给"我想确认一下"的人。
   */
  onArchivedTap: function (e) {
    var id = e.currentTarget.dataset.id
    if (!id || this.data.archivingId) return
    this._doArchive(id, false)
  },

  /**
   * 真去归档 / 取消归档。
   *
   * `archivingId` 是**进行中那一条的 id** 而不是布尔：连点两行时，
   * 第二次能被"已经有一次在跑"挡掉，而用户仍看得见是哪一行在忙。
   * 判据不能用 `busy`（那是配对用的）或 `creating`（那是新建会话用的）——
   * 共用它们会让归档的进度显示到别的按钮上。
   */
  _doArchive: function (id, archived) {
    var self = this
    this.setData({ archivingId: id })
    var done = function (res) {
      self.setData({ archivingId: '' })
      if (!res || !res.ok) {
        // 主机给的原因**原样**给用户：这一条的命令空间大
        //（「这一代主机不支持」与「会话正在运行，不能归档」）必须分别说出来。
        wx.showToast({ title: String((res && res.message) || '归档失败').slice(0, 40), icon: 'none' })
        return
      }
      // 成功**主动刷新**一次，不等主机补推的那一帧：用户点完就该看到列表变了。
      // 主机侧那条补推是兜底（应对别处改的会话），这里这条是"我点的，我确认"。
      self.refresh()
    }
    this.client.archiveSession(id, archived).then(done, function (e) {
      done({ ok: false, message: (e && e.message) || '归档失败' })
    })
  },

  /**
   * 新建会话。`picked` 是**工作区路径**（长按那条路传进来的），不是事件对象。
   *
   * ⚠️ 2026-10-07 修一个真实的缺陷：wxml 上是 `bindtap="onNewSession"`，
   * 而 bindtap 会把**事件对象**当第一个实参传进来 —— 于是 `picked` 恒为真值，
   * 下面那句 `picked || this._currentWorkspace()` 的三级兜底
   * （① 最后点开的那条会话的工作区 ② 列表里第一个非空分组 ③ 不带这个字段）
   * **永远走不到**，每次单击都往主机发一个名为 `[object Object]` 的工作区。
   *
   * 症状特别难查：`String({})` 是 `'[object Object]'`，它不是空串所以
   * `if (workspace) cmd.workspace = ...` 会照发；主机侧 `badWorkspace()` 收到
   * 一个不存在的目录，会话落错地方或被拒，而**回执路径上没有任何提示**
   * （`newSession` 只看 `res.ok`，而这条路径返回 ok:true 或一句读不懂的话）。
   * 唯一能工作的是长按那条路——它传的是真字符串。
   *
   * 修法是**判类型**而不是改 wxml（改 wxml 要多一个入口，而 `wx.navigateTo`
   * 那套已经够用）：只在它真的是字符串时才当成"用户显式指定的工作区"。
   */
  onNewSession: function (picked) {
    var self = this
    if (this.data.creating) return
    if (!this.client.isPaired()) {
      wx.showToast({ title: '还没有配对主机', icon: 'none' })
      return
    }
    if (this.data.status !== 'online') {
      wx.showToast({ title: '还没连上主机，稍后再试', icon: 'none' })
      return
    }
    // 没显式指定就用「当前分组」（长按那条路会把选中的工作区传进来）。
    //
    // 默认值的来历：最后点开的那条会话的工作区，没有就退到列表里第一个非空分组，
    // 都没有就**不带这个字段**（由主机推断，行为与接线之前完全一致）。
    // 为什么要有默认：用户点「＋新建会话」时心里通常有一个项目，而 DSH 的会话列表
    // 按目录分组 —— 落错分组的话，用户在电脑上翻不到这条新会话，而**手机这边
    // 全程没有任何提示**（回执照样 ok:true）。
    // `typeof picked === 'string'` 而不是 `!!picked`：bindtap 传进来的是事件对象，
    // 它恒为真值。任何"看它是不是空"的写法都拦不住——必须看**类型**。
    var workspace = (typeof picked === 'string' ? picked : '') || this._currentWorkspace()
    this.setData({ creating: true })
    var done = function (res) {
      self.setData({ creating: false })
      if (!res || !res.ok || !res.sessionId) {
        wx.showToast({ title: String((res && res.message) || '新建会话失败').slice(0, 40), icon: 'none' })
        return
      }
      // 新会话此刻还没有名字（主机要等第一条指令之后才起标题）。这里给它一个**诚实的**
      // 占位而不是编一个假标题：列表那一侧没标题时显示 id，是同一个规矩。
      self.refresh()
      wx.navigateTo({
        url: '/pages/chat/chat?id=' + encodeURIComponent(res.sessionId) + '&title=' + encodeURIComponent('新会话'),
      })
    }
    this.client
      .newSession(workspace)
      .then(done)
      .catch(function (e) {
        done({ ok: false, message: (e && e.message) || '新建会话失败' })
      })
  },

  /**
   * 长按「＋新建会话」→ 从**已见过的分组**里选一个（HANDOFF §0.10.4 第 4 步）。
   *
   * 为什么不只靠默认：默认值取"最近点开的那条会话的工作区"，而人点开列表
   * 常常只是看一眼就走 —— 于是默认会落到一个与意图无关的目录里，而**界面完全没有
   * 反馈**（回执照样 `ok:true`，会话建在别处，用户在电脑上找不到）。
   * 给一个明确的入口，是让"我要建在某个项目里"这件事可表达。
   *
   * 为什么是**长按**而不是单击：单击已经用于"用默认分组新建"，而这是这一代
   * 唯一一个能改默认的动作（用户原话："弹窗让自己选"）。长按不额外占版面，
   * 也不会让单击多一次点击。
   *
   * 列表只给**这一页见过的非空工作区**（会话摘要里的 `workspace`，原样透传，
   * 不做任何换算，所以两侧不可能对不上）。没有可选项时不弹任何东西 ——
   * 弹一个空列表比不弹更像坏了。
   */
  onNewSessionLongPress: function () {
    var seen = {}
    var order = []
    var all = this.data.sessions || []
    for (var i = 0; i < all.length; i++) {
      var w = all[i].workspace
      if (w && !seen[w]) {
        seen[w] = true
        order.push(w)
      }
    }
    if (!order.length) {
      // 一个都没见过 = 没有可选项。与其弹空列表，不如明说"为什么没有"。
      wx.showToast({ title: '还没有会话用过工作区', icon: 'none' })
      return
    }
    var labels = order.map(function (w) {
      var parts = w.split('/')
      var last = ''
      for (var k = parts.length - 1; k >= 0; k--) {
        if (parts[k]) {
          last = parts[k]
          break
        }
      }
      return last || w
    })
    var self = this
    wx.showActionSheet({
      itemList: labels,
      success: function (r) {
        var picked = order[r.tapIndex]
        if (picked) self.onNewSession(picked)
      },
    })
  },
})
