"""Public intraday reference changes for the client's fund watchlist.

The supplied fund_intraday module owns source parsing and calculation rules.
This adapter batches quotes and keeps stale market data out of the live view.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import fund_intraday as source


CHINA_TIME = timezone(timedelta(hours=8))
PROFILE_TTL = 6 * 60 * 60
_profile_lock = threading.RLock()
_profiles = {}


def _profile(code: str):
    with _profile_lock:
        cached = _profiles.get(code)
        if cached and cached[0] > time.monotonic():
            return cached[1]
    profile = source.fetch_profile(source.FundEntry(code=code, name=code), timeout=5)
    with _profile_lock:
        _profiles[code] = (time.monotonic() + PROFILE_TTL, profile)
    return profile


def _stock_rows(profile, quotes: dict) -> list[dict]:
    return [
        {'code': stock.code, 'name': stock.name,
         'weightPct': round(stock.weight_pct, 2),
         'changePct': quotes[stock.secid].change_pct if stock.secid in quotes else None}
        for stock in profile.stocks[:10]
    ]


def _unavailable(code: str, message: str, profile=None, quotes=None) -> dict:
    return {'code': code, 'changePct': None,
            'status': message, 'metricLabel': None, 'asOf': None,
            'basisName': None, 'reportDate': profile.report_date if profile else None,
            'quoteCoveragePct': None, 'disclosureWeightPct': None,
            'validStockCount': None,
            'disclosedHoldings': _stock_rows(profile, quotes or {}) if profile else []}


def watchlist_intraday(codes: list[str]) -> dict:
    """Return same-day proxy changes, never a fund's official NAV or return."""
    unique = list(dict.fromkeys(code for code in codes if len(code) == 6 and code.isdigit()))[:25]
    if not unique:
        return {'source': '东方财富公开披露 · 腾讯证券行情', 'asOf': None, 'funds': []}
    profiles = {}
    errors = {}
    with ThreadPoolExecutor(max_workers=min(6, len(unique))) as pool:
        futures = {pool.submit(_profile, code): code for code in unique}
        for future in as_completed(futures):
            code = futures[future]
            try:
                profiles[code] = future.result()
            except (source.DataError, OSError, ValueError) as exc:
                errors[code] = f'基金资料暂不可用：{exc}'

    secids = []
    for profile in profiles.values():
        if not profile.supported:
            continue
        if profile.tracking_secid:
            secids.append(profile.tracking_secid)
        elif not profile.tracking_name:
            secids.extend(stock.secid for stock in profile.stocks)
    quote_error = False
    try:
        quotes = source.fetch_quotes(secids, timeout=5) if secids else {}
    except (source.DataError, OSError, ValueError):
        quotes = {}
        quote_error = True
    current_time = datetime.now(CHINA_TIME)
    today = current_time.date()
    live_session = ((9, 45) <= (current_time.hour, current_time.minute) <= (11, 30)
                    or (13, 15) <= (current_time.hour, current_time.minute) <= (15, 0))
    current_quotes = {
        secid: quote for secid, quote in quotes.items()
        if quote.timestamp and datetime.fromtimestamp(quote.timestamp, CHINA_TIME).date() == today
        and (datetime.fromtimestamp(quote.timestamp, CHINA_TIME).hour,
             datetime.fromtimestamp(quote.timestamp, CHINA_TIME).minute) >= (9, 30)
        and (not live_session or current_time.timestamp() - quote.timestamp <= 20 * 60)
        and ((current_time.hour, current_time.minute) < (15, 0)
             or (datetime.fromtimestamp(quote.timestamp, CHINA_TIME).hour,
                 datetime.fromtimestamp(quote.timestamp, CHINA_TIME).minute) >= (14, 45))
    }
    funds = []
    for code in unique:
        profile = profiles.get(code)
        if not profile:
            funds.append(_unavailable(code, errors.get(code, '基金资料暂不可用')))
            continue
        if not profile.supported:
            funds.append(_unavailable(code, '此类基金暂不支持盘中参考', profile, current_quotes))
            continue
        if profile.tracking_name and not profile.tracking_secid:
            funds.append(_unavailable(code, '跟踪指数行情暂不可用', profile, current_quotes))
            continue
        if '指数' in profile.fund_type and not profile.tracking_name:
            funds.append(_unavailable(code, '未查到明确的跟踪指数', profile, current_quotes))
            continue
        result = source.analyze_profile(profile, current_quotes)
        if result.change_pct is None:
            if quote_error:
                reason = '证券行情源暂不可用'
            elif not current_quotes:
                reason = '今日行情尚未更新'
            elif profile.tracking_secid:
                reason = '跟踪指数今日行情暂不可用'
            else:
                reason = '公开重仓行情不足，无法估算'
            funds.append(_unavailable(code, reason, profile, current_quotes))
            continue
        funds.append({
            'code': code, 'changePct': round(result.change_pct, 4),
            'status': '参考涨跌，非基金净值',
            'metricLabel': result.metric_label, 'asOf': result.quote_time or None,
            'basisName': result.basis_name or None,
            'reportDate': result.report_date or None,
            'quoteCoveragePct': round(result.quote_coverage_pct, 1),
            'disclosureWeightPct': round(result.disclosure_weight_pct, 1),
            'validStockCount': result.valid_stock_count,
            'disclosedHoldings': _stock_rows(profile, current_quotes),
        })
    latest = max((row['asOf'] for row in funds if row['asOf']), default=None)
    return {'source': '东方财富公开披露 · 腾讯证券行情', 'asOf': latest, 'funds': funds}
