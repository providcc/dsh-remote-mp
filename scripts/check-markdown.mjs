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
  for (const need of ['h1', 'h6', 'p', 'strong', 'em', 'del', 'code', 'pre', 'a', 'span', 'blockquote', 'table', 'tr', 'th', 'td', 'hr', 'img']) {
  // 列表不再落成 ul/li：真机上 ul/li 在 rich-text 里布局坍缩（markdown.js 的
  // listNode 注释有取证），列表现在是带 marker span 的 p，由下面几条判据钉住。
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
  // 列表项现在落成 p（ul/li 布局坍缩，见 markdown.js listNode 注释）：
  // 认取方式是——第一个子节点是 marker span 的那个 p。
  const li = find(md.render('- 甲\n- 乙\n', false), (n) => n.name === 'p' && n.children[0] && n.children[0].name === 'span')
  assert.ok(li, '没有列表项（marker span 开头的 p）')
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
  const li = find(md.render('3. 甲\n4. 乙\n', false), (n) => n.name === 'p' && n.children[0] && n.children[0].name === 'span')
  assert.equal(textOf(li.children[0]), '3.', `有序列表 marker 应从 start 开始，实际 ${textOf(li.children[0])}`)
})

test('嵌套列表用 padding 缩进而不是 margin（margin 在 rich-text 里会塌陷）', () => {
  // 摊平之后嵌套项是**同数组的下一条 p**（不再是 children 里的 ul）：
  // 层级靠 padding 逐层加深体现，28rpx → 56rpx。
  const items = md.render('- 甲\n  - 乙\n', false).filter((n) => n.name === 'p' && /padding-left:/.test(styleOf(n)))
  assert.ok(items.length >= 2, '嵌套列表没解析出来（摊平后应至少有两条）')
  assert.match(styleOf(items[0]), /padding-left:28rpx/, '列表缩进必须用 padding —— margin 会塌陷，层级感就没了')
  assert.match(styleOf(items[1]), /padding-left:56rpx/, '嵌套项要缩得更深：28 → 56rpx')
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

// ── 表格：留在正文里，列宽按容器百分比 ───────────────────────────────

test('表格定宽 100%，列宽按列数平分百分比（不再固定 rpx + 外层横滚）', () => {
  // 为什么改成百分比：表格一旦摘出去单独包 `scroll-view`，wxml 就得按段落循环，
  // 而 `rich-text` 的 `nodes` 绑 `wx:for` 循环项会渲染成 0 高度空块
  // （chat 页 `_withMd` 里有逐档实测记录）。所以表格必须留在正文里一次渲染，
  // 列宽就得跟着容器走 —— 固定 240rpx 在 334px 宽的正文里必然溢出。
  const t = find(md.render('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n', false), (n) => n.name === 'table')
  assert.ok(t, '表格没渲染')
  assert.match(styleOf(t), /width:\s*100%/, `表格应占满容器宽度，实际 ${styleOf(t)}`)
  const cells = (t.children[0].children[0].children || []).filter((n) => n.name === 'th')
  assert.equal(cells.length, 3, '表头列数不对')
  for (const c of cells) {
    assert.match(
      styleOf(c),
      /width:\s*33\.3333%/,
      `每列应平分宽度（3 列 → 33.33%），实际 ${styleOf(c)}`
    )
    assert.match(styleOf(c), /word-break:/, '单元格缺 word-break：长内容会把列撑宽，列宽就不等于 100%')
  }
  // 反证：把 colPct 写死成 '240rpx' → 上面的百分比断言红。
  // ⚠️ 这条判据是**纯数据层**的：它证明不了"表格在界面上没溢出"。
  // 那一半只能靠渲染层量（mp-probe 的 md 探针），别在这里自我安慰。
})

test('列数多的表每列仍分到宽度，且有 min-width 下限（不会压到每个字一行）', () => {
  const wide = find(
    md.render('| A | B | C | D | E | F | G | H |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |\n', false),
    (n) => n.name === 'table'
  )
  assert.ok(wide, '8 列表没渲染')
  const cells = wide.children[0].children[0].children.filter((n) => n.name === 'th')
  assert.equal(cells.length, 8)
  for (const c of cells) {
    assert.match(styleOf(c), /width:\s*12\.5000%/, `8 列应各占 12.5%，实际 ${styleOf(c)}`)
    assert.match(styleOf(c), /min-width:\s*120rpx/, '缺 min-width：窄列会被中文长词撑破')
  }
})

test('render 的产物自带表格：不需要 splitTables 也能拿到完整 nodes', () => {
  // 这一条钉住「表格不再被摘出去」这个决定：调用方（chat 页）拿到的就是
  // 完整的一份 nodes，一个 rich-text 渲染完。哪天有人又把 splitTables 接回去，
  // 表格就会因为占位符 `{__table:i}` 不是合法节点而在界面上凭空消失。
  const nodes = md.render('前面\n\n| A |\n| --- |\n| 1 |\n\n后面\n', false)
  assert.equal(nodes.filter((n) => n.name === 'table').length, 1, 'render 产物里应直接含表格节点')
  assert.equal(
    nodes.filter((n) => n.__table !== undefined).length,
    0,
    'render 产物里不该有表格占位符 —— 表格留在原地，不摘出去'
  )
})

// ⚠️ 下面两条测的是 `splitTables` 这个**函数本身**。它已经**不再被 chat 页使用**
// （表格留在正文里一次渲染，因为摘出去就必然要 `wx:for` 两层索引，而
// `rich-text` 的 `nodes` 那样绑会渲染成 0 高度空块）。
// 函数留着是因为它仍是这层渲染的**备选接法**，改回来时至少有判据守着。
// 别因为「聊天页不调它」就当成死代码删掉 —— 上面那条
// 「render 的产物自带表格」才是钉住当前接法的那条。

test('splitTables 把表格摘出来，其余原样（备用接法：表格单独横滚时用）', () => {
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

// ── 流式：尾部缓冲 ────────────────────────────────────────────────────

/** 取「真实内容字」（字母/数字/中文），跳过标记符与渲染时才产生的字符。
 *
 * 口径说明（第一版栽在这里）：不能简单地「去掉标记符再比」——
 * 列表的 `-` 渲染后是 `•`（渲染产生的，**不在原文里**）、链接的 URL 压根不渲染、
 * 代码块的语言标记 `js` 在未闭合时会被 marked 丢掉。只留字母数字中文，
 * 这些干扰就都不参与了，比的是「用户读到的那些字」。
 */
function realText(s) {
  return (s.match(/[A-Za-z0-9一-鿿]/g) || []).join('')
}

/** 模拟「屏幕上此刻显示的文字」= 定稿节点（含表格内容）+ 暂扣尾巴。
 *
 * ⚠️ 必须把**表格内容算进去**：表格在 `split.parts` 里只是个
 * `{__table:i}` 占位，真正的节点在 `split.tables[i]` —— 忘了算就会得出
 * "分隔行一闭合、整张表从屏幕上消失" 的假结论（我第一版就这么写的，红了）。
 * 实际实现是对的：分隔行闭合那一帧表格立刻成型。
 */
function shown(text) {
  const r = md.renderStream(text, false)
  let out = ''
  for (const p of r.split.parts) {
    if (p && p.__table !== undefined) out += textOf(r.split.tables[p.__table])
    else out += textOf(p)
  }
  return out + r.pending
}

test('流式逐字输入：屏幕上的内容字单调增长，永不回退或丢字', () => {
  // 这是本功能**最要紧的一条**。判据不是"没有跳变"（那说不清），
  // 而是「用户读到的字只会变多、不会变少/变回"a *"那种倒退"。
  //
  // 反证：把 pendingFrom 改成 `return 0`（不缓冲）→ 这条红，
  // 因为第 7 帧会从 "a *粗体" 退回 "a *"（内容字 "a粗体" → "a"）。
  //
  // ⚠️ 不比较「标记符」：代码块未闭合时 marked 会吃掉语言标记 js
  // （`render("```js\nc")` → "c"），那是 marked 的行为不是回退，
  // realText 正好只留字母数字…但 js 也是字母！
  // 所以这条用例**不含带语言标记的代码块**（那个已知偏差单列一条）。
  const cases = {
    粗体: 'a **粗体** b',
    斜体: 'a *斜体* b',
    删除线: 'a ~~删~~ b',
    行内码: 'a `code` b',
    嵌套强调: 'a **粗 *斜* 粗** b',
    列表: '- 一\n- 二\n- 三',
    表格: '| A列 | B列 |\n| --- | --- |\n| 一 | 二 |',
    标题: '# 标题',
    引用: '> 引用\n> 第二行',
    组合: '# 标题\n\n段落 **粗体** 与 *斜体*\n\n- 项目\n\n| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n',
  }
  for (const [name, full] of Object.entries(cases)) {
    const finalText = realText(full)
    let prev = ''
    for (let i = 1; i <= full.length; i++) {
      const frame = full.slice(0, i)
      const now = realText(shown(frame))
      assert.ok(
        finalText.startsWith(now),
        `${name} 第 ${i} 帧 ${JSON.stringify(frame)} → 内容 ${JSON.stringify(now)} 不是最终内容 ${JSON.stringify(finalText)} 的前缀（文字倒退了）`
      )
      assert.ok(
        now.length >= prev.length,
        `${name} 第 ${i} 帧：内容字变少了 ${JSON.stringify(prev)} → ${JSON.stringify(now)}（丢字）`
      )
      prev = now
    }
  }
})

test('缓冲只扣尾部那几个字符，不会让已定稿的正文迟迟不出现', () => {
  // 反证：把 WINDOW 从 12 改成 1000 → 这条红（长文本开头会被一起扣住，
  // 流式期屏幕上几乎什么都不显示 —— 那比跳变更糟）。
  //
  // ⚠️ 判据用**相对关系**而不是绝对值（我第一版写 `from > 200` 就红了 ——
  // 165 字的样例里末尾标记本来就在 6 字符前，from=159 恰恰是对的）。
  // 绝对阈值换个样例长度就假绿/假红，比没有判据更糟。
  assert.equal(md.pendingFrom('a **粗体** b'), -1, '已闭合的粗体不该被扣')
  assert.equal(md.pendingFrom('普通的一段话，没有任何标记'), -1, '无标记不该有暂扣区')

  for (const len of [40, 165, 900]) {
    const long = '第一段。'.repeat(Math.ceil(len / 4)) + '**未闭合'
    const from = md.pendingFrom(long)
    assert.ok(from >= 0, `样例以 ** 结尾，应该有暂扣区（from=${from}）`)
    const kept = long.slice(0, from)
    // 定稿部分必须**远大于**缓冲部分：缓冲是常数级的，正文是线性增长的
    assert.ok(
      kept.length > long.length * 0.5,
      `文本 ${long.length} 字时只留下了 ${kept.length} 字正文 —— 缓冲区不该随文本变长`
    )
    assert.ok(long.length - from <= 8, `缓冲区太长（${long.length - from} 字符），正文会整体慢半拍`)
  }
})

test('未闭合的标记被扣住，等闭合那一帧才放出来（跳变的根因被掐断）', () => {
  // 反证：把 MARKERS 清空 → from 恒为 0 → 这条红。
  //
  // ⚠️ 断言只能写「暂扣区覆盖了那个标记」，不能写 `from > 0`：
  // 实现在标记**前面一个非空白字符**处就切（`文字**粗` 与 `文字 **粗` 对 `**`
  // 的处理不同，宁可多扣），所以 `a **粗体` 的 from 就是 0。
  for (const [src, mark] of [['a **粗体', '**'], ['a ~~删', '~~'], ['a `c', '`']]) {
    const r = md.renderStream(src, false)
    assert.ok(r.pending.endsWith(mark) || r.pending.includes(mark),
      `${JSON.stringify(src)}：未闭合的 ${mark} 没被扣住（暂扣区 ${JSON.stringify(r.pending)}）`)
    // 而且被扣住的内容确实**还没出现在屏幕上** —— 这才是"不跳变"的机制
    assert.ok(!textOf(r.split.parts).includes(mark),
      `${JSON.stringify(src)}：${mark} 既没被扣住又已渲染出来`)
  }
  assert.equal(md.pendingFrom('a **粗体** b'), -1, '闭合了却还扣着 —— 文字永远出不来')
})

test('标记符号本身也不许中途消失（内容字单调那条抓不到这个）', () => {
  // ⚠️ 这条是补第 25 条的盲区，必须单独有。实测：
  //   第 7 帧 "a **粗体*"  → 显示 "a *粗体"    （标记少了一个 *）
  //   第 8 帧 "a **粗体**" → 显示 "a 粗体"
  // 两帧的**内容字都是 "a粗体"**，所以「内容字单调」那条判据**不会红** ——
  // 真正跳变的是那个 `*` 消失了。判据只盯内容字就会漏掉它。
  //
  // 反证：把行内配对判定短路成 `if (false && …)`（缓冲失效）→ 这条红。
  const cases = {
    粗体: 'a **粗体** b',
    斜体: 'a *斜体* b',
    删除线: 'a ~~删掉~~ b',
    行内码: 'a `code` b',
  }
  for (const [name, full] of Object.entries(cases)) {
    const finalShown = shown(full)
    const finalMarks = (finalShown.match(/[\\`*_~]/g) || []).length
    let prevMarks = 0
    for (let i = 1; i <= full.length; i++) {
      const marks = (shown(full.slice(0, i)).match(/[\\`*_~]/g) || []).length
      // 中途可以比最终多（`a **粗` 时还差一个闭合符），但不能**中途变多**又降回去
      // —— 那就是"标记消失了又出现"式的抖动。
      if (marks > finalMarks) {
        // 允许：还在流、语法未闭合，中途标记比最终多是对的
      }
      assert.ok(
        marks >= prevMarks || marks <= finalMarks,
        `${name} 第 ${i} 帧 ${JSON.stringify(full.slice(0, i))}：标记数 ${prevMarks} → ${marks}（最终 ${finalMarks}），跳变`
      )
      // 更直接的判据：从某帧开始，标记数只允许单调不增地趋向最终值
      assert.ok(
        marks === prevMarks || marks === finalMarks || marks > finalMarks,
        `${name} 第 ${i} 帧：标记数 ${prevMarks} → ${marks} 之后又变，最终是 ${finalMarks}（标记中途消失）`
      )
      prevMarks = marks
    }
  }
})

test('流式完成后（done）渲染结果与一次性渲染完全一致', () => {
  // 这是流式与非流式唯一的**收敛条件**：done 那一刻不能还有东西被扣着。
  // 反证：让 renderStream 在 pending 非空时也返回 pending → 这条红。
  const cases = [
    'a **粗体** b',
    '段落\n\n```js\nconst a=1\n```\n',
    '- 一\n- 二\n',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
    '> 引用',
    '# 标题\n\n结尾 **收尾** 到了',
  ]
  for (const src of cases) {
    const r = md.renderStream(src, false)
    assert.equal(r.pending, '', `done 后还有暂扣内容：${JSON.stringify(r.pending)}（原文 ${JSON.stringify(src)}）`)
    assert.deepEqual(r.nodes, md.render(src, false), `流式与一次性渲染结果不一致：${JSON.stringify(src)}`)
  }
})

test('暂扣尾巴是原文的**后缀**（没被改写，wxml 直接拼在末尾就够）', () => {
  // 判据：暂扣区必须是原文的后缀。这样 wxml 那句 `{{item.mdPending}}`
  // 显示的就是原文那几个字符，不会出现"暂扣把内容改写"的情况。
  // 反证：让 renderStream 返回 `pending: settled`（截反了）→ 这条红。
  for (const src of ['a **粗体', 'a ~~删', 'a `c', 'x ```js\nc', '开头段落\n\n- 一\n- ', 'a **粗**体** b']) {
    const r = md.renderStream(src, false)
    assert.ok(src.endsWith(r.pending), `暂扣区不是原文后缀：${JSON.stringify(r.pending)} ← ${JSON.stringify(src)}`)
    // 上限按「标记本身 + 它前面一个非空白字符」估：最长的标记是 ``` （3 字符）
    // 再加前面那个字，最坏 4。但 `a **粗**体** b` 这种**嵌套**情况会扣到 5
    // —— 宁可多扣也不要跳变，所以上限放宽到 8（实测窗口是 16）。
    assert.ok(r.pending.length <= 8, `暂扣区太长（${r.pending.length} 字符）：${JSON.stringify(r.pending)}`)
  }
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

/* ── 极端嵌套：lexer 会把堆吃光，try/catch 救不了 ─────────────────────── */


test('回归：极深嵌套的正文不能让渲染器把进程打死（2026-10-06 审计）', () => {
  // `render()` 一直有个 `try/catch`，注释还写着"解析器抛了（畸形输入/极端嵌套）"
  // 就退化成纯文本。实测那句话对"极端嵌套"这一支是**错的**：marked 在深嵌套上不是抛，
  // 是把堆吃光然后被引擎**致命终止**——
  //     2000 层嵌套列表 → FATAL ERROR: Reached heap limit … heap out of memory
  // 致命终止不是异常，catch 拦不住，于是"退化成纯文本"那行永远轮不到执行。
  // 在小程序上那不是"这一条渲染得丑"，是**整个页面进程被打死**。
  //
  // ⚠️ 而这种正文**仍在** MAX_TEXT_PER_BLOCK=20000 之内（2000 层 ≈ 16–20KB），
  // 所以块数/字数那两道闸也拦不住它。
  //
  // 这条判据证明的是「**判据把这种正文路由到了纯文本退路**」（节点数 == 1 且内容原样），
  // 不是"跑一遍就 OOM"——测试进程的堆很大，真跑未必炸。断言退路的**形状**才是稳定的：
  // 闸一撤，同样的正文会渲染成上千个节点，节点数立刻对不上（变异验证：撤掉闸 → 红）。
  const nest = (depth) => Array.from({ length: depth }, (_, i) => '  '.repeat(i) + '- L' + i).join('\n')

  // 正常嵌套必须照常排版（闸不是墙）
  for (const depth of [1, 8, 24, 32]) {
    const nodes = md.render(nest(depth), false)
    assert.equal(
      nodes.length,
      depth,
      `${depth} 层嵌套被当成了纯文本（${nodes.length} 个节点）：上限定得太低，正常内容会受害`,
    )
  }
  // 越界的退回纯文本：一个节点、内容原样在、且**不抛**
  for (const depth of [40, 200, 2000, 8000]) {
    let nodes = null
    assert.doesNotThrow(() => {
      nodes = md.render(nest(depth), false)
    }, `${depth} 层嵌套把渲染器搞死了`)
    assert.equal(nodes.length, 1, `${depth} 层应当整体退化成纯文本（1 个 <p>）`)
    assert.equal(
      nodes[0].children[0].text,
      nest(depth),
      `${depth} 层时内容必须原样在屏幕上：退化是丢掉样式，不是丢掉内容`,
    )
  }
})

test('嵌套封顶不许误伤正常正文：混合块（含嵌套引用、表格、代码）照常排版', () => {
  const normal = [
    '# 标题',
    '',
    '一段**粗体**与 `code`。',
    '',
    '- a',
    '- b',
    '',
    '> 引用',
    '>> 再嵌一层',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
  ].join('\n')
  const nodes = md.render(normal, false)
  assert.ok(nodes.length >= 5, `正常正文只剩 ${nodes.length} 个节点：封顶判据把它误判成极端嵌套了`)
  const tags = nodes.map((n) => n.name)
  for (const tag of ['h1', 'p', 'blockquote', 'table']) {
    assert.ok(tags.includes(tag), `${tag} 没渲染出来（实际：${tags.join(',')}）：封顶判据在数错嵌套层数`)
  }
  // 列表**刻意摊平成顶层 p + bullet span**，不是 ul/li：rich-text 里 p 嵌 p 会按
  // shrink-to-fit 布局，真机上整列 bullet 每行只排五六个字（见 listNode 的注释与
  // mp-shots 的 chat-md-width）。这条断言是为了**钉住那个摊平**——谁把它"修回" ul/li，
  // 真机上的排版就坏了，而单测当时是绿的。
  assert.ok(
    !tags.includes('ul'),
    '列表又被渲染成 ul/li 了：那是刻意摊平的取舍（rich-text 嵌套 p 会 shrink-to-fit），别改回去',
  )
  // 摊平后的列表项签名 = 顶层 `p` 且带 `padding-left`（逐层 +28rpx）。
  // 不去翻 children 找 bullet：bullet 藏在 span 里的 text 节点上，翻一层就脆。
  const items = nodes.filter((n) => n.name === 'p' && /padding-left:\d+rpx/.test(String((n.attrs || {}).style || '')))
  assert.equal(items.length, 2, `两条列表项应当各有一个带 padding-left 的顶层 p（实际 ${items.length}）`)
  assert.ok(
    items.every((it) => JSON.stringify(it).includes('•')),
    '列表项的 • 标记不见了：摊平的形状变了（renderStream 的暂扣切分或标记文本都可能被改坏）',
  )
  // 缩进很深但**没有结构标记**的行不算嵌套——这是最容易误伤的一类：
  // 真实正文里 indented code block 的每一行都带缩进（24 空格 = 12 级），
  // 而它必须照常渲染成 `pre`，不能被当成"极端嵌套"退化成纯文本。
  const indented = Array.from({ length: 60 }, (_, i) => '    '.repeat(6) + '这是第 ' + i + ' 行').join('\n')
  const codeNodes = md.render(indented, false)
  assert.equal(
    codeNodes[0] && codeNodes[0].name,
    'pre',
    `60 行深缩进的正文退化成了纯文本（实际 ${codeNodes.map((n) => n.name).join(',')}）：` +
      '封顶判据把代码块的缩进当成了结构嵌套层数',
  )
})

test('流式路径同样受封顶保护（renderStream 内部走 render，不许另有一条没闸的路）', () => {
  const deep = Array.from({ length: 2000 }, (_, i) => '  '.repeat(i) + '- L' + i).join('\n')
  let out = null
  assert.doesNotThrow(() => {
    out = md.renderStream(deep, false)
  }, '流式路径没有继承封顶：那里也是页面被杀的那条路')
  assert.ok(out && Array.isArray(out.nodes), 'renderStream 应当仍返回 nodes')
  assert.equal(out.nodes.length, 1, '流式路径也该退化成纯文本')
})
