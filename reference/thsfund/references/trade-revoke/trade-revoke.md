---
name: trade-revoke
---

# 基金撤单（thsfund / references/trade-revoke/trade-revoke）

> 公共约定见 SKILL.md §2，全局禁止事项见 §3。

> **前置自检**：执行任何 `aijijin` 命令前，先按 SKILL.md §0 完成 SDK 自检。

基金撤单完整流程，包含：**订单详情查询 → 可撤单判断 → 用户最终确认 → 执行撤单 → 必要时复核详情**。

所有受保护接口均通过 `aijijin` CLI 调用。

---

## 全局禁止事项

通用禁止项（自动更换订单号、跳过可撤单判断、跳过用户最终确认、失败时自动重试、Work Token 直连等）见 SKILL.md §3。撤单动作专属约束：

- **禁止发送额外字段**：服务端撤单请求只接受 `revokeAppSheetNo`、`transActionAccountId`、`refundSource`；不得注入 `operator`、`revokeType` 或其他字段。

---

## 本轮状态变量

执行过程中持续维护以下状态，后续接口必须使用本轮状态值，不得混用历史值：

| 变量 | 来源 | 用途 |
|---|---|---|
| `appSheetSerialNo` | 用户指定/确认 | 详情查询与撤单必须使用该订单号 |
| `transactionAccountId` | 本轮订单详情响应的 `data.transactionAccountId` | 撤单时映射为 `transActionAccountId` |
| `businessCode` | 本轮订单详情响应的 `data.businessCode` | 区分订单类型：`020`/`022`/`039`=申购类 |
| `feeSource` | 本轮订单详情响应的 `data.feeSource` | 区分资金来源：`0`=银行卡，`1`=活期，`2`=钱包 |
| `refundSource` | 由 `businessCode` + `feeSource` 计算 | 撤单时映射为 `refundSource`：申购类且银行卡购买 → `"1"`；其它情况 → `"0"` |
| `cancelFlag` | 详情查询 | `0` 表示可撤单，`1` 表示不可撤单 |
| `confirmFlag` | 详情查询 | 撤单前的当前状态字段 |

### `refundSource` 计算规则

`refundSource` 必须由 Skill 在执行撤单前根据本轮订单详情的两个字段自行判定并填入，禁止让用户手工输入或猜测。：

- 满足 **`businessCode ∈ {020, 022, 039}`**（申购类订单）**且 `feeSource == '0'`**（银行卡购买）→ `refundSource = "1"`
- 其它情况默认→ `refundSource = "0"`

判定所需的两个字段均来自 `aijijin trade detail` 响应的 `data.businessCode` 与 `data.feeSource`。

---

## 订单锁定约束（强制执行）

**本 Skill 在处理撤单请求时，必须严格遵守以下约束，禁止违反：**

1. **订单号锁定**：一旦确定用户要撤销的订单号 `appSheetSerialNo`，所有后续 CLI 调用（`trade detail`、`trade revoke`）都必须使用该 `appSheetSerialNo`。
2. **交易账户锁定**：订单详情成功后，必须从本轮响应读取非空 `data.transactionAccountId`。撤单只能使用该值，禁止让用户另行输入、从历史订单复用或自行猜测；**禁止** 用逗号/分号/竖线/空格拼接多个账户（如 `--transaction-account-id "600110028462,600110028463"`），CLI 已收紧校验，传入拼接值会立即返回 `field: "transActionAccountId"`、`message: "must be a numeric transaction account ID starting with 600"` 错误并停止；字段缺失或为空时停止，不得调用 `trade revoke`。
3. **撤单请求禁止携带非文档字段**：仅可使用 `--order-id`、`--transaction-account-id`、`--refund-source`；其余字段一律不得手工拼接或映射。`--refund-source` 必须由 Skill 根据本轮订单详情的 `businessCode` 与 `feeSource` 计算后填入，禁止让用户直接指定或绕过。
4. **禁止更换订单**：当 CLI 返回业务错误时，**禁止** AI 自动从交易记录中挑选其他订单号进行重试，必须将原始错误信息（`error.code`、`error.message`）原样返回给用户。
5. **禁止推测替代方案**：不允许 AI 自行从交易记录中推测可撤单订单来"曲线救国"，不允许在用户未明确指定的情况下对其他订单进行任何撤单操作。
6. **撤单结果不明确时必须重新查询详情**：网络超时、连接中断、5xx 或响应格式异常时，禁止自动重试撤单；先调用 `aijijin trade detail --order-id "$appSheetSerialNo"` 复核当前订单状态，并将结果告知用户。

---

## CLI 命令规范

读服务端字段时要再往下取一层 `data.<field>`（例如 `data.cancelFlag`、`data.confirmFlag`、`data.appSheetSerialNo`、`data.transactionAccountId`）。

`aijijin trade revoke` 是提交型命令：返回 `ok: true` 只表示提交成功，不等于订单最终被撤销。提交结果不明确时，必须先调用 `aijijin trade detail --order-id "$appSheetSerialNo"` 复核实际订单状态。

