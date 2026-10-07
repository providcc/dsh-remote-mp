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
    /** 被过滤掉的归档会话数；>0 时列表底部补一句说明 */
    hiddenArchived: 0,
    hiddenText: '',
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
    } else {
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
          hiddenArchived: 0,
          hiddenText: '',
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
  _renderSessions: function (list) {
    var rows = []
    var hidden = 0
    var all = list || []
    for (var i = 0; i < all.length; i++) {
      var s = all[i]
      if (s.state === 'archived') {
        hidden++
        continue
      }
      var b = badgeFor(s.state, s.running)
      rows.push({
        id: s.id,
        title: s.title || s.id,
        workspace: s.workspace || '',
        badgeText: b.text,
        badgeTheme: b.theme,
        running: b.theme === 'primary',
        pending: s.state === 'awaiting-permission' || s.state === 'awaiting-answer',
        // sortAt 只参与排序，不进 setData（渲染层用不到，别让它两处口径）
        sortAt: new Date(s.updatedAt).getTime() || 0,
        updatedAt: formatTime(s.updatedAt),
      })
    }
    rows.sort(sessionRank)
    var items = []
    var pending = []
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j]
      items.push({
        id: r.id,
        title: r.title,
        workspace: r.workspace,
        workspaceTag: workspaceTagOf(r.workspace),
        badgeText: r.badgeText,
        badgeTheme: r.badgeTheme,
        running: r.running,
        updatedAt: r.updatedAt,
      })
      if (r.pending) pending.push({ id: r.id, title: r.title, badgeText: r.badgeText })
    }
    this.setData({
      sessions: items,
      pending: pending,
      pendingCount: pending.length,
      hiddenArchived: hidden,
      hiddenText: hidden ? '已隐藏 ' + hidden + ' 个归档会话' : '',
    })
  },

  refresh: function () {
    this.client.listSessions()
  },

  onOpen: function (e) {
    var id = e.currentTarget.dataset.id
    var title = e.currentTarget.dataset.title || id
    wx.navigateTo({
      url: '/pages/chat/chat?id=' + encodeURIComponent(id) + '&title=' + encodeURIComponent(title),
    })
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
  onNewSession: function () {
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
      .newSession()
      .then(done)
      .catch(function (e) {
        done({ ok: false, message: (e && e.message) || '新建会话失败' })
      })
  },
})
