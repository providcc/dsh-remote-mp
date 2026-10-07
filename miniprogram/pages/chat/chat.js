'use strict'

var client = require('../../core/client.js')
var ScrollPolicy = require('../../core/scroll-policy.js').ScrollPolicy
var theme = require('../../core/theme.js')
var markdown = require('../../core/markdown.js')
var env = require('../../core/env.js')
var activityLib = require('../../core/activity.js')

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

/**
 * 一条出站 `cmd.send_prompt` 的**线上字节**估算与它要面对的预算。
 *
 * 2026-10-06 审计补的：附件那两道闸（`MAX_ATTACH_*`）只算**附件**，于是
 * "512KB 附件 + 一段很长的正文"这个组合是没人管的。实测（`e2e` 侧同式复算）：
 * 附件 512KB + 正文 90KB → 线上帧 1 055 304 字节 > 中继的 `ws.maxPayload` 1 MiB
 * ⇒ 中继以 **1009** 关掉**整条连接**。用户看到的是"发出去就掉线"，而这一页的注释
 * 里写着"绝不能让它变成莫名掉线"——闸在那里，只是不在这条路上。
 *
 * 算式与线格式一一对应（改动必须同时改这几处与 `core/codec.js` 的 `seal`）：
 *   载荷 JSON ≈ 固定开销 + jsonEscapedBytes(text) + Σ(名字/类型 + base64(附件原始字节))
 *   密封 = base64(载荷JSON ‖ nonce(24B) ‖ MAC(16B))  →  ×4/3
 *   线上帧 = 密封结果 + 信封（t / sessionId / seq / clientId 与引号）
 *
 * **宁高勿低**：估大了只是提前拦下一条本来也发不出去的帧；估小了就是 1009 断链。
 * 所以每处都加了余量，而不是精确算。
 *
 * ⚠️ **正文那一项不是"数原始字符"**（2026-10-07 审计）：载荷要先过 `JSON.stringify`，
 * 而它对 `"` `\` 与控制字符每个都翻倍。漏掉这层，正文里全是引号或全是换行时闸会**放行**
 * 一条真实帧达 1.3 倍于中继上限的帧 ⇒ 1009 关掉整条连接 ⇒「发出去就掉线」，
 * 且清空输入框那句 `setData` 已在拦截之前跑过、正文丢了。实测与判据见 `jsonEscapedBytes`。
 */
var WIRE_FRAME_BUDGET = 1024 * 1024 // 中继 DRC_MAX_MSG_BYTES 的默认值（协议层 MAX_RELAY_MESSAGE_BYTES）
var WIRE_FRAME_HEADROOM = 8 * 1024 // 与协议层留的信封余量同值：宁可少发，不可断链

/** base64 之后的长度（向上取整到 4 的倍数）。 */
function base64Len(byteLen) {
  return Math.ceil(byteLen / 3) * 4
}

/**
 * 一段文本经 `JSON.stringify` 之后的**字节数**（2026-10-07 审计新增的一层）。
 *
 * ## 为什么必须多算这一层
 *
 * 载荷不是把正文拼上去就发出去的：它先过 `JSON.stringify`（`core/codec.js` 的 `seal`），
 * 而 stringify 对 `"` `\` 与控制字符（换行、回车、制表…）**每个都要翻倍**：
 * 一个 `"` 变成 `\"` 是 2 字节，一个 `\n` 变成 `\` + `n` 也是 2 字节。
 *
 * 原先的估算只数了原始 UTF-8 字节，对这层膨胀**零感知**，而那一页的注释写着
 * 「**宁高勿低**：估大了只是提前拦下一条本来也发不出去的帧；估小了就是 1009 断链」——
 * 它恰好是低估那一侧。实测（对真 `codec.seal` 复算）：
 *
 *   正文 400KB 全是 `"`  → 估算 546KB（闸放行）｜真实帧 1092KB > 中继 1MB ⇒ **1009 断链**
 *   正文 500KB 全是换行  → 估算 683KB（闸放行）｜真实帧 1366KB > 中继 1MB ⇒ **1009 断链**
 *
 * 用户看到的是「发出去就掉线」：闸放行 → 中继以 1009 关掉**整条连接**；
 * 而清空输入框的那句 `setData` 已经在拦截之前跑过，正文也丢了。
 *
 * ⚠️ **为什么既有判据没抓到**：`e2e/mp-chat-blocks.test.mjs` 的两条正文用例都是
 * `'x'.repeat(120*1024)` —— 纯 ascii 转义后**不变长**，于是这类膨胀在它们身上**测不出来**。
 * 判断一份正文会不会膨胀，看的是**它有没有大量引号/反斜杠/换行**，不是它有多长。
 *
 * 做法：先数「必须被转义的字符」有多少个，每个多算 1 字节。
 * 刻意不做「真的 stringify 一次」——那会让每帧都为一条长消息分配一个同样大的字符串，
 * 而流式期每 100ms 一帧。宁可多算一点（见下面的系数）。
 *
 * @param {string} text
 * @returns {number} 转义后的 UTF-8 字节数
 */
function jsonEscapedBytes(text) {
  var s = String(text || '')
  var escaped = 0
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    //  `"`  \  与 C0 控制字符（含换行/回车/制表）—— JSON.stringify 对它们加一个反斜杠。
    //  代理对（emoji）占两个 char 码元但 UTF-8 仍是 4 字节，不在这里处理。
    if (c === 0x22 || c === 0x5c || c < 0x20) escaped++
  }
  var raw = 0
  try {
    raw = unescape(encodeURIComponent(s)).length
  } catch (e) {
    raw = s.length * 3 // 兜底按最坏（中文 3 字节）估
  }
  return raw + escaped
}

/**
 * 一条出站帧的线上字节估算（见 WIRE_FRAME_BUDGET 的注释）。
 *
 * 算式与线格式一一对应（改动必须同时改这几行与 `core/codec.js` 的 `seal`）：
 *   载荷 JSON ≈ 固定开销 + jsonEscapedBytes(text) + Σ(名字/类型 + base64(附件原始字节))
 *   密封 = base64(载荷JSON ‖ nonce(24B) ‖ MAC(16B))  →  ×4/3
 *   线上帧 = 密封结果 + 信封（t / sessionId / seq / clientId 与引号）
 *
 * ⚠️ 附件那几项**不再乘转义系数**：base64 字母表是 `A-Za-z0-9+/=`，
 * `JSON.stringify` 对这些字符一个都不转义，所以它们的膨胀恰好为零 ——
 * 这一点与正文**相反**，把两边混成同一个系数就会算错（附件是这页的大头）。
 *
 * **宁高勿低**：估大了只是提前拦下一条本来也发不出去的帧；估小了就是 1009 断链。
 * 所以每处都加了余量，而不是精确算。
 */
function estimateWireFrameBytes(text, attachments) {
  var payload = 160 // 帧名 / cmdId / sessionId / 引号 / 转义余量
  payload += jsonEscapedBytes(text)
  for (var i = 0; i < attachments.length; i++) {
    var a = attachments[i]
    payload += 64 // name + mediaType + 键名与引号
    // ⚠️ 这里**不能**写 `payload += String(len)`：`+=` 见到字符串就变成拼接，
    // 于是 `821447` + `"16800"` 变成字符串 `"82144716800"`，后面再 `Math.ceil(x/3)`
    // 得到的估算值会大到离谱 → 一条普通消息也被这条闸拦下（第一版就踩了，
    // 判据「纯文字正文必须照发」当场抓住）。数字就当数字加。
    payload += (a.data || '').length // a.data 本来就是 base64，长度即长度
  }
  return base64Len(payload + 40) + 160
}
/** 主机给带附件的用户消息补的那段说明的开头（`shell/uploads.ts` 的 appendFileNote）。 */
var FILE_NOTE_HEAD = '[文件附件 '

var MAX_TEXT_PER_BLOCK = 20000
/**
 * **正文总量上限（字符）** —— 块数上限不封顶字节，这条才是 setData 的护栏。
 *
 * 为什么必须有：markdown 的 nodes 是原文的 13.7 倍（实测 20000 字符 → 274KB JSON），
 * 而 `MAX_BLOCKS=400` 只封顶块数 —— 400 块正文能到好几 MB。小程序的 setData
 * **单次上限 1MB，超了是静默丢弃**（更新不生效、正文从此不再刷新，最难查的那种坏）。
 * 30000 字符按同一比例约 410KB，加块流本身仍在半程以内。
 * 超了从**旧到新**截断：最新那段永远完整，旧的那几段换成一句明说被省略的提示
 * （`TEXT_TRIM_NOTICE`）——用户知道那里本来有内容，而不是以为模型没写过。
 */
