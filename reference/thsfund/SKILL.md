---
name: thsfund
description: Use when the user asks about ai基金/爱基金持仓、钱包总览、总资产，申购/买入/加仓/加投（含选择或新建分仓），赎回/卖出/清仓，交易记录/买卖记录/订单查询，或撤单/撤销订单。Do not use for standalone 费率、基金信息、NAV 估值或持仓之外的钱包查询。
version: 0.2.3
---

# thsfund Skill

`thsfund` 是 `aijijin` CLI 基金业务的统一入口，覆盖 5 类意图：持仓总览、申购、赎回、交易记录查询、撤单。命中任一意图后，按下表进入对应 `references/` 子文件，按动作流程完整执行。

## §0 前置条件：SDK 自检与安装引导

任何 `aijijin` 命令执行前都必须先完成本节自检；缺失或版本不足时**模型可在用户同意后替用户执行安装**（见 §0.3），未取得同意前不要执行 pip install。

### §0.1 兼容版本 & 自检命令

- **最低兼容版本**：`aijijin-sdk 0.2.3`。必须满足 `Version >= 0.2.3`；
- **自检命令**：

  ```bash
  pip show aijijin-sdk
  ```

  解析 `Version:` 行；命令非 0 退出或 `Version` 缺失 ⇒ SDK 未安装；仅 `Version >= 0.2.3` 满足兼容要求。

> SDK 装好后，`aijijin` CLI 入口随 pip 安装自动写入 Python 的 Scripts 目录；如遇 `pip show` 通过而 `aijijin` 调用报错「command not found」，停下向用户报告「Scripts 目录未在 PATH，请重新安装或将 Scripts 加入 PATH」。

### §0.2 决策矩阵

| `pip show` 结果 | 动作 |
|---|---|---|
| 未安装 / 解析失败 | 展示安装命令（见 §0.3），询问用户是否同意安装；同意后执行 pip install 并重新自检；不同意则停下 |
| `Version < 0.2.3`（含未安装 / 解析失败） | 展示安装/重装命令（见 §0.3，未安装时不加 `--force-reinstall`，版本低于 0.2.3 时加 `--force-reinstall`），说明当前版本不满足最低兼容要求，用 AskQuestion 询问用户是否同意升级到 0.2.3；同意后执行并重新自检；不同意则停下 |
| `Version >= 0.2.3` | 通过，进入 §1 路由 |

### §0.3 安装命令模板

skill 自带 `vendor/aijijin_sdk-0.2.3-py3-none-any.whl`，使用本地绝对路径安装，无需联网：

```bash
pip install "<skill_dir>\vendor\aijijin_sdk-0.2.3-py3-none-any.whl"
```

`<skill_dir>` 必须替换为本 skill 的实际目录。模型在向用户展示时把绝对路径写完整，不要让用户猜测。

- 版本不匹配时加 `--force-reinstall`，避免其他版本 CLI 残留；命令示例：`pip install --force-reinstall "<skill_dir>\vendor\aijijin_sdk-0.2.3-py3-none-any.whl"`。

### §0.4 references/*.md 的引用约定

每个会调用 `aijijin` 的 `references/**/*.md`（共 8 个：入口文件 `overview/overview.md` / `purchase/purchase.md` / `redeem/redeem.md` / `trade-query/trade-query.md` / `trade-revoke/trade-revoke.md`，以及 `purchase/` 下 3 个子文件 `api-reference.md` / `display-templates.md` / `order-status.md`）首部都以一行 `前置自检` 指针回链到本节；模型在执行该文件任何 CLI 命令前必须再次确认 §0 已通过。

每个 `references/**/*.md` 的错误处理表都必须包含以下四类登录错误，并统一路由到 §0.5：

| CLI 错误 | 触发条件 | 动作 |
|---|---|---|
| `CredentialsNotFoundError` | 本地凭证不存在 | → §0.5 |
| `RefreshTokenExpiredError` | Refresh Token 不存在、过期或已吊销 | → §0.5 |
| `DeviceAuthorizationError` | 当前设备未完成授权或设备信息失效 | → §0.5 |
| `TokenError` (`1001/1002/1003`) | API-Key 不存在、过期或已吊销 | → §0.5 |

## §0.5 登录授权

安装完成后的凭证检查，或任一业务命令命中 §0.4 的登录错误时，执行统一登录命令：

```bash
aijijin auth login
```

执行规则：

- 使用默认命令，不添加 `--force`。凭证仍有效时 CLI 会直接返回成功，不会要求用户重复扫码。
- 需要重新授权时，由 CLI 打开服务端返回的登录页面，并持续轮询、交换和保存凭证；模型不得自行打开本地页面、解析二维码或接管轮询。
- 命令运行期间提示用户在同花顺 App 内扫码并确认授权，然后等待 CLI 自行结束；不要要求用户复制或粘贴任何凭证。
- 只有用户明确要求重新扫码/切换授权时，才可以在说明影响后使用 `aijijin auth login --force`。

按 CLI 结果路由：

| 退出码 | `confirmStatus` | 动作 |
|---|---|---|
| 0 | `1` | 登录有效；安装流程进入完成汇报，业务错误恢复流程只重试原业务命令一次 |
| 2 | — | 登录参数无效 → 展示 `error.message`，停下 |
| 3 | — | 扫码超时、用户拒绝、会话失效或认证失败 → 展示 `error.message`，停下；需要重试时重新运行完整登录命令 |
| 4 | — | 业务失败 → 展示 `error.message`，停下 |
| 5 | — | 网络、响应或服务端异常 → 展示 `error.message`，停下 |

登录失败时不得盲目循环；登录成功后若原业务命令仍返回同一登录错误，展示最新错误并停下。

## §1 意图路由表

