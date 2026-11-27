/**
 * @file 对应 Go 源文件：internal/runtime/conversation_assets.go
 * 职责边界：校验会话目录安全性、列出并移除原生安装器遗留的技能符号链接，以及判定会话内资产目录与文件归属。
 * 语法差异说明：
 * - Go 的 (值, error) 与 error 返回值译为成功返回值（无返回值则为 undefined）、失败 throw Error；
 * - Go 的 errors.Is(err, fs.ErrNotExist) 译为 err.code === "ENOENT"；
 * - Go 的 filepath.WalkDir 无直接 JS 等价物，使用递归 fs.readdirSync 按字典序遍历模拟；
 * - Go 的 (allowed, rewrite bool) 多返回值译为 [boolean, boolean] 元组。
 */

"use strict";

const fs = require("node:fs"); // Go os/io/fs
const path = require("node:path"); // Go path/filepath

const { conversationGuardFiles } = require("./conversation_sandbox.js"); // 对应 Go 同包变量，conversation_sandbox.js 待翻译

/**
 * 描述会话准备阶段的错误，隐藏宿主绝对路径以防泄露环境信息。
 * 使用场景：校验会话目录或移除技能符号链接失败时抛出。
 */
class ConversationStateError extends Error {
  /**
   * 构造会话状态错误对象。
   * @param {string} [message=""] 对外展示的脱敏错误说明。
   * @param {Error|null} [cause=null] 原始底层错误对象。
   */
  constructor(message = "", cause = null) {
    super(message);
    this.Message = message;
    this.cause = cause;
  }

  /**
   * 返回错误消息文本，对应 Go 的 error 接口方法 Error()。
   * @returns {string} 脱敏后的错误说明字符串。
   */
  Error() { return this.Message; }

  /**
   * 返回被包装的底层原因错误，对应 Go 的 errors.Unwrap 约定。
   * @returns {Error|null} 原始底层错误对象，无则返回 null。
   */
  Unwrap() { return this.cause; }
}

/**
 * 创建脱敏后的会话状态错误，沿错误链提取底层系统错误原因而不暴露宿主机绝对路径。
 * 使用场景：文件检查、打开目录或移除符号链接失败时封装统一错误。
 * @param {string} operation 失败的操作名称（如 "检查会话路径"、"移除技能链接"）。
 * @param {string} p 会话内的相对路径。
 * @param {Error|unknown} cause 底层捕获的原始错误。
 * @returns {ConversationStateError} 封装后的会话状态错误实例。
 */
function NewConversationStateError(operation, p, cause) {
  let reason = cause;
  let cur = cause;
  // Go errors.As 沿 cause 链找 PathError/LinkError，取其内层错误；Node 的 fs 错误自带 code，沿链取第一个即是。
  while (cur != null) {
    if (cur.code !== undefined) {
      reason = cur;
      break;
    }
    cur = cur.cause;
  }
  const reasonText = reason instanceof Error ? reason.message : String(reason);
  return new ConversationStateError(`${operation} ${JSON.stringify(p)} 失败（${reasonText}）`, cause);
}

/**
 * 校验会话根目录中平台托管路径的合法性（拒绝符号链接等非法条目）。
 * 使用场景：只检查平台侧物化用到的路径；原生 CLI 自有日志与缓存（含 debug/latest 链接）不会跟随，平台也不经由它们读写。
 * @param {string} root 会话根目录路径。
 * @returns {void} 无返回值；若发现非法路径或符号链接则抛出 ConversationStateError。
 */
function ValidateConversationRoot(root) {
  scanConversationRoot(root, false);
}

/**
 * 扫描会话根目录，列出可恢复的技能目录符号链接，同时拒绝其余托管路径中的非法条目。
 * 使用场景：加锁前的只读检查；写入资产或启动 CLI 之前必须先移除返回的这些链接。
 * @param {string} root 会话根目录路径。
 * @returns {string[]} 技能目录下发现的符号链接相对路径列表（使用 "/" 分隔）。
 */
function ConversationSkillLinks(root) {
  return scanConversationRoot(root, true);
}

