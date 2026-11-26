// cli_live_config.js —— 对应 Go 文件：internal/runtime/cli_live_config.go
// 作用：CLI 实况测试的配置加载、超时、脱敏与截断（仅 clilive 构建标签下编译）。
// Go 的 time.Duration 译为毫秒数；testing.T 的 Fatal 译为 throw。

"use strict";

const fs = require("node:fs"); // Go os

const { clipOnRuneBoundary } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译

const liveCLIOrder = ["codebuddy", "codex", "claude-code", "opencode", "cursor", "agy", "kimi", "pi", "dsh", "zcode"];

class liveCLIConfig {
  constructor(init = {}) {
    this.Key = init.Key ?? "";
    this.BaseURL = init.BaseURL ?? "";
    this.Protocol = init.Protocol ?? "";
    this.Model = init.Model ?? "";
    this.Environment = init.Environment ?? "";
  }
}

function liveExecutorArgs(kind) {
  switch (kind) {
    case "codebuddy":
      return ["-p", "--output-format", "stream-json", "--include-partial-messages", "-y", "--setting-sources", "none"];
    case "codex":
      return ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check"];
    case "claude-code":
      return ["-p", "--output-format", "stream-json", "--permission-mode", "dontAsk"];
    default:
      return null;
  }
}

function liveTimeout() {
  // Go：strconv.Atoi 失败时返回 0。
  let seconds = parseInt(process.env.CLI_LIVE_TIMEOUT ?? "", 10);
  if (Number.isNaN(seconds)) {
    seconds = 0;
  }
  if (seconds <= 0) {
    seconds = 90;
  }
  return seconds * 1000;
}

function loadLiveConfig(t) {
  // Go：t.Helper()，JS 无对应写法。
  const configPath = process.env.CLI_LIVE_CONFIG ?? "";
  if (configPath === "") {
    throw new Error("CLI_LIVE_CONFIG is required");
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath);
  } catch (err) {
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw err;
  }
  if (parsed == null) {
    return null;
  }
  const cfg = {};
  for (const [key, value] of Object.entries(parsed)) {
    cfg[key] = new liveCLIConfig(value ?? {});
  }
  return cfg;
}

function redactLive(text) {
  for (const prefix of ["sk-", "crsr_", "ck_", "AQ."]) {
    for (;;) {
      const i = text.indexOf(prefix);
      if (i < 0) {
        break;
      }
      let end = i + prefix.length;
      while (end < text.length && end < i + prefix.length + 80) {
        const r = text[end];
        if (r === " " || r === "\n" || r === "\t" || r === '"' || r === "'" || r === "," || r === "\\") {
          break;
        }
        end++;
      }
      text = text.slice(0, i) + "[redacted]" + text.slice(end);
    }
  }
  return text;
}

function clipLive(text) {
  text = text.trim();
  // Go 的 len 是字节数，JS 的 length 是 UTF-16 码元数。
  if (text.length > 700) {
    return clipOnRuneBoundary(text, 700) + "…";
  }
  return text;
}

module.exports = { liveCLIOrder, liveCLIConfig, liveExecutorArgs, liveTimeout, loadLiveConfig, redactLive, clipLive };
