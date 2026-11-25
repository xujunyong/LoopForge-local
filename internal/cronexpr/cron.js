// cron.js —— 对应 Go 文件：internal/cronexpr/cron.go
// 作用：解析 5 段 cron 表达式，判断时间是否匹配、算下次执行时间。
// Go 的 uint64 位掩码译为 JS Number（2**n，避免 32 位有符号溢出）；
// time.Location（Asia/Shanghai，无夏令时）译为 UTC+8 小时的偏移换算。

"use strict";

// Location：Go 的 *time.Location，这里只保留时区名，供下面换算用。
const Location = "Asia/Shanghai";

// shanghaiParts：取 date 在 Asia/Shanghai 的分、时、日、月、周几。
// 上海固定 UTC+8、无夏令时，直接加 8 小时后按 UTC 取值。
function shanghaiParts(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), day: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay() };
}

class Schedule {
  constructor(init = {}) {
    this.min = init.min ?? 0;
    this.hour = init.hour ?? 0;
    this.day = init.day ?? 0;
    this.month = init.month ?? 0;
    this.dow = init.dow ?? 0;
    this.dayStar = init.dayStar ?? false;
    this.dowStar = init.dowStar ?? false;
  }

  // Matches：时间 t 是否命中本计划。
  Matches(t) {
    const p = shanghaiParts(t);
    if ((this.min & 2 ** p.minute) === 0) {
      return false;
    }
    if ((this.hour & 2 ** p.hour) === 0) {
      return false;
    }
    if ((this.month & 2 ** p.month) === 0) {
      return false;
    }
    const dayOK = (this.day & 2 ** p.day) !== 0;
    const dowOK = (this.dow & 2 ** p.dow) !== 0;
    if (this.dayStar || this.dowStar) {
      return dayOK && dowOK;
    }
    return dayOK || dowOK;
  }
}

// fieldSpecs：5 个 cron 字段的顺序、显示名（用于错误前缀）与取值范围。
const fieldSpecs = [
  { name: "分钟", min: 0, max: 59 },
  { name: "小时", min: 0, max: 23 },
  { name: "日", min: 1, max: 31 },
  { name: "月", min: 1, max: 12 },
  { name: "周", min: 0, max: 7 },
];

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
      throw new Error(`${spec.name}: ${e.message}`);
    }
  }
  let dow = bits[4];
  if ((dow & 2 ** 7) !== 0) {
    dow |= 2 ** 0;
  }
  return new Schedule({
    min: bits[0], hour: bits[1], day: bits[2], month: bits[3], dow,
    dayStar: fields[2].startsWith("*"),
    dowStar: fields[4].startsWith("*"),
  });
}

function parseField(raw, min, max) {
  raw = raw.trim();
  if (raw === "") {
    throw new Error("为空");
  }
  let bits = 0;
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
      bits |= 2 ** n;
    }
  }
  if (bits === 0) {
    throw new Error("没有有效取值");
  }
  return bits;
}

function Next(expr, after) {
  const sched = Parse(expr);
  // Go 的 Truncate 到分钟后加一分钟；上海与 UTC 的分钟边界一致，直接按毫秒截断。
  const cursor = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);
  const limit = new Date(cursor.getTime() + 366 * 24 * 3600 * 1000);
  for (let t = new Date(cursor.getTime()); t < limit; t = new Date(t.getTime() + 60000)) {
    if (sched.Matches(t)) {
      return t;
    }
  }
  throw new Error("cron 在一年内没有下次执行时间");
}

// atoi：对应 Go strconv.Atoi，整数字符串才通过，否则返回 null。
function atoi(s) {
  if (!/^-?\d+$/.test(s)) {
    return null;
  }
  return Number.parseInt(s, 10);
}

module.exports = { Location, Schedule, Parse, Next };
