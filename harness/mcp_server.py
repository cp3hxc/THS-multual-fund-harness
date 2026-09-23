#!/usr/bin/env python3
"""Native MCP tool surface for the Codex/DeepSeek Harness fund workbench.

The protocol is JSON-RPC over newline-delimited stdio.  stdout is reserved for
MCP messages; diagnostics go to stderr. The MCP surface exposes account reads,
transaction preparation, and local records; final financial submission stays
in the workbench's user-confirmed UI.
"""
from __future__ import annotations

import datetime as dt
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import threading
import urllib.request
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fund_data import FuyaoError, portfolio_analysis  # noqa: E402
from workbench_runtime import ROOT as WORKBENCH_ROOT, venv_python  # noqa: E402

ROOT = WORKBENCH_ROOT

WEB_URL = "http://127.0.0.1:8765"
WEB_PROCESS = None
AUTH_LOCK = threading.Lock()
AUTH_JOB = {"running": False, "success": False, "mode": "login", "message": "未发起登录"}


def obj(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}


STRING = {"type": "string"}
CODE = {"type": "string", "pattern": "^[0-9]{6}$", "description": "6 位场外基金代码"}
ID = {"type": "string", "minLength": 1, "maxLength": 100}
AMOUNT = {"oneOf": [{"type": "number", "exclusiveMinimum": 0}, {"type": "string", "pattern": "^[0-9]+(?:\\.[0-9]{1,2})?$"}]}


