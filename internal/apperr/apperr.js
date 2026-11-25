// apperr.js —— 对应 Go 文件：internal/apperr/apperr.go
// 作用：按种类上报应用错误，不依赖 HTTP 层。
// Go 的 type Kind int 译为一组数值常量；type Error struct 译为类；
// 多返回值 (值, error) 译为成功返回值、失败 throw。

"use strict";

const { format } = require("node:util"); // Go fmt.Sprintf

const Invalid = 1;
const NotFound = 2;
const Conflict = 3;
const Forbidden = 4;
// Unavailable：依赖未配置。
const Unavailable = 5;
// Upstream：依赖已配置但失败了。
const Upstream = 6;

const Kind = { Invalid, NotFound, Conflict, Forbidden, Unavailable, Upstream };

// Go 的 type Error struct 叫 Error，这里改名 AppError，避免与全局 Error 同名。
class AppError extends Error {
  constructor(kind, message, fields) {
    super(message);
    this.Kind = kind;
    this.Message = message;
    this.Fields = fields;
  }

  toString() {
    return this.Message;
  }

  // With：附加一个额外响应字段。
  with(key, value) {
    if (this.Fields == null) {
      this.Fields = {};
    }
    this.Fields[key] = value;
    return this;
  }
}

function New(kind, message) {
  return new AppError(kind, message);
}

function Newf(kind, fmt, ...args) {
  return new AppError(kind, format(fmt, ...args));
}

// As：从 err 的链上取出 *Error。Go errors.As 沿 cause 链找，JS 沿 err.cause 找。
function As(err) {
  let cur = err;
  while (cur != null) {
    if (cur instanceof AppError) {
      return [cur, true];
    }
    cur = cur.cause;
  }
  return [null, false];
}

module.exports = { Kind, Invalid, NotFound, Conflict, Forbidden, Unavailable, Upstream, Error: AppError, New, Newf, As };
