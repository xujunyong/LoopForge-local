/**
 * @file internal/auth/photo.js
 * @description 对应 Go 文件：internal/auth/photo.go
 * 职责与边界：实现企业 SSO 员工头像拉取相关能力，包括头像尺寸规格归一化、员工英文名安全清洗（防路径穿越）、
 * 头像相对 API 路径构造、带 TTL 与容量上限的内存缓存，以及挂载在 `Client` 上的远程头像拉取与缓存清理方法。
 * 语法差异说明：
 * - Go 的 `sync.RWMutex` 在单线程 JS 中无需加锁，已直接略去。
 * - Go 的 `map[string]photoCacheEntry` 译为普通对象 `{}`；`time.Duration` 译为毫秒数；`time.Time` 译为 `Date`。
 * - Go 的 `Client` 跨文件方法 `ClearPhotoCache`、`FetchPhoto` 统一挂载至 `Client.prototype`。
 * - Go 的 `([]byte, string, error)` 译为成功返回二元组 `[Buffer, string]`、失败 `throw Error`；因调用 `fetch`，`FetchPhoto` 为 `async` 方法。
 */

"use strict";

const { Client, doRequest } = require("./client.js"); // 对应 Go 同包的 Client 与 httpClient.Do

// ErrPhotoNotFound 表示 SSO 头像服务中没有该员工的头像图片。
const ErrPhotoNotFound = new Error("photo not found");
// ErrInvalidUsername 表示员工英文名为空或包含非法字符。
const ErrInvalidUsername = new Error("invalid username");
// ErrCredentialsNotConfigured 表示 PaaSID 或 AppToken 未配置。
const ErrCredentialsNotConfigured = new Error("sso credentials not configured");

/**
 * 将任意头像尺寸归一化为企业头像服务支持的四种标准规格之一：48、100、150、500。
 * 缺省或非正数默认归一化为 100；在生成头像地址和拉取上游头像前调用。
 * @param {number} spec - 期望的头像尺寸像素值。
 * @returns {number} 归一化后的标准规格值（48、100、150 或 500）。
 */
function NormalizePhotoSpec(spec) {
  if (spec <= 0) {
    return 100;
  } else if (spec <= 74) {
    return 48;
  } else if (spec <= 125) {
    return 100;
  } else if (spec <= 300) {
    return 150;
  }
  return 500;
}

/**
 * 校验并清理员工英文名：去除首尾空白及末尾常见的 `.png`/`.jpg`/`.jpeg` 扩展名，
 * 并拒绝路径穿越字符或 `[a-zA-Z0-9_.-]` 之外的非法字符。
 * 在构造头像 URL 及向 SSO 请求头像图片前调用。
 * @param {string} raw - 原始员工英文名（可能带有空白或图片扩展名）。
 * @returns {string} 校验通过后的纯净员工英文名；为空或包含非法字符时抛出 `ErrInvalidUsername`。
 */
function SanitizeUsername(raw) {
  let name = raw.trim();
  if (name === "") {
    throw ErrInvalidUsername;
  }

  // 去除可能携带的 .png / .jpg / .jpeg 扩展名
  const lower = name.toLowerCase();
  for (const ext of [".png", ".jpg", ".jpeg"]) {
    if (lower.endsWith(ext)) {
      name = name.slice(0, name.length - ext.length);
      break;
    }
  }
  name = name.trim();
  if (name === "" || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw ErrInvalidUsername;
  }

  for (const r of name) {
    const code = r.codePointAt(0);
    if (!((code >= 97 && code <= 122) || (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) || r === "_" || r === "-" || r === ".")) {
      throw ErrInvalidUsername;
    }
  }

  return name;
}

/**
 * 返回指定员工英文名与尺寸规格对应的系统头像相对 API 访问路径。
 * 在用户信息接口填充 `AvatarURL` 字段时调用。
 * @param {string} username - 员工英文名。
 * @param {number} spec - 期望头像尺寸像素值。
 * @returns {string} 形如 `/api/auth/photo/<规格>/<英文名>.png` 的相对路径；英文名非法时返回空字符串 `""`。
 */
function AvatarURL(username, spec) {
  let cleanName;
  try {
    cleanName = SanitizeUsername(username);
  } catch {
    return "";
  }
  const normSpec = NormalizePhotoSpec(spec);
  return `/api/auth/photo/${normSpec}/${encodeURIComponent(cleanName)}.png`;
}

/**
 * 表示内存头像缓存中的单条缓存记录。
 */
