#!/usr/bin/env python3
"""Read-only command surface for the DeepSeek Harness fund agent."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fund_data import FuyaoError, portfolio_analysis  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="个人场外基金工作台只读工具")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("holdings", help="读取真实持仓和钱包汇总")
    sub.add_parser("analysis", help="用扶摇历史净值分析当前组合")
    orders = sub.add_parser("orders", help="读取最近真实订单")
    orders.add_argument("--days", type=int, default=30, choices=range(1, 366), metavar="1..365")
    sub.add_parser("strategies", help="读取本地策略实例和模板")
    args = parser.parse_args()
    try:
        if args.command == "holdings":
            data = server.overview()
        elif args.command == "analysis":
            account = server.overview()
            data = portfolio_analysis(account["funds"], server.state_read()["strategies"], server.RUNTIME)
        elif args.command == "orders":
            today = dt.date.today()
            start = today - dt.timedelta(days=args.days)
            data = server.orders({"start": start.strftime("%Y%m%d"), "end": today.strftime("%Y%m%d"),
                                  "kind": "all", "processing": "false", "page": "1"})
        else:
            data = {"templates": server.TEMPLATES, "instances": server.state_read()["strategies"]}
        print(json.dumps({"ok": True, "data": data}, ensure_ascii=False, indent=2))
        return 0
    except (server.AppError, FuyaoError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