var MAX_TOTAL_TEXT_CHARS = 30000
var TEXT_TRIM_NOTICE = '…（这段较早的正文已省略：手机上只保留最近 ' + MAX_TOTAL_TEXT_CHARS + ' 字）'
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
 * 文件的类型标签。
 *
 * `wx.chooseMessageFile` 给的 `type` 是**类别**（`'video' | 'image' | 'file'`），
 * 不是扩展名——官方类型定义 `ChooseFile` 上写得很清楚。所以扩展名只能从**文件名**上取：
 *  `report.pdf` → `pdf`，`notes.txt` → `txt`。
 *
 * `fallback` 只在文件名里确实没有扩展名时才用（`README` → `file` 而不是 `undefined`，
 * 因为协议那边 `mediaType` 是可选的，而界面上一个空的类型标签比一个含糊的更难看）。
 * 这里刻意**不猜**：`type:'image'` 配一个 `.pdf` 的名字时，宁可标成 `pdf`（名字说了算，
 * 主机那边也是按名字保扩展名的），也不要标成 `image`。
 */
function extensionOf(name, fallback) {
  var base = String(name || '')
  var dot = base.lastIndexOf('.')
  if (dot > 0 && dot < base.length - 1) return capLabel(base.slice(dot + 1).toLowerCase())
  return capLabel(fallback || 'file')
}

/**
 * 类型标签的长度上界（2026-10-07 补，§5-9）。
 *
 * `extensionOf` 的返回值就是协议里的 `fileAttachment.mediaType`，而 schema 是
 * `z.string().max(64)` —— 一个 65 字符的扩展名（`a.<65 个字符>`）在主机那边会
 * `parseCmdPayload` **整条拒掉**：主机只记一行日志，手机那边则干等满 12 秒的
 * `COMMAND_TIMEOUT_MS` 才得到一句「主机没有回应」（同一个修的另一半在
 * `dsh-remote-control` 的 `runtime.handleInvalidCommand`，现在会回一条明说原因的执）。
 *
 * 夹在这里是"两端都能过"的最后一道：名字是手机本地的、我们自己就能收口，
 * 不必等主机那一版跟上来。64 是协议的上界，不是这里拍的数。
 */
function capLabel(label) {
  var s = String(label || '')
  return s.length > 64 ? s.slice(0, 64) : s
}

