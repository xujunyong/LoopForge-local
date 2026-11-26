// cron.js —— 对应 Go 文件：internal/cronexpr/cron.go
// 作用与职责边界：解析标准 5 段 cron 表达式（分 时 日 月 周），在 Asia/Shanghai 时区下
// 判断指定时间是否命中计划，并计算下一次触发时间。
// 语法差异说明：Go 的 uint64 位掩码译为 JS BigInt（0n 与 1n << BigInt(n)），避免 JS 普通 Number
// 按位运算被截断为 32 位有符号整数导致 32–59 分钟溢出失效；Asia/Shanghai 固定 UTC+8 且无夏令时，
// 通过加 8 小时偏移后取 UTC 字段实现时区换算。

"use strict";

/**
 * 定时表达式解析使用的时区标识（对应 Go 的 *time.Location，默认 Asia/Shanghai）。
 * @type {string}
 */
const Location = "Asia/Shanghai";

/**
 * 提取指定 Date 在 Asia/Shanghai（固定 UTC+8）下的分、时、日、月、星期各时间分量。
 * 使用场景：Schedule.Matches 判断时间点是否匹配 cron 位掩码时内部调用。
 * @param {Date} date - 待提取分量的时间对象。
 * @returns {{ minute: number, hour: number, day: number, month: number, dow: number }}
 *   分（0–59）、时（0–23）、日（1–31）、月（1–12）、周几（0–6，0 表示周日）。
 */
function shanghaiParts(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), day: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay() };
}

/**
 * 编译后的 5 段 cron 调度计划，内部以 BigInt 位掩码保存各字段允许的取值集合。
 */
class Schedule {
  /**
   * 构造 cron 计划实例，位掩码字段按 Go uint64 零值初始化为 0n，布尔字段初始化为 false。
   * 使用场景：Parse 解析表达式成功后构造返回对象。
   * @param {{
   *   min?: bigint,
   *   hour?: bigint,
   *   day?: bigint,
   *   month?: bigint,
   *   dow?: bigint,
   *   dayStar?: boolean,
   *   dowStar?: boolean
   * }} [init={}] - 初始化字段对象。
   */
  constructor(init = {}) {
    this.min = init.min ?? 0n;
    this.hour = init.hour ?? 0n;
    this.day = init.day ?? 0n;
    this.month = init.month ?? 0n;
    this.dow = init.dow ?? 0n;
    this.dayStar = init.dayStar ?? false;
    this.dowStar = init.dowStar ?? false;
  }

  /**
   * 判断给定时间点 t（按 Asia/Shanghai 时区换算）是否命中本 cron 计划。
   * 使用场景：调度器逐分钟扫描或校验时间点是否满足触发条件时调用。
   * @param {Date} t - 待匹配的时间对象。
   * @returns {boolean} 匹配返回 true，否则返回 false。
   */
  Matches(t) {
    const p = shanghaiParts(t);
    if ((this.min & (1n << BigInt(p.minute))) === 0n) {
      return false;
    }
    if ((this.hour & (1n << BigInt(p.hour))) === 0n) {
      return false;
    }
    if ((this.month & (1n << BigInt(p.month))) === 0n) {
      return false;
    }
    const dayOK = (this.day & (1n << BigInt(p.day))) !== 0n;
    const dowOK = (this.dow & (1n << BigInt(p.dow))) !== 0n;
    // 标准 cron 语义：日与周均受限时任一命中即可；若其中任一段以 * 开头，则需同时满足。
    if (this.dayStar || this.dowStar) {
      return dayOK && dowOK;
    }
    return dayOK || dowOK;
  }
}

/**
 * 5 个 cron 字段按表达式顺序排列的名称（用于错误前缀）及闭区间取值范围。
 * @type {Array<{ name: string, min: number, max: number }>}
 */
const fieldSpecs = [
  { name: "分钟", min: 0, max: 59 },
  { name: "小时", min: 0, max: 23 },
  { name: "日", min: 1, max: 31 },
  { name: "月", min: 1, max: 12 },
  { name: "周", min: 0, max: 7 },
];

/**
 * 解析标准 5 段 cron 表达式并返回编译后的 Schedule 对象。
 * 使用场景：保存定时任务时校验表达式合法性，或 Next() 计算下次执行时间前调用。
 * @param {string} expr - 5 段空格分隔的 cron 表达式（如 "0 * * * *"）。
 * @returns {Schedule} 解析生成的 Schedule 实例；段数不对或任意段非法时抛出 Error。
 */
