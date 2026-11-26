/**
 * 对应 Go 文件：internal/domain/issue_sop.go
 * 作用：定义需求 SOP 链步骤与项目 SOP 套餐数据结构，提供套餐/步骤归一化、默认套餐选择，
 *       以及工作项与项目上的 SOP 绑定链解析方法。
 * 职责边界：仅处理 SOP 链与套餐的内存归一化与查找逻辑，不执行调度或工作流运行。
 * 语法差异说明：
 * - Issue 与 Project 的跨文件方法分别挂载在 Issue.prototype 与 projectPkg.Project.prototype 上；
 * - Go 的 map[string]bool 译为普通对象 {}；
 * - Go 返回 (值, bool) 译为返回 [值, boolean] 元组；
 * - Go 空切片（nil slice）在 JS 中统一返回空数组 []，避免调用方读取 .length 或 for...of 时报错。
 */

"use strict";

// 同包引用：issue.js 的 Issue 与 project.js 的 Project，相关方法挂载在其原型上。
const { Issue } = require("./issue.js");
const projectPkg = require("./project.js");

/**
 * 需求 SOP 链中的单个步骤定义，描述工作流 ID、执行顺序、责任人、前置依赖与交接项。
 */
class IssueSOPBinding {
  /**
   * 构造 SOP 绑定步骤对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<IssueSOPBinding>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.Order = init.Order ?? 0;
    this.AssigneeUserID = init.AssigneeUserID ?? 0;
    this.DependsOn = init.DependsOn ?? [];
    this.Handoff = init.Handoff ?? [];
  }
}

/**
 * 获取工作项生效的 SOP 绑定链。
 * 若工作项已显式配置 SOPBindings（非 null），则返回归一化后的显式链；
 * 否则根据旧版单字段 WorkflowID 与 AssigneeUserID 合成单步链以兼容历史工单。
 *
 * @returns {IssueSOPBinding[]} 归一化或合成后的 SOP 步骤列表；无可用绑定时返回空数组。
 */
Issue.prototype.EffectiveSOPBindings = function () {
  if (this.SOPBindings != null) {
    return NormalizeSOPBindings(this.SOPBindings);
  }
  return bindingsFromWorkflow(this.WorkflowID, this.AssigneeUserID);
};

/**
 * 项目内可复用的命名 SOP 套餐组合，包含名称、是否默认及绑定的步骤链。
 */
class SOPPlaybook {
  /**
   * 构造 SOP 套餐对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<SOPPlaybook>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Default = init.Default ?? false;
    this.Bindings = init.Bindings ?? [];
  }
}

/**
 * 归一化项目的 SOP 套餐列表：去除首尾空白、补齐缺失 ID 与名称、按 ID 去重、
 * 归一化各套餐内的步骤链，并确保非空列表中恰好只有一个默认套餐。
 *
 * @param {SOPPlaybook[]} input - 原始 SOP 套餐列表。
 * @returns {SOPPlaybook[]} 清洗并归一化后的 SOP 套餐数组。
 */
function NormalizeSOPPlaybooks(input) {
  const seen = {};
  const out = [];
  input.forEach((rawBook, i) => {
    const book = new SOPPlaybook(rawBook);
    book.Name = book.Name.trim();
    book.ID = book.ID.trim();
    if (book.ID === "") {
      book.ID = "pb-" + book.Name.trim();
      if (book.ID === "pb-") {
        book.ID = `pb-${i + 1}`;
      }
    }
    if (Object.prototype.hasOwnProperty.call(seen, book.ID)) {
      return;
    }
    seen[book.ID] = true;
    if (book.Name === "") {
      book.Name = "未命名套餐";
    }
    book.Bindings = NormalizeSOPBindings(book.Bindings);
    out.push(book);
  });
  let hasDefault = false;
  for (const book of out) {
    if (book.Default) {
      hasDefault = true;
      break;
    }
  }
  if (!hasDefault && out.length > 0) {
    out[0].Default = true;
  }
  if (hasDefault) {
    let found = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i].Default && !found) {
        found = true;
        continue;
      }
      out[i].Default = false;
    }
  }
  return out;
}

/**
 * 获取项目的全部命名 SOP 套餐。
 * 当项目未配置 SOPPlaybooks 时，把旧版单个 SOPBindings 链（或单 WorkflowID）包装为一个“默认流程”套餐返回。
 *
 * @returns {SOPPlaybook[]} 归一化后的项目套餐列表；若项目未配置任何 SOP 则返回空数组。
 */
