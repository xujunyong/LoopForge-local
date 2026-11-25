// photo.js —— 对应 Go 文件：internal/auth/photo.go
// 作用：SSO 头像服务：英文名校验、规格归一化、带内存缓存的头像拉取。
// Go 的 sync.RWMutex 在单线程 JS 里不需要，已略去；time.Duration 译为毫秒数。
// ClearPhotoCache / FetchPhoto 是 Client 的方法，Go 里定义在本文件，JS 里用 prototype 挂在 Client 上。

"use strict";

const { Client, doRequest } = require("./client.js"); // 对应 Go 同包的 Client 与 httpClient.Do，client.js 已翻译

const ErrPhotoNotFound = new Error("photo not found"); // ErrPhotoNotFound 表示 SSO 头像服务中没有该员工的头像图片。
const ErrInvalidUsername = new Error("invalid username"); // ErrInvalidUsername 表示员工英文名为空或包含非法字符。
const ErrCredentialsNotConfigured = new Error("sso credentials not configured"); // ErrCredentialsNotConfigured 表示 PaaSID 或 AppToken 未配置。

// NormalizePhotoSpec 将任意尺寸归一化为头像服务支持的四种规格之一：48, 100, 150, 500。
// 缺省或 0 值默认归一化为 100。
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

// SanitizeUsername 校验并清理员工英文名，去除扩展名与首尾空白，防止路径穿越。
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

// AvatarURL 返回指定员工英文名与规格的系统头像相对 API 访问路径。
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

class photoCacheEntry {
  constructor(init = {}) {
    this.data = init.data ?? null;
    this.contentType = init.contentType ?? "";
    this.expireAt = init.expireAt ?? null;
  }
}

class photoCache {
  constructor(ttl, maxSize) {
    this.ttl = ttl;
    this.maxSize = maxSize;
    this.entries = new Map();
  }

  get(key) {
    if (this == null) {
      return [null, "", false];
    }
    const entry = this.entries.get(key);
    if (entry === undefined || Date.now() > entry.expireAt.getTime()) {
      return [null, "", false];
    }
    return [entry.data, entry.contentType, true];
  }

  set(key, data, contentType) {
    if (this == null) {
      return;
    }

    // 简单容量清理：如果达到上限，清理已过期的 key
    if (this.entries.size >= this.maxSize) {
      const now = Date.now();
      for (const [k, v] of this.entries) {
        if (now > v.expireAt.getTime()) {
          this.entries.delete(k);
        }
      }
      // 若仍然超限，清空一半
      if (this.entries.size >= this.maxSize) {
        let count = 0;
        for (const k of this.entries.keys()) {
          this.entries.delete(k);
          count++;
          if (count >= Math.floor(this.maxSize / 2)) {
            break;
          }
        }
      }
    }

    this.entries.set(key, new photoCacheEntry({
      data,
      contentType,
      expireAt: new Date(Date.now() + this.ttl),
    }));
  }

  clear() {
    if (this == null) {
      return;
    }
    this.entries = new Map();
  }
}

function newPhotoCache(ttl, maxSize) {
  if (ttl <= 0) {
    ttl = 60 * 60 * 1000;
  }
  if (maxSize <= 0) {
    maxSize = 1000;
  }
  return new photoCache(ttl, maxSize);
}

// ClearPhotoCache 清空内存中的头像图片缓存。
Client.prototype.ClearPhotoCache = function () {
  if (this != null && this.photoCache != null) {
    this.photoCache.clear();
  }
};

// detectContentType：Go 的 http.DetectContentType，这里只按常见图片魔数识别。
function detectContentType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF89a" ||
    data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF87a") {
    return "image/gif";
  }
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "application/octet-stream";
}

// FetchPhoto 请求 SSO 头像服务（GET {PhotoURI}/{spec}/{username}.png）。
// 返回头像二进制字节流、HTTP Content-Type（如 image/png）及可能的错误。
Client.prototype.FetchPhoto = async function (ctx, rawUsername, rawSpec) {
  let username;
  try {
    username = SanitizeUsername(rawUsername);
  } catch (err) {
    throw err;
  }
  const spec = NormalizePhotoSpec(rawSpec);

  const cacheKey = `${spec}:${username}`;
  const [data, ct, ok] = this.photoCache.get(cacheKey);
  if (ok) {
    return [data, ct];
  }

  const photoPath = this.cfg.PhotoURI;
  if (this.cfg.PaaSID === "" || this.cfg.AppToken === "" || this.cfg.AuthHost === "" || photoPath === "") {
    console.log(`[auth] SSO photo service is not configured, cannot fetch photo for ${username}`);
    throw ErrCredentialsNotConfigured;
  }
  const reqURL = `${this.cfg.AuthHost}${photoPath}/${spec}/${encodeURIComponent(username)}.png`;

  const req = this.newSignedGet(ctx, reqURL, "image/png,image/*;q=0.8,*/*;q=0.5");
  let resp;
  try {
    resp = await doRequest(this.httpClient, req);
  } catch (err) {
    throw new Error(`request SSO photo failed: ${err}`);
  }

  if (resp.status === 404) {
    throw ErrPhotoNotFound;
  }
  if (resp.status !== 200) {
    const respBody = Buffer.from(await resp.arrayBuffer()).subarray(0, 1024);
    throw new Error(`unexpected status ${resp.status} from SSO photo: ${respBody.toString("utf8")}`);
  }

  // 限制头像读取大小最大 5MB
  const photoData = Buffer.from(await resp.arrayBuffer()).subarray(0, 5 << 20);
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

  this.photoCache.set(cacheKey, photoData, contentType);
  return [photoData, contentType];
};

module.exports = {
  ErrPhotoNotFound, ErrInvalidUsername, ErrCredentialsNotConfigured,
  NormalizePhotoSpec, SanitizeUsername, AvatarURL, newPhotoCache,
};
