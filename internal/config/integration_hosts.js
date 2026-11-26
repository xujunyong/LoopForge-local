// integration_hosts.js —— 对应 Go 文件：internal/config/integration_hosts.go
// 作用与职责边界：严格校验并读取外部集成平台（工蜂 Git、TAPD）的主机名配置，
// 防止环境变量中混入路径、认证信息、非法端口或非法域名片段。
// 语法差异说明：JS 的 WHATWG URL 会把空路径规范为 "/" 且会剥离 https 默认端口 ":443"，
// 因此在校验时显式兼容这些差异，使行为与 Go 的 net/url.Parse 等价。

"use strict";

const { env } = require("./endpoints.js"); // 同包环境变量读取函数，见 endpoints.js

/** 合法外部集成主机名的正则约束（首尾为小写字母或数字，中间允许点与连字符）。 */
const integrationHostname = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * 校验并规整外部集成主机地址（允许可选端口号，拒绝协议路径、查询串、锚点、用户信息及非法端口）。
 * 使用场景：GongfengHost 与 TAPDWebHost 读取环境变量后进行安全校验时内部调用。
 * @param {string} raw - 原始主机配置字符串（如 "git.example.com" 或 "git.example.com:8443"）。
 * @returns {string} 校验通过返回小写规范主机（含合法端口），不合法返回空字符串 ""。
 */
function integrationHost(raw) {
  const value = raw.toLowerCase().trim();
  if (value === "" || value.includes("/") || value.includes("?") || value.includes("#") || value.includes("@")) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL("https://" + value);
  } catch {
    return "";
  }
  // WHATWG URL 对 https 默认端口 443 会省略 parsed.port 和 parsed.host 中的 ":443"，这里还原以便与 Go url.Parse 等价比对。
  const parsedPort = parsed.port !== "" ? parsed.port : (value === parsed.hostname + ":443" ? "443" : "");
  const parsedHost = parsedPort !== "" ? parsed.hostname + ":" + parsedPort : parsed.host;
  if (parsedHost !== value || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" ||
    !integrationHostname.test(parsed.hostname) || parsed.hostname.includes("..")) {
    return "";
  }
  if (parsedPort !== "") {
    const n = Number.parseInt(parsedPort, 10);
    if (!/^\d+$/.test(parsedPort) || n < 1 || n > 65535) {
      return "";
    }
  } else if (value.includes(":")) {
    return "";
  }
  return parsedHost;
}

/**
 * 返回环境变量 AGENTFLOW_GONGFENG_HOST 中显式配置的托管 Git（工蜂）主机名。
 * 使用场景：工蜂 OAuth、仓库识别及凭证匹配需要确定托管 Git 域名时调用。
 * @returns {string} 合法的工蜂主机名（可含端口）；未配置或配置非法时返回空字符串 ""。
 */
function GongfengHost() {
  return integrationHost(env("AGENTFLOW_GONGFENG_HOST"));
}

/**
 * 返回 TAPD Web 主机名；若未配置或配置非法，则回退到默认主机 "www.tapd.cn"。
 * 使用场景：解析或构造 TAPD 需求链接时调用。
 * @returns {string} 有效的 TAPD Web 主机名（默认 "www.tapd.cn"）。
 */
function TAPDWebHost() {
  const host = integrationHost(env("AGENTFLOW_TAPD_HOST"));
  if (host !== "") {
    return host;
  }
  return "www.tapd.cn";
}

module.exports = { GongfengHost, TAPDWebHost };
