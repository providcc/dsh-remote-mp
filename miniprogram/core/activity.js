/**
 * 工具名 → 中文类别（`activity.js`）。
 *
 * 逐字移植自宿主 `app.asar` 里 `@deepseek-ai/dsh-client-ui-chat` 的
 * `activity(name)`（2026-10-06 从 asar 实测抽出，不是猜的）：
 * 宿主步骤组那行中文（"正在读取文件"而不是 "Read"）就是它算出来的。
 * mp 之前直接显示 `{{it.tool}}` 原样英文（`Bash`），与宿主对不上。
 *
 * 未知工具名宿主返回 "tools"（"正在调用工具"）——这里行为一致：
 * 显示错的类别比显示英文更糟，但宿主就是这么定的，跟它保持一致，
 * 原工具名仍留在副标题位（见 chat.js `_applyTool`），信息不丢。
 *
 * 小程序没有 Intl.Segmenter 依赖问题——这里只用纯字符串比较（indexOf/slice，
 * 与本目录其它 core 文件同一口径，不用 startsWith/endsWith）。
 */

var ACTIVITY_ZH = {
  thinking: '正在分析请求',
  read: '正在读取文件',
  readImage: '正在读取图片',
  write: '正在写入文件',
  search: '正在搜索代码',
  edit: '正在编辑文件',
  commands: '正在运行命令',
  code: '正在运行代码',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  subagents: '正在协调子智能体',
  plan: '正在更新计划',
  questions: '等待你的操作',
  tools: '正在调用工具',
}

/**
 * 工具名 → 类别键。宿主原函数逐字移植（含 `_inspect` 后缀与
 * `terminal_` / `subagent_` 前缀两条规则）。
 */
function activity(name) {
  if (name === 'read') return 'read'
  if (name === 'read_image') return 'readImage'
  if (name === 'grep' || name === 'glob' || (name && name.slice(-8) === '_inspect')) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (
    name === 'bash' ||
    name === 'pwsh' ||
    name === 'exec_command' ||
    name === 'write_stdin' ||
    (name && name.indexOf('terminal_') === 0)
  )
    return 'commands'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || (name && name.indexOf('subagent_') === 0)) return 'subagents'
  if (name === 'todo_write' || name === 'create_goal' || name === 'update_goal' || name === 'get_goal')
    return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  return 'tools'
}

/** 工具名 → 直接能显示的中文（类别未知时宿主也显示"正在调用工具"）。 */
function activityLabel(name) {
  return ACTIVITY_ZH[activity(name)] || ACTIVITY_ZH.tools
}

module.exports = {
  ACTIVITY_ZH: ACTIVITY_ZH,
  activity: activity,
  activityLabel: activityLabel,
}
