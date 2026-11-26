/**
 * 对应 Go 文件：internal/domain/knowledge.go
 * 作用：定义平台级上游知识库连接配置、内置知识库 MCP/规则常量、知识投稿记录与候选产物结构。
 * 职责边界：仅负责知识库领域的数据模型、配置脱敏与项目可见知识源解析，不执行上游知识库读写调用。
 * 语法差异说明：Go 的 time.Time 对应 Date（零值为 null），map[string][]string 零值为 {}，切片零值为 []。
 */

"use strict";

const { Artifact } = require("./run.js");

/** 平台为启用知识库的角色动态生成的只读知识库 MCP 保留 ID（不写入 mcp_servers 表）。 */
const KnowledgeMCPServerID = "agentflow-knowledge";
/** 随知识库 MCP 一同注入的内置规则 ID，要求角色先检索再作答并标注来源。 */
const KnowledgeUsageRuleID = "agentflow-knowledge-usage";
/** 运行产物中用于标识待沉淀知识文档的约定文件名。 */
const KnowledgeArtifactBasename = "knowledge.md";

/**
 * 平台级上游知识库连接配置。
 * Token 为上游 MCP 鉴权令牌，绝不向前端暴露，返回 API 响应前必须经 Public() 脱敏。
 */
class KnowledgeSettings {
  /**
   * 构造知识库连接配置对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<KnowledgeSettings>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Enabled = init.Enabled ?? false;
    this.URL = init.URL ?? "";
    this.Token = init.Token ?? "";
    this.TokenConfigured = init.TokenConfigured ?? false;
    this.WriteEnabled = init.WriteEnabled ?? false;
    this.DefaultSources = init.DefaultSources ?? [];
    this.ProjectSources = init.ProjectSources ?? {};
    this.UpdatedBy = init.UpdatedBy ?? "";
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  /**
   * 返回适用于 API 响应的脱敏配置副本：根据 Token 是否非空设置 TokenConfigured，并清空明文 Token。
   *
   * @returns {KnowledgeSettings} 去除明文 Token 后的配置副本。
   */
  Public() {
    const s = new KnowledgeSettings(this);
    s.TokenConfigured = this.Token.trim() !== "";
    s.Token = "";
    return s;
  }

  /**
   * 判断上游知识库是否已启用且配置了有效的服务地址与鉴权令牌，可供 Agent 与平台功能调用。
   *
   * @returns {boolean} 已启用且 URL 与 Token 均非空时返回 true，否则返回 false。
   */
  Ready() {
    return this.Enabled && this.URL.trim() !== "" && this.Token.trim() !== "";
  }

  /**
   * 返回指定项目允许读取的知识源列表。
   * 若 ProjectSources 中存在该项目的显式配置项（即使为空数组），则覆盖 DefaultSources；空列表表示不限制来源。
   *
   * @param {string} projectID - 项目 ID。
   * @returns {string[]} 该项目可读的知识源标识数组。
   */
  SourcesForProject(projectID) {
    const key = projectID.trim();
    if (this.ProjectSources != null && Object.prototype.hasOwnProperty.call(this.ProjectSources, key)) {
      return this.ProjectSources[key];
    }
    return this.DefaultSources;
  }
}

/** 知识投稿状态：待人工审核。 */
const KnowledgeSubmissionPending = "pending";
/** 知识投稿状态：已发布至上游知识库。 */
const KnowledgeSubmissionPublished = "published";
/** 知识投稿状态：审核驳回。 */
const KnowledgeSubmissionRejected = "rejected";

/**
 * 一份待人工审核的蒸馏知识文档投稿，审核通过后才写回上游知识源。
 */
class KnowledgeSubmission {
  /**
   * 构造知识投稿对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<KnowledgeSubmission>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.ArtifactID = init.ArtifactID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.Title = init.Title ?? "";
    this.Source = init.Source ?? "";
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? "";
    this.Status = init.Status ?? "";
    this.Commit = init.Commit ?? "";
    this.Error = init.Error ?? "";
    this.ReviewNote = init.ReviewNote ?? "";
    this.CreatedBy = init.CreatedBy ?? "";
    this.ReviewedBy = init.ReviewedBy ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.PublishedAt = init.PublishedAt ?? null;
  }
}

/**
 * 识别为蒸馏知识文档、可转化为知识投稿的运行产物候选对象。
 */
class KnowledgeCandidate {
  /**
   * 构造知识候选文档对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<KnowledgeCandidate>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Artifact = init.Artifact ?? new Artifact();
    this.ProjectID = init.ProjectID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.RunStatus = init.RunStatus ?? "";
    this.SubmissionID = init.SubmissionID ?? "";
  }
}

module.exports = {
  KnowledgeMCPServerID,
  KnowledgeUsageRuleID,
  KnowledgeArtifactBasename,
  KnowledgeSettings,
  KnowledgeSubmissionPending,
  KnowledgeSubmissionPublished,
  KnowledgeSubmissionRejected,
  KnowledgeSubmission,
  KnowledgeCandidate,
};
