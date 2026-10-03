/**
 * env — 运行环境探测。
 *
 * 背景：发布版在手机上出现过 `wx.connectSocket is not a function` ——
 * 运行容器（体验版容器 ≠ 微信正式运行时）不一定实现完整的宿主 API。
 * 直接硬调某个 API，失败只剩一句 TypeError，用户既不知道缺什么，
 * 也不知道下一步该做什么。
 *
 * 这里做两件事：
 *   1. 采集「这个容器到底有什么」，压成一行可复制的诊断文本；
 *   2. 传输层据此选择实现路径，而不是假设某个 API 一定存在。
 *
 * 所有读取都有防御：探测本身绝不允许抛异常。
 */
'use strict'

/**
 * 各平台宿主对象名，按可能性排序（微信 / 支付宝 / 抖音 / QQ / 百度 / 京东）。
 *
 * 这不是「以后也许要支持」——真机上报过缺 API 的容器，而不同厂商的容器
 * 提供的全局对象名确实不同（`my` / `tt` / `qq` / `swan` / `jd`）。
 * 认错了名字就会把「有 WebSocket 能力」误判成「没有」。
 */
var HOST_NAMES = ['wx', 'my', 'tt', 'qq', 'swan', 'jd']

/** 取当前宿主对象；取不到返回 null。 */
function hostApi() {
  for (var i = 0; i < HOST_NAMES.length; i++) {
    var name = HOST_NAMES[i]
    try {
      var candidate = typeof globalThis !== 'undefined' ? globalThis[name] : undefined
      if (!candidate && typeof global !== 'undefined') candidate = global[name]
      if (candidate && typeof candidate === 'object') return { name: name, api: candidate }
    } catch (e) {
      /* 某些容器对 globalThis 取属性会抛错，忽略继续 */
    }
  }
  return null
}

function has(api, name) {
  try {
    return !!api && typeof api[name] === 'function'
  } catch (e) {
    return false
  }
}

/** 原始采集（probe 的缓存包装在外层）。 */
function collect() {
  var host = hostApi()
  var api = host ? host.api : null
  var info = (api && api.getSystemInfoSync && api.getSystemInfoSync()) || {}

  return {
    global: host ? host.name : '(none)',
    sdkVersion: info.SDKVersion || '',
    platform: info.platform || '',
    connectSocket: has(api, 'connectSocket'),
    // 旧式全局回调路径：connectSocket 只负责发起，消息走 onSocketMessage 等全局回调
    legacySocket:
      has(api, 'onSocketOpen') && has(api, 'onSocketMessage') && has(api, 'sendSocketMessage'),
    request: has(api, 'request'),
    storage: has(api, 'getStorageSync') && has(api, 'setStorageSync'),
    scanCode: has(api, 'scanCode'),
  }
}

var cachedProbe = null

/**
 * 能力清单（带缓存：能力不会中途变，没必要每次重连都重探一遍）。
 * @param {boolean} [force] true 强制重新采集。
 */
function probe(force) {
  if (cachedProbe && force !== true) return cachedProbe
  cachedProbe = collect()
  return cachedProbe
}

/** 压成一行：出问题时用户把这行复制回来就能定位。 */
function summary() {
  var p = probe()
  var parts = [
    'GLOBAL=' + p.global,
    'SDK=' + (p.sdkVersion || '?'),
    'PLATFORM=' + (p.platform || '?'),
    'SOCKET=' + (p.connectSocket ? 'yes' : 'NO'),
    'LEGACY=' + (p.legacySocket ? 'yes' : 'no'),
    'REQUEST=' + (p.request ? 'yes' : 'no'),
    'STORAGE=' + (p.storage ? 'yes' : 'no'),
    'SCAN=' + (p.scanCode ? 'yes' : 'no'),
  ]
  return parts.join(' ')
}

/**
 * 传输层不可用时的错误（带能力摘要与 code）。
 * 调用方据此弹完整说明而不是一句 toast。
 */
function unavailableError() {
  var err = new Error(
    '当前运行环境没有 WebSocket 能力（' +
      probe().global +
      '.connectSocket 不存在），无法连接中继。\n诊断：' +
      summary() +
      '\n可用微信开发者工具，或用自己的 AppID 以真机调试方式运行。',
  )
  err.code = 'SOCKET_UNAVAILABLE'
  return err
}

module.exports = {
  hostApi: hostApi,
  probe: probe,
  summary: summary,
  unavailableError: unavailableError,
}