TOOLS = [
    {"name": "open_workbench", "description": "启动并返回固定的基金 HTML 工作台入口。适合用户要求打开、查看或操作可视化工作台时使用。", "inputSchema": obj()},
    {"name": "get_dashboard", "description": "读取 HTML 首页需要的账户、策略、自选、交易待办和连接状态汇总。", "inputSchema": obj()},
    {"name": "get_account_brief", "description": "账户日常概览的首选工具。一次读取真实基金资产、最新日收益率、涨跌分布、主要贡献与拖累、待确认资金、钱包及各基金净值/收益日期；无需再逐只查询账户明细。", "inputSchema": obj()},
    {"name": "list_holdings", "description": "读取同花顺爱基金真实持仓、钱包和收益快照。", "inputSchema": obj()},
    {"name": "analyze_portfolio", "description": "使用扶摇复权净值和沪深300，对当前真实持仓做固定权重历史模拟、风险、配置与相关性分析。", "inputSchema": obj()},
    {"name": "get_fund_accounts", "description": "读取指定持仓基金的脱敏交易账户、可用份额和净值日期。", "inputSchema": obj({"code": CODE}, ["code"])},
    {"name": "get_buy_preview", "description": "查询指定基金的真实申购准备信息：风险等级、起购金额、限额、费率和确认日；不提交申购。", "inputSchema": obj({"code": CODE}, ["code"])},
    {"name": "get_redeem_preview", "description": "查询指定基金和不透明账户引用的真实可赎回份额、阶梯费率与到账时间；不提交赎回。", "inputSchema": obj({"code": CODE, "accountRef": ID}, ["code", "accountRef"])},
    {"name": "list_orders", "description": "读取真实基金订单，支持日期、处理中/历史、业务类型和游标分页。", "inputSchema": obj({
        "days": {"type": "integer", "minimum": 1, "maximum": 365, "default": 30},
        "startDate": {"type": "string", "pattern": "^[0-9]{8}$", "description": "可选，YYYYMMDD；提供后覆盖 days"},
        "endDate": {"type": "string", "pattern": "^[0-9]{8}$", "description": "可选，YYYYMMDD"},
        "processing": {"type": "boolean", "default": False},
        "kind": {"type": "string", "enum": ["all", "buy", "sell", "aip", "change", "dividend", "other"], "default": "all"},
        "page": {"type": "integer", "minimum": 1, "maximum": 100, "default": 1},
        "lastAcceptTime": {"type": "string", "maxLength": 40},
        "lastOrderId": ID
    })},
    {"name": "get_order", "description": "读取一笔真实基金订单的确认、份额、到账与失败原因详情。", "inputSchema": obj({"id": ID}, ["id"])},
    {"name": "list_strategy_templates", "description": "读取策略中心全部固定模板、默认单次投入、触发节奏、阈值和适用范围。", "inputSchema": obj()},
    {"name": "list_investment_strategies", "description": "读取五套场外基金投资策略的真实版本、规则、参数范围、数据口径以及本地保存的编辑版本。", "inputSchema": obj()},
    {"name": "run_investment_backtest", "description": "用确定性程序和真实历史数据运行一套场外基金策略回测，并返回指标、曲线、买卖位置、数据日期和缺失项。", "inputSchema": obj({
        "strategyId": {"type": "string", "enum": [x["id"] for x in server.strategy_invest_catalog()]},
        "code": CODE,
        "params": {"type": "object", "additionalProperties": {"oneOf": [{"type": "number"}, {"type": "string"}]}}
    }, ["strategyId", "code"])},
    {"name": "save_strategy_variant", "description": "保存或更新一份可追溯的策略配置版本；只能修改该策略声明支持的参数，不会生成任意代码或提交交易。", "inputSchema": obj({
        "id": ID, "strategyId": {"type": "string", "enum": [x["id"] for x in server.strategy_invest_catalog()]},
        "name": {"type": "string", "minLength": 1, "maxLength": 80},
        "description": {"type": "string", "maxLength": 500}, "code": CODE,
        "params": {"type": "object", "additionalProperties": {"oneOf": [{"type": "number"}, {"type": "string"}]}}
    }, ["strategyId", "name", "params"])},
    {"name": "list_strategies", "description": "读取“我的策略”全部实例，可筛选当前或已归档。", "inputSchema": obj({"status": {"type": "string", "enum": ["all", "current", "archived"], "default": "all"}})},
    {"name": "create_strategy", "description": "创建一份本地策略草稿，保存基金、月预算、单次投入和模板参数；不会产生交易或信号。", "inputSchema": obj({
        "templateId": {"type": "string", "enum": [x["id"] for x in server.TEMPLATES]},
        "name": {"type": "string", "minLength": 1, "maxLength": 60},
        "codes": {"type": "array", "items": CODE, "minItems": 1, "maxItems": 10},
        "budget": AMOUNT, "amount": AMOUNT,
        "params": {"type": "object", "additionalProperties": {"type": "number"}},
        "eligibilityConfirmed": {"type": "boolean", "description": "用户是否已确认基金符合模板适用范围"}
    }, ["templateId", "name", "codes", "budget", "amount", "params", "eligibilityConfirmed"])},
    {"name": "archive_strategy", "description": "归档一份本地策略实例，保留参数记录并解除当前关联。", "inputSchema": obj({"id": ID}, ["id"])},
    {"name": "list_watchlist", "description": "读取 HTML 自选基金清单，并标记哪些已有真实持仓或策略关联。", "inputSchema": obj()},
    {"name": "set_watchlist", "description": "添加或移除一只本地自选基金，不会产生持仓或交易。", "inputSchema": obj({"code": CODE, "name": {"type": "string", "maxLength": 80}, "remove": {"type": "boolean", "default": False}}, ["code"])},
    {"name": "list_trade_drafts", "description": "读取全部本地买入/赎回待办。待办只记录意图，不代表已提交或成交。", "inputSchema": obj()},
    {"name": "save_trade_draft", "description": "保存一条本地买入金额或赎回份额待办；不会向基金平台提交交易。", "inputSchema": obj({
        "kind": {"type": "string", "enum": ["buy", "redeem"]}, "code": CODE,
        "name": {"type": "string", "maxLength": 80}, "value": AMOUNT
    }, ["kind", "code", "value"])},
    {"name": "remove_trade_draft", "description": "移除一条本地交易待办。", "inputSchema": obj({"id": ID}, ["id"])},
    {"name": "get_connection_status", "description": "检查 thsfund 授权、扶摇数据密钥和 HTML 中的订阅/API 模型接入状态，不返回任何密钥。", "inputSchema": obj()},
    {"name": "start_fund_login", "description": "发起同花顺爱基金扫码授权；会打开官方授权页，需要用户本人扫码确认。force=true 会强制重新授权并切换账户，仅在用户明确要求切换账户时使用。", "inputSchema": obj({"force": {"type": "boolean", "default": False}})},
    {"name": "get_fund_login_status", "description": "读取本 MCP 进程最近一次同花顺扫码授权任务状态。", "inputSchema": obj()},
]


