// clone_url.js —— 对应 Go 文件：internal/domain/clone_url.go
// 作用：剥离仓库 URL 里嵌的凭据，判断 URL 是否带凭据。
// Go 的 net/url 译为全局 WHATWG URL；url.User 的有无以 username/password 是否为空判断。

"use strict";

// StripURLCredentials：去掉仓库 URL 里嵌的凭据。
function StripURLCredentials(raw) {
  const s = raw.trim();
  const i = s.indexOf("://");
  if (i <= 0 || !s.slice(i + 3).includes("@")) {
    return s;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  if (u.username === "" && u.password === "") {
    return s;
  }
  switch (u.protocol.slice(0, -1).toLowerCase()) {
    case "ssh":
    case "git+ssh":
    case "ssh+git":
      if (u.password === "") {
        return s;
      }
      u.password = "";
      break;
    default:
      u.username = "";
      u.password = "";
      break;
  }
  return u.toString();
}

// URLHasCredentials：StripURLCredentials 是否会改动 raw。
function URLHasCredentials(raw) {
  return StripURLCredentials(raw) !== raw.trim();
}

module.exports = { StripURLCredentials, URLHasCredentials };
