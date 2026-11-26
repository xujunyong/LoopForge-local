// repository_cache.js —— 对应 Go 文件：internal/engine/repository_cache.go
// 作用：用宿主机仓库缓存克隆出自包含的工作区，缓存不可用时返回 false 让调用方直接克隆。
// context.Context 译为 AbortSignal；(值, error) 译为 [值, error]。

"use strict";

const { RepositoryCacheFrom, RepositoryCachePath, CloneFromRepositoryCache } = require("../gitwork/repository_cache.js"); // 对应 Go 的 gitwork.RepositoryCacheFrom/RepositoryCachePath/CloneFromRepositoryCache，gitwork 待翻译
const { Stopped } = require("../procwatch/procwatch.js"); // 对应 Go 的 procwatch.Stopped，procwatch 待翻译
const { cloneWatch } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 本批翻译

// cloneFromRepositoryCache：用宿主机缓存克隆出自包含的工作区；false 且无错误表示让调用方直接克隆。
function cloneFromRepositoryCache(ctx, workspace, repository, branch) {
  const root = RepositoryCacheFrom(ctx);
  const remote = repository.CloneURL.trim();
  if (remote === "" || branch.trim() === "" || RepositoryCachePath(root, repository.RepositoryID) === "") {
    return [false, null];
  }
  let err = null;
  try {
    CloneFromRepositoryCache(ctx, root, repository.RepositoryID, remote, branch, workspace, true, cloneWatch(repository));
  } catch (e) {
    err = e;
  }
  if (err != null) {
    if (Stopped(err) || (ctx instanceof AbortSignal && ctx.aborted)) {
      return [false, err];
    }
    console.log(`repository ${repository.RepositoryID}: repository cache unavailable, cloning fully: ${err}`);
    return [false, null];
  }
  return [true, null];
}

module.exports = { cloneFromRepositoryCache };
