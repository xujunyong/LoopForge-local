// cli_live_config.js —— 对应 Go 文件：internal/runtime/cli_live_config.go
//
// 文件作用与职责边界：
// 提供 CLI 实况联调测试（仅在 Go `clilive` 构建标签下编译）的配置加载、默认执行参数、
// 超时读取、敏感凭证脱敏与长文本截断工具。
//
// Go 与 JS 语法差异说明：
// - Go 的 `time.Duration` 译为毫秒数；`testing.T.Fatal` 译为 `throw new Error(...)`；
// - Go 的 `map[string]liveCLIConfig` 译为普通对象 `{}`；
// - `json.Unmarshal` 按 JSON 标签解码小写键，构造函数同时兼容 Go 字段名与 JSON 键名。

"use strict";

const fs = require("node:fs"); // 对应 Go 标准库 os

const { clipOnRuneBoundary } = require("./runner.js"); // 对应 Go 同包函数

const liveCLIOrder = ["codebuddy", "codex", "claude-code", "opencode", "cursor", "agy", "kimi", "pi", "dsh", "zcode"];

/**
 * 表示单个 CLI 在实况测试配置中的连接与运行参数。
 * 由 loadLiveConfig 解析配置文件后构造。
 */
class liveCLIConfig {
  /**
   * 构造单条 CLI 实况测试配置对象。
   * @param {Object} [init={}] - 初始化字段集合（同时支持 Go 大写字段名与 JSON 小写键名）。
   * @param {string} [init.Key=""] - API 密钥（JSON 键 `key`）。
   * @param {string} [init.BaseURL=""] - API 基础地址（JSON 键 `baseUrl`）。
   * @param {string} [init.Protocol=""] - 协议类型（JSON 键 `protocol`）。
   * @param {string} [init.Model=""] - 模型名称（JSON 键 `model`）。
   * @param {string} [init.Environment=""] - 环境标识（JSON 键 `environment`）。
   */
  constructor(init = {}) {
    this.Key = init.Key ?? init.key ?? "";
    this.BaseURL = init.BaseURL ?? init.baseUrl ?? "";
    this.Protocol = init.Protocol ?? init.protocol ?? "";
    this.Model = init.Model ?? init.model ?? "";
    this.Environment = init.Environment ?? init.environment ?? "";
  }
}

/**
 * 返回指定执行器在实况测试中使用的默认命令行参数列表。
 * 仅对 `codebuddy`、`codex`、`claude-code` 提供固定参数，其余类型返回 null。
 * @param {string} kind - 执行器类型名称。
 * @returns {Array<string>|null} 命令行参数数组；未匹配时返回 null。
 */
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

/**
 * 从环境变量 `CLI_LIVE_TIMEOUT` 读取实况测试超时时长（单位：秒）并转换为毫秒。
 * 未配置、非合法整数或小于等于 0 时回退为默认值 90 秒。
 * @returns {number} 超时时长（毫秒）。
 */
function liveTimeout() {
  // 对应 Go：strconv.Atoi 仅接受完整十进制整数，解析失败返回 0。
  const raw = process.env.CLI_LIVE_TIMEOUT ?? "";
  let seconds = /^[+-]?\d+$/.test(raw) ? parseInt(raw, 10) : 0;
  if (seconds <= 0) {
    seconds = 90;
  }
  return seconds * 1000;
}

/**
 * 从环境变量 `CLI_LIVE_CONFIG` 指定的 JSON 文件加载全部 CLI 实况测试配置。
 * 在实况测试用例启动时调用；缺少环境变量、读取文件失败或 JSON 解析失败时抛出 Error（对应 Go `t.Fatal`）。
 * @param {Object} t - 测试上下文对象（对应 Go `*testing.T`，JS 中保留参数位以对齐签名）。
 * @returns {Object<string, liveCLIConfig>|null} 以 CLI 名称为键的配置映射表；JSON 内容为 null 时返回 null。
 */
function loadLiveConfig(t) {
  // 对应 Go：t.Helper()，JS 无对应调用。
  void t;
  const configPath = process.env.CLI_LIVE_CONFIG ?? "";
  if (configPath === "") {
    throw new Error("CLI_LIVE_CONFIG is required");
  }
  const raw = fs.readFileSync(configPath);
  const parsed = JSON.parse(raw.toString("utf8"));
  if (parsed == null) {
    return null;
  }
  const cfg = {};
  for (const [key, value] of Object.entries(parsed)) {
    cfg[key] = new liveCLIConfig(value ?? {});
  }
  return cfg;
}

/**
 * 对实况测试日志或错误输出中的常见 API Key 前缀（`sk-`、`crsr_`、`ck_`、`AQ.`）进行脱敏替换。
 * 防止测试失败输出意外泄露密钥内容。
 * @param {string} text - 待脱敏的原始文本。
 * @returns {string} 将匹配密钥段替换为 `[redacted]` 后的文本。
 */
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

/**
 * 去除首尾空白并在超过 700 字符时按字符边界截断文本，末尾追加省略号。
 * 用于在实况测试失败日志中控制输出片段长度。
 * @param {string} text - 待截断的原始文本。
 * @returns {string} 清理并按需截断后的文本。
 */
function clipLive(text) {
  text = text.trim();
  // Go 的 len 是字节数，JS 的 length 是 UTF-16 码元数。
  if (text.length > 700) {
    return clipOnRuneBoundary(text, 700) + "…";
  }
  return text;
}

module.exports = { liveCLIOrder, liveCLIConfig, liveExecutorArgs, liveTimeout, loadLiveConfig, redactLive, clipLive };
