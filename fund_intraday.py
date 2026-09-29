#!/usr/bin/env python3
"""Query public fund disclosures and market quotes, then render intraday performance."""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)
FUND_LIST_URL = "https://fund.eastmoney.com/js/fundcode_search.js"
FUND_BASIC_URL = "https://fundf10.eastmoney.com/jbgk_{code}.html"
FUND_HOLDINGS_URL = "https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
FUND_NAV_HISTORY_URL = "https://api.fund.eastmoney.com/f10/lsjz"
INDEX_SEARCH_URL = "https://searchapi.eastmoney.com/api/suggest/get"
QUOTE_URL = "https://qt.gtimg.cn/q="
KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
MAX_FUNDS = 50
MIN_STOCKS = 3
MIN_QUOTE_COVERAGE = 0.70
MIN_ACCOUNT_COVERAGE = 0.60
HISTORY_DAYS = 5
BANNED_OUTPUT_TERMS = ("估值", "估算", "预估")


class DataError(RuntimeError):
    pass


class AmbiguousFund(DataError):
    def __init__(self, query: str, candidates: list["FundEntry"]):
        self.query = query
        self.candidates = candidates
        message = "；".join(f"{item.name}（{item.code}）" for item in candidates[:8])
        super().__init__(f"“{query}”匹配到多个基金：{message}")


@dataclass
class FundEntry:
    code: str
    name: str
    catalog_type: str = ""
    market_value: Optional[float] = None


@dataclass
class HeavyStock:
    secid: str
    code: str
    name: str
    weight_pct: float


@dataclass
class Quote:
    secid: str
    code: str
    name: str
    price: Optional[float]
    change_pct: Optional[float]
    timestamp: Optional[int]


@dataclass
class FundProfile:
    fund: FundEntry
    fund_type: str = ""
    tracking_name: str = ""
    tracking_secid: str = ""
    report_date: str = ""
    stocks: list[HeavyStock] = field(default_factory=list)
    supported: bool = True
    errors: list[str] = field(default_factory=list)


@dataclass
class Driver:
    name: str
    code: str
    change_pct: float
    normalized_weight_pct: float
    contribution_pct: float


@dataclass
class HistoricalDeviation:
    sample_count: int
    mean_abs_deviation_pct: float
    direction_match_pct: float
    latest_date: str
    latest_heavy_pct: float
    latest_nav_pct: float
    latest_deviation_pct: float


@dataclass
class NavPoint:
    date: str
    unit_nav: Optional[float]
    change_pct: float


@dataclass
class FundResult:
    code: str
    name: str
    fund_type: str
    metric_label: str
    change_pct: Optional[float]
    basis_name: str
    quote_time: str
    report_date: str
    disclosure_weight_pct: float
    quote_coverage_pct: float
    valid_stock_count: int
    market_value: Optional[float]
    up_drivers: list[Driver] = field(default_factory=list)
    down_drivers: list[Driver] = field(default_factory=list)
    historical_deviation: Optional[HistoricalDeviation] = None
    nav_date: str = ""
    unit_nav: Optional[float] = None
    nav_change_pct: Optional[float] = None
    current_deviation_pct: Optional[float] = None
    status: str = "ok"
    message: str = ""


def request_text(
    url: str,
    *,
    referer: str = "https://fund.eastmoney.com/",
    timeout: float = 20.0,
    retries: int = 2,
) -> str:
    headers = {"User-Agent": USER_AGENT, "Referer": referer, "Accept": "*/*"}
    last_error: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read(12 * 1024 * 1024 + 1)
                if len(raw) > 12 * 1024 * 1024:
                    raise DataError("公开数据响应过大")
                encodings = [response.headers.get_content_charset(), "utf-8", "gb18030"]
                for encoding in encodings:
                    if not encoding:
                        continue
                    try:
                        return raw.decode(encoding)
                    except UnicodeDecodeError:
                        pass
                return raw.decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(0.35 * (attempt + 1))
    raise DataError(f"公开数据请求失败：{last_error}")


def request_json(url: str, **kwargs: Any) -> dict[str, Any]:
    text = request_text(url, **kwargs)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise DataError("公开数据返回格式无法识别") from exc
    if not isinstance(data, dict):
        raise DataError("公开数据返回结构异常")
    return data


