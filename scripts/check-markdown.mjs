#!/usr/bin/env node
/**
 * markdown 渲染的判据 —— `core/markdown.js`。
 *
 * 为什么单独一个文件、不塞进 e2e：这一层是**纯函数**（Markdown 字符串 → nodes），
 * 不需要中继、主机、真手机。用 `node:test` 直接打它，判据可以写得很细，
 * 失败时也不用先排除掉几百毫秒的网络与状态机噪声。
 *
 * ── 这些判据的形态 ───────────────────────────────────────────────────
 * 全是「结构断言」而不是「字符串包含」：节点结构是 rich-text 的契约，
 * 一旦产出白名单外的标签，那个元素会被小程序**直接丢掉**（内容凭空消失，
 * 界面上看不出原因）—— 这是这里最需要防住的一类错。
 *
 * 每条都做过反证（把被验的那一处改坏，确认它变红），
 * 改法记在每条的注释里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const MP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniprogram')
const md = require(path.join(MP, 'core', 'markdown.js'))

/** 递归收集所有节点名（含 type:'text' 的按 text 节点算，不算标签）。 */
function tagsOf(nodes, out = []) {
  for (const n of nodes || []) {
    if (!n || n.type === 'text') continue
    out.push(n.name)
    tagsOf(n.children, out)
  }
  return out
}

/** 找出第一个符合条件的节点（深度优先）。 */
function find(nodes, pred) {
  for (const n of nodes || []) {
    if (!n || n.type === 'text') continue
    if (pred(n)) return n
    const hit = find(n.children, pred)
    if (hit) return hit
  }
  return null
}

/** 把一个节点的 style 拼成字符串，便于断言「有没有某个声明」。 */
function styleOf(node) {
  return String((node && node.attrs && node.attrs.style) || '')
}

// ── 白名单：这是本文件最要紧的一条 ────────────────────────────────────

