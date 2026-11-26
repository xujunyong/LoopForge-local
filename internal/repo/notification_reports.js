/**
 * @file internal/repo/notification_reports.js
 * 对应 Go 源文件：internal/repo/notification_reports.go
 *
 * 作用与职责边界：
 * 为 `NotificationsRepo` 提供通知报告生成完成后的冻结落盘方法，通过校验投递状态、租约令牌与待生成状态，
 * 拦住已失去租约的过期 worker，并在实际发送外部消息前先将渲染好的报告内容持久化。
 * 不负责调用大模型生成报告正文或执行外部 IM 消息投递。
 *
 * 语法差异说明：
 * - Go 的 `(bool, error)` 返回值在 JS 中统一译为成功返回布尔值、失败 `throw err`。
 * - Go 的 `map[string]any` 译为普通对象字面量 `{}`，GORM 调用链按原样保留。
 */

"use strict";

const { NotificationDelivery } = require("../domain/notification.js"); // 对应 Go 的 domain.NotificationDelivery，notification.js 已翻译
const { NotificationsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/**
 * 在校验投递记录仍处于当前 worker 租约且报告状态为 `"pending"` 的前提下，持久化生成的报告正文并清空报告请求载荷。
 * 使用场景：AI 通知报告生成完成后、执行实际推送前调用，用于防重与拦截过期 worker 覆写。
 *
 * @param {NotificationDelivery} item - 包含目标记录 ID、租约令牌以及待落盘报告内容与状态的投递对象。
 * @returns {boolean} 成功冻结并更新恰好 1 行时返回 `true`，租约失效或已被其他 worker 处理时返回 `false`。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
NotificationsRepo.prototype.FreezeNotificationReport = function (item) {
  const result = this.DB.Model(new NotificationDelivery()).Where("id = ? AND status = ? AND lease_token = ? AND report_state = ?", item.ID, "sending", item.LeaseToken, "pending").Updates({
    content: item.Content, content_source: item.ContentSource, report_state: item.ReportState, report_error: item.ReportError, report_request: "",
  });
  if (result.Error != null) {
    throw result.Error;
  }
  return result.RowsAffected === 1;
};