function Parse(expr) {
  const fields = expr.trim().split(/\s+/).filter((s) => s !== "");
  if (fields.length !== fieldSpecs.length) {
    throw new Error("cron 需为 5 段（分 时 日 月 周），例如 0 * * * *");
  }
  const bits = [];
  for (let i = 0; i < fieldSpecs.length; i++) {
    const spec = fieldSpecs[i];
    try {
      bits[i] = parseField(fields[i], spec.min, spec.max);
    } catch (e) {
      throw new Error(`${spec.name}: ${e.message}`, { cause: e });
    }
  }
  let dow = bits[4];
  if ((dow & (1n << 7n)) !== 0n) {
    dow |= 1n << 0n;
  }
  return new Schedule({
    min: bits[0], hour: bits[1], day: bits[2], month: bits[3], dow,
    dayStar: fields[2].startsWith("*"),
    dowStar: fields[4].startsWith("*"),
  });
}

/**
 * 解析单个 cron 字段（支持逗号列表、星号、范围 a-b 与步长 /step），返回对应的 BigInt 位掩码。
 * 使用场景：Parse 遍历 5 个字段时内部调用。
 * @param {string} raw - 单段原始字段文本（如 "*\/5"、"1,15"、"1-5"）。
 * @param {number} min - 该字段允许的最小整数值（含）。
 * @param {number} max - 该字段允许的最大整数值（含）。
 * @returns {bigint} 聚合后的允许取值位掩码；格式非法、越界或无有效取值时抛出 Error。
 */
function parseField(raw, min, max) {
  raw = raw.trim();
  if (raw === "") {
    throw new Error("为空");
  }
  let bits = 0n;
  for (let part of raw.split(",")) {
    part = part.trim();
    if (part === "") {
      throw new Error("无效分段");
    }
    let step = 1;
    let rangePart = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      rangePart = part.slice(0, slash);
      const n = atoi(part.slice(slash + 1));
      if (n === null || n <= 0) {
        throw new Error("步长无效");
      }
      step = n;
    }
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      if (bounds.length === 1) {
        const n = atoi(bounds[0]);
        if (n === null) {
          throw new Error("不是数字");
        }
        start = n;
        end = n;
      } else if (bounds.length === 2) {
        const a = atoi(bounds[0]);
        const b = atoi(bounds[1]);
        if (a === null || b === null) {
          throw new Error("范围无效");
        }
        start = a;
        end = b;
      } else {
        throw new Error("范围无效");
      }
    }
    if (start < min || end > max || start > end) {
      throw new Error(`超出 ${min}-${max}`);
    }
    for (let n = start; n <= end; n += step) {
      bits |= 1n << BigInt(n);
    }
  }
  if (bits === 0n) {
    throw new Error("没有有效取值");
  }
  return bits;
}

/**
 * 计算 cron 表达式在指定时间 after 之后的下一次触发时间（最多向后搜索 366 天）。
 * 使用场景：定时任务调度器计算下次计划运行时刻时调用。
 * @param {string} expr - 5 段 cron 表达式。
 * @param {Date} after - 基准时间（搜索从该时间截断到分钟后的下一分钟开始）。
 * @returns {Date} 命中条件的下一次触发时间；表达式非法或一年内无匹配时间时抛出 Error。
 */
function Next(expr, after) {
  const sched = Parse(expr);
  // 对应 Go 的 after.In(Location).Truncate(time.Minute).Add(time.Minute)；上海与 UTC 的分钟边界一致，直接按毫秒截断。
  const cursor = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);
  const limit = new Date(cursor.getTime() + 366 * 24 * 3600 * 1000);
  for (let t = new Date(cursor.getTime()); t < limit; t = new Date(t.getTime() + 60000)) {
    if (sched.Matches(t)) {
      return t;
    }
  }
  throw new Error("cron 在一年内没有下次执行时间");
}

/**
 * 按 Go 标准库 strconv.Atoi 规则解析十进制整数字符串。
 * 使用场景：parseField 解析步长与起止边界数值时内部调用。
 * @param {string} s - 待解析字符串。
 * @returns {number | null} 合法整数返回对应数值，否则返回 null。
 */
function atoi(s) {
  if (!/^-?\d+$/.test(s)) {
    return null;
  }
  return Number.parseInt(s, 10);
}

module.exports = { Location, Schedule, Parse, Next };