/**
 * 连接态 → 顶栏那颗圆点的语义色。
 *
 * 2026-10-05 用户拍板："手机离线不要黄色，不要给用户提供焦虑"。
 * 产品定位是**临时离开电脑时的手机替身**：离线不是故障而是这件东西的常态
 * （合盖、睡觉、地铁），所以 error 也**不用红色**——红在这里说的是"你的东西坏了"，
 * 而实际要传达的只是"现在没连上"。中性灰 + 一句人话就够。
 * 全页没有 warning：真需要用户动手的状态（待审批/待回答）用品牌色。
 *
 * `error` 这一支当前**不可达**（client.js 的状态枚举里有它，但没有任何
 * `_setStatus('error', …)` 调用点）。留着是为了"枚举的一半"：删掉的话，
 * 将来真出现 error 时会掉进 default 支，而那与它现在的语义恰好相同（中性灰）——
 * 也就是说留着零成本，删掉也不会更对；写在这里免得下一个人以为漏了一档。
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
     * 瞬时提示（顶栏下一行，`ev.retry` / `ev.compaction` 落在这里）。
     *
     * 为什么是"一行字"而不是进块流：重试与压缩都是**进行中状态**，
     * 不是会话内容 —— 进块流会永久留在历史里，而"正在重试 2/5"这种话
     * 半小时后再看毫无意义。run-state 回到 idle 时清掉（见 _onRunState）。
     * `failed` 与 `ended` 是两件事（见 _onCompaction），绝不合并。
     */
    notice: '',
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
     * 而且**块上那份 `_md` 不进 setData**（`_commit` 会剥掉）：同一份 nodes 存两处
     * 时，一条 20000 字符的正文就是两块各 274KB —— 单次 setData 的硬上限是 1MB，
     * 超了静默丢弃（正文不再刷新）。nodes 缓存在页面实例的 `_mdNodes` 上，
     * 这个 map 是交给渲染层的那一份。
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
    /**
     * 用户回传（role:'user'）的**累积缓冲**：主机把一条长消息切成多帧，
     * 而本地回显是整条 —— 半截去比永远对不上（见 `_applyDelta`）。
     */
    this._userEcho = {}
    /**
     * markdown nodes 的缓存（块 key → nodes）。`_commit` 交给渲染层的 blocks
     * **不带 `_md`**（同一份 nodes 存两处 = 一条长回复撑到两倍，见 `_commit`），
     * 所以缓存必须落在页面实例上，否则下一次提交（收卡、运行态、工具事件）
     * 会因为块上已经没有 `_md` 而把正文的 nodes 全丢掉。
     */
    this._mdNodes = {}
    this._deltaTimer = null
    this._thinkTimer = null
    /**
     * 滚动状态与判据的**唯一**持有者（见 `core/scroll-policy.js` 的文件头）。
     *
     * 原来这里摊着 9 个字段，而判据内联在 `onScroll` 里、跨 6 个方法被写——
     * 想判断"此刻跟不跟"得横着扫整页。现在只有 `this.scroll` 一个对象，
     * 页面只负责把它的返回值画到 `data.atBottom` / `data.toView` 上。
     */
    this.scroll = new ScrollPolicy(function () { return Date.now() })
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
    /**
     * 视口高度的**唯一**来源，就在这里量一次。
     *
     * 为什么只能在这里：wx 的 scroll 事件 detail 只有 `scrollTop` / `scrollLeft` /
     * `scrollHeight` / `scrollWidth`（官方类型定义 `ScrollOffsetCallbackResult`），
     * **没有视口高度**——贴底判断需要的那个数，滚动帧里根本不存在。
     * 所以"每帧刷新高度"那种写法是**死的**：读一个真机永远不会给的字段。
     * （重构时一度就是这么写的，现在只留这一处。）
     *
     * 面板弹出会改变布局，那一刻的高度按原样忽略——它不影响"离底部多远"这个判断。
     *
     * ⚠️ 量到之后必须**交给 policy**：贴底判据住在那里。页面自己不留一份，
     * 免得出现"两处各存一个高度、其中一处没人更新"（重构时踩过：policy 永远拿到 0，
     * 于是每帧都走"高度未知"那条早退，「往上回看停跟随」整条判据失效）。
     */
    wx.createSelectorQuery()
      .select('.scroll')
      .boundingClientRect(function (r) {
        if (r && r.height) self.scroll.setViewportHeight(r.height)
      })
      .exec()
  },

  onShow: function () {
    this._off = this.client.on(this._onEvent.bind(this))
    this._retheme()
    this._renderBar()
    // 卡片倒数是 setTimeout 链，onHide 停掉之后**必须在这里重启**：
    // 不重启的话，从后台回来那张卡还挂着，而"还剩 N 秒"冻在离开时的数字上
    // （主机那边照常在走，用户按着一个看着还有 2 分钟的按钮其实早就作废了）。
    if (this.data.pendingPermission || this.data.pendingQuestion) this._startCardTick()
    // 思考秒表**同样必须重启**（2026-10-07 审计）。上面那条卡片倒数有判据守着，
    // 思考秒表漏了 —— 而它比卡片那两处更要紧：「思考中 12.0s」是用户唯一能看到
    // "模型还活着"的信号，它一冻，用户看到的就是"页面卡死了"。
    //
    // 为什么不能指望别处把它叫醒：`_startThinkTick` 的其它三个入口
    // （`_onRunState` / `_ensureThinkOpen` / `_onSessions`）都要**先收到一帧新的内核事件**
    // 才会被调用，而切后台期间那些帧早就过去了；`onShow` 里唯一会发的那次
    // `_maybeLoadHistory()` 又因为 `_historyStarted` 已置真而直接 return。
    if (this.data.running) this._startThinkTick()
    this.client.listSessions()
    this._maybeLoadHistory()
    // 挂起的审批/提问是「以 dsh 为准」：进会话主动拉一次，别等主机恰好有变化。
    // 断链期间错过的那一帧，靠这一拉补回来（同一 requestId，页面按卡覆盖）。
    this.client.getPending(this.data.sessionId)
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
    this._clearDeltaTimer()
    this._flushDelta()
    this._stopThinkTick()
    this._stopCardTick()
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  onUnload: function () {
    // 与 onHide 同一套收尾：**退页之后 delta 定时器还会醒**，那一刻页面已经销毁，
    // setData 落到一个不存在的页面上（不报错、不生效，纯泄漏）。
    // onHide 清了而 onUnload 没清，走"从会话列表返回"这条路时就会漏。
    this._clearDeltaTimer()
    this._stopThinkTick()
    this._stopCardTick()
    if (this._off) {
      this._off()
      this._off = null
    }
  },

  /** 撤掉待刷的 delta 定时器（onHide / onUnload 共用） */
  _clearDeltaTimer: function () {
    if (this._deltaTimer) {
      clearTimeout(this._deltaTimer)
      this._deltaTimer = null
    }
  },

  // ── 滚动：自动跟随 vs 用户回看 ────────────────────────────────────
  //
  // 判据全在 `core/scroll-policy.js` 里（纯函数、可单测）；这一段只负责
  // "把它的结论画到 data 上"。原来这些判据内联在 onScroll 里、跨六个方法被写，
  // 想回答"此刻跟不跟"得横着扫整页——见 scroll-policy.js 的文件头。
  onScroll: function (e) {
    var r = this.scroll.onScroll(e.detail || {})
    // 只在**跟随状态变了**的那一帧 setData：这一帧每滑动一次就来一次，
    // 而 setData 是这一页最贵的操作（同值提交也会触发渲染层 diff）。
    if (r.atBottom !== this.data.atBottom) this.setData({ atBottom: r.atBottom })
  },

  onScrollToLower: function () {
    this.scroll.onScrollToLower()
    if (!this.data.atBottom) this.setData({ atBottom: true })
  },

  onJumpLatest: function () {
    this.scroll.onJumpLatest()
    this.setData({ atBottom: true })
    this._scrollToBottom()
  },

  /**
   * scroll-into-view 只在**值变化**时才生效，所以用一个 id 在 a/b 之间翻转的
   * 尾部锚点：既保证每次刷新都真的滚到底，又不依赖"最后一个气泡会长高"这种假设。
   *
   * 锚点的翻转由 policy 持有（`_flip`），页面只把它写进 `data.toView`。
   */
  _scrollToBottom: function () {
    this.setData({ toView: this.scroll.scrollToBottom() })
  },

  /**
   * 折叠之后把外层滚动位置重新对一次。
   *
   * 为什么需要：折叠会让内容高度**剧烈**变化 —— 长会话里点一次收起某个组
   * 能少两千多像素（实测 4532 → 1876）。开发者工具每次都会把 scrollTop 收进
   * 新的合法范围，但真机（尤其 iOS）不是每次都重新量：视口停在旧的高度上，
   * 下面就是一段**滚不到任何内容**的空白 —— 用户看到的就是
   * 「过程内容不见了，但是所占的位置还在」。
   *
   * **只在贴底时做**（policy 的 afterFold 自己判）：正在往回翻历史的用户不该被
   * 这一下甩到底；贴在底部时"重新对到底部"本来就是他期望的位置，没有副作用。
   */
  _afterFold: function () {
    var anchor = this.scroll.afterFold()
    if (anchor) this.setData({ toView: anchor })
  },

  // ── 键盘：点空白收起 ──────────────────────────────────────────────
  /**
   * 小程序里 input 拿到焦点后，点页面上别的地方**不会**自动收键盘，
   * 键盘会一直盖住半屏。原来那个 `hold-keyboard="{{true}}"` 更是明确要求
   * 「点页面不收起键盘」——正是要反过来的东西。
   * 现在：外层容器接 tap（子级 tap 会冒泡上来），输入区/面板用 catchtap 挡住不误收。
   */
  onTapBlank: function () {
    this._dismissKeyboard()
  },

  /**
   * 收起键盘（外层 tap 与消息区那条 catchtap 共用）。
   *
   * 消息区的 `catchtap="onCollapseTodos"` 会**截断冒泡**，所以外层那句 bindtap
   * 在消息区永远收不到 —— 而消息区正是最常点的那片空白。它必须自己把这一半接上。
   */
  _dismissKeyboard: function () {
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
      if (evt.status === 'online') {
        /**
         * 挂起的审批/提问：**每一次**连上都补拉一次，不挂在 `_wasOffline` 那个条件下。
         *
         * 为什么（用户 2026-10-07 实测）：`client.sendCmd()` 只检查 `isPaired()` 与
         * `this.sock` 存不存在，**不检查 socket 是否真的开着**——所以离线时 `getPending`
         * 不报错也不抛，只是那一条指令被 `sock.send()` 静默丢掉（返回 false，
         * 而调用点是 fire-and-forget）。而 `_wasOffline` 只由**页面挂上之后**收到的
         * 'connecting' / 'idle' 事件置真，于是"我打开会话时手机本来就是离线的"这件事
         * 页面看不见：随后连上、status 变成 'online'，`_wasOffline` 仍是 false，
         * 整段补拉被跳过 —— 那张卡**永远不出现**，用户只能"当时人在会话里"才看得到。
         *
         * 幂等：主机侧 `cmd.get_pending` 没有挂起时只回 `ev.result{ok:true}`，
         * 不重发任何帧（`runtime.ts` 的那段），所以多拉一次没有任何副作用。
         *
         * 这一条同时锁住审批与提问——它们在主机是同一份 `pending`、同一个命令、同一段补拉。
         */
        this.client.getPending(this.data.sessionId)
      }
      if (evt.status === 'online' && this._wasOffline) {
        this._wasOffline = false
        this._historyStarted = false
        this._historyBusy = false
        // 断链期间世界可能变了：run_state 的跳变帧错过就没了，挂着的瞬时提示
        // （正在重试/压缩中）可能早已过期。清掉它，真相由随后的列表与历史重建——
        // 还在跑的话新的提示帧会再来，不会丢。
        if (this.data.notice) this.setData({ notice: '' })
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
        // **复位之后必须自己再触发一次**（2026-10-06 取证）。
        //
        // 开头那次 `_maybeLoadHistory()` 在这一刻还看到 `_historyStarted === true`，
        // 直接 return 了——而它全页只有两个调用点（onShow 与这里），不重新触发
        // 就**永远不会再读历史**。2026-10-05 那次"修复"只复位、不触发，整段是
        // 彻底的空操作：断链期间主机上跑完的步骤、工具、回复一条都补不回来，
        // 于是页面活着、顶栏亮着，**消息流从此静止**。
        //
        // 此刻三个前置条件全满足：status 已是 'online'、_historyStarted 刚复位、
        // _historyBusy 刚复位。
        this._maybeLoadHistory()
        // **重连后直接到底部**（2026-06 用户拍板：重连与重新进入都到底部，
        // 不记住"读到哪儿"）。
        //
        // 原来的行为是重读历史时 `firstPage=false` → `noScroll` → 停在原处。
        // 那对"继续读刚才那段"是对的，但断链期间主机上很可能已经跑完了一整轮，
        // 停在旧位置等于让用户以为没收到新东西——而这一页的约定就是"最新在最底"。
        //
        // 必须**先把跟随状态翻回来**：`_commit` 里那次 `shouldFollowNewContent` 是总闸，
        // 用户正在回看时它是关着的，只置 pending 标记根本不会滚。
        this.scroll.onReconnect()
        this.setData({ atBottom: true })
        // 断了多久不知道，但主机那边的会话状态一定变了 —— 顶栏那个
        // 「运行中」要重新问一次，否则它会一直停在上一次的值上。
        this.client.listSessions()
        // 挂起卡**不在这里拉**：上面那个"每次连上都补拉一次"已经覆盖了——
        // 同一条指令拉两遍没有第二个收益，只是让人以为这里另有一道保障。
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
    // 提问是**唯一一种"不回就等于出事"的帧**（2026-10-06 取证）。
    //
    // 现场：10:16:12 主机问了个真问题（2 道题），10:21:30 被桌面答掉。
    // 期间手机端整段时间什么都没有——不是"闪一下被撤卡"，是没出现过。
    // 而提问卡的结构是「一次性、单会话、只在 chat 页、永不重放」，所以用户在
    // 别的会话时，上面那句会话过滤会把它**无声吞掉**。
    //
    // 静默是最坏的处理：主机那边正阻塞着等回答（问答超时要 300s），
    // 手机上却毫无痕迹，用户只会以为"它没问我"。所以这里给一句提示——
    // 不弹卡（那张卡属于别的会话），但**必须让人知道有这件事**。
    //
    // 位置必须在下面那句通用会话过滤**之前**：那条会直接 return，
    // 放到它后面就永远走不到。
    if (p.t === 'ev.question_request' && p.sessionId && p.sessionId !== this.data.sessionId) {
      wx.showToast({ title: '主机在另一条会话里提问', icon: 'none' })
      return
    }
    // 审批与提问同一性质："不回就等于出事"的帧（主机阻塞等决定，180 秒超时自动拒绝）。
    // 提问那句上面有了，这里补审批的对称处理 —— 不弹卡（那张卡属于别的会话），
    // 但必须让人知道有这件事。原来审批跨会话是**彻底静默**（连提问那句 toast 都没有），
    // 主机白等 180 秒而手机毫无痕迹（PRODUCT.md G2）。
    if (p.t === 'ev.permission_request' && p.sessionId && p.sessionId !== this.data.sessionId) {
      wx.showToast({ title: '主机在另一条会话里等审批', icon: 'none' })
      return
    }
    if (p.sessionId && p.sessionId !== this.data.sessionId) return // 不是本会话

    // 老主机的 ev.model 不带 sessionId（那时它就是全局的）：只在**本会话确实还没
    // 拿到过模型**时用它兜底，绝不让别的会话的帧覆盖已有的正确值。
    if (p.t === 'ev.model') {
      if (p.sessionId || !this.data.modelName) this._onModel(p)
      return
    }

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
    // 重试与压缩的瞬时提示（主机 2.0.11 已发，见 _onRetry / _onCompaction）。
    // 与其它事件走同一句会话过滤（上面的通用过滤）：别的会话在重试不关这一页的事。
    if (p.t === 'ev.retry') return this._onRetry(p)
    if (p.t === 'ev.compaction') return this._onCompaction(p)
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
      // 列表是"这条会话此刻在不在跑"的权威来源：run_state 是跳变帧，错过就没了
      // （退后台时那一帧过去，回来后"正在重试"会永远挂着——2026-10-06 用户实测）。
      // 列表说没跑而提示还在，提示就是过期遮罩，清掉它。
      if (!running && this.data.notice) this.setData({ notice: '' })
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

  /**
   * 点消息区：收回待办面板（展开态是临时的，不该常驻）。
   *
   * 这个处理器挂在 scroll-view 的 **catchtap** 上（待办条要能点开，而 scroll-view
   * 里还有可点的步骤组，不能用 bindtap 让它们互相冒泡），冒泡因此到此为止 ——
   * 外层 `.chat-wrap` 那句「点空白收键盘」在消息区永远收不到。而消息区恰恰是
   * 用户最常点的那片"空白"：点正文想收键盘，结果什么都没发生。
   * 所以这里把收键盘那一并接上，而不是把 catchtap 去掉（去掉会让点步骤组也收键盘，
   * 还会把面板的收起动作变成冒泡的副作用，两处管一件事）。
   */
  onCollapseTodos: function () {
    if (this.data.todosOpen) this.setData({ todosOpen: false })
    this._dismissKeyboard()
  },

  /**
   * 又开始产出内容了 → 清掉瞬时提示（重试 / 压缩）。
   *
   * **刻意不在任何定时器里做**：提示的消失必须由"事情真的过去了"驱动，
   * 而不是"过了一会儿"。用计时器清，用户会在答案还在滚的时候看到提示先没，
   * 那是另一种形式的谎。
   *
   * 空闲时不碰：那一轮本来就没在跑，提示留给 `_onRunState` 回 idle 时清。
   */
  _clearNoticeIfProducing: function () {
    if (!this.data.notice || !this.data.running) return
    this.setData({ notice: '' })
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
    //
    // ⚠️ **这个锚点只对「往前翻更早」那一路有意义**（2026-10-07 审计）。
    // 它原来是无条件写进 `toView` 的，于是重连后重读第一页时把视口滚到了**块流最开头**：
    // 那一页的约定是"重连直接到底部"，而 `atBottom` 又被重连那一支手动置 true
    // 藏掉了「回到最新」那颗钮 —— 用户被留在几千行之前，界面上还没有任何回到底部的入口。
    // `scroll.onReconnect()` 只置标记、不产生滚动动作，白调。
    //
    // 判据用 `!first`：第一页 = "最新一页"，它的落点由 policy 决定（重连 ⇒ 到底部，
    // 普通首次读入 ⇒ `shouldFollowNewContent`）；更早页才需要"把刚才那块滚回视口"。
    var anchor = !first && this.data.blocks.length ? 'b' + this.data.blocks[0].key : ''
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
        // **第一页不能无条件拼在最前面**：屏幕上可能已经有实时内容，而这一页里
        // 有些条目与屏幕重叠（按 id 跳过、不占位）。直接 concat 会把"历史里还没渲染过
        // 的那几条"放到**比它们旧**的屏幕内容之前（实测：屏幕上已有 m1/c2，
        // 历史页是 c1/m1/c2/m3 时顺序会变成 c1/m3/m1/c2）。
        // `_replayAnchors` 给出每一条新块在页内紧随其后的那个"屏幕上也有的"块，
        // 据此插到它前面；更早页（first=false）仍按老规矩整页拼在前面。
        var merged
        if (first && self.data.blocks.length) {
          merged = self._mergeByAnchors(replayed, self._replayAnchors || [], self.data.blocks)
        } else {
          merged = replayed.concat(self.data.blocks)
        }
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
        // 重连后强制回底部：`_commit` 的 noScroll 是"翻更早一页时别把用户甩下去"，
        // 断链重读不属于那一类——它要的是"最新在最底"。
        // 读完即消费（policy 里做）：标记不清，下一页也会被当成重连拖到底——
        // 而那时用户正在读更早的历史。
        var forceBottom = self.scroll.consumePendingBottom(first)
        self._commit(merged, { noScroll: !firstPage && !forceBottom })
        // 待办快照：只应用**第一页**（最新一页）——更早页的快照是过期的，
        // 应用它等于把用户看到的清单往回拨。实时帧已经到过（_todoLive）就
        // 一律不应用：后到者胜，历史不许盖实时。
        if (first && self._replayTodos && !self._todoLive) {
          self._setTodos(self._replayTodos)
        }
      })
      .catch(function (e) {
        // `.then` 里抛错（页形状不对、页面自己的 bug）也必须把状态复位：
        // 不 catch 的话 `historyState` 永远停在 'loading'，界面永远是
        // "正在读取主机上的历史…"，用户只能退出重进；而且 `_historyBusy` 也再也
        // 回不到 false，之后每次重连都被它挡在门外。
        self._historyBusy = false
        if (first) {
          self._historyStarted = false
          self.setData({ historyState: 'error' })
        } else {
          self.setData({ historyLoadingMore: false })
        }
        wx.showToast({ title: '主机上的历史没读到', icon: 'none' })
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
   *
   * 去重是"跳过"而不是"占位"，所以返回的**新块顺序**要靠 `_replayAnchors` 与屏幕上
   * 现有的块对齐（见 `_mergeByAnchors`）：每一个新块记下它在页内紧随其后的那个
   * "屏幕上也有的"块的 key，合并时插到它前面。
   */
  _replayPage: function (items) {
    var existing = this.data.blocks
    // 这一页里的最后一份待办快照（全量语义：后面的覆盖前面的）。没有就是 undefined——
    // 调用方据此区分"这页没有待办"与"这页有一条空清单"。
    this._replayTodos = undefined
    // 与 out 平行：out[i] 的锚点（屏幕上那个"它应该排在前面"的块的 key）。
    // null = 页里它后面没有已渲染过的块（比屏幕上所有东西都新，落在最后）。
    var anchors = []
    /** 已生成、还没等到锚点的 out 下标（等到下一个"屏幕上也有的"块就一起结算）。 */
    var pending = []

    /**
     * 下面这几张表**只是"屏幕上已经有的东西"的快照，回放过程中绝不往里登记自己**。
     *
     * 第一版是边回放边登记的，于是同一页里同一次工具调用的「参数」「收尾」两条
     * 被当成重复，第二条（带结果的那条）被丢掉 —— 历史里的工具行永远停在
     * 「正在执行」且结果预览是空的。而一页里同一个 `callId` 出现两次本来就是**正常**的：
     * 主机侧是一条内核事件折成一条线格式条目（`historyPageFromLog`）。
     * 同一条消息的多个 delta 也是同理。去重只该针对"实时已经渲染过、历史里又来一遍"。
     * 现在它们同时承担第二件事：记下**对应屏幕块的 key**，用来对齐顺序。
     */
    var onScreenText = {}
    var onScreenTool = {}
    /**
     * 本地回显的用户块按**文本**记块 key 队列：同文本可能有好几条（多重集消耗）。
     *
     * ⚠️ 值存 `{text, key}` 而不是光一个 key（2026-10-07 审计）：判重不能只比相等，
     * 得走 `_echoMatches` —— 主机给带附件的消息补了一段说明（`uploads.ts` 的
     * `appendFileNote`），所以历史里的正文与用户输入的原文**本来就不相等**。
     * 光存 key 就只能逐字比对，于是每一条带附件的消息在历史回放里都会**再画一遍**：
     * 屏幕上两条一模一样的用户气泡，各带一个「第 N 轮」分隔。
     * （实时路径早就为此写了 `_echoMatches`，历史路径没跟上——两处形状不一致，
     * 症状又与 message/inbox 双发长得几乎一样，极难归因。）
     */
    var localEcho = {}
    for (var i = 0; i < existing.length; i++) {
      var b = existing[i]
      if (b.msgId) onScreenText[b.msgId] = b.key
      if (b.kind === 'user') {
        // 空正文（只发附件的消息）也要登记：那种消息的本地回显 text 是空串，
        // 而历史那条是「附件说明」本身，不登记就必然匹配不上 → 一样两遍。
        var ut = String(b.text || '').trim()
        if (!localEcho[ut]) localEcho[ut] = []
        localEcho[ut].push({ text: ut, key: b.key })
      }
      if (b.kind !== 'steps') continue
      for (var j = 0; j < b.items.length; j++) onScreenTool[b.items[j].callId] = b.key
    }

    var localIndex = {}
    var out = []
    /** 每次 out 变长之后补登记锚点槽位（apply* 只会往后追加） */
    var track = function () {
      while (anchors.length < out.length) {
        anchors.push(null)
        pending.push(anchors.length - 1)
      }
    }
    /** 遇到一个"屏幕上也有的"块：在它之前生成的那些新块都排在它前面 */
    var settle = function (key) {
      for (var p = 0; p < pending.length; p++) anchors[pending[p]] = key
      pending = []
    }
    for (var k = 0; k < items.length; k++) {
      var it = items[k]
      // 待办不进块流（它是"此刻的清单"，不是一条消息）：记下最后一份，
      // 由 _loadHistory 在**第一页**落地时应用（更早页的是过期快照）。
      if (it.t === 'ev.todo') {
        if (Array.isArray(it.todos)) this._replayTodos = it.todos
        continue
      }
      if (it.t === 'ev.tool_event') {
        if (it.callId && onScreenTool[it.callId]) {
          settle(onScreenTool[it.callId])
          continue
        }
        out = this._applyTool(out, it, false)
        track()
        continue
      }
      if (it.t !== 'ev.message_delta') continue
      if (it.role === 'user') {
        // 本地已经立刻回显过的那句，历史里又来一遍。**按多重集消耗**而不是简单判相等：
        // 「继续」这种话整个会话里会出现很多次，判相等会把更早那一页里重复的那句也一起吞掉。
        //
        // 匹配用 `_echoMatches` 而不是 `===`（2026-10-07 审计）：那条规则专门为
        // "回显正文与回传正文本来就不相等"这一族写的 —— 主机给带附件的消息补了一段
        // 附件说明，而那正是实时路径（`_onUserEcho`）已经在用的判据。这里逐字相等就漏。
        var echo = String(it.delta || '').trim()
        var hit = null
        // ⚠️ 必须扫**全部**桶，不能只查 `localEcho[echo]`：带附件的那条历史正文
        // 与本地回显的原文不相等，按字面去查表必然查不到（那正是本条要修的缺陷）。
        // 桶少（本地回显的条数），扫一遍的代价可以忽略。
        for (var bucket in localEcho) {
          if (!Object.prototype.hasOwnProperty.call(localEcho, bucket)) continue
          var slot = localEcho[bucket]
          for (var q = 0; q < slot.length; q++) {
            if (this._echoMatches(slot[q].text, echo)) {
              hit = slot.splice(q, 1)[0]
              break
            }
          }
          if (hit) {
            if (!slot.length) delete localEcho[bucket]
            break
          }
        }
        if (hit) {
          settle(hit.key)
          continue
        }
        out = this._append(out, { key: 'r' + this._counter++, kind: 'turn', label: '', time: '' })
        track()
        out = this._append(out, {
          key: 'u' + this._counter++,
          kind: 'user',
          text: it.delta || '',
          confirmed: true,
        })
        track()
        continue
      }
      if (it.messageId && onScreenText[it.messageId]) {
        settle(onScreenText[it.messageId])
        continue
      }
      out = this._applyText(out, localIndex, it.messageId, it.delta || '', true)
      track()
    }
    this._replayAnchors = anchors
    return out
  },

  /**
   * 把一页历史生成的新块按锚点插进屏幕上现有的块流（见 `_replayPage`）。
   *
   * 三个分支：
   *   · 一个锚点都没有 —— 这一页与屏幕上的内容没有交集，维持老行为（整页拼在最前面）。
   *     往前翻的那条路（`_loadHistory(cursor)`）不经过这里，它按定义就是"更早"。
   *   · 有锚点 —— 按锚点把新块插到它前面，屏幕上的块保持原顺序。
   *   · 尾部没有锚点的新块 —— 页里它们后面没有已渲染过的块，就是更新的内容，落在最后。
   */
  _mergeByAnchors: function (replayed, anchors, existing) {
    var any = false
    for (var a = 0; a < anchors.length; a++) {
      if (anchors[a]) {
        any = true
        break
      }
    }
    if (!any) return replayed.concat(existing)
    var out = []
    var i = 0
    for (var e = 0; e < existing.length; e++) {
      var key = existing[e].key
      while (i < replayed.length && anchors[i] === key) out.push(replayed[i++])
      out.push(existing[e])
    }
    while (i < replayed.length) out.push(replayed[i++])
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
    // **重试一旦成功，那句提示就必须消失**（2026-06 用户复访报的第 2 条）。
    //
    // 原先只在 `_onRunState` 回到 idle 时清。但重试成功往往发生在**这一轮还没结束**
    // 的时候：模型重试成功 → 继续这一轮 → 开始出字。那条「正在重试 2/5」就一直挂着，
    // 用户看着答案一行行出来，头上却写着"正在重试"。
    //
    // 判据用"**又producing了**"而不是时间：任何新的正文/工具产出都说明那个瞬时状态
    // 已经过去。这条对压缩同样成立——压缩结束后正文开始流，提示就该收。
    this._clearNoticeIfProducing()
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
      // **攒到 done 再匹配**。回传会被切帧（一条长消息按 DELTA_FLUSH_CHARS=4096
      // 分几次交出去），而本地回显是**整条** —— 拿半截去比永远对不上，
      // 于是同一条消息在屏幕上变成两三条半截的用户块（真机上 >4096 字符必现）。
      // 主机侧一条 user delta 无论切几片，最后一片一定带 done（`window.ts` 的
      // 合帧器在收尾帧上补 done），所以攒到 done 是可靠的。
      if (!this._userEcho) this._userEcho = {}
      var acc = (this._userEcho[messageId] || '') + (text || '')
      if (!done) {
        this._userEcho[messageId] = acc
        return
      }
      delete this._userEcho[messageId]
      // **同一条消息主机会回传两次**（2026-10-06 真机取证）：
      // `agent/inbox/spliced`（排队时）与 `user/message`（落定时）各一条，
      // 两条带的是**同一个内核 messageId**（session log seq4155/seq4179 同为 f71ae5a5…）。
      //
      // 第一次 `_onUserEcho` 把本地回显标成 confirmed，第二次就找不到"未确认的那条"了
      // ——而它兜底的动作是**再画一个一样的气泡**（`chat.js:1322`），
      // 于是用户 2026-10-06 截图里第 3 轮出现两条一模一样的用户消息。
      // 主机侧排队的消息（用户在 DSH 桌面里敲的）同样中招：本地没有回显，
      // 两次都走"追加"分支。
      //
      // 所以去重键是 **messageId**，不是文本：同一条消息只结算一次。
      if (!this._echoSettled) this._echoSettled = {}
      if (this._echoSettled[messageId]) return
      this._echoSettled[messageId] = true
      // 这个表会随会话变长，只保留最近的一批：超出就清空重来。
      // 代价是极老的消息再回传一次可能又画一遍 —— 那比一条常驻的消息表划算得多。
      this._echoSettledCount = (this._echoSettledCount || 0) + 1
      if (this._echoSettledCount > 300) {
        this._echoSettled = {}
        this._echoSettledCount = 0
      }
      if (acc) this._onUserEcho(acc)
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
    if (!this._mdNodes) this._mdNodes = {}
    // 正文还是空的时候不要建任何 md 字段：wxml 判 map 里没有这一块时会走
    // 「流式纯文本」那一支，而空文本那一支本来就不该渲染出东西。
    if (!b.text) {
      b._md = null
      b.mdPending = ''
      delete this._mdNodes[b.key]
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
      // **同时按块 key 缓存一份**：交给渲染层的 blocks 会被剥掉 `_md`
      // （同一份 nodes 不进两次 setData），下一次提交要靠这份缓存把 nodes 找回来。
      this._mdNodes[b.key] = r.nodes
    } catch (e) {
      // 渲染层崩了不能连累正文：退回纯文本那一支（wxml 拿不到 nodes 时就走它）
      b._md = null
      b.mdPending = b.text
      delete this._mdNodes[b.key]
    }
    return b
  },

  /**
   * 宿主机回传的用户消息，与本地那条回显**是不是同一条**。
   *
   * 原来这里是逐字相等（`===`），而那条判据在**带附件的消息上必然失效**：
   * 主机把附件落盘后会在正文后面补一段说明（`uploads.ts` 的 `appendFileNote`）：
   *
   *     你发出去的正文
   *
   *     [文件附件 2 个，已存到本机]
   *     1. /Users/…/a.pdf（application/pdf）
   *
   * 手机上的本地回显只有上面那两行，于是回传与回显**对不上** → 匹配失败 →
   * 落到"追加新块"那条兜底 → **屏幕上多出一条一模一样的用户气泡**。
   * （用户 2026-10-07 实测；它长得跟 §0.10 的 message/inbox 双发一模一样，
   * 但根因不是双发，是**回显正文与回传正文本来就不相等**。）
   *
   * 只放行一种"多出来的部分"：那段附件说明。别放宽成前缀相等——
   * 「ok」与「okay」会被错认成同一条，而确认错一条的代价是把一条消息永远留在
   * "未确认"上。空正文（只发附件）也要能配上：这时回传正文就是那段说明本身。
   */
  _echoMatches: function (localText, incomingText) {
    var a = String(localText || '').trim()
    var b = String(incomingText || '').trim()
    if (!b) return false
    if (a === b) return true
    // 唯一放行的"不一样"：宿主在正文后面补的那段附件说明。
    // ⚠️ 这**一道**就是全部的闸——不需要（也不该）再加一条"b 必须以 a 开头"：
    // 那样只是把同一件事说两遍，而两遍里总有一遍会先被人放宽。
    // 空正文（只发附件）走同一条：a 为空，切出来的就是 b 本身，正好是那段说明。
    return b.slice(a.length).replace(/^\s+/, '').indexOf(FILE_NOTE_HEAD) === 0
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
      if (!this._echoMatches(b.text, want)) break // 最近的一条对不上，那就是另一条消息
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
    // 工具又跑起来了 = 重试/压缩那个瞬时状态已经过去（见 _queueDelta 里的同一段）。
    this._clearNoticeIfProducing()
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

    // 工具名保持原样存（`tool` 是调试与断言的锚点），显示用中文类别：
    // 宿主那行显示的中文（"正在读取文件"）就是按 core/activity.js 的映射算的，
    // 这里跟它保持一致；原英文名退到副标题位（无标题时），信息不丢。
    var toolName = p.tool || (prev && prev.tool) || 'tool'
    var titleText = p.title || (prev && prev.title) || ''
    var item = {
      key: prev ? prev.key : 't' + this._counter++,
      type: 'tool',
      callId: p.callId,
      phase: p.phase,
      tool: toolName,
      cat: activityLib.activityLabel(toolName),
      title: titleText || toolName,
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

  // ── 重试 / 压缩的瞬时提示 ──────────────────────────────────────────
  /**
   * 模型正在重试（`ev.retry` ← 内核 `llm/retry`）。
   *
   * 现场：模型卡住 → 用户以为死了 → 手动去中断，而宿主其实正在重试。
   * 文案与其它事件同一条会话过滤之后才到这里（分发处），
   * 所以这里只管拼人话：`正在重试 2/5 · TRANSPORT`。
   * 清除时机：run-state 回到 idle（见 _onRunState），或被下一条提示覆盖。
   */
  _onRetry: function (p) {
    var attempt = typeof p.attempt === 'number' && p.attempt > 0 ? p.attempt : 1
    var max = typeof p.max === 'number' && p.max > 0 ? p.max : attempt
    var text = '正在重试 ' + attempt + '/' + max
    if (p.reason) text += ' · ' + String(p.reason).slice(0, 40)
    this.setData({ notice: text })
  },

  /**
   * 上下文压缩的起止（`ev.compaction` ← 内核 `compaction/start|end`）。
   *
   * `failed` 与 `ended` **绝不合并**：前者是"压缩没成"（真机见过
   * `summarization produced no text summary content`），上下文已经烂掉；
   * 合并成一个 ended 会让用户在出事的情况下以为一切正常。
   * `ended` 当场清掉（压缩结束了，没什么好说的）；`failed` 留下原因，
   * 等 run-state 回到 idle 时再清（见 _onRunState）。
   */
  _onCompaction: function (p) {
    if (p.state === 'started') this.setData({ notice: '正在压缩上下文' })
    else if (p.state === 'failed')
      this.setData({ notice: '压缩没成功：' + String(p.error || '未知原因').slice(0, 60) })
    else this.setData({ notice: '' })
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
   *
   * ── 为什么 running **不**粗清卡片 ───────────────────────────────────
   * 主机在"桌面先答掉一张卡"之后会 `voidStaleCard` → 广播 `runState(state:'running')`，
   * 而这一帧里**只有那一张**被作废。旧写法拿它当粗收单，把两张卡一起清掉 ——
   * 还挂着的那张（例如一个正在等回答的提问）在手机上直接消失，而主机继续阻塞，
   * 直到 300 秒超时按"没答上"处理。用户完全不知道自己错过了一次提问。
   * 所以 running 里"哪张没了"只认**精确帧** `ev.permission_resolved` /
   * `ev.question_resolved`；只有回到 idle（这一轮结束了，挂着的卡都过期）才粗清。
   */
  _onRunState: function (p) {
    var running = p.state === 'running'
    var blocks = this.data.blocks
    if (!running) blocks = this._closeThink(blocks)
    var patch = { running: running }
    if (!running) {
      if (this.data.pendingPermission || this.data.pendingQuestion) this._stopCardTick()
      patch.pendingPermission = null
      patch.pendingQuestion = null
      // 瞬时提示（重试/压缩）只在"这一轮"里有意义：回到 idle 说明这一轮结束了，
      // 留着"正在重试 2/5"会让用户以为下一轮还没开始。压缩失败那句也在这里清 ——
      // 它在失败那一刻已经说过那句话，idle 时再挂着就是在说一件过去的事。
      if (this.data.notice) patch.notice = ''
      // 待办是"**这一轮**在干什么"的清单：一轮结束了还挂着，用户看到的是一件
      // 已经做完的事（2026-06 用户复访报的第 1 条：待办全做完、dsh 都关闭了，
      // mp 端还在显示）。内核**不保证**在收尾时再发一帧空清单，所以不能只靠它。
      if (this.data.todos.length) {
        patch.todos = []
        patch.todoDone = 0
        patch.todoRunning = 0
        patch.todoRunningText = ''
        patch.todosOpen = false
      }
      // 清掉待办也要放开这条闩锁：否则这一页实例之后的历史回放会拿旧快照盖回来。
      this._todoLive = false
    }
    this.setData(patch)
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
  /**
   * 块数封顶。上一轮那条省略提示也在块流里，**它不参与计数** ——
   * 不先剔掉的话 `dropped` 每次都会把提示自己算进去：长度恒为 MAX_BLOCKS+1，
   * 而提示里的数字**永远停在 2**（"每帧都报已省略 2 个片段"），
   * 用户看不出到底省了多少，也没法判断后面还有多少内容被丢了。
   */
  _trim: function (blocks) {
    var kept = blocks
    var prevNote = null
    var prevDropped = 0
    var first = blocks[0]
    if (first && first.kind === 'note' && first.trimKey === 'trim') {
      prevNote = first
      kept = blocks.slice(1)
      prevDropped = Number(first.dropped) || 0
    }
    if (kept.length <= MAX_BLOCKS) {
      // 剔掉提示之后没超：提示要留着（否则它会一闪一没），没有提示就原样返回。
      return prevNote ? [prevNote].concat(kept) : kept
    }
    var dropped = prevDropped + (kept.length - MAX_BLOCKS)
    var out = kept.slice(kept.length - MAX_BLOCKS)
    out.unshift({
      key: 'trim',
      kind: 'note',
      trimKey: 'trim',
      dropped: dropped,
      text: '…已省略较早的 ' + dropped + ' 个片段（仅保留最近 ' + MAX_BLOCKS + ' 个）',
    })
    return out
  },

  /**
   * 正文总量封顶（见 {@link MAX_TOTAL_TEXT_CHARS}）。
   *
   * 从**最新往最旧**累计：最新的那几段保持完整（用户正在读的就是它们），
   * 一旦预算用完，更旧的正文档位换成一句明说"这段被省略了"的提示。
   * 不这么做的话：一条 20000 字符的正文配一份 274KB 的 nodes，几条就能把
   * 单次 setData 顶过 1MB —— 超限是**静默丢弃**，正文从此不再刷新。
   *
   * 幂等：已经截过的块（`trimmed`）不再重复处理，所以每帧调用不会反复重排。
   */
  _capText: function (blocks) {
    var total = 0
    var cut = false
    var out = blocks
    for (var i = blocks.length - 1; i >= 0; i--) {
      var b = blocks[i]
      if (b.kind !== 'text' || !b.text) continue
      if (!cut && total + b.text.length <= MAX_TOTAL_TEXT_CHARS) {
        total += b.text.length
        continue
      }
      cut = true
      if (b.trimmed) continue
      if (out === blocks) out = blocks.slice()
      var c = copyBlock(b)
      c.text = TEXT_TRIM_NOTICE
      c.trimmed = true
      c.done = true
      out[i] = this._withMd(c)
    }
    return out
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
    // 正文总量在这里封顶（块数上限管不到字节，见 MAX_TOTAL_TEXT_CHARS）
    trimmed = this._capText(trimmed)
    this._reindex(trimmed)
    // markdown 的 nodes 收进**顶层** map：wxml 要按 `item.key` 取，不能直接
    // 绑块上的字段（`rich-text` 那样会渲染成 0 高度空块，见 `_withMd` 的说明）。
    // 每次**整份重建**而不是增量改：块数有上限（MAX_BLOCKS），一份重建的
    // 成本就是一次遍历，而增量改要额外判断"哪一块被裁掉了"，漏一次就是
    // 一块永远留在 map 里的孤儿 nodes（会渲染出一段没人能解释的内容）。
    //
    // ⚠️ **交给渲染层的 blocks 必须剥掉 `_md`**：同一份 nodes 存两处时，
    // 一条 20000 字符的正文在 setData 里是两块各 274KB（约 550KB），
    // 再加上别的块就能顶过单次 1MB 的硬上限 —— 超限是静默丢弃，正文不再刷新。
    // 剥掉的那一份缓存在 `_mdNodes`（按块 key），下一次提交照样取得到。
    if (!this._mdNodes) this._mdNodes = {}
    var bodies = {}
    var payload = new Array(trimmed.length)
    for (var i = 0; i < trimmed.length; i++) {
      var b = trimmed[i]
      var nodes = b._md ? b._md.nodes : null
      if (nodes) bodies[b.key] = nodes
      else if (b.kind === 'text' && b.text && this._mdNodes[b.key]) bodies[b.key] = this._mdNodes[b.key]
      if (b._md) {
        var c = copyBlock(b)
        delete c._md
        payload[i] = c
      } else {
        payload[i] = b
      }
    }
    // 缓存只留还在块流里的（被裁掉的块不许留孤儿 nodes）
    this._mdNodes = bodies
    this.setData({ blocks: payload, turn: renumbered.turn, mdBodies: bodies }, function () {
      // 只在用户还贴着底部时跟随；他往上翻过就让他安静地读。
      // 「加载更早」那一路显式静音：往前插内容时跟底会把他从刚读到的位置甩走。
      if (self.scroll.shouldFollowNewContent(opts)) self._scrollToBottom()
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
    // 发送前的**最后一道**帧预算闸（2026-10-06）：附件那两道只算附件，正文长度没人管。
    // 512KB 附件 + 约 88KB 以上正文会顶过中继的 1MB 硬帧上限，帧被 1009 掐掉、
    // 整条连接断掉，用户看到的是"发出去就掉线"。这里提前拦，并说清该减什么。
    // **必须拦在清空输入框之前**：拦完再清，用户就要重打一遍。
    var wire = estimateWireFrameBytes(text, images)
    if (wire > WIRE_FRAME_BUDGET - WIRE_FRAME_HEADROOM) {
      wx.showToast({
        title:
          '这条太大发不出去（' +
          Math.round(wire / 1024) +
          'KB，超中继上限）：先把正文或附件减一些',
        icon: 'none',
      })
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
    this.scroll.onScrollToLower() // 刚发出去的这条必须自己看得见
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
   * 附件入口的能力守卫（2026-10-07 审计新增）。
   *
   * ## 为什么需要
   *
   * `env.probe()` 早就探到了 `chooseMessageFile` / `chooseMedia` / `showActionSheet`
   * （诊断行里就是 `CHOOSE_MSG_FILE=` / `ACTION_SHEET=` 两项，2026-10-06 还专门补的），
   * 但**没有任何调用点读它们**。于是老基础库上：
   *
   *   点「加号 → 文件」→ `wx.chooseMessageFile is not a function`
   *
   * 一句 `TypeError` 抛在 `showActionSheet` 的 success 回调里，用户看到的只有
   * 「点了没反应」，而他唯一能做的事（把诊断行发回来）里恰恰写着缺哪个能力 ——
   * 探到了、报出来了，就是没人读。
   *
   * 这一页其余每一处 API 调用都有守卫（`compressImage`、`canvas`、`scanCode`…），
   * 附件这两条是**唯一**漏掉的，所以那不是"疏忽"，是没写完。
   *
   * @param {string} apiName 宿主 API 名（也是 probe 里的字段名）
   * @param {string} what 用户视角的这件事（"选文件"/"选图片"/"打开那个菜单"）
   * @returns {boolean} 有这个能力吗（false 时已经提示过了，直接返回）
   */
  _requireApi: function (apiName, what) {
    var p = env.probe()
    if (p && p[apiName]) return true
    wx.showModal({
      title: '当前环境无法' + what,
      content:
        '这个运行环境没有 ' +
        apiName +
        '（' +
        (p ? p.global : '?') +
        '）。\n' +
        '请在微信开发者工具里运行，或把自己的 AppID 用真机调试方式打开。\n' +
        '（可点下面的「复制环境自检」把这行诊断发回来，里面写着缺的是哪个能力。）',
      showCancel: false,
    })
    return false
  },

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
    // 守卫：`wx.showActionSheet` 不在极老的容器里，而抛在回调里等于"点了没反应"
    if (!this._requireApi('showActionSheet', '打开附件菜单')) return
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
    // 守卫：`chooseMedia` 是基础库 2.10.0 才有的 API，比这一代其它任何一个都新
    if (!this._requireApi('chooseMedia', '从相册选图')) return
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
    // 守卫（2026-10-07 审计）：老基础库上没有 `chooseMessageFile`，
    // 直接调它抛一句 TypeError，而用户看到的是"点了加号没反应"——
    // 与"文件读不出来"那条 toast 长得很像，用户会以为是自己文件的问题。
    if (!this._requireApi('chooseMessageFile', '从微信会话里选文件')) return
    wx.chooseMessageFile({
      count: room,
      success: function (r) {
        self._acceptPickedFiles(r.tempFiles || [])
      },
    })
  },

  /**
   * 逐份文件：读成 base64 -> 过预算闸 -> 进 attachments。
   *
   * ## 路径字段：`path`，不是 `tempFilePath`（2026-10-06 用户报"txt 附件读不出来"）
   *
   * 真 API 的形状在官方类型定义 `miniprogram-api-typings` 的 `ChooseFile` 里写死了：
   *
   * ```ts
   * interface ChooseFile {
   *   name: string                                  // 文件名（带扩展名）
   *   path: string                                  // ← 本地临时路径
   *   size: number
   *   time: number
   *   type: 'video' | 'image' | 'file'              // ← 类别，不是扩展名
   * }
   * ```
   *
   * 旧代码读 `f.tempFilePath` —— 那是 `chooseMedia` / `chooseImage` 的字段，
   * `chooseMessageFile` **从来没有**它。于是 `filePath` 恒为 undefined，
   * 每一个文件都直接落进 "这个文件读不出来 换一个试试"：文件附件这条路**一次都没通过**。
   *
   * `tempFilePath` 一起兜着是有意的，不是留后路：1.1.6 那次修的正是它（`chooseMedia` 侧），
   * 而不同基础库/开发者工具对这两个入口的字段命名历史上并不统一。两个都读，
   * 哪个给就用哪个——总比赌某一个更稳。
   *
   * ## 为什么非要读（用户问过："不能直接传路径吗？"）
   *
   * 不能。`path` 是 `wxfile://` 沙箱里的**本机临时路径**，只在手机那个沙箱内有意义：
   * 主机插件跑在 Mac 上，中继是零知识中继（从头到尾只有密文、没有密钥）。
   * Mac 上那个 Agent 要看到文件内容，唯一的通路就是**字节本身**走一遍载荷层
   * （`cmd.send_prompt.files[].data`，base64），到主机再落盘换成路径交给 Agent
   * （`shell/uploads.ts`）。要让"直接传"成立，就得把文件放到一个第三方服务器上、
   * 再让 Mac 去拉——那等于把零知识这条整个拆掉，所以这条路是不改的。
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
      var filePath = f.tempFilePath || f.path
      if (!filePath) {
        wx.showToast({ title: '这个文件读不出来 换一个试试', icon: 'none' })
        next()
        return
      }
      var name = f.name || f.fileName || ''
      var meta = {
        kind: 'file',
        name: name,
        // type 是**类别**（'video'/'image'/'file'），拿它当扩展名会把 report.pdf 标成
        // mediaType:'file'——界面上那一行的类型标签就没信息了。扩展名从**文件名**上取，
        // 那才是 Agent 认文件真正依据的东西（uploads.ts 不改扩展名）。
        type: extensionOf(name, f.type),
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
      // **没有 compressImage 就直接进下一步**：老容器 / 工具某些模式下这个 API
      // 不存在，无条件调用会在用户点加号时抛一句 TypeError（"加不进来"）。
      // 文件头那句"没有 compressImage 就用相册给的文件"说的就是这一支 ——
      // 缩图那一步（画布）自己还有一次能力探测，两处都不行才会一路退到原文件。
      if (!env.probe().compressImage) {
        self._shrinkPicked(picked, f, out, next)
        return
      }
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

  /**
   * 页面上那块藏起来的 2d 画布（懒建 + 缓存）。没有画布能力回 null。
   *
   * ⚠️ **结果只能走回调**：`createSelectorQuery().exec(cb)` 的回调是逻辑层→渲染层
   * 跑一个来回之后才回来的。旧实现把 `node` 写在回调里，却在 `exec()` 之后**同步**
   * 读它 —— 那时它还是 null，而且这个 null 被缓存进 `_canvasNode`（首行
   * `!== undefined` 直接返回），于是**整页生命周期一次都拿不到画布**，
   * `_shrinkPicked` 的"钉死长边"一步从来没跑过：Android 上 compressImage 的
   * quality 被系统忽略，压完还是几 MB，用户看到的是"这张图压完还有 NNNKB 太大"。
   * 所以：结果只在回调里给，并且**拿到节点之后**才写缓存（失败也缓存 null，
   * 只是不再重复查询）。
   */
  _shrinkCanvas: function (cb) {
    var self = this
    if (this._canvasNode !== undefined) {
      cb(this._canvasNode || null)
      return
    }
    if (!env.probe().canvas) {
      this._canvasNode = null
      cb(null)
      return
    }
    wx.createSelectorQuery()
      .select('#drc-shrink')
      .fields({ node: true, size: true })
      .exec(function (res) {
        self._canvasNode = res && res[0] ? res[0].node || null : null
        cb(self._canvasNode)
      })
  },

  /**
   * 把长边钉死。本来就小的图原样放过——缩一张 800px 的截图只会更糊。
   *
   * 为什么不靠 compressImage 反复降 quality：Android 上 quality 被忽略，
   * 那条路在 Android 上一格都不降。
   */
  _shrinkPicked: function (path, meta, out, done) {
    var self = this
    this._shrinkCanvas(function (canvas) {
      if (!canvas) {
        self._readAsBase64(path, meta, out, done, self)
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
    /**
     * **不许无条件报成功**（2026-10-07 补，§5-5）。
     *
     * `sendCmd` 是会返回 false 的：退避窗口内、或 socket 对象还在而底层 task 已经
     * 不在（重连退避窗口）时，那条帧根本没上过网。这一句原来**不看结果**一律 toast
     * 「已发送中断」—— 用户以为中断发出去了，主机那边的回合照旧跑到底，
     * 而这正是"点了没反应"里最让人困惑的一档（它还额外报了一次成功）。
     *
     * 失败时不再叠第二条 toast：`sendCmd` 自己已经 emit 了一条带原因的 error，
     * 页面上那个 `evt.kind === 'error'` 的分支会把它弹出来。
     */
    if (this.client.interrupt(this.data.sessionId) === false) return
    wx.showToast({ title: '已发送中断', icon: 'none' })
  },

  onPermissionTap: function (e) {
    var decision = e.currentTarget.dataset.decision
    var perm = this.data.pendingPermission
    if (!perm) return
    /**
     * **先把帧发出去、再清卡**（2026-10-07 补，§5-6）。
     *
     * 顺序原来是反的：卡当场 `setData(null)`，然后再发。可 `sendCmd` 是会失败的
     * （退避窗口、底层 socket 不在、没配上……），失败时那张卡**已经没了**——
     * 主机那边继续阻塞 180 秒，而用户手上没有任何能再点一次的东西，
     * 界面上还留着"已经决定了"的假象。发不出去时卡原地不动，
     * `sendCmd` 那条 error 说明原因，用户再点一次就行。
     */
    if (this.client.resolvePermission(this.data.sessionId, perm.requestId, decision) === false) return
    this.setData({ pendingPermission: null, running: decision !== 'reject' })
    this._renderBar()
    // **这表两张卡共用**：提问卡还挂着就继续走秒（它在 data 里没被动过）。
    // 无条件停表会把提问卡的倒数冻在那一刻 —— 用户以为还有 2 分钟，
    // 而主机那边 300 秒一到就按"没答上"结掉了。
    if (!this.data.pendingQuestion) this._stopCardTick()
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
    // **先发、再清卡**（与 onPermissionTap 同一条，2026-10-07，§5-6）：
    // 发不出去时卡留着，用户可以再点一次；清掉就再也补不回来了，
    // 而主机那条 300 秒的提问还挂着等答案。
    if (this.client.answer(this.data.sessionId, q.requestId, answers) === false) return
    this.setData({ pendingQuestion: null, running: true })
    this._renderBar()
  },
})