def strip_tags(value: str) -> str:
    value = re.sub(r"(?i)<br\s*/?>", " ", value)
    value = re.sub(r"<[^>]+>", "", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def parse_number(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("%", "")
    if text in {"", "-", "--", "None", "null"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_fund_catalog(text: str) -> list[FundEntry]:
    match = re.search(r"var\s+r\s*=\s*(\[.*\])\s*;?\s*$", text, re.S)
    if not match:
        raise DataError("基金目录结构无法识别")
    try:
        rows = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise DataError("基金目录解析失败") from exc
    entries: list[FundEntry] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 4:
            continue
        code, name, catalog_type = str(row[0]), str(row[2]), str(row[3])
        if re.fullmatch(r"\d{6}", code) and name:
            entries.append(FundEntry(code=code, name=name, catalog_type=catalog_type))
    if not entries:
        raise DataError("基金目录为空")
    return entries


def normalize_name(value: str) -> str:
    return re.sub(r"[\s·・()（）\-—_/]", "", value).casefold()


def resolve_fund(query: str, catalog: list[FundEntry]) -> FundEntry:
    query = query.strip()
    by_code = {item.code: item for item in catalog}
    if re.fullmatch(r"\d{6}", query):
        return by_code.get(query, FundEntry(code=query, name=query))
    normalized = normalize_name(query)
    exact = [item for item in catalog if normalize_name(item.name) == normalized]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise AmbiguousFund(query, exact)
    matches = [
        item
        for item in catalog
        if normalized in normalize_name(item.name) or normalize_name(item.name) in normalized
    ]
    if len(matches) == 1:
        return matches[0]
    if matches:
        matches.sort(key=lambda item: (len(item.name), item.code))
        raise AmbiguousFund(query, matches)
    raise DataError(f"未找到基金“{query}”")


def parse_basic_page(text: str) -> tuple[str, str]:
    rows: dict[str, str] = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S | re.I):
        pairs = re.findall(
            r"<th[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)(?=<th[^>]*>|</tr>|$)",
            row,
            re.S | re.I,
        )
        for raw_key, raw_value in pairs:
            key = strip_tags(raw_key).rstrip("：:")
            value = strip_tags(raw_value)
            if key:
                rows[key] = value
    fund_type = rows.get("基金类型", "")
    tracking = rows.get("跟踪标的", "")
    if tracking in {"-", "--", "—", "暂无", "无"} or "无跟踪标的" in tracking:
        tracking = ""
    return fund_type, tracking


def is_supported_fund_type(fund_type: str) -> bool:
    """Only stock-oriented and mixed funds are in scope."""
    normalized = re.sub(r"\s+", "", fund_type or "")
    excluded = ("债券型", "货币型", "理财型", "商品型", "REIT", "FOF")
    if any(label.casefold() in normalized.casefold() for label in excluded):
        return False
    return "股票型" in normalized or "混合型" in normalized or "指数型-股票" in normalized


def extract_latest_holdings(text: str) -> tuple[str, list[HeavyStock]]:
    match = re.search(r"content:\"(.*?)\",arryear:", text, re.S)
    if not match:
        raise DataError("重仓披露结构无法识别")
    content = match.group(1).replace('\\"', '"').replace("\\/", "/")
    table_match = re.search(
        r"(<h4[^>]*>.*?</h4>).*?(<table[^>]*class=['\"][^'\"]*tzxq[^'\"]*['\"][^>]*>.*?</table>)",
        content,
        re.S | re.I,
    )
    if not table_match:
        return "", []
    heading, table = table_match.groups()
    date_match = re.search(r"(20\d{2}-\d{2}-\d{2})", strip_tags(heading))
    report_date = date_match.group(1) if date_match else ""
    stocks: list[HeavyStock] = []
    seen: set[str] = set()
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S | re.I):
        secid_match = re.search(
            r"quote\.eastmoney\.com/unify/r/([0-9]+\.[A-Za-z0-9._-]+)", row, re.I
        )
        if not secid_match:
            continue
        secid = secid_match.group(1)
        if secid in seen:
            continue
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        cell_text = [strip_tags(cell) for cell in cells]
        if len(cell_text) < 3:
            continue
        percentages = [parse_number(value) for value in cell_text if value.endswith("%")]
        weights = [value for value in percentages if value is not None and value >= 0]
        if not weights:
            continue
        code = secid.split(".", 1)[1]
        name = cell_text[2] or code
        stocks.append(HeavyStock(secid=secid, code=code, name=name, weight_pct=weights[-1]))
        seen.add(secid)
    return report_date, stocks[:10]


def index_normal_form(value: str) -> str:
    value = normalize_name(value)
    for suffix in ("指数收益率", "全收益指数", "净收益指数", "价格指数", "指数"):
        value = value.replace(suffix, "")
    return value


def resolve_index(name: str, timeout: float) -> tuple[str, str]:
    search_name = re.sub(r"(指数收益率|全收益指数|净收益指数|价格指数|指数)$", "", name).strip()
    params = urllib.parse.urlencode({"input": search_name or name, "type": 14, "count": 50})
    data = request_json(
        f"{INDEX_SEARCH_URL}?{params}",
        referer="https://quote.eastmoney.com/",
        timeout=timeout,
    )
    candidates = (((data.get("QuotationCodeTable") or {}).get("Data")) or [])
    target = index_normal_form(name)
    scored: list[tuple[int, int, str, str]] = []
    for position, item in enumerate(candidates):
        if not isinstance(item, dict):
            continue
        quote_id = str(item.get("QuoteID") or "")
        candidate_name = str(item.get("Name") or "")
        classify = str(item.get("Classify") or "")
        security_type_name = str(item.get("SecurityTypeName") or "")
        if classify.casefold() != "index" and security_type_name != "指数":
            continue
        if not quote_id or "." not in quote_id or not candidate_name:
            continue
        candidate = index_normal_form(candidate_name)
        if candidate == target:
            score = 100
        elif target and target in candidate:
            score = 80
        elif candidate and candidate in target:
            score = 70
        else:
            score = 0
        if score:
            scored.append((score, -position, quote_id, candidate_name))
    if not scored:
        raise DataError(f"未找到跟踪指数“{name}”的行情代码")
    scored.sort(reverse=True)
    _, _, secid, resolved_name = scored[0]
    return secid, resolved_name


def secid_to_tencent_symbol(secid: str) -> Optional[str]:
    if "." not in secid:
        return None
    market, code = secid.split(".", 1)
    if market == "1":
        return f"sh{code}"
    if market == "0":
        return f"sz{code}"
    if market in {"100", "116"}:
        return f"hk{code}"
    if market in {"105", "106", "107"}:
        return f"us{code}"
    return None


def parse_tencent_quotes(text: str, symbol_to_secid: dict[str, str]) -> dict[str, Quote]:
    quotes: dict[str, Quote] = {}
    for symbol, payload in re.findall(r'v_([^=]+)="([^"]*)";', text):
        secid = symbol_to_secid.get(symbol)
        if not secid:
            continue
        fields = payload.split("~")
        if len(fields) < 33:
            continue
        timestamp: Optional[int] = None
        raw_time = fields[30].strip()
        if re.fullmatch(r"\d{14}", raw_time):
            try:
                timestamp = int(datetime.strptime(raw_time, "%Y%m%d%H%M%S").replace(tzinfo=timezone(timedelta(hours=8))).timestamp())
            except ValueError:
                timestamp = None
        quotes[secid] = Quote(
            secid=secid,
            code=fields[2].strip(),
            name=fields[1].strip() or fields[2].strip(),
            price=parse_number(fields[3]),
            change_pct=parse_number(fields[32]),
            timestamp=timestamp,
        )
    return quotes


def fetch_quotes(secids: Iterable[str], timeout: float) -> dict[str, Quote]:
    secid_to_symbol = {
        secid: symbol
        for secid in sorted({secid for secid in secids if secid})
        if (symbol := secid_to_tencent_symbol(secid)) is not None
    }
    quotes: dict[str, Quote] = {}
    pairs = list(secid_to_symbol.items())
    for start in range(0, len(pairs), 60):
        chunk = pairs[start : start + 60]
        symbol_to_secid = {symbol: secid for secid, symbol in chunk}
        symbols = ",".join(symbol_to_secid)
        text = request_text(
            f"{QUOTE_URL}{symbols}",
            referer="https://stockapp.finance.qq.com/",
            timeout=timeout,
        )
        quotes.update(parse_tencent_quotes(text, symbol_to_secid))
    return quotes


def parse_nav_points(data: dict[str, Any]) -> dict[str, NavPoint]:
    rows = (((data.get("Data") or {}).get("LSJZList")) or [])
    points: dict[str, NavPoint] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        day = str(row.get("FSRQ") or "")
        change = parse_number(row.get("JZZZL"))
        if re.fullmatch(r"20\d{2}-\d{2}-\d{2}", day) and change is not None:
            points[day] = NavPoint(
                date=day,
                unit_nav=parse_number(row.get("DWJZ")),
                change_pct=change,
            )
    return points


def parse_nav_history(data: dict[str, Any]) -> dict[str, float]:
    return {day: point.change_pct for day, point in parse_nav_points(data).items()}


def fetch_nav_points(code: str, timeout: float) -> dict[str, NavPoint]:
    params = urllib.parse.urlencode(
        {"fundCode": code, "pageIndex": 1, "pageSize": HISTORY_DAYS + 8}
    )
    data = request_json(
        f"{FUND_NAV_HISTORY_URL}?{params}",
        referer=f"https://fundf10.eastmoney.com/jjjz_{code}.html",
        timeout=timeout,
    )
    return parse_nav_points(data)


def attach_current_nav(result: FundResult, points: dict[str, NavPoint]) -> None:
    target_date = result.quote_time[:10] if len(result.quote_time) >= 10 else date.today().isoformat()
    point = points.get(target_date)
    if point is None:
        return
    result.nav_date = point.date
    result.unit_nav = point.unit_nav
    result.nav_change_pct = point.change_pct
    if result.change_pct is not None:
        result.current_deviation_pct = result.change_pct - point.change_pct


def parse_tencent_history(data: dict[str, Any], symbol: str) -> dict[str, float]:
    payload = ((data.get("data") or {}).get(symbol)) or {}
    rows = payload.get("qfqday") or payload.get("day") or []
    closes: list[tuple[str, float]] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 3:
            continue
        day = str(row[0])
        close = parse_number(row[2])
        if re.fullmatch(r"20\d{2}-\d{2}-\d{2}", day) and close is not None and close > 0:
            closes.append((day, close))
    returns: dict[str, float] = {}
    for index in range(1, len(closes)):
        day, close = closes[index]
        previous_close = closes[index - 1][1]
        if previous_close > 0:
            returns[day] = (close / previous_close - 1) * 100
    return returns


def fetch_stock_history(secid: str, timeout: float) -> dict[str, float]:
    symbol = secid_to_tencent_symbol(secid)
    if not symbol:
        return {}
    params = f"{symbol},day,,,{HISTORY_DAYS + 10},qfq"
    data = request_json(
        f"{KLINE_URL}?param={urllib.parse.quote(params, safe=',')}",
        referer="https://stockapp.finance.qq.com/",
        timeout=timeout,
    )
    return parse_tencent_history(data, symbol)


def fetch_stock_histories(
    secids: Iterable[str], timeout: float
) -> dict[str, dict[str, float]]:
    unique = sorted({secid for secid in secids if secid})
    histories: dict[str, dict[str, float]] = {}
    workers = min(8, max(1, len(unique)))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(fetch_stock_history, secid, timeout): secid for secid in unique
        }
        for future in as_completed(futures):
            secid = futures[future]
            try:
                histories[secid] = future.result()
            except (DataError, OSError, ValueError):
                histories[secid] = {}
    return histories


