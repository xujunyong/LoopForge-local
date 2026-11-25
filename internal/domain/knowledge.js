// knowledge.js —— 对应 Go 文件：internal/domain/knowledge.go
// 作用：知识库连接配置、投稿与候选文档结构。

"use strict";

const KnowledgeMCPServerID = "agentflow-knowledge";
const KnowledgeUsageRuleID = "agentflow-knowledge-usage";
const KnowledgeArtifactBasename = "knowledge.md";

// KnowledgeSettings：上游知识库的平台级连接，Token 永不离站，Public() 会去掉它。
class KnowledgeSettings {
  constructor(init = {}) {
    this.Enabled = init.Enabled ?? false;
    this.URL = init.URL ?? "";
    this.Token = init.Token ?? "";
    this.TokenConfigured = init.TokenConfigured ?? false;
    this.WriteEnabled = init.WriteEnabled ?? false;
    this.DefaultSources = init.DefaultSources ?? [];
    this.ProjectSources = init.ProjectSources ?? null;
    this.UpdatedBy = init.UpdatedBy ?? "";
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  Public() {
    const s = new KnowledgeSettings(this);
    s.TokenConfigured = this.Token.trim() !== "";
    s.Token = "";
    return s;
  }

  // Ready：上游是否可供调用。
  Ready() {
    return this.Enabled && this.URL.trim() !== "" && this.Token.trim() !== "";
  }

  // SourcesForProject：项目可读的来源，项目条目（含空）覆盖默认来源，空表示不限。
  SourcesForProject(projectID) {
    const key = projectID.trim();
    if (this.ProjectSources != null && Object.prototype.hasOwnProperty.call(this.ProjectSources, key)) {
      return this.ProjectSources[key];
    }
    return this.DefaultSources;
  }
}

const KnowledgeSubmissionPending = "pending";
const KnowledgeSubmissionPublished = "published";
const KnowledgeSubmissionRejected = "rejected";

// KnowledgeSubmission：一份待人工审核的蒸馏文档，审核后才写回上游知识源。
class KnowledgeSubmission {
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

// KnowledgeCandidate：看起来像蒸馏知识文档、可转投稿的 run 产物。
class KnowledgeCandidate {
  constructor(init = {}) {
    this.Artifact = init.Artifact ?? null;
    this.ProjectID = init.ProjectID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.RunStatus = init.RunStatus ?? "";
    this.SubmissionID = init.SubmissionID ?? "";
  }
}

module.exports = { KnowledgeMCPServerID, KnowledgeUsageRuleID, KnowledgeArtifactBasename, KnowledgeSettings, KnowledgeSubmissionPending, KnowledgeSubmissionPublished, KnowledgeSubmissionRejected, KnowledgeSubmission, KnowledgeCandidate };
