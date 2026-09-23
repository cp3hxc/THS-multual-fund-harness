"""Fuyao market-data adapter and current-weight portfolio analytics.

Account positions come from thsfund in ``server.py``.  This module only adds
public fund/profile/NAV/index data from Fuyao.  The API key stays in the
process environment or the ignored ``.runtime/fuyao.key`` file.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests


BASE_URL = "https://fuyao.aicubes.cn"
CACHE_TTL = 6 * 3600
PALETTE = ["#d97706", "#3a6ea8", "#17a673", "#9c8cd0", "#bf6b63", "#7f8f62"]


class FuyaoError(RuntimeError):
    pass


def number(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    text = str(value).replace(",", "").replace("%", "").strip()
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def _date_from_ms(value: Any) -> Optional[str]:
    try:
        return dt.datetime.fromtimestamp(float(value) / 1000).date().isoformat()
    except (TypeError, ValueError, OSError):
        return None


class FuyaoClient:
    def __init__(self, runtime: Path):
        self.runtime = runtime
        self.cache = runtime / "fuyao-cache"
        self.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._local = threading.local()

    def api_key(self) -> str:
        key = os.environ.get("FUYAO_API_KEY", "").strip()
        path = self.runtime / "fuyao.key"
        if not key and path.exists():
            key = path.read_text(encoding="utf-8").strip()
        if not key:
            raise FuyaoError("扶摇数据密钥未配置。请设置 FUYAO_API_KEY 或 .runtime/fuyao.key。")
        return key

    def session(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            # This Mac's system proxy is not usable for Fuyao.
            session.trust_env = False
            session.headers.update({"X-api-key": self.api_key(), "User-Agent": "fund-ai-workbench/0.2"})
            self._local.session = session
        return session

    def _cache_path(self, path: str, params: Dict[str, Any]) -> Path:
        raw = json.dumps([path, sorted(params.items())], ensure_ascii=False).encode()
        return self.cache / (hashlib.sha256(raw).hexdigest() + ".json")

    def get(self, path: str, params: Dict[str, Any], *, ttl: int = CACHE_TTL) -> Dict[str, Any]:
        cache_path = self._cache_path(path, params)
        if cache_path.exists() and time.time() - cache_path.stat().st_mtime < ttl:
            try:
                return json.loads(cache_path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                pass
        try:
            response = self.session().get(BASE_URL + path, params=params, timeout=(8, 30))
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            if cache_path.exists():
                try:
                    return json.loads(cache_path.read_text(encoding="utf-8"))
                except (ValueError, OSError):
                    pass
            raise FuyaoError("扶摇数据连接失败，请稍后刷新。") from exc
        if payload.get("code") not in (0, None):
            code = payload.get("code")
            if code in (2001, 2003):
                raise FuyaoError("扶摇数据密钥无效或缺少权限，请在扶摇控制台核对。")
            raise FuyaoError("扶摇数据返回错误：" + str(payload.get("message") or code))
        try:
            temp = cache_path.with_suffix(".tmp")
            temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.chmod(temp, 0o600)
            os.replace(temp, cache_path)
        except OSError:
            pass
        return payload

    @staticmethod
    def items(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
        rows = (payload.get("data") or {}).get("item") or []
        return rows if isinstance(rows, list) else []

    def fund_nav(self, code: str, range_: str = "tyear") -> List[Tuple[str, float]]:
        payload = self.get("/api/fund/performance/nav", {
            "fund_type": "otc", "thscode": code + ".OF", "range": range_, "nav_type": "adj"
        })
        out = []
        for row in self.items(payload):
            date, nav = _date_from_ms(row.get("nav_date")), number(row.get("adj_nav"))
            if date and nav is not None and nav > 0:
                out.append((date, nav))
        return sorted(dict(out).items())

    def fund_indicators(self, code: str, years: int = 5) -> List[Dict[str, Any]]:
        """Return dated indicator rows used by versioned strategy Skills.

        The response deliberately keeps only the documented fields consumed by
        the local adapters.  It does not derive a PE percentile from NAV data.
        """
        # Use a day-stable boundary so repeated signal checks share the same
        # six-hour cache key instead of creating one entry per millisecond.
        boundary = dt.datetime.combine(dt.date.today(), dt.time(23, 59, 59))
        end = int(boundary.timestamp() * 1000)
        # Fuyao caps this endpoint at exactly five 365-day years.
        start = end - int(years * 365 * 24 * 3600 * 1000)
        payload = self.get("/api/fund/performance/indicators-historical", {
            "fund_type": "otc", "thscode": code + ".OF", "start": start, "end": end
        })
        out: List[Dict[str, Any]] = []
        for row in self.items(payload):
            date = _date_from_ms(row.get("date_ms"))
            if not date:
                continue
            out.append({
                "date": date,
                "rsi_pct": number(row.get("rsi_pct")),
                "donchian_channel": number(row.get("donchian_channel")),
                "pe_ttm_5y_pct": number(row.get("track_index_pe_ttm_five_year_percentile")),
            })
        return sorted(out, key=lambda item: item["date"])

    def fund_series(self, code: str, years: int = 5) -> List[Dict[str, Any]]:
        """Join real adjusted NAV and indicator data by trading date."""
        nav = self.fund_nav(code, "fyear")
        cutoff = (dt.date.today() - dt.timedelta(days=int(years * 365.25))).isoformat()
        indicators = {row["date"]: row for row in self.fund_indicators(code, years)}
        return [
            {"date": date, "adj_nav": value, **indicators.get(date, {})}
            for date, value in nav if date >= cutoff
        ]

    def index_history(self, code: str, start: str, end: str) -> List[Tuple[str, float]]:
        def ms(value: str) -> int:
            return int(dt.datetime.strptime(value, "%Y-%m-%d").timestamp() * 1000)
        payload = self.get("/api/a-share-index/prices/historical", {
            "thscode": code, "interval": "1d", "start": ms(start), "end": ms(end)
        })
        out = []
        for row in self.items(payload):
            date, close = _date_from_ms(row.get("date_ms")), number(row.get("close_price"))
            if date and close is not None and close > 0:
                out.append((date, close))
        return sorted(dict(out).items())

    def fund_profile(self, code: str) -> Dict[str, Any]:
        payload = self.get("/api/fund/profile/detail", {"fund_type": "otc", "thscode": code + ".OF"})
        rows = self.items(payload)
        return rows[0] if rows else {}

    def benchmark(self, start: str, end: str) -> List[Tuple[str, float]]:
        return self.index_history("000300.SH", start, end)


def classify(name: str) -> Tuple[str, str]:
    text = name.upper()
    if "黄金" in text or "商品" in text:
        return "商品", "#d9a441"
    if any(x in text for x in ("QDII", "纳斯达克", "标普", "恒生", "全球")):
        return "海外权益", "#9c8cd0"
    if any(x in text for x in ("ETF联接", "指数", "中证", "沪深", "创业板", "科创")):
        return "境内指数", "#3a6ea8"
    if "股票" in text:
        return "主动股票", "#d97706"
    if "混合" in text:
        return "主动混合", "#17a673"
    return "其他基金", "#7f8f62"


def is_pending_position(fund: Dict[str, Any]) -> bool:
    """Return whether thsfund marks a positive-amount position as unconfirmed."""
    return str(fund.get("holdVol") or "").strip() == "待确认"


def _forward_value(series: List[Tuple[str, float]], date: str, cursor: int) -> Tuple[Optional[float], int]:
    while cursor + 1 < len(series) and series[cursor + 1][0] <= date:
        cursor += 1
    if cursor < len(series) and series[cursor][0] <= date:
        return series[cursor][1], cursor
    return None, cursor


def _returns(values: List[Tuple[str, float]]) -> Dict[str, float]:
    return {values[i][0]: values[i][1] / values[i - 1][1] - 1 for i in range(1, len(values))
            if values[i - 1][1] > 0}


def _corr(left: Dict[str, float], right: Dict[str, float]) -> Optional[float]:
    dates = sorted(set(left) & set(right))
    if len(dates) < 20:
        return None
    a, b = [left[d] for d in dates], [right[d] for d in dates]
    ma, mb = statistics.fmean(a), statistics.fmean(b)
    numerator = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    denominator = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return numerator / denominator if denominator else None


def _metrics(history: List[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    if len(history) < 3:
        return {"returnPct": None, "volatilityPct": None, "maxDrawdownPct": None, "sharpe": None}
    values = [x["value"] for x in history]
    daily = [values[i] / values[i - 1] - 1 for i in range(1, len(values)) if values[i - 1] > 0]
    total = (values[-1] / values[0] - 1) * 100
    volatility = statistics.stdev(daily) * math.sqrt(252) * 100 if len(daily) > 1 else None
    peak, drawdown = values[0], 0.0
    for value in values:
        peak = max(peak, value)
        drawdown = min(drawdown, value / peak - 1)
    sharpe = None
    if daily and statistics.pstdev(daily):
        sharpe = (statistics.fmean(daily) * 252 - 0.015) / (statistics.pstdev(daily) * math.sqrt(252))
    return {"returnPct": round(total, 2),
            "volatilityPct": round(volatility, 2) if volatility is not None else None,
            "maxDrawdownPct": round(drawdown * 100, 2),
            "sharpe": round(sharpe, 2) if sharpe is not None else None}


def portfolio_analysis(holdings: Iterable[Dict[str, Any]], strategies: Iterable[Dict[str, Any]], runtime: Path) -> Dict[str, Any]:
    positions = []
    for fund in holdings:
        amount = number(fund.get("totalAmount"))
        code = str(fund.get("fundCode") or "")
        if len(code) == 6 and amount is not None and amount > 0:
            positions.append({"code": code, "name": str(fund.get("fundName") or code),
                              "amount": amount, "pending": is_pending_position(fund)})
    if not positions:
        raise FuyaoError("当前没有可用于组合分析的正持仓。")

    client = FuyaoClient(runtime)
    series: Dict[str, List[Tuple[str, float]]] = {}
    profiles: Dict[str, Dict[str, Any]] = {}
    failures: List[Dict[str, str]] = []

    confirmed = [p for p in positions if not p["pending"]]
    if not confirmed:
        raise FuyaoError("当前基金资产均在待确认中，暂无已确认持仓可用于历史模拟。")

    def fetch(position: Dict[str, Any]):
        code = position["code"]
        return code, client.fund_nav(code), client.fund_profile(code)

    with ThreadPoolExecutor(max_workers=min(6, len(confirmed))) as pool:
        tasks = {pool.submit(fetch, p): p for p in confirmed}
        for future in as_completed(tasks):
            position = tasks[future]
            try:
                code, nav, profile = future.result()
                if len(nav) < 20:
                    raise FuyaoError("历史净值不足 20 个交易日")
                series[code], profiles[code] = nav, profile
            except Exception as exc:
                failures.append({"code": position["code"], "name": position["name"], "reason": str(exc)[:120]})

    usable = [p for p in confirmed if p["code"] in series]
    if not usable:
        detail = failures[0]["reason"] if failures else "未返回历史净值"
        raise FuyaoError("没有持仓取得可用历史净值：" + detail)
    total = sum(p["amount"] for p in positions)
    confirmed_total = sum(p["amount"] for p in confirmed)
    pending_total = total - confirmed_total
    usable_total = sum(p["amount"] for p in usable)
    weights = {p["code"]: p["amount"] / usable_total for p in usable}

    all_dates = sorted({date for p in usable for date, _ in series[p["code"]]})[-253:]
    cursors = {p["code"]: 0 for p in usable}
    bases: Dict[str, float] = {}
    history = []
    for date in all_dates:
        weighted, active_weight = 0.0, 0.0
        for p in usable:
            code = p["code"]
            value, cursors[code] = _forward_value(series[code], date, cursors[code])
            if value is None:
                continue
            bases.setdefault(code, value)
            weighted += weights[code] * value / bases[code]
            active_weight += weights[code]
        if active_weight > 0:
            history.append({"date": date, "value": weighted / active_weight})
    if len(history) < 20:
        raise FuyaoError("持仓净值的共同观察期不足 20 个交易日。")

    benchmark = []
    try:
        bench_raw = client.benchmark(history[0]["date"], history[-1]["date"])
        if bench_raw:
            base = bench_raw[0][1]
            benchmark = [{"date": date, "value": value / base} for date, value in bench_raw]
    except FuyaoError:
        pass

    allocations: Dict[str, Dict[str, Any]] = {}
    for p in positions:
        category, color = (("待确认资金", "#a7aaa2") if p["pending"] else classify(p["name"]))
        row = allocations.setdefault(category, {"name": category, "amount": 0.0, "color": color, "funds": 0})
        row["amount"] += p["amount"]
        row["funds"] += 1
    allocation_rows = sorted(allocations.values(), key=lambda x: x["amount"], reverse=True)
    for row in allocation_rows:
        row["amount"], row["percent"] = round(row["amount"], 2), round(row["amount"] / total * 100, 1)

    active_codes = {code for s in strategies if s.get("status") != "archived" for code in s.get("codes", [])}
    covered = sum(p["amount"] for p in positions if p["code"] in active_codes)

    top = sorted(usable, key=lambda p: p["amount"], reverse=True)[:6]
    return_maps = {p["code"]: _returns(series[p["code"]][-254:]) for p in top}
    matrix = []
    for left in top:
        row = []
        for right in top:
            value = 1.0 if left["code"] == right["code"] else _corr(return_maps[left["code"]], return_maps[right["code"]])
            row.append(round(value, 2) if value is not None else None)
        matrix.append(row)

    metrics = _metrics(history)
    benchmark_metrics = _metrics(benchmark)
    concentration = max(p["amount"] / confirmed_total for p in confirmed) * 100
    overseas = sum(p["amount"] for p in confirmed if classify(p["name"])[0] == "海外权益") / confirmed_total * 100
    findings = []
    findings.append({"tone": "warning" if concentration >= 35 else "good", "title": "单基金集中度",
                     "text": f"最大单只基金占组合 {concentration:.1f}%" + ("，可重点检查风格暴露。" if concentration >= 35 else "，当前未触及 35% 观察线。")})
    findings.append({"tone": "info", "title": "海外资产占比", "text": f"已确认持仓中 QDII/海外权益约占 {overseas:.1f}%，交易日与净值确认节奏可能不同。"})
    if pending_total > 0:
        findings.append({"tone": "warning", "title": "待确认资金",
                         "text": f"¥{pending_total:,.2f} 尚未确认份额，已从历史收益和风险模拟中排除。"})
    findings.append({"tone": "good" if covered else "warning", "title": "策略覆盖",
                     "text": f"已有策略关联 ¥{covered:,.2f}，覆盖当前持仓的 {covered / total * 100:.1f}%。"})

    # Downsample transport/UI points without changing the metrics.
    def sample(rows: List[Dict[str, Any]], limit: int = 90):
        if len(rows) <= limit:
            return rows
        step = (len(rows) - 1) / (limit - 1)
        return [rows[round(i * step)] for i in range(limit)]

    return {
        "source": "扶摇 Fuyao · 已确认持仓权重模拟", "asOf": history[-1]["date"],
        "method": "以已确认持仓金额为固定权重，使用复权净值构造最近约 252 个交易日的模拟组合；待确认资金不参与历史模拟，也不包含历史申赎现金流、个人费率与税费。",
        "totalAmount": round(total, 2), "confirmedAmount": round(confirmed_total, 2),
        "pendingAmount": round(pending_total, 2),
        "pendingFundCount": sum(1 for p in positions if p["pending"]),
        "simulationAmount": round(usable_total, 2), "coveredAmount": round(covered, 2),
        "coveragePct": round(covered / total * 100, 1),
        "dataCoveragePct": round(usable_total / confirmed_total * 100, 1),
        "metrics": metrics, "benchmarkMetrics": benchmark_metrics,
        "history": sample(history), "benchmark": sample(benchmark), "allocations": allocation_rows,
        "correlation": {"funds": [{"code": p["code"], "name": p["name"]} for p in top], "values": matrix},
        "findings": findings, "failures": failures,
        "funds": [{"code": p["code"], "name": p["name"], "amount": round(p["amount"], 2),
                   "manager": profiles.get(p["code"], {}).get("manager_name")} for p in usable],
    }
