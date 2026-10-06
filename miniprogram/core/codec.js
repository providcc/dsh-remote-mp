/**
 * codec — DSH Remote Control 线格式编解码（小程序侧）。
 *
 * 与 Node 侧 @dsh-rc/protocol/src/crypto.ts 必须逐字节一致：
 *   sealed record = base64( nonce(24) || nacl.secretbox(utf8(JSON), nonce, key) )
 *   conv key      = SHA-512( 'dsh-rc/v1' ␟ dir ␟ convId ␟ psk )[0..32]   (␟ = 0x1f)
 *
 * 不造轮子：
 *   - 加密原语用 vendored tweetnacl（vendor/nacl-fast.js，打过小程序补丁：
 *     移除了 require('crypto') 的 PRNG 探测，升级 tweetnacl 时要重新打）；
 *   - UTF-8 / base64 用 vendored js-base64（vendor/js-base64.js，MIT），
 *     纯 JS、不依赖 Buffer / TextEncoder —— 小程序里这两者都不可靠。
 *
 * 小程序没有可用 CSPRNG，所以 seal() 强制要求调用方传入显式 nonce
 * （计数器 nonce 是安全的：key 已绑定 配对×方向×会话，nonce 绝不重复）。
 */
'use strict'

var nacl = require('./vendor/nacl-fast.js')
var Base64 = require('./vendor/js-base64.js')

var KDF_NAMESPACE = 'dsh-rc/v1'
var NONCE_NAMESPACE = 'dsh-rc/v1/nonce'
var UNIT_SEPARATOR = 0x1f

/** PSK 的字节数：与 @dsh-rc/protocol 的 `PSK_BYTES` 是同一个数（B5）。 */
var PSK_BYTES = 16

// ── string <-> bytes (UTF-8) ────────────────────────────────────────
/** string -> Uint8Array(UTF-8)。与 TextEncoder 对合法输入的输出一致。 */
function stringToBytes(str) {
  var bin = Base64.utob(String(str))
  var out = new Uint8Array(bin.length)
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff
  return out
}

/** Uint8Array(UTF-8) -> string。与 TextDecoder(fatal=false) 对合法输入的输出一致。 */
function bytesToString(bytes) {
  // 分段拼接，避免超长文本一次拼出一个巨大中间串
  var bin = ''
  var CHUNK = 0x8000
  for (var i = 0; i < bytes.length; i += CHUNK) {
    var end = Math.min(i + CHUNK, bytes.length)
    for (var j = i; j < end; j++) bin += String.fromCharCode(bytes[j])
  }
  return Base64.btou(bin)
}

// ── bytes <-> base64 ────────────────────────────────────────────────
/** Uint8Array -> 标准 base64（与 Buffer.toString('base64') 一致）。 */
function bytesToBase64(bytes) {
  return Base64.fromUint8Array(bytes)
}

/** 标准 base64 -> Uint8Array。容忍空白字符；非法输入抛异常。 */
function base64ToBytes(str) {
  return Base64.toUint8Array(String(str).replace(/[\r\n\s]/g, ''))
}

// ── 配对入口的形状校验 ──────────────────────────────────────────────
/**
 * 标准 base64 的**文本形状**（不长度、不解码）。
 *
 * 为什么要有它：`js-base64` 对含非法字符/长度不对的串会抛 `InvalidCharacterError`，
 * 而那条路发生在**配对成功之后**（derivePskKey）—— 用户已经"扫上了"却收到一句英文异常。
 * 这个判据让非 base64 的密钥在最外面就被拒。
 */
function looksLikeBase64(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}

/**
 * 配对密钥（PSK）：base64 且解出来**正好 16 字节**。
 *
 * 16 这个数与 Node 侧 `derivePskKey` 的校验同一个口径（那里不对就抛）。
 * 小程序这份 codec 的 derivePskKey 刻意不抛（它还要当 e2e 的 oracle 喂各种边界向量），
 * 所以"长度必须对"这条纪律落在**配对入口**（client.connect / session-store.loadPairing）。
 */
function isValidPsk(pskB64) {
  if (!looksLikeBase64(pskB64)) return false
  try {
    return base64ToBytes(pskB64).length === PSK_BYTES
  } catch (e) {
    return false
  }
}

/** 中继地址：只认 ws:// 与 wss://（http(s) 连不上，越早说清越好）。 */
function isValidPairingServer(url) {
  return typeof url === 'string' && /^wss?:\/\//.test(url)
}

/** 6 位配对码（归一化**之后**的形状）。 */
function isValidPairingToken(token) {
  return /^\d{6}$/.test(String(token == null ? '' : token))
}