class photoCacheEntry {
  /**
   * 构造头像缓存条目实例，未提供的字段按 Go 零值初始化。
   * 在 `photoCache.prototype.set` 写入新缓存条目时调用。
   * @param {Object} [init={}] - 可选初始字段对象（含 `data`、`contentType`、`expireAt`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.data = init.data ?? null;
    this.contentType = init.contentType ?? "";
    this.expireAt = init.expireAt ?? null;
  }
}

/**
 * 带过期时间（TTL）与最大条目数上限的内存头像缓存容器。
 */
class photoCache {
  /**
   * 构造内存头像缓存实例，未提供的字段按 Go 零值初始化。
   * 由 `newPhotoCache` 内部调用创建。
   * @param {Object} [init={}] - 可选初始字段对象（含 `ttl` 毫秒数、`maxSize` 最大条数、`entries` 键值映射对象）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ttl = init.ttl ?? 0;
    this.maxSize = init.maxSize ?? 0;
    this.entries = init.entries ?? {};
  }

  /**
   * 按缓存键查询未过期的头像数据与内容类型。
   * 在 `Client.prototype.FetchPhoto` 发起远程请求前检查缓存命中时调用。
   * @param {string} key - 缓存键（格式为 `<规格>:<英文名>`）。
   * @returns {[Buffer|null, string, boolean]} 三元组 `[图片二进制数据, Content-Type, 是否命中]`；未命中或已过期时返回 `[null, "", false]`。
   */
  get(key) {
    if (this == null) {
      return [null, "", false];
    }
    if (!Object.prototype.hasOwnProperty.call(this.entries, key)) {
      return [null, "", false];
    }
    const entry = this.entries[key];
    if (Date.now() > entry.expireAt.getTime()) {
      return [null, "", false];
    }
    return [entry.data, entry.contentType, true];
  }

  /**
   * 写入或覆盖一条头像缓存记录；当缓存条目达到上限时先清理过期项，若仍超限则淘汰一半现有条目。
   * 在 `Client.prototype.FetchPhoto` 成功从上游拉取头像后调用。
   * @param {string} key - 缓存键（格式为 `<规格>:<英文名>`）。
   * @param {Buffer} data - 头像二进制图片数据。
   * @param {string} contentType - 图片对应的 HTTP `Content-Type`（如 `"image/png"`）。
   * @returns {void} 无返回值。
   */
  set(key, data, contentType) {
    if (this == null) {
      return;
    }

    // 简单容量清理：如果达到上限，清理已过期的 key
    if (Object.keys(this.entries).length >= this.maxSize) {
      const now = Date.now();
      for (const [k, v] of Object.entries(this.entries)) {
        if (now > v.expireAt.getTime()) {
          delete this.entries[k];
        }
      }
      // 若仍然超限，清空一半
      const remainingKeys = Object.keys(this.entries);
      if (remainingKeys.length >= this.maxSize) {
        let count = 0;
        for (const k of remainingKeys) {
          delete this.entries[k];
          count++;
          if (count >= Math.floor(this.maxSize / 2)) {
            break;
          }
        }
      }
    }

    this.entries[key] = new photoCacheEntry({
      data,
      contentType,
      expireAt: new Date(Date.now() + this.ttl),
    });
  }