projectPkg.Project.prototype.Playbooks = function () {
  if (this.SOPPlaybooks.length > 0) {
    return NormalizeSOPPlaybooks(this.SOPPlaybooks);
  }
  let bindings = NormalizeSOPBindings(this.SOPBindings);
  if (bindings.length === 0) {
    bindings = bindingsFromWorkflow(this.WorkflowID, 0);
  }
  if (bindings.length === 0) {
    return [];
  }
  return [new SOPPlaybook({ ID: "default", Name: "默认流程", Default: true, Bindings: bindings })];
};

/**
 * 按套餐 ID 查找项目中的指定 SOP 套餐。
 *
 * @param {string} id - 待查找的套餐 ID。
 * @returns {[SOPPlaybook, boolean]} 找到时返回 [套餐对象, true]，未找到返回 [零值 SOPPlaybook, false]。
 */
projectPkg.Project.prototype.Playbook = function (id) {
  id = id.trim();
  for (const book of this.Playbooks()) {
    if (book.ID === id) {
      return [book, true];
    }
  }
  return [new SOPPlaybook(), false];
};

/**
 * 获取项目的默认 SOP 套餐；若无标记为 Default 的条目则回退到首个套餐。
 *
 * @returns {[SOPPlaybook, boolean]} 存在套餐时返回 [默认套餐对象, true]，无任何套餐时返回 [零值 SOPPlaybook, false]。
 */
projectPkg.Project.prototype.DefaultPlaybook = function () {
  const books = this.Playbooks();
  for (const book of books) {
    if (book.Default) {
      return [book, true];
    }
  }
  if (books.length > 0) {
    return [books[0], true];
  }
  return [new SOPPlaybook(), false];
};

/**
 * 获取项目默认 SOP 套餐对应的步骤绑定链副本。
 *
 * @returns {IssueSOPBinding[]} 默认套餐的步骤数组副本；项目无默认套餐时返回空数组。
 */
projectPkg.Project.prototype.EffectiveSOPBindings = function () {
  const [book, ok] = this.DefaultPlaybook();
  if (ok) {
    return [...book.Bindings];
  }
  return [];
};

/**
 * 解析工作项最终生效的 SOP 绑定链。
 * 若工作项显式设置了 SOPBindings（非 null）则归一化后返回，否则回退到 issue.EffectiveSOPBindings()。
 *
 * @param {Issue} issue - 目标工作项对象。
 * @param {import("./project.js").Project} project - 所属项目对象（保留与 Go 函数签名一致）。
 * @returns {IssueSOPBinding[]} 解析后的 SOP 绑定步骤数组。
 */
function ResolveSOPBindings(issue, project) {
  if (issue.SOPBindings != null) {
    return NormalizeSOPBindings(issue.SOPBindings);
  }
  return issue.EffectiveSOPBindings();
}

/**
 * 在工作项显式配置的 SOPBindings 链中查找指定工作流对应的步骤。
 *
 * @param {string} workflowID - 目标工作流 ID。
 * @returns {[IssueSOPBinding, boolean]} 找到返回 [步骤对象, true]，未找到返回 [零值 IssueSOPBinding, false]。
 */
Issue.prototype.SOPBindingForWorkflow = function (workflowID) {
  return bindingForWorkflow(NormalizeSOPBindings(this.SOPBindings ?? []), workflowID);
};

/**
 * 在解析后的（含继承/兜底合成）SOP 绑定链中查找指定工作流对应的步骤。
 *
 * @param {Issue} issue - 目标工作项对象。
 * @param {import("./project.js").Project} project - 所属项目对象。
 * @param {string} workflowID - 目标工作流 ID。
 * @returns {[IssueSOPBinding, boolean]} 找到返回 [步骤对象, true]，未找到返回 [零值 IssueSOPBinding, false]。
 */
function ResolveSOPBinding(issue, project, workflowID) {
  return bindingForWorkflow(ResolveSOPBindings(issue, project), workflowID);
}

