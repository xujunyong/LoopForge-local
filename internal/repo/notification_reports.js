// notification_reports.js —— 对应 Go 文件：internal/repo/notification_reports.go
// 作用：通知报告生成前的冻结：拦住过期 worker，先落盘内容再发送。

"use strict";

const { NotificationDelivery } = require("../domain/notification.js"); // 对应 Go 的 domain.NotificationDelivery，notification.js 已翻译
const { NotificationsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// FreezeNotificationReport：冻结通知报告，拦住过期 worker 并先落盘内容再发送。
NotificationsRepo.prototype.FreezeNotificationReport = function (item) {
  const result = this.DB.Model(new NotificationDelivery()).Where("id = ? AND status = ? AND lease_token = ? AND report_state = ?", item.ID, "sending", item.LeaseToken, "pending").Updates({
    content: item.Content, content_source: item.ContentSource, report_state: item.ReportState, report_error: item.ReportError, report_request: "",
  });
  if (result.Error != null) {
    throw result.Error;
  }
  return result.RowsAffected === 1;
};