// ── KDF ─────────────────────────────────────────────────────────────
/** SHA-512(part ␟ part ␟ …)[0..32] —— 每个部分之后都补一个单元分隔符。 */
function kdfHash(parts) {
  var total = 0
  var encoded = []
  for (var i = 0; i < parts.length; i++) {
    var b = typeof parts[i] === 'string' ? stringToBytes(parts[i]) : parts[i]
    encoded.push(b)
    total += b.length + 1
  }
  var joined = new Uint8Array(total)
  var p = 0
  for (var k = 0; k < encoded.length; k++) {
    joined.set(encoded[k], p)
    p += encoded[k].length
    joined[p++] = UNIT_SEPARATOR
  }
  return nacl.hash(joined).slice(0, 32)
}

/** 按方向派生会话密钥：PSK + 会话 id。 */
function derivePskKey(pskB64, direction, conversationId) {
  return kdfHash([KDF_NAMESPACE, direction, conversationId, base64ToBytes(pskB64)])
}

// ── seal / open ─────────────────────────────────────────────────────
/**
 * @param {Uint8Array} key     32 字节会话密钥
 * @param {*} payload          可 JSON 序列化的对象
 * @param {Uint8Array} nonce   24 字节，小程序侧必须显式传入（无 CSPRNG）
 * @returns {{ciphertext: string}} base64(nonce || box)
 */
function seal(key, payload, nonce) {
  if (!nonce || nonce.length !== 24) {
    throw new Error('seal() 在小程序侧必须传入显式 24 字节 nonce')
  }
  var msg = stringToBytes(JSON.stringify(payload))
  var box = nacl.secretbox(msg, nonce, key)
  var merged = new Uint8Array(24 + box.length)
  merged.set(nonce, 0)
  merged.set(box, 24)
  return { ciphertext: bytesToBase64(merged) }
}

/** @returns {*|null} 解密出的 JSON，或任何失败都返回 null（不向外抛错）。 */
function open(key, record) {
  try {
    var merged = base64ToBytes(record.ciphertext)
    if (merged.length < 24 + 16) return null
    var nonce = merged.slice(0, 24)
    var box = merged.slice(24)
    var msg = nacl.secretbox.open(box, nonce, key)
    if (!msg) return null
    return JSON.parse(bytesToString(msg))
  } catch (e) {
    return null
  }
}

// ── 计数器 nonce ────────────────────────────────────────────────────
/**
 * (安装, 配对, 会话) 三元组的稳定 16 字节前缀；后 8 字节是大端计数器，
 * 由调用方持久化。唯一性：key 已绑定 psk+会话+方向；计数器按 installId
 * 单调递增——存储被清空时 installId 也会变，nonce 因此绝不复用。
 */
function noncePrefix(pskB64, conversationId, installId) {
  return kdfHash([NONCE_NAMESPACE, installId, conversationId, base64ToBytes(pskB64)]).slice(0, 16)
}

/** prefix(16) + counter(8, big-endian) -> 24 字节 nonce。 */
function buildNonce(prefix16, counter) {
  var n = new Uint8Array(24)
  n.set(prefix16, 0)
  var hi = Math.floor(counter / 0x100000000)
  var lo = counter >>> 0
  n[16] = (hi >>> 24) & 0xff
  n[17] = (hi >>> 16) & 0xff
  n[18] = (hi >>> 8) & 0xff
  n[19] = hi & 0xff
  n[20] = (lo >>> 24) & 0xff
  n[21] = (lo >>> 16) & 0xff
  n[22] = (lo >>> 8) & 0xff
  n[23] = lo & 0xff
  return n
}

// ── 配对二维码 ──────────────────────────────────────────────────────
/**
 * 解析 `dshr:/p?v=1&s=<ws url>&n=<label>&psk=<base64 16B>[&t=<6 位码>]`。
 * 与 Node 侧 parser 语义一致：'+' 先按 URLSearchParams 当作空格解码；
 * 若解出的 psk 含空格（生产方直接输出了未编码的 base64 '+'），保留 '+'
 * 重试一次，兼容手写 / 第三方二维码。
 *
 * **只拒非法输入，不改合法输入的解析结果**（这条被 e2e/protocol.test.mjs 与
 * Node 侧解析器逐字段对拍）。这里拒的两类：
 *   · `s` 不是 ws:// / wss://  —— http(s) 的地址根本连不上，放过去只会让用户
 *     在"正在连接"里白等一轮（错误文案还指不到根因）；
 *   · `psk` 不是 base64 文本 —— 放到 derivePskKey 里就是一句英文异常。
 * `psk` 的 **16 字节**长度校验不在这里：解析器要对拍 Node 侧那份更宽松的语义，
 * 严格口径统一在真正的配对入口（见 client.connect 的校验）。
 */