def ensure_web() -> Dict[str, Any]:
    global WEB_PROCESS
    try:
        with urllib.request.urlopen(WEB_URL + "/api/bootstrap", timeout=2) as response:
            if response.status == 200:
                return {"url": WEB_URL, "running": True, "started": False}
    except Exception:
        pass
    log_dir = server.RUNTIME
    log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    log = open(log_dir / "workbench.log", "a", encoding="utf-8")
    if getattr(sys, "frozen", False):
        server_exe = Path(os.environ.get("FUND_WORKBENCH_SERVER", ""))
        if not server_exe.is_file():
            raise server.AppError("未找到桌面版基金服务，请重新安装应用。", 503)
        command = [str(server_exe)]
    else:
        command = [str(venv_python(ROOT)), str(ROOT / "server.py")]
    process_options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    WEB_PROCESS = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=log, **process_options)
    for _ in range(20):
        try:
            with urllib.request.urlopen(WEB_URL + "/api/bootstrap", timeout=.5) as response:
                if response.status == 200:
                    return {"url": WEB_URL, "running": True, "started": True}
        except Exception:
            threading.Event().wait(.15)
    raise server.AppError("HTML 工作台服务启动失败，请查看 .runtime/workbench.log。", 503)


def account_ref(account_id: str) -> str:
    """Return a stable opaque reference without exposing the platform account id."""
    key_path = server.RUNTIME / "account-ref.key"
    server.RUNTIME.mkdir(mode=0o700, exist_ok=True)
    if not key_path.exists():
        try:
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(os.urandom(32))
        except FileExistsError:
            pass
    digest = hmac.new(key_path.read_bytes(), account_id.encode(), hashlib.sha256).digest()[:12]
    return "acct_" + base64.urlsafe_b64encode(digest).decode().rstrip("=")


def public_accounts(details: Dict[str, Any]) -> Dict[str, Any]:
    clean = dict(details)
    clean["accounts"] = [
        {**{k: v for k, v in row.items() if k != "id"}, "ref": account_ref(str(row["id"]))}
        for row in details.get("accounts", [])
    ]
    return clean


def resolve_account(code: str, opaque_ref: str) -> str:
    details = server.holding_details(code)
    for row in details.get("accounts", []):
        raw = str(row.get("id") or "")
        if raw and hmac.compare_digest(account_ref(raw), str(opaque_ref or "")):
            return raw
    raise server.AppError("交易账户引用已失效，请重新读取基金账户。", 404)


def valid_date(value: Any, label: str) -> str:
    text = str(value or "")
    try:
        parsed = dt.datetime.strptime(text, "%Y%m%d").date()
    except ValueError:
        raise server.AppError(label + "须为 YYYYMMDD 格式。")
    return parsed.strftime("%Y%m%d")


def connection_status() -> Dict[str, Any]:
    fuyao_key = bool(os.environ.get("FUYAO_API_KEY", "").strip() or (server.RUNTIME / "fuyao.key").exists())
    try:
        account = server.overview()
        fund = {"connected": True, "message": f"已连接，读取到 {len(account['funds'])} 只持仓"}
    except server.AppError as exc:
        fund = {"connected": False, "message": str(exc)}
    return {"fund": fund, "fuyao": {"configured": fuyao_key}, "webAI": server.ai_status(), "workbench": ensure_web()}


