/**
 * @file internal/repo/knowledge.js
 * 对应 Go 源文件：internal/repo/knowledge.go
 *
 * 作用与职责边界：
 * 实现知识库仓储（`KnowledgeRepo`）的持久化读写方法，负责平台级上游知识库连接配置（含独立列存储的鉴权令牌）
 * 以及待人工审核的知识蒸馏投稿队列的查询、写入、按产物反查与删除。
 * 不负责上游知识库远端读写调用或候选运行产物扫描（见 `run_knowledge.js`）。
 *
 * 语法差异说明：
 * - `KnowledgeRepo` 继承自 `repo.js` 中的 `deps`（对应 Go 的 `*deps` 嵌入），本文件定义并导出 `KnowledgeRepo`，通过 `KnowledgeRepo.prototype` 挂载全部方法。
 * - Go 的 `error`-only 方法统一译为成功返回 `undefined`、失败抛出 `Error`；`(值, bool)` 译为 `[值, boolean]` 元组。
 * - Go 的 `map[string]string` 译为普通对象 `{}`；`time.Time` 零值译为 `null`。
 * - Go 按值传递的结构体参数在写入前显式浅拷贝，避免修改调用方持有的原始对象。
 */

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { KnowledgeSettings, KnowledgeSubmission, KnowledgeSubmissionPending } = require("../domain/knowledge.js"); // 对应 Go 的 domain.KnowledgeSettings/KnowledgeSubmission/KnowledgeSubmissionPending，knowledge.js 已翻译
const { knowledgeSettingsRow, knowledgeSubmissionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { deps } = require("./repo.js"); // 对应 Go 同包共享依赖基类，repo.js 已翻译

/**
 * 知识库领域仓储（对应 Go 的 `KnowledgeRepo struct { *deps }`），负责知识库配置与投稿队列持久化。
 */
class KnowledgeRepo extends deps {
  /**
   * 构造知识库仓储实例。
   * 使用场景：由 `repo.js` 的 `newStore` 装配领域仓储时调用。
   *
   * @param {{ DB?: object | null }} [init={}] - 初始化字段对象（包含共享数据库句柄 `DB`）。
   */
  constructor(init = {}) {
    super(init);
  }
}

/** 平台级知识库配置表唯一记录的主键 ID。 */
const knowledgeSettingsID = "default";

/**
 * 读取已持久化的平台知识库连接配置（包含独立列中的明文上游令牌）。
 * 供后台调用上游知识库及配置编辑回显使用；向前端渲染 API 响应时必须先调用 `Public()` 脱敏。
 *
 * @returns {KnowledgeSettings} 知识库配置对象；记录不存在时返回零值配置实例。
 */
KnowledgeRepo.prototype.KnowledgeSettings = function () {
  const row = new knowledgeSettingsRow();
  if (this.DB.Where("id = ?", knowledgeSettingsID).Take(row).Error != null) {
    return new KnowledgeSettings();
  }
  let out = new KnowledgeSettings();
  try {
    out = new KnowledgeSettings(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  } catch {
    // Go 忽略 JSON 解码错误。
  }
  out.Token = "";
  if (row.Token != null) {
    out.Token = row.Token;
  }
  out.TokenConfigured = out.Token.trim() !== "";
  if (row.Updated != null) {
    out.UpdatedAt = row.Updated;
  }
  return out;
};

/**
 * 保存或覆盖平台级知识库连接配置：将上游令牌剥离后单独写入 `token` 列，避免进入 JSON 载荷。
 * 用于平台管理员更新知识库接入地址、开关状态、鉴权令牌及知识源映射。
 *
 * @param {KnowledgeSettings} settings - 待保存的知识库连接配置对象。
 * @returns {void} 无返回值。
 * @throws {Error} JSON 序列化失败或数据库 Upsert 失败时抛出错误。
 */
KnowledgeRepo.prototype.PutKnowledgeSettings = function (settings) {
  const now = new Date();
  // Go 按值传参，此处复制一份避免清空 Token 时影响调用方对象。
  const copy = new KnowledgeSettings(settings);
  const token = copy.Token.trim();
  copy.Token = "";
  copy.TokenConfigured = false;
  copy.UpdatedAt = now;
  const payload = Buffer.from(JSON.stringify(copy), "utf8");
  const row = new knowledgeSettingsRow({ ID: knowledgeSettingsID, Payload: payload, Updated: now });
  if (token !== "") {
    row.Token = token;
  }
  const err = this.DB.Clauses(new clause.OnConflict({
    Columns: [new clause.Column({ Name: "id" })],
    DoUpdates: clause.AssignmentColumns(["payload", "token", "updated_at"]),
  })).Create(row).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 按更新时间倒序查询知识投稿队列列表；空过滤条件表示不过滤，返回项会清空 `Content` 以减小列表响应体积。
 * 供知识审核队列页面分页或筛选展示。
 *
 * @param {string} projectID - 项目 ID 过滤条件，空字符串表示匹配全部项目。
 * @param {string} status - 投稿状态过滤条件，空字符串表示匹配全部状态。
 * @param {number} limit - 返回条数上限；小于等于 0 或大于 500 时回退为默认值 200。
 * @returns {KnowledgeSubmission[]} 省略正文的知识投稿对象数组；查询出错时返回空数组。
 */
KnowledgeRepo.prototype.KnowledgeSubmissions = function (projectID, status, limit) {
  const out = [];
  if (limit <= 0 || limit > 500) {
    limit = 200;
  }
  let q = this.DB.Model(new knowledgeSubmissionRow());
  projectID = projectID.trim();
  if (projectID !== "") {
    q = q.Where("project_id = ?", projectID);
  }
  status = status.trim();
  if (status !== "") {
    q = q.Where("status = ?", status);
  }
  const rows = [];
  if (q.Order("updated_at DESC").Limit(limit).Find(rows).Error != null) {
    return out;
  }
  for (const row of rows) {
    const item = knowledgeSubmissionFromRow(row);
    item.Content = "";
    out.push(item);
  }
  return out;
};

/**
 * 按主键 ID 读取单条完整知识投稿记录（包含正文内容）。
 * 用于审核详情查看与发布写回上游知识库前加载文档正文。
 *
 * @param {string} id - 知识投稿唯一标识。
 * @returns {[KnowledgeSubmission, boolean]} 返回 `[投稿对象, 是否找到]`；未找到时返回 `[空投稿对象, false]`。
 */
KnowledgeRepo.prototype.KnowledgeSubmission = function (id) {
  const row = new knowledgeSubmissionRow();
  if (this.DB.Where("id = ?", id.trim()).Take(row).Error != null) {
    return [new KnowledgeSubmission(), false];
  }
  return [knowledgeSubmissionFromRow(row), true];
};

/**
 * 根据一组运行产物 ID 批量反查对应的知识投稿 ID 映射，便于候选列表展示“已进入投稿队列”状态。
 *
 * @param {string[]} artifactIDs - 运行产物 ID 数组。
 * @returns {Object<string, string>} 以产物 ID 为键、对应投稿 ID 为值的普通对象映射；输入为空或查询失败时返回 `{}`。
 */
KnowledgeRepo.prototype.KnowledgeSubmissionIDsByArtifact = function (artifactIDs) {
  const out = {};
  if (artifactIDs.length === 0) {
    return out;
  }
  const rows = [];
  if (this.DB.Select("id", "artifact_id").Where("artifact_id IN ?", artifactIDs).Find(rows).Error != null) {
    return out;
  }
  for (const row of rows) {
    out[row.ArtifactID] = row.ID;
  }
  return out;
};

/**
 * 新增或更新一条知识投稿记录；缺失创建时间或状态时自动补齐当前时间与待审核默认状态。
 * 用于将蒸馏候选产物加入队列，或在审核通过/驳回后更新状态与备注。
 *
 * @param {KnowledgeSubmission} item - 待保存的知识投稿对象（`ID` 去除空白后不可为空）。
 * @returns {void} 无返回值。
 * @throws {Error} 投稿 ID 为空、JSON 序列化失败或数据库 Upsert 失败时抛出错误。
 */
KnowledgeRepo.prototype.PutKnowledgeSubmission = function (item) {
  if (item.ID.trim() === "") {
    throw new Error("knowledge submission id is required");
  }
  const now = new Date();
  // Go 按值传参，此处复制一份避免副作用影响调用方对象。
  const copy = new KnowledgeSubmission(item);
  if (copy.CreatedAt == null) {
    copy.CreatedAt = now;
  }
  copy.UpdatedAt = now;
  if (copy.Status === "") {
    copy.Status = KnowledgeSubmissionPending;
  }
  const payload = Buffer.from(JSON.stringify(copy), "utf8");
  const created = copy.CreatedAt;
  const row = new knowledgeSubmissionRow({
    ID: copy.ID, ProjectID: copy.ProjectID, RunID: copy.RunID, ArtifactID: copy.ArtifactID,
    Status: copy.Status, Payload: payload, Created: created, Updated: now,
  });
  const err = this.DB.Clauses(new clause.OnConflict({
    Columns: [new clause.Column({ Name: "id" })],
    DoUpdates: clause.AssignmentColumns(["project_id", "run_id", "artifact_id", "status", "payload", "updated_at"]),
  })).Create(row).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 按主键 ID 删除单条知识投稿记录；若未命中任何记录则抛出 `gorm.ErrRecordNotFound`。
 *
 * @param {string} id - 待删除的知识投稿 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除失败或记录不存在（`gorm.ErrRecordNotFound`）时抛出错误。
 */
KnowledgeRepo.prototype.DeleteKnowledgeSubmission = function (id) {
  const res = this.DB.Where("id = ?", id.trim()).Delete(new knowledgeSubmissionRow());
  if (res.Error != null) {
    throw res.Error;
  }
  if (res.RowsAffected === 0) {
    throw gorm.ErrRecordNotFound;
  }
};

/**
 * 将 `knowledge_submissions` 物理行解码为 `KnowledgeSubmission` 领域对象，并用索引列覆盖核心标识及时间戳字段。
 *
 * @param {knowledgeSubmissionRow} row - 数据库查询返回的知识投稿物理行。
 * @returns {KnowledgeSubmission} 解码并回填字段后的知识投稿领域对象。
 */
function knowledgeSubmissionFromRow(row) {
  let out = new KnowledgeSubmission();
  try {
    out = new KnowledgeSubmission(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  } catch {
    // Go 忽略 JSON 解码错误。
  }
  out.ID = row.ID;
  out.ProjectID = row.ProjectID;
  out.RunID = row.RunID;
  out.ArtifactID = row.ArtifactID;
  out.Status = row.Status;
  if (row.Created != null) {
    out.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    out.UpdatedAt = row.Updated;
  }
  return out;
}

module.exports = { KnowledgeRepo, knowledgeSettingsID, knowledgeSubmissionFromRow };
