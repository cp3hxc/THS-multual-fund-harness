# 同花顺理财：场外基金策略 Agent

> **协作与隐私提示**：本仓库包含可共享的项目代码和运行依赖，不包含任何人的扶摇密钥、同花顺授权、模型 API Key、账户资料或个人持仓快照。每位使用者必须在自己的电脑上配置扶摇密钥，并在应用内独立完成同花顺扫码授权；请勿把这些个人信息提交到 GitHub、Issue、PR 或聊天记录中。

本仓库只保留当前深色版场外基金策略 Agent。浏览器根入口、桌面应用和安装包都会打开同一套策略工作台；旧版白色工作台与演示页面已从当前版本移除。

## Windows 和 macOS 首次配置

仓库提供 Windows 与 macOS 共用的 Node 启动器、独立 Python 虚拟环境和双系统 CI。运行源码需要 Python 3.10+、Node.js 22.12+；桌面 Agent 还需要本人安装并登录 Codex CLI。源码版首次启动会在项目目录创建 `.venv`，并安装仓库中的固定版本同花顺 SDK。开发环境需联网安装 Python SDK 依赖和 npm 包。

1. 克隆仓库后，在项目目录运行 `npm run setup`。桌面版先运行 `npm ci`。
2. 浏览器预览运行 `npm run start:web`；桌面 Agent 运行 `npm start`。也可以用 macOS 的 `start.command` / `start-panda-strategy.command`，或 Windows PowerShell 的 `start.ps1` / `start-panda-strategy.ps1`。
3. 在“接入设置”中按页面提示完成同花顺扫码授权。授权和模型设置保存在当前操作系统用户的本机目录，不要复制到仓库。
4. 源码版需要真实复权净值数据时，可在项目目录创建 `.runtime/fuyao.key`，也可使用环境变量 `FUYAO_API_KEY`。安装包版请使用环境变量配置扶摇 Key。不要把密钥写进源码、`.env`、截图、Issue 或 PR。

每位同事使用自己的模型登录、扶摇 Key 和同花顺授权。安装包把工作台数据放在当前操作系统的应用数据目录；源码版数据放在项目 `.runtime/`，权限沿用项目目录。不要共享 `.runtime/`、`.venv/` 或模型登录态。

仓库根目录的 `.gitignore` 会排除 `.runtime/`、虚拟环境、依赖构建产物、常见密钥/授权文件，以及本机历史持仓页面快照。提交前仍需检查 `git status`，不要使用 `git add -f` 强制加入个人数据。

协作时要求所有贡献者遵守 [CONTRIBUTING.md](CONTRIBUTING.md) 的隐私检查。扶摇密钥、模型凭据、同花顺授权和本机账户数据必须留在本机。

## 桌面应用

可以从源码在本机分别构建 Windows 和 macOS 安装包。构建必须使用目标系统本机和 Python 3.10+；先运行 `npm ci`，然后：

```sh
npm run build:desktop
```

构建结果位于 `dist/`：Mac 生成与当前构建机架构一致的 DMG，Windows x64 生成 NSIS 安装程序。两个系统的安装包都包含基金服务和同花顺 SDK 命令行，不再依赖项目源码或系统 Python。使用真实模型对话仍需本人安装并登录 Codex CLI；首次使用时，各自配置扶摇密钥和同花顺扫码授权。

也可以用 `npm run build:mac` 或 `npm run build:win` 指定本机目标；构建必须在对应系统本机执行。GitHub Actions 会分别构建并保存两种安装包作为工作流产物，不会自动发布公开 Release。

桌面应用会自动启动基金服务和 Codex App Server，退出时只清理由它启动的子进程。它使用专属的 Codex 数据目录和会话索引，不会把其他 Codex 任务混入工作台。

## 浏览器模式

在项目目录运行：

```sh
npm run start:web
```

浏览器访问 <http://127.0.0.1:8765> 即进入当前深色策略 Agent。真实接口需要本地 Python 服务，不能仅双击 HTML 获取账户数据。保持启动服务的终端运行；停止时按 Ctrl+C。

## 场外基金策略 Agent

工作台采用 PandaAI 的深色导航、持续对话、策略编辑双栏、运行阶段和回测历史交互。桌面依赖安装后，在项目目录运行：

```sh
npm start
```

命令会启动 Electron 桌面版并直接进入场外基金 Agent。它使用真实 Codex 会话、模型与推理强度选择、历史会话恢复、置顶/重命名/归档、工具进度和中断；浏览器预览同样使用该页面。策略参数调整只作用于 Skill 支持的范围，保存计划前仍需确认标的和资金安排。

源码运行时会建立项目虚拟环境并使用仓库中的 `aijijin-sdk 0.2.3`。已存在且有效的同花顺授权可直接复用；需要登录时，在“接入设置”点“扫码登录”，由 SDK CLI 打开授权页面。

端口占用时可指定其他端口：

```sh
npm run start:web -- --port 8766
```

## 已实现

