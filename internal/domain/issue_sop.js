// issue_sop.js —— 对应 Go 文件：internal/domain/issue_sop.go
// 作用：需求 SOP 链的绑定、套餐归一化与解析。

"use strict";

// 同包引用：issue.go 的 Issue 与 project.go 的 Project，相关方法挂在其原型上，待翻译后提供。
const { Issue } = require("./issue.js");
const projectPkg = require("./project.js");

// IssueSOPBinding：需求 SOP 链中的一步。
class IssueSOPBinding {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.Order = init.Order ?? 0;
    this.AssigneeUserID = init.AssigneeUserID ?? 0;
    this.DependsOn = init.DependsOn ?? [];
    this.Handoff = init.Handoff ?? [];
  }
}

// EffectiveSOPBindings：显式链，或从 WorkflowID 合成单步以兼容老工单。
Issue.prototype.EffectiveSOPBindings = function () {
  if (this.SOPBindings != null) {
    return NormalizeSOPBindings(this.SOPBindings);
  }
  return bindingsFromWorkflow(this.WorkflowID, this.AssigneeUserID);
};

// SOPPlaybook：项目内可复用的命名 SOP 组合。
class SOPPlaybook {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Default = init.Default ?? false;
    this.Bindings = init.Bindings ?? [];
  }
}

function NormalizeSOPPlaybooks(input) {
  const seen = new Set();
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
    if (seen.has(book.ID)) {
      return;
    }
    seen.add(book.ID);
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

// Playbooks：命名套餐，空时把旧的单 SOP 链包成一个默认套餐。
projectPkg.Project.prototype.Playbooks = function () {
  if (this.SOPPlaybooks.length > 0) {
    return NormalizeSOPPlaybooks(this.SOPPlaybooks);
  }
  let bindings = NormalizeSOPBindings(this.SOPBindings);
  if (bindings.length === 0) {
    bindings = bindingsFromWorkflow(this.WorkflowID, 0);
  }
  if (bindings.length === 0) {
    return null;
  }
  return [new SOPPlaybook({ ID: "default", Name: "默认流程", Default: true, Bindings: bindings })];
};

projectPkg.Project.prototype.Playbook = function (id) {
  id = id.trim();
  for (const book of this.Playbooks()) {
    if (book.ID === id) {
      return [book, true];
    }
  }
  return [new SOPPlaybook(), false];
};

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

projectPkg.Project.prototype.EffectiveSOPBindings = function () {
  const [book, ok] = this.DefaultPlaybook();
  if (ok) {
    return [...book.Bindings];
  }
  return null;
};

function ResolveSOPBindings(issue, project) {
  if (issue.SOPBindings != null) {
    return NormalizeSOPBindings(issue.SOPBindings);
  }
  return issue.EffectiveSOPBindings();
}

// SOPBindingForWorkflow：取显式链中某工作流的一步。
Issue.prototype.SOPBindingForWorkflow = function (workflowID) {
  return bindingForWorkflow(NormalizeSOPBindings(this.SOPBindings ?? []), workflowID);
};

// ResolveSOPBinding：在解析后（继承）的链上查找一步。
function ResolveSOPBinding(issue, project, workflowID) {
  return bindingForWorkflow(ResolveSOPBindings(issue, project), workflowID);
}

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

function bindingsFromWorkflow(workflowID, assigneeUserID) {
  const wf = workflowID.trim();
  if (wf === "") {
    return null;
  }
  return [new IssueSOPBinding({
    ID: "sop-default",
    WorkflowID: wf,
    Order: 1,
    AssigneeUserID: assigneeUserID,
  })];
}

function NormalizeSOPBindings(input) {
  const seen = new Set();
  const items = [];
  input.forEach((rawBinding, i) => {
    const binding = new IssueSOPBinding(rawBinding);
    const wf = binding.WorkflowID.trim();
    if (wf === "" || seen.has(wf)) {
      return;
    }
    seen.add(wf);
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
  const ids = new Set();
  const out = [];
  items.forEach((item, i) => {
    const binding = item.binding;
    binding.Order = i + 1;
    ids.add(binding.ID);
    out.push(binding);
  });
  out.forEach((binding, i) => {
    const deps = [];
    for (const id of binding.DependsOn ?? []) {
      if (ids.has(id) && id !== binding.ID) {
        deps.push(id);
      }
    }
    out[i].DependsOn = deps;
  });
  return out;
}

function compactStrings(input) {
  const seen = new Set();
  const out = [];
  for (const raw of input ?? []) {
    const value = raw.trim();
    if (value === "" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  if (out.length === 0) {
    return null;
  }
  return out;
}

module.exports = { IssueSOPBinding, SOPPlaybook, NormalizeSOPPlaybooks, ResolveSOPBindings, ResolveSOPBinding, NormalizeSOPBindings };
