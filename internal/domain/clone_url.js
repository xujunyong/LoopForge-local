/**
 * 对应 Go 文件：internal/domain/clone_url.go
 * 作用：剥离仓库克隆 URL 中嵌入的凭据信息，并判断原始 URL 是否包含凭据。
 * 职责边界：仅处理 URL 字符串层面的凭据识别与脱敏，不执行网络请求或仓库克隆。
 * 语法差异说明：Go 的 net/url 对应全局 WHATWG URL；因为 WHATWG URL 无法直接区分
 * “未携带密码（ssh://git@host）”与“携带空密码（ssh://git:@host）”，故同时检查 authority
 * 中 `@` 之前原始 userinfo 是否含 `:`，以对齐 Go 中 `u.User.Password()` 的 hasPassword 语义。
 */

"use strict";

/**
 * 剥离仓库 URL 中嵌入的敏感凭据。
 * 对于 HTTP(S) 和 git:// 协议，userinfo 通常承载访问令牌，直接全部移除；
 * 对于 ssh://、git+ssh://、ssh+git:// 协议，用户名（如 git@）仅标识账号会被保留，仅移除其中的密码部分；
 * scp 风格远程地址（user@host:path）与本地路径无法携带密码，原样返回。
 *
 * @param {string} raw - 原始仓库地址字符串。
 * @returns {string} 去除首尾空白并剥离凭据后的仓库 URL；若无需剥离或解析失败则返回去空白后的原串。
 */
function StripURLCredentials(raw) {
  const s = raw.trim();
  const i = s.indexOf("://");
  if (i <= 0 || !s.slice(i + 3).includes("@")) {
    return s;
  }
  const afterScheme = s.slice(i + 3);
  const authEnd = afterScheme.search(/[/?#]/);
  const authority = authEnd >= 0 ? afterScheme.slice(0, authEnd) : afterScheme;
  const atIdx = authority.lastIndexOf("@");
  if (atIdx < 0) {
    return s;
  }
  const rawUserinfo = authority.slice(0, atIdx);

  let u;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  switch (u.protocol.slice(0, -1).toLowerCase()) {
    case "ssh":
    case "git+ssh":
    case "ssh+git": {
      const hasPassword = rawUserinfo.includes(":");
      if (!hasPassword) {
        return s;
      }
      u.password = "";
      break;
    }
    default:
      u.username = "";
      u.password = "";
      break;
  }
  return u.toString();
}

/**
 * 判断原始仓库 URL 中是否包含会被 StripURLCredentials 剥离的凭据。
 * 常用于入库校验、日志脱敏判断或前端提示。
 *
 * @param {string} raw - 待检测的原始仓库地址字符串。
 * @returns {boolean} 若剥离凭据后的结果与去空白后的原串不同返回 true，否则返回 false。
 */
function URLHasCredentials(raw) {
  return StripURLCredentials(raw) !== raw.trim();
}

module.exports = { StripURLCredentials, URLHasCredentials };