/**
 * 解除原生安装器在技能目录中留下的符号链接（仅移除链接本身，不触碰目标）。
 * 使用场景：调用方将资产准备与原生进程串行化后，在写入资产或启动 CLI 前清理技能符号链接。
 * @param {string} root 会话根目录路径。
 * @returns {string[]|null} 实际移除的符号链接相对路径列表；若无可移除链接则返回 null。
 */
function RemoveConversationSkillLinks(root) {
  const links = ConversationSkillLinks(root);
  if (links.length === 0) {
    return null;
  }
  // Go os.OpenRoot 无 JS 对应物，用 path.join 对应。
  let removed = null;
  for (const link of links) {
    let info;
    try {
      info = fs.lstatSync(path.join(root, link));
    } catch (err) {
      if (err.code === "ENOENT") {
        continue;
      }
      throw NewConversationStateError("检查技能链接", link, err);
    }
    if (!info.isSymbolicLink()) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(root, link));
    } catch (err) {
      if (err.code === "ENOENT") {
        continue;
      }
      throw NewConversationStateError("移除技能链接", link, err);
    }
    if (removed === null) {
      removed = [];
    }
    removed.push(link);
  }
  return removed;
}

/**
 * 递归遍历会话根目录下的平台托管路径，校验非法符号链接并按需收集技能目录中的符号链接。
 * 使用场景：由 ValidateConversationRoot 与 ConversationSkillLinks 内部调用。
 * @param {string} root 会话根目录路径。
 * @param {boolean} collectSkillLinks 为 true 时收集技能目录下的符号链接而不立即报错；为 false 时一律报错。
 * @returns {string[]} 收集到的技能符号链接相对路径列表。
 */
function scanConversationRoot(root, collectSkillLinks) {
  const links = [];
  const visit = (p, entry, walkErr) => {
    let rel = path.relative(root, p);
    if (rel === "") {
      rel = ".";
    }
    rel = rel.split(path.sep).join("/");
    if (walkErr !== null) {
      if (walkErr.code === "ENOENT" && rel === ".") {
        return "ok";
      }
      throw NewConversationStateError("检查会话路径", rel, walkErr);
    }
    if (!conversationManagedPath(rel)) {
      if (entry.isDirectory()) {
        return "skip";
      }
      return "ok";
    }
    if (entry.isSymbolicLink()) {
      if (collectSkillLinks && conversationSkillPath(rel)) {
        links.push(rel);
        return "ok";
      }
      throw NewConversationStateError("检查会话路径", rel, new Error("不支持符号链接"));
    }
    if (entry.isDirectory() && p === path.join(root, "ws")) {
      return "skip";
    }
    return "ok";
  };
  const walk = (p, entry) => {
    if (visit(p, entry, null) === "skip" || !entry.isDirectory()) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (err) {
      visit(p, entry, err);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of entries) {
      walk(path.join(p, child.name), child);
    }
  };
  let rootInfo;
  try {
    rootInfo = fs.lstatSync(root);
  } catch (err) {
    visit(root, null, err);
    return links;
  }
  // Go WalkDir 传给回调的是 DirEntry；根节点用 lstat 结果适配。
  const rootEntry = {
    isDirectory: () => rootInfo.isDirectory(),
    isSymbolicLink: () => rootInfo.isSymbolicLink(),
  };
  walk(root, rootEntry);
  return links;
}

/**
 * 判断给定的相对路径是否位于任一技能目录树内。
 * 使用场景：扫描会话目录遇到符号链接时，判定该链接是否属于可自动清理的技能链接。
 * @param {string} rel 相对于会话根目录的正斜杠路径。
 * @returns {boolean} 位于技能目录树中返回 true，否则返回 false。
 */
