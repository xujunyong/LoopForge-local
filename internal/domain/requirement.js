/**
 * @file internal/domain/requirement.js
 * @description 对应 Go 源文件：internal/domain/requirement.go
 * 职责边界：定义需求总览快照视图所需的数据模型，包括节点阶段、多通道执行进度、总体汇总指标以及对话工作区关联分支信息。
 * 语法差异说明：
 * - Go 的 `time.Time` 对应 JS 的 `Date | null`（零值为 `null`）。
 * - Go 的指针字段（如 `*RequirementConversation`）零值为 `null`。
 */

"use strict";

const { Issue } = require("./issue.js");

/**
 * 需求进度视图中的单个节点阶段状态。
 * 支持通过 `ChildRunID` 和 `Children` 嵌套展示由 SOP 节点触发的子运行节点阶段。
 */
class RequirementNodeStage {
  /**
   * 构造需求节点阶段实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.NodeID=""] - 节点 ID。
   * @param {string} [init.Name=""] - 节点名称。
   * @param {string} [init.Status=""] - 节点执行状态。
   * @param {number} [init.DurationMs=0] - 节点执行耗时（毫秒）。
   * @param {string} [init.ChildRunID=""] - 子 SOP 运行 ID（如有）。
   * @param {RequirementNodeStage[]} [init.Children=[]] - 子 SOP 展开后的节点阶段列表。
   */
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Name = init.Name ?? "";
    this.Status = init.Status ?? "";
    this.DurationMs = init.DurationMs ?? 0;
    // ChildRunID 与 Children 描述 SOP 节点启动的子运行。
    this.ChildRunID = init.ChildRunID ?? "";
    this.Children = init.Children ?? [];
  }
}

/**
 * 需求的一条 SOP 执行通道（Lane）进度汇总。
 * 描述通道绑定的工作流、最新运行/任务、成败次数、Token 与费用统计、依赖关系及节点阶段列表。
 */
class RequirementLane {
  /**
   * 构造需求执行通道实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.BindingID=""] - SOP 绑定 ID。
   * @param {string} [init.Lane=""] - 通道标识键。
   * @param {string} [init.Label=""] - 通道展示标签。
   * @param {string} [init.WorkflowID=""] - 关联工作流 ID。
   * @param {string} [init.WorkflowName=""] - 关联工作流名称。
   * @param {string} [init.LatestRunID=""] - 最新一次运行 ID。
   * @param {string} [init.LatestTaskID=""] - 最新一次任务 ID。
   * @param {string} [init.Status=""] - 通道当前状态。
   * @param {boolean} [init.Started=false] - 该通道是否已启动执行。
   * @param {number} [init.RunCount=0] - 累计运行次数。
   * @param {number} [init.FailedRuns=0] - 累计失败次数。
   * @param {number} [init.Tokens=0] - 累计消耗 Token 数。
   * @param {number} [init.CostUSD=0] - 累计估算或上报成本（美元）。
   * @param {number} [init.ExecutionDurationMs=0] - 累计执行耗时（毫秒）。
   * @param {number} [init.AssigneeUserID=0] - 通道负责人用户 ID。
   * @param {number} [init.Order=0] - 通道排列顺序。
   * @param {string[]} [init.DependsOn=[]] - 依赖的前置通道标识列表。
   * @param {string[]} [init.Handoff=[]] - 交接给下游的产物或字段列表。
   * @param {boolean} [init.Orphan=false] - 是否为已从当前组合移除的孤立历史通道。
   * @param {RequirementNodeStage[]} [init.Stages=[]] - 通道内各节点阶段状态列表。
   */
  constructor(init = {}) {
    this.BindingID = init.BindingID ?? "";
    this.Lane = init.Lane ?? "";
    this.Label = init.Label ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.WorkflowName = init.WorkflowName ?? "";
    this.LatestRunID = init.LatestRunID ?? "";
    this.LatestTaskID = init.LatestTaskID ?? "";
    this.Status = init.Status ?? "";
    this.Started = init.Started ?? false;
    this.RunCount = init.RunCount ?? 0;
    this.FailedRuns = init.FailedRuns ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? 0;
    this.AssigneeUserID = init.AssigneeUserID ?? 0;
    this.Order = init.Order ?? 0;
    this.DependsOn = init.DependsOn ?? [];
    this.Handoff = init.Handoff ?? [];
    this.Orphan = init.Orphan ?? false;
    this.Stages = init.Stages ?? [];
  }
}

/**
 * 需求生命周期中的高层阶段条目。
 * 用于在需求进度条上展示各关键阶段的标签、状态与补充提示。
 */
class RequirementStage {
  /**
   * 构造需求阶段实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Key=""] - 阶段唯一键。
   * @param {string} [init.Label=""] - 阶段展示文案。
   * @param {string} [init.Status=""] - 阶段状态。
   * @param {string} [init.Hint=""] - 辅助提示说明。
   */
  constructor(init = {}) {
    this.Key = init.Key ?? "";
    this.Label = init.Label ?? "";
    this.Status = init.Status ?? "";
    this.Hint = init.Hint ?? "";
  }
}

