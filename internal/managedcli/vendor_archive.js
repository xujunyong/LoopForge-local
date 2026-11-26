// vendor_archive.js —— 对应 Go 文件：internal/managedcli/vendor_archive.go
// 作用：在严格的总字节数、条目数与路径边界限制下，解压供应商直供的 .tar.gz 归档文件到目标目录。
// 职责边界：仅负责 gzip/tar 解包与防路径逃逸校验，不执行网络下载、哈希校验或启动脚本写入。
// 语法差异说明：
// - Go 的 compress/gzip 与 archive/tar 在 Node 标准库无直接 tar 流解析器，此处使用 node:zlib.gunzipSync 解压后按 512 字节 ustar 块解析；
// - Go 的 os.OpenRoot 防逃逸边界通过相对路径检查 + path.join 对应实现；
// - Go 的 context.Context 译为 AbortSignal；error 返回译为成功无返回值、失败 throw Error。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const maxExpandedVendorArchive = 1 << 30;
const maxVendorMembers = 20000;

// tar 条目类型标志位，与 Go archive/tar 常量同值。
const tarTypeReg = 0x30; // '0'
const tarTypeDir = 0x35; // '5'
const tarTypeSymlink = 0x32; // '2'

/**
 * 解压供应商直供的 .tar.gz 归档到新建目录 dest，校验解压总大小、条目数量、目录前缀与符号链接边界。
 * 在 vendor.js 的 installVendorArtifact 校验完归档 SHA512 后调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 供应商名称（"agy" 仅提取 antigravity 文件并重命名为 agy；其余按 Cursor 的 dist-package/ 布局提取）。
 * @param {string} archive 待解压的 .tar.gz 本地文件路径。
 * @param {string} dest 解压输出目录的绝对路径（必须尚不存在，由本函数以 0700 权限新建）。
 * @returns {void} 无返回值；解压失败、超出大小/条目上限、检测到路径逃逸或取消信号触发时抛出错误。
 */
function extractVendorArchive(ctx, provider, archive, dest) {
  const compressed = fs.readFileSync(archive);
  // Go 使用 gzip 流 + LimitedReader 限流；此处整包解压后按同一字节上限校验（gunzipSync 同时校验 gzip 校验和）。
  const expanded = zlib.gunzipSync(compressed);
  if (expanded.length >= maxExpandedVendorArchive + (maxVendorMembers + 1) * 1024) {
    throw new Error("expanded vendor archive exceeds size limit");
  }
  fs.mkdirSync(dest, { mode: 0o700 });
  let total = 0;
  let offset = 0;
  let i = 0;
  for (;; i++) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason; // 对应 Go：ctx.Err()
    }
    if (offset + 512 > expanded.length) {
      break;
    }
    const header = expanded.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) {
      break;
    }
    const h = parseTarHeader(header);
    if (i >= maxVendorMembers || h.Size < 0 || h.Size > maxExpandedVendorArchive - total) {
      throw new Error("expanded vendor archive exceeds size limit");
    }
    total += h.Size;
    // Go 的 path.Clean 会去掉非根路径尾部的斜杠；Node 的 path.posix.normalize 会保留尾斜杠，需手动去除以保持一致。
    let name = path.posix.normalize(h.Name);
    if (name.length > 1 && name.endsWith("/")) {
      name = name.replace(/\/+$/, "");
    }
    if (provider === "agy") {
      if (name !== "antigravity") {
        offset += Math.ceil(h.Size / 512) * 512;
        continue;
      }
      if (h.Typeflag !== tarTypeReg) {
        throw new Error("Antigravity archive entry is not a regular file");
      }
      name = "agy";
    } else {
      if (name === "dist-package" && h.Typeflag === tarTypeDir) {
        offset += Math.ceil(h.Size / 512) * 512;
        continue;
      }
      if (!name.startsWith("dist-package/")) {
        throw new Error("Cursor archive entry escapes its distribution directory");
      }
      name = name.slice("dist-package/".length);
    }
    if (offset + h.Size > expanded.length) {
      throw new Error("unexpected EOF");
    }
    const content = expanded.subarray(offset, offset + h.Size);
    offset += Math.ceil(h.Size / 512) * 512;
    extractVendorMember(dest, content, name, h);
  }
}

/**
 * 按 POSIX ustar 格式解析单个 512 字节 tar 头块，提取路径名、字节大小、权限位、类型标志与链接目标。
 * 仅供 extractVendorArchive 内部逐块读取 tar 归档时调用。
 *
 * @param {Buffer} header 长度为 512 字节的 tar 头缓冲区。
 * @returns {{Name: string, Size: number, Mode: number, Typeflag: number, Linkname: string}} 解析后的 tar 头字段对象。
 */
function parseTarHeader(header) {
  const readString = (start, len) => {
    const end = header.indexOf(0, start);
    const stop = end === -1 || end > start + len ? start + len : end;
    return header.toString("utf8", start, stop);
  };
  let name = readString(0, 100);
  // POSIX ustar 规范中 prefix 字段位于字节偏移 345，长度 155 字节。
  const prefix = readString(345, 155);
  if (prefix !== "") {
    name = prefix + "/" + name;
  }
  const sizeText = readString(124, 12).trim();
  const size = sizeText === "" ? 0 : parseInt(sizeText, 8);
  // 传统 V7 tar 使用 0x00 表示普通文件，与 Go archive/tar 一致归一化为 tarTypeReg ('0')。
  const typeflag = header[156] === 0 ? tarTypeReg : header[156];
  return {
    Name: name,
    Size: size,
    Mode: parseInt(readString(100, 8).trim() || "0", 8),
    Typeflag: typeflag,
    Linkname: readString(157, 100),
  };
}

/**
 * 将单个 tar 条目（目录、普通文件或相对符号链接）安全写入目标安装根目录 dest 内。
 * 在 extractVendorArchive 校验完条目归属后调用；拒绝任何绝对路径、父目录穿越或不受支持的条目类型。
 *
 * @param {string} dest 解压根目录的绝对路径。
 * @param {Buffer} content 当前条目的文件内容字节切片。
 * @param {string} name 相对于 dest 的规范化条目路径。
 * @param {{Name: string, Size: number, Mode: number, Typeflag: number, Linkname: string}} h 解析后的 tar 头对象。
 * @returns {void} 无返回值；条目路径越界、符号链接逃逸、类型不支持或写入失败时抛出错误。
 */
function extractVendorMember(dest, content, name, h) {
  // 对应 Go 的 os.OpenRoot(dest)：拒绝任何绝对路径或向上穿越 dest 的条目路径。
  if (path.posix.isAbsolute(name) || name === ".." || name.startsWith("../")) {
    throw new Error("vendor archive entry escapes its installation");
  }
  const target = path.join(dest, name);
  if (h.Typeflag === tarTypeDir) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  switch (h.Typeflag) {
    case tarTypeReg: {
      let mode = 0o600;
      if ((h.Mode & 0o111) !== 0) {
        mode |= 0o100;
      }
      const fd = fs.openSync(target, "wx", mode);
      try {
        fs.writeSync(fd, content);
      } finally {
        fs.closeSync(fd);
      }
      return;
    }
    case tarTypeSymlink: {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), h.Linkname));
      if (path.posix.isAbsolute(h.Linkname) || resolved === ".." || resolved.startsWith("../")) {
        throw new Error("vendor archive symlink escapes its installation");
      }
      fs.symlinkSync(h.Linkname, target);
      return;
    }
    default:
      throw new Error("unsupported vendor archive entry type");
  }
}

module.exports = { maxExpandedVendorArchive, maxVendorMembers, extractVendorArchive, extractVendorMember };