def start_login(force: bool = False) -> Dict[str, Any]:
    with AUTH_LOCK:
        if AUTH_JOB["running"]:
            return dict(AUTH_JOB)
        AUTH_JOB.update(running=True, success=False, mode="switch" if force else "login",
                        message="官方授权页已打开，请使用同花顺 App 扫码并确认。")

    def run():
        try:
            command = [str(server.CLI), "auth", "login"]
            if force:
                command.append("--force")
            with server.FINANCE_LOCK:
                process = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=320)
            payload = json.loads(process.stdout or "{}")
            success = bool(payload.get("ok"))
            message = ("账户切换成功，可以读取新账户。" if force else "授权成功，可以读取真实持仓。") if success else "授权未完成，请重新发起扫码。"
        except Exception:
            success = False
            message = "扫码超时或连接失败，请重新发起登录。"
        with AUTH_LOCK:
            AUTH_JOB.update(running=False, success=success, message=message)

    threading.Thread(target=run, daemon=True).start()
    return dict(AUTH_JOB)


def _decimal(value):
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def account_brief() -> Dict[str, Any]:
    account = server.overview()
    confirmed = [row for row in account["funds"] if row.get("holdVol") != "待确认"]
    codes = [str(row.get("fundCode") or "") for row in confirmed if row.get("fundCode")]
    date_result = server.holding_dates(codes) if codes else {"dates": {}, "failedCategories": [], "fetchedAt": account["fetchedAt"]}

    confirmed_amount = _decimal(account["summary"].get("confirmedAmount"))
    if confirmed_amount is None:
        amounts = [_decimal(row.get("totalAmount")) for row in confirmed]
        confirmed_amount = sum((value for value in amounts if value is not None), Decimal("0"))
    known_daily = [(row, _decimal(row.get("newestIncome"))) for row in confirmed]
    known_daily = [(row, value) for row, value in known_daily if value is not None]
    latest_income = sum((value for _, value in known_daily), Decimal("0")) if known_daily else None
    opening_amount = confirmed_amount - latest_income if latest_income is not None else None
    latest_rate = latest_income / opening_amount * Decimal("100") if opening_amount and opening_amount > 0 else None

    def compact(row, daily):
        code = str(row.get("fundCode") or "")
        date_rows = date_result["dates"].get(code) or []
        newest_date = max(date_rows, key=lambda item: str(item.get("navDate") or ""), default={})
        contribution = daily / opening_amount * Decimal("100") if daily is not None and opening_amount and opening_amount > 0 else None
        return {
            "code": code,
            "name": row.get("fundName"),
            "amount": row.get("totalAmount"),
            "holdingIncome": row.get("holdIncome"),
            "holdingIncomeRate": row.get("holdIncomeRate"),
            "latestIncome": row.get("newestIncome"),
            "contributionPercentagePoints": f"{contribution:.4f}" if contribution is not None else None,
            "navDate": newest_date.get("navDate"),
            "incomeDate": newest_date.get("incomeDate"),
            "navValue": newest_date.get("navValue"),
        }

    funds = [compact(row, _decimal(row.get("newestIncome"))) for row in confirmed]
    positives = sorted((row for row in funds if (_decimal(row["latestIncome"]) or 0) > 0),
                       key=lambda row: _decimal(row["latestIncome"]), reverse=True)
    negatives = sorted((row for row in funds if (_decimal(row["latestIncome"]) or 0) < 0),
                       key=lambda row: _decimal(row["latestIncome"]))
    pending = [row for row in account["funds"] if row.get("holdVol") == "待确认"]
    flat_count = sum(1 for row in funds if _decimal(row["latestIncome"]) == 0)
    missing_count = sum(1 for row in funds if _decimal(row["latestIncome"]) is None)
    limitations = ["最新日收益来自各基金最近一次更新，基金之间的净值日期可能不同。",
                   "最新日收益率按最新日收益金额 ÷ 日初已确认基金资产估算，不含待确认资金和钱包。"]
    if date_result["failedCategories"]:
        limitations.append("部分持仓类别的日期查询失败，日期信息可能不完整。")
    if missing_count:
        limitations.append(f"{missing_count} 只已确认持仓缺少最新日收益，汇总收益率仅覆盖有返回值的持仓。")
    return {
        "source": "同花顺爱基金 · thsfund",
        "fetchedAt": account["fetchedAt"],
        "account": account["summary"],
        "wallet": account["wallet"],
        "latestPerformance": {
            "income": f"{latest_income:.4f}" if latest_income is not None else None,
            "estimatedRatePct": f"{latest_rate:.4f}" if latest_rate is not None else None,
            "upCount": len(positives),
            "downCount": len(negatives),
            "flatCount": flat_count,
            "missingCount": missing_count,
            "topPositive": positives[0] if positives else None,
            "topNegative": negatives[0] if negatives else None,
        },
        "pending": {"count": len(pending), "amount": account["summary"].get("pendingAmount")},
        "funds": funds,
        "dateQuery": {"fetchedAt": date_result["fetchedAt"], "failedCategories": date_result["failedCategories"]},
        "dataLimitations": limitations,
    }