### `aijijin trade detail`

查询单个订单的详情，用于撤单前的可撤单判断与信息展示。参数、取值与响应字段见 [`../trade-query/cli.md`](../trade-query/cli.md)；本文只补撤单动作对响应字段的关注点。

注意：服务端请求内容只包含 `appSheetSerialNo` 一个字段。

调用示例：

```bash
aijijin trade detail --order-id "$appSheetSerialNo"
```

### `aijijin trade revoke`

提交订单撤单。一次性的提交命令，CLI 不会对超时、连接错误、5xx、响应异常或业务错误进行自动重试；只有 HTTP 401 会自动重新获取 Work Token 并重放一次。提交结果不明确时，必须先查询订单状态再说明，不得自动重新提交。

参数：

| 选项 | 必填 | 类型 | 取值 | 服务端字段 | 说明 |
|---|---|---|---|---|---|
| `--order-id` | 是 | 字符串 | — | `revokeAppSheetNo` | 待撤单的单据编号 |
| `--transaction-account-id` | 是 | 非空字符串 | 来自本轮订单详情 | `transActionAccountId` | 详情响应中的 `transactionAccountId` |
| `--refund-source` | 是 | 字符串 | `"0"` 或 `"1"` | `refundSource` | 退款来源标识；按 §本轮状态变量 的 `refundSource` 计算规则从本轮订单详情的 `businessCode` + `feeSource` 派生，禁止手工猜测或询问用户。 |
| `--json-file` | 否 | 文件路径 | — | — | 基础请求体；与 `--stdin` 互斥；可与 `--json` 和命名选项共存并被覆盖 |
| `--stdin` | 否 | 标志 | — | — | 从 stdin 读取请求体；与 `--json-file` 互斥 |
| `--json` | 否 | 字符串 | — | — | 内联 JSON 字符串；可补充或覆盖基础请求体 |
| `--dry-run` | 否 | 标志 | — | — | 仅校验，不发起网络请求；输出 `{"endpoint": "revoke", "request": {...}}` |

注意：服务端请求内容只包含 `revokeAppSheetNo`、`transActionAccountId`、`refundSource` 三个字段。CLI 不接受也不会发送其他字段。

成功输出：UTF-8 JSON `{"ok": true, "data": <server-response>}`，exit 0。

> 顶层可附 `update` 字段（受保护接口 + 未 dismiss 时由 CLI 透传），详见 SKILL.md §2 第 8 条。

调用示例：

```bash
aijijin trade revoke \
  --order-id "$appSheetSerialNo" \
  --transaction-account-id "$transactionAccountId" \
  --refund-source "$refundSource"
```

### 关键响应字段（`trade detail` 与 `trade revoke` 的 `data` 字段）

| 字段 | 说明 |
|------|------|
| data.appSheetSerialNo | 订单号 |
| data.fundCode | 基金代码 |
| data.fundName | 基金名称 |
| data.businessCode | 业务代码：`020`/`022`/`039`=申购类，`023`=赎回。撤单的 `refundSource` 仅在申购类订单上参与判定 |
| data.productType | 产品类型：0101=普通基金, 0102=养老基金 |
| data.cancelFlag | 撤单标志：'0'=可撤单, '1'=不可撤单 |
| data.confirmFlag | 确认状态：'0'=未确认, '1'=已撤单, '3'=确认成功, '4'=确认失败, '6'=作废 |
| data.transactionAccountId | 交易账号ID |
| data.feeSource | 资金来源：'0'=银行卡, '1'=活期, '2'=钱包。撤单的 `refundSource` 仅在银行卡购买（`'0'`）时取 `"1"` |
| data.applicationAmount | 申请金额 |
| data.walletPayAmount | 钱包支付金额 |
| data.cardPayAmount | 银行卡支付金额 |
| data.bankAccount | 银行卡账号（后4位） |
| data.bankName | 银行名称 |
| data.acceptTime | 受理时间 |
| data.exceptCfmDate | 预期确认日期 |

### 撤单结果展示

面向用户的结果使用简洁卡片，不展示 `ok`、退出码、`confirmFlag`、`refundSource`、`refundAmount` 或其他底层字段。撤单接口只关联原订单号，未定义独立的“撤单单据编号”，不得自行编造。

撤单成功时必须告知用户**交易金额将退回至钱包**，让用户对资金去向有明确预期。

#### 撤单已确认（推荐主卡片）

复核 `aijijin trade detail` 响应 `data.confirmFlag = '1'` 后，按以下 9 字段格式展示最终结果：

| 字段 | 取值来源 |
|---|---|
| 订单号 | `data.appSheetSerialNo` |
| 基金代码 | `data.fundCode` |
| 基金名称 | `data.fundName` |
| 购买金额 | `data.applicationAmount`（带 `元` 单位） |
| 支付方式 | 由 `data.feeSource` 派生：`'0'` → `银行卡 - <bankName>-<bankAccount 后 4 位>`；`'1'` → `活期`；`'2'` → `钱包` |
| 申请下单时间 | `data.acceptTime` |
| 撤单时间 | 复核详情查询时记录的本轮时间戳；若 `data` 返回 `confirmTime` / `cancelTime` 等具体撤单确认字段，优先使用字段值 |
| 退款金额 | 默认等同购买金额（撤单全数退回），带 `元` 单位；若 `data` 返回 `refundAmount` 等具体退款字段，优先使用字段值 |
| 交易状态 | `↩️ 已撤单`（来自 `confirmFlag = '1'`） |

