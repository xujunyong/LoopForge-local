/**
 * @file internal/repo/generic_docker.js
 * 对应 Go 源文件：internal/repo/generic_docker.go
 *
 * 作用与职责边界：
 * 定义平台内置的通用后端 Docker 容器沙箱镜像配方（Dockerfile 正文）、基线时间戳以及默认 `SandboxProfile` 构造函数。
 * 供通用交付 SOP、对话工作区默认回退以及沙箱目录缺失默认行时作为平台默认容器沙箱使用。
 *
 * 语法差异说明：
 * - Go 的 `time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)` 译为 `new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))`（JS 月份从 0 开始）。
 * - Go 的反引号原生字符串译为模板字符串，其中的反斜杠 `\` 与 `${` 均已转义以保持内容逐字节一致。
 */

"use strict";

const { SandboxProfile, SandboxDockerfile } = require("../domain/assets.js"); // 对应 Go 的 domain.SandboxProfile/SandboxDockerfile，domain 已翻译
const { GenericDockerSandboxID } = require("./generic_workflows.js"); // 对应 Go 同包常量，generic_workflows.js 已翻译

// 通用 Docker 沙箱的固定纪元时间戳（2026-01-01T00:00:00Z）。
const genericDockerEpoch = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));

// 平台默认的通用后端容器沙箱 Dockerfile 正文（内置 Node 22、主流 Agent CLI、gcc 与 Go 工具链）。
const genericBackendDockerfileContent = `FROM node:22-bookworm-slim

ARG CLAUDE_CODE_PACKAGE=@anthropic-ai/claude-code
ARG CODEX_PACKAGE=@openai/codex
ARG CODEBUDDY_PACKAGE=@tencent-ai/codebuddy-code

RUN apt-get update \\
    && apt-get install -y --no-install-recommends bash ca-certificates curl git jq openssh-client python3 ripgrep \\
    && rm -rf /var/lib/apt/lists/* \\
    && npm install -g "\${CLAUDE_CODE_PACKAGE}" "\${CODEX_PACKAGE}" \\
    && if [ -n "\${CODEBUDDY_PACKAGE}" ]; then npm install -g "\${CODEBUDDY_PACKAGE}"; fi

RUN apt-get update \\
    && apt-get install -y --no-install-recommends gcc libc6-dev \\
    && rm -rf /var/lib/apt/lists/* \\
    && gcc --version

ARG GO_VERSION=1.22.12
RUN set -eu; \\
    arch="$(dpkg --print-architecture)"; \\
    case "$arch" in \\
      amd64) goarch=amd64 ;; \\
      arm64) goarch=arm64 ;; \\
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \\
    esac; \\
    tmp="/tmp/go\${GO_VERSION}.linux-\${goarch}.tar.gz"; \\
    ok=0; \\
    for url in \\
      "https://mirrors.cloud.tencent.com/go/go\${GO_VERSION}.linux-\${goarch}.tar.gz" \\
      "https://dl.google.com/go/go\${GO_VERSION}.linux-\${goarch}.tar.gz" \\
      "https://go.dev/dl/go\${GO_VERSION}.linux-\${goarch}.tar.gz?download"; do \\
      echo "download $url"; \\
      if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$tmp" "$url" && gzip -t "$tmp"; then \\
        ok=1; \\
        break; \\
      fi; \\
      echo "not a gzip archive, try next: $url" >&2; \\
      rm -f "$tmp"; \\
    done; \\
    if [ "$ok" != 1 ]; then echo "failed to download Go \${GO_VERSION}" >&2; exit 1; fi; \\
    tar -C /usr/local -xzf "$tmp"; \\
    rm -f "$tmp"; \\
    ln -sfn /usr/local/go/bin/go /usr/local/bin/go; \\
    ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt; \\
    /usr/local/go/bin/go version

ENV PATH="/usr/local/go/bin:\${PATH}" \\
    GOROOT=/usr/local/go \\
    GOPATH=/go \\
    GOCACHE=/go/cache \\
    GOMODCACHE=/go/pkg/mod \\
    GOPROXY="https://goproxy.cn,direct" \\
    GOSUMDB=sum.golang.google.cn \\
    GO111MODULE=on \\
    GOTOOLCHAIN=auto \\
    CGO_ENABLED=1

RUN mkdir -p /workspace /go/pkg/mod /go/cache /go/bin

WORKDIR /workspace

CMD ["sh", "-lc", "trap : TERM INT; sleep infinity & wait"]
`;

/**
 * 构造平台共享的通用后端 Docker 沙箱配置档案。
 * 作为通用 SOP 的默认绑定沙箱，以及数据库中默认沙箱记录缺失时的内置回退配置。
 *
 * @returns {SandboxProfile} 内置通用后端 Docker 沙箱配置对象。
 */
function GenericDockerSandbox() {
  return new SandboxProfile({
    ID: GenericDockerSandboxID,
    Name: "通用后端容器沙箱",
    ProjectID: "platform",
    Shared: true,
    Driver: "docker",
    Dockerfile: new SandboxDockerfile({ Content: genericBackendDockerfileContent }),
  });
}

module.exports = { genericDockerEpoch, genericBackendDockerfileContent, GenericDockerSandbox };