模型按 description 命中意图后，按下表读取对应 references/ 子文件（按原 5 skill 意图分目录：`overview/` / `purchase/` / `redeem/` / `trade-query/` / `trade-revoke/`）：

| 用户意图（关键词） | 进入 references |
|---|---|
| 持仓 / 总持仓 / 总资产 / 我的基金 / 钱包 + 持仓 / 今天赚了多少 | `references/overview/overview.md` |
| 买入 / 申购 / 购买 / 加仓 / 加投 / subscribe | `references/purchase/purchase.md` |
| 赎回 / 卖出 / 清仓 / 把基金赎回来 | `references/redeem/redeem.md` |
| 交易记录 / 买卖记录 / 最近买了什么 / 查一下我的交易 / 订单查询 / 历史订单 | `references/trade-query/trade-query.md` |
| 撤单 / 撤销订单 / 撤销这笔 / revoke / cancel order | `references/trade-revoke/trade-revoke.md` |
| 安装 / 重装 / 更新 / 部署 / 升级爱基金 skill | `references/install/install.md` |

子文件首部统一以一行 `> 公共约定见 SKILL.md §2，全局禁止事项见 §3。` 引用本文，不重复整段。

## §2 公共约定

所有 `references/**/*.md` 共用以下契约：

1. **CLI 输出与退出码约定**：`aijijin` CLI 对所有命令统一输出 UTF-8 JSON，即使 Windows 本地代码页不是 UTF-8 也能直接 `json.loads` 解析。
   - 成功（退出码 0）：`{"ok": true, "data": <server-response>}`
   - 失败（退出码非 0）：`{"ok": false, "error": {"code": "...", "message": "...", "field": "..."}}`
   - 退出码语义：`0` 成功 / `2` 输入或校验失败 / `3` 凭据或认证失败 / `4` 业务失败 / `5` 网络或服务端异常。
2. **读字段一律取 `data.*`**：所有服务端字段都要再往下读一层 `data.<field>`（如 `data.fundRiskLevel`、`data.cancelFlag`）；`trade list` 的订单数组在 `data.data[]`（三层嵌套）。
3. **Work Token 由 CLI 自动管理**：skill 不需要也无法获取 Work Token，禁止调用任何 Work Token 或 Refresh Token 接口。
4. **CLI 重试规则**：除 `trade-account create` 外，CLI 仅在服务端明确返回 HTTP 401 时刷新凭据并重试一次；网络超时、连接中断、5xx 或响应异常时不会自动重试。创建虚拟账户是不可安全重放的写操作，`trade-account create` 包括 HTTP 401 在内均不自动重试。
5. **用户询问规范**：所有需要用户确认 / 选择 / 输入的步骤，**优先使用 `AskQuestion` 工具**。若当前 Agent 不支持 `AskQuestion`，则降级为**直接用文字询问**并等待用户回复。本规范覆盖所有 `references/**/*.md` 中的「询问用户」「用户确认」「用户输入」「等用户」等步骤；各文件无需重复说明，统一引用本条。
6. **面向用户展示约束**：不得展示底层状态码、`confirmFlag`、`checkFlag`、`failMsg.code` 等字段名或字段值；面向用户只展示中文状态和可读原因。
7. **dry-run 行为**：所有 CLI 命令都支持 `--dry-run`，仅在排查拼写错误、字段合并结果或 Schema 报错时使用——它执行命名选项 + JSON 输入合并和 Schema 校验，但不读取 Work Token、不发起网络请求、不会产生交易，输出 `{"endpoint": <name>, "request": <merged-payload>}`。dry-run 不是流程的一部分，不写进正常调用样例。
8. **顶层 `update` 字段（版本更新通知）**：受保护接口成功响应（`ok: true`）顶层可能附 `update` 字段；触发条件、展示要求、用户询问与升级动作全部抽到 `references/update/update.md`，模型在业务命令成功返回后读取该文件判断是否需要提示升级。

## §3 全局禁止事项

| 禁止事项 | 原因 |
|---|---|
| 禁止自动更换基金代码 / 订单号 / 交易账户 | 真实交易必须锁定用户指定对象 |
| 禁止跳过可撤单判断、风险等级校验、协议确认、支付方式选择、用户最终确认等用户确认节点 | 监管与合规要求 |
| 禁止把用户的购买 / 赎回 / 撤单意图当作风险确认、协议确认、支付方式选择、撤单最终确认 | 不得用意图代替显式确认 |
| 禁止在申购 / 赎回 / 撤单提交失败或结果不明确时自动重试 | 必须先查订单状态再说明 |
| 禁止展示底层状态码、确认标志、失败错误码 | 面向用户只展示中文状态和可读原因 |
| 禁止自行调用任何 Work Token / Refresh Token 接口 | CLI 自动管理；skill 不需要也无法访问 |
| 禁止使用 `curl` 直连保护接口 | 一律走 `aijijin` CLI |
| 禁止通过 `python -c` 内联脚本调用 `aijijin_sdk` 模块绕过 CLI | 一律走 `aijijin` CLI |
| 禁止手工发送未在 CLI Schema 暴露的字段 | CLI 自动完成字段映射 |
| 禁止用逗号/分号/竖线/空格拼接多个 ID 传入单值 CLI 参数（如 `--transaction-account-id "600110028462,600110028463"`、`--fund-code "000001,000002"`、`--order-id "1,2"`、`--trade-id "v1,v2"`）；每个 ID 都是 single token。SDK 0.2.3 起对这些字段做了正则收紧，拼接值会被 CLI 立即拒绝并报 `field` 错误，模型不得把列表用分隔符拼成单串绕过 | 防止服务端收到"列表串"后类型/格式校验失败 → 5xx；用户多账户/多订单时必须先 AskQuestion 选定唯一值再传 |