  /**
   * 清空缓存容器内的全部头像条目。
   * 由 `Client.prototype.ClearPhotoCache` 内部调用。
   * @returns {void} 无返回值。
   */
  clear() {
    if (this == null) {
      return;
    }
    this.entries = {};
  }
}

/**
 * 创建内存头像缓存实例，并在参数非正数时应用默认 TTL（1 小时）与默认容量上限（1000 条）。
 * 在 `client.js` 的 `NewClient` 初始化客户端时调用。
 * @param {number} ttl - 缓存条目存活时长（毫秒）；小于等于 0 时默认为 1 小时（`3600000`）。
 * @param {number} maxSize - 最大缓存条目数量；小于等于 0 时默认为 `1000`。
 * @returns {photoCache} 初始化完成的内存头像缓存实例。
 */
function newPhotoCache(ttl, maxSize) {
  if (ttl <= 0) {
    ttl = 60 * 60 * 1000;
  }
  if (maxSize <= 0) {
    maxSize = 1000;
  }
  return new photoCache({
    ttl,
    maxSize,
    entries: {},
  });
}

/**
 * 清空当前认证客户端内存中的全部头像图片缓存。
 * 在需要强制刷新员工头像或测试重置缓存状态时调用。
 * @returns {void} 无返回值。
 */
Client.prototype.ClearPhotoCache = function () {
  if (this != null && this.photoCache != null) {
    this.photoCache.clear();
  }
};

/**
 * 根据二进制文件头魔数嗅探常见图片格式的 MIME 类型，对应 Go 的 `http.DetectContentType`。
 * 在上游响应未返回有效图片 `Content-Type` 时用于兜底识别图片类型。
 * @param {Buffer} data - 图片文件的原始二进制字节流。
 * @returns {string} 识别出的 MIME 类型（`image/png`、`image/jpeg`、`image/gif`、`image/webp` 或 `application/octet-stream`）。
 */
function detectContentType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if ((data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF89a") ||
    (data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF87a")) {
    return "image/gif";
  }
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "application/octet-stream";
}

/**
 * 请求企业 SSO 头像服务（`GET {PhotoURI}/{spec}/{username}.png`）获取员工头像二进制数据与内容类型。
 * 优先命中内存缓存，未命中时发起带 RIO 签名的上游请求（最大读取 5MB）并将结果写入缓存。
 * 在后端头像代理 HTTP 接口响应前端头像加载请求时调用。
 * @param {AbortSignal|null} ctx - 可选的请求取消信号，对应 Go 的 `context.Context`。
 * @param {string} rawUsername - 原始员工英文名。
 * @param {number} rawSpec - 请求的头像尺寸规格像素值。
 * @returns {Promise<[Buffer, string]>} 异步返回二元组 `[头像二进制字节流, HTTP Content-Type]`；校验失败、未配置凭据、未找到头像或上游异常时抛出错误。
 */
Client.prototype.FetchPhoto = async function (ctx, rawUsername, rawSpec) {
  const username = SanitizeUsername(rawUsername);
  const spec = NormalizePhotoSpec(rawSpec);

  const cacheKey = `${spec}:${username}`;
  if (this.photoCache != null) {
    const [data, ct, ok] = this.photoCache.get(cacheKey);
    if (ok) {
      return [data, ct];
    }
  }

  const photoPath = this.cfg.PhotoURI;
  if (this.cfg.PaaSID === "" || this.cfg.AppToken === "" || this.cfg.AuthHost === "" || photoPath === "") {
    console.log(`[auth] SSO photo service is not configured, cannot fetch photo for ${username}`);
    throw ErrCredentialsNotConfigured;
  }
  const reqURL = `${this.cfg.AuthHost}${photoPath}/${spec}/${encodeURIComponent(username)}.png`;

  let req;
  try {
    req = this.newSignedGet(ctx, reqURL, "image/png,image/*;q=0.8,*/*;q=0.5");
  } catch (err) {
    throw new Error(`create photo request failed: ${err}`, { cause: err });
  }

  let resp;
  try {
    resp = await doRequest(this.httpClient, req);
  } catch (err) {
    throw new Error(`request SSO photo failed: ${err}`, { cause: err });
  }

  if (resp.status === 404) {
    throw ErrPhotoNotFound;
  }
  if (resp.status !== 200) {
    let respBody = Buffer.alloc(0);
    try {
      respBody = Buffer.from(await resp.arrayBuffer()).subarray(0, 1024);
    } catch {
      // 对应 Go 忽略错误读取前 1024 字节用于错误日志：respBody, _ := io.ReadAll(...)
    }
    throw new Error(`unexpected status ${resp.status} from SSO photo: ${respBody.toString("utf8")}`);
  }

  // 限制头像读取大小最大 5MB
  let photoData;
  try {
    photoData = Buffer.from(await resp.arrayBuffer()).subarray(0, 5 << 20);
  } catch (err) {
    throw new Error(`read photo response body failed: ${err}`, { cause: err });
  }
  if (photoData.length === 0) {
    throw ErrPhotoNotFound;
  }

  let contentType = resp.headers.get("Content-Type") ?? "";
  if (contentType === "" || contentType.includes("text/") || contentType.includes("application/json")) {
    contentType = detectContentType(photoData);
  }
  if (!contentType.startsWith("image/")) {
    contentType = "image/png";
  }

  if (this.photoCache != null) {
    this.photoCache.set(cacheKey, photoData, contentType);
  }
  return [photoData, contentType];
};

module.exports = {
  ErrPhotoNotFound, ErrInvalidUsername, ErrCredentialsNotConfigured,
  NormalizePhotoSpec, SanitizeUsername, AvatarURL, newPhotoCache,
};
