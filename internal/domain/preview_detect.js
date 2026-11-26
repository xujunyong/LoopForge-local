/**
 * @file internal/domain/preview_detect.js
 * @description 对应 Go 源文件：internal/domain/preview_detect.go
 * 职责边界：通过受限深度与文件数上限的目录扫描，判断给定工作区是否包含前端工程或静态站点产物，并返回命中证据，用于非前端仓库自动跳过预览构建。
 * 语法差异说明：
 * - Go 的 `os`、`io/fs` 与 `path/filepath` 对应 Node.js 内置模块 `node:fs` 与 `node:path`。
 * - Go 的 `(bool, string)` 双返回值译为 `[boolean, string]` 二元数组。
 * - Go 的 `map[string]bool` 集合统一译为普通对象 `{}`（值为 `true`）。
 */

"use strict";

const fs = require("node:fs"); // Go os、io/fs
const path = require("node:path"); // Go path/filepath

const maxPreviewDetectDepth = 6;
const maxPreviewDetectFiles = 8000;

const previewDetectSkipDirs = {
  node_modules: true,
  ".git": true,
  ".svn": true,
  ".hg": true,
  vendor: true,
  ".agentflow": true,
  ".next": true,
  ".nuxt": true,
  ".output": true,
  ".cache": true,
  ".turbo": true,
  coverage: true,
  tmp: true,
  temp: true,
};

const frontendConfigFiles = {
  "vite.config.js": true,
  "vite.config.ts": true,
  "vite.config.mjs": true,
  "vite.config.cjs": true,
  "webpack.config.js": true,
  "webpack.config.ts": true,
  "webpack.config.mjs": true,
  "rspack.config.js": true,
  "rspack.config.ts": true,
  "next.config.js": true,
  "next.config.mjs": true,
  "next.config.ts": true,
  "nuxt.config.js": true,
  "nuxt.config.ts": true,
  "angular.json": true,
  "svelte.config.js": true,
  "astro.config.mjs": true,
  "astro.config.ts": true,
  "vue.config.js": true,
  "remix.config.js": true,
};

const frontendIndexNames = {
  "index.html": true,
  "index.htm": true,
};

const frontendDepNames = {
  react: true,
  "react-dom": true,
  "react-scripts": true,
  preact: true,
  vue: true,
  nuxt: true,
  next: true,
  svelte: true,
  "@sveltejs/kit": true,
  vite: true,
  webpack: true,
  rspack: true,
  "@rspack/core": true,
  "@angular/core": true,
  "@angular/cli": true,
  "solid-js": true,
  lit: true,
  astro: true,
  gatsby: true,
  "@remix-run/react": true,
  parcel: true,
  umi: true,
  "@vitejs/plugin-react": true,
  "@vitejs/plugin-vue": true,
};

const frontendScriptTokens = [
  "vite",
  "webpack",
  "rspack",
  "next build",
  "next start",
  "next dev",
  "nuxt",
  "react-scripts",
  "vue-cli-service",
  "ng build",
  "ng serve",
  "svelte-kit",
  "astro build",
  "astro dev",
  "parcel",
];

/**
 * 解析 `package.json` 时使用的轻量依赖与脚本结构。
 * 仅提取依赖声明和 scripts 字段以识别前端框架或构建工具。
 */
class npmPackageJSON {
  /**
   * 构造 `package.json` 局部解析结果，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {Object.<string, string>} [init.Dependencies={}] - 运行时依赖映射。
   * @param {Object.<string, string>} [init.DevDependencies={}] - 开发依赖映射。
   * @param {Object.<string, string>} [init.PeerDependencies={}] - 对等依赖映射。
   * @param {Object.<string, string>} [init.Scripts={}] - npm 脚本命令映射。
   */
  constructor(init = {}) {
    this.Dependencies = init.Dependencies ?? {};
    this.DevDependencies = init.DevDependencies ?? {};
    this.PeerDependencies = init.PeerDependencies ?? {};
    this.Scripts = init.Scripts ?? {};
  }
}

/**
 * 检测给定工作区根目录是否包含前端工程或已构建的静态站点。
 * 供预览构建流程在启动前判断，使非前端仓库跳过预览而不是编造页面或导致 SOP 失败。
 *
 * @param {string} root - 待检测的工作区根目录绝对或相对路径。
 * @returns {[boolean, string]} 二元组 `[是否为前端工程, 命中证据或未命中原因说明]`。
 */
