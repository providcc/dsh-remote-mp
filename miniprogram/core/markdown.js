/**
 * markdown — 把 AI 回复的 Markdown 转成小程序 `rich-text` 能吃的 nodes。
 *
 * ── 为什么必须自己写这一层 ──────────────────────────────────────────
 * 小程序**没有 DOM**，没有 innerHTML，也没有任何 HTML 解析器。渲染 Markdown
 * 只有一条路：手写 token → `rich-text` 的 nodes 结构。官方 npm 上那些
 * 「小程序 Markdown 组件」多数是 `.axml`（支付宝语法）或要 WebView，都用不了。
 *
 * 语法解析交给 `vendor/marked.js`（只调 `lexer()`，它只切 token 不出 HTML）。
 * **这一层只做渲染**，不碰任何语法判断 —— 嵌套强调的边界、链接括号配平、
 * 未闭合围栏这些都由 marked 负责，重新实现一遍只会更差。
 *
 * ── `rich-text` 的三条硬限制（每一条都在下面有对应处理）───────────────
 * ① **标签白名单**：只认受信任的一批（p/h1-h6/strong/em/code/pre/ul/ol/li/
 *    blockquote/table/tr/td/th/img/a/hr/del/s/sub/sup…）。白名单外的标签会被
 *    丢弃或当纯文本。所以我们只生成白名单里的标签 —— 见 `ALLOWED`。
 * ② **不认 `style` 之外的 class**：`attrs.style` 是可靠的，`attrs.class` 在
 *    `rich-text` 内部**只在自定义组件的 wxss 里生效**。我们用的是内置组件，
 *    所以样式一律走 **inline style**（`styleOf()`），并且颜色在渲染时
 *    **解析成具体色值**（见 `palette()`）—— 这条是深色模式能不能成立的关键。
 * ③ **内部不能滚动**：表格列多了会溢出，而 `rich-text` 里没有 `scroll-view`。
 *    所以表格由调用方拆出来单独渲染（`splitTables()`），外面自己包
 *    `scroll-view`。x-markdown-mini 的做法也是固定列宽 + 外层横滚。
 *
 * ── 为什么颜色要「解析成具体色值」而不是 `var(--xxx)` ─────────────────
 * 本项目真机踩过：CSS 自定义属性在**声明它的那个元素**上解析，继承下来的是
 * 计算值；而 `rich-text` 内部对自定义属性的继承支持又不稳。写成
 * `style="color: var(--td-text-color-primary)"` 的结果是**深色下字色不变**
 * （近黑字压在深底上）。所以这里从主题取值表里**算出真实色值**再写进去。
 * 代价是色值有两份（wxss 变量表 + 本文件 `PALETTE`），改配色要同时改两处 ——
 * 这条由 `scripts/check-mp-contrast.mjs` 兜（它认得本文件里的色值，见该脚本）。
 */
'use strict'

var marked = require('./vendor/marked.js')

// ── 主题色板 ──────────────────────────────────────────────────────────
// 与 miniprogram/theme/{light,dark}.wxss 里那几个变量**同一个口径**。
// 取的是「正文色 / 次要色 / 分隔线 / 代码底」这四个真正会被 markdown 用到的，
// 全部经过 check-mp-contrast 的对比度校验（正文 4.5:1）。
var PALETTE = {
  light: {
    text: '#181818', // --td-text-color-primary
    muted: '#7a7a7a', // --td-text-color-placeholder（对比度校验过 ≥4.5）
    rule: '#e5e5e5', // --td-border-color / 分隔线
    codeBg: '#f3f3f3', // --td-brand-color-1 浅底档
    quoteBg: '#fafafa',
    link: '#0052d9' // --td-brand-color
  },
  dark: {
    text: '#e8e8e8', // 深色下正文必须够亮（本项目踩过"字全黑"）
    muted: '#9a9a9a',
    rule: '#3a3a3a',
    codeBg: '#242424',
    quoteBg: '#1e1e1e',
    link: '#5a9bff'
  }
}

