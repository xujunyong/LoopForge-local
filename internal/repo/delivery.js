/**
 * @file internal/repo/delivery.js
 * 对应 Go 源文件：internal/repo/delivery.go
 *
 * 作用与职责边界：
 * 实现 MR 交付状态仓储（`DeliveryRepo`）及交付分析聚合逻辑，涵盖工蜂 MR 状态表（`mr_delivery_states`）的登记、
 * 查询、刷新与产物自动发现，工作项的交付锁定、重开、主干提升与降级、历史状态对账修复，
 * 以及按需求维度聚合运行耗时、阶段耗时（澄清/研发/测试）、返工、成本与多 MR 合并状态的交付分析快照构建。
 *
 * 语法差异说明：
 * - `DeliveryRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `DeliveryRepo.prototype` 挂载全部领域方法并保留导出兼容。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回；Go 中以 `_ = ...` 显式忽略的错误调用用 `try ... catch` 吞掉以保持语义一致。
 * - Go 的 `(值, bool)` 或多值元组（如 `(clarification, development, test)`、`(defaultBranch, integrate)`）译为数组元组。
 * - Go 的 `map[string]struct{}` 集合统一译为普通对象 `{}`（值为 `true`）；复合结构键 `map[MRDeliveryKey]V` 用 `${project}\x00${iid}` 字符串键代替。
 * - Go 的 `time.Time` 零值译为 `null`，通过 `isZeroTime`/`timeMs`/`timeBefore`/`timeAfter` 保持零值时间比较一致。
 * - 与 `analytics.js` 存在同包循环引用，调用其辅助函数时采用函数内延迟 `require`。
 */

"use strict";

