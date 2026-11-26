// conversation_assets.js —— 对应 Go 文件：internal/runtime/conversation_assets.go
// 作用：校验会话目录、列出并移除原生安装器留下的技能符号链接、判定资产路径。
// (值, error) 译为返回值、失败 throw；errors.Is(err, fs.ErrNotExist) 译为 err.code === "ENOENT"；
// Go filepath.WalkDir 无 JS 对应物，用递归 readdirSync 按字典序模拟。

"use strict";

const fs = require("node:fs"); // Go os/io/fs
const path = require("node:path"); // Go path/filepath

const { conversationGuardFiles } = require("./conversation_sandbox.js"); // 对应 Go 同包变量，conversation_sandbox.js 待翻译

// ConversationStateError：描述一次准备失败，不暴露会话的宿主路径。
class ConversationStateError extends Error {
  constructor(message, cause) {
    super(message);
    this.Message = message;
    this.cause = cause;
  }

  Unwrap() { return this.cause; }
}

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

// 只检查平台侧物化用到的路径。原生 CLI 自有日志与缓存（含 debug/latest 链接）；
// WalkDir 从不跟随这些链接，平台也不经由它们读写。
function ValidateConversationRoot(root) {
  scanConversationRoot(root, false);
}

// ConversationSkillLinks：列出可恢复的链接，并拒绝会话其余部分的非法路径。
// 用于加锁前的只读检查。写入资产或启动 CLI 之前必须先移除这些链接。
function ConversationSkillLinks(root) {
  return scanConversationRoot(root, true);
}

// RemoveConversationSkillLinks：解除原生安装器留下的技能条目链接。
// 安装器可能把条目指向任意位置；只用限定在根目录内的操作移除链接本身。
// 调用方把资产准备与原生进程串行化。
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

function conversationSkillPath(rel) {
  for (const tree of conversationSkillTrees) {
    if (rel === tree || rel.startsWith(tree + "/")) {
      return true;
    }
  }
  return false;
}

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

// ConversationAssetDirectory：只允许生成输入的上级目录与完整的资产树。
// 原生日志与缓存永不遍历，而技能内 legitimately 可能含有 projects、sessions 或 tmp 目录。
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
