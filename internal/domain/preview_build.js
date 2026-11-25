// preview_build.js —— 对应 Go 文件：internal/domain/preview_build.go
// 作用：预览构建节点的注入、提示词与产物。

"use strict";

// StripPreviewBuild：去掉合成预览节点，SOP 目录永不持久化引擎注入的步骤。
function StripPreviewBuild(wf) {
  const nodes = [];
  for (const node of wf.Nodes) {
    if (IsPreviewBuildNode(node.ID)) {
      continue;
    }
    nodes.push(node);
  }
  const edges = [];
  for (const edge of wf.Edges) {
    if (IsPreviewBuildNode(edge.Source) || IsPreviewBuildNode(edge.Target)) {
      continue;
    }
    edges.push(edge);
  }
  return { ...wf, Nodes: nodes, Edges: edges };
}

// AttachPreviewBuild：合约启用时保证预览构建节点存在；用户自放的节点保留自己的位置与边（画布允许把构建插到流程任意处），仅在节点缺失时追加到每个当前成功汇点之后。
function AttachPreviewBuild(wf) {
  wf = { ...wf };
  if (wf.Preview != null) {
    wf.Preview = new PreviewContract(wf.Preview);
  }
  if (wf.Preview != null) {
    wf.Preview.Validate();
  }
  if (wf.Preview == null || !wf.Preview.Static()) {
    return StripPreviewBuild(wf);
  }
  for (let i = 0; i < wf.Nodes.length; i++) {
    const node = wf.Nodes[i];
    if (IsPreviewBuildNode(node.ID)) {
      // 旧版画布把原始合成执行机持久化在了节点上；执行机的选择权归预览合约。
      if (node.ExecutorID !== wf.Preview.SelectedExecutorID()) {
        const nodes = [...wf.Nodes];
        nodes[i] = { ...node, ExecutorID: wf.Preview.SelectedExecutorID() };
        wf.Nodes = nodes;
      }
      return wf;
    }
  }
  const node = PreviewBuildNode(wf);
  const sinks = previewSuccessSinks(wf);
  wf.Nodes = [...wf.Nodes, node];
  for (let i = 0; i < sinks.length; i++) {
    wf.Edges = [...wf.Edges, { ID: `${PreviewBuildEdgeID}-${i + 1}`, Source: sinks[i], Target: node.ID, When: "success" }];
  }
  return wf;
}

function PreviewBuildNode(wf) {
  const contract = wf.Preview;
  const [x, y] = previewBuildPosition(wf.Nodes);
  return {
    ID: PreviewBuildNodeID,
    Name: "构建静态站点",
    Type: "agent",
    AgentID: PreviewBuildAgentID,
    ExecutorID: contract.SelectedExecutorID(),
    ExecutionScope: ExecutionScopeRun,
    ArtifactOutputs: [PreviewBuildArtifact(contract)],
    OnFailure: "fail",
    RetryStrategy: "targeted_fix",
    CarryOver: ["last_error"],
    MaxAttempts: 2,
    MaxReworks: 1,
    Position: { X: x, Y: y },
  };
}

function PreviewBuildAgent(contract) {
  const executorID = contract.SelectedExecutorID();
  let model = "";
  if (executorID !== "") {
    model = contract.ModelOrDefault();
  }
  return {
    ID: PreviewBuildAgentID,
    Name: "构建静态站点",
    Description: "系统步骤：构建可托管的静态站点并归档为预览。",
    ExecutorID: executorID,
    Model: model,
    Prompt: PreviewBuildPrompt(contract),
    ArtifactOutputs: [PreviewBuildArtifact(contract)],
    Loop: { Enabled: true, MaxIterations: 2, ExitCondition: "all_gates_pass", OnExhausted: "fail" },
  };
}

function PreviewBuildArtifact(contract) {
  return {
    Name: "frontend-preview",
    Path: contract.EntryRel(),
    Required: true,
  };
}

function PreviewBuildPrompt(contract) {
  const source = contract.SourceOrDist();
  const index = contract.Index();
  const entry = contract.EntryRel();
  return "把当前工作区里的前端应用打成可独立托管的静态站点，不要让用户再手写构建脚本。\n\n" +
    "这是 AgentFlow 在 SOP 勾选「前端预览」后自动追加的构建步骤。工作区可能包含一个或多个代码仓库子目录，上游节点已经完成实现与测试。构建完成后平台会打包静态目录并删除工作区。\n\n" +
    "### 步骤\n\n" +
    "1. 识别前端工程（package.json、vite、webpack、rspack、next 静态导出等）。\n" +
    "2. 若工作区没有前端工程（无 Vite/webpack/Next 等配置、无前端依赖的 package.json、无 index.html），不要另起项目或手写预览页，不要创建 `" + source + "/" + index + "`，直接说明原因并结束。\n" +
    "3. 安装依赖并执行生产构建，不要启动开发服务器。\n" +
    "4. 生产构建必须使用相对资源根：Vite 设 `base: './'`，webpack/rspack 设 `publicPath: 'auto'` 或 `'./'`，禁止 `base: '/'` 或把资源写死成网站根路径。\n" +
    "5. 不要依赖开发服务器；预览打开时用户可配置后端地址，网关会拦截 fetch/XHR 转到该地址，不要为了预览另写一套绝对 API。\n" +
    "6. 把最终可浏览的静态文件放到工作区根目录 `" + source + "/`，入口文件必须是 `" + index + "`；若产物落在仓库子目录内，复制或同步到工作区根的 `" + source + "/`。\n" +
    "7. 不要修改 git remote，不要提交无关文件；构建失败时根据日志只修复失败项后重试。\n\n" +
    "### 完成标准\n\n" +
    "- 静态站点入口 `" + entry + "` 必须存在、可被直接打开，且同目录包含页面引用的 JS/CSS/资源。\n" +
    "- 入口和 chunk 的资源地址必须是相对路径（`./assets/...`），不能依赖网站根 `/assets/`。\n" +
    "- 不要留下需要 `npm run dev` 才能访问的开发服务器。\n\n" +
    "### 禁止\n\n" +
    "- 只使用现有仓库，不要另起无关项目。\n" +
    "- 禁止在非前端仓库里编造静态站点来满足产物契约。\n" +
    "- 不要把源码、node_modules 或 .git 拷进 " + source + "。\n";
}

function previewSuccessSinks(wf) {
  const outgoing = {};
  for (const edge of wf.Edges) {
    if (edge.When.trim() !== "" && edge.When.toLowerCase() !== "success") {
      continue;
    }
    outgoing[edge.Source] = true;
  }
  const sinks = [];
  for (const node of wf.Nodes) {
    if (outgoing[node.ID]) {
      continue;
    }
    sinks.push(node.ID);
  }
  return sinks;
}

function previewBuildPosition(nodes) {
  if (nodes.length === 0) {
    return [110, 120];
  }
  let maxX = nodes[0].Position.X;
  let maxY = nodes[0].Position.Y;
  for (const node of nodes.slice(1)) {
    if (node.Position.X > maxX) {
      maxX = node.Position.X;
    }
    if (node.Position.Y > maxY) {
      maxY = node.Position.Y;
    }
  }
  return [maxX + 280, maxY];
}

module.exports = { StripPreviewBuild, AttachPreviewBuild, PreviewBuildNode, PreviewBuildAgent, PreviewBuildArtifact, PreviewBuildPrompt };
