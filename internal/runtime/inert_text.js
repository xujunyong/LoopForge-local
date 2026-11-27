// inert_text.js —— 对应 Go 文件：internal/runtime/inert_text.go
//
// 文件作用与职责边界：
// 对喂给 CodeBuddy CLI 渲染的技能文本进行去活化处理：通过插入零宽空格解除 `` !`cmd` `` 命令执行
// 与代码块外 `@path` 文件/目录内联触发，避免控制面会话 CLI 绕过禁用 Bash 的约束访问宿主机。
//
// Go 与 JS 语法差异说明：
// - Go 的 `[]rune(text)` 译为 `Array.from(text)` 以按 Unicode 码点索引；
// - Go 的 `unicode.IsSpace(r)` 译为正则 `/^\s$/` 匹配。

"use strict";

// cliBreak 为零宽空格（U+200B），用于阻断 CodeBuddy CLI 对后续语法的解析执行，
// 同时对模型阅读语义保持无感。
const cliBreak = "\u200b";

/**
 * 对将由 CodeBuddy CLI 渲染的技能文本进行去活化处理：
 * - 在所有 `` !` `` 之间插入零宽空格，禁用任何位置（含代码块内）的 shell 命令执行；
 * - 在围栏代码块（```` ``` ````）和行内代码（`` ` ``）之外，在位于文本开头或空白字符之后的 `@<非空白非@>` 前插入零宽空格，
 *   禁用文件/目录路径内联，同时保留代码块内如 `@types/node` 的示例原样不变。
 *
 * @param {string} text 原始技能文本内容。
 * @returns {string} 插入零宽空格完成去活化后的文本内容。
 */
function InertCLIText(text) {
  text = text.replaceAll("!`", "!" + cliBreak + "`");
  let b = "";
  const runes = Array.from(text);
  let fences = 0;
  let ticks = 0;
  for (let i = 0; i < runes.length; i++) {
    const r = runes[i];
    if (
      r === "@" &&
      (i === 0 || /^\s$/.test(runes[i - 1])) &&
      i + 1 < runes.length &&
      !/^\s$/.test(runes[i + 1]) &&
      runes[i + 1] !== "@" &&
      fences % 2 === 0 &&
      ticks % 2 === 0
    ) {
      b += cliBreak;
    }
    b += r;
    if (r === "`") {
      if (i + 2 < runes.length && runes[i + 1] === "`" && runes[i + 2] === "`" && (i === 0 || runes[i - 1] !== "`")) {
        fences++;
      }
      if ((i === 0 || runes[i - 1] !== "`") && (i + 1 >= runes.length || runes[i + 1] !== "`")) {
        ticks++;
      }
    }
  }
  return b;
}

module.exports = {
  cliBreak,
  InertCLIText,
};