/**
 * 需求的整体运行统计与聚合状态。
 * 汇总跨所有通道的运行数、失败数、活跃/成功通道数、Token 与成本以及首末运行时间。
 */
class RequirementOverall {
  /**
   * 构造需求总体汇总实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {number} [init.RunCount=0] - 总运行次数。
   * @param {number} [init.FailedRuns=0] - 总失败次数。
   * @param {number} [init.SucceededLanes=0] - 已成功的通道数。
   * @param {number} [init.ActiveLanes=0] - 正在执行的活跃通道数。
   * @param {number} [init.Tokens=0] - 累计消耗 Token 数。
   * @param {number} [init.CostUSD=0] - 累计成本（美元）。
   * @param {boolean} [init.CostKnown=false] - 成本数据是否已知（区分 0 成本与未知成本）。
   * @param {number} [init.ExecutionDurationMs=0] - 累计实际执行耗时（毫秒）。
   * @param {number} [init.CycleDurationMs=0] - 从首次运行到最近结束的周期耗时（毫秒）。
   * @param {Date|null} [init.FirstRunAt=null] - 首次启动运行时间。
   * @param {Date|null} [init.LastRunAt=null] - 最近一次运行时间。
   * @param {string} [init.Status=""] - 需求聚合后的总体状态。
   */
  constructor(init = {}) {
    this.RunCount = init.RunCount ?? 0;
    this.FailedRuns = init.FailedRuns ?? 0;
    this.SucceededLanes = init.SucceededLanes ?? 0;
    this.ActiveLanes = init.ActiveLanes ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostKnown = init.CostKnown ?? false;
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? 0;
    this.CycleDurationMs = init.CycleDurationMs ?? 0;
    this.FirstRunAt = init.FirstRunAt ?? null;
    this.LastRunAt = init.LastRunAt ?? null;
    this.Status = init.Status ?? "";
  }
}

/**
 * 单个需求的完整实时快照视图。
 * 聚合需求基础信息、总体指标、多通道进度、高层阶段以及可选的对话工作区信息。
 */
class RequirementSnapshot {
  /**
   * 构造需求快照实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {Issue} [init.Issue] - 需求本体对象。
   * @param {RequirementOverall} [init.Overall] - 需求总体汇总数据。
   * @param {RequirementLane[]} [init.Lanes=[]] - 各 SOP 通道进度列表。
   * @param {RequirementStage[]} [init.Stages=[]] - 需求高层阶段列表。
   * @param {RequirementConversation|null} [init.Conversation=null] - 对话工作区处理模式下的关联对话信息。
   */
  constructor(init = {}) {
    this.Issue = init.Issue ?? new Issue();
    this.Overall = init.Overall ?? new RequirementOverall();
    this.Lanes = init.Lanes ?? [];
    this.Stages = init.Stages ?? [];
    // Conversation 用于在对话工作区而非 SOP 里处理的需求。
    this.Conversation = init.Conversation ?? null;
  }
}

/**
 * 需求所关联的对话工作区信息。
 * 适用于不通过 SOP、直接在对话工作区修改代码的需求。
 */
class RequirementConversation {
  /**
   * 构造需求关联对话实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.SessionID=""] - 创建或处理该需求的对话会话 ID。
   * @param {boolean} [init.Available=false] - 该对话是否仍然存在（删除后为 `false`）。
   * @param {RequirementBranch[]} [init.Branches=[]] - 对话工作区检出的仓库分支列表。
   */
  constructor(init = {}) {
    // SessionID 是创建该需求的对话；需求来自别处时为空。
    this.SessionID = init.SessionID ?? "";
    // Available 在该对话被删除后为 false。
    this.Available = init.Available ?? false;
    // Branches 是其对话工作区的工作分支。
    this.Branches = init.Branches ?? [];
  }
}

/**
 * 对话工作区检出的单个代码仓库及其基准/工作分支信息。
 */
class RequirementBranch {
  /**
   * 构造需求关联分支实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Repository=""] - 仓库名称或标识。
   * @param {string} [init.WebURL=""] - 仓库网页地址。
   * @param {string} [init.BaseBranch=""] - 基准分支名。
   * @param {string} [init.WorkBranch=""] - 工作分支名。
   */
  constructor(init = {}) {
    this.Repository = init.Repository ?? "";
    this.WebURL = init.WebURL ?? "";
    this.BaseBranch = init.BaseBranch ?? "";
    this.WorkBranch = init.WorkBranch ?? "";
  }
}

module.exports = { RequirementNodeStage, RequirementLane, RequirementStage, RequirementOverall, RequirementSnapshot, RequirementConversation, RequirementBranch };