def calculate_historical_deviation(
    profile: FundProfile,
    nav_history: dict[str, float],
    stock_histories: dict[str, dict[str, float]],
    exclude_date: str = "",
) -> Optional[HistoricalDeviation]:
    total_disclosed = sum(stock.weight_pct for stock in profile.stocks if stock.weight_pct > 0)
    if total_disclosed <= 0:
        return None
    samples: list[tuple[str, float, float, float]] = []
    for day, nav_change in sorted(nav_history.items(), reverse=True):
        if exclude_date and day == exclude_date:
            continue
        if profile.report_date and day < profile.report_date:
            continue
        valid = [
            (stock, stock_histories.get(stock.secid, {}).get(day))
            for stock in profile.stocks
            if stock.weight_pct > 0
            and stock_histories.get(stock.secid, {}).get(day) is not None
        ]
        quoted_weight = sum(stock.weight_pct for stock, _ in valid)
        coverage = quoted_weight / total_disclosed
        if len(valid) < MIN_STOCKS or coverage < MIN_QUOTE_COVERAGE or quoted_weight <= 0:
            continue
        heavy_change = sum(
            stock.weight_pct * float(change) for stock, change in valid
        ) / quoted_weight
        deviation = heavy_change - nav_change
        samples.append((day, heavy_change, nav_change, deviation))
        if len(samples) >= HISTORY_DAYS:
            break
    if not samples:
        return None
    direction_matches = sum(
        1
        for _, heavy_change, nav_change, _ in samples
        if (heavy_change >= 0) == (nav_change >= 0)
    )
    latest_day, latest_heavy, latest_nav, latest_deviation = samples[0]
    return HistoricalDeviation(
        sample_count=len(samples),
        mean_abs_deviation_pct=sum(abs(item[3]) for item in samples) / len(samples),
        direction_match_pct=direction_matches / len(samples) * 100,
        latest_date=latest_day,
        latest_heavy_pct=latest_heavy,
        latest_nav_pct=latest_nav,
        latest_deviation_pct=latest_deviation,
    )