- 真实持仓、钱包、账户、净值日期、收益日期和可用份额查询。
- 真实订单、处理中/历史筛选、日期过滤、游标分页及订单详情。
- 策略模板、个人策略草稿、参数预算校验、同基金冲突检查、版本快照与归档。
- 独立自选清单。
- 内嵌 Codex Harness Agent：持续会话、历史恢复、工具进度、可读推理摘要、澄清问题、中断和 Markdown 结果卡片。
- 场外基金策略 Agent：左侧历史会话与置顶、策略/持仓/自选/计划分类首页、受控策略定义编辑、参数版本、异步回测阶段、耗时与日志。
- Agent 可调用五策略目录、真实历史回测和策略版本保存工具；网页和 Agent 共用同一确定性策略引擎。
- 策略 Agent 展示同花顺真实持仓，并用扶摇复权净值生成当前权重归因、风险曲线和单基金下钻。
- 订阅模式从 Codex 实时读取可用模型与对应推理强度；选择用于之后新建的会话，已有会话继续使用创建时固定的模型。
- 账户日常问题使用聚合简报工具，一次返回最新收益率、涨跌分布、贡献/拖累、待确认资金和批量净值日期，减少重复工具调用。
- ChatGPT / Codex 订阅、OpenAI API Key 及 Responses 兼容第三方 API；每个会话固定模型服务。
- 账户数据授权按会话和服务商记录；未授权时仅开放非账户工具。
- API Key 使用 Electron `safeStorage` 交给当前操作系统的安全存储加密，不进入前端存储、对话或日志。
- 扶摇真实复权净值与沪深300基准：当前权重组合曲线、年化波动、最大回撤、夏普比率、资产配置和相关性矩阵。
- Codex 与页面共用统一业务服务，策略、自选和待办使用跨进程文件锁防止覆盖。

## Codex Harness Agent

Electron 主进程通过 stdio 连接 Codex App Server，对接 `thread/start`、`thread/resume`、`thread/read`、`turn/start` 和 `turn/interrupt`。渲染进程只能通过 [desktop/preload.js](desktop/preload.js) 的受限 IPC 调用它，并启用上下文隔离和渲染器沙箱。

Agent 仅挂载 [harness/mcp_server.py](harness/mcp_server.py) 提供的固定基金工具，通用 shell、文件修改、网络搜索、插件和多 Agent 功能均关闭。模型侧只看到不透明账户引用，真实账户号仅在业务服务内解析。工具返回统一带数据源、查询时间和错误状态。

## 模型配置

订阅模式优先复用本机 Codex CLI 的有效 ChatGPT 登录；也可在“接入设置”启动 OpenAI 官方登录。API 模式填写服务商的 HTTPS Base URL、模型 ID 和密钥，首版仅支持 Responses 协议。

API 与订阅的凭据、权限和额度独立。兼容性检测使用无账户数据的策略模板工具，分别验证连接、文本流、工具调用和工具结果续接。没有使用用户真实密钥完成检测的第三方服务保持“未验证”。

## 数据与交易边界

本地 `.runtime/state.json` 保存策略草稿、自选和待办，原始持仓快照不落盘；该目录已加入 gitignore。网页显示数据时没有预置的个人持仓或模拟业绩。

`server.py` 绑定 `127.0.0.1`，只提供指定的静态文件和业务接口，校验来源及本机会话令牌。不要把这个个人工作台通过公网隧道暴露。

基金接口白名单分为查询和四个明确的提交动作：协议留痕、申购、赎回和撤单。新版场外基金 Agent 不注册这些金融提交工具，只能查询真实账户、研究策略、保存本地配置和计划。五套策略均已接入确定性引擎：三套单基金策略使用复权净值，创业板策略另使用五年 PE 分位，行业轮动使用固定行业基金池和沪深300基准；数据缺失时明确返回具体缺项。组合历史曲线按当前持仓权重模拟，不包含真实历史现金流、个人费率与税费，因此不作为账户实际收益。

## 验证

```sh
npm run test:python
node --check panda-strategy-agent.js
npm run test:desktop
```

GitHub Actions 会在 macOS 和 Windows 上执行上述 Python、Electron 运行时和 JavaScript 检查。

行为测试覆盖真实响应嵌套、业务失败、隐私字段裁剪、待确认订单、游标分页、风险限制、账户与订单锁定、一次性提交、批量撤单的部分失败结果、防重复交易、费率单位、可赎回份额、策略预算冲突和 AI 数据授权。测试通过模拟 CLI 验证交易命令，不会提交真实基金订单，也不会调用收费模型。

桌面端验收记录见 [VALIDATION.md](VALIDATION.md)。

主要界面文件：`panda-strategy-agent.html` / `panda-strategy-agent.css` / `panda-strategy-agent.js`；本地服务和业务计算分别位于 `server.py`、`workbench_runtime.py`、`fund_data.py` 与 `strategy_engine.py`。`reference/` 只保存可共享的 SDK 文档和固定版本依赖；个人凭据和账户资料不会纳入仓库。
