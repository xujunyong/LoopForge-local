/**
 * @file internal/repo/assistant_generation_approvals.js
 * 对应 Go 源文件：internal/repo/assistant_generation_approvals.go
 *
 * 作用与职责边界：
 * 管理助手生成私有载荷中的原生工具调用审批状态，包括审批记录的创建（含入参 SHA-256 摘要校验与幂等重试）、
 * 单条与待决列表查询、用户允许/拒绝决定，以及按单条或按 CLI 阶段释放审批记录。
 * 审批状态保存在私有生成载荷内，既支持多 API 实例共享读取，又避免在对外 DTO 中泄露原始工具参数。
 *
 * 语法差异说明：
 * - Go 结构体单嵌入 `domain.AssistantNativeApproval` 译为类继承 `extends AssistantNativeApproval`。
 * - Go 仅返回 `error` 的方法及事务/更新回调统一按成功无返回值（`undefined`）、失败 `throw err` 处理；`(值, bool)` 译为 `[值, boolean]`。
 */

"use strict";

const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantNativeApproval } = require("../domain/assistant.js"); // 对应 Go 同包类型，assistant.js 已翻译
const { assistantGenerationRow, generationPayload } = require("./assistant_generations.js"); // 对应 Go 同包类型与函数，assistant_generations.js 本次一同翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 存储在生成记录私有载荷中的原生工具审批持久化状态。
 * 在领域模型 `AssistantNativeApproval` 基础上补充所属执行阶段 `Phase` 与原始入参摘要 `InputDigest`。
 */
