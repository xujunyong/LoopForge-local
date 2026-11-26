/**
 * 对应 Go 文件：internal/domain/conflict_blocks.go
 * 作用：从合并冲突的文本文件中读取并解析 Git 冲突标记，按上限裁剪后生成冲突块列表。
 * 职责边界：仅负责本地冲突文件的读取、UTF-8 文本过滤、冲突标记解析与长度裁剪，不执行 Git 合并操作。
 * 语法差异说明：Go 的 os.ReadFile / path/filepath 对应 node:fs 与 node:path；
 * Go 的 utf8.Valid 用 TextDecoder({ fatal: true }) 等价表达；Go 的 []rune 按 Unicode 码点计数，用 [...s] 展开。
 */

"use strict";

const fs = require("node:fs"); // 对应 Go os.ReadFile
const path = require("node:path"); // 对应 Go path/filepath

/** 单个文件最多提取的冲突块数量，防止复杂合并导致提示词膨胀。 */
const maxBlocksPerFile = 4;
/** 单次提取总共最多返回的冲突块数量。 */
const maxTotalBlocks = 8;
/** 单个冲突块单侧（ours 或 theirs）最多保留的 Unicode 字符数。 */
const maxBlockSideRunes = 1600;

/**
 * 从冲突的工作区目录中读取指定文件，提取并裁剪其中的 Git 合并冲突块。
 * 无法读取、空文件、非合法 UTF-8 或含空字节的二进制文件会被跳过。
 *
 * @param {string} dir - 发生合并冲突的工作区根目录路径。
 * @param {string[]} files - 相对工作区根目录的冲突文件路径列表。
 * @returns {Array<{ File: string, Ours: string, Theirs: string }>} 提取并裁剪后的冲突块数组，总数不超过 maxTotalBlocks。
 */
function ExtractConflictBlocks(dir, files) {
  const out = [];
  for (const f of files) {
    if (out.length >= maxTotalBlocks) {
      break;
    }
    let data;
    try {
      // Go 的 filepath.FromSlash 将斜杠转为系统分隔符，Node 的 path.join 会自动规范化分隔符。
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

/**
 * 从文件内容字节流中解析 `<<<<<<< / ======= / >>>>>>>` 冲突段，最多返回 max 个冲突块。
 * 其中 ours 对应当前集成侧（HEAD），theirs 对应目标默认分支侧。
 *
 * @param {string} file - 冲突文件路径，写入返回冲突块的 File 字段。
 * @param {Buffer} data - 冲突文件的原始 UTF-8 字节内容。
 * @param {number} max - 最多提取的冲突块数量上限。
 * @returns {Array<{ File: string, Ours: string, Theirs: string }>} 解析并裁剪后的冲突块列表。
 */
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

/**
 * 组装单个裁剪后的冲突块对象。
 * 供 ParseConflictMarkers 在匹配到完整冲突段或异常嵌套刷出时调用。
 *
 * @param {string} file - 冲突文件路径。
 * @param {string[]} ours - 当前侧（HEAD）的冲突内容行数组。
 * @param {string[]} theirs - 对端（默认分支侧）的冲突内容行数组。
 * @returns {{ File: string, Ours: string, Theirs: string }} 裁剪后的冲突块对象。
 */
function newConflictBlock(file, ours, theirs) {
  return { File: file, Ours: clipConflictLines(ours), Theirs: clipConflictLines(theirs) };
}

/**
 * 按行数上限（40 行）与 Unicode 字符数上限（maxBlockSideRunes）裁剪冲突块单侧文本。
 * 超出上限时在末尾追加截断提示，避免阻塞信息或提示词过长。
 *
 * @param {string[]} ls - 冲突块单侧的文本行数组。
 * @returns {string} 拼接并按规则裁剪后的多行字符串。
 */
function clipConflictLines(ls) {
  const maxLines = 40;
  if (ls.length > maxLines) {
    ls = [...ls.slice(0, maxLines), "…（截断）"];
  }
  let s = ls.join("\n");
  // Go 的 []rune(s) 按 Unicode 码点计数，JS 用 [...s] 展开后按码点切片。
  if ([...s].length > maxBlockSideRunes) {
    s = [...s].slice(0, maxBlockSideRunes).join("") + "…（截断）";
  }
  return s;
}

/**
 * 校验字节缓冲区是否为合法的 UTF-8 编码，对应 Go 标准库 utf8.Valid。
 * 供 ExtractConflictBlocks 跳过非文本或编码损坏的文件。
 *
 * @param {Buffer|Uint8Array} data - 待校验的原始字节序列。
 * @returns {boolean} 合法 UTF-8 返回 true，否则返回 false。
 */
function isValidUTF8(data) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

module.exports = { ExtractConflictBlocks, ParseConflictMarkers };
