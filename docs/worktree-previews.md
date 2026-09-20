# Worktree 功能测试预览（本地 k3s）

在 **Work Progress** 的卡片和表格中，每个 worktree 都有独立的「部署预览」、
「重新部署」、「停止预览」和「打开预览」。构建使用该 worktree 当前的磁盘内容，
包括未提交的改动；改动后需要重新部署。
每个 worktree 的任务看板顶部也提供「功能预览」栏，显示当前分支的预览操作；
隐藏 worktree 选择栏后仍可使用，切换 worktree 时预览链接同步切换。

参考 `skills/go-viper-k8s-devbridge` 的环境隔离和就绪验证原则，这里为每个
worktree 创建独立的 Deployment、Service，以及可选的 Ingress。
不使用 mirrord，不改写现有应用的 Deployment 或共享网关。
验收材料中的「验收环境」使用这里创建的独立 NodePort/Ingress 预览链接（例如 `http://172.16.251.159:32035/saas/`）。当前实现不使用 `go-viper-k8s-devbridge`。devbridge 提供后端请求隔离，通常输出 `127.0.0.1:18080` 回环代理；要使用它，需要将独立前端的后端代理接到该入口，并验证请求路由。独立前端端口本身不代表后端也已隔离。

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
当前实现生成 HTTP 入口；TLS、登录和访问范围由开发环境的入口设施管理。

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
界面轮询 Kubernetes 的 Deployment 就绪状态；这不是持续的外部 URL 探测。
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

停止只删除当前 worktree 所属的 Deployment、Service、Ingress。
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