const { MRDeliveryState, MRDeliveryKey } = require("../domain/mr_delivery.js"); // 对应 Go 的 domain.MRDeliveryState/MRDeliveryKey，domain 已翻译
const { DeliveryMR, ResolveRunDeliveryMRs } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.DeliveryMR/ResolveRunDeliveryMRs，domain 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，domain 已翻译
const { NormalizeBranchName, ParseDeliveryMRURL, ParseGongfengMRs, MRArtifactPriority, ClassifyMRDeliveryState, AnalyticsMRRank, BaselinePromoteIssueID, IsBaselinePromoteIssueID, EffectiveAnalyticsMRState, KeepMainlineDeliveryLabel, SameGongfengMR, FinalizeAnalyticsDelivery, WorkLandedWithPromote } = require("../domain/mr.js"); // 对应 Go 的 domain.*，domain 已翻译
const { DefaultIntegrateBranch } = require("../domain/sync.js"); // 对应 Go 的 domain.DefaultIntegrateBranch，domain 已翻译
const { AnalyticsDelivery, AnalyticsPhaseSamples, AnalyticsPhaseEvidence } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsDelivery 等，domain 已翻译
const { WorkflowDefinition, WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/WorkflowNode，domain 已翻译
const { Run, Artifact } = require("../domain/run.js"); // 对应 Go 的 domain.Run/Artifact，domain 已翻译
const { Project } = require("../domain/project.js"); // 对应 Go 的 domain.Project，domain 已翻译
const { SOPLaneProduct, SOPLaneDesign, InferSOPLane } = require("../domain/sop_lane.js"); // 对应 Go 的 domain.*，domain 已翻译
const { DeliveryRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { mrDeliveryStateRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { insertIgnore, upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { runEndedAt, runExecutionDuration } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译
const { BuildRequirementSnapshot } = require("./requirement.js"); // 对应 Go 同包函数，requirement.js 待翻译

/**
 * 判断时间对象是否为 Go 语境下的零值时间（`null` 或 `undefined`）。
 *
 * @param {Date|null|undefined} t - 待判断的时间对象。
 * @returns {boolean} 为零值时间时返回 `true`，否则返回 `false`。
 */
function isZeroTime(t) {
  return t == null;
}

/**
 * 将 `Date` 或零值时间换算为与 Go `time.Time` 一致的毫秒时间戳（零值对应公元 0001-01-01 UTC）。
 *
 * @param {Date|null|undefined} t - 待换算的时间对象。
 * @returns {number} 毫秒时间戳。
 */
function timeMs(t) {
  return t == null ? -62135596800000 : t.getTime();
}

/**
 * 判断时间 `a` 是否严格早于时间 `b`（对应 Go 的 `a.Before(b)`）。
 *
 * @param {Date|null|undefined} a - 左侧时间。
 * @param {Date|null|undefined} b - 右侧时间。
 * @returns {boolean} `a` 早于 `b` 返回 `true`，否则返回 `false`。
 */
function timeBefore(a, b) {
  return timeMs(a) < timeMs(b);
}

/**
 * 判断时间 `a` 是否严格晚于时间 `b`（对应 Go 的 `a.After(b)`）。
 *
 * @param {Date|null|undefined} a - 左侧时间。
 * @param {Date|null|undefined} b - 右侧时间。
 * @returns {boolean} `a` 晚于 `b` 返回 `true`，否则返回 `false`。
 */
function timeAfter(a, b) {
  return timeMs(a) > timeMs(b);
}

// analytics.js 与本文件存在同包循环引用（analytics.js 引用本文件的 countDeliveryGroups），调用时延迟加载。

/**
 * 延迟调用 `analytics.js` 的 `analyticsRunInWindow`，判断运行是否落在分析时间窗口内。
 *
 * @param {Run} run - 运行记录。
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析过滤条件。
 * @returns {boolean} 落在窗口内时返回 `true`。
 */
function analyticsRunInWindow(run, filter) {
  return require("./analytics.js").analyticsRunInWindow(run, filter);
}

/**
 * 延迟调用 `analytics.js` 的 `analyticsRunMatchesUser`，判断运行是否归属于指定用户。
 *
 * @param {Run} run - 运行记录。
 * @param {string} userID - 目标用户 ID。
 * @param {Issue} issue - 关联的工作项。
 * @returns {boolean} 归属匹配时返回 `true`。
 */
function analyticsRunMatchesUser(run, userID, issue) {
  return require("./analytics.js").analyticsRunMatchesUser(run, userID, issue);
}

/**
 * 延迟调用 `analytics.js` 的 `analyticsRunUserID`，解析运行的归属用户 ID。
 *
 * @param {Run} run - 运行记录。
 * @param {Issue} issue - 关联的工作项。
 * @returns {string} 归属用户 ID。
 */
function analyticsRunUserID(run, issue) {
  return require("./analytics.js").analyticsRunUserID(run, issue);
}

/**
 * 延迟调用 `analytics.js` 的 `analyticsIssueMatchesSource`，判断工作项是否匹配指定来源筛选。
 *
 * @param {Issue} issue - 工作项对象。
 * @param {string} source - 来源筛选值。
 * @returns {boolean} 匹配时返回 `true`。
 */
function analyticsIssueMatchesSource(issue, source) {
  return require("./analytics.js").analyticsIssueMatchesSource(issue, source);
}

/**
 * 延迟调用 `analytics.js` 的 `analyticsIsRequirementIssue`，判断工作项是否属于需求类别。
 *
 * @param {Issue} issue - 工作项对象。
 * @returns {boolean} 为需求类别时返回 `true`。
 */
function analyticsIsRequirementIssue(issue) {
  return require("./analytics.js").analyticsIsRequirementIssue(issue);
}

/**
 * 延迟调用 `analytics.js` 的 `analyticsWorkflowCategory`，解析工作流统计分类。
 *
 * @param {WorkflowDefinition} snapshot - 运行冻结的工作流快照。
 * @param {WorkflowDefinition} fallback - 兜底工作流定义。
 * @returns {string} 工作流分类标识。
 */
function analyticsWorkflowCategory(snapshot, fallback) {
  return require("./analytics.js").analyticsWorkflowCategory(snapshot, fallback);
}

/**
 * 延迟调用 `analytics.js` 的 `analyticsRunDuration`，计算单次运行的耗时。
 *
 * @param {Run} run - 运行记录。
 * @param {Date} now - 当前统计基准时间。
 * @returns {[number, boolean]} 返回 `[耗时毫秒数, 是否已结束]`。
 */
function analyticsRunDuration(run, now) {
  return require("./analytics.js").analyticsRunDuration(run, now);
}

/**
 * 延迟调用 `analytics.js` 的 `usageCostKnown`，判断一次运行的费用是否可计算。
 *
 * @param {Object} usage - 运行用量统计对象。
 * @returns {boolean} 费用已知时返回 `true`。
 */
function usageCostKnown(usage) {
  return require("./analytics.js").usageCostKnown(usage);
}

/**
 * 延迟调用 `analytics.js` 的 `runReworks`，统计单次运行内的返工次数。
 *
 * @param {Run} run - 运行记录。
 * @returns {number} 返工次数。
 */
function runReworks(run) {
  return require("./analytics.js").runReworks(run);
}

// ---------- MR delivery states ( Gongfeng MCP delivery analytics ) ----------

/**
 * 将数据库行 `mrDeliveryStateRow` 转换为领域对象 `MRDeliveryState`。
 *
 * @returns {MRDeliveryState} 转换后的 MR 交付状态领域对象。
 */
mrDeliveryStateRow.prototype.toDomain = function () {
  const item = new MRDeliveryState({
    MRProject: this.MRProject, MRIID: this.MRIID, MRURL: this.MRURL, State: this.State,
    TargetBranch: this.TargetBranch, IssueID: this.IssueID,
  });
  if (this.RegisteredBy != null) {
    item.RegisteredBy = this.RegisteredBy;
  }
  if (this.MergedAt != null) {
    item.MergedAt = this.MergedAt;
  }
  if (this.CheckedAt != null) {
    item.CheckedAt = this.CheckedAt;
  }
  if (this.Created != null) {
    item.CreatedAt = this.Created;
  }
  if (this.Updated != null) {
    item.UpdatedAt = this.Updated;
  }
  return item;
};

/**
 * 将领域对象 `MRDeliveryState` 映射为写入 `mr_delivery_states` 表的列值字典。
 *
 * @param {MRDeliveryState} item - MR 交付状态对象。
 * @param {Date} now - 当前写入时间（写入 `updated_at`）。
 * @returns {Object<string, *>} 数据库列名到值的映射对象。
 */
function mrDeliveryRowValues(item, now) {
  const checked = timePtr(item.CheckedAt);
  return {
    mr_project: item.MRProject, mr_iid: item.MRIID, mr_url: item.MRURL,
    state: item.State, target_branch: NormalizeBranchName(item.TargetBranch),
    issue_id: item.IssueID, merged_at: timePtr(item.MergedAt), checked_at: checked,
    created_at: timePtr(item.CreatedAt), updated_at: timePtr(now),
  };
}

/**
 * 按工蜂项目与 MR IID 读取单条 MR 交付状态记录。
 *
 * @param {string} project - 工蜂项目标识。
 * @param {number} iid - MR 序号。
 * @returns {[MRDeliveryState, boolean]} 返回 `[MR 状态对象, 是否存在]`。
 */
DeliveryRepo.prototype.mrDeliveryState = function (project, iid) {
  return mrDeliveryStateDB(this.DB, project, iid);
};

/**
 * 在指定数据库句柄（主连接或事务）上查询单条 MR 交付状态行并转为领域对象。
 *
 * @param {Object} db - `gorm.DB` 查询句柄。
 * @param {string} project - 工蜂项目标识。
 * @param {number} iid - MR 序号。
 * @returns {[MRDeliveryState, boolean]} 返回 `[MR 状态对象, 是否找到]`。
 */
function mrDeliveryStateDB(db, project, iid) {
  const row = new mrDeliveryStateRow();
  if (db.Where("mr_project = ? AND mr_iid = ?", project, iid).Take(row).Error != null) {
    return [new MRDeliveryState(), false];
  }
  return [row.toDomain(), true];
}

/**
 * 登记或刷新一条 MR 与工作项的关联记录。
 * 若记录尚不存在则忽略冲突插入初始行；已存在时按保护规则刷新 URL 与 `IssueID`（保护基线提升标记不被普通工作项覆盖）。
 *
 * @param {string} project - 工蜂项目标识。
 * @param {number} iid - MR 序号。
 * @param {string} url - MR 链接地址。
 * @param {string} issueID - 关联的工作项 ID（可为空）。
 * @returns {void} 无返回值。
 * @throws {Error} 事务内插入或更新失败时抛出错误。
 */
DeliveryRepo.prototype.EnsureMRDeliveryState = function (project, iid, url, issueID) {
  if (project === "" || iid <= 0) {
    return;
  }
  url = url.trim();
  issueID = issueID.trim();
  const now = new Date();
  this.DB.Transaction((tx) => {
    const [existing, ok] = mrDeliveryStateDB(tx, project, iid);
    if (!ok) {
      insertIgnore(tx, "mr_delivery_states", mrDeliveryRowValues(new MRDeliveryState({
        MRProject: project, MRIID: iid, MRURL: url, State: "unknown", IssueID: issueID,
      }), now));
      return;
    }
    const originalURL = existing.MRURL;
    const originalIssueID = existing.IssueID;
    if (url !== "") {
      existing.MRURL = url;
    }
    if (existing.IssueID === issueID || issueID === BaselinePromoteIssueID) {
      // 保持原关联不变
    } else if (existing.IssueID === BaselinePromoteIssueID) {
      // 基线提升标记不被普通工作项覆盖
    } else if (issueID !== "") {
      existing.IssueID = issueID;
    }
    if (existing.MRURL === originalURL && existing.IssueID === originalIssueID) {
      return;
    }
    upsert(tx, "mr_delivery_states", mrDeliveryRowValues(existing, now));
  });
};

/**
 * 记录首次登记某条 MR 的操作人用户 ID；若已有登记人则保留原始用户不被覆盖。
 *
 * @param {string} project - 工蜂项目标识。
 * @param {number} iid - MR 序号。
 * @param {number} userID - 登记人用户 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
DeliveryRepo.prototype.SetMRDeliveryRegisteredBy = function (project, iid, userID) {
  if (project === "" || iid <= 0 || userID <= 0) {
    return;
  }
  const err = this.DB.Table("mr_delivery_states").
    Where("mr_project = ? AND mr_iid = ? AND registered_by IS NULL", project, iid).
    Update("registered_by", userID).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 更新一条 MR 在工蜂侧的最新状态，并根据目标分支分类结果联动更新关联工作项的交付状态。
 * 合入默认分支时锁定工作项为已交付，其余状态仅同步工作项上的 MR 状态标签。
 *
 * @param {string} project - 工蜂项目标识。
 * @param {number} iid - MR 序号。
 * @param {string} state - 工蜂原始 MR 状态（如 `"opened"`、`"merged"`、`"closed"`）。
 * @param {string} targetBranch - MR 目标分支名称。
 * @param {Date|null} mergedAt - MR 合入时间（未合入或缺失时为 `null`）。
 * @param {Date|null} checkedAt - 本次轮询检查时间（为空时取当前时间）。
 * @returns {void} 无返回值。
 * @throws {Error} 状态落盘或工作项联动更新失败时抛出错误。
 */
DeliveryRepo.prototype.UpdateMRDeliveryState = function (project, iid, state, targetBranch, mergedAt, checkedAt) {
  if (project === "" || iid <= 0) {
    return;
  }
  state = state.trim();
  if (state === "") {
    state = "unknown";
  }
  targetBranch = NormalizeBranchName(targetBranch);
  if (isZeroTime(checkedAt)) {
    checkedAt = new Date();
  }
  this.recordMRState(project, iid, state, targetBranch, mergedAt, checkedAt);
  const classified = this.classifyMRDelivery(new MRDeliveryState({
    MRProject: project,
    State: state,
    TargetBranch: targetBranch,
  }));
  const [existing, ok] = this.mrDeliveryState(project, iid);
  if (!ok) {
    return;
  }
  if (IsBaselinePromoteIssueID(existing.IssueID)) {
    if (classified === "merged") {
      this.PromoteIntegratedIssuesIfBaselineLanded(project, checkedAt);
    }
    return;
  }
  if (existing.IssueID !== "") {
    if (!this.shouldWriteIssueDeliveryFromMR(existing.IssueID, existing.MRURL)) {
      return;
    }
    if (classified === "merged") {
      this.MarkIssueDelivered(existing.IssueID, existing.MRURL, checkedAt);
      return;
    }
    this.syncIssueMRState(existing.IssueID, existing.MRURL, classified);
  }
};

/**
 * 仅将查询到的工蜂 MR 状态写入 `mr_delivery_states` 表，不触碰工作项表。
 * 当状态为 `"merged"` 但未携带 `mergedAt` 时，不抹除已有权威合入时间。
 *
 * @param {string} project - 工蜂项目标识。
 * @param {number} iid - MR 序号。
 * @param {string} state - 工蜂 MR 状态。
 * @param {string} targetBranch - 目标分支名。
 * @param {Date|null} mergedAt - 合入时间。
 * @param {Date} checkedAt - 检查时间。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
DeliveryRepo.prototype.recordMRState = function (project, iid, state, targetBranch, mergedAt, checkedAt) {
  const values = { state: state, target_branch: NormalizeBranchName(targetBranch), checked_at: checkedAt, updated_at: new Date() };
  if (state !== "merged") {
    values["merged_at"] = null;
  } else if (!isZeroTime(mergedAt)) {
    // 无合入时间的响应不得覆盖已记录的权威合入时间。
    values["merged_at"] = mergedAt;
  }
  const err = this.DB.Model(new mrDeliveryStateRow()).
    Where("mr_project = ? AND mr_iid = ?", project, iid).
    Updates(values).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 由 MR 轮询或对账任务触发的工作项交付锁定。
 * 要求 `mrURL` 属于工作项已关联的交付 MR（或工作项尚未关联任何 MR），且不会重新锁定已被人工重开的工作项。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {string} mrURL - 已合入的 MR 链接。
 * @param {Date|null} deliveredAt - 交付时间戳。
 * @returns {void} 无返回值。
 * @throws {Error} 保存工作项失败时抛出错误。
 */
DeliveryRepo.prototype.MarkIssueDelivered = function (issueID, mrURL, deliveredAt) {
  this.markIssueDelivered(issueID, singleDeliveryMR(mrURL), deliveredAt, false);
};

/**
 * 在新的 SOP 运行成功后锁定工作项为已交付（单 MR 入口）。
 * 与 `MarkIssueDelivered` 不同，SOP 成功回调允许重新锁定曾被人工重开的工作项。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {string} mrURL - 本次 SOP 产出的 MR 链接。
 * @param {Date|null} deliveredAt - 交付时间戳。
 * @returns {void} 无返回值。
 * @throws {Error} 保存工作项失败时抛出错误。
 */
DeliveryRepo.prototype.MarkIssueDeliveredFromSOP = function (issueID, mrURL, deliveredAt) {
  this.MarkIssueDeliveredFromSOPMRs(issueID, singleDeliveryMR(mrURL), deliveredAt);
};

/**
 * 在新的 SOP 运行成功后锁定工作项为已交付（多仓库多 MR 入口）。
 * 非空列表会替换工作项当前的交付 MR 列表；空列表则保留此前已关联的交付 MR。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {DeliveryMR[]|null} mrs - 本次 SOP 产出的交付 MR 列表。
 * @param {Date|null} deliveredAt - 交付时间戳。
 * @returns {void} 无返回值。
 * @throws {Error} 保存工作项失败时抛出错误。
 */
DeliveryRepo.prototype.MarkIssueDeliveredFromSOPMRs = function (issueID, mrs, deliveredAt) {
  this.markIssueDelivered(issueID, mrs, deliveredAt, true);
};

/**
 * 将单个 MR URL 封装为单元素 `DeliveryMR` 数组，并尽力解析其项目与 IID。
 * URL 为空时返回 `null`。
 *
 * @param {string} mrURL - MR 链接地址。
 * @returns {DeliveryMR[]|null} 单元素数组或 `null`。
 */
function singleDeliveryMR(mrURL) {
  mrURL = mrURL.trim();
  if (mrURL === "") {
    return null;
  }
  const mr = new DeliveryMR({ URL: mrURL });
  const [project, iid, , ok] = ParseDeliveryMRURL(mrURL);
  if (ok) {
    mr.Project = project;
    mr.IID = iid;
  }
  return [mr];
}

/**
 * 将交付 MR 登记到轮询状态表并可选写入实时工蜂状态，最后返回分类后的 MR 交付状态。
 *
 * @param {string} issueID - 关联的工作项 ID。
 * @param {DeliveryMR} mr - 交付 MR 描述对象。
 * @param {Date} at - 登记时间戳。
 * @returns {string} 分类后的 MR 交付状态（无法解析项目/IID 时返回 `"unknown"`）。
 */
DeliveryRepo.prototype.registerDeliveryMR = function (issueID, mr, at) {
  let project = mr.Project;
  let iid = mr.IID;
  if (project === "" || iid <= 0) {
    const [p, n, , ok] = ParseDeliveryMRURL(mr.URL);
    if (ok) {
      project = p;
      iid = n;
    }
  }
  if (project === "" || iid <= 0) {
    return "unknown";
  }
  try {
    this.EnsureMRDeliveryState(project, iid, mr.URL, issueID);
  } catch {
    // Go 忽略此处的错误返回值。
  }
  const st = mr.GongfengState.trim();
  if (st !== "") {
    try {
      this.recordMRState(project, iid, st, mr.TargetBranch, null, at);
    } catch {
      // Go 忽略此处的错误返回值。
    }
  }
  return this.lookupMRDeliveryState(mr.URL);
};

/**
 * 执行工作项交付锁定的核心实现：检查跳过条件、更新交付 MR 列表与状态、置为完成态与忽略自动化，然后保存工作项。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {DeliveryMR[]|null} mrs - 关联的交付 MR 列表。
 * @param {Date|null} deliveredAt - 交付时间戳（为空时取当前时间）。
 * @param {boolean} fromSOP - 是否来自 SOP 运行成功回调。
 * @returns {void} 无返回值。
 * @throws {Error} 持久化工作项失败时抛出错误。
 */
DeliveryRepo.prototype.markIssueDelivered = function (issueID, mrs, deliveredAt, fromSOP) {
  issueID = issueID.trim();
  if (issueID === "") {
    return;
  }
  const [issue, ok] = this.issues.Issue(issueID);
  if (!ok) {
    return;
  }
  if (isZeroTime(deliveredAt)) {
    deliveredAt = new Date();
  }
  if (issueDeliverySkipped(issue, mrs, deliveredAt, fromSOP)) {
    return;
  }
  issue.DeliveryState = "merged";
  const mrList = mrs ?? [];
  if (mrList.length > 0 && (fromSOP || (issue.DeliveryMRList() ?? []).length === 0)) {
    const list = [];
    for (const mr of mrList) {
      mr.State = this.registerDeliveryMR(issue.ID, mr, deliveredAt);
      list.push(mr);
    }
    issue.SetDeliveryMRs(list);
  } else {
    for (const mr of mrList) {
      issue.SetDeliveryMRState(mr.URL, this.lookupMRDeliveryState(mr.URL));
    }
    if (fromSOP) {
      const list = issue.DeliveryMRList() ?? [];
      for (let idx = 0; idx < list.length; idx++) {
        list[idx].State = this.lookupMRDeliveryState(list[idx].URL);
      }
      issue.SetDeliveryMRs(list);
    }
  }
  issue.DeliveryUpdatedAt = deliveredAt;
  if (issue.Status !== "closed") {
    issue.Status = "done";
  }
  issue.AutomationState = "ignored";
  this.issues.PutIssue(issue);
};

/**
 * 判断本次交付信号是否应跳过而不改动目标工作项。
 * 人工关闭的工作项始终跳过；人工重开的工作项跳过非 SOP 回调；非 SOP 轮询跳过不属于当前交付 MR 列表的旧 MR；
 * 已处于 `merged` 状态且时间戳不晚于当前 `DeliveryUpdatedAt` 的信号亦跳过。
 *
 * @param {Issue} issue - 目标工作项。
 * @param {DeliveryMR[]|null} mrs - 触发本次信号的 MR 列表。
 * @param {Date} deliveredAt - 已解析好的非零交付时间。
 * @param {boolean} fromSOP - 是否来自 SOP 运行成功回调。
 * @returns {boolean} 应跳过时返回 `true`，否则返回 `false`。
 */
function issueDeliverySkipped(issue, mrs, deliveredAt, fromSOP) {
  // 人工关闭为显式终态，后台轮询与过时 SOP 回调不得改写。
  if (issue.ManuallyClosed()) {
    return true;
  }
  // 人工重开的工作项在新的 SOP 成功前保持打开，防止 MR 轮询立即重新锁定。
  if (issue.DeliveryState.toLowerCase() === "reopened" && !fromSOP) {
    return true;
  }
  // 轮询或对账可能看到历史 SOP 留下的旧 MR，这些记录不得覆盖当前工作项的交付 MR。
  if (!fromSOP) {
    for (const mr of mrs ?? []) {
      if ((issue.DeliveryMRList() ?? []).length > 0 && !issue.HasDeliveryMR(mr.URL)) {
        return true;
      }
    }
  }
  return issue.DeliveryState === "merged" && !(timeMs(deliveredAt) > timeMs(issue.DeliveryUpdatedAt));
}

/**
 * 重新打开已完成交付或已关闭的工作项，将其交付状态标记为 `"reopened"` 并恢复为可自动化调度状态。
 * 若外部追踪系统（如 TAPD/工蜂）仍为关闭态，则拒绝重开。
 *
 * @param {string} issueID - 待重开的工作项 ID。
 * @returns {Issue} 重开并保存后的最新工作项对象。
 * @throws {Error} 工作项不存在、尚未交付/关闭、外部系统仍关闭或保存失败时抛出错误。
 */
DeliveryRepo.prototype.ReopenDeliveredIssue = function (issueID) {
  const [issue, ok] = this.issues.Issue(issueID.trim());
  if (!ok) {
    throw new Error("issue not found");
  }
  if (issue.Status.toLowerCase() !== "closed" && !issue.DeliveryLocked()) {
    throw new Error("工作项尚未完成交付，无需重新打开");
  }
  if (issue.TrackerClosed()) {
    throw new Error("外部工作项仍处于关闭状态，请先在外部系统重新打开");
  }
  if (issue.DeliveryLocked()) {
    issue.DeliveryState = "reopened";
  }
  issue.DeliveryUpdatedAt = new Date();
  issue.Status = "todo";
  issue.CloseSource = "";
  issue.AutomationState = "eligible";
  this.issues.PutIssue(issue);
  const [stored] = this.issues.Issue(issue.ID);
  return stored;
};

/**
 * 对账历史上已合入默认分支的 MR 状态行，为对应工作项补齐交付锁定状态。
 * 已被人工重开的工作项保持打开直到下一次 SOP 成功。
 *
 * @returns {void} 无返回值。
 * @throws {Error} 查询 MR 状态表或锁定工作项失败时抛出错误。
 */
DeliveryRepo.prototype.ReconcileMergedMRDeliveries = function () {
  const rows = [];
  const findErr = this.DB.Where("state = 'merged' AND issue_id <> '' AND issue_id <> ?", BaselinePromoteIssueID).Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  const items = [];
  for (const row of rows) {
    if (this.classifyMRDelivery(row.toDomain()) !== "merged") {
      continue;
    }
    let at = null;
    if (row.Updated != null) {
      at = row.Updated;
    }
    if (row.CheckedAt != null) {
      at = row.CheckedAt;
    }
    items.push({ issueID: row.IssueID, mrURL: row.MRURL, at: at });
  }
  for (const item of items) {
    this.MarkIssueDelivered(item.issueID, item.mrURL, item.at);
  }
};

/**
 * 为已交付锁定但缺少 MR 链接的工作项执行一次性回填，从其最近成功 SOP 的运行产物中恢复 MR 链接。
 *
 * @returns {void} 无返回值。
 * @throws {Error} 回写工作项失败时抛出错误。
 */
DeliveryRepo.prototype.ReconcileUnlinkedDeliveryMRs = function () {
  const now = new Date();
  for (const issue of this.issues.Issues()) {
    if (!issue.DeliveryLocked() || (issue.DeliveryMRList() ?? []).length > 0) {
      continue;
    }
    const recovered = this.recoverUnlinkedDeliveryMRs(issue);
    if ((recovered ?? []).length === 0) {
      continue;
    }
    for (let idx = 0; idx < recovered.length; idx++) {
      recovered[idx].State = this.registerDeliveryMR(issue.ID, recovered[idx], now);
    }
    issue.SetDeliveryMRs(recovered);
    this.issues.PutIssue(issue);
  }
};

/**
 * 对账最新 SOP 运行已成功但在交付锁定功能上线前创建的遗留工作项，为其补齐交付锁定状态。
 *
 * @returns {void} 无返回值。
 * @throws {Error} 锁定工作项失败时抛出错误。
 */
DeliveryRepo.prototype.ReconcileCompletedDeliveries = function () {
  for (const issue of this.issues.Issues()) {
    if (issue.DeliveryLocked() || issue.DeliveryState.toLowerCase() === "reopened") {
      continue;
    }
    const taskID = issue.LatestTaskID.trim();
    if (taskID === "") {
      continue;
    }
    const [task, ok] = this.tasks.Task(taskID);
    if (!ok || task.Status !== "completed" || task.RunID.trim() === "") {
      continue;
    }
    const [run, runOk] = this.runs.Run(task.RunID);
    if (!runOk || run.Status !== "succeeded") {
      continue;
    }
    let at = run.UpdatedAt;
    if (isZeroTime(at)) {
      at = new Date();
    }
    this.markIssueDelivered(issue.ID, ResolveRunDeliveryMRs(run, null), at, false);
  }
};

/**
 * 刷新全部已交付锁定工作项上的 `DeliveryMRState` 标签。
 * 若工作项已因基线提升落地主干，则保留主干标签不被目标分支为集成分支的旧工作 MR 降级。
 *
 * @returns {void} 无返回值。
 * @throws {Error} 后续基线对账失败时抛出错误。
 */
DeliveryRepo.prototype.ReconcileDeliveryMRStates = function () {
  for (const issue of this.issues.Issues()) {
    if (!issue.DeliveryLocked()) {
      continue;
    }
    const list = issue.DeliveryMRList() ?? [];
    if (list.length === 0) {
      if (issue.DeliveryMRState !== "") {
        issue.DeliveryMRState = "";
        try {
          this.issues.PutIssue(issue);
        } catch {
          // Go 忽略此处的错误返回值。
        }
      }
      continue;
    }
    // Go 的 before := issue 是值复制；JS 对象是引用，快照须在改动前取。
    const before = { ...issue, DeliveryMRs: (issue.DeliveryMRs ?? []).map((mr) => ({ ...mr })) };
    for (let idx = 0; idx < list.length; idx++) {
      const state = this.lookupMRDeliveryState(list[idx].URL);
      // 人工发起的基线合入默认分支 MR 落地后，保留主干交付标签不被工作 MR 的集成分支状态覆盖。
      if (state === "" || KeepMainlineDeliveryLabel(list[idx].State, state)) {
        continue;
      }
      list[idx].State = state;
    }
    issue.SetDeliveryMRs(list);
    if (deliveryMRFieldsEqual(before, issue)) {
      continue;
    }
    try {
      this.issues.PutIssue(issue);
    } catch {
      // Go 忽略此处的错误返回值。
    }
  }
  this.ReconcileBaselinePromoteDeliveries();
};

/**
 * 将已合入基线的工作项提升标记为已落地默认分支（`"merged"`），同时保留原工作 MR 链接不变。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {string} mrURL - 对应的工作 MR 链接。
 * @param {Date|null} at - 落地主干时间（为空时取当前时间）。
 * @returns {void} 无返回值。
 * @throws {Error} 持久化工作项失败时抛出错误。
 */
DeliveryRepo.prototype.PromoteIssueToMainline = function (issueID, mrURL, at) {
  issueID = issueID.trim();
  if (issueID === "") {
    return;
  }
  const [issue, ok] = this.issues.Issue(issueID);
  if (!ok) {
    return;
  }
  if (issue.DeliveryState.toLowerCase() === "reopened") {
    return;
  }
  if (isZeroTime(at)) {
    at = new Date();
  }
  let changed = false;
  if (issue.DeliveryState !== "merged") {
    issue.DeliveryState = "merged";
    if (issue.Status !== "closed") {
      issue.Status = "done";
    }
    issue.AutomationState = "ignored";
    changed = true;
  }
  const before = { ...issue, DeliveryMRs: (issue.DeliveryMRs ?? []).map((mr) => ({ ...mr })) };
  const trimmed = mrURL.trim();
  if (trimmed !== "") {
    issue.SetDeliveryMRState(trimmed, "merged");
  } else if ((issue.DeliveryMRList() ?? []).length === 0) {
    issue.DeliveryMRState = "merged";
  }
  if (!deliveryMRFieldsEqual(before, issue)) {
    changed = true;
  }
  if (timeAfter(at, issue.DeliveryUpdatedAt)) {
    issue.DeliveryUpdatedAt = at;
    changed = true;
  }
  if (!changed) {
    return;
  }
  this.issues.PutIssue(issue);
};

/**
 * 历史兼容空实现：不再仅凭基线提升 MR 的时间戳批量升级交付标签，改由 MR 同步中的提交包含关系决定。
 *
 * @param {string} _project - 工蜂项目标识（未使用）。
 * @param {Date|null} _at - 提升时间（未使用）。
 * @returns {void} 无返回值。
 */
DeliveryRepo.prototype.PromoteIntegratedIssuesIfBaselineLanded = function (_project, _at) {
  return;
};

/**
 * 历史兼容空实现：不再按时间戳广播已合入的基线提升 MR，改由 MR 同步中的提交包含关系处理。
 *
 * @returns {void} 无返回值。
 */
DeliveryRepo.prototype.ReconcileBaselinePromoteDeliveries = function () {
  return;
};

/**
 * 内部辅助：按时间窗口将指定工蜂项目下所有处于 `"integrated"` 状态的工作项提升为主干已交付。
 *
 * @param {string} project - 工蜂项目标识。
 * @param {Date} promoteAt - 基线提升落地时间。
 * @returns {void} 无返回值。
 * @throws {Error} 查询 MR 状态表或更新工作项失败时抛出错误。
 */
DeliveryRepo.prototype.promoteIntegratedIssues = function (project, promoteAt) {
  const seen = {};
  const rows = [];
  const findErr = this.DB.Where("mr_project = ? AND issue_id <> '' AND issue_id <> ?", project, BaselinePromoteIssueID).Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  for (const row of rows) {
    const item = row.toDomain();
    if (IsBaselinePromoteIssueID(item.IssueID)) {
      continue;
    }
    let at = item.UpdatedAt;
    if (!isZeroTime(item.CheckedAt)) {
      at = item.CheckedAt;
    }
    if (this.classifyMRDelivery(new MRDeliveryState({ MRProject: project, State: item.State, TargetBranch: item.TargetBranch })) !== "integrated") {
      continue;
    }
    if (!WorkLandedWithPromote(at, promoteAt)) {
      continue;
    }
    this.PromoteIssueToMainline(item.IssueID, item.MRURL, promoteAt);
    seen[item.IssueID] = true;
  }
  for (const issue of this.issues.Issues()) {
    if (seen[issue.ID]) {
      continue;
    }
    if (!WorkLandedWithPromote(issue.DeliveryUpdatedAt, promoteAt)) {
      continue;
    }
    for (const mr of issue.DeliveryMRList() ?? []) {
      if (mr.State.toLowerCase() !== "integrated") {
        continue;
      }
      const [proj, , , ok] = ParseDeliveryMRURL(mr.URL);
      if (!ok || proj.trim().toLowerCase() !== project.trim().toLowerCase()) {
        continue;
      }
      this.PromoteIssueToMainline(issue.ID, mr.URL, promoteAt);
    }
  }
};

/**
 * 从工作项最近一次成功运行的 SOP 产物中提取遗漏的交付 MR 列表。
 *
 * @param {Issue} issue - 目标工作项。
 * @returns {DeliveryMR[]|null} 解析出的交付 MR 数组；无可用运行记录或依赖缺失时返回 `null`。
 */
DeliveryRepo.prototype.recoverUnlinkedDeliveryMRs = function (issue) {
  if (this.tasks == null || this.runs == null) {
    return null;
  }
  const taskID = issue.LatestTaskID.trim();
  if (taskID === "") {
    return null;
  }
  const [task, ok] = this.tasks.Task(taskID);
  if (!ok || task.RunID.trim() === "") {
    return null;
  }
  const [run, runOk] = this.runs.Run(task.RunID);
  if (!runOk || run.Status !== "succeeded") {
    return null;
  }
  return ResolveRunDeliveryMRs(run, null);
};

/**
 * 列出单个工蜂项目下全部已合入的工作 MR 记录（排除基线提升标记行），供提交包含关系检查使用。
 *
 * @param {string} project - 工蜂项目标识。
 * @returns {MRDeliveryState[]|null} 已合入的 MR 交付状态数组；`project` 为空时返回 `null`。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
DeliveryRepo.prototype.MergedWorkMRs = function (project) {
  project = project.trim();
  if (project === "") {
    return null;
  }
  const rows = [];
  const findErr = this.DB.Where("mr_project = ? AND state = ? AND issue_id <> '' AND issue_id <> ?", project, "merged", BaselinePromoteIssueID).Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  const out = [];
  for (const row of rows) {
    out.push(row.toDomain());
  }
  return out;
};

/**
 * 根据工作提交是否已包含在默认分支中，将工作项对应 MR 的交付标签设置为已落地主干或回退为已合入基线。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {string} mrURL - 工作 MR 链接。
 * @param {boolean} onDefault - 提交是否已存在于默认分支中。
 * @returns {void} 无返回值。
 * @throws {Error} 更新工作项失败时抛出错误。
 */
DeliveryRepo.prototype.ApplyDefaultBranchLanding = function (issueID, mrURL, onDefault) {
  if (onDefault) {
    this.PromoteIssueToMainline(issueID, mrURL, new Date());
    return;
  }
  this.demoteIssueToBaseline(issueID, mrURL);
};

/**
 * 将误标为主干 `"merged"` 的工作项 MR 状态降级回 `"integrated"`（仅合入基线尚未上默认分支）。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {string} mrURL - 工作 MR 链接。
 * @returns {void} 无返回值。
 * @throws {Error} 保存工作项失败时抛出错误。
 */
DeliveryRepo.prototype.demoteIssueToBaseline = function (issueID, mrURL) {
  const [issue, ok] = this.issues.Issue(issueID.trim());
  if (!ok || issue.DeliveryState.toLowerCase() === "reopened") {
    return;
  }
  mrURL = mrURL.trim();
  if (mrURL === "" || issue.DeliveryMRState.toLowerCase() !== "merged") {
    return;
  }
  const before = { ...issue, DeliveryMRs: (issue.DeliveryMRs ?? []).map((mr) => ({ ...mr })) };
  if (!issue.SetDeliveryMRState(mrURL, "integrated")) {
    return;
  }
  if (deliveryMRFieldsEqual(before, issue)) {
    return;
  }
  this.issues.PutIssue(issue);
};

/**
 * 按 MR URL 查询数据库中的 MR 状态，并结合仓库分支上下文返回分类后的交付状态标签。
 *
 * @param {string} mrURL - MR 链接地址。
 * @returns {string} 分类后的交付状态；URL 非法时返回 `""`，查不到或无法分类时返回 `"unknown"`。
 */
DeliveryRepo.prototype.lookupMRDeliveryState = function (mrURL) {
  const [project, iid, , ok] = ParseDeliveryMRURL(mrURL);
  if (!ok) {
    return "";
  }
  const states = this.MRDeliveryStatesMap([new MRDeliveryKey({ Project: project, IID: iid })]);
  const st = states[`${project}\x00${iid}`];
  if (st !== undefined) {
    const classified = this.classifyMRDelivery(st);
    if (classified !== "") {
      return classified;
    }
  }
  return "unknown";
};

/**
 * 结合工蜂项目对应的默认分支与集成分支配置，对单条 MR 交付状态进行分类。
 *
 * @param {MRDeliveryState} st - MR 交付状态对象。
 * @returns {string} 分类后的状态标签（如 `"merged"`、`"integrated"`、`"opened"`、`"closed"` 等）。
 */
DeliveryRepo.prototype.classifyMRDelivery = function (st) {
  const [def, integ] = this.branchContextForMRProject(st.MRProject);
  return ClassifyMRDeliveryState(st.State, st.TargetBranch, def, integ);
};

/**
 * 根据工蜂项目标识从目录仓库列表中查找其配置的默认分支与集成分支名。
 *
 * @param {string} project - 工蜂项目标识。
 * @returns {[string, string]} 返回 `[默认分支名, 集成分支名]`；未找到时集成分支回退为 `DefaultIntegrateBranch`。
 */
DeliveryRepo.prototype.branchContextForMRProject = function (project) {
  let integrate = DefaultIntegrateBranch;
  project = project.trim();
  if (project === "") {
    return ["", integrate];
  }
  for (const repo of this.catalog.Repositories()) {
    if (repo.GongfengProjectID.trim().toLowerCase() === project.toLowerCase()) {
      return [repo.DefaultBranch.trim(), repo.IntegrateBranch.trim()];
    }
  }
  return ["", integrate];
};

/**
 * 判断来自指定 MR 的状态更新是否允许写回目标工作项。
 * 若工作项尚未关联任何交付 MR，或该 MR 已在工作项的交付 MR 列表中，则允许写回。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {string} mrURL - MR 链接地址。
 * @returns {boolean} 允许写回时返回 `true`，否则返回 `false`。
 */
DeliveryRepo.prototype.shouldWriteIssueDeliveryFromMR = function (issueID, mrURL) {
  const [issue, ok] = this.issues.Issue(issueID.trim());
  if (!ok) {
    return false;
  }
  if ((issue.DeliveryMRList() ?? []).length === 0) {
    return true;
  }
  return issue.HasDeliveryMR(mrURL);
};

/**
 * 将单条 MR 的非终态分类状态同步到关联工作项的交付 MR 字段上。
 *
 * @param {string} issueID - 工作项 ID。
 * @param {string} mrURL - MR 链接地址。
 * @param {string} state - 分类后的 MR 状态标签。
 * @returns {void} 无返回值。
 * @throws {Error} 持久化工作项失败时抛出错误。
 */
DeliveryRepo.prototype.syncIssueMRState = function (issueID, mrURL, state) {
  const [issue, ok] = this.issues.Issue(issueID.trim());
  if (!ok) {
    return;
  }
  if (!this.shouldWriteIssueDeliveryFromMR(issue.ID, mrURL)) {
    return;
  }
  state = state.trim();
  if (mrURL.trim() === "" || state === "") {
    return;
  }
  const before = { ...issue, DeliveryMRs: (issue.DeliveryMRs ?? []).map((mr) => ({ ...mr })) };
  issue.SetDeliveryMRState(mrURL, state);
  if (deliveryMRFieldsEqual(before, issue)) {
    return;
  }
  this.issues.PutIssue(issue);
};

/**
 * 比较两个工作项快照的交付 MR 相关字段（`DeliveryMRURL`、`DeliveryMRState` 与 `DeliveryMRs` 列表）是否完全相等。
 *
 * @param {Issue} a - 变更前的工作项快照。
 * @param {Issue} b - 变更后的工作项对象。
 * @returns {boolean} 所有交付 MR 字段均相等时返回 `true`，否则返回 `false`。
 */
function deliveryMRFieldsEqual(a, b) {
  if (a.DeliveryMRURL !== b.DeliveryMRURL || a.DeliveryMRState !== b.DeliveryMRState || (a.DeliveryMRs ?? []).length !== (b.DeliveryMRs ?? []).length) {
    return false;
  }
  for (let i = 0; i < (a.DeliveryMRs ?? []).length; i++) {
    // Go 按值比较结构体；JS 按 JSON 比较字段值。
    if (JSON.stringify(a.DeliveryMRs[i]) !== JSON.stringify(b.DeliveryMRs[i])) {
      return false;
    }
  }
  return true;
}

/**
 * 按一组 `(Project, IID)` 键批量查询 MR 交付状态，并以 `${Project}\x00${IID}` 为键返回映射表。
 *
 * @param {MRDeliveryKey[]} keys - 待查询的 MR 复合键列表。
 * @returns {Object<string, MRDeliveryState>} 以 `${Project}\x00${IID}` 为键的 MR 状态映射对象。
 */
DeliveryRepo.prototype.MRDeliveryStatesMap = function (keys) {
  const out = {};
  if (keys.length === 0) {
    return out;
  }
  const conditions = [];
  const args = [];
  for (const k of keys) {
    if (k.Project === "" || k.IID <= 0) {
      continue;
    }
    conditions.push("(mr_project = ? AND mr_iid = ?)");
    args.push(k.Project, k.IID);
  }
  if (conditions.length === 0) {
    return out;
  }
  const rows = [];
  if (this.DB.Where(conditions.join(" OR "), ...args).Find(rows).Error != null) {
    return out;
  }
  for (const row of rows) {
    const item = row.toDomain();
    // Go 用结构体值作 map 键；JS 用 project 与 iid 拼成的字符串键代替。
    out[`${item.MRProject}\x00${item.MRIID}`] = item;
  }
  return out;
};

/**
 * 查询需要轮询刷新的 MR 交付状态记录（未终态，或已合入但缺少目标分支/合入时间，且检查时间为空或早于 `staleBefore`）。
 * 未检查过的记录优先，其余按检查时间升序排列。
 *
 * @param {Date} staleBefore - 过期阈值时间（UTC）。
 * @returns {MRDeliveryState[]} 待刷新的 MR 交付状态数组。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
DeliveryRepo.prototype.MRDeliveryStatesNeedingRefresh = function (staleBefore) {
  const rows = [];
  const findErr = this.DB.
    Where("(state NOT IN ('merged', 'closed') OR (state='merged' AND (target_branch='' OR merged_at IS NULL))) AND (checked_at IS NULL OR checked_at < ?)", staleBefore).
    Order("checked_at IS NULL DESC, checked_at ASC").
    Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  const out = [];
  for (const row of rows) {
    out.push(row.toDomain());
  }
  return out;
};

/**
 * 按更新时间倒序查询全部 MR 交付状态记录。
 *
 * @returns {MRDeliveryState[]} 全部 MR 交付状态数组。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
DeliveryRepo.prototype.ListMRDeliveryStates = function () {
  const rows = [];
  const findErr = this.DB.Order("updated_at DESC").Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  const out = [];
  for (const row of rows) {
    out.push(row.toDomain());
  }
  return out;
};

/**
 * 扫描运行产物表（`run_artifacts`）中记录的工蜂 MR 链接，按产物优先级去重后批量登记到 `mr_delivery_states`。
 *
 * @returns {void} 无返回值。
 * @throws {Error} 查询产物表或登记 MR 状态失败时抛出错误。
 */
DeliveryRepo.prototype.DiscoverMRDeliveryStatesFromArtifacts = function () {
  const rows = [];
  const findErr = this.DB.Table("run_artifacts").
    Joins("JOIN runs r ON r.id = run_artifacts.run_id").
    Where("run_artifacts.content LIKE ? AND (run_artifacts.name IN ('mr-body','e2e-report','closeout') OR run_artifacts.node_id='mr' OR run_artifacts.name LIKE '%mr%') AND run_artifacts.name NOT LIKE '%patch%' AND run_artifacts.name NOT LIKE '%diff%'", "%merge_requests/%").
    Select("r.execution_context AS execution_context, run_artifacts.name AS name, run_artifacts.node_id AS node_id, run_artifacts.content AS content").
    Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  const seen = {};
  for (const row of rows) {
    const pri = MRArtifactPriority(row.Name, "", row.NodeID);
    if (pri <= 0) {
      continue;
    }
    const issueID = issueIDFromExecutionContext(row.ExecutionContext);
    for (const ref of ParseGongfengMRs(row.Content)) {
      const key = ref.Project + "#" + String(ref.IID);
      const cur = seen[key];
      if (cur !== undefined && (cur.pri > pri || (cur.pri === pri && cur.url.length >= ref.URL.length))) {
        continue;
      }
      seen[key] = { project: ref.Project, iid: ref.IID, url: ref.URL, issueID: issueID, pri: pri };
    }
  }
  for (const item of Object.values(seen)) {
    this.EnsureMRDeliveryState(item.project, item.iid, item.url, item.issueID);
  }
};

/**
 * 从运行记录的 `execution_context` JSON 字符串中提取关联的工作项 ID（`issueId`）。
 *
 * @param {string} raw - 原始 `execution_context` JSON 文本。
 * @returns {string} 提取出的工作项 ID；为空或解析失败时返回 `""`。
 */
function issueIDFromExecutionContext(raw) {
  raw = raw.trim();
  if (raw === "") {
    return "";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  // Go 按 json tag issueId 解码；JS 构造器认 Go 字段名，直接读小驼峰键。
  return (parsed.issueId ?? parsed.IssueID ?? "").trim();
}

// ---------- Delivery analytics ----------

/**
 * 需求维度交付分析的聚合累加器，累计单个需求（或 TAPD 外部故事分组）关联的全部运行指标、阶段耗时与 MR 候选列表。
 */
class deliveryAcc {
  /**
   * 构造并初始化需求交付累加器，未提供的字段按 Go 零值填充。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsDelivery();
    this.latest = init.latest ?? null;
    this.latestRun = init.latestRun ?? new Run();
    this.mrAt = init.mrAt ?? null;
    this.displayRank = init.displayRank ?? 0;
    this.mrs = init.mrs ?? [];
    // 该需求全部关联执行（含失败与返工）的累计节点求和耗时与执行次数。
    this.execDuration = init.execDuration ?? 0;
    this.runCount = init.runCount ?? 0;
    this.failedRuns = init.failedRuns ?? 0;
    this.reworks = init.reworks ?? 0;
    this.firstRunAt = init.firstRunAt ?? null;
    this.lastRunAt = init.lastRunAt ?? null;
    // 仅当全部关联执行的费用都可识别时为 true。
    this.costKnown = init.costKnown ?? false;
    this.runs = init.runs ?? [];
    this.clarificationDuration = init.clarificationDuration ?? 0;
    this.developmentDuration = init.developmentDuration ?? 0;
    this.testDuration = init.testDuration ?? 0;
    this.clarificationStart = init.clarificationStart ?? null;
    this.clarificationSource = init.clarificationSource ?? "";
    this.developmentStart = init.developmentStart ?? null;
    this.developmentSource = init.developmentSource ?? "";
    this.developmentRunID = init.developmentRunID ?? "";
    this.phaseSamples = init.phaseSamples ?? new AnalyticsPhaseSamples();
    this.phaseEvidence = init.phaseEvidence ?? [];
    this.unclassifiedPhaseNodes = init.unclassifiedPhaseNodes ?? 0;
  }

  /**
   * 按 `project + iid` 去重向累加器登记一个关联 MR，已存在时保留更完整的 URL、更晚时间与更高来源权重。
   *
   * @param {string} project - 工蜂项目标识。
   * @param {number} iid - MR 序号。
   * @param {string} url - MR 链接。
   * @param {Date|null} at - MR 出现或更新时间。
   * @param {number} sourceRank - 来源优先级权重（工作项交付字段高于运行产物）。
   * @returns {void} 无返回值。
   */
  addMR(project, iid, url, at, sourceRank) {
    for (let i = 0; i < this.mrs.length; i++) {
      if (this.mrs[i].project === project && this.mrs[i].iid === iid) {
        if (url !== "" && this.mrs[i].url === "") {
          this.mrs[i].url = url;
        }
        if (timeAfter(at, this.mrs[i].createdAt)) {
          this.mrs[i].createdAt = at;
        }
        if (sourceRank > this.mrs[i].sourceRank) {
          this.mrs[i].sourceRank = sourceRank;
        }
        return;
      }
    }
    this.mrs.push(new mrRef({ project: project, iid: iid, url: url, createdAt: at, sourceRank: sourceRank }));
  }

  /**
   * 从文本中解析全部工蜂 MR 链接并登记到累加器，按来源权重与时间挑选默认展示 MR。
   *
   * @param {string} text - 包含 MR 链接的文本。
   * @param {Date|null} at - 文本对应的时间戳。
   * @param {number} sourceRank - 来源优先级权重。
   * @returns {void} 无返回值。
   */
  addMRsFromText(text, at, sourceRank) {
    const refs = ParseGongfengMRs(text);
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      this.addMR(ref.Project, ref.IID, ref.URL, at, sourceRank);
      if (i > 0) {
        continue;
      }
      if (this.item.MRURL !== "" && sourceRank < this.displayRank) {
        continue;
      }
      if (this.item.MRURL !== "" && sourceRank === this.displayRank && !timeAfter(at, this.mrAt)) {
        continue;
      }
      this.displayRank = sourceRank;
      this.mrAt = at;
      this.item.MRURL = ref.URL;
      this.item.MRProject = ref.Project;
      this.item.MRIID = ref.IID;
      this.item.MRState = "unknown";
    }
  }
}

/**
 * 提取单次运行在澄清、研发与测试三个阶段的耗时毫秒数三元组。
 *
 * @param {Run} run - 运行记录。
 * @param {WorkflowDefinition} fallback - 当运行未携带冻结快照时使用的兜底工作流定义。
 * @returns {[number, number, number]} 返回 `[澄清耗时ms, 研发耗时ms, 测试耗时ms]`。
 */
function requirementPhaseDurations(run, fallback) {
  const measurements = requirementPhaseMeasurements(run, fallback);
  return [measurements.clarification, measurements.development, measurements.test];
}

/**
 * 单次运行的需求阶段耗时与证据度量结果。
 */
class phaseMeasurements {
  /**
   * 构造并初始化阶段度量结果实例，未提供的字段按 Go 零值填充。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.clarification = init.clarification ?? 0;
    this.development = init.development ?? 0;
    this.test = init.test ?? 0;
    this.clarificationStart = init.clarificationStart ?? null;
    this.clarificationStartSource = init.clarificationStartSource ?? "";
    this.developmentStart = init.developmentStart ?? null;
    this.developmentStartSource = init.developmentStartSource ?? "";
    this.samples = init.samples ?? new AnalyticsPhaseSamples();
    this.evidence = init.evidence ?? [];
    this.unclassified = init.unclassified ?? 0;
  }
}

/**
 * 遍历单次运行的全部节点执行记录，按工作流节点声明或启发式推断归类到澄清/研发/测试阶段并汇总耗时与证据。
 * 跳过组合型 `"sop"` 节点以免与其子运行重复计入时长。
 *
 * @param {Run} run - 运行记录。
 * @param {WorkflowDefinition} fallback - 运行缺少冻结工作流快照时的兜底定义。
 * @returns {phaseMeasurements} 阶段耗时、起止时间、样本计数与证据明细。
 */
function requirementPhaseMeasurements(run, fallback) {
  const result = new phaseMeasurements();
  let workflow = run.WorkflowSnapshot;
  const frozenDefinition = workflow.ID !== "";
  if (workflow.ID === "") {
    workflow = fallback;
  }
  const definitions = {};
  for (const node of workflow.Nodes ?? []) {
    definitions[node.ID] = node;
  }
  const lane = InferSOPLane(workflow);
  for (const [nodeID, nodeRun] of Object.entries(run.Nodes ?? {})) {
    if (nodeRun == null || isZeroTime(nodeRun.StartedAt)) {
      continue;
    }
    const definition = definitions[nodeID] ?? new WorkflowNode();
    // 组合 SOP 节点包裹了其子运行，两者同时计入会重复统计墙钟耗时。
    if (definition.Type === "sop") {
      continue;
    }
    const [stage, source] = nodeMetricStage(nodeID, definition, lane, frozenDefinition);
    if (stage === "clarification" && (isZeroTime(result.clarificationStart) || timeBefore(nodeRun.StartedAt, result.clarificationStart))) {
      result.clarificationStart = nodeRun.StartedAt;
      result.clarificationStartSource = source;
    }
    if (stage === "development" && (isZeroTime(result.developmentStart) || timeBefore(nodeRun.StartedAt, result.developmentStart))) {
      result.developmentStart = nodeRun.StartedAt;
      result.developmentStartSource = source;
    }
    if (isZeroTime(nodeRun.FinishedAt) || timeBefore(nodeRun.FinishedAt, nodeRun.StartedAt)) {
      continue;
    }
    const duration = nodeRun.FinishedAt.getTime() - nodeRun.StartedAt.getTime();
    switch (stage) {
      case "clarification":
        result.clarification += duration;
        result.samples.Clarification++;
        break;
      case "development":
        result.development += duration;
        result.samples.Development++;
        break;
      case "testing":
        result.test += duration;
        result.samples.Testing++;
        break;
      default:
        if (stage !== "none") {
          result.unclassified++;
        }
        continue;
    }
    if (source === "inferred") {
      result.samples.Inferred++;
    }
    result.evidence.push(new AnalyticsPhaseEvidence({
      RunID: run.ID, NodeID: nodeID, Stage: stage, Source: source, DurationMs: duration,
    }));
  }
  result.evidence.sort((a, b) => {
    if (a.RunID !== b.RunID) {
      return a.RunID < b.RunID ? -1 : 1;
    }
    if (a.NodeID !== b.NodeID) {
      return a.NodeID < b.NodeID ? -1 : 1;
    }
    return 0;
  });
  return result;
}

/**
 * 解析工作流节点归属的需求度量阶段及其来源（`"explicit"` 或 `"inferred"`）。
 * 仅当节点显式配置了 `MetricStage` 且来自运行冻结的工作流快照时标记为 `"explicit"`，其余按旧规则推断。
 *
 * @param {string} nodeID - 节点 ID。
 * @param {WorkflowNode} definition - 节点定义对象。
 * @param {string} lane - 工作流推断的业务泳道。
 * @param {boolean} frozenDefinition - 工作流定义是否来自运行的冻结快照。
 * @returns {[string, string]} 返回 `[阶段名, 来源标识]`。
 */
function nodeMetricStage(nodeID, definition, lane, frozenDefinition) {
  const stage = definition.MetricStage.trim();
  if (stage === "") {
    return [inferLegacyMetricStage(nodeID, definition.Name, lane), "inferred"];
  }
  if (!frozenDefinition) {
    return [stage, "inferred"];
  }
  return [stage, "explicit"];
}

/**
 * 根据历史节点 ID、节点名称与工作流泳道关键词启发式推断节点所属度量阶段。
 *
 * @param {string} nodeID - 节点 ID。
 * @param {string} name - 节点名称。
 * @param {string} lane - 工作流泳道。
 * @returns {string} 推断出的阶段名（`"clarification"`、`"testing"`、`"development"` 或 `""`）。
 */
function inferLegacyMetricStage(nodeID, name, lane) {
  const text = (nodeID + " " + name).trim().toLowerCase();
  if (text.includes("澄清") || text.includes("需求确认") || text.includes("clarif") || text.includes("requirement-shaping")) {
    return "clarification";
  }
  if (text.includes("测试") || text.includes("验证") || text.includes("验收") || text.includes("test") || text.includes("verify") || text.includes(" qa")) {
    return "testing";
  }
  if (text.includes("研发") || text.includes("开发") || text.includes("前端") || text.includes("后端") || text.includes("implement") || text.includes("coding") || text.includes("frontend") || text.includes("backend")) {
    return "development";
  }
  if (lane === SOPLaneProduct || lane === SOPLaneDesign) {
    return "clarification";
  }
  return "";
}

/**
 * 记录某个工作项在聚合分析期间关联到的单个 MR 引用及来源优先级。
 */
class mrRef {
  /**
   * 构造并初始化 MR 引用对象，未提供的字段按 Go 零值填充。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.project = init.project ?? "";
    this.iid = init.iid ?? 0;
    this.url = init.url ?? "";
    this.createdAt = init.createdAt ?? null;
    this.sourceRank = init.sourceRank ?? 0;
  }
}

/**
 * 生成需求交付聚合分组键：TAPD 需求按外部故事 ID 与项目归并，避免重复导入导致吞吐量重复计数；其余按本地工作项 ID 分组。
 *
 * @param {string} issueID - 本地工作项 ID。
 * @param {Issue} issue - 工作项对象。
 * @param {Run} run - 关联运行记录（用于工作项缺少项目 ID 时兜底取 `ExecutionContext.ProjectID`）。
 * @returns {string} 分组键字符串。
 */
function deliveryGroupKey(issueID, issue, run) {
  const externalID = issue.RequirementTAPDID();
  if (externalID !== "") {
    let projectID = issue.ProjectID.trim();
    if (projectID === "") {
      projectID = run.ExecutionContext.ProjectID.trim();
    }
    return "tapd\x00" + projectID + "\x00" + externalID;
  }
  return "issue\x00" + issueID;
}

/**
 * 判断单次运行在给定过滤条件下是否计入需求交付统计，若计入则返回其工作项 ID。
 * 由 `buildDeliveries` 与 `countDeliveryGroups` 共用，保证总览计数与交付列表一致。
 *
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析过滤条件。
 * @param {Run} run - 运行记录。
 * @param {Object<string, Issue>} issues - 按工作项 ID 索引的工作项字典。
 * @returns {[string, boolean]} 返回 `[工作项 ID, 是否计入]`。
 */
function deliveryRunIssueID(filter, run, issues) {
  const issueID = run.ExecutionContext.IssueID.trim();
  if (issueID === "") {
    return ["", false];
  }
  if (filter.WorkflowID !== "" && run.WorkflowID !== filter.WorkflowID) {
    return ["", false];
  }
  if (!analyticsRunInWindow(run, filter)) {
    return ["", false];
  }
  const issue = issues[issueID] ?? new Issue();
  if (filter.UserID !== "" && !analyticsRunMatchesUser(run, filter.UserID, issue)) {
    return ["", false];
  }
  if (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issue, filter.IssueSource)) {
    return ["", false];
  }
  if (filter.RequirementsOnly && !analyticsIsRequirementIssue(issue)) {
    return ["", false];
  }
  return [issueID, true];
}

/**
 * 计算满足过滤条件的去重需求交付分组数量，对应总览卡片数字（不触发 MR 查询与阶段耗时计算）。
 *
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析过滤条件。
 * @param {Run[]} runs - 待统计的运行记录列表。
 * @param {Object<string, Issue>} issues - 按工作项 ID 索引的工作项字典。
 * @returns {number} 去重后的交付需求分组数。
 */
function countDeliveryGroups(filter, runs, issues) {
  const groups = {};
  for (const run of runs) {
    const [issueID, ok] = deliveryRunIssueID(filter, run, issues);
    if (!ok) {
      continue;
    }
    groups[deliveryGroupKey(issueID, issues[issueID] ?? new Issue(), run)] = true;
  }
  return Object.keys(groups).length;
}

/**
 * 按需求分组聚合全部关联运行，输出带用量、周期/阶段耗时、泳道摘要与 MR 交付状态的 `AnalyticsDelivery` 列表。
 * 允许调用方传入已加载的 `issues` 快照以复用；传 `null` 时内部自动加载全部工作项。
 *
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析过滤条件。
 * @param {Date} now - 统计基准时间。
 * @param {Run[]} runs - 运行记录数组。
 * @param {Object<string, WorkflowDefinition>} workflowDefs - 按工作流 ID 索引的工作流定义字典。
 * @param {Object<string, Issue>|null} issues - 可选预加载的工作项字典。
 * @returns {AnalyticsDelivery[]} 排序并填充好 MR 状态的交付分析条目数组。
 */
DeliveryRepo.prototype.buildDeliveries = function (filter, now, runs, workflowDefs, issues) {
  const byIssue = {};
  if (issues == null) {
    issues = {};
    for (const issue of this.issues.Issues()) {
      issues[issue.ID] = issue;
    }
  }
  const clarificationByGroup = {};
  for (const [issueID, issue] of Object.entries(issues)) {
    const started = issue.Clarification.StartedAt;
    if (isZeroTime(started)) {
      continue;
    }
    const key = deliveryGroupKey(issueID, issue, new Run());
    const prior = clarificationByGroup[key] ?? null;
    if (prior == null || timeBefore(started, prior)) {
      clarificationByGroup[key] = started;
    }
  }
  const mrRuns = [];
  for (const run of runs) {
    const [, ok] = deliveryRunIssueID(filter, run, issues);
    if (ok) {
      mrRuns.push(run);
    }
  }
  const mrText = this.mrTextsByRun(mrRuns);
  for (const run of runs) {
    const [issueID, ok] = deliveryRunIssueID(filter, run, issues);
    if (!ok) {
      continue;
    }
    const groupKey = deliveryGroupKey(issueID, issues[issueID] ?? new Issue(), run);
    let acc = byIssue[groupKey] ?? null;
    if (acc == null) {
      acc = new deliveryAcc({ item: new AnalyticsDelivery({ IssueID: issueID, MRState: "none" }), costKnown: true });
      const started = clarificationByGroup[groupKey] ?? null;
      if (!isZeroTime(started)) {
        acc.clarificationStart = started;
        acc.clarificationSource = "recorded";
      }
      byIssue[groupKey] = acc;
    }
    // 需求维度的 Token/成本累计其全部关联执行，包含失败与返工。
    acc.item.Tokens += run.Usage.TotalTokens;
    acc.item.CostUSD += run.Usage.CostUSD;
    acc.costKnown = acc.costKnown && usageCostKnown(run.Usage);
    // 对话工作区无 SOP 图：只计入用量与活动时间跨度，不计为 SOP 执行或阶段样本。
    if (run.IsWorkspace()) {
      if (isZeroTime(acc.firstRunAt) || timeBefore(run.CreatedAt, acc.firstRunAt)) {
        acc.firstRunAt = run.CreatedAt;
      }
      const ended = run.UpdatedAt;
      if (timeAfter(ended, acc.lastRunAt)) {
        acc.lastRunAt = ended;
      }
      if (acc.latestRun.ID === "" || (acc.latestRun.IsWorkspace() && timeAfter(run.CreatedAt, acc.latest))) {
        acc.latest = run.CreatedAt;
        acc.latestRun = run;
        acc.item.IssueID = issueID;
      }
      continue;
    }
    // 嵌套子 SOP 运行归属于父节点内部：累计用量、阶段与返工，但不重复计入顶层运行次数与执行耗时。
    const nested = run.ExecutionContext.ParentRunID.trim() !== "";
    if (!nested) {
      acc.execDuration += runExecutionDuration(run);
    }
    const phase = requirementPhaseMeasurements(run, workflowDefs[run.WorkflowID] ?? new WorkflowDefinition());
    acc.developmentDuration += phase.development;
    acc.testDuration += phase.test;
    acc.phaseSamples.Development += phase.samples.Development;
    acc.phaseSamples.Testing += phase.samples.Testing;
    acc.phaseSamples.Inferred += phase.samples.Inferred;
    for (const evidence of phase.evidence) {
      if (evidence.Stage !== "clarification") {
        acc.phaseEvidence.push(evidence);
      }
    }
    {
      const started = phase.clarificationStart;
      if (!isZeroTime(started) && (isZeroTime(acc.clarificationStart) || timeBefore(started, acc.clarificationStart))) {
        acc.clarificationStart = started;
        acc.clarificationSource = phase.clarificationStartSource;
      }
    }
    {
      const started = phase.developmentStart;
      if (!isZeroTime(started) && (isZeroTime(acc.developmentStart) || timeBefore(started, acc.developmentStart))) {
        acc.developmentStart = started;
        acc.developmentSource = phase.developmentStartSource;
        acc.developmentRunID = run.ID;
      }
    }
    acc.unclassifiedPhaseNodes += phase.unclassified;
    acc.reworks += runReworks(run);
    if (!nested) {
      acc.runCount++;
      if (run.Status === "failed") {
        acc.failedRuns++;
      }
    }
    if (isZeroTime(acc.firstRunAt) || timeBefore(run.CreatedAt, acc.firstRunAt)) {
      acc.firstRunAt = run.CreatedAt;
    }
    const ended = runEndedAt(run, now);
    if (timeAfter(ended, acc.lastRunAt)) {
      acc.lastRunAt = ended;
    }
    const latestNested = acc.latestRun.ExecutionContext.ParentRunID.trim() !== "";
    const newer = isZeroTime(acc.latest) || timeAfter(run.CreatedAt, acc.latest);
    if (acc.latestRun.ID === "" || acc.latestRun.IsWorkspace() || (!nested && (latestNested || newer)) || (nested && latestNested && newer)) {
      acc.latest = run.CreatedAt;
      acc.latestRun = run;
      acc.item.IssueID = issueID;
    }
    acc.runs.push(run);
    let text = mrText[run.ID] ?? "";
    if (text === "") {
      text = runMRText(run);
    }
    acc.addMRsFromText(text, run.CreatedAt, 40);
  }
  const out = [];
  const mrsByIssue = {};
  const projectCache = {};
  for (const acc of Object.values(byIssue)) {
    const issueID = acc.item.IssueID;
    const run = acc.latestRun;
    acc.item.RunID = run.ID;
    acc.item.RunStatus = run.Status;
    acc.item.SOPSucceeded = !run.IsWorkspace() && run.Status === "succeeded";
    acc.item.DirectDelivery = run.IsWorkspace();
    acc.item.WorkflowID = run.WorkflowID;
    acc.item.WorkflowName = run.WorkflowSnapshot.Name;
    if (run.IsWorkspace()) {
      acc.item.WorkflowName = "对话改代码";
    }
    if (acc.item.WorkflowName === "") {
      acc.item.WorkflowName = (workflowDefs[run.WorkflowID] ?? new WorkflowDefinition()).Name;
    }
    if (acc.item.WorkflowName === "") {
      acc.item.WorkflowName = run.WorkflowID;
    }
    let duration;
    [duration] = analyticsRunDuration(run, now);
    if (run.IsWorkspace()) {
      duration = 0;
    }
    acc.item.DurationMs = duration;
    acc.item.RunCount = acc.runCount;
    acc.item.FailedRuns = acc.failedRuns;
    acc.item.Reworks = acc.reworks;
    // 执行耗时为该需求全部执行按 SOP 节点求和的累计值；周期耗时为首次执行开始到最后一次执行结束。
    acc.item.ExecutionDurationMs = acc.execDuration;
    if (!isZeroTime(acc.clarificationStart) && !isZeroTime(acc.developmentStart) && !timeBefore(acc.developmentStart, acc.clarificationStart)) {
      acc.clarificationDuration = acc.developmentStart.getTime() - acc.clarificationStart.getTime();
      acc.phaseSamples.Clarification = 1;
      acc.item.ClarificationStartedAt = acc.clarificationStart;
      acc.item.DevelopmentStartedAt = acc.developmentStart;
      let source = "explicit";
      if (acc.clarificationSource === "inferred" || acc.developmentSource === "inferred") {
        source = "inferred";
      }
      acc.phaseEvidence.push(new AnalyticsPhaseEvidence({ RunID: acc.developmentRunID, NodeID: "clarification-to-development", Stage: "clarification", Source: source, DurationMs: acc.clarificationDuration, StartedAt: acc.clarificationStart, FinishedAt: acc.developmentStart }));
    }
    acc.item.ClarificationDurationMs = acc.clarificationDuration;
    acc.item.DevelopmentDurationMs = acc.developmentDuration;
    acc.item.TestDurationMs = acc.testDuration;
    acc.item.PhaseSamples = acc.phaseSamples;
    acc.item.PhaseEvidence = acc.phaseEvidence;
    acc.item.UnclassifiedPhaseNodes = acc.unclassifiedPhaseNodes;
    acc.item.FirstRunAt = acc.firstRunAt;
    acc.item.LastRunAt = acc.lastRunAt;
    if (!isZeroTime(acc.firstRunAt) && timeAfter(acc.lastRunAt, acc.firstRunAt)) {
      acc.item.CycleDurationMs = acc.lastRunAt.getTime() - acc.firstRunAt.getTime();
    }
    acc.item.UserID = analyticsRunUserID(run, issues[issueID] ?? new Issue());
    acc.item.Category = analyticsWorkflowCategory(run.WorkflowSnapshot, workflowDefs[run.WorkflowID] ?? new WorkflowDefinition());
    acc.item.CostKnown = acc.costKnown;
    let project = new Project();
    const issue = issues[issueID];
    if (issue !== undefined && this.catalog != null && this.catalog.projects != null) {
      let cached = projectCache[issue.ProjectID];
      if (cached === undefined) {
        [cached] = this.catalog.projects.Project(issue.ProjectID);
        projectCache[issue.ProjectID] = cached;
      }
      project = cached;
    }
    acc.item.Lanes = compactDeliveryLanes(BuildRequirementSnapshot(issues[issueID] ?? new Issue(), project, acc.runs, null, workflowDefs, now).Lanes);
    if (issue !== undefined) {
      acc.item.Title = issue.Title;
      acc.item.Source = issue.Source;
      if (acc.item.Source === "") {
        acc.item.Source = "local";
      }
      if (issue.ExternalRef != null) {
        acc.item.ExternalIID = issue.ExternalRef.ExternalIID;
        acc.item.IssueURL = issue.ExternalRef.ExternalURL;
      }
      acc.item.ExternalID = issue.RequirementTAPDID();
      for (const mr of issue.DeliveryMRList() ?? []) {
        acc.addMRsFromText(mr.URL, issue.DeliveryUpdatedAt, 100);
      }
    } else {
      acc.item.Title = issueID;
      acc.item.Source = "local";
    }
    if (acc.item.MRURL === "") {
      acc.item.MRState = "none";
    }
    // 即使运行无产物，也保留工作项本身记录的 MR 链接参与状态批量查询。
    mrsByIssue[issueID] = acc.mrs;
    out.push(acc.item);
  }
  out.sort((a, b) => {
    if (a.Delivered !== b.Delivered) {
      return a.Delivered ? -1 : 1;
    }
    if (a.SOPSucceeded !== b.SOPSucceeded) {
      return a.SOPSucceeded ? -1 : 1;
    }
    if (a.RunID !== b.RunID) {
      return a.RunID > b.RunID ? -1 : 1;
    }
    return 0;
  });
  this.applyMRDeliveryStates(out, mrsByIssue, issues);
  return out;
};

/**
 * 将工作项自身记录的 MR 状态叠加到数据库查出的 MR 状态上：
 * 查询为空或 `"unknown"` 时回退采用工作项记录，否则仅允许向更高等级升级。
 *
 * @param {string} state - 查库并分类得到的 MR 状态。
 * @param {string} url - 目标 MR 链接。
 * @param {DeliveryMR[]|null} own - 工作项自身记录的交付 MR 列表。
 * @returns {string} 叠加后的有效 MR 状态。
 */
function overlayIssueMRState(state, url, own) {
  for (const mr of own ?? []) {
    if (!SameGongfengMR(mr.URL, url)) {
      continue;
    }
    if (state === "" || state === "unknown") {
      if (mr.State !== "") {
        return mr.State;
      }
      return state;
    }
    return EffectiveAnalyticsMRState(state, mr.State);
  }
  return state;
}

/**
 * 批量登记并查询本批次交付分析条目关联的全部 MR 状态，为每条交付项选出最优展示 MR 与最终 `Delivered` 标记。
 *
 * @param {AnalyticsDelivery[]} items - 待补充 MR 状态的交付分析条目数组（原地更新）。
 * @param {Object<string, mrRef[]>} mrsByIssue - 按工作项 ID 索引的候选 MR 列表。
 * @param {Object<string, Issue>} issues - 按工作项 ID 索引的工作项字典。
 * @returns {void} 无返回值。
 */
DeliveryRepo.prototype.applyMRDeliveryStates = function (items, mrsByIssue, issues) {
  if (items.length === 0) {
    return;
  }
  // 收集该批次所有工作项关联到的全部 MR（不只是展示用的那个），逐一登记并批量查状态。
  const keySet = {};
  const ensured = {};
  const ensure = (project, iid, url, issueID) => {
    if (project === "" || iid <= 0) {
      return;
    }
    const ensureKey = `${project}\x00${iid}\x00${url}\x00${issueID}`;
    if (!ensured[ensureKey]) {
      try {
        this.EnsureMRDeliveryState(project, iid, url, issueID);
      } catch {
        // Go 忽略此处的错误返回值。
      }
      ensured[ensureKey] = true;
    }
    keySet[`${project}\x00${iid}`] = true;
  };
  for (let i = 0; i < items.length; i++) {
    for (const ref of mrsByIssue[items[i].IssueID] ?? []) {
      ensure(ref.project, ref.iid, ref.url, items[i].IssueID);
    }
    // 兜底：展示用的 MR 一般已在 mrs 中，这里再确保一次。
    ensure(items[i].MRProject, items[i].MRIID, items[i].MRURL, items[i].IssueID);
  }
  if (Object.keys(keySet).length === 0) {
    for (let i = 0; i < items.length; i++) {
      const issue = issues[items[i].IssueID];
      if (issue !== undefined) {
        items[i].MRState = EffectiveAnalyticsMRState(items[i].MRState, issue.DeliveryMRState);
      }
      FinalizeAnalyticsDelivery(items[i]);
    }
    return;
  }
  const keys = [];
  for (const k of Object.keys(keySet)) {
    const [project, iid] = k.split("\x00");
    keys.push(new MRDeliveryKey({ Project: project, IID: Number(iid) }));
  }
  const states = this.MRDeliveryStatesMap(keys);
  const repositories = this.catalog.Repositories();
  const classify = (st) => {
    let def = "";
    let integ = DefaultIntegrateBranch;
    for (const repository of repositories) {
      if (repository.GongfengProjectID.trim().toLowerCase() === st.MRProject.trim().toLowerCase()) {
        def = repository.DefaultBranch.trim();
        integ = repository.IntegrateBranch.trim();
        break;
      }
    }
    return ClassifyMRDeliveryState(st.State, st.TargetBranch, def, integ);
  };
  for (let i = 0; i < items.length; i++) {
    // 同一需求可能跑多次、提多个 MR：合入默认分支为 merged，合入集成分支为 integrated，按优先级选最佳展示 MR。
    let preferProject = "";
    let preferIID = 0;
    const issueForPrefer = issues[items[i].IssueID];
    if (issueForPrefer !== undefined) {
      const [p, iid, , ok] = ParseDeliveryMRURL(issueForPrefer.DeliveryMRURL);
      if (ok) {
        preferProject = p;
        preferIID = iid;
      }
    }
    const own = (issues[items[i].IssueID] ?? new Issue()).DeliveryMRList() ?? [];
    let best = null;
    let bestState = "";
    items[i].MRs = [];
    const seen = {};
    for (const ref of mrsByIssue[items[i].IssueID] ?? []) {
      if (ref.project === "" || ref.iid <= 0) {
        continue;
      }
      const st = states[`${ref.project}\x00${ref.iid}`];
      const ok = st !== undefined;
      const mr = new DeliveryMR({ Project: ref.project, IID: ref.iid, URL: ref.url, State: "unknown", TargetBranch: st !== undefined ? st.TargetBranch : "" });
      if (ok) {
        mr.State = classify(st);
      }
      mr.State = overlayIssueMRState(mr.State, mr.URL, own);
      const key = `${ref.project.toLowerCase()}\x00${ref.iid}`;
      if (!seen[key]) {
        items[i].MRs.push(mr);
        seen[key] = true;
      }
      if (!ok) {
        continue;
      }
      const classified = classify(st);
      if (classified === "") {
        continue;
      }
      if (best == null || betterAnalyticsMR(preferProject, preferIID, best, bestState, ref, classified)) {
        best = { ...ref };
        bestState = classified;
      }
    }
    if (best != null && AnalyticsMRRank(bestState) > 0) {
      items[i].MRProject = best.project;
      items[i].MRIID = best.iid;
      if (best.url !== "") {
        items[i].MRURL = best.url;
      }
      items[i].MRState = bestState;
    } else if (items[i].MRProject !== "" && items[i].MRIID > 0) {
      const st = states[`${items[i].MRProject}\x00${items[i].MRIID}`];
      if (st !== undefined) {
        // 未分类（unknown）的查询结果不得把运行或锁定工作项已有状态降级。
        const classified = classify(st);
        if (classified !== "" && classified !== "unknown") {
          items[i].MRState = classified;
        }
      }
    }
    const issue = issues[items[i].IssueID];
    if (issue !== undefined) {
      items[i].MRState = EffectiveAnalyticsMRState(items[i].MRState, issue.DeliveryMRState);
    }
    FinalizeAnalyticsDelivery(items[i]);
  }
};

/**
 * 比较候选 MR `next` 是否比当前最优 MR `best` 更适合作为交付分析主展示 MR。
 * 优先级依次为：MR 状态等级 > 是否匹配工作项首选 MR > 来源权重 > 创建时间更晚。
 *
 * @param {string} preferProject - 工作项首选 MR 所属项目。
 * @param {number} preferIID - 工作项首选 MR IID。
 * @param {mrRef} best - 当前最优候选 MR。
 * @param {string} bestState - 当前最优候选 MR 的分类状态。
 * @param {mrRef} next - 待比较的新候选 MR。
 * @param {string} nextState - 新候选 MR 的分类状态。
 * @returns {boolean} `next` 优于 `best` 时返回 `true`，否则返回 `false`。
 */
function betterAnalyticsMR(preferProject, preferIID, best, bestState, next, nextState) {
  const bestRank = AnalyticsMRRank(bestState);
  const nextRank = AnalyticsMRRank(nextState);
  if (nextRank !== bestRank) {
    return nextRank > bestRank;
  }
  const bestPref = preferIID > 0 && best.project.toLowerCase() === preferProject.toLowerCase() && best.iid === preferIID;
  const nextPref = preferIID > 0 && next.project.toLowerCase() === preferProject.toLowerCase() && next.iid === preferIID;
  if (nextPref !== bestPref) {
    return nextPref;
  }
  if (next.sourceRank !== best.sourceRank) {
    return next.sourceRank > best.sourceRank;
  }
  return timeAfter(next.createdAt, best.createdAt);
}

/**
 * 提取单次运行解析出的全部交付 MR 链接并以换行符拼接。
 *
 * @param {Run} run - 运行记录。
 * @returns {string} 换行分隔的 MR URL 文本。
 */
function runMRText(run) {
  const urls = [];
  for (const mr of ResolveRunDeliveryMRs(run, null)) {
    urls.push(mr.URL);
  }
  return urls.join("\n");
}

/**
 * 按运行 ID 批量查询包含 MR 链接的运行产物并提取对应的 MR 文本映射。
 * 超过 500 条运行时按 500 条分片递归查询，避免单条 SQL `IN` 列表过大。
 *
 * @param {Run[]} runs - 运行记录数组。
 * @returns {Object<string, string>} 以运行 ID 为键、换行分隔的 MR URL 文本为值的映射对象。
 */
DeliveryRepo.prototype.mrTextsByRun = function (runs) {
  const out = {};
  if (runs.length === 0) {
    return out;
  }
  if (runs.length > 500) {
    for (let start = 0; start < runs.length; start += 500) {
      const chunk = this.mrTextsByRun(runs.slice(start, Math.min(start + 500, runs.length)));
      for (const [id, value] of Object.entries(chunk)) {
        out[id] = value;
      }
    }
    return out;
  }
  const ids = [];
  const byID = {};
  for (const run of runs) {
    ids.push(run.ID);
    byID[run.ID] = run;
  }
  const rows = [];
  const findErr = this.DB.Where("run_id IN ? AND content LIKE ? AND name NOT LIKE ? AND name NOT LIKE ?", ids, "%merge_requests/%", "%patch%", "%diff%").
    Select("run_id", "name", "path", "node_id", "content").Order("created_at, id").Find(rows).Error;
  if (findErr != null) {
    return out;
  }
  for (const row of rows) {
    const run = byID[row.RunID] ?? new Run();
    run.Artifacts.push(new Artifact({ Name: row.Name, Path: row.Path, NodeID: row.NodeID, Content: row.Content }));
    byID[row.RunID] = run;
  }
  for (const [id, run] of Object.entries(byID)) {
    out[id] = runMRText(run);
  }
  return out;
};

/**
 * 精简需求泳道数组，清空每条泳道的 `Stages` 明细以减小交付列表响应体积。
 *
 * @param {Object[]|null} lanes - 原始需求泳道列表。
 * @returns {Object[]|null} 精简后的泳道副本数组；输入为空时返回 `null`。
 */
function compactDeliveryLanes(lanes) {
  if ((lanes ?? []).length === 0) {
    return null;
  }
  const out = [];
  for (const lane of lanes) {
    out.push({ ...lane, Stages: null });
  }
  return out;
}

module.exports = { DeliveryRepo, deliveryAcc, phaseMeasurements, mrRef, mrDeliveryStateDB, mrDeliveryRowValues, singleDeliveryMR, issueDeliverySkipped, deliveryMRFieldsEqual, deliveryGroupKey, deliveryRunIssueID, countDeliveryGroups, requirementPhaseDurations, requirementPhaseMeasurements, nodeMetricStage, inferLegacyMetricStage, overlayIssueMRState, betterAnalyticsMR, runMRText, compactDeliveryLanes, issueIDFromExecutionContext, isZeroTime, timeMs, timeBefore, timeAfter };
