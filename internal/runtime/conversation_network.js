// conversation_network.js —— 对应 Go 文件：internal/runtime/conversation_network.go
// 作用：确定工作区可访问的容器网络：取配置或探测本机 IP 后匹配 docker 网络。
// context.Context 译为 AbortSignal；(值, error) 译为返回值、失败 throw；
// Go net.Interfaces/ParseCIDR 译为 os.networkInterfaces 加手动 IPv4 解析。

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os/net
const { spawnSync } = require("node:child_process"); // Go os/exec

// withTimeout：给 ctx 加一个超时，返回 [信号, 取消函数]，对应 Go 的 context.WithTimeout。
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

// parseIPv4：Go net.ParseCIDR 取地址部分的对照，只接受 IPv4。
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

// isGlobalUnicastIPv4：Go IP.IsGlobalUnicast 对 IPv4 的排除项：未指定、回环、链路本地、组播与广播。
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

// 用 docker.sock 的守护进程监听在自己的网络命名空间内。把原生工作区加入
// 同一网络，并通告其可达 IP。
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
      if (result.error != null || result.status !== 0) {
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
      if (idsResult.error == null && idsResult.status === 0) {
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