def call(name: str, args: Dict[str, Any]):
    state = None
    if name == "open_workbench":
        if os.environ.get("FUND_WORKBENCH_DESKTOP") == "1":
            return {"desktopAction": {"type": "navigate", "route": "holdings"}, "running": True}
        return ensure_web()
    if name == "get_dashboard":
        account, state = server.overview(), server.state_read()
        return {"account": account["summary"], "wallet": account["wallet"],
                "counts": {"holdings": len(account["funds"]), "strategies": len([x for x in state["strategies"] if x["status"] != "archived"]),
                           "watchlist": len(state["watchlist"]), "tradeDrafts": len(state["drafts"])},
                "connections": connection_status(), "entry": WEB_URL}
    if name == "get_account_brief":
        return account_brief()
    if name == "list_holdings":
        return server.overview()
    if name == "analyze_portfolio":
        account, state = server.overview(), server.state_read()
        return portfolio_analysis(account["funds"], state["strategies"], server.RUNTIME)
    if name == "get_fund_accounts":
        return public_accounts(server.holding_details(server.require_code(args.get("code"))))
    if name == "get_buy_preview":
        return server.buy_preview(server.require_code(args.get("code")))
    if name == "get_redeem_preview":
        code = server.require_code(args.get("code"))
        return server.redeem_preview(code, resolve_account(code, args.get("accountRef")))
    if name == "list_orders":
        days = int(args.get("days", 30)); today = dt.date.today()
        start = valid_date(args["startDate"], "开始日期") if args.get("startDate") else (today - dt.timedelta(days=days)).strftime("%Y%m%d")
        end = valid_date(args["endDate"], "结束日期") if args.get("endDate") else today.strftime("%Y%m%d")
        if start > end:
            raise server.AppError("开始日期不能晚于结束日期。")
        page = int(args.get("page", 1))
        query = {"start": start, "end": end, "kind": args.get("kind", "all"),
                 "processing": str(bool(args.get("processing", False))).lower(), "page": str(page)}
        if page > 1:
            if not args.get("lastAcceptTime") or not args.get("lastOrderId"):
                raise server.AppError("后续页需要上一页返回的 lastAcceptTime 和 lastOrderId。")
            query.update(lastTime=str(args["lastAcceptTime"]), lastId=str(args["lastOrderId"]))
        return server.orders(query)
    if name == "get_order":
        return server.order_view(server.cli_run(["trade", "detail", "--order-id", server.require_id(args.get("id"))]))
    if name == "list_strategy_templates":
        return server.TEMPLATES
    if name == "list_investment_strategies":
        return {"catalog": server.strategy_invest_catalog(), "variants": server.strategy_variants()}
    if name == "run_investment_backtest":
        return server.strategy_backtest({"strategyId": args.get("strategyId"), "code": args.get("code"),
                                         "params": args.get("params") or {}})
    if name == "save_strategy_variant":
        return server.strategy_variant_save(args)
    if name == "list_strategies":
        rows = server.state_read()["strategies"]; status = args.get("status", "all")
        if status == "current": rows = [x for x in rows if x["status"] != "archived"]
        if status == "archived": rows = [x for x in rows if x["status"] == "archived"]
        return rows
    if name == "create_strategy":
        body = dict(args); body["codes"] = ",".join(args.get("codes", []))
        return server.save_strategy(body)
    if name == "archive_strategy":
        return server.archive_strategy(args.get("id"))
    if name == "list_watchlist":
        state, account = server.state_read(), server.overview()
        funds = {x["fundCode"]: x for x in account["funds"]}
        strategies = {c: s["name"] for s in state["strategies"] if s["status"] != "archived" for c in s["codes"]}
        return [{**x, "holding": funds.get(x["code"]), "strategy": strategies.get(x["code"])} for x in state["watchlist"]]
    if name == "set_watchlist":
        return server.update_watchlist(args.get("code"), args.get("name"), args.get("remove") is True)
    if name == "list_trade_drafts":
        return server.state_read()["drafts"]
    if name == "save_trade_draft":
        return server.save_draft(args.get("kind"), args.get("code"), args.get("name"), args.get("value"))
    if name == "remove_trade_draft":
        return server.remove_draft(args.get("id"))
    if name == "get_connection_status":
        return connection_status()
    if name == "start_fund_login":
        return start_login(args.get("force") is True)
    if name == "get_fund_login_status":
        with AUTH_LOCK: return dict(AUTH_JOB)
    raise server.AppError("未知基金工具。", 404)


