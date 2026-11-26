// apperr.js —— 对应 Go 文件：internal/apperr/apperr.go
// 作用与职责边界：定义与传输层（HTTP/MCP）解耦的应用错误种类与错误对象，
// 供各业务服务按错误种类上报异常，由上层传输层自行映射为对应状态码。
// 语法差异说明：Go 的 type Kind int 译为数值常量；Go 的 type Error struct 改名为 AppError
// 以避免与全局内置 Error 冲突；多返回值 (值, bool) 译为 [值, boolean] 元组。

"use strict";

const { format } = require("node:util"); // 对应 Go 标准库 fmt.Sprintf

/** 参数非法错误种类。 */
const Invalid = 1;
/** 资源不存在错误种类。 */
const NotFound = 2;
/** 资源冲突错误种类。 */
const Conflict = 3;
/** 权限不足错误种类。 */
const Forbidden = 4;
/** 必需的外部依赖尚未配置。 */
const Unavailable = 5;
/** 外部依赖已配置，但上游调用失败。 */
const Upstream = 6;

/**
 * 错误种类枚举映射，便于按 Kind.Xxx 方式引用。
 * @type {{ Invalid: number, NotFound: number, Conflict: number, Forbidden: number, Unavailable: number, Upstream: number }}
 */
const Kind = { Invalid, NotFound, Conflict, Forbidden, Unavailable, Upstream };

/**
 * 应用层错误对象（对应 Go 的 apperr.Error，因与全局 Error 重名改名为 AppError）。
 * 用于携带错误种类、面向用户的提示文案以及可选的扩展响应字段。
 */
class AppError extends Error {
  /**
   * 构造应用错误实例，字段按 Go 零值初始化。
   * 使用场景：通过 New / Newf 或直接传入字段对象构造业务错误。
   * @param {{ Kind?: number, Message?: string, Fields?: Record<string, any> | null }} [init={}] - 初始化字段对象（Kind 错误种类、Message 错误消息、Fields 扩展响应字段）。
   */
  constructor(init = {}) {
    super(init.Message ?? "");
    this.Kind = init.Kind ?? 0;
    this.Message = init.Message ?? "";
    this.Fields = init.Fields ?? null;
  }

  /**
   * 返回面向用户的错误消息文本（对应 Go 的 error 接口方法 Error() string）。
   * 使用场景：需要直接提取应用错误文案时调用。
   * @returns {string} 错误消息字符串。
   */
  Error() {
    return this.Message;
  }

  /**
   * 将错误对象转为字符串形式，返回错误消息文本。
   * 使用场景：字符串拼接、日志打印或隐式转字符串时使用。
   * @returns {string} 错误消息字符串。
   */
  toString() {
    return this.Message;
  }

  /**
   * 为当前错误附加一个额外响应字段（例如冲突资源的 ID），并返回自身以便链式调用。
   * 使用场景：上层传输层需要把结构化上下文字段一并返回给调用方时使用。
   * @param {string} key - 附加字段的键名。
   * @param {any} value - 附加字段的值。
   * @returns {AppError} 当前错误对象自身。
   */
  With(key, value) {
    if (this.Fields == null) {
      this.Fields = {};
    }
    this.Fields[key] = value;
    return this;
  }
}

/**
 * 创建指定种类与消息的应用错误实例。
 * 使用场景：服务层需要返回确定错误分类和固定文案的错误时使用。
 * @param {number} kind - 错误种类常量（如 Invalid、NotFound 等）。
 * @param {string} message - 面向用户的错误消息。
 * @returns {AppError} 新建的 AppError 实例。
 */
function New(kind, message) {
  return new AppError({ Kind: kind, Message: message });
}

/**
 * 使用格式化模板创建指定种类的应用错误实例。
 * 使用场景：需要在错误消息中动态拼接参数时使用。
 * @param {number} kind - 错误种类常量。
 * @param {string} fmt - 格式化模板字符串（对应 Go fmt.Sprintf）。
 * @param {...any} args - 格式化参数列表。
 * @returns {AppError} 新建的 AppError 实例。
 */
function Newf(kind, fmt, ...args) {
  return new AppError({ Kind: kind, Message: format(fmt, ...args) });
}

/**
 * 沿错误原因链（cause）查找并提取 AppError 实例（对应 Go 的 errors.As）。
 * 使用场景：传输层捕获异常后判断是否为应用层错误并取出其 Kind 和 Fields。
 * @param {unknown} err - 待检查的错误对象。
 * @returns {[AppError | null, boolean]} 命中时返回 [AppError 实例, true]，否则返回 [null, false]。
 */
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