/** 取当前主题的色板；theme 由 core/theme.js 决定（light / dark）。 */
function palette(isDark) {
  return isDark ? PALETTE.dark : PALETTE.light
}

// ── rich-text 白名单 ─────────────────────────────────────────────────
// 只列**本文件真的会生成**的标签。生成白名单外的标签 = 那个元素被小程序丢掉，
// 内容凭空消失（比显示成纯文本更糟），所以这张表是硬约束不是参考。
var ALLOWED = {
  p: true,
  br: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  strong: true,
  b: true,
  em: true,
  i: true,
  del: true,
  s: true,
  code: true,
  pre: true,
  blockquote: true,
  ul: true,
  ol: true,
  li: true,
  a: true,
  img: true,
  hr: true,
  table: true,
  thead: true,
  tbody: true,
  tr: true,
  th: true,
  td: true,
  span: true,
  div: true,
  sub: true,
  sup: true
}

/** 构造一个文本节点。`rich-text` 的文本节点是 `{type:'text', text}`。 */
function textNode(s) {
  return { type: 'text', text: s == null ? '' : String(s) }
}

/**
 * 构造一个元素节点。
 *
 * `style` 一律拼在这里而不是交给 wxss —— 见文件头限制 ②。
 * 省略空 style：给 `rich-text` 传 `style:''` 会让该元素失去所有默认行高，
 * 比不给更糟。
 */
function el(name, style, children) {
  var node = { name: name, children: children || [] }
  if (style) node.attrs = { style: style }
  return node
}

// ── 行内 token ───────────────────────────────────────────────────────
// marked 的 inline token 里 `text` 是已解码的纯文本（HTML 实体已还原），
// `rich-text` 的文本节点会自己转义，**不要再 escape 一次** —— 那会让
// `&` 变成 `&amp;` 的字面量，页面上真的显示 `&amp;`。
function inlineNodes(tokens, c) {
  var out = []
  if (!tokens) return out
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i]
    switch (t.type) {
      case 'text':
        if (t.tokens) out.push.apply(out, inlineNodes(t.tokens, c))
        else out.push(textNode(t.text))
        break
      case 'escape':
        // 转义字符（\* 这种）：要的是**字符本身**，不是它的 raw 写法
        out.push(textNode(t.text))
        break
      case 'strong':
        out.push(el('strong', 'font-weight:600;', inlineNodes(t.tokens, c)))
        break
      case 'em':
        out.push(el('em', 'font-style:italic;', inlineNodes(t.tokens, c)))
        break
      case 'del':
        out.push(el('del', 'text-decoration:line-through;', inlineNodes(t.tokens, c)))
        break
      case 'codespan':
        // 行内代码：药丸底 + 等宽。`word-break` 让长串（URL/哈希）不撑破布局。
        out.push(
          el(
            'code',
            'font-family:Menlo,Monaco,Consolas,"Courier New",monospace;font-size:0.9em;' +
              'background:' + c.codeBg + ';color:' + c.text + ';' +
              'padding:2rpx 6rpx;border-radius:4rpx;word-break:break-all;',
            [textNode(t.text)]
          )
        )
        break
      case 'br':
        out.push(el('br', ''))
        break
      case 'link': {
        var kids = inlineNodes(t.tokens, c)
        // 链接：小程序里 rich-text 的 a 点不跳（attrs 不支持 onclick），
        // 所以只保留**可读性**（颜色 + 下划线），不做可点。
        // 假装能点而实际点了没反应，比不可点更糟。
        var a = el('a', 'color:' + c.link + ';text-decoration:underline;', kids.length ? kids : [textNode(t.text)])
        if (t.href) a.attrs.href = t.href
        out.push(a)
        break
      }
      case 'image': {
        // 只认网络图（rich-text 的 img 只支持网络 src），且要限宽否则溢出。
        var img = el('img', 'width:100%;')
        img.attrs.src = t.href || ''
        if (t.text) img.attrs.alt = t.text
        out.push(img)
        break
      }
      case 'html':
        // 内联 HTML 在小程序里没有意义。**当纯文本显示**而不是丢掉：
        // 丢掉 = 用户看到内容凭空消失。
        out.push(textNode(t.text || t.raw || ''))
        break
      default:
        // 未知类型：退回纯文本，绝不静默丢内容。
        if (t.tokens) out.push.apply(out, inlineNodes(t.tokens, c))
        else if (t.text) out.push(textNode(t.text))
        else if (t.raw) out.push(textNode(t.raw))
    }
  }
  return out
}

