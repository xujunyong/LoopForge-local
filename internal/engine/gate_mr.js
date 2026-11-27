// gate_mr.js —— 对应 Go 文件：internal/engine/gate_mr.go
// 作用：mode=mr 验证门禁：核验每个已推送新提交的可写仓库工作分支在托管平台上是否已存在覆盖该提交的 MR。
// 职责边界：仅负责远端待核验输出解析、MR 状态与提交覆盖度校验；具体远端命令执行与平台 API 查询由外部回调注入。
// 语法差异说明：(值, error) 统一译为成功返回值、失败 throw Error；仅返回 error 的函数译为成功返回 undefined、失败 throw Error。

"use strict";

const { DeliveryMR, BranchMRQuery } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.DeliveryMR/BranchMRQuery，delivery_mr.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { writableWorkBranch, repositoryBaseBranch } = require("./execution_scope.js"); // 对应 Go 同包函数，execution_scope.js 已翻译

/**
 * 查询远端工作分支最新提交 SHA 及领先目标基线分支提交数的 shell 命令。
 * 若工作分支从未推送到 origin，输出 "- 0"。
 */
const mrPendingCommand = `refs="$(git ls-remote origin "refs/heads/$AGENTFLOW_WORK_BRANCH")" || exit 2
tip="$(printf '%s\\n' "$refs" | cut -f1)"
if [ -z "$tip" ]; then echo "- 0"; exit 0; fi
git cat-file -e "$tip^{commit}" 2>/dev/null || git fetch -q origin "refs/heads/$AGENTFLOW_WORK_BRANCH" || exit 2
printf '%s %s\\n' "$tip" "$(git rev-list --count "$tip" --not "refs/remotes/origin/$AGENTFLOW_BASE_BRANCH")"`;

/** 标记托管平台无法自动核验 MR 的哨兵错误，表示需要人工确认而非继续 Agent 迭代。 */
const errMRUnverifiable = new Error("MR cannot be verified on the hosting platform");

/**
 * 仓库远端工作分支的推送状态，对应 Go 的 pushedWork。
 * 记录 origin 上工作分支的最新提交 SHA 与领先目标分支的提交数。
 */
class pushedWork {
  /**
   * 按 Go 结构体零值语义初始化 pushedWork 实例。
   * @param {Object} [init={}] - 可选初始字段。
   * @param {string} [init.Tip=""] - 远端工作分支最新提交 SHA（未推送时为 "-"）。
   * @param {number} [init.Ahead=0] - 领先目标基线分支的提交数量。
   * @returns {pushedWork} 初始化后的推送状态实例。
   */
  constructor(init = {}) {
    this.Tip = init.Tip ?? "";
    this.Ahead = init.Ahead ?? 0;
  }
}

/**
 * 执行 mode=mr 门禁核验：检查 Run 下每个可写仓库在 origin 上的工作分支提交是否都已有对应的打开或已合并 MR 覆盖。
 * 在节点完成进入 MR 验证门禁时调用；全部通过时正常返回，任一仓库存在问题时汇总错误并抛出。
 * @param {Object} run - 运行对象（domain.Run）。
 * @param {string} gitToken - 本次运行推送所使用的 Git 凭证令牌。
 * @param {function(Object): pushedWork} pending - 查询单个仓库远端推送状态的回调，成功返回 pushedWork，失败抛出 Error。
 * @returns {void} 全部仓库核验通过时无返回值。
 * @throws {Error} 存在缺失、过时或无法核验的 MR 时抛出汇总 Error；若包含无法核验项则附加 errMRUnverifiable 前缀。
 */
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
    let pushed;
    try {
      pushed = pending(rc);
    } catch (err) {
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
    let mrs;
    try {
      mrs = this.FindBranchMRsInto(new BranchMRQuery({ ProjectID: run.ExecutionContext.ProjectID, RemoteProject: project, SourceBranch: work, TargetBranch: base, GitToken: gitToken, ResponsibleUserID: run.ExecutionContext.ResponsibleUserID }));
    } catch (queryErr) {
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
    return;
  }
  const err = new Error(problems.join("；"));
  if (unverifiable) {
    const wrapped = new Error(errMRUnverifiable.message + "：" + err.message);
    wrapped.cause = err;
    throw wrapped;
  }
  throw err;
};

/**
 * 判断候选 MR 列表中是否存在覆盖指定最新提交 tip 的 MR，未覆盖时返回具体问题描述。
 * 打开状态的 MR 若未上报 HeadSHA 或 HeadSHA 等于 tip 视为覆盖；已合并 MR 必须 HeadSHA 等于 tip 才视为覆盖。
 * @param {DeliveryMR[]} mrs - 同一源分支到目标分支的 MR 列表。
 * @param {string} tip - 远端工作分支的最新提交 SHA。
 * @returns {string} 已覆盖时返回空字符串 ""，否则返回中文问题描述。
 */
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

/**
 * 提取并归一化 MR 的状态字符串，优先使用 GongfengState，并将 reopened 归一化为 opened。
 * 在 mrCoverageProblem 分类统计 MR 状态时调用。
 * @param {DeliveryMR} mr - 交付 MR 记录对象。
 * @returns {string} 归一化后的状态字符串。
 */
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

/**
 * 解析 mrPendingCommand 的标准输出最后一行，提取远端提交 SHA 与领先提交数。
 * 在 mode=mr 门禁拿到沙箱命令输出后调用。
 * @param {string} output - mrPendingCommand 的完整标准输出。
 * @returns {pushedWork} 解析得到的远端推送状态对象。
 * @throws {Error} 输出格式不是两列或第二列不是有效整数时抛出 Error。
 */
function parseMRPending(output) {
  const lines = (output ?? "").trim().split("\n");
  const last = (lines[lines.length - 1] ?? "").trim();
  const fields = last === "" ? [] : last.split(/\s+/);
  if (fields.length !== 2) {
    throw new Error(`unexpected output ${JSON.stringify(last)}`);
  }
  const n = Number(fields[1]);
  if (!/^[+-]?\d+$/.test(fields[1]) || !Number.isInteger(n)) {
    throw new Error(`unexpected output ${JSON.stringify(last)}`);
  }
  return new pushedWork({ Tip: fields[0], Ahead: n });
}

module.exports = { mrPendingCommand, errMRUnverifiable, pushedWork, mrCoverageProblem, deliveryMRState, parseMRPending };