function conversationSkillPath(rel) {
  for (const tree of conversationSkillTrees) {
    if (rel === tree || rel.startsWith(tree + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * 判断给定的相对路径是否属于平台需要校验的托管路径（含顶层文件、资产树、守卫文件及托管配置路径的祖先）。
 * 使用场景：遍历会话目录时决定是否继续深入检查或跳过非托管目录。
 * @param {string} rel 相对于会话根目录的正斜杠路径。
 * @returns {boolean} 属于平台托管路径返回 true，否则返回 false。
 */
function conversationManagedPath(rel) {
  // 全部顶层文件都是平台输入、检查点或钩子。ws 目录本身必须是真实目录，
  // 但其原生内容不检查。
  if (!rel.includes("/")) {
    return true;
  }
  for (const paths of [conversationAssetTrees, conversationGuardFiles, conversationManagedFiles]) {
    for (const p of paths) {
      if (rel === p || p.startsWith(rel + "/")) {
        return true;
      }
    }
  }
  for (const tree of conversationAssetTrees) {
    if (rel.startsWith(tree + "/")) {
      return true;
    }
  }
  return false;
}

// 凭据/配置目标与宿主创建或删除的目录，另加已同步资产与只读审批守卫。
var conversationManagedFiles = [
  "home/tmp", "home/.agents/agents", "home/.pi/agent/agents", "home/.gemini/config/agents",
  "home/.config/opencode/opencode.json", "home/.cursor/mcp.json", "home/.cursor/cli-config.json",
  "home/.gemini/config/mcp_config.json", "home/.gemini/antigravity-cli/settings.json",
  "home/.kimi-code/mcp.json", "home/.pi/agent/mcp.json", "home/.pi/agent/models.json",
  "home/.dsh/agentflow-mcp.json", "home/.dsh/agentflow-model.json",
  "home/.zcode/v2", "home/.codex/auth.json", "home/.claude/.credentials.json",
];

var conversationSkillTrees = [
  "home/.codebuddy/skills", "home/.claude/skills",
  "home/.codex/skills", "home/.agents/skills", "home/.pi/agent/skills",
  "home/.gemini/config/skills",
];

// 只有平台生成的输入才会传到执行宿主。原生 transcript、会话映射、锁与供应商凭据永不传输。
var conversationAssetTrees = [
  "home/.codebuddy/agents", "home/.claude/agents", "attachments",
  ...conversationSkillTrees,
];

var conversationAssetFiles = [
  "current-mcp.json", "current-settings.json", "claude-mcp.json", "claude-settings.json", "mcp.json", "codex-native-guard.py", "kimi-agent.md",
  "home/.config/opencode/opencode.json", "home/.cursor/mcp.json", "home/.cursor/cli-config.json", "home/.gemini/config/mcp_config.json", "home/.kimi-code/mcp.json", "home/.pi/agent/mcp.json", "home/.dsh/agentflow-mcp.json",
  "home/.zcode/cli/config.json",
];

/**
 * 判断相对路径是否为允许同步遍历的资产目录（仅允许生成输入的上级目录与完整的资产树）。
 * 使用场景：打包或同步会话资产到执行宿主时过滤目录，避免遍历原生日志与缓存，同时允许技能目录内正常包含 projects、sessions 或 tmp 子目录。
 * @param {string} rel 相对于会话根目录的正斜杠路径。
 * @returns {boolean} 允许遍历的资产目录返回 true，否则返回 false。
 */
function ConversationAssetDirectory(rel) {
  if (rel === ".") {
    return true;
  }
  for (const dir of conversationAssetTrees) {
    if (rel === dir || dir.startsWith(rel + "/") || rel.startsWith(dir + "/")) {
      return true;
    }
  }
  for (const p of conversationAssetFiles) {
    if (p.startsWith(rel + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * 判断相对路径是否为允许传输的平台生成资产文件，并指示传输时是否需要重写路径占位符。
 * 使用场景：向执行宿主同步会话资产文件时过滤文件列表并决定是否执行路径重写。
 * @param {string} rel 相对于会话根目录的正斜杠路径。
 * @returns {[boolean, boolean]} 二元组 [allowed, rewrite]：allowed 表示是否允许同步，rewrite 表示是否需要路径重写。
 */
function ConversationAsset(rel) {
  for (const dir of conversationAssetTrees) {
    if (rel.startsWith(dir + "/")) {
      return [true, false];
    }
  }
  for (const p of conversationAssetFiles) {
    if (rel === p) {
      return [true, true];
    }
  }
  if (!rel.includes("/") && rel.endsWith("-system.md")) {
    return [true, true];
  }
  return [false, false];
}

module.exports = {
  ConversationStateError, NewConversationStateError,
  ValidateConversationRoot, ConversationSkillLinks, RemoveConversationSkillLinks,
  scanConversationRoot, conversationSkillPath, conversationManagedPath,
  conversationManagedFiles, conversationSkillTrees, conversationAssetTrees, conversationAssetFiles,
  ConversationAssetDirectory, ConversationAsset,
};