```text
订单号	00000000000105876459
基金代码	000083
基金名称	添富消费行业混合
购买金额	300.00 元
支付方式	银行卡 - 中国农业银行-4949
申请下单时间	2026-09-09 16:11:37
撤单时间	2026-09-09 16:12:26
退款金额	300.00 元
交易状态	↩️ 已撤单
```

#### 撤单已提交（过渡态，退化为简化卡片）

`aijijin trade revoke` 成功返回 `ok: true` 但复核详情仍未观察到 `confirmFlag = '1'` 时，先给出简化卡片并提示用户稍后查询详情，不要把"已受理"包装成"已撤单"。

```text
基金：<fundName>（<fundCode>）
原单据编号：<appSheetSerialNo>
状态：撤单申请已提交

提示：交易金额将退回至钱包；最终是否撤销以订单详情为准。
```

#### 撤单未提交

服务端明确拒绝或业务失败时，按以下卡片展示可读原因，禁止把 `error.code` / `error.message` 字面量直接抛给用户。

```text
基金：<fundName>（<fundCode>）
原单据编号：<appSheetSerialNo>
原因：<可读失败原因>
```

#### 撤单结果待确认

网络超时、连接中断、5xx 或响应异常时，先查询原订单详情复核实际状态，不能自动再次撤单：

```text
基金：<fundName>（<fundCode>）
原单据编号：<appSheetSerialNo>
说明：本次撤单提交结果尚无法确认，请先查询订单详情；为避免重复操作，不会自动再次撤单。
```

### 可撤单判断

- `cancelFlag = '0'`: 可撤单，向用户展示完整订单信息并请其确认后撤单。
- `cancelFlag = '1'`: 不可撤单，**禁止** 调用 `aijijin trade revoke`，向用户说明该订单状态不可撤销。

---

## 完整交互流程

```
1. 收集参数 → 用户提供订单号 appSheetSerialNo（与查询阶段确认）
2. 订单详情查询 → aijijin trade detail --order-id "$appSheetSerialNo"；保存 data.transactionAccountId / data.businessCode / data.feeSource
3. 可撤单判断 → 检查 cancelFlag：'0'=可撤单，'1'=不可撤单
4. 订单展示 → 向用户展示订单关键信息（基金代码、名称、金额、受理时间等）
5. 最终确认 → 用户明确确认后继续；用户未确认则终止流程
6. 计算 refundSource → 按本轮 data.businessCode + data.feeSource 按 §本轮状态变量 中的规则计算 refundSource（缺字段则停止）
7. 执行撤单 → aijijin trade revoke --order-id "$appSheetSerialNo" --transaction-account-id "$transactionAccountId" --refund-source "$refundSource"
8. 结果判定 → exit 0 且 ok:true 仅表示“撤单已提交”；其他退出码或结果不明确时先复核详情，不把提交受理表述为最终撤销
9. 复核（如需）→ 撤单结果不明确时再次 aijijin trade detail --order-id "$appSheetSerialNo"，将真实状态告知用户
```

---

## 注意事项

1. **Work Token**：见 SKILL.md §2 第 3 条。
2. **撤单为提交型命令**：网络超时、连接中断、5xx 或响应格式异常时禁止自动重试撤单；先调用 `aijijin trade detail` 复核订单实际状态，再决定是否再次撤单。
3. **不可自动更换订单**：CLI 业务错误（退出码 `4`）时必须原样返回错误信息，禁止挑选其他订单替代。
4. **不可显示底层状态码**：面向用户只展示中文状态和可读原因。
5. **交易账户必须来自详情**：撤单命令的 `--transaction-account-id` 必须取本轮订单详情的 `data.transactionAccountId`；缺失或为空时停止。
6. **不得发送额外字段**：撤单请求只包含 `revokeAppSheetNo`、`transActionAccountId`、`refundSource`；禁止传入或其他字段。
7. **`refundSource` 必须由 Skill 计算**：根据本轮订单详情的 `data.businessCode` 与 `data.feeSource` 按既定规则得出，禁止让用户直接输入或猜测。


---
---

## 需登录授权的错误路由（→ SKILL.md §0.5）

`aijijin` CLI 调用失败后，按 `error.code` 精确路由：

- `CredentialsNotFoundError` / `RefreshTokenExpiredError` / `DeviceAuthorizationError` / `TokenError` (`1001/1002/1003`) → **§0.5**（执行 `aijijin auth login`）

模型在 references 主体流程内遇到上述错误时，立即跳到 SKILL.md §0.5。登录成功后只重试原命令一次；不要在本文档内自行循环或绕过。