def fetch_profile(fund: FundEntry, timeout: float) -> FundProfile:
    profile = FundProfile(fund=fund)
    try:
        basic = request_text(FUND_BASIC_URL.format(code=fund.code), timeout=timeout)
        profile.fund_type, profile.tracking_name = parse_basic_page(basic)
    except DataError as exc:
        profile.errors.append(str(exc))
    effective_type = profile.fund_type or fund.catalog_type
    profile.supported = is_supported_fund_type(effective_type)
    if not profile.supported:
        return profile
    try:
        params = urllib.parse.urlencode(
            {
                "type": "jjcc",
                "code": fund.code,
                "topline": 10,
                "year": "",
                "month": "",
                "rt": f"{time.time():.6f}",
            }
        )
        holdings = request_text(
            f"{FUND_HOLDINGS_URL}?{params}",
            referer=f"https://fundf10.eastmoney.com/ccmx_{fund.code}.html",
            timeout=timeout,
        )
        profile.report_date, profile.stocks = extract_latest_holdings(holdings)
    except DataError as exc:
        profile.errors.append(str(exc))
    if profile.tracking_name:
        try:
            profile.tracking_secid, profile.tracking_name = resolve_index(
                profile.tracking_name, timeout
            )
        except DataError as exc:
            profile.errors.append(str(exc))
    return profile


