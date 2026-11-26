/**
 * @file internal/repo/spaces.js
 * 对应 Go 源文件：internal/repo/spaces.go
 *
 * 作用与职责边界：
 * 实现需求空间（`requirement_spaces`）、空间成员（`space_members`）、版本化产物及其历史修订
 * （`space_artifacts`、`space_artifact_revisions`）与空间会话线程（`space_threads`）的持久化存取；
 * 方法按领域归属挂载于 `SpacesRepo.prototype`（`SpacesRepo` 定义于 `repo.js`），不负责房间消息推送或上层权限校验。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样遵循失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 译为二元组 `[值, boolean]`；`errors.Is(err, gorm.ErrRecordNotFound)` 译为 `===`。
 * - `jsonUnmarshal` 在反序列化失败时抛出异常，Go 中忽略或返回 `false` 的解码错误分支在 JS 中以 `try ... catch` 表达。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { RequirementSpace, SpaceMember, SpaceArtifact, SpaceThread } = require("../domain/space.js"); // 对应 Go 的 domain.*，space.js 已翻译
const { SpacesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { payloadOne, upsert, mustJSON, timePtr, jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { requirementSpaceRow, spaceMemberRow, spaceArtifactRow, spaceArtifactRevisionRow, spaceThreadRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

// 产物基于过期版本号提交编辑时抛出的乐观锁冲突错误。
const ErrArtifactConflict = new Error("产物已被其他人更新，请刷新后再保存");

/**
 * 按主键 ID 读取单个需求空间配置。
 * 使用场景：根据空间 ID 加载需求空间基本信息及关联需求。
 *
 * @param {string} id - 需求空间主键 ID（自动去除首尾空白）。
 * @returns {[RequirementSpace, boolean]} 找到且解码成功时返回 `[space, true]`，否则返回 `[空 RequirementSpace, false]`。
 */
SpacesRepo.prototype.Space = function (id) {
  return payloadOne(RequirementSpace, this.DB, "requirement_spaces", id.trim());
};

/**
 * 创建或更新需求空间记录；更新已有空间时保留原始 `CreatedAt`，并刷新 `UpdatedAt`。
 * 使用场景：新建需求空间或修改空间元数据时写入数据库。
 *
 * @param {RequirementSpace} v - 待保存的需求空间领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
SpacesRepo.prototype.PutSpace = function (v) {
  const now = new Date();
  const [old, ok] = this.Space(v.ID);
  if (ok) {
    v.CreatedAt = old.CreatedAt;
  } else if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  upsert(this.DB, "requirement_spaces", {
    id: v.ID, project_id: v.ProjectID, issue_id: v.IssueID,
    payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 按关联的 Issue ID 查找最早创建的需求空间。
 * 使用场景：从需求详情反查其所在的需求协作空间。
 *
 * @param {string} issueID - 关联的需求（Issue）ID。
 * @returns {[RequirementSpace, boolean]} 找到且解码成功时返回 `[space, true]`，否则返回 `[空 RequirementSpace, false]`。
 */
SpacesRepo.prototype.SpaceByIssue = function (issueID) {
  const row = new requirementSpaceRow();
  issueID = issueID.trim();
  if (issueID === "") {
    return [new RequirementSpace(), false];
  }
  if (this.DB.Table("requirement_spaces").Where("issue_id = ?", issueID).Order("created_at").Take(row).Error != null) {
    return [new RequirementSpace(), false];
  }
  const item = new RequirementSpace();
  try {
    jsonUnmarshal(row.Payload, item);
  } catch {
    return [new RequirementSpace(), false];
  }
  return [item, true];
};

/**
 * 按加入时间升序读取指定需求空间的全部成员列表；解码失败的损坏行会被跳过。
 * 使用场景：展示空间成员清单或校验空间成员权限。
 *
 * @param {string} spaceID - 需求空间 ID。
 * @returns {SpaceMember[]} 空间成员领域对象数组；查询失败时返回空数组。
 */
SpacesRepo.prototype.SpaceMembers = function (spaceID) {
  const rows = [];
  if (this.DB.Table("space_members").Where("space_id = ?", spaceID.trim()).Order("created_at").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new SpaceMember();
    try {
      jsonUnmarshal(row.Payload, item);
    } catch {
      continue;
    }
    out.push(item);
  }
  return out;
};

/**
 * 添加或更新单个需求空间成员；若未填写 `AddedAt` 则默认补全当前 UTC 时间。
 * 使用场景：邀请成员加入空间或更新其角色信息。
 *
 * @param {SpaceMember} v - 待保存的空间成员领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
SpacesRepo.prototype.PutSpaceMember = function (v) {
  if (isZeroTime(v.AddedAt)) {
    v.AddedAt = new Date();
  }
  upsert(this.DB, "space_members", {
    space_id: v.SpaceID, user_id: v.UserID, payload: mustJSON(v), created_at: timePtr(v.AddedAt),
  });
};

/**
 * 从指定需求空间中移除某位成员。
 * 使用场景：成员主动退出或管理员移除空间成员。
 *
 * @param {string} spaceID - 需求空间 ID。
 * @param {number} userID - 待移除的用户数字 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除执行失败时抛出错误。
 */