class assistantNativeApprovalState extends AssistantNativeApproval {
  /**
   * 构造原生工具审批持久化状态对象，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Phase=""] - 产生该审批的 CLI 执行阶段标识。
   * @param {string} [init.InputDigest=""] - 工具原始 JSON 入参的 SHA-256 十六进制摘要。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.Phase = init.Phase ?? "";
    this.InputDigest = init.InputDigest ?? "";
  }
}

/**
 * 将内部持久化审批状态投影为对外返回的领域模型 `AssistantNativeApproval`，并保留 `InputDigest` 供重试校验。
 *
 * @param {assistantNativeApprovalState} item - 内部存储的审批状态对象。
 * @returns {AssistantNativeApproval} 剥离内部 `Phase` 后的领域审批对象。
 */
function nativeApprovalState(item) {
  const out = new AssistantNativeApproval({ ...item });
  out.InputDigest = item.InputDigest;
  return out;
}

/**
 * 判断一条生成记录当前是否仍处于存活运行状态（运行中、未请求取消且心跳未超时）。
 * 使用与心跳写入一致的数据库时钟判定超时，防止主机时钟偏差引起误判。
 *
 * @param {object} db - 当前使用的 `gorm.DB` 句柄或事务对象。
 * @param {object} row - 生成记录数据库行（`assistantGenerationRow` 实例）。
 * @returns {boolean} 仍存活运行时返回 `true`，否则返回 `false`。
 */
AssistantRepo.prototype.nativeApprovalGenerationActive = function (db, row) {
  return row.Status === "running" && !row.CancelRequested && !this.heartbeatLate(db, row.UpdatedAt);
};

/**
 * 在行锁事务中读取指定生成记录的私有载荷、执行审批修改回调并仅更新 `payload` 列。
 * 不刷新 `updated_at`，确保审批流量不会替已失联的工作进程续租心跳。
 *
 * @param {number} owner - 会话归属用户 ID。
 * @param {string} session - 会话 ID。
 * @param {string} generation - 生成轮次 ID。
 * @param {boolean} requireLive - 是否要求该轮生成必须处于存活运行状态。
 * @param {function(object): void} update - 原地修改 `assistantGenerationPayload` 的回调，业务校验失败时抛错。
 * @returns {void} 无返回值。
 * @throws {Error} 本轮已结束、审批失效、回调校验失败或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.updateNativeApprovals = function (owner, session, generation, requireLive, update) {
  this.DB.Transaction((tx) => {
    const row = new assistantGenerationRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ? AND generation_id = ?", session, owner, generation).Take(row).Error;
    if (err != null) {
      throw new Error("本轮已结束，审批已失效");
    }
    if (requireLive && !this.nativeApprovalGenerationActive(tx, row)) {
      throw new Error("本轮已结束，审批已失效");
    }
    const payload = generationPayload(row);
    update(payload);
    // 审批交互不能续期已失效工作节点的租约，仅由生成自身的检查点循环推进 updated_at。
    const updateErr = tx.Model(row).UpdateColumn("payload", mustJSON(payload)).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

/**
 * 为当前存活的生成轮次登记一条待审批的原生工具调用记录。
 * 对同一 `item.ID` 的传输层重试做幂等放行（要求阶段、发起人、工具名及入参 SHA-256 摘要全部一致），否则拒绝冲突复用。
 *
 * @param {number} owner - 会话归属用户 ID。
 * @param {string} session - 会话 ID。
 * @param {string} phase - 当前 CLI 执行阶段标识。
 * @param {AssistantNativeApproval} item - 待登记的原生工具审批对象（须含合法 JSON 格式的 `Input`）。
 * @returns {void} 无返回值。
 * @throws {Error} 参数不完整、入参非合法 JSON、审批 ID 被不同调用占用或本轮已结束时抛出错误。
 */
AssistantRepo.prototype.CreateNativeApproval = function (owner, session, phase, item) {
  let inputValid = false;
  try {
    JSON.parse(typeof item.Input === "string" ? item.Input : Buffer.from(item.Input).toString("utf8"));
    inputValid = true;
  } catch (err) {
    // 非合法 JSON，保持 inputValid 为 false 触发下方参数校验报错。
  }
  if (item.GenerationID === "" || item.ID === "" || phase === "" || item.ActorID <= 0 || item.Tool === "" || !inputValid) {
    throw new Error("原生工具审批参数无效");
  }
  const inputDigest = createHash("sha256").update(item.Input).digest("hex");
  this.updateNativeApprovals(owner, session, item.GenerationID, true, (payload) => {
    for (const old of payload.NativeApprovals) {
      if (old.ID !== item.ID) {
        continue;
      }
      if (old.Phase !== phase || old.ActorID !== item.ActorID || old.Tool !== item.Tool || old.InputDigest !== inputDigest) {
        throw new Error("审批调用标识已被其他操作使用");
      }
      // 相同参数的传输层重试视作同一次调用，幂等返回。
      return;
    }
    item.Decision = "pending";
    if (item.CreatedAt == null) {
      item.CreatedAt = new Date();
    }
    payload.NativeApprovals.push(new assistantNativeApprovalState({ ...item, Phase: phase, InputDigest: inputDigest }));
  });
};

/**
 * 查询当前存活生成中指定 ID 的原生工具审批记录。
 * 供工具网关轮询审批结果时调用。
 *
 * @param {number} owner - 会话归属用户 ID。
 * @param {string} session - 会话 ID。
 * @param {string} id - 审批记录 ID。
 * @returns {[AssistantNativeApproval, boolean]} 返回 `[审批对象, 是否找到]`；本轮非存活或无此审批时返回 `[空审批对象, false]`。
 */
AssistantRepo.prototype.NativeApproval = function (owner, session, id) {
  const row = new assistantGenerationRow();
  const err = this.DB.Where("session_id = ? AND user_id = ?", session, owner).Take(row).Error;
  if (err != null || !this.nativeApprovalGenerationActive(this.DB, row)) {
    return [new AssistantNativeApproval(), false];
  }
  for (const item of generationPayload(row).NativeApprovals) {
    if (item.ID === id) {
      return [nativeApprovalState(item), true];
    }
  }
  return [new AssistantNativeApproval(), false];
};

/**
 * 获取当前存活生成中全部处于 `"pending"` 状态的原生工具审批列表。
 * 供前端展示待确认的工具审批卡片。
 *
 * @param {number} owner - 会话归属用户 ID。
 * @param {string} session - 会话 ID。
 * @returns {AssistantNativeApproval[]} 待审批记录数组；无存活生成或无待决审批时返回 `[]`。
 */
AssistantRepo.prototype.PendingNativeApprovals = function (owner, session) {
  const out = [];
  const row = new assistantGenerationRow();
  const err = this.DB.Where("session_id = ? AND user_id = ?", session, owner).Take(row).Error;
  if (err != null || !this.nativeApprovalGenerationActive(this.DB, row)) {
    return out;
  }
  for (const item of generationPayload(row).NativeApprovals) {
    if (item.Decision === "pending") {
      out.push(nativeApprovalState(item));
    }
  }
  return out;
};

/**
 * 记录操作者对指定原生工具审批的决定（`"allow"` 或 `"deny"`）。
 * 仅允许该审批的原发起人 `actor` 作出决定；决定落盘后清空原始 `Input` 仅保留 `InputDigest` 供重试校验，且禁止更改为相反决定。
 *
 * @param {number} owner - 会话归属用户 ID。
 * @param {number} actor - 提交审批决定的用户 ID（必须与审批记录的 `ActorID` 一致）。
 * @param {string} session - 会话 ID。
 * @param {string} id - 审批记录 ID。
 * @param {string} decision - 审批决定，仅允许 `"allow"` 或 `"deny"`。
 * @returns {void} 无返回值。
 * @throws {Error} 决定值非法、本轮已结束、审批已作出不同决定、不属于当前发起人或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.DecideNativeApproval = function (owner, actor, session, id, decision) {
  if (decision !== "allow" && decision !== "deny") {
    throw new Error("无效审批结果");
  }
  const row = new assistantGenerationRow();
  const err = this.DB.Where("session_id = ? AND user_id = ?", session, owner).Take(row).Error;
  if (err != null) {
    throw new Error("本轮已结束，审批已失效");
  }
  this.updateNativeApprovals(owner, session, row.GenerationID, true, (payload) => {
    for (let i = 0; i < payload.NativeApprovals.length; i++) {
      const item = payload.NativeApprovals[i];
      if (item.ID !== id || item.ActorID !== actor) {
        continue;
      }
      if (item.Decision !== "pending" && item.Decision !== decision) {
        throw new Error("审批已作出不同决定");
      }
      item.Decision = decision;
      // 审批完成后前端无需再展示完整工具参数，仅保留精确入参摘要供传输重试校验。
      item.Input = null;
      return;
    }
    throw new Error("审批已失效或不属于当前发起人");
  });
};

/**
 * 移除已完成或已取消的单次工具网关调用对应的审批卡片，同阶段内仍在等待的其他调用不受影响。
 *
 * @param {number} owner - 会话归属用户 ID。
 * @param {string} session - 会话 ID。
 * @param {string} generation - 生成轮次 ID。
 * @param {string} phase - 所属 CLI 执行阶段标识。
 * @param {string} id - 待释放的审批记录 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 对应生成记录不存在或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.ReleaseNativeApproval = function (owner, session, generation, phase, id) {
  this.updateNativeApprovals(owner, session, generation, false, (payload) => {
    payload.NativeApprovals = payload.NativeApprovals.filter((item) => !(item.Phase === phase && item.ID === id));
  });
};

/**
 * 撤销并清理指定 CLI 退出阶段下的全部原生工具审批记录（包含已裁决条目），不影响其他会话及后续生成轮次。
 *
 * @param {number} owner - 会话归属用户 ID。
 * @param {string} session - 会话 ID。
 * @param {string} generation - 生成轮次 ID。
 * @param {string} phase - 正在退出的 CLI 执行阶段标识。
 * @returns {void} 无返回值。
 * @throws {Error} 对应生成记录不存在或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.ReleaseNativeApprovals = function (owner, session, generation, phase) {
  this.updateNativeApprovals(owner, session, generation, false, (payload) => {
    payload.NativeApprovals = payload.NativeApprovals.filter((item) => item.Phase !== phase);
  });
};

module.exports = { assistantNativeApprovalState, nativeApprovalState };
