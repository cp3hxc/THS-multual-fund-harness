---
name: fund-workbench
description: 读取和分析用户在同花顺爱基金的真实场外基金持仓、订单、本地策略，以及扶摇历史净值。用于持仓体检、组合风险、交易核对、交易准备和策略规划；最终金融交易由用户在工作台确认页提交。
---

# 场外基金个人工作台

本 skill 优先使用固定注册的 `mcp__fund_workbench__*` 工具取得账户、市场与本地计划数据。先调用与问题最接近的工具，再基于返回数据回答；不得凭记忆编造净值、收益、回测或订单状态。

Harness 固定工具覆盖 HTML 的全部主要功能：工作台入口、首页汇总、持仓、组合分析、钱包、交易账户、申购与赎回预览、订单及详情、五套投资策略、真实回测、策略配置版本、自选基金、交易待办、连接状态与基金扫码登录。`create_strategy`、`archive_strategy`、`save_strategy_variant`、`set_watchlist`、`save_trade_draft` 和 `remove_trade_draft` 只修改本地计划文件。

用户询问策略选择、修改或回测时：

1. 先调用 `list_investment_strategies` 读取当前 Skill 版本、规则、支持参数和数据要求。
2. 修改只能落在返回的参数范围内，通过 `save_strategy_variant` 保存可追溯版本；不能自由生成策略代码或改变策略算法含义。
3. 历史结果必须调用 `run_investment_backtest`，由确定性程序计算。专用数据缺失时原样说明缺项，不得用其他行情替代或补造业绩。
4. 清楚区分原始 Skill 版本、个人配置版本、回测结果和跟踪计划。

询问账户概览、最新表现、昨日表现或日收益时，优先调用 `get_account_brief`。它会一次返回基金资产、估算日收益率、涨跌分布、主要贡献与拖累、待确认资金和批量净值日期；不要为了补日期逐只重复调用 `get_fund_accounts`。只有用户明确询问某只基金的交易账户或可用份额时，才调用 `get_fund_accounts`。

只有在 MCP 工具暂不可用并需要诊断时，才使用以下命令行回退。先运行 `npm run setup`；macOS 使用 `.venv/bin/python`，Windows PowerShell 使用 `.venv\Scripts\python.exe`：

macOS：
```bash
./.venv/bin/python harness/fund_tool.py holdings
./.venv/bin/python harness/fund_tool.py analysis
./.venv/bin/python harness/fund_tool.py orders --days 30
./.venv/bin/python harness/fund_tool.py strategies
```

Windows PowerShell：
```powershell
.venv\Scripts\python.exe harness/fund_tool.py holdings
.venv\Scripts\python.exe harness/fund_tool.py analysis
.venv\Scripts\python.exe harness/fund_tool.py orders --days 30
.venv\Scripts\python.exe harness/fund_tool.py strategies
```

数据口径：

- 持仓、钱包、订单、买入和赎回规则来自 thsfund / 同花顺爱基金。
- 历史复权净值、基金资料和沪深300来自扶摇。
- `analysis` 的组合曲线是“以当前持仓金额为固定权重”的历史模拟，不是账户真实收益；必须同时说明其现金流、费率和税费限制。
- 本地策略实例表示研究规则、参数和预算，不表示策略已经执行，也不能把持仓收益归因给策略。

交易边界：

- MCP 不调用申购、赎回、撤单或支付提交接口。
- 用户提出申购或赎回时，可以查询真实规则、列检查清单和解释影响，并引导其在工作台「我的持仓」中选择基金；实际提交必须由用户在最终确认页本人核对并点击，然后到「订单中心」核对确认结果。
- 不读取、输出或要求用户粘贴 `.runtime/fuyao.key`、Harness 凭据、API Key、账户号或完整银行卡号。

回答时优先给出：数据截至时间、来源、结论、依据、未覆盖的数据和下一步可执行动作。收益与风险判断应使用条件句，避免收益承诺。
