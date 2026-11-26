// gate_mr.js —— 对应 Go 文件：internal/engine/gate_mr.go
// 作用：mode=mr 门禁：核验工作分支的推送是否已有覆盖的 MR。

"use strict";

const { DeliveryMR, BranchMRQuery } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.DeliveryMR/BranchMRQuery，delivery_mr.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { writableWorkBranch, repositoryBaseBranch } = require("./execution_scope.js"); // 对应 Go 同包函数，execution_scope.js 本次一同翻译

const mrPendingCommand = `refs="$(git ls-remote origin "refs/heads/$AGENTFLOW_WORK_BRANCH")" || exit 2
tip="$(printf '%s\\n' "$refs" | cut -f1)"
if [ -z "$tip" ]; then echo "- 0"; exit 0; fi
git cat-file -e "$tip^{commit}" 2>/dev/null || git fetch -q origin "refs/heads/$AGENTFLOW_WORK_BRANCH" || exit 2
printf '%s %s\\n' "$tip" "$(git rev-list --count "$tip" --not "refs/remotes/origin/$AGENTFLOW_BASE_BRANCH")"`;

const errMRUnverifiable = new Error("MR cannot be verified on the hosting platform");

class pushedWork {
  constructor(init = {}) {
    this.Tip = init.Tip ?? "";
    this.Ahead = init.Ahead ?? 0;
  }
}

Engine.prototype.verifyRunMRs = function (run, gitToken, pending) {
  const problems = [];
  let unverifiable = false;
  for (const rc of run.RepositoryContexts()) {
    const work = writableWorkBranch(rc);
    if (work === "") {
      continue;
    }
    let label = (rc.Name ?? "").trim();
    if (label === "") {
      label = rc.RepositoryID;
    }
    const base = repositoryBaseBranch(rc);
    const [pushed, err] = pending(rc);
    if (err != null) {
      problems.push(`${label}：无法读取远端工作分支 ${work}：${err.message}`);
      continue;
    }
    if (pushed.Ahead === 0) {
      continue;
    }
    const project = (rc.GongfengProjectID ?? "").trim();
    if (this.FindBranchMRsInto == null || project === "") {
      problems.push(`${label}：托管平台不支持自动核验 MR，请人工确认已创建 ${work} → ${base} 的 MR`);
      unverifiable = true;
      continue;
    }
    const [mrs, queryErr] = this.FindBranchMRsInto(new BranchMRQuery({ ProjectID: run.ExecutionContext.ProjectID, RemoteProject: project, SourceBranch: work, TargetBranch: base, GitToken: gitToken, ResponsibleUserID: run.ExecutionContext.ResponsibleUserID }));
    if (queryErr != null) {
      problems.push(`${label}：查询 ${work} → ${base} 的 MR 失败：${queryErr.message}`);
      unverifiable = true;
      continue;
    }
    const problem = mrCoverageProblem(mrs, pushed.Tip);
    if (problem !== "") {
      problems.push(`${label}：${work} → ${base} ${problem}`);
    }
  }
  if (problems.length === 0) {
    return null;
  }
  const err = new Error(problems.join("；"));
  if (unverifiable) {
    return new Error(errMRUnverifiable.message + "：" + err.message);
  }
  return err;
};

function mrCoverageProblem(mrs, tip) {
  const stale = [];
  const merged = [];
  let closed = 0;
  for (const mr of mrs) {
    const head = (mr.HeadSHA ?? "").trim();
    switch (deliveryMRState(mr)) {
      case "opened":
        if (head === "" || head === tip) {
          return "";
        }
        stale.push(`${mr.URL} 的源提交是 ${head}`);
        break;
      case "merged":
        if (head === tip) {
          return "";
        }
        merged.push(mr.URL);
        break;
      default:
        closed++;
        break;
    }
  }
  if (stale.length > 0) {
    return `的 MR 还没有包含远端工作分支的 ${tip}：${stale.join("，")}`;
  }
  if (merged.length > 0) {
    return `只有已合并的 MR ${merged.join("，")}，不包含本轮推送的 ${tip}，需要创建新的 MR`;
  }
  if (closed > 0) {
    return "的 MR 已关闭，需要重新打开或创建新的 MR";
  }
  return "在托管平台上没有 MR/PR，需要创建";
}

function deliveryMRState(mr) {
  let state = (mr.GongfengState ?? "").trim();
  if (state === "") {
    state = (mr.State ?? "").trim();
  }
  if (state === "reopened") {
    return "opened";
  }
  return state;
}

function parseMRPending(output) {
  const lines = (output ?? "").trim().split("\n");
  const last = (lines[lines.length - 1] ?? "").trim();
  const fields = last === "" ? [] : last.split(/\s+/);
  if (fields.length !== 2) {
    return [new pushedWork(), new Error(`unexpected output ${JSON.stringify(last)}`)];
  }
  const n = Number(fields[1]);
  if (!Number.isInteger(n)) {
    return [new pushedWork(), new Error(`unexpected output ${JSON.stringify(last)}`)];
  }
  return [new pushedWork({ Tip: fields[0], Ahead: n }), null];
}

module.exports = { mrPendingCommand, errMRUnverifiable, pushedWork, mrCoverageProblem, deliveryMRState, parseMRPending };
