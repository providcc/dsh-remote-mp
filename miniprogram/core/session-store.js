/**
 * session-store — 小程序客户端的持久化。
 *
 * 除配对 PSK 外都不是秘密；PSK 只存在下面的配对记录里（微信存储按
 * app+设备沙箱隔离）。丢了它的代价只是「重新扫码」——主机每次配对都会换 PSK。
 */
'use strict'

var codec = require('./codec.js')

var KEY_PAIRING = 'drc.pairing.v1'
var KEY_INSTALL = 'drc.installId'
var KEY_SERVER = 'drc.serverUrl'

function read(key, fallback) {
  try {
    var v = wx.getStorageSync(key)
    return v === '' || v === undefined || v === null ? fallback : v
  } catch (e) {
    return fallback
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (e) {
    return false
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(key)
  } catch (e) {
    /* ignore */
  }
}

/**
 * 稳定的按安装 id。nonce 前缀里有它：存储被清空（计数器归零）时
 * installId 也会重新生成，同一 key 下 nonce 绝不复用。
 */
function installId() {
  var id = read(KEY_INSTALL, '')
  if (!id) {
    id = codec.randomId()
    write(KEY_INSTALL, id)
  }
  return id
}

/**
 * @typedef {Object} Pairing
 * @property {string} server    中继 ws(s):// 地址
 * @property {string} psk       base64 16B 预共享密钥（来自二维码）
 * @property {string} convId    中继分配的会话 id
 * @property {string} hostId
 * @property {string} hostLabel
 * @property {number} nonceCounter
 * @property {number} pairedAt
 */

/**
 * 上一次 `loadPairing()` 丢掉坏记录的原因（`''` = 没丢过）。
 *
 * 为什么要有它：`hydrate()` 必须把「这台机器没配过对」与「配过、但存储里的记录坏了」
 * 分开说 —— 后者要清掉并要求重新扫码，前者是正常的首启。只返回 null 的话两种
 * 情况长得一模一样，用户看到的是"什么都没有"，而真相是"你那把钥匙坏了"。
 */
var lastLoadError = ''

/** @returns {Pairing|null} 形状不对（含 psk 不是 base64 16 字节）就当没有配对，并就地清掉。 */
function loadPairing() {
  lastLoadError = ''
  var p = read(KEY_PAIRING, null)
  if (!p || typeof p !== 'object') return null
  if (!p.server || !p.psk || !p.convId) return null
  // 坏记录**不能留**：留着的话每次启动都会再读一次、再派生出一次异常。
  // psk 的校验尤其重要：非 base64 会让 js-base64 抛 InvalidCharacterError，
  // 而 hydrate() 是 App.onLaunch 调的 —— 那就是"小程序启动即失败、无提示、无法自愈"。
  if (!codec.isValidPairingServer(p.server)) return dropCorrupt('server')
  if (!codec.isValidPsk(p.psk)) return dropCorrupt('psk')
  if (typeof p.convId !== 'string' || !p.convId) return dropCorrupt('convId')
  return p
}

function dropCorrupt(why) {
  lastLoadError = why
  clearPairing()
  return null
}

/** 上一次 loadPairing 丢掉坏记录的原因（'' = 没有）。 */
function loadPairingError() {
  return lastLoadError
}

function savePairing(pairing) {
  return write(KEY_PAIRING, pairing)
}

function clearPairing() {
  remove(KEY_PAIRING)
}

/**
 * 会话内单调递增的 nonce（持久化：app 重启不能在同一 key 下重复 nonce）。
 */
function nextNonceFor(pairing) {
  var c = Number(pairing.nonceCounter || 0) + 1
  pairing.nonceCounter = c
  savePairing(pairing)
  var prefix = codec.noncePrefix(pairing.psk, pairing.convId, installId())
  return codec.buildNonce(prefix, c)
}

function serverUrl() {
  return read(KEY_SERVER, '')
}

function setServerUrl(u) {
  return write(KEY_SERVER, u)
}

module.exports = {
  installId: installId,
  loadPairing: loadPairing,
  loadPairingError: loadPairingError,
  savePairing: savePairing,
  clearPairing: clearPairing,
  nextNonceFor: nextNonceFor,
  serverUrl: serverUrl,
  setServerUrl: setServerUrl,
}
