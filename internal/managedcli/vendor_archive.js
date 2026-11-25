// vendor_archive.js —— 对应 Go 文件：internal/managedcli/vendor_archive.go
// 作用：解压供应商的 .tar.gz 归档，只取白名单内的可执行文件。
// Go 的 archive/tar 与 compress/gzip 在 Node 标准库无对应：
// gzip 用 node:zlib 解压，tar 按 512 字节块逐个解析头部。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const maxExpandedVendorArchive = 1 << 30;
const maxVendorMembers = 20000;

// tar 类型标志位，与 Go 的 archive/tar 同值。
const tarTypeReg = 0x30; // '0'
const tarTypeDir = 0x35; // '5'
const tarTypeSymlink = 0x32; // '2'

async function extractVendorArchive(ctx, provider, archive, dest) {
  const compressed = fs.readFileSync(archive);
  // Go 用 gzip 流 + LimitedReader 限流；此处整包解压后按同一上限校验。
  let expanded;
  try {
    expanded = zlib.gunzipSync(compressed);
  } catch (err) {
    throw err;
  }
  if (expanded.length > maxExpandedVendorArchive + (maxVendorMembers + 1) * 1024) {
    throw new Error("expanded vendor archive exceeds size limit");
  }
  fs.mkdirSync(dest, { mode: 0o700 });
  let total = 0;
  let offset = 0;
  let i = 0;
  for (;; i++) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason; // Go：ctx.Err()
    }
    if (offset + 512 > expanded.length) {
      break; // 两个零块即 EOF；gunzipSync 已校验 gzip 校验和
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
    let name = path.posix.normalize(h.Name);
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
    const content = expanded.subarray(offset, offset + h.Size);
    offset += Math.ceil(h.Size / 512) * 512;
    extractVendorMember(dest, content, name, h);
  }
}

// parseTarHeader：按 ustar 格式读 512 字节头：名字、大小（八进制）、类型、链接目标、权限。
function parseTarHeader(header) {
  const readString = (start, len) => {
    const end = header.indexOf(0, start);
    const stop = end === -1 || end > start + len ? start + len : end;
    return header.toString("utf8", start, stop);
  };
  let name = readString(0, 100);
  const prefix = readString(155, 155);
  if (prefix !== "") {
    name = prefix + "/" + name;
  }
  const sizeText = readString(124, 12).trim();
  const size = sizeText === "" ? 0 : parseInt(sizeText, 8);
  return {
    Name: name,
    Size: size,
    Mode: parseInt(readString(100, 8).trim() || "0", 8),
    Typeflag: header[156],
    Linkname: readString(157, 100),
  };
}

function extractVendorMember(dest, content, name, h) {
  // Go 的 os.Root 把操作锁在 dest 内防逃逸；JS 无对应物，用 path.join 对应。
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
