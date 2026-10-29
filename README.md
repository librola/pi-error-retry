# pi-error-retry

独立 Pi 扩展，移植 `@local/dsh-error-retry` 的规则重试行为，并增加输出长度截断后的自动续写。当前在本机 Pi **1.4.0** 上验证。

## 必须区分的两种行为

| 情况 | 行为 | 模型上下文 |
| --- | --- | --- |
| `stopReason: "error"` 且规则命中 | 无限重试当前模型请求 | 追加 `context_edit`，省略失败回复；不插入“继续”或新的用户输入 |
| `stopReason: "length"` | 自动继续完成原任务 | 保留截断回复，追加明确续写提示；不从头重试 |
| 未匹配错误 | 本扩展不接管 | Pi 原有重试／恢复策略不变 |
| 用户停止、取消或卸载 | 停止 | 不在后台定时唤醒会话 |

Pi 中的 `Response was truncated before completion.` 对应第二种情况。续写不增加错误重试计数，也不使用错误退避。再次截断会再次续写，直至正常完成或用户停止。

Pi 自带的有限错误重试先行；它耗尽后，本扩展接管匹配错误。扩展重试发起的新请求仍可能经过 Pi 原有有限重试。不会全局关闭内置重试，也不会把所有错误都设为无限重试。

### 为什么重试不会重放工具

例如：原任务 → 工具 A 已执行 → 请求下一步失败。本扩展仅省略这个失败回复，下一次请求仍包含工具 A 的结果，不重新提交原任务，也不重新执行工具 A。

截断时，Pi 本身会将截断回复中的工具调用标记失败，不执行可能残缺的参数。本扩展保留这些结果，要求模型重新生成尚未执行的调用的完整参数。它与自然工具后续共用一次 continuation，不额外叠加第二次请求。

## 安装

从 npm 安装：

```sh
pi install npm:pi-error-retry
```

也可直接从 GitHub 安装：

```sh
pi install git:github.com/librola/pi-error-retry
```

在现有 Pi 会话中执行 `/reload`；新会话自动加载。克隆后的本地源码无需编译，也可临时加载：

```sh
pi -e ./pi-error-retry/index.ts
```

安装声明位于 `~/.pi/agent/settings.json` 的 `packages` 数组。本扩展只注册事件和用户命令，没有新增模型可调用的配置工具。

不要同时启用其他错误恢复／长度续写扩展，避免竞争触发。

## 配置和编辑

用户配置文件：

```text
~/.pi/agent/error-retry.json
```

设置了 `PI_CODING_AGENT_DIR` 时使用该目录。规则只从用户目录读取，不读取项目里的规则覆盖。

```text
/error-retry        查看规则数量、配置位置和两种恢复行为
/error-retry edit   用 Pi 原生 JSON 编辑器修改规则
/error-retry stop   停止当前请求
```

Pi 原生编辑器适用于 TUI 和支持该对话协议的 RPC 客户端；不提供 DSH 的插件详情页。JSON／print 模式请直接编辑文件。

- 规则每次由扩展接管错误前重新读取，不需要重新加载或卸载扩展。
- 保存时校验配置并原子写入；文件原文充当 revision，跨窗口保存使用排他锁。版本冲突不会覆盖他人修改。
- 非法草稿或保存失败不显示成功，并可以保留草稿继续编辑、主动读取最新配置，或取消。
- 保存不取消已经排定的等待；已排定的重试可能完成一次，下一次错误判定读取新规则。立即停止请使用标准停止按钮或 `/error-retry stop`。
- 非法配置、读取失败或正则匹配超时不被当成命中，也不静默回退为宽泛规则。

### 规则格式

```json
{
  "rules": [
    { "mode": "contains", "pattern": "Quota service is temporarily unavailable." },
    { "mode": "regex", "pattern": "^temporary overload(?:\\s|$)", "flags": "i" }
  ]
}
```

