// index.js —— 对应 Go 包：internal/managedcli（JS 包入口文件）
// 作用：汇总导出 internal/managedcli 目录下全部 13 个跨平台对照模块的符号，并确保各文件挂在
// Manager.prototype 与 release.prototype 上的同包方法在加载包时全部就位，满足 cmd/agentflow/cli.js
// 等调用方按包目录 require("../../internal/managedcli") 的使用方式。
// 职责边界：仅做模块加载与导出汇总，不包含任何业务逻辑；4 个按 Go 构建标签二选一的平台文件
// （command_unix.js / command_other.js、coordinator_unix.js / coordinator_unsupported.js）
// 分别由 command_capture.js 与 coordinator.js 在加载时按 process.platform 自行选择，不在此处直接导出。

"use strict";

const manifest = require("./manifest.js");
const providers = require("./providers.js");
const registry = require("./registry.js");
const vendor = require("./vendor.js");
const vendorArchive = require("./vendor_archive.js");
const vendorObservation = require("./vendor_observation.js");
const npm = require("./npm.js");
const npmConfig = require("./npm_config.js");
const updater = require("./updater.js");
const argumentProbe = require("./argument_probe.js");
const commandCapture = require("./command_capture.js");
const coordinator = require("./coordinator.js");
const scheduler = require("./scheduler.js");

module.exports = {
  ...manifest,
  ...providers,
  ...registry,
  ...vendor,
  ...vendorArchive,
  ...vendorObservation,
  ...npm,
  ...npmConfig,
  ...updater,
  ...argumentProbe,
  ...commandCapture,
  ...coordinator,
  ...scheduler,
};
