// conflict_blocks.js —— 对应 Go 文件：internal/domain/conflict_blocks.go
// 作用：从冲突文件中提取带裁剪的冲突块（ours/theirs 两侧）。

"use strict";

const fs = require("node:fs"); // Go os.ReadFile
const path = require("node:path"); // Go path/filepath

// 提取上限：单个文件、总量、单侧字符数。
const maxBlocksPerFile = 4;
const maxTotalBlocks = 8;
const maxBlockSideRunes = 1600;

// ExtractConflictBlocks：读带合并标记的冲突文件，返回裁剪后的冲突块，二进制文件跳过。
function ExtractConflictBlocks(dir, files) {
  const out = [];
  for (const f of files) {
    if (out.length >= maxTotalBlocks) {
      break;
    }
    let data;
    try {
      // Go 的 filepath.FromSlash 在 Linux 下无操作，直接用 path.join。
      data = fs.readFileSync(path.join(dir, f));
    } catch {
      continue;
    }
    if (data.length === 0 || !isValidUTF8(data) || data.includes(0)) {
      continue;
    }
    out.push(...ParseConflictMarkers(f, data, maxBlocksPerFile));
  }
  if (out.length > maxTotalBlocks) {
    return out.slice(0, maxTotalBlocks);
  }
  return out;
}

// ParseConflictMarkers：从 <<<<<<< / ======= / >>>>>>> 段提取至多 max 个冲突块。
function ParseConflictMarkers(file, data, max) {
  const lines = data.toString("utf8").split("\n");
  const out = [];
  let ours = [];
  let theirs = [];
  let state = 0; // 0 正常，1 ours，2 theirs
  for (const ln of lines) {
    if (ln.startsWith("<<<<<<<")) {
      if (state === 2) { // 畸形嵌套：先刷出已有内容
        out.push(newConflictBlock(file, ours, theirs));
        if (out.length >= max) {
          return out;
        }
      }
      ours = [];
      theirs = [];
      state = 1;
    } else if (ln.startsWith("=======") && state === 1) {
      state = 2;
    } else if (ln.startsWith(">>>>>>>") && state === 2) {
      out.push(newConflictBlock(file, ours, theirs));
      ours = [];
      theirs = [];
      state = 0;
      if (out.length >= max) {
        return out;
      }
    } else {
      switch (state) {
        case 1:
          ours.push(ln);
          break;
        case 2:
          theirs.push(ln);
          break;
        default:
          break;
      }
    }
  }
  return out;
}

function newConflictBlock(file, ours, theirs) {
  return { File: file, Ours: clipConflictLines(ours), Theirs: clipConflictLines(theirs) };
}

function clipConflictLines(ls) {
  const maxLines = 40;
  if (ls.length > maxLines) {
    ls = [...ls.slice(0, maxLines), "…（截断）"];
  }
  let s = ls.join("\n");
  // Go 的 []rune(s)：按 Unicode 码点计数，JS 用 [...s] 展开。
  if ([...s].length > maxBlockSideRunes) {
    s = [...s].slice(0, maxBlockSideRunes).join("") + "…（截断）";
  }
  return s;
}

// isValidUTF8：对应 Go utf8.Valid，非法 UTF-8 返回 false。
function isValidUTF8(data) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

module.exports = { ExtractConflictBlocks, ParseConflictMarkers };
