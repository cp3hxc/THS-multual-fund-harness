# 基金 AI 工作台与 PandaAI 风格场外基金策略 Agent

> **协作与隐私提示**：本仓库包含可共享的项目代码和运行依赖，不包含任何人的扶摇密钥、同花顺授权、模型 API Key、账户资料或个人持仓快照。每位使用者必须在自己的电脑上配置扶摇密钥，并在应用内独立完成同花顺扫码授权；请勿把这些个人信息提交到 GitHub、Issue、PR 或聊天记录中。

本目录保留原基金工作台，同时提供一套独立的 PandaAI 风格策略研究入口。原工作台的功能设计与接口问题见 [优化说明](优化说明.md)。

## 同事克隆后的首次配置

项目代码已包含固定版本的同花顺 SDK 安装包及 npm 锁文件。运行脚本会在本机建立 Python 虚拟环境并安装依赖，不需要手动下载项目依赖。需要 macOS、Python 3、Node.js/npm；策略 Agent 桌面版还需要已安装并登录的 Codex CLI。桌面打包脚本面向 Apple Silicon Mac。

1. 克隆私有仓库后，在项目目录运行 `./start.command`（浏览器工作台）、`./start-panda-strategy.command`（策略 Agent），或 `./start-desktop.command`（Codex 桌面工作台）。首次运行会准备本地依赖。
2. 在“接入设置”中按页面提示完成同花顺扫码授权。授权由同花顺 SDK 保存到当前 macOS 用户目录，不会写入项目仓库。
3. 需要真实复权净值数据时，在项目目录创建 `.runtime/fuyao.key`，将自己的扶摇 API Key 放入该文件。文件权限应为 `0600`；也可以用环境变量 `FUYAO_API_KEY`。不要把密钥写进源码、`.env`、截图、Issue 或 PR。
4. 使用 Codex Agent 时，确保 Codex CLI 已由本人安装并登录。每位同事使用各自的模型登录、扶摇 Key 和同花顺授权；不要共享凭据文件。

仓库根目录的 `.gitignore` 会排除 `.runtime/`、虚拟环境、依赖构建产物、常见密钥/授权文件，以及本机历史持仓页面快照。提交前仍需检查 `git status`，不要使用 `git add -f` 强制加入个人数据。

项目需要在 GitHub 私有仓库中协作。仓库管理员可在 GitHub 仓库 Settings → Collaborators 中邀请同事，并要求所有贡献者遵守 [CONTRIBUTING.md](CONTRIBUTING.md) 的隐私检查。

## 桌面应用

首次构建并安装到“应用程序”：

```sh
./build-desktop.command
```

之后可从 `/Applications/基金 AI 工作台.app` 双击启动。开发中也可双击 `start-desktop.command`，它会在需要时构建并打开项目内的应用。

桌面应用会自动启动 Python 基金服务和 Codex App Server，退出时只清理由它启动的子进程。它使用专属的 Codex 数据目录和会话索引，不会把其他 Codex 任务混入工作台。

## 浏览器模式

在 macOS 上双击 `start.command`；或者在项目目录运行：

```sh
./start.command
```

浏览器访问 <http://127.0.0.1:8765>。真实接口需要本地 Python 服务，不能仅双击 HTML 获取账户数据。保持启动服务的终端运行；停止时按 Ctrl+C。

## PandaAI 风格场外基金策略 Agent

这是独立于原基金工作台的新入口，沿用 PandaAI 的深色导航、持续对话、策略编辑双栏、运行阶段和回测历史交互。双击 `start-panda-strategy.command`，或在项目目录运行：

```sh
./start-panda-strategy.command
```

命令会启动 Electron 桌面版并直接进入场外基金 Agent。它使用真实 Codex 会话、模型与推理强度选择、历史会话恢复、置顶/重命名/归档、工具进度和中断；浏览器地址 <http://127.0.0.1:8765/panda-strategy-agent.html> 仅用于无模型的页面预览。策略参数调整只作用于 Skill 支持的范围，保存计划前仍需确认标的和资金安排。