// ── 块级 token ───────────────────────────────────────────────────────
var HEADING_SIZE = [
  '34rpx', // h1
  '31rpx',
  '29rpx',
  '28rpx',
  '28rpx',
  '28rpx'
]
var HEADING_MARGIN = [
  '20rpx 0 12rpx', // h1 前后留白最大，往下递减
  '18rpx 0 10rpx',
  '16rpx 0 8rpx',
  '14rpx 0 8rpx',
  '12rpx 0 6rpx',
  '12rpx 0 6rpx'
]

function blockNodes(tokens, c) {
  var out = []
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i]
    switch (t.type) {
      case 'space':
        break // 空行只用于分隔，不产生节点
      case 'heading': {
        var d = Math.min(Math.max(t.depth || 1, 1), 6) - 1
        out.push(
          el(
            'h' + (d + 1),
            'font-size:' + HEADING_SIZE[d] + ';font-weight:600;line-height:1.4;' +
              'margin:' + HEADING_MARGIN[d] + ';color:' + c.text + ';',
            inlineNodes(t.tokens, c)
          )
        )
        break
      }
      case 'paragraph':
        // 段落间距靠 `margin` 而不是空 `space` 节点：`rich-text` 里多个
        // 相邻 margin 会**塌陷**（拿到最大值），所以只留底部 margin，
        // 不写顶部 —— 那样段间距会变成"两个加起来"，还是最大，不会翻倍。
        out.push(
          el('p', 'font-size:29rpx;line-height:1.65;margin:0 0 12rpx;color:' + c.text + ';', inlineNodes(t.tokens, c))
        )
        break
      case 'blockquote': {
        var inner = blockNodes(t.tokens, c)
        // 引用：左边框 + 浅底。底色用 quoteBg 而不是透明，深色下光靠边框太弱。
        out.push(
          el(
            'blockquote',
            'display:block;margin:12rpx 0;padding:8rpx 16rpx;' +
              'border-left:6rpx solid ' + c.muted + ';' +
              'background:' + c.quoteBg + ';color:' + c.muted + ';',
            inner
          )
        )
        break
      }
      case 'hr':
        out.push(el('hr', 'display:block;margin:16rpx 0;border-top:2rpx solid ' + c.rule + ';height:0;'))
        break
      case 'code': {
        // 围栏代码块：`pre` 里只能放 `code`，两者都在白名单里。
        // 用 `pre` + `code` 而不是 div，是为了拿到 `white-space:pre` 的语义 ——
        // 不写它的话所有行会在一处连成一行（<pre> 不生效）。
        //
        // **长行是换行而不是横滚**：代码块不像表格那样被 `splitTables()` 拆出来，
        // 而 `rich-text` 内部也不能横向滚动。所以这里靠 `word-break:break-all`
        // 让长行折行（复制出来的代码仍然是原文，换行只是显示层的）。
        // 想要横滚得把代码块也拆出来单配 `scroll-view`，代价是 chat 页要多一套
        // 拆分逻辑 —— 与其那样，不如先确认"折行够不够用"。
        var body = el(
          'code',
          'display:block;font-family:Menlo,Monaco,Consolas,"Courier New",monospace;' +
            'font-size:25rpx;line-height:1.55;white-space:pre-wrap;word-break:break-all;' +
            'background:' + c.codeBg + ';color:' + c.text + ';',
          [textNode(t.text || '')]
        )
        var lang = t.lang ? String(t.lang).split(/\s+/)[0] : ''
        var pre = el('pre', 'display:block;margin:12rpx 0;padding:14rpx 16rpx;border-radius:8rpx;', [body])
        if (lang) pre.attrs.lang = lang // 仅作标记，样式由 wxss 决定
        out.push(pre)
        break
      }
      case 'list':
        out.push(listNode(t, c))
        break
      case 'table':
        out.push(tableNode(t, c))
        break
      case 'html':
        // 块级 HTML（<div> 之类）在小程序里没意义，当纯文本。
        if (t.text) out.push(el('p', 'font-size:27rpx;color:' + c.muted + ';', [textNode(t.text)]))
        break
      case 'def':
        break // 链接引用定义（[x]: url），不显示
      case 'checkbox':
        break // 任务列表的勾选框由 listNode 处理
      default:
        if (t.tokens) out.push.apply(out, blockNodes(t.tokens, c))
        else if (t.text) out.push(el('p', 'font-size:29rpx;', [textNode(t.text)]))
        else if (t.raw) out.push(el('p', 'font-size:29rpx;', [textNode(t.raw)]))
    }
  }
  return out
}

