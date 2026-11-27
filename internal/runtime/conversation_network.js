/**
 * @file 对应 Go 源文件：internal/runtime/conversation_network.go
 * 职责边界：探测工作区容器访问宿主机/守护进程中继服务所需的主机地址与 Docker 网络名称，
 * 支持通过环境变量显式指定或在容器化环境中基于本机 IP 与 docker inspect 自动匹配。
 * 语法差异说明：
 * - Go 的 context.Context 译为 AbortSignal，context.WithTimeout 译为 withTimeout；
 * - Go 的 (string, string, error) 返回值译为成功返回 [string, string]、失败 throw Error；
 * - Go 的 net.Interfaces / net.ParseCIDR 译为 os.networkInterfaces 与手动 IPv4 解析校验。
 */

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os/net
const { spawnSync } = require("node:child_process"); // Go os/exec

/**
 * 基于父级取消信号构造带超时控制的派生 AbortSignal，对应 Go 的 context.WithTimeout。
 * 使用场景：限制 docker inspect 与 docker ps 命令的执行超时（10 秒）。
 * @param {AbortSignal|null|undefined} ctx 父级取消信号，可为空。
 * @param {number} ms 超时毫秒数。
 * @returns {[AbortSignal, function(): void]} 二元组 [signal, cancel]，分别为派生信号与清理定时器的取消函数。
 */
function withTimeout(ctx, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), ms);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => controller.abort(ctx.reason), { once: true });
    }
  }
  return [controller.signal, () => clearTimeout(timer)];
}

/**
 * 将点分十进制 IPv4 字符串解析为四个 0~255 的字节数值数组，对应 Go 的 net.ParseCIDR 取 IPv4 部分。
 * 使用场景：过滤本机网卡地址时验证地址格式并提取 IPv4 八位组。
 * @param {string} text 待解析的 IP 字符串。
 * @returns {number[]|null} 合法 IPv4 返回长度为 4 的数字数组，非法格式返回 null。
 */
function parseIPv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = [];
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

/**
 * 判断 IPv4 地址是否为全局单播地址（排除未指定、回环、链路本地、组播与广播地址），对应 Go 的 IP.IsGlobalUnicast。
 * 使用场景：筛选可用于容器间通信的本机网卡 IPv4 地址。
 * @param {number[]} octets 长度为 4 的 IPv4 八位组数组。
 * @returns {boolean} 为全局单播 IPv4 返回 true，否则返回 false。
 */
function isGlobalUnicastIPv4(octets) {
  if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224) {
    return false;
  }
  if (octets[0] === 169 && octets[1] === 254) {
    return false;
  }
  if (octets[0] === 255 && octets[1] === 255 && octets[2] === 255 && octets[3] === 255) {
    return false;
  }
  return true;
}

/**
 * 解析工作区容器访问守护进程中继服务所需的主机地址与 Docker 网络名称。
 * 使用场景：使用 docker.sock 的守护进程监听在独立网络命名空间时，需要将原生工作区加入同一网络并通告其可达 IP。
 * @param {AbortSignal|null|undefined} ctx 取消信号。
 * @returns {[string, string]} 二元组 [host, network]：工作区可达的中继主机地址与需加入的 Docker 网络名。
 */
function conversationDockerAccess(ctx) {
  let host = (process.env.AGENTFLOW_CONVERSATION_RELAY_HOST ?? "").trim();
  const network = (process.env.AGENTFLOW_CONVERSATION_DOCKER_NETWORK ?? "").trim();
  if (/[/\\\r\n\x00]/.test(host) || /[\r\n\x00]/.test(network)) {
    throw new Error("invalid conversation network configuration");
  }
  if (host !== "" && network !== "") {
    return [host, network];
  }
  let dockerErr = null;
  let podmanErr = null;
  try {
    fs.statSync("/.dockerenv");
  } catch (err) {
    dockerErr = err;
  }
  try {
    fs.statSync("/run/.containerenv");
  } catch (err) {
    podmanErr = err;
  }
  if (dockerErr !== null && podmanErr !== null && (process.env.KUBERNETES_SERVICE_HOST ?? "") === "") {
    if (host === "") {
      host = "host.docker.internal";
    }
    return [host, network];
  }
  const addresses = {};
  const interfaces = os.networkInterfaces();
  for (const items of Object.values(interfaces)) {
    for (const item of items ?? []) {
      // Node 不暴露接口的 up 标志，列出的接口视为已启用；internal 对应回环。
      if (item.internal) {
        continue;
      }
      const ipText = (item.cidr ?? item.address).split("/")[0];
      const octets = parseIPv4(ipText);
      if (octets !== null && isGlobalUnicastIPv4(octets)) {
        addresses[ipText] = true;
      }
    }
  }
  const [signal, cancel] = withTimeout(ctx, 10 * 1000);
  try {
    const inspect = (ids) => {
      const args = ["inspect", "--format", "{{json .NetworkSettings.Networks}}", ...ids];
      const result = spawnSync("docker", args, { signal });
      if (signal.aborted || result.error != null || result.status !== 0) {
        return ["", ""];
      }
      return matchConversationNetwork((result.stdout ?? Buffer.alloc(0)).toString("utf8"), addresses, network);
    };
    let hostname = "";
    try {
      hostname = os.hostname();
    } catch {
      hostname = "";
    }
    let ip = "";
    let selected = "";
    [ip, selected] = inspect([hostname]);
    if (ip === "") {
      const idsResult = spawnSync("docker", ["ps", "-q"], { signal });
      if (!signal.aborted && idsResult.error == null && idsResult.status === 0) {
        const fields = (idsResult.stdout ?? Buffer.alloc(0)).toString("utf8").split(/\s+/).filter((field) => field !== "");
        if (fields.length > 0) {
          [ip, selected] = inspect(fields);
        }
      }
    }
    if (ip === "") {
      throw new Error("无法确定工作区可访问的容器网络，请设置 AGENTFLOW_CONVERSATION_RELAY_HOST 和 AGENTFLOW_CONVERSATION_DOCKER_NETWORK");
    }
    if (host === "") {
      host = ip;
    }
    return [host, selected];
  } finally {
    cancel();
  }
}

/**
 * 从 `docker inspect` 输出的逐行网络配置 JSON 中，按网络名排序匹配本机拥有的 IP 地址。
 * 使用场景：conversationDockerAccess 在容器环境中识别当前守护进程所在的 Docker 网络及对应 IP。
 * @param {string} data `docker inspect --format '{{json .NetworkSettings.Networks}}'` 的多行输出文本。
 * @param {Object<string, boolean>} addresses 本机全局单播 IPv4 地址集合（键为 IP 字符串，值为 true）。
 * @param {string} requested 显式指定的目标网络名；为空字符串时匹配任意网络。
 * @returns {[string, string]} 匹配到的二元组 [ip, networkName]；未匹配到则返回 ["", ""]。
 */
function matchConversationNetwork(data, addresses, requested) {
  for (const line of data.split("\n")) {
    let networks;
    try {
      networks = JSON.parse(line);
    } catch {
      continue;
    }
    if (networks == null || typeof networks !== "object" || Array.isArray(networks)) {
      continue;
    }
    const names = Object.keys(networks).sort();
    for (const name of names) {
      const ip = (networks[name] ?? {}).IPAddress ?? "";
      if ((requested === "" || requested === name) && addresses[ip]) {
        return [ip, name];
      }
    }
  }
  return ["", ""];
}

module.exports = {
  conversationDockerAccess, matchConversationNetwork,
  withTimeout, parseIPv4, isGlobalUnicastIPv4,
};