首次启动会建立项目虚拟环境并使用附件中的 `aijijin-sdk 0.2.3`。已存在且有效的同花顺授权可直接复用；需要登录时，在“接入设置”点“扫码登录”，由官方 CLI 打开授权页面。

端口占用时可指定其他端口：

```sh
.venv/bin/python server.py --port 8766 --open-browser
```

## 已实现

- 真实持仓、钱包、账户、净值日期、收益日期和可用份额查询。
- 真实订单、处理中/历史筛选、日期过滤、游标分页及订单详情。
- 持仓页每只基金可直接发起真实申购或赎回；支持银行卡/钱包支付，展示费用、协议、账户与状态，由用户在最终确认页本人提交。
- 订单中心支持可撤订单多选、全选和批量撤单；服务端提交前逐笔复核订单，并单独返回每笔成功或失败结果。
- 每次真实提交使用 10 分钟有效的一次性确认令牌；提交前校验失败可在原页修改后重试，令牌只在真实写请求前锁定。网络或结果不明确时不自动重试，提交后立即查询订单详情。
- 买入/赎回本地交易待办继续保留，与真实订单分开显示。
- 策略模板、个人策略草稿、参数预算校验、同基金冲突检查、版本快照与归档。
- 独立自选清单。
- 内嵌 Codex Harness Agent：持续会话、历史恢复、工具进度、可读推理摘要、澄清问题、中断和 Markdown 结果卡片。
- PandaAI 风格场外基金 Agent：左侧历史会话与置顶、策略/持仓/自选/计划分类首页、受控策略定义编辑、参数版本、异步回测阶段、耗时与日志。
- Agent 可调用五策略目录、真实历史回测和策略版本保存工具；网页和 Agent 共用同一确定性策略引擎。
- 新入口直接展示同花顺真实持仓，并用扶摇复权净值生成当前权重归因、风险曲线和单基金下钻。
- 订阅模式从 Codex 实时读取可用模型与对应推理强度；选择用于之后新建的会话，已有会话继续使用创建时固定的模型。
- 账户日常问题使用聚合简报工具，一次返回最新收益率、涨跌分布、贡献/拖累、待确认资金和批量净值日期，减少重复工具调用。
- ChatGPT / Codex 订阅、OpenAI API Key 及 Responses 兼容第三方 API；每个会话固定模型服务。
- 账户数据授权按会话和服务商记录；未授权时仅开放非账户工具。
- API Key 使用 Electron `safeStorage` 交给 macOS 系统加密，不进入前端存储、对话或日志。
- 扶摇真实复权净值与沪深300基准：当前权重组合曲线、年化波动、最大回撤、夏普比率、资产配置和相关性矩阵。
- Codex 与页面共用统一业务服务，策略、自选和待办使用跨进程文件锁防止覆盖。

## Codex Harness Agent

Electron 主进程通过 stdio 连接 Codex App Server，对接 `thread/start`、`thread/resume`、`thread/read`、`turn/start` 和 `turn/interrupt`。渲染进程只能通过 [desktop/preload.js](desktop/preload.js) 的受限 IPC 调用它，并启用上下文隔离和渲染器沙箱。

Agent 仅挂载 [harness/mcp_server.py](harness/mcp_server.py) 提供的固定基金工具，通用 shell、文件修改、网络搜索、插件和多 Agent 功能均关闭。模型侧只看到不透明账户引用，真实账户号仅在业务服务内解析。工具返回统一带数据源、查询时间和错误状态。

下面的 DeepSeek Harness preset 保留为兼容入口，不是桌面应用的运行依赖。

## DeepSeek Harness 兼容入口

安装脚本已经把专属模式写入本机 DeepSeek Harness 的个人目录：

```sh
./install-harness.command
```

