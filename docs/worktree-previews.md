# Worktree 功能测试预览（本地 k3s）

在 **Work Progress** 的卡片和表格中，每个 worktree 都有独立的「部署预览」、
「重新部署」、「停止预览」和「打开预览」。构建使用该 worktree 当前的磁盘内容，
包括未提交的改动；改动后需要重新部署。
预览控件的「Preview config」可直接编辑项目级 `.automaker/preview.json`；
保存时服务端校验配置并检测是否被其他人改动，保存后重新部署才会生效。
Agent 任务执行完成并进入 Waiting Review 时，若该 worktree 已配置预览则自动部署；
执行失败或没有匹配的 worktree / 预览配置不会触发。卡片显示最近开发完成时间，
进度栏显示最近一次部署开始时间；部署失败可在 Deployment logs 查看原因并手动重试。
每个 worktree 的任务看板顶部也提供「功能预览」栏，显示当前分支的预览操作；
隐藏 worktree 选择栏后仍可使用，切换 worktree 时预览链接同步切换。

参考 [vibe-skills 的 go-devbridge](http://gitblue.transwarp.io/llm/llmops/product/vibe-skills/-/tree/72c36a9/skills/go-devbridge) 环境隔离和就绪验证原则，这里为每个
worktree 创建独立的 Deployment、Service，以及可选的 Ingress。
可通过下方 `devbridge` 配置启用每个 worktree 独立的 Go 后端会话，
使用 mirrord 按请求标识路由，不改写共享 Deployment 或网关。
启用后「打开预览」及验收材料使用 Automaker 主机上的独立组合入口：
页面转发到该 worktree 的前端 Deployment，选定 API 转发到该 worktree 的后端。
未启用时仍使用独立 NodePort/Ingress 链接，仅前端独立不代表后端也已隔离。

## 接入 devbridge 后端

从固定的 vibe-skills 提交 `72c36a9` 安装统一工具（0.4.1），
让 Automaker 服务端可以执行这个**编译后的二进制**：

```sh
sh /path/to/vibe-skills/skills/go-devbridge/scripts/install.sh /usr/local/bin/go-devbridge
/usr/local/bin/go-devbridge version
```

Deployment logs 展示 devbridge 0.3.1 起提供的逐步进度。升级时需重新编译上面的
可执行文件；旧版本不支持 `-progress-file`。日志按服务记录本地工具检查、
SSH / Kubernetes 权限检查、镜像准备、构建、文件上传、代理启动、路由校验、
后端健康检查及清理。每步包含时间与开始/成功/失败状态。
结构化记录保存在 `.automaker/previews/<wt-id>.devbridge/progress.jsonl`，
页面自动轮询，重新打开页面仍可查看；新部署会清空上次记录。
前端构建与 Kubernetes 命令的日志按步骤折叠，展开可查看执行命令、退出码及截断、脱敏的
stdout/stderr（每步最多 4 KiB）；Kubernetes JSON 和标准输入不展示，以免暴露环境
变量或资源详情。若构建脚本内部调用了多个工具，展示的是外层构建命令；内部命令只有
脚本自身输出时才可见。devbridge 工具的内部步骤继续只展示其结构化安全进度，
不展示包含 Pod 环境或远端凭据的 SSH 命令和原始输出。页面默认只显示每一步一行，
失败步骤自动展开。

devbridge 0.3.2 起，Deployment logs 还显示本次启动的配置快照：配置文件、源码根目录、
namespace、脱敏网关地址、代理监听、前缀移除和恢复策略；各组件显示源码目录、
目标工作负载、端口、路由、健康路径、构建工具及环境变量名称（不显示值或命令参数）。
快照保存在同目录 `config-summary.json`，在 doctor / up 前写入，失败后仍可查看，
新部署重置快照。旧部署没有快照时不以当前配置冒充历史配置。

组件改动统计包括其目录内的已提交分支差异、暂存、未暂存和未跟踪文件。
优先比较 origin/HEAD，其次尝试 origin/dev、origin/main、origin/master 和本地
dev / main / master，页面显示实际基线；Git 不可读或没有基线且工作区干净时显示
“Change scope unknown”。该统计不归因目录外的共享依赖，也不改变部署范围：
所有配置的组件仍参与部署。按组件筛选仅影响日志展示。

长期使用时将二进制放在持久目录。复制
[`devbridge.example.yaml`](http://gitblue.transwarp.io/llm/llmops/product/vibe-skills/-/blob/72c36a9/skills/go-devbridge/assets/devbridge.example.yaml)
到组件目录的 `.devbridge.yaml`，填写 SSH 开发主机、非生产 namespace、
单副本目标 Deployment、网关、API 路径、构建命令和 API-only 环境变量。
配置和源码都从任务 Worktree 读取，不再从主项目默认 checkout 读取组件配置。
升级到 devbridge 0.4.0 后，旧的主项目配置需要移入对应 Worktree；缺失时明确失败，
不会回退到共享后端或主项目配置。
不要在配置文件中写 Secret 值。

在下文 `.automaker/preview.json` 中加入：

```json
{
  "devbridge": {
    "command": ["/usr/local/bin/go-devbridge"],
    "configFile": ".devbridge.yaml",
    "sourcePath": "backend",
    "bindHost": "0.0.0.0",
    "host": "172.16.251.159"
  }
}
```

`sourcePath` 为每个 worktree 内的 Go 项目目录；Go 项目就在根目录时填 `"."`。
`host` 必须是浏览器和 Automaker 都可访问的 **Automaker 主机**地址。
程序为每个 worktree 自动分配不同的回环代理端口和组合入口端口。
入口运行在 Automaker 的网络环境；容器部署需使用可访问这些动态端口的网络配置
（例如开发机的 host networking）。入口只用于受控开发网络，TLS 和登录仍由入口设施管理。

### 一次预览多个服务

推荐每个后端组件维护自己的 `.devbridge.yaml`，任务 Worktree 根目录仅维护清单：

```yaml
version: 1
components:
  - backend/sophon-mind/.devbridge.yaml
  - backend/cvat-backend/.devbridge.yaml
```

清单的路径相对所在目录，单个文件必须只描述一个服务；组件的源码目录相对组件配置
目录解析。工具拒绝缺失配置、越界路径/符号链接、重复名称和重复路由。集群、
namespace、网关和 mirrord 版本必须兼容，环境继承、只读挂载和恢复策略按组件保留，
不会将一个组件的权限规则合并给另一个组件。

在这个任务 Worktree 的 `.automaker/preview.json` 中仅覆盖 `devbridge`，设置
`configFile: ".devbridge.yaml"`、`sourcePath: "."`。其他前端构建默认值仍从主项目
`.automaker/preview.json` 继承；该覆盖不影响其他任务。所有配置组件的健康及路由身份
都通过后才显示 Ready。配置检查可先运行 `devbridge validate -f <worktree>/.devbridge.yaml`；
`doctor` 另行检查真实 SSH/集群条件。API-only 模式下跳过的播种/后台任务不能以预览
就绪代替验收。

部署前还执行 `devbridge preflight`，要求**每个**共享后端拒绝错误的
`X-Devbridge-Required-Route`，且带回匹配的拒绝标识。任意组件未通过时停止，
不启动桥接、不重建或替换既有预览。现有前端独立预览在任务配置要求桥接后会显示
`unavailable`，直到双后端均通过预检并重新部署；不应以之前的前端 Ready
代替整项验收。项目级 `.automaker/preview.json` 的前端部署参数仍作为默认值，
Worktree 内 `.automaker/preview.json` 可以只覆盖 `devbridge`。
若项目需要所有任务预览使用同一后端环境，可在项目级 `.automaker/preview.json`
设置 `env` 地址，并用 `lockedEnv` 列出不可被 Worktree 覆盖的变量名，
例如 `["AUTOCV_GATEWAY_URL", "AUTOCV_GATEWAY_URL_WITHOUT_LUA", "SAAS_DOCS_URL"]`。
任务覆盖了锁定变量且值不同时，部署会在构建前失败并提示配置错误；
项目级配置只保存在当前机器时，迁移项目应同时迁移该文件。

也兼容单文件的 `apps` 形式：

一个任务经常同时改多个微服务。把 `.devbridge.yaml` 的 `app` 换成 `apps`
列表即可在同一个会话里桥多个服务，每个服务有自己的源码目录、目标
Deployment、路由前缀、就绪路径和进程；组合入口按最长前缀把请求分给对应服务，
某个服务掉线只影响它自己的前缀。

```yaml
version: 1
project:
  name: vibe-llmops
remote:
  ssh: dev17
  namespace: llmops
  non_production: true
gateway:
  upstream: http://172.17.124.17:31922
  strip_prefix: /gateway
  route_header: X-Dev-Route
apps:
  - name: cvat-backend
    dir: backend/cvat-backend
    target: deployment/autocv-cvat/container/backend
    route_paths:
      - /cv/api/knowlhub/
    health_path: /cv/api/devbridge/status
    build: [go, build, -o, '{{output}}', .]
    env:
      CVAT_DEVBRIDGE_API_ONLY: 'true'
  - name: sophon-mind
    dir: backend/sophon-mind
    target: deployment/sophon-mind/container/backend
    route_paths:
      - /asset-query/api/
    health_path: /asset-query/api/devbridge/status
    build: [go, build, -o, '{{output}}', .]
    env:
      SOPHON_MIND_DEVBRIDGE_API_ONLY: 'true'
```

使用 `apps` 时 `devbridge.sourcePath` 留空，`dir` 相对 worktree 根目录填写；
每个服务仍要各自满足下面的 API-only 与路由保护条件。`route_paths` 不能交叉，
配置里重复的前缀会被拒绝。

前端必须使用同源 API 地址，例如 `/gateway/my-service/api/items`，不能写死共享后端域名。
`.devbridge.yaml` 的 `gateway.strip_prefix` 可设为 `/gateway`，
`route_paths` 列出需要拦截的服务路径（例如 `/my-service/`）。
组合入口将这些请求直接转给会话后端，其余页面转给原前端 Service；
`/gateway` 内未配置的服务返回 404，避免经过前端代理落到共享服务。
原前端 NodePort/Ingress 是内部上游，验收时使用界面给出的组合入口。

### 后端必须满足的条件

按 [API-only 检查表](http://gitblue.transwarp.io/llm/llmops/product/vibe-skills/-/blob/72c36a9/skills/go-devbridge/references/safe-mode-checklist.md)
审计启动链，关闭迁移、种子写入、消费者、定时任务等副作用。
健康接口及所有 API 响应（包括错误响应和 WebSocket 握手）
必须携带 `X-Devbridge-Route: <DEVBRIDGE_ROUTE_ID>`。

为避免「健康检查刚成功、会话随即断开」时写请求落入共享服务，
**共享后端和预览后端都要安装以下路由保护中间件**，放在业务处理器之前：

```go
func devbridgeRouteGuard(next http.Handler) http.Handler {
    routeID := os.Getenv("DEVBRIDGE_ROUTE_ID")
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        required := r.Header.Get("X-Devbridge-Required-Route")
        if required != "" && required != routeID {
            w.Header().Set("X-Devbridge-Rejected-Route", required)
            http.Error(w, "devbridge route unavailable", http.StatusConflict)
            return
        }
        if routeID != "" {
            w.Header().Set("X-Devbridge-Route", routeID)
        }
        next.ServeHTTP(w, r)
    })
}
```

共享服务的 `DEVBRIDGE_ROUTE_ID` 留空，普通请求无需任何 devbridge header。
网关必须保留这两个请求头。组合入口会覆盖浏览器传来的会话标识，
且只在允许的 API 路径注入。启动时实际发送错配探测，要求共享服务返回
409 和 `X-Devbridge-Rejected-Route`；不满足时部署失败，不发布可用链接。
健康检查再核对当前会话标识，避免把共享服务的 200 误判为预览就绪。

### 会话生命周期及隔离范围

- 每次部署先停止该 worktree 的旧会话，再执行 `doctor`、`up`；
  前端和后端均就绪后发布组合入口。重新部署可能分配新的端口。
- 会话和清理命令保存在主项目 `.automaker/previews/<wt-id>.devbridge/`。
  各 worktree 的状态文件、随机请求标识、远程进程目录及 agent 标签互不共用。
- 停止／删除 worktree 时先终止其会话并清理 agent，再删除前端资源。
  清理失败保留状态供重试；移除配置或 worktree 后仍可执行停止。
- Automaker 退出后，子进程通过 stdin 关闭检测父进程退出并清理；
  意外断电后的遗留资源在下次停止或重新部署时清理。
  服务端重启不会自动重建后端会话，需重新部署。
- devbridge 隔离请求和应用进程，**不自动隔离数据库、Redis 或队列**。
  API 写操作仍需独立数据库／schema／测试租户。可在业务的 API-only 模式下
  用 `DEVBRIDGE_ROUTE_ID` 区分测试数据；不能把此请求隔离当作数据隔离。

本地检查覆盖两个并行会话、端口隔离、路由防串用和独立停止。
真实环境还需验证两个版本标识、真实只读接口、启动日志无副作用及 agent 清理；
WebSocket、上传和流式接口按项目实际用法单独验收。

## 配置

Automaker 服务端所在机器需要 `kubectl`、镜像构建工具及访问本地 k3s 的权限。
显式选择开发集群 context，创建专用预览 namespace：

```sh
kubectl --context default create namespace automaker-preview
kubectl --context default label namespace automaker-preview automaker.dev/previews-enabled=true
```

仅给非生产 namespace 添加此标签。将下面的配置保存到**项目主目录**的
`.automaker/preview.json`（不从子 worktree 读取部署配置）。
`172.16.251.159` 是示例节点地址，请改成浏览器和 Automaker 服务端都可访问的 k3s 节点 IP。

```json
{
  "enabled": true,
  "context": "default",
  "namespace": "automaker-preview",
  "imageRepository": "local/automaker-preview",
  "buildCommand": [
    "nerdctl",
    "--address",
    "/run/k3s/containerd/containerd.sock",
    "--namespace",
    "k8s.io",
    "build",
    "-t",
    "{image}",
    "."
  ],
  "containerPort": 8080,
  "readinessPath": "/health",
  "exposure": {
    "type": "nodePort",
    "host": "172.16.251.159"
  }
}
```

项目需要 Dockerfile；镜像中的服务必须监听 `0.0.0.0:8080`，并在 `/health`
返回 2xx。上例需要运行中的 BuildKit，镜像直接构建到单节点 k3s 的 containerd
`k8s.io` namespace。多节点环境应使用所有节点都能拉取的开发镜像仓库：
设置 `imageRepository`，并配置 `"loadCommand": ["docker", "push", "{image}"]`。
Docker 构建可用 `"buildCommand": ["docker", "build", "-t", "{image}", "."]`。

命令为参数数组，不经过 shell；`{image}` 替换为每次部署的新镜像标签。
需要多步构建时，将步骤写入项目脚本，再使用
`["bash", "scripts/build-preview.sh", "{image}"]`。不要在配置中写凭据。
配置及 `.automaker/previews/` 运行状态应加入项目的本地忽略规则。

## 独立域名

已有 Ingress Controller 时，可将 `exposure` 改成：

```json
{
  "type": "ingress",
  "domain": "preview.example.test",
  "className": "traefik"
}
```

需要将 `*.preview.example.test` 解析到 Ingress 入口。链接形如
`http://wt-<项目和worktree路径的哈希>.preview.example.test`。
NodePort 模式使用 `http://节点IP:独立端口`，无需 Ingress Controller。
默认生成 HTTP 入口；登录和访问范围由开发环境的入口设施管理。

独立 NodePort 前端可在 Worktree 的 `.automaker/preview.json` 中启用 HTTPS：

```json
{
  "containerPort": 443,
  "tls": {
    "secretName": "preview-frontend-tls"
  }
}
```

Secret 必须已存在于预览 namespace，包含标准 `tls.crt`、`tls.key`，
以只读卷挂载到 `/etc/automaker/tls`。镜像需配置 HTTPS 监听并读取这两个文件；
服务端不会修改应用的 Nginx 配置。启用后 Pod 探针、外部就绪检查和预览链接均使用
HTTPS。私有 CA 可通过 `tls.caCertificate` 提供 PEM 格式的**公开证书**，
就绪检查仍校验证书和主机名；私钥只放在 Kubernetes Secret 中。
浏览器也需要信任该证书。此配置目前仅支持未启用后端 devbridge 的 NodePort，
不改变 devbridge 组合入口或 Ingress 的协议。

## 配置、依赖与副作用

可用 `env` 配置非敏感变量，`secretRefs` 引用**预览 namespace 中已有的**
Kubernetes Secret；Secret 内容不经 Automaker 导出。

```json
{
  "env": {
    "FOO_DEVBRIDGE_API_ONLY": "true",
    "BACKEND_URL": "http://backend.development.svc.cluster.local:8080"
  },
  "secretRefs": ["preview-app-config"]
}
```

每个预览隔离应用进程及 HTTP 路由；数据库、队列等是否隔离取决于项目配置。
连接共享开发依赖时，按技能中的 `safe-mode-checklist.md` 审计启动流程，
禁用自动迁移、种子写入、定时任务和消费者。设置一个环境变量并不会自动实现这些保护。
完整前后端预览可由镜像中的前端服务反向代理后端；本版本部署一个应用容器，
不复制整个环境，也不自动挂载共享 Pod 的配置文件或 ServiceAccount token。

## 测试与生命周期

部署先检查 namespace 标签和资源归属，再构建、加载镜像、等待 Deployment
就绪并请求外部 URL 的 readiness 路径。通过后才显示可点击链接。
界面轮询 Kubernetes 的 Deployment 就绪状态；启用 devbridge 时同时检查
组合入口的后端会话标识。未启用时这不是持续的外部 URL 探测。
状态保存在主项目 `.automaker/previews/`，服务端重启后仍能找回和停止部署；
被重启中断的部署会显示失败，需重新部署或停止。

通过已有 worktree「运行测试」入口执行测试时，就绪的预览地址会注入
`AUTOMAKER_PREVIEW_URL`。例如 Playwright：

```ts
export default defineConfig({
  use: { baseURL: process.env.AUTOMAKER_PREVIEW_URL || 'http://localhost:3000' },
});
```

存在部署中、失败或不可用的预览时，测试入口会要求先恢复或停止预览，
避免误测其他环境。停止预览后继续使用原有的本地测试方式。
未部署的 worktree 不会自动触发构建。

停止只清理当前 worktree 的 devbridge 会话及其 Deployment、Service、Ingress。
通过 Automaker 删除 worktree 时会先清理预览；清理失败会阻止删除。
外部手动删除 worktree 时，应先停止预览，也可以调用
`POST /api/worktree/preview-stop`，请求体包含原 `projectPath` 和 `worktreePath`。
镜像缓存保留供构建工具管理，不随停止自动删除。

构建失败时界面显示失败的程序与退出码，不回传可能含凭据的构建输出。
可在对应 worktree 中手动执行构建命令检查；Pod 启动异常可用
`kubectl --context <context> -n <namespace> logs deployment/<wt-id>` 查看。

API：`POST /api/worktree/preview-status`、`preview-start`、`preview-stop`，
均使用上述两个路径字段及 Automaker 的正常认证。start 返回 202 后后台部署，
通过 status 查询结果。每个 worktree 同时只允许一个部署或停止操作。