/**
 * 在给定步骤列表中按工作流 ID 查找匹配的首个 SOP 步骤。
 * 供 SOPBindingForWorkflow 与 ResolveSOPBinding 内部复用。
 *
 * @param {IssueSOPBinding[]} bindings - 候选 SOP 步骤列表。
 * @param {string} workflowID - 目标工作流 ID。
 * @returns {[IssueSOPBinding, boolean]} 命中返回 [步骤对象, true]，workflowID 为空或未命中返回 [零值 IssueSOPBinding, false]。
 */
function bindingForWorkflow(bindings, workflowID) {
  workflowID = workflowID.trim();
  if (workflowID === "") {
    return [new IssueSOPBinding(), false];
  }
  for (const binding of bindings) {
    if (binding.WorkflowID === workflowID) {
      return [binding, true];
    }
  }
  return [new IssueSOPBinding(), false];
}

/**
 * 根据单个工作流 ID 和责任人合成一条兼容旧版数据的单步 SOP 链。
 * 供工作项或项目未配置显式多步链时兜底调用。
 *
 * @param {string} workflowID - 单个工作流 ID。
 * @param {number} assigneeUserID - 步骤责任人用户 ID。
 * @returns {IssueSOPBinding[]} 含单条默认步骤的数组；workflowID 为空时返回空数组。
 */
function bindingsFromWorkflow(workflowID, assigneeUserID) {
  const wf = workflowID.trim();
  if (wf === "") {
    return [];
  }
  return [new IssueSOPBinding({
    ID: "sop-default",
    WorkflowID: wf,
    Order: 1,
    AssigneeUserID: assigneeUserID,
  })];
}

/**
 * 归一化 SOP 步骤链：过滤空工作流并按 WorkflowID 去重、补齐默认步骤 ID、
 * 清洗 Handoff 与 DependsOn、按 Order 稳定排序并重编号为 1..N、剔除指向自身或不存在步骤的无效依赖。
 *
 * @param {IssueSOPBinding[]} input - 原始 SOP 步骤列表。
 * @returns {IssueSOPBinding[]} 清洗、排序并修正依赖后的 SOP 步骤数组。
 */
function NormalizeSOPBindings(input) {
  const seen = {};
  const items = [];
  input.forEach((rawBinding, i) => {
    const binding = new IssueSOPBinding(rawBinding);
    const wf = binding.WorkflowID.trim();
    if (wf === "" || Object.prototype.hasOwnProperty.call(seen, wf)) {
      return;
    }
    seen[wf] = true;
    binding.WorkflowID = wf;
    binding.ID = binding.ID.trim();
    if (binding.ID === "") {
      binding.ID = "sop-" + wf;
    }
    binding.Handoff = compactStrings(binding.Handoff);
    binding.DependsOn = compactStrings(binding.DependsOn);
    if (binding.Order <= 0) {
      binding.Order = (i + 1) * 10;
    }
    items.push({ binding, index: i });
  });
  items.sort((a, b) => {
    if (a.binding.Order === b.binding.Order) {
      return a.index - b.index;
    }
    return a.binding.Order - b.binding.Order;
  });
  const ids = {};
  const out = [];
  items.forEach((item, i) => {
    const binding = item.binding;
    binding.Order = i + 1;
    ids[binding.ID] = true;
    out.push(binding);
  });
  out.forEach((binding, i) => {
    const deps = [];
    for (const id of binding.DependsOn ?? []) {
      if (Object.prototype.hasOwnProperty.call(ids, id) && id !== binding.ID) {
        deps.push(id);
      }
    }
    out[i].DependsOn = deps;
  });
  return out;
}

/**
 * 去除字符串列表各项的首尾空白，过滤空串并按首次出现顺序去重。
 * 供 NormalizeSOPBindings 清洗 Handoff 与 DependsOn 列表。
 *
 * @param {string[]|null|undefined} input - 原始字符串数组。
 * @returns {string[]} 清洗并去重后的字符串数组；无有效项时返回空数组。
 */
function compactStrings(input) {
  const seen = {};
  const out = [];
  for (const raw of input ?? []) {
    const value = raw.trim();
    if (value === "" || Object.prototype.hasOwnProperty.call(seen, value)) {
      continue;
    }
    seen[value] = true;
    out.push(value);
  }
  if (out.length === 0) {
    return [];
  }
  return out;
}

module.exports = {
  IssueSOPBinding,
  SOPPlaybook,
  NormalizeSOPPlaybooks,
  ResolveSOPBindings,
  ResolveSOPBinding,
  NormalizeSOPBindings,
};