重启 DeepSeek Harness Desktop 后，新会话的 Agent 模式中会出现“场外基金工作台”。本机已经完成安装并在 Desktop 中验证可选。也可以双击 `start-harness.command`，使用桌面版自带的 `dsh` 运行时在 <http://127.0.0.1:8767> 启动专属 profile；该命令同时确保基金工作台服务运行。

Agent 使用 [harness/fund_tool.py](harness/fund_tool.py) 读取持仓、历史分析、订单与策略，skill 位于 [harness/skills/fund-workbench/SKILL.md](harness/skills/fund-workbench/SKILL.md)。Agent 工具负责查询和交易准备，真实申购、支付、赎回与撤单只能在可视化工作台的最终确认页提交。

专属 Agent preset 还会启动 [harness/mcp_server.py](harness/mcp_server.py)，固定注册 `mcp__fund_workbench__*` 原生工具。它们覆盖账户简报、持仓、组合分析、订单、五套投资策略、真实回测、策略版本、自选、交易待办、连接状态与扫码登录。Harness 对话本身承接 HTML 的“问 AI”功能，模型和接入方式由 Harness 顶部的模型选择器管理。

其中策略、自选和交易待办工具只修改 `.runtime/state.json`；申购、赎回、撤单和支付提交工具没有注册到 Harness，避免模型代替用户完成最终确认。可视化页面仍保留为固定入口，由 `mcp__fund_workbench__open_workbench` 或 <http://127.0.0.1:8765> 打开。

扶摇密钥从环境变量 `FUYAO_API_KEY` 或被 git 忽略且权限为 `0600` 的 `.runtime/fuyao.key` 读取。密钥不会进入 HTML、Harness preset、skill、日志或模型提示词。

## 模型配置

订阅模式优先复用本机 Codex CLI 的有效 ChatGPT 登录；也可在“接入设置”启动 OpenAI 官方登录。API 模式填写服务商的 HTTPS Base URL、模型 ID 和密钥，首版仅支持 Responses 协议。

API 与订阅的凭据、权限和额度独立。兼容性检测使用无账户数据的策略模板工具，分别验证连接、文本流、工具调用和工具结果续接。没有使用用户真实密钥完成检测的第三方服务保持“未验证”。

## 数据与交易边界

本地 `.runtime/state.json` 保存策略草稿、自选和待办，原始持仓快照不落盘；该目录已加入 gitignore。网页显示数据时没有预置的个人持仓或模拟业绩。

`server.py` 绑定 `127.0.0.1`，只提供指定的静态文件和业务接口，校验来源及本机会话令牌。不要把这个个人工作台通过公网隧道暴露。

基金接口白名单分为查询和四个明确的提交动作：协议留痕、申购、赎回和撤单。新版场外基金 Agent 不注册这些金融提交工具，只能查询真实账户、研究策略、保存本地配置和计划。五套策略均已接入确定性引擎：三套单基金策略使用复权净值，创业板策略另使用五年 PE 分位，行业轮动使用固定行业基金池和沪深300基准；数据缺失时明确返回具体缺项。组合历史曲线按当前持仓权重模拟，不包含真实历史现金流、个人费率与税费，因此不作为账户实际收益。

## 验证

```sh
.venv/bin/python -m unittest -v test_server.py
.venv/bin/python -m unittest -v test_fund_data.py
.venv/bin/python -m unittest -v test_mcp_server.py
node --check workbench.js
npm run test:desktop
```

行为测试覆盖真实响应嵌套、业务失败、隐私字段裁剪、待确认订单、游标分页、风险限制、账户与订单锁定、一次性提交、批量撤单的部分失败结果、防重复交易、费率单位、可赎回份额、策略预算冲突和 AI 数据授权。测试通过模拟 CLI 验证交易命令，不会提交真实基金订单，也不会调用收费模型。

桌面端验收记录见 [VALIDATION.md](VALIDATION.md)。

主要文件：`fund-ai-workbench.html` / `workbench.css` / `workbench.js` / `server.py`。可共享的 SDK 文档和固定版本依赖存放在 `reference/`；含个人持仓信息的本机页面快照不会纳入仓库。