SpacesRepo.prototype.DeleteSpaceMember = function (spaceID, userID) {
  const err = this.DB.Exec("DELETE FROM space_members WHERE space_id = ? AND user_id = ?", spaceID, userID).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 按创建时间升序读取指定需求空间下的全部产物列表；解码失败的行会被跳过。
 * 使用场景：加载空间产物侧栏或产物概览列表。
 *
 * @param {string} spaceID - 需求空间 ID。
 * @returns {SpaceArtifact[]} 空间产物领域对象数组；查询失败时返回空数组。
 */
SpacesRepo.prototype.SpaceArtifacts = function (spaceID) {
  const rows = [];
  if (this.DB.Table("space_artifacts").Where("space_id = ?", spaceID.trim()).Order("created_at").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new SpaceArtifact();
    try {
      jsonUnmarshal(row.Payload, item);
    } catch {
      continue;
    }
    out.push(item);
  }
  return out;
};

/**
 * 按空间 ID 与产物 ID 读取单个产物，并校验产物确实归属于目标空间。
 * 使用场景：查看或编辑指定空间内的单个产物正文。
 *
 * @param {string} spaceID - 期望归属的需求空间 ID。
 * @param {string} id - 产物主键 ID。
 * @returns {[SpaceArtifact, boolean]} 产物存在且归属匹配时返回 `[artifact, true]`，否则返回 `[空 SpaceArtifact, false]`。
 */
SpacesRepo.prototype.SpaceArtifact = function (spaceID, id) {
  const [item, ok] = payloadOne(SpaceArtifact, this.DB, "space_artifacts", id.trim());
  if (!ok || item.SpaceID !== spaceID.trim()) {
    return [new SpaceArtifact(), false];
  }
  return [item, true];
};

/**
 * 在事务与行锁保护下保存空间产物的新版本，并同步写入一条不可变的历史修订快照。
 * `baseVersion` 为编辑起点版本号（传 `0` 表示新建产物），版本不匹配时抛出 `ErrArtifactConflict`。
 *
 * @param {SpaceArtifact} v - 待保存的空间产物领域对象。
 * @param {number} baseVersion - 编辑器加载时所基于的产物版本号；新建产物传 `0`。
 * @returns {SpaceArtifact} 已递增版本号并更新时间戳的产物对象。
 * @throws {Error} 版本冲突（`ErrArtifactConflict`）、跨空间归属不匹配或数据库读写失败时抛出错误。
 */
SpacesRepo.prototype.PutSpaceArtifact = function (v, baseVersion) {
  this.DB.Transaction((tx) => {
    const now = new Date();
    const row = new spaceArtifactRow();
    const takeErr = tx.Table("space_artifacts").Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", v.ID).Take(row).Error;
    if (takeErr === gorm.ErrRecordNotFound) {
      if (baseVersion !== 0) {
        throw ErrArtifactConflict;
      }
      v.Version = 1;
      v.CreatedAt = now;
    } else if (takeErr != null) {
      throw takeErr;
    } else {
      const old = new SpaceArtifact();
      let unmarshalFailed = false;
      try {
        jsonUnmarshal(row.Payload, old);
      } catch {
        unmarshalFailed = true;
      }
      if (unmarshalFailed || old.SpaceID !== v.SpaceID) {
        throw new Error(`artifact ${v.ID} belongs to another space`);
      }
      if (baseVersion !== old.Version) {
        throw ErrArtifactConflict;
      }
      v.Version = old.Version + 1;
      v.CreatedAt = old.CreatedAt;
    }
    v.UpdatedAt = now;
    upsert(tx, "space_artifacts", {
      id: v.ID, space_id: v.SpaceID, kind: v.Kind, version: v.Version,
      payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
    });
    upsert(tx, "space_artifact_revisions", {
      artifact_id: v.ID, version: v.Version, space_id: v.SpaceID, payload: mustJSON(v), created_at: timePtr(now),
    });
  });
  return v;
};

/**
 * 按版本号倒序查询指定产物的全部历史修订元数据列表（清空 `Body` 正文以减小返回体积）。
 * 使用场景：在产物详情页展示版本历史列表供用户切换查看。
 *
 * @param {string} spaceID - 需求空间 ID。
 * @param {string} id - 产物主键 ID。
 * @returns {SpaceArtifact[]} 不含正文的修订版本数组（最新在前）；查询失败时返回空数组。
 */
SpacesRepo.prototype.SpaceArtifactRevisions = function (spaceID, id) {
  const rows = [];
  if (this.DB.Table("space_artifact_revisions").Where("artifact_id = ? AND space_id = ?", id, spaceID).Order("version desc").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new SpaceArtifact();
    try {
      jsonUnmarshal(row.Payload, item);
    } catch {
      continue;
    }
    item.Body = "";
    out.push(item);
  }
  return out;
};

/**
 * 读取指定产物的某一个历史修订完整内容（含正文）。
 * 使用场景：用户在历史版本列表中查看或回溯某一具体版本的产物内容。
 *
 * @param {string} spaceID - 需求空间 ID。
 * @param {string} id - 产物主键 ID。
 * @param {number} version - 目标修订版本号。
 * @returns {[SpaceArtifact, boolean]} 找到且解码成功时返回 `[artifact, true]`，否则返回 `[空 SpaceArtifact, false]`。
 */
SpacesRepo.prototype.SpaceArtifactRevision = function (spaceID, id, version) {
  const row = new spaceArtifactRevisionRow();
  if (this.DB.Table("space_artifact_revisions").Where("artifact_id = ? AND space_id = ? AND version = ?", id, spaceID, version).Take(row).Error != null) {
    return [new SpaceArtifact(), false];
  }
  const item = new SpaceArtifact();
  try {
    jsonUnmarshal(row.Payload, item);
  } catch {
    return [new SpaceArtifact(), false];
  }
  return [item, true];
};

/**
 * 在单个事务内删除指定空间产物及其全部历史修订记录。
 * 使用场景：用户彻底删除需求空间内的某个产物文档。
 *
 * @param {string} spaceID - 需求空间 ID。
 * @param {string} id - 待删除的产物主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 事务中任一删除语句执行失败时抛出错误。
 */
SpacesRepo.prototype.DeleteSpaceArtifact = function (spaceID, id) {
  this.DB.Transaction((tx) => {
    const revErr = tx.Exec("DELETE FROM space_artifact_revisions WHERE artifact_id = ? AND space_id = ?", id, spaceID).Error;
    if (revErr != null) {
      throw revErr;
    }
    const err = tx.Exec("DELETE FROM space_artifacts WHERE id = ? AND space_id = ?", id, spaceID).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 按创建时间升序读取指定需求空间下的全部会话线程列表；解码失败的行会被跳过。
 * 使用场景：渲染空间内的讨论线程与执行线程列表。
 *
 * @param {string} spaceID - 需求空间 ID。
 * @returns {SpaceThread[]} 空间会话线程领域对象数组；查询失败时返回空数组。
 */
SpacesRepo.prototype.SpaceThreads = function (spaceID) {
  const rows = [];
  if (this.DB.Table("space_threads").Where("space_id = ?", spaceID.trim()).Order("created_at").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new SpaceThread();
    try {
      jsonUnmarshal(row.Payload, item);
    } catch {
      continue;
    }
    out.push(item);
  }
  return out;
};

/**
 * 按空间 ID 与线程 ID 读取单个空间会话线程，并校验其确实属于目标空间。
 * 使用场景：打开指定空间线程的详情或追加消息前校验归属。
 *
 * @param {string} spaceID - 期望归属的需求空间 ID。
 * @param {string} id - 线程主键 ID。
 * @returns {[SpaceThread, boolean]} 线程存在且归属匹配时返回 `[thread, true]`，否则返回 `[空 SpaceThread, false]`。
 */
SpacesRepo.prototype.SpaceThread = function (spaceID, id) {
  const [item, ok] = payloadOne(SpaceThread, this.DB, "space_threads", id.trim());
  if (!ok || item.SpaceID !== spaceID.trim()) {
    return [new SpaceThread(), false];
  }
  return [item, true];
};

/**
 * 按空间 ID 与已派发的运行 ID 查找绑定到该次运行的空间线程。
 * 使用场景：从工作流运行回溯或同步进展到对应的需求空间线程。
 *
 * @param {string} spaceID - 需求空间 ID。
 * @param {string} runID - 关联的运行 ID。
 * @returns {[SpaceThread, boolean]} 找到且解码成功时返回 `[thread, true]`，否则返回 `[空 SpaceThread, false]`。
 */
SpacesRepo.prototype.SpaceRunThread = function (spaceID, runID) {
  const row = new spaceThreadRow();
  if (this.DB.Table("space_threads").Where("space_id = ? AND run_id = ?", spaceID, runID).Take(row).Error != null) {
    return [new SpaceThread(), false];
  }
  const item = new SpaceThread();
  try {
    jsonUnmarshal(row.Payload, item);
  } catch {
    return [new SpaceThread(), false];
  }
  return [item, true];
};

/**
 * 创建或更新单个需求空间会话线程；若未填写 `CreatedAt` 则默认补全当前 UTC 时间。
 * 使用场景：新建空间讨论线程或更新线程关联的运行信息。
 *
 * @param {SpaceThread} v - 待保存的空间会话线程领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
SpacesRepo.prototype.PutSpaceThread = function (v) {
  if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = new Date();
  }
  upsert(this.DB, "space_threads", {
    id: v.ID, space_id: v.SpaceID, run_id: v.RunID, payload: mustJSON(v), created_at: timePtr(v.CreatedAt),
  });
};

module.exports = { ErrArtifactConflict };