function listNode(t, c) {
  var ordered = !!t.ordered
  var tag = ordered ? 'ol' : 'ul'
  var items = []
  for (var i = 0; i < (t.items || []).length; i++) {
    var it = t.items[i]
    // 任务列表：`- [x] foo` → marker 换成 ✓/☐，其余按普通列表处理
    var marker = ordered ? String((t.start || 1) + i) + '.' : '•'
    if (it.task) marker = it.checked ? '✓' : '☐'

    var body = blockNodes(it.tokens, c)
    // 列表项内部的段落已经有 margin，去掉首段的上边距（本身为0）与末段的
    // 下边距（否则每个条目下面多一截空白，列表显得松散）。
    var kids = [el('span', 'color:' + c.muted + ';margin-right:8rpx;', [textNode(marker)])]
    if (body.length === 1 && body[0].name === 'p') {
      var p = body[0]
      kids = kids.concat(p.children)
    } else {
      kids = kids.concat(body)
    }
    items.push(el('li', 'display:block;margin:4rpx 0;', kids))
  }
  // 缩进靠 padding（不用 margin）：`rich-text` 内部的 margin 会塌陷，
  // 嵌套层级越多塌陷越明显，padding 是累加的、层级感才对。
  return el(tag, 'display:block;margin:8rpx 0;padding-left:28rpx;color:' + c.text + ';', items)
}

/**
 * 表格。**列宽固定 + 外层横滚**（调用方用 scroll-view 包）。
 *
 * 为什么固定列宽：列数不定时没法按内容分配宽度，而让 `rich-text` 里的
 * `table` 自动布局在真机上宽度不可控。固定 `COL_W` 让「列 = 一列宽」这个
 * 关系成立，滚动位置才稳定。
 *
 * ⚠️ `word-break:break-all` 是必须的：不写的话长单元格内容会把这列撑到
 * 240rpx 之外，整张表的列宽就不等于列数 × COL_W，横滚会错位。
 */
var COL_W = 240
function tableNode(t, c) {
  var rows = []
  var headCells = []
  for (var i = 0; i < (t.header || []).length; i++) {
    headCells.push(cellNode(t.header[i], c, 'th', true))
  }
  rows.push(el('tr', 'display:block;', headCells))
  for (var r = 0; r < (t.rows || []).length; r++) {
    var row = t.rows[r]
    var tds = []
    for (var k = 0; k < row.length; k++) tds.push(cellNode(row[k], c, 'td', false))
    rows.push(el('tr', 'display:block;', tds))
  }
  return el(
    'table',
    'display:block;width:' + (t.header || []).length * COL_W + 'rpx;' +
      'border-collapse:collapse;font-size:25rpx;',
    [el('thead', 'display:block;', [rows[0]]), el('tbody', 'display:block;', rows.slice(1))]
  )
}