- 规则之间为 **OR**，任意一条命中就无限重试。
- `contains` 区分大小写，不接受 `flags`。
- `regex` 使用 JavaScript 正则，不写外围斜线；`flags` 只允许不重复的 `i/m/s/u`，不允许有状态的 `g/y`。
- `pattern` 不能为空或纯空白；有意义的前后空白会保留。
- 整组匹配在 `node:vm` 中共享 **25ms** 预算，超时不接管。这里只用 VM 限制正则回溯，不把它当成恶意代码安全沙箱。
- 显式提供 `rules` 完全替换默认规则，不追加。`{"rules":[]}` 仅关闭本扩展的错误重试，**不会关闭长度续写或 Pi 内置重试**。

不提供文件或省略 `rules` 时，默认与 DSH 源码一致，使用两条完整句子：

1. `Requests have exceeded the throughput limit on your Provisioned-Managed deployment. If you continue to exceed your limit, consider increasing the number of provisioned throughput units deployed.`
2. `Your request exceeds the maximum size allowed by your deployment's quota.`

`examples/error-retry.json` 提供从 DSH 配置迁移的 10 条示例规则；按需复制到用户配置文件使用。安装不会自动用示例覆盖你的配置，扩展默认列表仍保持上述两条。

## 等待、日志和范围

- 匹配错误的重试次数和累计等待时间均不设上限。
- 本地退避约为 1、2、4、8、16、30 秒，带 10% 抖动，最大 30 秒。
- 有效 `Retry-After-Ms`／`Retry-After` 响应头优先，支持毫秒、秒和 HTTP 日期；服务端长等待不截短，定时器分段避免溢出。
- 最终结束边界没有运行取消信号。因此边界只准备重试，实际等待在下一次 `agent_start`、发送模型请求之前进行，使用运行信号与扩展生命周期信号。标准停止可以立即取消长等待。
- 重试等待显示状态栏；`pi-error-retry.recovery` 非消息条目记录 `retry`、`retry-started` 和 `continue`。计数从当前分支日志恢复，按提供方、模型及规范化策略隔离；成功步骤、新用户输入或规则变化重置。
- 失败回复及其用量仍保留在原始会话历史和统计中，只从后续模型上下文省略，不删除历史。
- 用户已排队的新输入或其他扩展已选定的 continuation 优先，不追加竞争请求。
- 作用范围为加载了此扩展的 Pi Agent 主循环，包括同样加载此包的 Pi 子会话；不包装工具内部 HTTP、辅助总结调用或外部 CLI。外部子代理不会因为父会话加载而自动获得此扩展。
- 加载扩展不会自动唤醒已经结束的旧错误回合，需要用户手动继续。

**风险：无限重试可能产生无限请求和费用。** 配额／请求大小问题未必能靠等待修复，过宽正则也可能永远不成功。请保留明确规则，遇到永久错误及时停止并修正输入或部署。

## 验证

开发依赖安装不会安装另一份 Pi：

```sh
npm install --ignore-scripts --legacy-peer-deps
export PI_TEST_PACKAGE=/path/to/pi-coding-agent/package.json
npm run check
npm test
```

`PI_TEST_PACKAGE` 指向已安装 Pi 的包清单。不设置时从项目依赖中寻找宿主 Pi。测试使用真实 SDK、扩展 TypeScript 加载器、会话上下文投影及模拟 provider；不调用真实模型，也不读取用户模型凭据。临时文件在系统临时目录中创建和清理。

覆盖：101 次连续错误、内置重试串联、请求输入不变、截断前文保留、截断后错误重试、已执行工具不重放、截断工具不执行、取消长等待、规则热更新／冲突／校验、正则超时、退避、服务端等待及日志计数隔离。

当前 **32 项测试通过**，TypeScript 严格类型检查通过。

另有一个已独立对照复现的宿主限制：SDK 直接对活动会话调用 `session.dispose()` 时，Pi 1.4.0 会先解绑持久化订阅，随后可能报告 `turn_end could not resolve the persisted assistant entry ID`；仅注册空 `turn_end` 处理器、不加载本扩展也能复现。本扩展不会因此继续请求，也不会访问已失效的上下文。该宿主问题未修改；正常标准停止已验证，SDK 集成建议先 `await session.abort()` 再 `session.dispose()`。

真实提供方故障恢复和客户端 UI 交互尚未人工验收；SDK 与加载器验证不等同于实际付费请求验收。
