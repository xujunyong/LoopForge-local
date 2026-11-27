/**
 * @file internal/engine/repository_cache.js
 * 对应 Go 源文件：internal/engine/repository_cache.go
 *
 * 作用与职责边界：
 * 使用宿主机仓库缓存为运行工作区克隆出自包含（self-contained）的 Git 检出目录；
 * 当缓存不可用且非主动停止或上下文取消时，记录日志并返回 `false`，由调用方回退到直接克隆。
 *
 * 语法差异说明：
 * - Go 的 `context.Context` 译为 `AbortSignal`（或 `null`）。
 * - Go 的 `(bool, error)` 返回按统一约定译为成功返回 `boolean`、失败 `throw err`。
 * - Go 的 `log.Printf` 译为 `console.log`。
 */

"use strict";

const { RepositoryCacheFrom, RepositoryCachePath, CloneFromRepositoryCache } = require("../gitwork/repository_cache.js"); // 对应 Go 的 gitwork.RepositoryCacheFrom/RepositoryCachePath/CloneFromRepositoryCache，gitwork 待翻译
const { Stopped } = require("../procwatch/procwatch.js"); // 对应 Go 的 procwatch.Stopped，procwatch 待翻译
const { cloneWatch } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 已翻译

/**
 * 尝试使用宿主机仓库缓存将指定仓库分支克隆为自包含工作区。
 * 使用场景：在 `prepareRepository` 首次检出远端仓库时优先命中本地缓存，减少网络传输；
 * 返回 `false` 且不抛出错误时，表示调用方应回退到直接克隆。
 *
 * @param {AbortSignal|null} ctx - 取消信号，同时用于提取宿主机仓库缓存根目录。
 * @param {string} workspace - 目标运行工作区目录路径。
 * @param {object} repository - 仓库上下文对象（`domain.RepositoryContext`，含 `RepositoryID`、`CloneURL` 等）。
 * @param {string} branch - 目标检出分支名。
 * @returns {boolean} 通过缓存成功克隆返回 `true`；缓存未配置或不可用需回退直接克隆返回 `false`。
 * @throws {Error} 克隆因进程监控中止（`procwatch.Stopped`）或上下文已取消而失败时抛出错误。
 */
function cloneFromRepositoryCache(ctx, workspace, repository, branch) {
  const root = RepositoryCacheFrom(ctx);
  const remote = repository.CloneURL.trim();
  if (remote === "" || branch.trim() === "" || RepositoryCachePath(root, repository.RepositoryID) === "") {
    return false;
  }
  try {
    CloneFromRepositoryCache(ctx, root, repository.RepositoryID, remote, branch, workspace, true, cloneWatch(repository));
  } catch (err) {
    if (Stopped(err) || (ctx instanceof AbortSignal && ctx.aborted)) {
      throw err;
    }
    console.log(`repository ${repository.RepositoryID}: repository cache unavailable, cloning fully: ${err}`);
    return false;
  }
  return true;
}

module.exports = { cloneFromRepositoryCache };
