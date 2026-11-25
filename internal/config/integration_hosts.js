// integration_hosts.js —— 对应 Go 文件：internal/config/integration_hosts.go
// 作用：校验并读取外部集成（共锋 / TAPD）的主机名。
// Go 的 url.Parse / strconv.Atoi 在 JS 里用 URL 构造器与正则检查对应。

"use strict";

const { env } = require("./endpoints.js"); // 同包的 env，见 endpoints.js

const integrationHostname = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function integrationHost(raw) {
  const value = raw.toLowerCase().trim();
  let parsed;
  try {
    parsed = new URL("https://" + value);
  } catch {
    return "";
  }
  if (parsed.host !== value || parsed.username !== "" || parsed.pathname !== "" ||
    !integrationHostname.test(parsed.hostname) || parsed.hostname.includes("..")) {
    return "";
  }
  if (parsed.port !== "") {
    const n = Number.parseInt(parsed.port, 10);
    if (!/^\d+$/.test(parsed.port) || n < 1 || n > 65535) {
      return "";
    }
  } else if (value.includes(":")) {
    return "";
  }
  return parsed.host;
}

// GongfengHost：返回明确配置的托管 Git 主机。
function GongfengHost() {
  return integrationHost(env("AGENTFLOW_GONGFENG_HOST"));
}

function TAPDWebHost() {
  const host = integrationHost(env("AGENTFLOW_TAPD_HOST"));
  if (host !== "") {
    return host;
  }
  return "www.tapd.cn";
}

module.exports = { GongfengHost, TAPDWebHost };