def reply(rpc_id, result=None, error=None):
    message = {"jsonrpc": "2.0", "id": rpc_id}
    if error is not None:
        message["error"] = error
    else:
        message["result"] = result
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def result_meta(name: str, data: Any) -> Dict[str, Any]:
    if name in {"get_account_brief", "list_holdings", "get_fund_accounts", "get_buy_preview", "get_redeem_preview", "list_orders", "get_order"}:
        source = "thsfund"
    elif name == "analyze_portfolio":
        source = "thsfund+fuyao"
    elif name == "run_investment_backtest":
        source = "fuyao"
    else:
        source = "local"
    fetched = data.get("fetchedAt") if isinstance(data, dict) else None
    return {"status": "ok", "source": source, "fetchedAt": fetched or server.now()}


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            rpc_id, method = request.get("id"), request.get("method")
            if method == "initialize":
                params = request.get("params") or {}
                reply(rpc_id, {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                               "capabilities": {"tools": {"listChanged": False}},
                               "serverInfo": {"name": "fund-workbench", "version": "1.0.0"}})
            elif method == "tools/list":
                reply(rpc_id, {"tools": TOOLS})
            elif method == "tools/call":
                params = request.get("params") or {}
                try:
                    data = call(str(params.get("name") or ""), params.get("arguments") or {})
                    payload = {"result": data, "meta": result_meta(str(params.get("name") or ""), data)}
                    content = [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}]
                    if params.get("name") == "open_workbench":
                        content.append({"type": "resource_link", "uri": WEB_URL, "name": "基金 AI 工作台", "mimeType": "text/html"})
                    reply(rpc_id, {"content": content, "structuredContent": payload, "isError": False})
                except (server.AppError, FuyaoError, ValueError, TypeError) as exc:
                    reply(rpc_id, {"content": [{"type": "text", "text": "Error: " + str(exc)}], "isError": True})
            elif method == "ping":
                reply(rpc_id, {})
            elif method in ("shutdown",):
                reply(rpc_id, None)
            elif rpc_id is not None:
                reply(rpc_id, error={"code": -32601, "message": "Method not found"})
        except Exception as exc:
            print("fund MCP error: " + str(exc), file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