def format_timestamp(timestamp: Optional[int]) -> str:
    if not timestamp:
        return ""
    try:
        return datetime.fromtimestamp(timestamp, timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    except (OSError, OverflowError, ValueError):
        return ""


def build_drivers(
    valid: list[tuple[HeavyStock, Quote]], quoted_weight: float
) -> tuple[list[Driver], list[Driver]]:
    drivers: list[Driver] = []
    for stock, quote in valid:
        normalized = stock.weight_pct / quoted_weight * 100
        contribution = stock.weight_pct / quoted_weight * float(quote.change_pct)
        drivers.append(
            Driver(
                name=stock.name,
                code=stock.code,
                change_pct=float(quote.change_pct),
                normalized_weight_pct=normalized,
                contribution_pct=contribution,
            )
        )
    up = sorted(
        (item for item in drivers if item.contribution_pct > 0),
        key=lambda item: item.contribution_pct,
        reverse=True,
    )[:3]
    down = sorted(
        (item for item in drivers if item.contribution_pct < 0),
        key=lambda item: item.contribution_pct,
    )[:3]
    return up, down


def analyze_profile(profile: FundProfile, quotes: dict[str, Quote]) -> FundResult:
    fund = profile.fund
    if not profile.supported:
        return FundResult(
            code=fund.code,
            name=fund.name,
            fund_type=profile.fund_type or fund.catalog_type,
            metric_label="—",
            change_pct=None,
            basis_name="",
            quote_time="",
            report_date="",
            disclosure_weight_pct=0.0,
            quote_coverage_pct=0.0,
            valid_stock_count=0,
            market_value=fund.market_value,
            status="unsupported",
            message="暂不支持该基金类型，仅计算股票型和混合型基金",
        )
    if profile.tracking_secid:
        quote = quotes.get(profile.tracking_secid)
        if quote and quote.change_pct is not None:
            return FundResult(
                code=fund.code,
                name=fund.name,
                fund_type=profile.fund_type or fund.catalog_type,
                metric_label="跟踪指数涨跌幅",
                change_pct=quote.change_pct,
                basis_name=profile.tracking_name or quote.name,
                quote_time=format_timestamp(quote.timestamp),
                report_date=profile.report_date,
                disclosure_weight_pct=sum(item.weight_pct for item in profile.stocks),
                quote_coverage_pct=100.0,
                valid_stock_count=0,
                market_value=fund.market_value,
            )

    total_disclosed = sum(item.weight_pct for item in profile.stocks if item.weight_pct > 0)
    valid: list[tuple[HeavyStock, Quote]] = []
    for stock in profile.stocks:
        quote = quotes.get(stock.secid)
        if stock.weight_pct > 0 and quote and quote.change_pct is not None:
            valid.append((stock, quote))
    quoted_weight = sum(stock.weight_pct for stock, _ in valid)
    coverage = quoted_weight / total_disclosed if total_disclosed > 0 else 0.0
    quote_times = [quote.timestamp for _, quote in valid if quote.timestamp]
    if len(valid) >= MIN_STOCKS and coverage >= MIN_QUOTE_COVERAGE and quoted_weight > 0:
        performance = sum(
            stock.weight_pct * float(quote.change_pct) for stock, quote in valid
        ) / quoted_weight
        up, down = build_drivers(valid, quoted_weight)
        return FundResult(
            code=fund.code,
            name=fund.name,
            fund_type=profile.fund_type or fund.catalog_type,
            metric_label="重仓表现",
            change_pct=performance,
            basis_name="最新公开披露重仓股票",
            quote_time=format_timestamp(max(quote_times) if quote_times else None),
            report_date=profile.report_date,
            disclosure_weight_pct=total_disclosed,
            quote_coverage_pct=coverage * 100,
            valid_stock_count=len(valid),
            market_value=fund.market_value,
            up_drivers=up,
            down_drivers=down,
        )
    message = (
        "暂无跟踪指数行情，且暂无足够的重仓行情"
        if profile.tracking_name
        else "暂无足够的重仓行情"
    )
    if profile.errors:
        message = f"{message}；{profile.errors[-1]}"
    return FundResult(
        code=fund.code,
        name=fund.name,
        fund_type=profile.fund_type or fund.catalog_type,
        metric_label="跟踪指数涨跌幅" if profile.tracking_name else "重仓表现",
        change_pct=None,
        basis_name=profile.tracking_name or "最新公开披露重仓股票",
        quote_time=format_timestamp(max(quote_times) if quote_times else None),
        report_date=profile.report_date,
        disclosure_weight_pct=total_disclosed,
        quote_coverage_pct=coverage * 100,
        valid_stock_count=len(valid),
        market_value=fund.market_value,
        status="unavailable",
        message=message,
    )


def format_pct(value: Optional[float]) -> str:
    return "—" if value is None else f"{value:+.2f}%"


def safe_cell(value: Any) -> str:
    return str(value).replace("|", "｜").replace("\n", " ").strip()


def account_summary(results: list[FundResult]) -> tuple[Optional[float], float]:
    valued = [
        item
        for item in results
        if item.status != "unsupported"
        and item.market_value is not None
        and item.market_value > 0
    ]
    total = sum(float(item.market_value) for item in valued)
    if total <= 0:
        return None, 0.0
    available = [item for item in valued if item.change_pct is not None]
    covered = sum(float(item.market_value) for item in available)
    coverage = covered / total
    if coverage < MIN_ACCOUNT_COVERAGE or covered <= 0:
        return None, coverage
    value = sum(
        float(item.market_value) * float(item.change_pct) for item in available
    ) / covered
    return value, coverage


def render_drivers(items: list[Driver]) -> str:
    return "、".join(
        f"{item.name} {item.change_pct:+.2f}%（贡献{item.contribution_pct:+.2f}个百分点）"
        for item in items
    )


def build_report_title(latest_date: str, now: Optional[datetime] = None) -> str:
    current = now or datetime.now()
    if not latest_date:
        return "基金今日表现"
    if latest_date != current.date().isoformat():
        return f"基金最近交易日表现（{latest_date}）"
    minute = current.hour * 60 + current.minute
    if 9 * 60 + 30 <= minute < 15 * 60:
        return "基金盘中表现"
    if minute >= 16 * 60 + 10:
        return "基金今日收盘表现"
    return "基金今日表现"


def render_current_nav(item: FundResult) -> str:
    unit_text = f"{item.unit_nav:.4f}" if item.unit_nav is not None else "暂无"
    text = (
        f"- 当日正式净值（{item.nav_date}）：单位净值 {unit_text}，"
        f"涨跌 {float(item.nav_change_pct):+.2f}%"
    )
    if item.current_deviation_pct is None:
        return f"{text}。"
    deviation = float(item.current_deviation_pct)
    if abs(deviation) < 0.005:
        return f"{text}；与{item.metric_label}基本一致。"
    direction = "高" if deviation > 0 else "低"
    return (
        f"{text}；{item.metric_label}比正式净值涨跌{direction} "
        f"{abs(deviation):.2f} 个百分点。"
    )


def render_markdown(
    results: list[FundResult], now: Optional[datetime] = None
) -> str:
    timestamps = [item.quote_time for item in results if item.quote_time]
    dates = [value[:10] for value in timestamps if len(value) >= 10]
    latest_date = max(dates) if dates else ""
    title = build_report_title(latest_date, now)
    if "盘中" in title:
        overall_label = "股票型/混合型持仓整体盘中表现"
    elif "收盘" in title:
        overall_label = "股票型/混合型持仓整体收盘表现"
    else:
        overall_label = "股票型/混合型持仓整体今日表现"
    latest_time = max(timestamps) if timestamps else "暂无"
    lines = [f"## {title}", f"\n数据时间：{latest_time}"]
    overall, coverage = account_summary(results)
    if any(
        item.status != "unsupported"
        and item.market_value is not None
        and item.market_value > 0
        for item in results
    ):
        if overall is not None:
            lines.append(
                f"\n{overall_label}：**{overall:+.2f}%**（覆盖 {coverage * 100:.0f}% 持有市值）"
            )
        else:
            lines.append(
                f"\n{overall_label}：暂不展示（可用结果覆盖 {coverage * 100:.0f}% 持有市值）"
            )
    lines.extend(
        [
            "",
            "| 基金 | 类型 | 指标 | 今日表现 |",
            "| --- | --- | --- | ---: |",
        ]
    )
    for item in results:
        value = format_pct(item.change_pct) if item.change_pct is not None else safe_cell(item.message)
        lines.append(
            f"| {safe_cell(item.name)}（{item.code}） | {safe_cell(item.fund_type or '—')} | "
            f"{item.metric_label} | {value} |"
        )
    for item in results:
        has_active_detail = item.change_pct is not None and item.metric_label == "重仓表现"
        has_current_nav = item.nav_change_pct is not None and bool(item.nav_date)
        if not has_active_detail and not has_current_nav:
            continue
        lines.append(f"\n### {safe_cell(item.name)}")
        if has_active_detail:
            lines.append(
                f"重仓行情覆盖：{item.valid_stock_count} 只，覆盖已披露重仓权重的 {item.quote_coverage_pct:.0f}%；"
                f"前十大重仓合计占基金资产 {item.disclosure_weight_pct:.2f}%"
                + (f"；重仓披露日期 {item.report_date}。" if item.report_date else "。")
            )
            if item.up_drivers:
                lines.append(f"- 主要上涨驱动：{render_drivers(item.up_drivers)}")
            if item.down_drivers:
                lines.append(f"- 主要下跌驱动：{render_drivers(item.down_drivers)}")
        if has_current_nav:
            lines.append(render_current_nav(item))
        if has_active_detail and item.historical_deviation:
            deviation = item.historical_deviation
            lines.append(
                f"- 历史偏离校准（近 {deviation.sample_count} 个可比日）："
                f"平均绝对偏离 {deviation.mean_abs_deviation_pct:.2f} 个百分点，"
                f"方向一致率 {deviation.direction_match_pct:.0f}%；"
                f"最近可比日 {deviation.latest_date}，重仓表现 {deviation.latest_heavy_pct:+.2f}%，"
                f"正式净值涨跌 {deviation.latest_nav_pct:+.2f}%，"
                f"偏离 {deviation.latest_deviation_pct:+.2f} 个百分点。"
            )
    lines.append("\n数据来源：天天基金、东方财富、腾讯财经公开页面。")
    lines.append(
        "重仓数据来自最近公开披露，基金经理可能已调整持仓；正式净值未公布前，结果仅用于观察当日方向。"
    )
    output = "\n".join(lines)
    for term in BANNED_OUTPUT_TERMS:
        if term in output:
            raise DataError("输出包含禁用表述")
    return output


def aliases_get(record: dict[str, Any], aliases: tuple[str, ...]) -> Any:
    for key in aliases:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return None


def normalize_records(data: Any, collection: str) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [item if isinstance(item, dict) else {"fund": item} for item in data]
    if not isinstance(data, dict):
        raise DataError("输入数据必须是列表或对象")
    if collection == "auto":
        for key in ("holdings", "favorites", "funds"):
            if isinstance(data.get(key), list):
                return normalize_records(data[key], key)
        if any(
            key in data
            for key in ("fund_code", "code", "基金代码", "fund_name", "name", "基金名称")
        ):
            return [data]
        raise DataError("输入对象中未找到 holdings、favorites 或 funds")
    selected = data.get(collection)
    if not isinstance(selected, list):
        raise DataError(f"输入对象中没有 {collection} 列表")
    return normalize_records(selected, collection)


def read_input(path: Path, collection: str) -> list[dict[str, Any]]:
    suffix = path.suffix.lower()
    raw = path.read_bytes()
    text = ""
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if not text:
        raise DataError("输入文件编码无法识别")
    if suffix == ".json":
        return normalize_records(json.loads(text), collection)
    if suffix == ".csv":
        return [dict(row) for row in csv.DictReader(text.splitlines())]
    return [{"fund": line.strip()} for line in text.splitlines() if line.strip()]


def split_targets(values: Iterable[str]) -> list[str]:
    targets: list[str] = []
    for value in values:
        targets.extend(part.strip() for part in re.split(r"[,，;；\n]", value) if part.strip())
    return targets


def collect_requests(args: argparse.Namespace) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for target in split_targets(args.fund or []):
        records.append({"fund": target})
    for path in args.input or []:
        records.extend(read_input(Path(path), args.collection))
    if args.stdin_json:
        payload = sys.stdin.read()
        if not payload.strip():
            raise DataError("标准输入为空")
        records.extend(normalize_records(json.loads(payload), args.collection))
    if not records:
        raise DataError("请提供基金代码、名称或输入文件")
    return records


def resolve_requests(records: list[dict[str, Any]], catalog: list[FundEntry]) -> list[FundEntry]:
    merged: dict[str, FundEntry] = {}
    for record in records:
        target = aliases_get(record, ("fund_code", "code", "基金代码"))
        if target is None:
            target = aliases_get(record, ("fund_name", "name", "基金名称", "fund"))
        if target is None:
            raise DataError("输入记录缺少基金代码或名称")
        entry = resolve_fund(str(target), catalog)
        market_value = parse_number(
            aliases_get(
                record,
                ("market_value", "amount", "holding_value", "持有市值", "持有金额"),
            )
        )
        existing = merged.get(entry.code)
        if existing:
            if market_value is not None:
                existing.market_value = (existing.market_value or 0.0) + market_value
        else:
            merged[entry.code] = FundEntry(
                code=entry.code,
                name=entry.name,
                catalog_type=entry.catalog_type,
                market_value=market_value,
            )
    funds = list(merged.values())
    if len(funds) > MAX_FUNDS:
        raise DataError(f"单次最多处理 {MAX_FUNDS} 只基金，请分批查询")
    return funds


def sort_results(results: list[FundResult]) -> list[FundResult]:
    """Keep the user's order within each group, with available rows first."""
    indexed = list(enumerate(results))
    indexed.sort(key=lambda pair: (pair[1].change_pct is None, pair[0]))
    return [result for _, result in indexed]


def run(args: argparse.Namespace) -> list[FundResult]:
    catalog = parse_fund_catalog(request_text(FUND_LIST_URL, timeout=args.timeout))
    funds = resolve_requests(collect_requests(args), catalog)
    profiles: list[FundProfile] = []
    workers = min(6, max(1, len(funds)))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(fetch_profile, fund, args.timeout): fund for fund in funds}
        for future in as_completed(futures):
            fund = futures[future]
            try:
                profiles.append(future.result())
            except Exception as exc:
                profiles.append(FundProfile(fund=fund, errors=[f"基金数据读取失败：{exc}"]))
    order = {fund.code: index for index, fund in enumerate(funds)}
    profiles.sort(key=lambda item: order[item.fund.code])
    secids = [profile.tracking_secid for profile in profiles if profile.tracking_secid]
    secids.extend(stock.secid for profile in profiles for stock in profile.stocks)
    quotes = fetch_quotes(secids, args.timeout) if secids else {}
    results = [analyze_profile(profile, quotes) for profile in profiles]

    supported_pairs = [
        (profile, result)
        for profile, result in zip(profiles, results)
        if profile.supported
    ]
    nav_points_by_code: dict[str, dict[str, NavPoint]] = {}
    if supported_pairs:
        workers = min(6, len(supported_pairs))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(fetch_nav_points, profile.fund.code, args.timeout): (
                    profile,
                    result,
                )
                for profile, result in supported_pairs
            }
            for future in as_completed(futures):
                profile, result = futures[future]
                try:
                    points = future.result()
                    nav_points_by_code[profile.fund.code] = points
                    attach_current_nav(result, points)
                except (DataError, OSError, ValueError):
                    continue

    active_pairs = [
        (profile, result)
        for profile, result in zip(profiles, results)
        if profile.supported
        and not profile.tracking_name
        and result.metric_label == "重仓表现"
        and result.change_pct is not None
    ]
    if active_pairs:
        history_secids = [
            stock.secid for profile, _ in active_pairs for stock in profile.stocks
        ]
        stock_histories = fetch_stock_histories(history_secids, args.timeout)
        for profile, result in active_pairs:
            points = nav_points_by_code.get(profile.fund.code, {})
            nav_history = {day: point.change_pct for day, point in points.items()}
            result.historical_deviation = calculate_historical_deviation(
                profile,
                nav_history,
                stock_histories,
                exclude_date=result.nav_date,
            )

    return sort_results(results)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="使用公开重仓股票和跟踪指数行情查询基金当日表现。"
    )
    parser.add_argument("--fund", action="append", help="基金代码或名称；可重复或使用逗号分隔")
    parser.add_argument("--input", action="append", help="JSON、CSV 或 TXT 文件；可重复")
    parser.add_argument(
        "--collection",
        choices=("auto", "holdings", "favorites", "funds"),
        default="auto",
        help="JSON 对象中的集合名称",
    )
    parser.add_argument("--stdin-json", action="store_true", help="从标准输入读取 JSON")
    parser.add_argument("--json", action="store_true", help="输出结构化 JSON")
    parser.add_argument("--timeout", type=float, default=20.0, help="单次公开数据请求超时秒数")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        results = run(args)
        if args.json:
            print(json.dumps([asdict(item) for item in results], ensure_ascii=False, indent=2))
        else:
            print(render_markdown(results))
        return 0
    except AmbiguousFund as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except (DataError, json.JSONDecodeError, OSError, ValueError) as exc:
        print(f"查询失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
