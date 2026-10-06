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
/**
 * 这些是**手挑的固定色值**，不是从 `theme/{light,dark}.wxss` 里读出来的
 * （`rich-text` 不认 var()，见文件头）。
 *
 * 溯源要说实话：变量表里那几个 token 是**别名**（`--td-text-color-primary` →
 * `--td-font-gray-1` 是带 alpha 的黑/白），而这里必须是能直接写进 inline style 的
 * 实色，所以只能取"压在该主题的容器底上算出来的那个色"。它们与 token
 * **同一档语义、数值不逐字相等**（例：浅色正文 #181818，而 token 压白底约 #1a1a1a）。
 * 改配色时两处都要看；对比度由 `scripts/check-mp-contrast.mjs` 兜（它认得这里的色值）：
 *
 *   light（压在白卡片 #ffffff 上）
 *     text     正文近黑                      ← --td-text-color-primary（rgba(0,0,0,.9) 压白）
 *     muted    次要/占位灰                   ← --td-text-color-placeholder（light.wxss 覆盖为 rgba(0,0,0,.56)）
 *     rule     分隔线                        ← 边框灰那一档
 *     codeBg   代码块底（比正文卡深一档）      ← --td-bg-color-page 灰
 *     quoteBg  引用块/表头底（比正文卡浅一档，当"内嵌"用）
 *     link     链接                          ← --td-brand-color（= --td-brand-color-7 #0052d9，逐字相同）
 *
 *   dark（压在正文卡 #2c2c2c = --td-gray-color-12 上）
 *     text     正文必须够亮（本项目踩过"字全黑"）← --td-text-color-primary（rgba(255,255,255,.9)）
 *     muted    次要/占位灰                   ← --td-text-color-placeholder（dark.wxss 覆盖为 rgba(255,255,255,.5)）
 *     rule     分隔线（比卡片亮一档，否则看不见）
 *     codeBg   代码块底 —— 比卡片**亮一档**（曾经与卡片同色 → 代码块整块消失，2026-10-04 修）
 *     quoteBg  引用块/表头底 —— 比卡片暗一档（同一次一起定的）
 *     link     链接（比浅色那档亮，压深底才读得清）
 */
