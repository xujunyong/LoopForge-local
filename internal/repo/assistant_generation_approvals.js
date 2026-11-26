// assistant_generation_approvals.js —— 对应 Go 文件：internal/repo/assistant_generation_approvals.go
// 作用：原生工具调用的审批创建、查询、决定与释放。

"use strict";

const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantNativeApproval } = require("../domain/assistant.js"); // 对应 Go 同包类型，assistant.js 已翻译
const { assistantGenerationRow, generationPayload } = require("./assistant_generations.js"); // 对应 Go 同包类型与函数，assistant_generations.js 本次一同翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// Approval state is stored in the private generation payload, so any API
// instance can answer without exposing raw tool arguments in the generation DTO.
class assistantNativeApprovalState extends AssistantNativeApproval {
  constructor(init = {}) {
    super(init);
    this.Phase = init.Phase ?? "";
    this.InputDigest = init.InputDigest ?? "";
  }
}

function nativeApprovalState(item) {
  const out = new AssistantNativeApproval({ ...item });
  out.InputDigest = item.InputDigest;
  return out;
}

// nativeApprovalGenerationActive measures the heartbeat on the same clock that
// stamped it (see heartbeatNow).
AssistantRepo.prototype.nativeApprovalGenerationActive = function (db, row) {
  return row.Status === "running" && !row.CancelRequested && !this.heartbeatLate(db, row.UpdatedAt);
};

AssistantRepo.prototype.updateNativeApprovals = function (owner, session, generation, requireLive, update) {
  return this.DB.Transaction((tx) => {
    const row = new assistantGenerationRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ? AND generation_id = ?", session, owner, generation).Take(row).Error;
    if (err != null) {
      return new Error("本轮已结束，审批已失效");
    }
    if (requireLive && !this.nativeApprovalGenerationActive(tx, row)) {
      return new Error("本轮已结束，审批已失效");
    }
    const payload = generationPayload(row);
    const updateErr = update(payload);
    if (updateErr != null) {
      return updateErr;
    }
    // Approval traffic does not renew a dead worker's lease. Only the
    // generation's existing checkpoint loop updates updated_at.
    return tx.Model(row).UpdateColumn("payload", mustJSON(payload)).Error;
  });
};

AssistantRepo.prototype.CreateNativeApproval = function (owner, session, phase, item) {
  let inputValid = false;
  try {
    JSON.parse(typeof item.Input === "string" ? item.Input : Buffer.from(item.Input).toString("utf8"));
    inputValid = true;
  } catch (err) {
    // 不是合法 JSON。
  }
  if (item.GenerationID === "" || item.ID === "" || phase === "" || item.ActorID <= 0 || item.Tool === "" || !inputValid) {
    return new Error("原生工具审批参数无效");
  }
  const inputDigest = createHash("sha256").update(item.Input).digest("hex");
  return this.updateNativeApprovals(owner, session, item.GenerationID, true, (payload) => {
    for (const old of payload.NativeApprovals) {
      if (old.ID !== item.ID) {
        continue;
      }
      if (old.Phase !== phase || old.ActorID !== item.ActorID || old.Tool !== item.Tool || old.InputDigest !== inputDigest) {
        return new Error("审批调用标识已被其他操作使用");
      }
      return null; // A transport retry is still the same invocation.
    }
    item.Decision = "pending";
    if (item.CreatedAt == null) {
      item.CreatedAt = new Date();
    }
    payload.NativeApprovals.push(new assistantNativeApprovalState({ ...item, Phase: phase, InputDigest: inputDigest }));
    return null;
  });
};

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

AssistantRepo.prototype.DecideNativeApproval = function (owner, actor, session, id, decision) {
  if (decision !== "allow" && decision !== "deny") {
    return new Error("无效审批结果");
  }
  const row = new assistantGenerationRow();
  const err = this.DB.Where("session_id = ? AND user_id = ?", session, owner).Take(row).Error;
  if (err != null) {
    return new Error("本轮已结束，审批已失效");
  }
  return this.updateNativeApprovals(owner, session, row.GenerationID, true, (payload) => {
    for (let i = 0; i < payload.NativeApprovals.length; i++) {
      const item = payload.NativeApprovals[i];
      if (item.ID !== id || item.ActorID !== actor) {
        continue;
      }
      if (item.Decision !== "pending" && item.Decision !== decision) {
        return new Error("审批已作出不同决定");
      }
      item.Decision = decision;
      // Keep only the exact-input digest for transport retries once the
      // browser no longer needs to display the full tool arguments.
      item.Input = null;
      return null;
    }
    return new Error("审批已失效或不属于当前发起人");
  });
};

// ReleaseNativeApproval removes the card for a single finished or cancelled
// gateway call. Other calls waiting in the same phase retain their approvals.
AssistantRepo.prototype.ReleaseNativeApproval = function (owner, session, generation, phase, id) {
  return this.updateNativeApprovals(owner, session, generation, false, (payload) => {
    payload.NativeApprovals = payload.NativeApprovals.filter((item) => !(item.Phase === phase && item.ID === id));
    return null;
  });
};

// ReleaseNativeApprovals revokes only the exiting CLI phase, including its
// resolved callbacks. Sibling sessions and later generations are untouched.
AssistantRepo.prototype.ReleaseNativeApprovals = function (owner, session, generation, phase) {
  return this.updateNativeApprovals(owner, session, generation, false, (payload) => {
    payload.NativeApprovals = payload.NativeApprovals.filter((item) => item.Phase !== phase);
    return null;
  });
};

module.exports = { assistantNativeApprovalState, nativeApprovalState };
