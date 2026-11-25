// preview_detect.js —— 对应 Go 文件：internal/domain/preview_detect.go
// 作用：检测工作区是否为前端工程。

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

class npmPackageJSON {
  constructor(init = {}) {
    this.Dependencies = init.Dependencies ?? null;
    this.DevDependencies = init.DevDependencies ?? null;
    this.PeerDependencies = init.PeerDependencies ?? null;
    this.Scripts = init.Scripts ?? null;
  }
}

// DetectFrontendProject：报告工作区是否像前端工程（或已构建好的静态站点）；非前端仓库应跳过预览，而不是编造页面或让 SOP 失败。返回 [是否前端, 证据]。
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

// previewDetectSkipDir：报告 rel 处目录是否应剪枝：已知的依赖、缓存、版本控制目录，或达到 maxPreviewDetectDepth 深度。
function previewDetectSkipDir(name, rel) {
  if (previewDetectSkipDirs[name.toLowerCase()]) {
    return true;
  }
  return (rel.match(/\//g) || []).length >= maxPreviewDetectDepth;
}

// frontendFileEvidence：报告 path 处文件（rel 为相对工作区根目录的路径）是否标志工作区为前端，并给出证据串：首页或打包器配置给出斜杠路径，含前端依赖或脚本的 package.json 给出 "<rel> (<原因>)"。
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
    Dependencies: parsed.dependencies ?? null,
    DevDependencies: parsed.devDependencies ?? null,
    PeerDependencies: parsed.peerDependencies ?? null,
    Scripts: parsed.scripts ?? null,
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