function cellNode(cell, c, tag, isHead) {
  var pad = '12rpx 16rpx;border-right:2rpx solid ' + c.rule + ';border-bottom:2rpx solid ' + c.rule + ';'
  var style =
    'display:block;width:' + COL_W + 'rpx;min-width:' + COL_W + 'rpx;box-sizing:border-box;' +
    'padding:12rpx 16rpx;' + pad +
    'word-break:break-all;white-space:normal;vertical-align:top;' +
    'color:' + (isHead ? c.text : c.text) + ';'
  if (isHead) style += 'font-weight:600;background:' + c.quoteBg + ';'
  return el(tag, style, inlineNodes(cell.tokens, c))
}

// ── 对外 ─────────────────────────────────────────────────────────────

/**
 * Markdown → `rich-text` 的 nodes。
 *
 * @param {string} src Markdown 原文
 * @param {boolean} [isDark] 深色主题；决定色板
 * @returns {Array} nodes（空数组表示空输入）
 *
 * **不抛异常**：AI 回复里的内容不可控，一个畸形表格不该让整条消息渲染失败。
 * 解析出错时退化成「原文当纯文本」，那正是这个功能上线前的样子 —— 可用 > 好看。
 */
function render(src, isDark) {
  // 非字符串（null / undefined / 数字）一律**转成字符串再渲染**，不是当空输入：
  // 数据源变了形态时静默返回空数组 = 那条消息在界面上凭空消失，
  // 而"显示成纯文本"是这个功能上线前的样子，永远是可用的退路。
  var text = typeof src === 'string' ? src : src == null ? '' : String(src)
  if (!text) return []
  var c = palette(!!isDark)
  var nodes
  try {
    nodes = blockNodes(marked.lexer(text, { gfm: true, breaks: false }), c)
  } catch (e) {
    // 兜底：解析器抛了（畸形输入/极端嵌套）。退回纯文本，绝不让整条消息空掉。
    return [el('p', 'font-size:29rpx;line-height:1.65;white-space:pre-wrap;color:' + c.text + ';', [textNode(text)])]
  }
  // 白名单兜底：理论上不会越界（生成的都是白名单标签），但这是个便宜的保险 ——
  // 漏一个标签的表现是**那段内容凭空消失**，很难从界面上看出原因。
  return prune(nodes)
}

/**
 * 把 nodes 拆成「普通部分」与「表格部分」，表格按出现顺序单列。
 *
 * 为什么需要拆：`rich-text` 内部**不能横向滚动**，宽表格会直接撑破布局。
 * 调用方（chat 页）把 `tables` 里的每一项用 `<scroll-view scroll-x>` 包起来，
 * `parts` 里表格的位置用 `{ __table: i }` 占位。
 *
 * 形状：`{ parts: [...], tables: [...] }`
 *  - `parts` 里的元素要么是节点、要么是 `{ __table: <在 tables 里的下标> }`
 *  - `tables[i]` 是那个表格的 node
 *
 * @param {Array} nodes `render()` 的产物
 * @returns {{parts: Array, tables: Array}}
 */
function splitTables(nodes) {
  var parts = []
  var tables = []
  for (var i = 0; i < (nodes || []).length; i++) {
    if (nodes[i] && nodes[i].name === 'table') {
      tables.push(nodes[i])
      parts.push({ __table: tables.length - 1 })
    } else {
      parts.push(nodes[i])
    }
  }
  return { parts: parts, tables: tables }
}

/** 递归剥掉白名单外的标签（把它的 children 提上来），并把 `text` 归一。 */
function prune(nodes) {
  var out = []
  for (var i = 0; i < (nodes || []).length; i++) {
    var n = nodes[i]
    if (!n) continue
    if (n.type === 'text') {
      if (typeof n.text === 'string' && n.text) out.push(n)
      continue
    }
    if (n.__table !== undefined) {
      out.push(n) // 占位符，放行
      continue
    }
    if (!n.name || !ALLOWED[n.name]) {
      // 不在白名单：提 children 上来（内容不丢），没有 children 才真的没救
      var kids = prune(n.children || [])
      out.push.apply(out, kids)
      continue
    }
    n.children = prune(n.children || [])
    out.push(n)
  }
  return out
}

module.exports = {
  render: render,
  splitTables: splitTables,
  PALETTE: PALETTE,
  ALLOWED: ALLOWED,
  COL_W: COL_W
}