function DetectFrontendProject(root) {
  root = root.trim();
  if (root === "") {
    return [false, "工作区为空"];
  }
  let info;
  try {
    info = fs.statSync(root);
  } catch {
    return [false, "工作区不可读"];
  }
  if (!info.isDirectory()) {
    return [false, "工作区不可读"];
  }
  let found = false;
  let evidence = "";
  let files = 0;
  // filepath.WalkDir 按字典序遍历；found 与文件数上限相当于返回 SkipAll。
  const walk = (dir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of entries) {
      if (found || files > maxPreviewDetectFiles) {
        return;
      }
      const rel = relDir === "" ? d.name : relDir + "/" + d.name;
      if (d.isDirectory()) {
        if (previewDetectSkipDir(d.name, rel)) {
          continue;
        }
        walk(path.join(dir, d.name), rel);
        continue;
      }
      files++;
      if (files > maxPreviewDetectFiles) {
        return;
      }
      const [hit, why] = frontendFileEvidence(path.join(dir, d.name), rel, d.name);
      if (hit) {
        found = true;
        evidence = why;
        return;
      }
    }
  };
  walk(root, "");
  if (found) {
    return [true, evidence];
  }
  return [false, "未发现 Vite/webpack/Next 配置、前端依赖或 index.html"];
}

/**
 * 判断扫描过程中遇到的目录是否应当剪枝跳过。
 * 命中常见依赖、缓存、版本控制目录，或相对深度达到 `maxPreviewDetectDepth` 时返回 `true`。
 *
 * @param {string} name - 目录名。
 * @param {string} rel - 相对工作区根目录的正斜杠路径。
 * @returns {boolean} 需要跳过该目录时返回 `true`，否则返回 `false`。
 */
function previewDetectSkipDir(name, rel) {
  if (previewDetectSkipDirs[name.toLowerCase()]) {
    return true;
  }
  return (rel.match(/\//g) || []).length >= maxPreviewDetectDepth;
}

/**
 * 检查单个文件是否足以证明工作区包含前端工程，并返回对应证据说明。
 * 命中首页或构建器配置文件时返回其相对路径；命中带前端依赖或脚本的 `package.json` 时返回 `"<rel> (<原因>)"`。
 *
 * @param {string} filePath - 文件的完整路径。
 * @param {string} rel - 文件相对工作区根目录的正斜杠路径。
 * @param {string} name - 文件名。
 * @returns {[boolean, string]} 二元组 `[是否命中前端特征, 命中证据字符串]`。
 */
function frontendFileEvidence(filePath, rel, name) {
  const lower = name.toLowerCase();
  if (frontendIndexNames[lower] || frontendConfigFiles[lower]) {
    return [true, rel];
  }
  if (lower !== "package.json") {
    return [false, ""];
  }
  const [hit, why] = packageJSONFrontend(filePath);
  if (hit) {
    return [true, rel + " (" + why + ")"];
  }
  return [false, ""];
}

/**
 * 读取并解析 `package.json`，检查其依赖列表或构建脚本中是否包含已知前端框架/打包工具。
 *
 * @param {string} filePath - `package.json` 文件路径。
 * @returns {[boolean, string]} 二元组 `[是否包含前端特征, 命中的依赖名或 "scripts:<关键字>"]`。
 */
function packageJSONFrontend(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [false, ""];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [false, ""];
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [false, ""];
  }
  const pkg = new npmPackageJSON({
    Dependencies: parsed.dependencies ?? {},
    DevDependencies: parsed.devDependencies ?? {},
    PeerDependencies: parsed.peerDependencies ?? {},
    Scripts: parsed.scripts ?? {},
  });
  for (const group of [pkg.Dependencies, pkg.DevDependencies, pkg.PeerDependencies]) {
    for (const name of Object.keys(group ?? {})) {
      if (frontendDepNames[name.toLowerCase()]) {
        return [true, name];
      }
    }
  }
  for (const cmd of Object.values(pkg.Scripts ?? {})) {
    const lower = String(cmd).toLowerCase();
    for (const token of frontendScriptTokens) {
      if (lower.includes(token)) {
        return [true, "scripts:" + token];
      }
    }
  }
  return [false, ""];
}

module.exports = { DetectFrontendProject };
