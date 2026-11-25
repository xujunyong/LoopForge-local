// index.js —— Go 包 internal/managedcli 的 JS 包入口。
// Go 的包即目录，import 直接用包名；JS 里 require 目录需要一个入口文件，
// 这里把 17 个对照文件导出的内容汇总成一个包对象。
// 注：command_unix.js 与 command_other.js、coordinator_unix.js 与
// coordinator_unsupported.js 是 Go 构建标签的二选一文件，不由入口汇总导出；
// 选用哪边由 command_capture.js 与 coordinator.js 在加载时按 process.platform 决定。

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
