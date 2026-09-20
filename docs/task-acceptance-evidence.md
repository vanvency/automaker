# 任务卡验收材料

任务开发 Agent 可以输出原型参考、真实运行截图及验证步骤。Kanban 卡片和编辑任务
弹窗显示「验收结果」，点击可查看左右对照大图、页面来源、代码版本和逐项检查结果。
这些输出独立于任务描述中的输入附件，截图复制到任务目录后不依赖 worktree 的保留。

## Agent 产出约定

在任务所属 worktree 中写 `.automaker/acceptance/<featureId>/manifest.json`；
截图必须位于同一目录或其子目录，使用 PNG、JPEG 或 WebP，每张不超过 10 MiB，
最多 20 张。不要把密码、token、个人隐私或其他敏感信息写入截图、URL 和说明。

```json
{
  "status": "passed",
  "summary": "本机 k3s 实际页面验证了按筛选条件导出，下载内容与页面一致。",
  "previewUrl": "http://172.16.251.159:31000",
  "verifiedAt": "2026-09-19T07:00:00Z",
  "commit": "被测应用提交 SHA（未提交改动在 summary 中说明）",
  "checks": [
    {
      "name": "筛选后导出",
      "status": "passed",
      "details": "点击导出，下载 CSV；检查字段、行数及筛选范围。"
    }
  ],
  "screenshots": [
    {
      "kind": "prototype",
      "path": "prototype.png",
      "title": "审计页面原型",
      "capturedAt": "2026-09-19T06:50:00Z",
      "sourceUrl": "http://127.0.0.1:3001/demo/audit"
    },
    {
      "kind": "actual",
      "path": "actual.png",
      "title": "k3s 实际审计页面",
      "capturedAt": "2026-09-19T07:00:00Z",
      "sourceUrl": "http://172.16.251.159:31000/audit"
    }
  ]
}
```

`status` 为 `passed`、`failed` 或 `blocked`；检查项为 `passed`、`failed` 或
`skipped`。无法验证的场景必须明确标记，不能用原型截图充当真实截图。
通过结果要求至少一项通过、没有失败项，并同时具有原型图和真实截图。
这只验证证据结构，不代表系统能独立证明每项测试真实执行；由人结合日志和图片验收。

## 自动回填和补录

Agent 正常结束后，执行服务自动读取**本次运行开始后更新的** manifest，
复制截图到项目 `.automaker/features/<featureId>/acceptance/`，
将结构化结果保存在 `feature.acceptanceEvidence`，任务进入 `waiting_approval`。
旧文件不会被当作本次运行结果。新证据替换卡片当前展示内容，已有图片不自动删除。
没有 manifest 的任务保持原流程。Agent 异常退出时可用补录接口收集已有材料。

补录 API：`POST /api/features/acceptance-evidence`，请求体：

```json
{ "projectPath": "/workspace/project", "featureId": "task-id" }
```

使用 Automaker 正常认证。服务端根据任务分支解析 worktree，客户端不能指定任意
证据目录或图片。接口只更新验收材料，不改变任务状态或执行 MR 合并。
预览环境可以通过[worktree 预览](./worktree-previews.md)或任务专用部署脚本创建。
这里展示的是验证时记录的 URL，环境被停止后该历史地址可能不可用。