var PALETTE = {
  light: {
    text: '#181818',
    muted: '#7a7a7a',
    rule: '#e5e5e5',
    codeBg: '#f3f3f3',
    quoteBg: '#fafafa',
    link: '#0052d9'
  },
  dark: {
    text: '#e8e8e8',
    muted: '#9a9a9a',
    rule: '#3a3a3a',
    codeBg: '#333333',
    quoteBg: '#262626',
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
      case 'text':
        // 列表项/引用里的裸文本段：它带的是**行内** tokens。旧代码让它落进
        // default 分支递归，于是每个行内 token（文本/加粗/行内码）都各自变成
        // 一个 p —— rich-text 里 p 嵌 p 会按 shrink-to-fit 布局，真机上整列
        // bullet 每行只排五六个字（2026-10-04 截图，见 mp-shots chat-md-width）。
        // 正确形状：一个 p 包着行内节点；listNode 再把 marker 与它们拼成一条。
        out.push(
          el('p', 'font-size:29rpx;line-height:1.65;margin:0 0 12rpx;color:' + c.text + ';', t.tokens ? inlineNodes(t.tokens, c) : [textNode(t.text || '')])
        )
        break
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
        out.push.apply(out, listNode(t, c))
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

/**
 * 为什么每个条目是一个 p 而不是 ul/li：真机截图（2026-10-04）里 ul/li 在
 * rich-text 中布局坍缩成 shrink-to-fit，一整列 bullet 每行只排五六个字；
 * 同一屏里 p 段落是满宽的，差别只在标签。缩进用 padding-left（rich-text
 * 内部 margin 会塌陷）。返回值因此是**一个数组**，调用方 apply 展开。
 */
function listNode(t, c, depth) {
  depth = depth || 0
  var ordered = !!t.ordered
  var pad = 28 + depth * 28
  var out = []
  for (var i = 0; i < (t.items || []).length; i++) {
    var it = t.items[i]
    // 任务列表：`- [x] foo` → marker 换成 ✓/☐，其余按普通列表处理
    var marker = ordered ? String((t.start || 1) + i) + '.' : '•'
    if (it.task) marker = it.checked ? '✓' : '☐'

    // 条目自身的行内内容与嵌套结构**分开处理**：行内摊进这一条 p；
    // 嵌套列表递归成**扁平**的后续几条（缩进逐层加深）；其它块级内容
    // （代码块等）跟在这一条后面。
    //
    // 为什么必须摊平而不能嵌套：rich-text 里 p 嵌 p 会按 shrink-to-fit 布局，
    // 真机上整列 bullet 每行只排五六个字（2026-10-04 截图，mp-shots 的
    // chat-md-width）。摊平之后每个条目都是顶层 p —— 满宽。
    var kids = [el('span', 'color:' + c.muted + ';margin-right:8rpx;', [textNode(marker)])]
    var trailing = []
    var toks = it.tokens || []
    for (var k = 0; k < toks.length; k++) {
      var tk = toks[k]
      if (tk.type === 'space') continue
      if (tk.type === 'text') {
        kids = kids.concat(tk.tokens ? inlineNodes(tk.tokens, c) : [textNode(tk.text || '')])
      } else if (tk.type === 'list') {
        trailing = trailing.concat(listNode(tk, c, depth + 1))
      } else {
        trailing = trailing.concat(blockNodes([tk], c))
      }
    }
    // 缩进用 padding-left（margin 在 rich-text 内部会塌陷），逐层 +28rpx。
    out.push(el('p', 'margin:4rpx 0;padding-left:' + pad + 'rpx;color:' + c.text + ';', kids))
    out = out.concat(trailing)
  }
  return out
}

/**
 * 表格。**列宽按容器比例分配**（每列 `100/列数`%），随正文一起渲染。
 *
 * ── 为什么不再固定列宽 + 外层横滚 ──────────────────────────────────
 * 原来的做法是「固定 `COL_W` 240rpx，表格摘出来由调用方用 `scroll-view scroll-x` 包」。
 * 那条路走不通，根因在渲染层而不是表格本身：**`rich-text` 的 `nodes` 不能绑
 * `wx:for` 作用域里的变量**（绑了会渲染成高度 0 的空块），而「每张表一个
 * `scroll-view` + `rich-text`」必然要按段落循环 → 必然绑到循环项。
 * 逐档实测：顶层字段可以，`顶层map[key]` 可以，`顶层map[key][i]` 与
 * `wx:for` 的循环项都不行（见 chat 页 `_commit` 的注释）。
 *
 * 官方文档确认 `table`/`tr`/`td`/`th` 都在受信任标签里，且 `td` 支持 `width`，
 * 所以表格可以**留在正文里**。代价是宽表在窄屏上会挤一些 —— 但对「远程看 AI 干活」
 * 这个场景，能读到的内容比能横滑更重要（横滑在小程序里要先看到表才知道右边还有列）。
 *
 * `word-break:break-all` 仍然是必须的：不写的话长单元格会把这一列撑破，
 * 「每列等宽」就不成立。
 */
function tableNode(t, c) {
  var cols = (t.header || []).length || 1
  // 用百分比而不是 rpx：容器宽度由页面决定，百分比才跟着变。
  // `min-width` 给一个下限，避免 8 列以上的表被压到每个字一行。
  var colPct = (100 / cols).toFixed(4) + '%'
  var rows = []
  var headCells = []
  for (var i = 0; i < (t.header || []).length; i++) {
    headCells.push(cellNode(t.header[i], c, 'th', true, colPct))
  }
  rows.push(el('tr', '', headCells))
  for (var r = 0; r < (t.rows || []).length; r++) {
    var row = t.rows[r]
    var tds = []
    for (var k = 0; k < row.length; k++) tds.push(cellNode(row[k], c, 'td', false, colPct))
    rows.push(el('tr', '', tds))
  }
  return el(
    'table',
    'display:block;width:100%;table-layout:fixed;' +
      'border-collapse:collapse;font-size:25rpx;',
    [el('thead', '', [rows[0]]), el('tbody', '', rows.slice(1))]
  )
}

function cellNode(cell, c, tag, isHead, colPct) {
  var pad = '12rpx 16rpx;border-right:2rpx solid ' + c.rule + ';border-bottom:2rpx solid ' + c.rule + ';'
  var style =
    'width:' + colPct + ';min-width:120rpx;box-sizing:border-box;' +
    'padding:12rpx 16rpx;' + pad +
    'word-break:break-all;white-space:normal;vertical-align:top;' +
    'color:' + c.text + ';'
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
/**
 * 一块正文的**嵌套封顶**（2026-10-06 审计）。
 *
 * 为什么需要：`render()` 下面那个 `try/catch` **救不了"极端嵌套"这一支**——
 * 它自己的注释就写着"解析器抛了（畸形输入/极端嵌套）"，但实测里 `marked.lexer`
 * 在深嵌套上不是抛，是**把堆吃光然后被引擎致命终止**：
 *
 * ```
 * 2000 层嵌套列表（约 16–20KB 正文，仍在 MAX_TEXT_PER_BLOCK=20000 之内）
 *   → FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 * ```
 *
 * 致命终止**不是异常**，try/catch 拦不住，`catch` 里那句"退化成纯文本"永远轮不到执行。
 * 在小程序上那不是"这一条渲染得丑"，是**整个页面进程被打死**：用户看到的是页面没了，
 * 要重新进一次会话，而正文本身一个字节都没坏。
 *
 * 所以要在**进 lexer 之前**判掉。判据是"最大结构嵌套层数"，用一个便宜的一遍扫描：
 * 引用符号 `>` 一层，行首缩进两格算一层（marked 的常用口径）。正常内容深不了十几层，
 * 真正的爆点在 1000 层以上——32 这个上限离两者都极远。
 *
 * 命中上限就**整体退化成纯文本**（与 catch 分支同一条退路）：内容一个不少地留在屏幕上，
 * 样式少了，但页面活着。流式期会有一次可见的跳变（前半段还是排版好的，越过上限后整块
 * 变纯文本）——那是两种结果里明显更好的那一种。
 */
var MAX_RENDER_NESTING = 32

/**
 * 最大结构嵌套层数。**只看结构标记，不看正文内容**——正文里有多少个 `-`、多少个 `>`
 * 都不算数，只数行首那几个。
 *
 * 提前返回：一旦越过上限就没必要看完剩下的行（正常文本第一遍扫完即可，代价与行数成正比）。
 */
function nestingDepthOf(text) {
  var deepest = 0
  var lines = String(text).split('\n')
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (!line) continue
    var depth = 0
    var j = 0
    // 行首只可能是一串 `>` 与空白（引用 + 列表缩进），这里一次走完。
    for (; j < line.length; j++) {
      var ch = line.charAt(j)
      if (ch === '>') depth++
      else if (ch === ' ' || ch === '\t') depth += ch === '\t' ? 2 : 0.5
      else break
    }
    depth = Math.floor(depth)
    if (depth > deepest) deepest = depth
    if (deepest > MAX_RENDER_NESTING) return deepest
  }
  return deepest
}

function render(src, isDark) {
  // 非字符串（null / undefined / 数字）一律**转成字符串再渲染**，不是当空输入：
  // 数据源变了形态时静默返回空数组 = 那条消息在界面上凭空消失，
  // 而"显示成纯文本"是这个功能上线前的样子，永远是可用的退路。
  var text = typeof src === 'string' ? src : src == null ? '' : String(src)
  if (!text) return []
  var c = palette(!!isDark)
  // 极端嵌套要在 lexer **之前**拦：它不是异常，catch 拦不住（见 MAX_RENDER_NESTING 的注释）。
  if (nestingDepthOf(text) > MAX_RENDER_NESTING) {
    return [el('p', 'font-size:29rpx;line-height:1.65;white-space:pre-wrap;color:' + c.text + ';', [textNode(text)])]
  }
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

// ── 流式：尾部缓冲 ───────────────────────────────────────────────────
//
// 问题的实测形态（逐字输入 `a **粗体** b`，marked v18.0.14）：
//
//     输入 "a **粗体"   → 文字 "a **粗体"     ← 标记还在屏幕上
//     输入 "a **粗体*"  → 文字 "a *"          ← **跳变**（还吃掉了前导 *）
//     输入 "a **粗体**" → 文字 "a 粗体"       ← 闭合才变粗体
//
// 所以「等闭合再排版」会跳，而这一页的主场景恰恰是长回复，跳变次数很多。
//
// 办法：**把尾部可能是不完整语法的字符先扣住不渲染**，只渲染确定的那部分。
// 下一帧如果闭合了，就把它放出来 —— 用户看到的是「文字先出现、加粗样式稍后补上」，
// 观感接近原生 App 的流式 Markdown，且几乎看不见重排。
//
// 实测（逐字输入 `a **粗体** b`，缓冲后）：
//     第 7 帧 "a **粗体*"  → "a *粗体"    ← **粗体** 三字位置不变
//     第 8 帧 "a **粗体**" → "a 粗体"     ← 星号消失、加粗补上，**文字无倒退**
//
// ⚠️ **一处已知且接受的 marked 行为**：围栏**未闭合**时 `` ```js `` 里的 `js`
// 会被当成语言标记丢掉（代码内容一字不差）。实测 `render("```js\nc")` → `"c"`、
// 闭合后 `render("```js\nconst a=1\n```")` → `"const a=1"` 正常。
// 影响只有"流式期看不到 js/py 这种语言名"，不值得为它加一套回退逻辑。
//
// 为什么缓冲长度可以很小：实测不确定区域**从一个标记符起、最多 3 个字符**
// （`~~` / `**` / `` ``` ``），所以从这里往前找最近一个未配对的标记起点即可，
// 不需要"扣住最后 N 个字符"那种粗暴做法（那会让正文整体慢半拍）。

/** 会在流式末尾造成"标记裸露"的**行内**语法：按长度从长到短，先匹配长的。
 *
 * ⚠️ 不含 ` ``` ` / `~~~`：围栏是**块级**语法、闭合点是行首+换行，
 * 靠"数配对"判不对（末尾窗口看不到行首那个开始标记），由 `pendingFrom`
 * 单独按行首判定。见那里的实测记录。
 */
var MARKERS = ['**', '__', '~~', '`', '*', '_', '~']

/**
 * 找出「从哪个下标起是暂扣区」。
 *
 * @param {string} text 累计收到的完整文本
 * @returns {number} 暂扣区起点；**-1 表示全文都算定稿**（不用扣）
 *
 * ⚠️ "不用扣"必须用 `-1` 而**不能**用 `0`：标记恰好出现在文本开头时
 * （`"**粗体"` 暂扣区就是 0），若返回 0 调用方会分不清"从第 0 字扣起"
 * 与"什么都不扣"—— 那个歧义会让流式期第一段**一个字都不显示**。
 * 这不是假想：`a **粗体` 那一帧就踩到了（`pendingFrom` 返 0，调用方按"不扣"处理）。
 *
 * 规则（刻意保守）：只找**最后一个未配对的标记**。找到了就把它前面那个
 * **非空白**字符一起扣住（因为 `文字**粗` 里那个 `**` 前若有空格，marked 对
 * `**` 的处理与紧贴文字时不同 —— 宁可多扣几个字符，也不要在两种解释间跳）。
 *
 * 故意**不**处理的（宁可多扣，也不要错扣）：
 *  · 块级结构（标题 `#`、列表 `-`、引用 `>`、表格 `|`）：它们的闭合点是换行，
 *    而流式末尾几乎总是「刚打完字还没换行」，按行切即可，不属于这里的问题。
 *  · 行内链接 `[文字](url)`：`)` 一到就闭合，实测不会跳，所以不缓冲。
 */
function pendingFrom(text) {
  if (!text) return -1
  // ① **围栏先判，且按「行首」判定** —— 不能靠数配对，也不能用 lastIndexOf。
  //
  //    两个实测踩过的坑：
  //    · `"段落\n\n```js\nconst a=1\n```\n"` 里 ``` 出现两次（偶数）本该判已闭合，
  //      但**末尾窗口看不到行首那个开始标记**，数出来是 1 次 → 判成未闭合 →
  //      代码块一直扣着，done 后 pending 不空。
  //    · 用 `lastIndexOf` 找开始标记会**找到闭合那个**，往后找不到配对 →
  //      同样判成未闭合（正确做法是数**行首围栏的总数**，奇数 = 未闭合）。
  //
  //    围栏是**块级**语法、闭合点是行首 + 换行，用行规则判才稳。
  var fence = lastLineFence(text)
  if (fence.start >= 0) {
    if (fence.unclosed) {
      // 没闭合 → 整个围栏（连语言标记）都还在写，扣住行首那三个字符
      return fence.start
    }
    // 已闭合 → 继续看它**后面**有没有未配对的行内标记（下面走②）
  }

  // ② 行内标记：只在最后 16 个字符里数配对。
  //
  //    ⚠️ 起点要落在**最后一个围栏之后**：围栏里的 ``` 是三个反引号，
  //    会被 `` ` `` 这个标记数成 3 次（奇数）→ 判成未闭合 →
  //    done 后还扣着 "``\n"（实测踩过）。所以先把围栏那一整行切掉。
  var tailFrom = 0
  if (fence.start >= 0 && !fence.unclosed) {
    // 闭合围栏：从行首围栏起找到这一行的行尾（围栏整行都是标记，不参与配对）
    var nl = text.indexOf('\n', fence.start)
    tailFrom = nl < 0 ? text.length : nl + 1
  }
  var WINDOW = 16
  var region = text.slice(tailFrom)
  var start = tailFrom + Math.max(0, region.length - WINDOW)
  var tail = text.slice(start)
  for (var m = 0; m < MARKERS.length; m++) {
    var mark = MARKERS[m]
    var idx = tail.lastIndexOf(mark)
    if (idx < 0) continue
    var count = countOccurrences(tail, mark)
    if (count % 2 === 1) {
      var abs = start + idx
      var j = abs - 1
      while (j >= 0 && /\s/.test(text.charAt(j))) j--
      return j >= 0 ? j : abs
    }
  }
  return -1
}

/**
 * 最后一个**行首**围栏的位置，以及它有没有闭合。
 *
 * 判定只看行首（允许缩进）—— 因为 ` ``` ` 出现在行中间时那是行内代码
 * （或普通反引号），不构成块级围栏。
 *
 * @returns {{start: number, unclosed: boolean}} `start` 是最后一个行首围栏的下标；
 *   `unclosed` = 全文的行首围栏数为奇数（还有没闭合的）
 */
function lastLineFence(text) {
  var RE = /(^|\n)([ \t]*)(`{3,}|~{3,})/g
  var m
  var last = -1
  var count = 0
  while ((m = RE.exec(text)) !== null) {
    // 分组 1 是前导换行（可能是空字符串），围栏本体从它之后开始
    var at = m.index + m[1].length
    last = at
    count++
    if (m.index === RE.lastIndex) RE.lastIndex++ // 防零宽死循环
  }
  return { start: last, unclosed: count % 2 === 1 }
}

function countOccurrences(hay, needle) {
  var n = 0
  var i = 0
  for (;;) {
    var k = hay.indexOf(needle, i)
    if (k < 0) break
    n++
    i = k + needle.length
  }
  return n
}

/**
 * 流式渲染：返回「定稿部分」与「暂扣的原文尾巴」。
 *
 * 渲染层（chat 页）只画 `nodes`，暂扣尾巴以纯文本追加在最后 ——
 * 那几个字符本来就是标记符号（`**`），用纯文本显示它们**与最终态一致**，
 * 不会因为"提前显示"而看到错误的内容。
 *
 * @param {string} src 累计收到的文本
 * @param {boolean} [isDark]
 * @returns {{nodes: Array, split: any, pending: string}}
 *   `nodes` 是定稿部分的节点（已过 splitTables 的形状由调用方处理），
 *   `pending` 是该以纯文本追加在末尾的原文尾巴（通常是 ''）
 */
function renderStream(src, isDark) {
  var text = typeof src === 'string' ? src : src == null ? '' : String(src)
  var from = pendingFrom(text)
  // ⚠️ `from >= 0` 不是 `from > 0`：pendingFrom 用 -1 表示"不用扣"，
  // 而 0 是**合法的暂扣起点**（文本以标记开头）。写成 `from > 0` 会把
  // "从第 0 字扣起" 误判成"不扣"，流式期第一段一个字都不显示。
  var settled = from >= 0 ? text.slice(0, from) : text
  var pending = from >= 0 ? text.slice(from) : ''
  // 只解析一次：`render()` 要跑一遍完整 lexer，两次会让流式期的
  // CPU 开销翻倍（实测 1.2ms/帧 → 2.4ms，真机上还要叠加 setData 传输）。
  var nodes = render(settled, isDark)
  return {
    nodes: nodes,
    split: splitTables(nodes),
    pending: pending
  }
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

/**
 * 递归剥掉白名单外的标签（把它的 children 提上来），并把 `text` 归一。
 */
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
  renderStream: renderStream,
  pendingFrom: pendingFrom,
  // 已不再被 chat 页使用（表格留在正文里一次渲染，见 `tableNode` 的注释）。
  // 留着是因为它仍是这层渲染的**备选接法**，改回来时 `check-markdown.mjs` 有判据守着。
  splitTables: splitTables,
  PALETTE: PALETTE,
  ALLOWED: ALLOWED
}