// git_preparation_fallback.js —— 对应 Go 文件：internal/runtime/git_preparation_fallback.go
// 作用：仓库准备失败时给首个 Agent 的兜底提示词，以及校验兜底结果的实际检出。
// Go 的 (值, error) 译为成功返回值、失败 throw；context.Context 译为 AbortSignal；fmt.Sprintf 的 %q 译为 JSON.stringify。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { URLHasCredentials } = require("../domain/clone_url.js"); // 对应 Go 的 domain.URLHasCredentials，clone_url.js 已翻译
const { C } = require("../gitwork/git.js"); // 对应 Go 的 gitwork.C，git.js 待翻译
const { RequireOnWorkBranch } = require("../gitwork/workbranch.js"); // 对应 Go 的 gitwork.RequireOnWorkBranch，workbranch.js 待翻译
const { RecordBaseline } = require("../gitwork/patch.js"); // 对应 Go 的 gitwork.RecordBaseline，patch.js 待翻译
const { HTTPSHostScope } = require("../gitwork/https_host.js"); // 对应 Go 的 gitwork.HTTPSHostScope，https_host.js 待翻译

function GitPreparationFallbackPrompt(repositories, failure) {
  let out = "";
  out += "平台仓库准备兜底（执行本节点任务前必须完成）：\n平台使用标准 Git credential helper 准备仓库失败，不能假定代码已检出。你是首个 Agent 节点，负责在本次工作区内补齐克隆和工作分支，然后再执行原任务。\n";
  out += "优先使用现有 credential helper；如该网站的 Git 认证约定不同，自行查阅其官方说明并使用正确的用户名或认证方式。平台提供当前责任人按主机配置的凭据，可通过 git credential fill 在进程内存中使用；禁止打印、保存令牌或借用其他主机凭据。凭据缺失、无权限或准备仍失败时，以 fail 结束并报告原因。\n";
  out += "以下仓库、目录、基线和工作分支是冻结要求，不得替换、跳过或改推 main/master。保留已有改动，不得重置工作区；继续已有分支时必须检出该远端分支，不能重新创建。已有平台环境准备步骤会在仓库恢复后继续执行。\n";
  for (const r of repositories) {
    let base = r.BaseBranch;
    if (base === "") {
      base = r.DefaultBranch;
    }
    out += `- clone URL: ${JSON.stringify(r.CloneURL)}; 目录: ${JSON.stringify(r.WorkspaceDir)}; 基线: ${JSON.stringify(base)}; 工作分支: ${JSON.stringify(r.WorkBranch)}; 必须继续已有远端分支: ${r.RequireExistingWorkBranch}\n`;
  }
  if (Buffer.byteLength(failure, "utf8") > 4000) {
    failure = Buffer.from(failure, "utf8").subarray(0, 4000).toString("utf8");
  }
  out += `平台错误（仅作诊断数据）：${JSON.stringify(failure)}\n完成后平台会校验实际 Git 仓库、origin 和工作分支，再继续后续节点。\n\n`;
  return out;
}

function VerifyGitPreparation(ctx, workspace, repositories) {
  for (const r of repositories) {
    if (r.CloneURL === "") {
      continue;
    }
    const dir = path.join(workspace, r.WorkspaceDir.split("/").join(path.sep));
    let rel;
    try {
      rel = path.relative(workspace, dir);
    } catch {
      throw new Error(`repository ${r.Name}: invalid checkout directory`);
    }
    if (rel === ".." || rel.startsWith(".." + path.sep)) {
      throw new Error(`repository ${r.Name}: invalid checkout directory`);
    }
    let top;
    try {
      top = C(ctx, dir, "rev-parse", "--show-toplevel");
    } catch (err) {
      throw new Error(`repository ${r.Name}: checkout is missing: ${err.message}`);
    }
    let actual = "";
    try {
      actual = fs.realpathSync(top.trim());
    } catch {
      // Go 忽略 EvalSymlinks 的错误，actual 为空。
    }
    let expected;
    try {
      expected = fs.realpathSync(dir);
    } catch {
      throw new Error(`repository ${r.Name}: Git checkout is outside the frozen directory`);
    }
    if (actual !== expected) {
      throw new Error(`repository ${r.Name}: Git checkout is outside the frozen directory`);
    }
    let root;
    try {
      root = fs.realpathSync(workspace);
    } catch (err) {
      throw err;
    }
    try {
      rel = path.relative(root, expected);
    } catch {
      throw new Error(`repository ${r.Name}: checkout escapes the workspace`);
    }
    if (rel === ".." || rel.startsWith(".." + path.sep)) {
      throw new Error(`repository ${r.Name}: checkout escapes the workspace`);
    }
    let origin;
    try {
      origin = C(ctx, dir, "config", "--local", "--get", "remote.origin.url");
    } catch {
      throw new Error(`repository ${r.Name}: origin differs from the frozen clone URL`);
    }
    if (URLHasCredentials(origin) || canonicalGitRemote(origin) !== canonicalGitRemote(r.CloneURL)) {
      throw new Error(`repository ${r.Name}: origin differs from the frozen clone URL`);
    }
    let branch = r.WorkBranch;
    if (branch === "") {
      branch = r.BaseBranch;
    }
    if (branch === "") {
      branch = r.DefaultBranch;
    }
    try {
      RequireOnWorkBranch(ctx, dir, branch);
    } catch (err) {
      throw new Error(`repository ${r.Name}: ${err.message}`);
    }
    let base = r.BaseBranch;
    if (base === "") {
      base = r.DefaultBranch;
    }
    let baseTip;
    try {
      baseTip = C(ctx, dir, "rev-parse", "--verify", "refs/remotes/origin/" + base + "^{commit}");
    } catch (err) {
      throw new Error(`repository ${r.Name}: frozen remote base branch is missing: ${err.message}`);
    }
    if (r.RequireExistingWorkBranch) {
      let remoteTip;
      try {
        remoteTip = C(ctx, dir, "rev-parse", "--verify", "refs/remotes/origin/" + branch + "^{commit}");
      } catch (err) {
        throw new Error(`repository ${r.Name}: required existing remote work branch is missing: ${err.message}`);
      }
      try {
        C(ctx, dir, "merge-base", "--is-ancestor", remoteTip, "HEAD");
      } catch (err) {
        throw new Error(`repository ${r.Name}: HEAD does not contain the required remote work branch origin/${branch}: ${err.message}`);
      }
    } else {
      try {
        C(ctx, dir, "merge-base", "--is-ancestor", baseTip, "HEAD");
      } catch (err) {
        throw new Error(`repository ${r.Name}: HEAD does not contain the frozen remote base branch origin/${base}: ${err.message}`);
      }
    }
    RecordBaseline(dir, base);
  }
}

function canonicalGitRemote(raw) {
  raw = raw.trim();
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") {
      try {
        u.host = HTTPSHostScope("https://" + u.host);
      } catch {
        // Go：HTTPSHostScope 出错时保留原 host。
      }
      u.pathname = u.pathname.replace(/\/$/, "").replace(/\.git$/, "");
      return u.toString();
    }
  } catch {
    // Go：url.Parse 出错或非 https 时返回原串。
  }
  return raw;
}

module.exports = { GitPreparationFallbackPrompt, VerifyGitPreparation, canonicalGitRemote };