function parsePairingQr(text) {
  try {
    var s = String(text || '')
    if (s.indexOf('dshr:') !== 0) return null
    var q = s.indexOf('?')
    if (q < 0) return null
    var params = parseQuery(s.slice(q + 1), true)
    var psk = params.psk
    var server = params.s
    if (!psk || !server) return null
    if (psk.indexOf(' ') >= 0) {
      var retry = parseQuery(s.slice(q + 1), false)
      if (retry.psk && retry.psk.indexOf(' ') < 0) {
        psk = retry.psk
        if (!server || server.indexOf(' ') >= 0) server = retry.s || server
      }
    }
    if (!isValidPairingServer(server)) return null
    if (!looksLikeBase64(psk)) return null
    // t 可选：主机把配对码也放进二维码时，客户端可以扫码即连。
    // 形状不对的 t 只是**不采用**，不因此否掉整张二维码（老二维码里这一项可能被别的
    // 工具改坏，而地址与密钥都是好的，没有理由让用户重新扫码）。
    var token = params.t && isValidPairingToken(params.t) ? params.t : ''
    return { v: 1, server: server, hostLabel: params.n || 'dsh', psk: psk, token: token }
  } catch (e) {
    return null
  }
}

/**
 * 二维码为什么不能用来配对的**中文一句话**（能用的时候给）。
 *
 * `''` = 没看出问题（`parsePairingQr` 会给结果，或这串本来就不是配对二维码）。
 * 页面用它把两种失败分开：「这不是 DSH 的二维码」与「是 DSH 的二维码、但里面
 * 某一项不合法」——下一步动作不一样（换一张 vs 让主机重新生成），
 * 用同一句"无法识别"等于把用户支错方向。
 *
 * 判据与 `parsePairingQr` 的拒绝条件一一对应，绝不出现"解析成功但这里说有问题"。
 */
function pairingQrError(text) {
  var s = String(text == null ? '' : text)
  if (s.indexOf('dshr:') !== 0) return ''
  var q = s.indexOf('?')
  if (q < 0) return '配对二维码不完整：问号后面没有参数'
  var params = parseQuery(s.slice(q + 1), true)
  var psk = params.psk
  var server = params.s
  if (psk && psk.indexOf(' ') >= 0) {
    var retry = parseQuery(s.slice(q + 1), false)
    if (retry.psk && retry.psk.indexOf(' ') < 0) {
      psk = retry.psk
      if (!server || server.indexOf(' ') >= 0) server = retry.s || server
    }
  }
  if (!server) return '配对二维码里没有中继地址（s=）'
  if (!isValidPairingServer(server)) return '配对二维码里的中继地址不是 ws:// 或 wss://'
  if (!psk) return '配对二维码里没有配对密钥（psk=）'
  if (!looksLikeBase64(psk)) return '配对二维码里的配对密钥不是合法的 base64'
  return ''
}

function parseQuery(qs, plusAsSpace) {
  var out = {}
  var parts = String(qs).split('&')
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    var eq = parts[i].indexOf('=')
    var k = eq < 0 ? parts[i] : parts[i].slice(0, eq)
    var v = eq < 0 ? '' : parts[i].slice(eq + 1)
    out[decodeQ(k, plusAsSpace)] = decodeQ(v, plusAsSpace)
  }
  return out
}

function decodeQ(v, plusAsSpace) {
  var s = String(v)
  if (plusAsSpace) s = s.replace(/\+/g, ' ')
  try {
    return decodeURIComponent(s)
  } catch (e) {
    return s
  }
}

/**
 * 6 位配对码是手输的：归一化掉空格与连字符。
 *
 * **只归一化、不校验**：这个函数的输入输出被 e2e/protocol.test.mjs 与 Node 侧
 * 逐字对拍（`a1b2c3` 原样返回是契约的一部分）。"必须是 6 位数字"的校验在
 * 使用它的配对入口（client.connect），那里才说得出中文原因。
 */
function normalizePairingToken(raw) {
  return String(raw || '').replace(/[\s-]/g, '')
}

/** 控制面用的弱随机 id（clientId）。不是秘密。 */
function randomId() {
  return (
    Date.now().toString(36) +
    '-' +
    Math.floor(Math.random() * 0xffffffff).toString(36) +
    Math.floor(Math.random() * 0xffffffff).toString(36)
  )
}

module.exports = {
  // vendored nacl 直接暴露：e2e/protocol.test.mjs 拿它和 npm tweetnacl、node:crypto
  // 做三方对拍（小程序那份必须与另两侧逐字节相同）。小程序自身不直接调它。
  nacl: nacl,
  stringToBytes: stringToBytes,
  bytesToString: bytesToString,
  bytesToBase64: bytesToBase64,
  base64ToBytes: base64ToBytes,
  kdfHash: kdfHash,
  derivePskKey: derivePskKey,
  seal: seal,
  open: open,
  noncePrefix: noncePrefix,
  buildNonce: buildNonce,
  looksLikeBase64: looksLikeBase64,
  isValidPsk: isValidPsk,
  isValidPairingServer: isValidPairingServer,
  isValidPairingToken: isValidPairingToken,
  parsePairingQr: parsePairingQr,
  pairingQrError: pairingQrError,
  normalizePairingToken: normalizePairingToken,
  randomId: randomId,
}