test('产出的标签全在 rich-text 白名单内（越界标签会被小程序丢掉，内容凭空消失）', () => {
  // 反证：把 ALLOWED 里的 del 去掉，而 markdown.js 遇到 ~~x~~ 仍会生成 del
  // → 这条立刻红。改法：md.ALLOWED.del = false 不生效（同一对象），实际反证时
  // 是把 delete 的分支去掉再跑，见提交记录。
  const src = [
    '# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n',
    '段落 **b** *i* ~~d~~ `c` [l](https://a.example)\n',
    '- ul\n- ul2\n  - nested\n\n1. ol\n',
    '> quote\n\n```js\ncode\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    '---\n\n![i](https://a.example/x.png)\n\nH~2~O and x^2^\n',
  ].join('\n')
  const tags = tagsOf(md.render(src, false))
  const bad = tags.filter((t) => !md.ALLOWED[t])
  assert.deepEqual(bad, [], `越界标签：${[...new Set(bad)].join(', ')}`)
  // 反过来钉住"覆盖要全"：上面那份样例用到的标签一个都不能少
  for (const need of ['h1', 'h6', 'p', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'table', 'tr', 'th', 'td', 'hr', 'img']) {
    assert.ok(tags.includes(need), `样例里的 ${need} 没渲染出来（实际：${[...new Set(tags)].join(', ')}）`)
  }
})

// ── 结构：每种语法落到哪个标签 ─────────────────────────────────────────

test('标题按层级落成 h1..h6，且都带字号与 margin', () => {
  const nodes = md.render('# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n', false)
  for (let i = 1; i <= 6; i++) {
    const h = find(nodes, (n) => n.name === 'h' + i)
    assert.ok(h, `h${i} 没渲染出来`)
    const s = styleOf(h)
    assert.match(s, /font-size:/, `h${i} 没有字号`)
    assert.match(s, /margin:/, `h${i} 没有 margin —— 相邻标题会挤成一坨`)
    assert.match(s, /color:/, `h${i} 没有 color —— 深色下会用父色`)
  }
})

test('段落拆成多个 p 而不是一个（段落间距靠 margin，不靠空节点）', () => {
  // 反证：把 blockNodes 里 'space' 分支去掉也测不到这条（space 本就不产出节点），
  // 所以改成断"段数"——只有真按段落切分才会有 2 个 p。
  const nodes = md.render('第一段\n\n第二段\n', false)
  const ps = nodes.filter((n) => n.name === 'p')
  assert.equal(ps.length, 2, `应该两个段落块，实际 ${ps.length}`)
  assert.equal(textOf(nodes[0]), '第一段')
  assert.equal(textOf(nodes[1]), '第二段')
})

test('行内代码有底色与等宽字体（深浅色底不同）', () => {
  const light = find(md.render('a `code` b\n', false), (n) => n.name === 'code')
  const dark = find(md.render('a `code` b\n', true), (n) => n.name === 'code')
  assert.match(styleOf(light), /monospace/)
  assert.match(styleOf(light), /background:#/, '行内码没有底色（那就不是药丸而是普通字）')
  const lbg = /background:([^;]*)/.exec(styleOf(light))[1]
  const dbg = /background:([^;]*)/.exec(styleOf(dark))[1]
  assert.notEqual(lbg, dbg, `深色下行内码底色没跟着变（两边都是 ${lbg}）`)
})

test('围栏代码块落成 pre>code，且 pre 的 white-space 由 code 承担', () => {
  // 反证：把 pre 的 pre-wrap 去掉只留 code 的 → 这条仍绿，所以判据要盯住
  // **code**（真正放字的那一层）才有意义，这里明确写死盯 code。
  const nodes = md.render('```js\nconst a = 1;\n```\n', false)
  const pre = find(nodes, (n) => n.name === 'pre')
  assert.ok(pre, '代码块没有 pre')
  const code = find(pre.children, (n) => n.name === 'code')
  assert.ok(code, 'pre 里没有 code —— rich-text 里 pre 的语义来自它')
  assert.match(styleOf(code), /white-space:pre/, '缺 white-space:pre，所有行会连成一行')
  assert.match(styleOf(code), /word-break:/, '长代码行会撑破布局')
  assert.match(styleOf(code), /monospace/)
})

test('未闭合围栏也渲染成代码块（流式期很常见），不抛异常', () => {
  // 反证：这不是"能跑就行"的宽松判据 —— 换成没有 try/catch 的写法时，
  // marked 本身不抛，所以要盯住**产出形态**而不是"没崩"。
  const nodes = md.render('```js\nconst a = 1;\n', false)
  const pre = find(nodes, (n) => n.name === 'pre')
  assert.ok(pre, '未闭合围栏没有落成 pre')
  assert.equal(textOf(pre), 'const a = 1;')
})

test('链接保留 href 与可读样式（不假装能点：rich-text 里 a 点不动）', () => {
  const a = find(md.render('[标题](https://a.example/p?q=1)\n', false), (n) => n.name === 'a')
  assert.ok(a, '链接没渲染')
  assert.equal(a.attrs.href, 'https://a.example/p?q=1')
  assert.match(styleOf(a), /text-decoration:underline/, '链接看不出来就分不清是不是链接')
})

test('列表项的 marker 单独成节点，不混进正文文字里', () => {
  // 反证：把 marker 的 span 去掉、直接把 '• ' 拼进文本 → 这条红。
  const li = find(md.render('- 甲\n- 乙\n', false), (n) => n.name === 'li')
  assert.ok(li, '没有 li')
  const marker = li.children[0]
  assert.equal(marker.name, 'span', 'marker 必须是独立节点（第一条子节点）')
  assert.match(textOf(marker), /•/, `marker 文本不对：${JSON.stringify(textOf(marker))}`)
  // ⚠️ 不能断言 `textOf(li) === '甲'`：`textOf` 是递归全收，会把 marker 的
  // '•' 也数进去（第一版就这么写错的，红了却不是实现的锅）。要盯的是
  // **marker 之后那个兄弟文本节点** —— 那才是"正文"。
  const body = li.children.slice(1)
  assert.ok(body.length > 0, 'marker 之后没有正文节点')
  assert.deepEqual(
    body.map(textOf).join(''),
    '甲',
    'marker 的字混进正文了'
  )
})

test('有序列表 marker 是数字，且按 start 递增', () => {
  const li = find(md.render('3. 甲\n4. 乙\n', false), (n) => n.name === 'li')
  assert.equal(textOf(li.children[0]), '3.', `有序列表 marker 应从 start 开始，实际 ${textOf(li.children[0])}`)
})

test('嵌套列表用 padding 缩进而不是 margin（margin 在 rich-text 里会塌陷）', () => {
  const ul = find(md.render('- 甲\n  - 乙\n', false), (n) => n.name === 'ul')
  assert.match(styleOf(ul), /padding-left:/, '列表缩进必须用 padding —— margin 会塌陷，层级感就没了')
  // ⚠️ `find` 收**数组**（第一版传了单个节点，报 "is not iterable"）。
  // 嵌套那个 ul 在外层 ul 的 children 里，要从 children 找起。
  const nested = find(ul.children || [], (n) => n.name === 'ul')
  assert.ok(nested, '嵌套列表没解析出来')
  assert.match(styleOf(nested), /padding-left:/)
})

test('任务列表 marker 是 ✓/☐ 而不是 •', () => {
  const nodes = md.render('- [x] 做完了\n- [ ] 没做\n', false)
  const texts = []
  const walk = (ns) => (ns || []).forEach((n) => { if (!n) return; if (n.type === 'text') texts.push(n.text); walk(n.children) })
  walk(nodes)
  assert.ok(texts.some((t) => t.includes('✓')), '已完成项缺 ✓')
  assert.ok(texts.some((t) => t.includes('☐')), '未完成项缺 ☐')
  assert.ok(!texts.some((t) => t === '•'), '任务列表不该还带圆点 marker')
})

test('删除线落成 del 且带 line-through', () => {
  const d = find(md.render('~~删掉~~\n', false), (n) => n.name === 'del')
  assert.ok(d, '删除线没渲染')
  assert.match(styleOf(d), /line-through/)
})

test('引用有左边框 + 底色（深色下光靠边框太弱）', () => {
  const light = find(md.render('> 引用\n', false), (n) => n.name === 'blockquote')
  assert.match(styleOf(light), /border-left:/)
  assert.match(styleOf(light), /background:/, '引用没有底色')
  const dark = find(md.render('> 引用\n', true), (n) => n.name === 'blockquote')
  assert.notEqual(
    /background:([^;]*)/.exec(styleOf(light))[1],
    /background:([^;]*)/.exec(styleOf(dark))[1],
    '深色下引用底色没跟着变'
  )
})

// ── 表格：列宽 + 拆出来横滚 ───────────────────────────────────────────

test('表格给 table/table 定宽 = 列数 × COL_W（固定列宽才谈得上横滚）', () => {
  const t = find(md.render('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n', false), (n) => n.name === 'table')
  assert.ok(t, '表格没渲染')
  assert.match(styleOf(t), /width:\s*'?\s*720rpx/, `表格宽度应为 3×240，实际 ${styleOf(t)}`)
  const cells = (t.children[0].children[0].children || []).filter((n) => n.name === 'th')
  assert.equal(cells.length, 3, '表头列数不对')
  for (const c of cells) {
    assert.match(styleOf(c), /word-break:/, '单元格缺 word-break：长内容会把列撑宽，横滚就错位')
  }
})

test('splitTables 把表格摘出来，其余原样（rich-text 内部不能滚动，横滚必须靠外层）', () => {
  // 反证：把 splitTables 改成直接返回（不拆）→ 这条红。
  const nodes = md.render('前面\n\n| A |\n| --- |\n| 1 |\n\n后面\n', false)
  const { parts, tables } = md.splitTables(nodes)
  assert.equal(tables.length, 1, '表格没被摘出来')
  assert.equal(parts.length, 3, `parts 应为 [p, 占位, p]，实际 ${parts.length}`)
  assert.equal(parts[1].__table, 0, '占位符没带上表格下标')
  assert.equal(parts[1].name, undefined, '占位符不该是节点（wxml 靠它识别分支）')
})

test('splitTables 处理多个表格与「没有表格」两种情形', () => {
  const two = md.splitTables(md.render('| A |\n| --- |\n| 1 |\n\n正文\n\n| B |\n| --- |\n| 2 |\n', false))
  assert.equal(two.tables.length, 2, '两个表格没都摘出来')
  assert.deepEqual(
    two.parts.filter((p) => p.__table !== undefined).map((p) => p.__table),
    [0, 1],
    '占位符下标要与 tables 顺序一致'
  )
  const none = md.splitTables(md.render('就一段话\n', false))
  assert.equal(none.tables.length, 0)
  assert.equal(none.parts.length, 1)
})

// ── 深色模式：颜色必须解析成具体色值（本项目真机踩过 var() 不继承）─────

test('深色下正文/行内码/引用色都换了具体值，不是 var(--xxx)', () => {
  // 反证：把 palette() 改成返回 'var(--td-text-color-primary)' 这类值 → 这几条全红。
  for (const isDark of [false, true]) {
    const nodes = md.render('段落 `c`\n\n> 引用\n', isDark)
    const joined = JSON.stringify(nodes)
    assert.ok(!/var\(--/.test(joined), `isDark=${isDark} 的产物里出现了 var(--…)：CSS 自定义属性在 rich-text 里继承不稳，会退化成深色下字色不变`)
  }
  const lightP = find(md.render('段落\n', false), (n) => n.name === 'p')
  const darkP = find(md.render('段落\n', true), (n) => n.name === 'p')
  assert.notEqual(/color:([^;]*)/.exec(styleOf(lightP))[1], /color:([^;]*)/.exec(styleOf(darkP))[1], '深浅色下正文色相同')
})

test('PALETTE 两套色板各自的正文色都过对比度门槛（正文 4.5:1）', () => {
  // 这是 markdown 唯一自己定义颜色的地方 —— wxss 变量表管不到 inline style，
  // 所以对比度必须在这里自证，不能指望 check-mp-contrast（它只扫 wxss）。
  // 反证：把 dark.text 改成 '#181818'（深色下的近黑）→ 这条立刻红。
  for (const [name, p] of Object.entries(md.PALETTE)) {
    for (const key of ['text']) {
      const ratio = contrast(p[key], name === 'dark' ? '#181818' : '#ffffff')
      assert.ok(ratio >= 4.5, `${name}.${key} = ${p[key]} 在页面底色上只有 ${ratio.toFixed(2)}:1（门槛 4.5:1）`)
    }
  }
})

// ── 健壮性：AI 回复不可控，一条畸形输入不能让整条消息空掉 ──────────────

test('畸形与极端输入都不抛异常，且至少产出一个节点', () => {
  const cases = {
    '未闭合围栏': '```js\nconst a=1',
    '未闭合粗体': '**粗',
    '未闭合链接': '[文字](http://a',
    '只有表头': '| A |\n| --- |',
    '深层嵌套列表': '- a\n  - b\n    - c\n      - d\n        - e',
    '超长行': 'x'.repeat(20000),
    '只有符号': '***___```',
    'HTML 注入': '<script>alert(1)</script>',
    // ⚠️ **「纯空白」不在这个表里**，下面那条另测。
    // 这里原本写了它，结果与"空输入返回空数组"那条**自相矛盾**
    //（同一个输入既要求 ≥1 节点又要求 0 节点）——判据自己跟自己打架，
    // 红了不能怪实现。空白就该是 0 节点：真机上"空 text 块"的表现是
    // 回复下面一排只有 padding 的窄条（见 chat.js `_applyText` 的注释）。
  }
  for (const [name, src] of Object.entries(cases)) {
    let out
    assert.doesNotThrow(() => { out = md.render(src, false) }, `${name} 抛异常了`)
    assert.ok(out.length > 0, `${name} 渲染成了 0 个节点 —— 那条消息会在界面上凭空消失`)
    const bad = tagsOf(out).filter((t) => !md.ALLOWED[t])
    assert.deepEqual(bad, [], `${name} 产出了越界标签 ${bad.join(',')}`)
  }
})

test('HTML 标签按纯文本显示而不是被解析（不能变成可执行内容）', () => {
  const out = md.render('<script>alert(1)</script>\n', false)
  const texts = []
  const walk = (ns) => (ns || []).forEach((n) => { if (!n) return; if (n.type === 'text') texts.push(n.text); walk(n.children) })
  walk(out)
  assert.ok(texts.join('').includes('<script>'), `原始标签文字被吃掉了：${JSON.stringify(texts)}`)
  assert.ok(!tagsOf(out).includes('script'), 'script 变成了真节点')
})

test('非字符串输入按纯文本渲染而不是静默变空', () => {
  // 反证：把 render 里 `typeof src === 'string' ? src : ''` 放回去 → 这条红。
  for (const v of [null, undefined, 123, 0, false]) {
    const out = md.render(v, false)
    if (v === null || v === undefined || v === '' ) continue
    assert.ok(out.length > 0, `${JSON.stringify(v)} 渲染成了空 —— 数据源变形时那条消息会凭空消失`)
  }
})

test('空输入返回空数组（不是一段带 padding 的空壳）', () => {
  // 真机上"空 text 块"的表现就是回复下面一排只有 padding 的窄条（见 chat.js 的注释）
  assert.deepEqual(md.render('', false), [])
  assert.deepEqual(md.render('   \n\n  ', false), [])
})

// ── HTML 实体：不能被转义两次 ─────────────────────────────────────────

// ── HTML 实体：marked 不解码，这里必须**恰好**解一次 ────────────────────
//
// ⚠️ 这里的口径容易搞反（第一版我按"marked 已解码"写，红了）：
// `marked.lexer()` **不解码 HTML 实体** —— 解码发生在 renderer 阶段，
// 而本项目只用 lexer、不用 renderer。所以 `&amp;lt;` 原样出来，
// 再由 `rich-text` 的文本节点解码**一次**，页面显示 `&lt;`，
// 这正是 CommonMark 要的行为（`&amp;` 是"作者写的字面量 &"）。
// 因此判据要盯的是「产物里保持原样」，**不是**「已经被解码」。

test('HTML 实体保持原样交给 rich-text 解码一次（不在 JS 侧多解或多转义）', () => {
  // 反证：在 inlineNodes 的 text 分支里再 escape 一次 → 下面几条都红。
  //
  // ⚠️ marked 的实体行为是**混合的**，实测（v18.0.14）：
  //   命名实体（&amp; &lt; &copy; &nbsp;）→ lexer **原样保留**，由 rich-text 解码；
  //   数字实体（&#39; &#x27;）→ marked 当成 escape token **已经解码**成字符。
  // 两者在页面上都对（前者解一次、后者解零次），所以这里照实测行为断言，
  // 别按"统一解码一次"来写 —— 我第一版就是这么写的，红了。
  for (const [src, want] of [
    ['a &amp;lt; b', 'a &amp;lt; b'], // 命名实体：原样（rich-text 解一次 → `&lt;`）
    ['a &lt; b', 'a &lt; b'],
    ['a &copy; b', 'a &copy; b'],
    ["a ' b", "a ' b"], // 数字实体：marked 已解码
    ['a &#39; b', "a ' b"],
    ['a &#x27; b', "a ' b"],
  ]) {
    assert.equal(textOf(md.render(src + '\n', false)), want, `实体处理与实测口径不符：${src}`)
  }
})

test('`&` 不会被显示成 `&amp;` 的字面量', () => {
  // 反证：在 inlineNodes 的 text 分支里再 escape 一次 → 这条红。
  const out = md.render('Tom & Jerry\n', false)
  assert.equal(textOf(out), 'Tom & Jerry')
})

// ── 工具 ──────────────────────────────────────────────────────────────

/** 取一个节点（或节点数组）里的全部文字。
 *
 * 接受数组是有意的：多处断言写 `textOf(md.render(...))` 直接传顶层数组，
 * 而顶层是 `[p, ...]` 而不是某个节点。⚠️ 这就是第一版判据全红的成因 ——
 * **判据红了先怀疑判据**（本项目反复踩的一条）。
 */
function textOf(node) {
  if (node == null) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.type === 'text') return node.text
  const kids = node.children || []
  let s = ''
  for (const k of kids) s += textOf(k)
  return s
}

/** WCAG 相对亮度与对比度（与 scripts/check-mp-contrast.mjs 同一口径）。 */
function contrast(fg, bg) {
  const lum = (hex) => {
    const v = hex.replace('#', '')
    const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16)
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  }
  const a = lum(fg)
  const b = lum(bg)
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  return (hi + 0.05) / (lo + 0.05)
}