---
name: update
---

# 版本更新提醒（thsfund / references/update/update）

> 公共约定见 SKILL.md §2，全局禁止事项见 §3。

> **前置自检**：执行任何 `aijijin` 命令前，先按 SKILL.md §0 完成 SDK 自检。

本文件描述 CLI 受保护接口成功响应顶层的 `update` 字段如何被识别、展示与升级。模型在业务意图（持仓/申购/赎回/查询/撤单）成功返回后读取本文件判断是否需要提示用户升级。

## 触发条件

受保护接口（`fund buy` / `fund redeem` / `fund redeem-render`、`holding list` / `holding wallet-home` / `holding overview`、`trade list` / `trade detail` / `trade revoke`、`trade-account list` / `trade-account create`）的**成功响应**（`ok: true`）在以下条件**同时**满足时，CLI 会在 JSON 顶层附加一个 `update` 字段：

- `getworktoken` 本次返回中包含 `update` 对象（服务端提示当前 CLI 已是最新或需要更新）；
- 本地尚未 dismiss 该 `update.latestVersion`；
- 本次调用不是 `--dry-run`。

字段内容形如：

```json
{"update": {"latestVersion": "0.2.2", "downloadUrl": "下载地址", "changeLog": "..."}}
```

`changeLog` 格式为 Keep-a-Changelog Markdown（`## [版本] - 日期 \n 描述`）。`downloadUrl` 是**单 URL** 指向一个组合 zip 包（含 SDK + skill 整套）。

## 触发时机

业务意图的 CLI 命令成功返回（退出码 0）**之后**；自检阶段（§0.1 ~ §0.5）只判断"能不能干活"，**不触发**版本升级提示（会打断用户当前业务）。即使用户在升级提示后说"先不升级"，skill 也必须保留已完成业务的有效状态继续工作。

## 版本比较

模型必须在提示升级前，比较本地 SDK 版本与 `update.latestVersion`：

- **本地版本 >= `latestVersion`** ⇒ 当前 SDK 已不低于服务端推荐版本，**不展示**任何升级提示，直接返回业务结果给用户；
- **本地版本 < `latestVersion`** ⇒ 才进入下面的展示要求与用户询问流程。

版本比较时按主版本号（major）、次版本号（minor）、修订号（patch）逐段解析为整数比较；预发布（rc/alpha/Beta）按字符串字典序比较。

## 展示要求

提示语必须是"提醒/建议"语气，**不得**要求用户必须升级才能继续：

- 必须展示 `data.update.latestVersion`（新版本号）；
- 提示用户变更内容 `data.update.changeLog`；
- 可附带 `data.update.downloadUrl` 作为升级包来源（zip URL，不是 SDK 单文件）。

## 用户操作询问

使用 `AskQuestion` 提供以下四个选项（顺序固定），按用户选择进入对应分支：

1. **稍后再说（本次会话仍可能再提示）** —— 保留当前会话内未来受保护接口再次提示的机会；
2. **今天内不再提示（24h）** —— 执行：`aijijin auth dismiss-update --version <latestVersion> --mode today`；
3. **此版本不再提示** —— 执行：`aijijin auth dismiss-update --version <latestVersion>`（不传 `--mode` 即默认"此版本不再提示"）；
4. **立即下载并升级** —— 自动执行下方"升级动作"全流程（与 §0.4 "停下等用户完成"模式不同；用户已在 AskQuestion 中显式授权）；完成后提示用户 skill 文件已更新，下次业务起新会话生效（当前会话引用的 references 仍是旧版）。

## 升级动作（用户选择"立即下载并升级"后自动执行）

1. `curl -L -o <tmp> "<downloadUrl>"` 下载 zip 到临时目录；
2. `unzip -o <tmp> -d ~/.Codex/skills/` 解压覆盖 `thsfund/`（zip 根目录是 `thsfund/`，解压会整体覆盖现有 `thsfund/` 目录，旧 vendor whl 被新 vendor whl 自然替换）；
3. `pip install --force-reinstall "<~/.Codex/skills/thsfund/vendor/aijijin_sdk-X.Y.Z-py3-none-any.whl>"` 装新 SDK；
4. 提示用户 skill 文件已更新，下次业务起新会话生效。

## 升级范围

SDK + skill 本身（`SKILL.md` / `references/` / `vendor/`）**必须一起升**，不允许只升其一（skill 改了引用/字段名但 SDK 没换版本会出现接口错位，反之亦然）。

---

## 需登录授权的错误路由（→ SKILL.md §0.5）

`aijijin` CLI 调用失败后，按 `error.code` 精确路由：

- `CredentialsNotFoundError` / `RefreshTokenExpiredError` / `DeviceAuthorizationError` / `TokenError` (`1001/1002/1003`) → **§0.5**（执行 `aijijin auth login`）

模型在 references 主体流程内遇到上述错误时，立即跳到 SKILL.md §0.5。登录成功后只重试原命令一次；不要在本文档内自行循环或绕过。