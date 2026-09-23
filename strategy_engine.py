"""Deterministic, read-only strategy research adapters for the local workbench.

The engine deliberately keeps the model out of numerical work.  It consumes
the existing Fuyao adjusted-NAV adapter and returns either an auditable result
or a blocked response explaining which data contract is missing.
"""
from __future__ import annotations

import datetime as dt
import math
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fund_data import FuyaoClient, FuyaoError


RISK_STATEMENT = "历史回测结果基于历史数据与既定规则模拟，不代表未来收益；市场有风险，投资需谨慎。本输出仅为决策参考，不构成投资建议。"


CATALOG: List[Dict[str, Any]] = [
    {
        "id": "rsi-profit",
        "name": "分批低吸目标止盈",
        "version": "2.1.10",
        "category": "波动",
        "symbol": "↗",
        "description": "基金偏弱时分批投入，达到目标退出边界后结束这一轮。",
        "suitableFor": "怕追高、愿意按规则等待的人",
        "tradeoff": "单边下跌时可能持续观察，退出条件可能较久才出现。",
        "rules": ["RSI 低于低吸边界才投入", "每月最多投入 3 次", "计划持仓达到目标边界后退出本轮"],
        "dataBasis": "扶摇复权净值 · 单基金",
        "defaultFundCode": "110020",
        "showcaseCandidates": [
            {"code": "110020", "name": "易方达沪深300ETF联接A"},
            {"code": "000478", "name": "建信中证500指数增强A"},
            {"code": "005918", "name": "天弘沪深300ETF联接C"},
            {"code": "000216", "name": "华安黄金ETF联接A"},
            {"code": "002611", "name": "博时黄金ETF联接C"},
        ],
        "defaultParams": {"buy_threshold_percent": 30, "target_profit_percent": 10, "max_buy_times": 3, "amount": 1000},
        "params": [
            {"key": "buy_threshold_percent", "label": "低吸边界", "help": "RSI 低于这个数值时，策略才允许分批投入；越低越谨慎。", "unit": "%", "type": "number", "default": 30, "min": 10, "max": 50, "step": 1},
            {"key": "target_profit_percent", "label": "目标退出边界", "help": "本轮持仓相对成本达到该收益率后，模拟结束本轮并退出。", "unit": "%", "type": "number", "default": 10, "min": 1, "max": 30, "step": 1},
            {"key": "max_buy_times", "label": "每月最多投入次数", "help": "限制同一个月内最多触发多少次投入，避免短期连续加仓。", "unit": "次", "type": "number", "default": 3, "min": 1, "max": 22, "step": 1},
            {"key": "amount", "label": "单次投入", "help": "每次满足投入条件时使用的模拟金额。", "unit": "元", "type": "number", "default": 1000, "min": 100, "max": 100000, "step": 100},
        ],
    },
    {
        "id": "nav-swing",
        "name": "净值波动低吸高抛",
        "version": "2.4.1",
        "category": "波动",
        "symbol": "〰",
        "description": "按复权净值在近期区间中的位置分批投入，高位转弱时谨慎减仓。",
        "suitableFor": "愿意等待净值回到区间、希望减少追涨的人",
        "tradeoff": "趋势持续上涨时可能错过部分投入，震荡期也可能反复观察。",
        "rules": ["低位回稳后才追加", "高位转弱只模拟有限减仓", "动作之间保留冷却期"],
        "dataBasis": "扶摇复权净值 · 单基金",
        "defaultFundCode": "110020",
        "showcaseCandidates": [
            {"code": "110020", "name": "易方达沪深300ETF联接A"},
            {"code": "000478", "name": "建信中证500指数增强A"},
            {"code": "005918", "name": "天弘沪深300ETF联接C"},
            {"code": "000216", "name": "华安黄金ETF联接A"},
            {"code": "002611", "name": "博时黄金ETF联接C"},
        ],
        "defaultParams": {"action_mode": "stable", "add_multiplier": 1.5, "sell_ratio": 0.1, "amount": 1000},
        "params": [
            {"key": "action_mode", "label": "行动节奏", "help": "stable 等待位置变化确认，sensitive 在进入低位时更快响应。", "unit": "模式", "type": "choice", "default": "stable", "choices": ["stable", "sensitive"]},
            {"key": "add_multiplier", "label": "低位回稳投入倍数", "help": "净值位于低位并回稳时，单次投入金额相对基础金额的放大倍数。", "unit": "倍", "type": "number", "default": 1.5, "min": 1.0, "max": 2.0, "step": 0.1},
            {"key": "sell_ratio", "label": "高位转弱减仓比例", "help": "净值处在高位并转弱时，模拟减掉当前份额的比例。", "unit": "比例", "type": "number", "default": 0.1, "min": 0.0, "max": 0.2, "step": 0.01},
            {"key": "amount", "label": "单次投入", "help": "普通投入信号触发时使用的基础模拟金额。", "unit": "元", "type": "number", "default": 1000, "min": 100, "max": 100000, "step": 100},
        ],
        "fixed": {"lookback_periods": 14, "low_boundary": 30, "high_boundary": 70, "cooldown_days": 30},
    },
    {
        "id": "trend-strength",
        "name": "趋势强弱",
        "version": "2.2.5",
        "category": "趋势",
        "symbol": "⤴",
        "description": "读取基金真实的 Donchian 趋势状态；明确转强后按周期分批投入，明确转弱时提出退出建议，其余时间保持不动。",
        "suitableFor": "能接受等待趋势确认、希望少做逆势操作的人",
        "tradeoff": "趋势反复时可能多次等待确认，快速反转会带来滞后。",
        "rules": ["Donchian 状态达到明确转强区间后分批投入", "按周或按月限制投入次数", "达到明确转弱区间时只提出退出建议"],
        "dataBasis": "扶摇复权净值 + Donchian 趋势状态 · 单基金",
        "defaultFundCode": "110020",
        "showcaseCandidates": [
            {"code": "110020", "name": "易方达沪深300ETF联接A"},
            {"code": "000478", "name": "建信中证500指数增强A"},
            {"code": "005918", "name": "天弘沪深300ETF联接C"},
            {"code": "000216", "name": "华安黄金ETF联接A"},
            {"code": "002611", "name": "博时黄金ETF联接C"},
        ],
        "defaultParams": {"trend_mode": "confirmed", "buy_cycle": "monthly", "max_buy_times": 3, "amount": 1000},
        "params": [
            {"key": "trend_mode", "label": "行动节奏", "help": "confirmed 等待趋势由弱转强，early 在趋势已强时也允许更早响应。", "unit": "模式", "type": "choice", "default": "confirmed", "choices": ["confirmed", "early"]},
            {"key": "buy_cycle", "label": "投入次数统计周期", "help": "按周或按月重新计算允许投入的次数上限。", "unit": "周期", "type": "choice", "default": "monthly", "choices": ["weekly", "monthly"]},
            {"key": "max_buy_times", "label": "周期最多投入次数", "help": "每个统计周期内允许触发投入的最大次数。", "unit": "次", "type": "number", "default": 3, "min": 1, "max": 22, "step": 1},
            {"key": "amount", "label": "单次投入", "help": "趋势转强并满足次数限制时使用的模拟金额。", "unit": "元", "type": "number", "default": 1000, "min": 100, "max": 100000, "step": 100},
        ],
        "fixed": {"indicator_code": "donchianChannel", "confirmed_boundary": 10},
    },
    {
        "id": "gem-valuation",
        "name": "创业板估值百分位",
        "version": "0.3.21",
        "category": "估值",
        "symbol": "▱",
        "description": "用创业板 PE 历史百分位安排基础投入、加速和现金池。",
        "suitableFor": "有明确创业板暴露、愿意管理现金储备的人",
        "tradeoff": "估值数据、指数暴露和现金规则缺一项都不能可靠生成信号。",
        "rules": ["低估区提高投入倍数", "高估区将部分资金转入现金池", "现金池规则和估值日期必须可追溯"],
        "dataBasis": "创业板 PE 分位接口 + 指数相关场外基金",
        "defaultFundCode": "007664",
        "showcaseCandidates": [{"code": "007664", "name": "永赢创业板指数A"}],
        "defaultParams": {"trigger_percentile": 70, "weekly_base_amount": 1000, "growth_rate": 0.07,
                          "daily_redeem_ratio": 0.01, "cash_interest_rate": 0.014,
                          "initial_capital": 50000, "extra_contribution_amount": 5000,
                          "extra_contribution_freq": "每月"},
        "params": [
            {"key": "trigger_percentile", "label": "高估触发百分位", "help": "PE 五年百分位达到该位置后，策略进入分批赎回阶段。", "unit": "%", "type": "number", "default": 70, "min": 70, "max": 100, "step": 1},
            {"key": "weekly_base_amount", "label": "每周基础投入", "help": "估值处于正常区时的每周基础投入金额，低估时会按规则放大。", "unit": "元/周", "type": "number", "default": 1000, "min": 100, "max": 10000, "step": 100},
            {"key": "growth_rate", "label": "年度投入增幅", "help": "基础投入和定期新增金额每年的增长比例。", "unit": "比例", "type": "number", "default": 0.07, "min": 0, "max": 0.2, "step": 0.01},
            {"key": "daily_redeem_ratio", "label": "每日赎回比例", "help": "进入高估阶段后，每个交易日相对参考份额的模拟赎回比例。", "unit": "比例", "type": "number", "default": 0.01, "min": 0.001, "max": 0.05, "step": 0.001},
            {"key": "cash_interest_rate", "label": "现金年利率", "help": "未投入现金在回测中的年化计息假设。", "unit": "比例", "type": "number", "default": 0.014, "min": 0, "max": 0.05, "step": 0.001},
            {"key": "initial_capital", "label": "初始资金", "help": "回测开始时可用于基金与现金池的总金额。", "unit": "元", "type": "number", "default": 50000, "min": 0, "max": 1000000, "step": 5000},
            {"key": "extra_contribution_amount", "label": "定期新增金额", "help": "回测运行期间按指定频率补充到现金池的金额。", "unit": "元/次", "type": "number", "default": 5000, "min": 0, "max": 100000, "step": 1000},
            {"key": "extra_contribution_freq", "label": "定期新增频率", "help": "决定新增资金进入现金池的时间间隔。", "unit": "频率", "type": "choice", "default": "每月", "choices": ["每周", "每月", "每季", "每年"]},
        ],
        "requires": ["创业板 PE 历史百分位", "现金池规则数据"],
    },
    {
        "id": "industry-trend",
        "name": "行业基金趋势轮动",
        "version": "0.3.9",
        "category": "轮动",
        "symbol": "⟳",
        "description": "比较行业基金中短期趋势和波动，每月选择更强且相对平稳的方向。",
        "suitableFor": "愿意接受行业切换、能按月复核组合的人",
        "tradeoff": "需要完整行业基金池和同期数据，轮动也可能增加操作和错过反弹的风险。",
        "rules": ["比较短长期均线和近期涨跌", "每月选择有限数量行业", "高波动方向少分配资金"],
        "dataBasis": "行业基金池 + 多基金复权净值",
        "codeRequired": False,
        "defaultParams": {"ma_fast": 30, "ma_slow": 250, "top_k": 2,
                          "weight_scheme": "vol", "initial_capital": 1000000},
        "params": [
            {"key": "ma_fast", "label": "短期均线", "help": "观察近期趋势所使用的交易日数量。", "unit": "日", "type": "number", "default": 30, "min": 5, "max": 120, "step": 1},
            {"key": "ma_slow", "label": "长期均线", "help": "确认中长期方向所使用的交易日数量，必须大于短期均线。", "unit": "日", "type": "number", "default": 250, "min": 60, "max": 500, "step": 1},
            {"key": "top_k", "label": "每月选择行业数", "help": "每次月度轮动保留得分最高的行业数量。", "unit": "个", "type": "number", "default": 2, "min": 1, "max": 5, "step": 1},
            {"key": "weight_scheme", "label": "行业资金分配", "help": "equal 等权、rank 按排名、score 按得分、vol 按波动率倒数分配。", "unit": "方式", "type": "choice", "default": "vol", "choices": ["equal", "rank", "score", "vol"]},
            {"key": "initial_capital", "label": "初始资金", "help": "轮动组合开始时的模拟可用资金。", "unit": "元", "type": "number", "default": 1000000, "min": 0, "max": 1000000, "step": 5000},
        ],
        "requires": ["行业基金池", "多基金历史复权净值", "行业分类映射"],
    },
]


def catalog() -> List[Dict[str, Any]]:
    return [dict(item) for item in CATALOG]


def get_strategy(strategy_id: str) -> Dict[str, Any]:
    for item in CATALOG:
        if item["id"] == strategy_id:
            return item
    raise ValueError("未找到指定策略。")


def _number(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def validate_params(strategy_id: str, params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    strategy = get_strategy(strategy_id)
    source = dict(strategy["defaultParams"])
    source.update(strategy.get("fixed") or {})
    source.update(params or {})
    clean: Dict[str, Any] = {}
    for spec in strategy["params"]:
        key = spec["key"]
        value = source.get(key, spec.get("default"))
        if spec.get("choices"):
            if value not in spec["choices"]:
                raise ValueError(f"{spec['label']}取值无效，请从指定选项中选择。")
            clean[key] = value
            continue
        number_value = _number(value)
        if number_value is None or not math.isfinite(number_value):
            raise ValueError(f"{spec['label']}必须是有效数字。")
        if number_value < spec["min"] or number_value > spec["max"]:
            raise ValueError(f"{spec['label']}须在 {spec['min']} 至 {spec['max']} {spec['unit']}之间。")
        step = float(spec.get("step") or 1)
        steps = (number_value - float(spec["min"])) / step
        if abs(steps - round(steps)) > 1e-8:
            raise ValueError(f"{spec['label']}须从 {spec['min']} 起按 {spec['step']} {spec['unit']}递增。")
        clean[key] = int(number_value) if spec["step"] >= 1 else round(number_value, 6)
    if strategy_id == "industry-trend" and clean.get("ma_fast", 0) >= clean.get("ma_slow", 1):
        raise ValueError("短期均线必须小于长期均线。")
    if strategy_id == "nav-swing" and (strategy.get("fixed", {}).get("low_boundary", 30) >= strategy.get("fixed", {}).get("high_boundary", 70)):
        raise ValueError("低位边界必须低于高位边界。")
    # Fixed parameters remain in the snapshot for auditability, but are not
    # exposed as editable fields in the catalog UI.
    for key, value in (strategy.get("fixed") or {}).items():
        clean.setdefault(key, value)
    return clean


def _rsi(values: List[float], period: int = 14) -> Optional[float]:
    if len(values) <= period:
        return None
    changes = [values[i] - values[i - 1] for i in range(len(values) - period, len(values))]
    gains = [max(change, 0) for change in changes]
    losses = [max(-change, 0) for change in changes]
    average_gain, average_loss = statistics.fmean(gains), statistics.fmean(losses)
    if average_loss == 0:
        return 100.0
    return 100 - 100 / (1 + average_gain / average_loss)


def _position(values: List[float], lookback: int) -> Optional[float]:
    if len(values) < lookback:
        return None
    window = values[-lookback:]
    low, high = min(window), max(window)
    return 50.0 if high == low else (window[-1] - low) / (high - low) * 100


def _metrics(curve: List[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    if not curve:
        return {"returnPct": None, "maxDrawdownPct": None, "volatilityPct": None}
    values = [float(row["value"]) for row in curve]
    first_positive = next((i for i, value in enumerate(values) if value > 0), None)
    if first_positive is None:
        return {"returnPct": None, "maxDrawdownPct": None, "volatilityPct": None}
    values = values[first_positive:]
    start = values[0]
    peak, drawdown = values[0], 0.0
    daily: List[float] = []
    for value in values:
        peak = max(peak, value)
        drawdown = min(drawdown, value / peak - 1)
    for left, right in zip(values, values[1:]):
        if left > 0:
            daily.append(right / left - 1)
    volatility = statistics.stdev(daily) * math.sqrt(252) * 100 if len(daily) > 1 else None
    return {"returnPct": round((values[-1] / start - 1) * 100, 2) if start else None,
            "maxDrawdownPct": round(drawdown * 100, 2),
            "volatilityPct": round(volatility, 2) if volatility is not None else None}


def _benchmark_return(curve: List[Dict[str, Any]]) -> Optional[float]:
    values = [float(row["benchmark"]) for row in curve if row.get("benchmark") not in (None, 0)]
    return round((values[-1] / values[0] - 1) * 100, 2) if len(values) > 1 else None


def _with_comparison(metrics: Dict[str, Any], curve: List[Dict[str, Any]], capital_return: Optional[float]) -> Dict[str, Any]:
    """Use like-for-like period returns for strategy/benchmark comparison.

    ``capital_return`` describes the investor cash-flow outcome and is kept as
    a separate field.  Excess return must compare the strategy's time-weighted
    index with the benchmark index over the same dates.
    """
    time_weighted = metrics.get("returnPct")
    benchmark = _benchmark_return(curve)
    metrics["timeWeightedReturnPct"] = time_weighted
    metrics["absoluteReturnPct"] = time_weighted
    metrics["capitalReturnPct"] = capital_return
    metrics["benchmarkReturnPct"] = benchmark
    metrics["excessReturnPct"] = round(time_weighted - benchmark, 2) if time_weighted is not None and benchmark is not None else None
    metrics["returnPct"] = time_weighted
    return metrics


def _sample_curve(curve: List[Dict[str, Any]], target: int = 120) -> List[Dict[str, Any]]:
    """Downsample a chart while always retaining both comparison endpoints."""
    if len(curve) <= target:
        return curve
    step = max(1, math.ceil((len(curve) - 1) / (target - 1)))
    sampled = curve[::step]
    if sampled[-1] is not curve[-1]:
        sampled.append(curve[-1])
    return sampled


def _audit_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """Attach deterministic arithmetic checks without inventing missing data."""
    if result.get("status") != "ok":
        return result
    metrics, cash, curve = result.get("metrics") or {}, result.get("cashFlow") or {}, result.get("curve") or []
    checks: List[Dict[str, Any]] = []

    def check(name: str, actual: Any, expected: Any, tolerance: float = .02) -> None:
        left, right = _number(actual), _number(expected)
        passed = left is not None and right is not None and abs(left - right) <= tolerance
        checks.append({"name": name, "passed": passed,
                       "actual": round(left, 4) if left is not None else None,
                       "expected": round(right, 4) if right is not None else None})

    invested, ending, profit = (_number(cash.get(key)) for key in ("totalInvested", "endingValue", "netProfit"))
    if invested is not None and ending is not None:
        check("现金流恒等式", profit, ending - invested)
    if len(curve) > 1:
        dates = [str(row.get("date") or "") for row in curve]
        checks.append({"name": "曲线日期顺序", "passed": all(left < right for left, right in zip(dates, dates[1:])),
                       "actual": dates[-1] if dates else None, "expected": "日期严格递增"})
        finite_points = all(_number(row.get("value")) is not None and _number(row.get("value")) > 0
                            for row in curve)
        checks.append({"name": "策略曲线有效值", "passed": finite_points,
                       "actual": len(curve), "expected": len(curve)})
        strategy_values = [_number(row.get("value")) for row in curve]
        strategy_values = [value for value in strategy_values if value not in (None, 0)]
        if len(strategy_values) > 1:
            check("策略累计收益率", metrics.get("absoluteReturnPct"),
                  (strategy_values[-1] / strategy_values[0] - 1) * 100)
        benchmark_values = [_number(row.get("benchmark")) for row in curve]
        benchmark_values = [value for value in benchmark_values if value not in (None, 0)]
        if len(benchmark_values) > 1:
            check("基准累计收益率", metrics.get("benchmarkReturnPct"),
                  (benchmark_values[-1] / benchmark_values[0] - 1) * 100)
    absolute, benchmark = _number(metrics.get("absoluteReturnPct")), _number(metrics.get("benchmarkReturnPct"))
    if absolute is not None and benchmark is not None:
        check("超额收益", metrics.get("excessReturnPct"), absolute - benchmark)
    checks.append({"name": "数据日期", "passed": result.get("dataAsOf") == (result.get("period") or {}).get("end"),
                   "actual": result.get("dataAsOf"), "expected": (result.get("period") or {}).get("end")})
    result["audit"] = {
        "passed": bool(checks) and all(row["passed"] for row in checks),
        "checks": checks,
        "formula": "超额收益 = 策略同期累计收益率 - 同期基准收益率",
        "curveBasis": "策略与基准均以回测首个有效观察值归一为 100",
    }
    return result


def _blocked(strategy: Dict[str, Any], reason: str, code: Optional[str] = None) -> Dict[str, Any]:
    return {"status": "blocked", "strategyId": strategy["id"], "strategyName": strategy["name"],
            "strategyVersion": strategy["version"], "fundCode": code, "missingData": [reason],
            "riskStatement": RISK_STATEMENT, "source": strategy["dataBasis"]}


def _signal_for(strategy_id: str, values: List[float], params: Dict[str, Any]) -> Tuple[str, str, Optional[float]]:
    if strategy_id == "rsi-profit":
        value = _rsi(values)
        if value is None:
            return "观察", "历史净值不足以计算 RSI。", value
        if value <= params["buy_threshold_percent"]:
            return "满足分批投入条件", f"RSI {value:.1f} 低于低吸边界 {params['buy_threshold_percent']:.0f}。", value
        return "继续观察", f"RSI {value:.1f} 尚未进入低吸边界。", value
    if strategy_id == "nav-swing":
        value = _position(values, int(params["lookback_periods"]))
        if value is None:
            return "观察", "历史净值不足以判断区间位置。", value
        if value <= params["low_boundary"]:
            return "低位观察", f"当前区间位置约 {value:.1f}%，接近低位边界。", value
        if value >= params["high_boundary"]:
            return "高位观察", f"当前区间位置约 {value:.1f}%，接近高位边界。", value
        return "正常区", f"当前区间位置约 {value:.1f}%，处于正常观察区。", value
    return "观察", "当前策略需要未接入的数据源。", None


def _trend_signal(value: Optional[float]) -> Tuple[str, str, Optional[float]]:
    """Map the Skill's real Donchian state value to its public state names."""
    if value is None:
        return "观察", "当日趋势强弱状态缺失，未产生动作。", None
    if value >= 10:
        return "趋势已明确转强", f"Donchian 趋势状态为 {value:.2f}，达到明确转强区间。", value
    if value > 0:
        return "趋势开始转强", f"Donchian 趋势状态为 {value:.2f}，处于开始转强区间。", value
    if value <= -10:
        return "趋势已明确转弱", f"Donchian 趋势状态为 {value:.2f}，达到明确转弱区间。", value
    if value < 0:
        return "趋势开始转弱", f"Donchian 趋势状态为 {value:.2f}，处于开始转弱区间。", value
    return "趋势中性", "Donchian 趋势状态为 0，暂不动作。", value


def _period_key(date: str, cycle: str) -> str:
    if cycle == "weekly":
        try:
            parsed = dt.date.fromisoformat(date)
            year, week, _ = parsed.isocalendar()
            return f"{year}-W{week:02d}"
        except ValueError:
            pass
    return date[:7]


GEM_FIXED = {
    "years": 5, "reset_percentile": 70.0, "weeks_per_year": 52,
    "trading_days_per_week": 5, "min_reinvest_multiple": 0.15,
    "min_reinvest_cash_ratio": 0.15, "min_reinvest_pct_low": 70.0,
    "min_reinvest_pct_high": 80.0,
    "base_multiples": [(20, 3.5), (30, 2.5), (45, 1.0), (65, .5), (70, .25), (101, 0)],
    "final_caps": [(20, 6.0), (30, 5.0), (45, 3.0), (65, 1.5), (80, .5), (101, 0)],
    "acceleration": [(10, 1.0), (15, 1.25), (20, 1.5), (30, 2.0), (101, 2.5)],
}

INDUSTRY_POOL = [
    ("银行", "011971"), ("证券", "012362"), ("保险", "012605"),
    ("食品饮料", "001631"), ("家电", "008713"), ("农业", "010769"),
    ("医药", "007883"), ("煤炭", "008279"), ("有色", "011630"),
    ("钢铁", "008189"), ("化工", "012537"), ("汽车", "006233"),
    ("军工", "013035"), ("电子", "012550"), ("计算机", "160224"),
    ("通信", "007817"), ("传媒", "010677"), ("半导体", "008887"),
    ("房地产", "008088"), ("光伏", "011102"), ("锂电", "012862"),
    ("人工智能", "008585"), ("国企改革", "007788"),
]


def _band_value(value: float, table: Iterable[Tuple[float, float]]) -> float:
    for upper, result in table:
        if value < upper:
            return float(result)
    return float(list(table)[-1][1])


def _xirr(cashflows: List[Tuple[str, float]]) -> float:
    if len(cashflows) < 2:
        return 0.0
    base = dt.date.fromisoformat(cashflows[0][0])
    days = [(dt.date.fromisoformat(date) - base).days for date, _ in cashflows]
    amounts = [amount for _, amount in cashflows]

    def npv(rate: float) -> float:
        return sum(amount / ((1 + rate) ** (day / 365.0)) for amount, day in zip(amounts, days))

    lo, hi = -.9, 10.0
    if npv(lo) * npv(hi) > 0:
        return 0.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if npv(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _extra_period_key(date: str, frequency: str) -> str:
    value = dt.date.fromisoformat(date)
    if frequency == "每周":
        year, week, _ = value.isocalendar()
        return f"{year}-W{week:02d}"
    if frequency == "每季":
        return f"{value.year}-Q{(value.month - 1) // 3 + 1}"
    if frequency == "每年":
        return str(value.year)
    return f"{value.year}-{value.month:02d}"


def _weekly_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    weeks: Dict[Tuple[int, int], Dict[str, Any]] = {}
    for row in rows:
        date = dt.date.fromisoformat(row["date"])
        year, week, _ = date.isocalendar()
        weeks[(year, week)] = row
    return [weeks[key] for key in sorted(weeks)]


def _run_gem(strategy: Dict[str, Any], code: Optional[str], clean: Dict[str, Any], client: FuyaoClient) -> Dict[str, Any]:
    fund_code = str(code or strategy.get("defaultFundCode") or "")
    if not fund_code.isdigit() or len(fund_code) != 6:
        return _blocked(strategy, "请提供 6 位场外基金代码。")
    try:
        daily = client.fund_series(fund_code, GEM_FIXED["years"])
    except FuyaoError as exc:
        return _blocked(strategy, str(exc), fund_code)
    weekly = _weekly_rows([row for row in daily if row.get("adj_nav") is not None])
    valid = [row for row in weekly if row.get("pe_ttm_5y_pct") is not None]
    if not valid:
        return _blocked(strategy, "同花顺金融数据API未返回可用的创业板指五年 PE 分位数据。", fund_code)
    initial = float(clean["initial_capital"])
    weekly_base = float(clean["weekly_base_amount"])
    growth = float(clean["growth_rate"])
    cash_rate = float(clean["cash_interest_rate"])
    trigger = float(clean["trigger_percentile"])
    daily_redeem = float(clean["daily_redeem_ratio"])
    extra_amount = float(clean["extra_contribution_amount"])
    extra_freq = str(clean["extra_contribution_freq"])
    cash, shares, contributed = initial, 0.0, initial
    start_year = dt.date.fromisoformat(weekly[0]["date"]).year
    last_extra_key: Optional[str] = None
    redeeming, reference_shares = False, 0.0
    first_nav = float(weekly[0]["adj_nav"])
    previous_value = initial
    strategy_index = 100.0
    trades: List[Dict[str, Any]] = []
    curve: List[Dict[str, Any]] = []
    cashflows: List[Tuple[str, float]] = [(weekly[0]["date"], -initial)]
    for index, row in enumerate(weekly):
        date, nav = row["date"], float(row["adj_nav"])
        percentile_value = row.get("pe_ttm_5y_pct")
        percentile = float(percentile_value) if percentile_value is not None else None
        cash *= 1 + cash_rate / GEM_FIXED["weeks_per_year"]
        value_before = cash + shares * nav
        if index:
            strategy_index *= value_before / previous_value if previous_value > 0 else 1.0
        current_year = dt.date.fromisoformat(date).year
        extra_key = _extra_period_key(date, extra_freq)
        if extra_amount > 0 and last_extra_key is not None and extra_key != last_extra_key:
            added = extra_amount * ((1 + growth) ** (current_year - start_year))
            cash += added
            contributed += added
            cashflows.append((date, -added))
        last_extra_key = extra_key
        if percentile is not None and percentile >= trigger and not redeeming:
            redeeming, reference_shares = True, shares
        if redeeming and (percentile is None or percentile < GEM_FIXED["reset_percentile"]):
            redeeming, reference_shares = False, 0.0
        if redeeming and reference_shares > 0 and shares > 0:
            sold = min(shares, reference_shares * daily_redeem * GEM_FIXED["trading_days_per_week"])
            proceeds = sold * nav
            cash += proceeds
            shares -= sold
            trades.append({"date": date, "side": "sell", "amount": round(proceeds, 2), "nav": nav,
                           "holdingAmount": round(shares * nav, 2),
                           "reason": f"PE 分位 {percentile:.1f}% 高于触发线，按规则分批赎回。"})
        total = cash + shares * nav
        cash_ratio = cash / total if total > 0 else 1.0
        base = _band_value(percentile, GEM_FIXED["base_multiples"]) if percentile is not None else 0.0
        acceleration = _band_value(cash_ratio * 100, GEM_FIXED["acceleration"])
        multiple = min(base * acceleration, _band_value(percentile, GEM_FIXED["final_caps"])) if percentile is not None else 0.0
        if percentile is not None and cash_ratio > GEM_FIXED["min_reinvest_cash_ratio"] and GEM_FIXED["min_reinvest_pct_low"] < percentile <= GEM_FIXED["min_reinvest_pct_high"]:
            multiple = max(multiple, GEM_FIXED["min_reinvest_multiple"])
        desired = multiple * weekly_base * ((1 + growth) ** (current_year - start_year))
        buy_amount = min(desired, cash)
        if buy_amount > 0:
            cash -= buy_amount
            shares += buy_amount / nav
            trades.append({"date": date, "side": "buy", "amount": round(buy_amount, 2), "nav": nav,
                           "holdingAmount": round(shares * nav, 2),
                           "reason": f"PE 分位 {percentile:.1f}%，基础倍数 {base:.2f}，最终倍数 {multiple:.2f}。"})
        total = cash + shares * nav
        curve.append({"date": date, "value": round(strategy_index, 4),
                      "benchmark": round(nav / first_nav * 100, 4)})
        previous_value = total
    final_value = cash + shares * float(weekly[-1]["adj_nav"])
    cashflows.append((weekly[-1]["date"], final_value))
    metrics = _metrics([{"date": row["date"], "value": row["value"]} for row in curve])
    metrics = _with_comparison(metrics, curve, round(_xirr(cashflows) * 100, 2))
    metrics.update(trades=len(trades), completedCycles=sum(1 for row in trades if row["side"] == "sell"))
    latest_pct = float(valid[-1]["pe_ttm_5y_pct"])
    latest_state = "高估分批赎回" if latest_pct >= trigger else ("低估加大投入" if latest_pct < 30 else "按分位投入")
    return {
        "status": "ok", "strategyId": strategy["id"], "strategyName": strategy["name"],
        "strategyVersion": strategy["version"], "fundCode": fund_code,
        "source": "同花顺金融数据API（扶摇）· 复权净值 + 创业板指五年 PE 分位",
        "dataAsOf": weekly[-1]["date"], "period": {"start": weekly[0]["date"], "end": weekly[-1]["date"], "observations": len(weekly)},
        "parameters": clean, "cashFlow": {"totalInvested": round(contributed, 2), "endingValue": round(final_value, 2),
            "netProfit": round(final_value - contributed, 2), "fees": 0.0,
            "feeNote": "Skill v0.3.21 的回测口径暂不计申购费和赎回费。"},
        "metrics": metrics, "curve": _sample_curve(curve), "trades": trades,
        "benchmarkName": "基金复权净值",
        "latestSignal": {"state": latest_state, "reason": f"最新创业板指五年 PE 分位为 {latest_pct:.1f}%。", "value": latest_pct},
        "riskStatement": RISK_STATEMENT,
        "limitations": ["费用按 Skill 原始口径记为 0，不代表实际交易免费。", "曲线以 100 为基期指数。"]
    }


def _zscore(values: Dict[str, float]) -> Dict[str, float]:
    usable = [value for value in values.values() if math.isfinite(value)]
    if len(usable) < 2:
        return {key: 0.0 for key in values}
    mean, spread = statistics.fmean(usable), statistics.stdev(usable)
    if spread == 0:
        return {key: 0.0 for key in values}
    return {key: (value - mean) / spread for key, value in values.items()}


def _industry_weights(scores: Dict[str, float], vols: Dict[str, float], scheme: str) -> Dict[str, float]:
    names = list(scores)
    if not names:
        return {}
    if scheme == "equal":
        return {name: 1 / len(names) for name in names}
    if scheme == "rank":
        ranked = sorted(names, key=lambda name: scores[name], reverse=True)
        raw = {name: len(names) - ranked.index(name) for name in names}
    elif scheme == "score":
        floor = min(scores.values())
        raw = {name: max(0.0, scores[name] - floor) for name in names}
    else:
        raw = {name: (1 / vols[name] if vols.get(name, 0) > 0 else 0.0) for name in names}
    total = sum(raw.values())
    return {name: (raw[name] / total if total > 0 else 1 / len(names)) for name in names}


def _redeem_rate(hold_days: int) -> float:
    if hold_days < 7:
        return .015
    if hold_days < 365:
        return .005
    return 0.0


def _run_industry(strategy: Dict[str, Any], clean: Dict[str, Any], client: FuyaoClient) -> Dict[str, Any]:
    series: Dict[str, List[Tuple[str, float]]] = {}
    missing: List[str] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        jobs = {pool.submit(client.fund_nav, code, "fyear"): (name, code) for name, code in INDUSTRY_POOL}
        for future in as_completed(jobs):
            name, code = jobs[future]
            try:
                rows = future.result()
                if rows:
                    series[name] = rows
                else:
                    missing.append(f"{name}({code})")
            except FuyaoError:
                missing.append(f"{name}({code})")
    if len(series) < 3:
        return _blocked(strategy, "行业基金池可用标的少于 3 只，无法运行轮动。")
    maps = {name: dict(rows) for name, rows in series.items()}
    common_dates = sorted(set.intersection(*(set(rows) for rows in maps.values())))
    slow = int(clean["ma_slow"])
    if len(common_dates) < slow + 40:
        return _blocked(strategy, "行业基金池的同期复权净值不足，无法计算长期均线。")
    fast, top_k = int(clean["ma_fast"]), int(clean["top_k"])
    names = sorted(series)
    values = {name: [maps[name][date] for date in common_dates] for name in names}
    targets: List[Dict[str, float]] = []
    current = {name: 0.0 for name in names}
    for index, date in enumerate(common_dates):
        is_month_start = index == 0 or date[:7] != common_dates[index - 1][:7]
        if is_month_start and index + 1 >= slow:
            trend = {name: statistics.fmean(values[name][index-fast+1:index+1]) - statistics.fmean(values[name][index-slow+1:index+1]) for name in names}
            momentum = {name: values[name][index] / values[name][max(0, index-20)] - 1 for name in names}
            ztrend, zmomentum = _zscore(trend), _zscore(momentum)
            scores = {name: ztrend[name] + zmomentum[name] for name in names}
            selected = sorted(names, key=lambda name: scores[name], reverse=True)[:top_k]
            vols: Dict[str, float] = {}
            for name in selected:
                window = values[name][max(0, index-20):index+1]
                returns = [right / left - 1 for left, right in zip(window, window[1:]) if left > 0]
                vols[name] = statistics.stdev(returns) if len(returns) > 1 else 0.0
            chosen = _industry_weights({name: scores[name] for name in selected}, vols, str(clean["weight_scheme"]))
            current = {name: chosen.get(name, 0.0) for name in names}
        targets.append(dict(current))
    end_date = dt.date.fromisoformat(common_dates[-1])
    try:
        start_cutoff = end_date.replace(year=end_date.year - 4)
    except ValueError:
        start_cutoff = end_date.replace(year=end_date.year - 4, day=28)
    start_index = next((i for i, value in enumerate(common_dates) if dt.date.fromisoformat(value) >= start_cutoff), slow)
    dates = common_dates[start_index:]
    initial = float(clean["initial_capital"])
    cash = initial
    lots: Dict[str, List[Dict[str, float]]] = {name: [] for name in names}
    strategy_index, previous_value = 100.0, initial
    trades: List[Dict[str, Any]] = []
    curve: List[Dict[str, Any]] = []
    total_fees = 0.0
    try:
        benchmark_rows = client.index_history("000300.SH", dates[0], dates[-1])
        benchmark_map = dict(benchmark_rows)
    except FuyaoError:
        benchmark_map = {}
    benchmark_first = next((benchmark_map[date] for date in dates if date in benchmark_map), None)

    def shares_of(name: str) -> float:
        return sum(lot["shares"] for lot in lots[name])

    for local_index, date in enumerate(dates):
        source_index = start_index + local_index
        navs = {name: maps[name][date] for name in names}
        value_before = cash + sum(shares_of(name) * navs[name] for name in names)
        if local_index:
            strategy_index *= value_before / previous_value if previous_value > 0 else 1.0
        is_month_start = local_index == 0 or date[:7] != dates[local_index - 1][:7]
        desired = targets[source_index - 1] if source_index > 0 else {name: 0.0 for name in names}
        if is_month_start:
            current_weights = {name: shares_of(name) * navs[name] / value_before if value_before > 0 else 0 for name in names}
            for name in names:
                if desired[name] >= current_weights[name] - 1e-8:
                    continue
                target_value = desired[name] * value_before
                to_sell = max(0.0, shares_of(name) - target_value / navs[name])
                remaining, gross, fees = to_sell, 0.0, 0.0
                for lot in lots[name]:
                    if remaining <= 1e-12 or lot["shares"] <= 0:
                        continue
                    take = min(remaining, lot["shares"])
                    amount = take * navs[name]
                    fee = amount * _redeem_rate((dt.date.fromisoformat(date) - dt.date.fromisoformat(str(lot["date"]))).days)
                    lot["shares"] -= take
                    remaining -= take
                    gross += amount
                    fees += fee
                if gross > 0:
                    cash += gross - fees
                    total_fees += fees
                    trades.append({"date": date, "side": "sell", "amount": round(gross, 2), "nav": navs[name],
                                   "holdingAmount": round(sum(shares_of(item) * navs[item] for item in names), 2),
                                   "reason": f"月度轮动移出{name}，赎回费 {fees:.2f} 元。"})
            for name in names:
                gap = desired[name] - current_weights[name]
                if gap <= 1e-8:
                    continue
                buy_amount = min(gap * value_before, cash)
                if buy_amount <= 0:
                    continue
                net = buy_amount / 1.0015
                fee = buy_amount - net
                shares = net / navs[name]
                cash -= buy_amount
                total_fees += fee
                lots[name].append({"date": date, "shares": shares})
                trades.append({"date": date, "side": "buy", "amount": round(buy_amount, 2), "nav": navs[name],
                               "holdingAmount": round(sum(shares_of(item) * navs[item] for item in names), 2),
                               "reason": f"月度轮动选入{name}，目标权重 {desired[name]*100:.1f}%。"})
        value_now = cash + sum(shares_of(name) * navs[name] for name in names)
        benchmark = None
        if benchmark_first and date in benchmark_map:
            benchmark = benchmark_map[date] / benchmark_first * 100
        strategy_index = value_now / initial * 100 if initial > 0 else 0.0
        curve.append({"date": date, "value": round(strategy_index, 4), "benchmark": round(benchmark, 4) if benchmark is not None else None})
        previous_value = value_now
    ending = cash + sum(shares_of(name) * maps[name][dates[-1]] for name in names)
    metrics = _metrics([{"date": row["date"], "value": row["value"]} for row in curve])
    metrics = _with_comparison(metrics, curve, round((ending / initial - 1) * 100, 2) if initial > 0 else None)
    metrics.update(trades=len(trades), completedCycles=sum(1 for row in trades if row["side"] == "sell"))
    latest_target = targets[-1]
    selected_now = [name for name, weight in sorted(latest_target.items(), key=lambda pair: pair[1], reverse=True) if weight > 0]
    pool_public = [{"industry": name, "fundCode": code, "used": name in series} for name, code in INDUSTRY_POOL]
    return {
        "status": "ok", "strategyId": strategy["id"], "strategyName": strategy["name"],
        "strategyVersion": strategy["version"], "fundCode": None, "fundPool": pool_public,
        "source": "同花顺金融数据API（扶摇）· 行业基金复权净值池",
        "dataAsOf": dates[-1], "period": {"start": dates[0], "end": dates[-1], "observations": len(dates)},
        "parameters": clean, "cashFlow": {"totalInvested": round(initial, 2), "endingValue": round(ending, 2),
            "netProfit": round(ending - initial, 2), "fees": round(total_fees, 2),
            "feeNote": "按 Skill v0.3.9 默认申购费 0.15% 和持有期赎回费阶梯计算。"},
        "metrics": metrics, "curve": _sample_curve(curve), "trades": trades,
        "benchmarkName": "沪深300",
        "latestSignal": {"state": ("持有：" + "、".join(selected_now)) if selected_now else "现金观察",
            "reason": f"最新月度轮动选出 {len(selected_now)} 个行业，按 {clean['weight_scheme']} 分配。", "value": None},
        "riskStatement": RISK_STATEMENT,
        "limitations": (["未取得的基金：" + "、".join(missing)] if missing else []) + ["曲线以 100 为基期指数，基准为沪深300。"]
    }


def run_backtest(strategy_id: str, code: Optional[str], params: Optional[Dict[str, Any]], runtime) -> Dict[str, Any]:
    strategy = get_strategy(strategy_id)
    clean = validate_params(strategy_id, params)
    client = FuyaoClient(runtime)
    if strategy_id == "gem-valuation":
        return _audit_result(_run_gem(strategy, code, clean, client))
    if strategy_id == "industry-trend":
        return _audit_result(_run_industry(strategy, clean, client))
    if not code or not str(code).isdigit() or len(str(code)) != 6:
        return _blocked(strategy, "请提供 6 位场外基金代码后运行真实回测。")
    trend_states: Dict[str, float] = {}
    source = "扶摇 Fuyao · 复权净值"
    try:
        if strategy_id == "trend-strength":
            series = client.fund_series(str(code), 5)
            usable = [row for row in series if row.get("adj_nav") is not None and row.get("donchian_channel") is not None]
            if usable:
                end = dt.date.fromisoformat(usable[-1]["date"])
                try:
                    cutoff = end.replace(year=end.year - 3)
                except ValueError:
                    cutoff = end.replace(year=end.year - 3, day=28)
                usable = [row for row in usable if dt.date.fromisoformat(row["date"]) >= cutoff]
            rows = [(row["date"], float(row["adj_nav"])) for row in usable]
            trend_states = {row["date"]: float(row["donchian_channel"]) for row in usable}
            source = "扶摇 Fuyao · 复权净值 + Donchian 趋势状态"
        else:
            rows = client.fund_nav(str(code))
    except FuyaoError as exc:
        return _blocked(strategy, str(exc), str(code))
    if len(rows) < 60:
        missing = "真实趋势状态少于 60 个交易日，暂不足以运行该策略。" if strategy_id == "trend-strength" else "历史复权净值少于 60 个交易日，暂不足以运行该策略。"
        return _blocked(strategy, missing, str(code))
    values = [float(value) for _, value in rows]
    dates = [date for date, _ in rows]
    amount = float(clean["amount"])
    cash, units, cost_basis, invested = 0.0, 0.0, 0.0, 0.0
    trades: List[Dict[str, Any]] = []
    curve: List[Dict[str, Any]] = []
    cycle_counts: Dict[str, int] = {}
    previous_signal: Optional[str] = None
    completed_cycles = 0
    strategy_index, previous_post_value = 100.0, None
    for index, (date, nav) in enumerate(rows):
        value_before_trades = cash + units * nav
        if previous_post_value and previous_post_value > 0:
            strategy_index *= value_before_trades / previous_post_value
        history = values[: index + 1]
        signal, reason, indicator = (_trend_signal(trend_states.get(date)) if strategy_id == "trend-strength"
                                     else _signal_for(strategy_id, history, clean))
        cycle = _period_key(date, clean.get("buy_cycle", "monthly"))
        limit = int(clean.get("max_buy_times", 1))
        can_buy = cycle_counts.get(cycle, 0) < limit
        buy_amount = amount
        buy = False
        sell_ratio = 0.0
        sell_reason = ""
        if strategy_id == "rsi-profit":
            buy = signal == "满足分批投入条件" and can_buy
            if units > 0 and cost_basis > 0 and nav / (cost_basis / units) - 1 >= clean["target_profit_percent"] / 100:
                sell_ratio, sell_reason = 1.0, f"持仓收益达到目标退出边界 {clean['target_profit_percent']:.0f}%。"
        elif strategy_id == "nav-swing":
            previous_position = _position(values[:index], int(clean["lookback_periods"])) if index else None
            entered_low = signal == "低位观察" and (clean["action_mode"] == "sensitive" or previous_signal != "低位观察")
            buy = entered_low and can_buy
            if buy and previous_position is not None and previous_position <= clean["low_boundary"]:
                buy_amount *= float(clean["add_multiplier"])
            if units > 0 and signal == "高位观察" and previous_signal not in {"高位观察", "高位转弱"}:
                sell_ratio, sell_reason = float(clean["sell_ratio"]), "高位转弱，按策略默认减仓比例模拟。"
        elif strategy_id == "trend-strength":
            if clean["trend_mode"] == "confirmed":
                buy_states, sell_states = {"趋势已明确转强"}, {"趋势已明确转弱"}
            else:
                buy_states = {"趋势开始转强", "趋势已明确转强"}
                sell_states = {"趋势开始转弱", "趋势已明确转弱"}
            # A qualifying state can trigger multiple staged purchases, but
            # the selected weekly/monthly limit is always enforced.
            buy = signal in buy_states and can_buy
            if units > 0 and signal in sell_states:
                sell_ratio, sell_reason = 1.0, f"{signal}，提出退出本计划已确认份额。"
        if sell_ratio > 0 and units > 0:
            sold_units = units * min(1.0, sell_ratio)
            proceeds = sold_units * nav
            units -= sold_units
            cash += proceeds
            cost_basis *= max(0.0, 1.0 - min(1.0, sell_ratio))
            if sell_ratio >= 1.0:
                completed_cycles += 1
            trades.append({"date": date, "side": "sell", "amount": round(proceeds, 2), "nav": nav,
                           "holdingAmount": round(units * nav, 2), "reason": sell_reason})
        if buy:
            units += buy_amount / nav
            cost_basis += buy_amount
            invested += buy_amount
            cycle_counts[cycle] = cycle_counts.get(cycle, 0) + 1
            trades.append({"date": date, "side": "buy", "amount": round(buy_amount, 2), "nav": nav,
                           "holdingAmount": round(units * nav, 2), "reason": reason})
        value_now = cash + units * nav
        curve.append({"date": date, "value": round(strategy_index, 4),
                      "benchmark": round(nav / values[0] * 100, 4)})
        previous_post_value = value_now
        previous_signal = signal
    ending = cash + units * values[-1]
    latest_state, latest_reason, latest_value = (_trend_signal(trend_states.get(dates[-1])) if strategy_id == "trend-strength"
                                                 else _signal_for(strategy_id, values, clean))
    metrics = _metrics(curve)
    metrics = _with_comparison(metrics, curve, round((ending / invested - 1) * 100, 2) if invested > 0 else None)
    result = {"status": "ok", "strategyId": strategy_id, "strategyName": strategy["name"], "strategyVersion": strategy["version"],
            "fundCode": str(code), "source": source, "dataAsOf": dates[-1],
            "period": {"start": dates[0], "end": dates[-1], "observations": len(rows)},
            "parameters": clean, "cashFlow": {"totalInvested": round(invested, 2), "endingValue": round(ending, 2),
                                                "netProfit": round(ending - invested, 2), "fees": None,
                                                "feeNote": "历史费率序列未随净值返回；结果未虚构费用，实际费率需按销售平台核对。"},
            "metrics": {**metrics, "trades": len(trades), "completedCycles": completed_cycles},
            "curve": _sample_curve(curve), "trades": trades, "benchmarkName": "基金复权净值",
            "latestSignal": {"state": latest_state, "reason": latest_reason, "value": latest_value},
            "riskStatement": RISK_STATEMENT, "limitations": ["没有把历史费率或真实现金流补入结果。", "这是历史规则模拟，不是账户实际收益。"]}
    return _audit_result(result)


def run_showcase(strategy_id: str, runtime) -> Dict[str, Any]:
    """Run the fixed default parameters and choose the highest excess return.

    The comparison universe is published in the catalog so the UI never calls
    a fund "best" without also exposing the finite candidate set.
    """
    strategy = get_strategy(strategy_id)
    candidates = strategy.get("showcaseCandidates") or ([{"code": None, "name": "固定行业基金池"}]
                                                         if strategy.get("codeRequired") is False else [])
    if not candidates:
        return {"status": "blocked", "strategyId": strategy_id, "missingData": ["策略未配置可审计的案例候选池。"]}
    results: List[Dict[str, Any]] = []
    for candidate in candidates:
        result = run_backtest(strategy_id, candidate.get("code"), strategy.get("defaultParams") or {}, runtime)
        result["candidateName"] = candidate.get("name")
        results.append(result)
    eligible = [result for result in results if result.get("status") == "ok" and
                _number((result.get("metrics") or {}).get("excessReturnPct")) is not None]
    if not eligible:
        missing = [f"{row.get('candidateName') or row.get('fundCode') or '固定基金池'}：{';'.join(row.get('missingData') or ['缺少可比收益'])}"
                   for row in results]
        return {"status": "blocked", "strategyId": strategy_id, "candidateCount": len(candidates),
                "eligibleCount": 0, "missingData": missing}
    best = max(eligible, key=lambda row: (
        float((row.get("metrics") or {}).get("excessReturnPct")),
        float((row.get("metrics") or {}).get("absoluteReturnPct") or -math.inf),
    ))
    ranking = [{
        "fundCode": row.get("fundCode"), "fundName": row.get("candidateName"),
        "status": row.get("status"), "dataAsOf": row.get("dataAsOf"),
        "absoluteReturnPct": (row.get("metrics") or {}).get("absoluteReturnPct"),
        "benchmarkReturnPct": (row.get("metrics") or {}).get("benchmarkReturnPct"),
        "excessReturnPct": (row.get("metrics") or {}).get("excessReturnPct"),
        "auditPassed": (row.get("audit") or {}).get("passed"),
        "missingData": row.get("missingData") or [],
    } for row in sorted(results, key=lambda row: _number((row.get("metrics") or {}).get("excessReturnPct"), -math.inf), reverse=True)]
    best["showcase"] = {
        "selectionMetric": "excessReturnPct", "candidateCount": len(candidates),
        "eligibleCount": len(eligible), "formula": "策略同期累计收益率 - 同期基准收益率",
    }
    return {"status": "ok", "strategyId": strategy_id, "strategyVersion": strategy["version"],
            "candidateCount": len(candidates), "eligibleCount": len(eligible),
            "selectionMetric": "excessReturnPct", "best": best, "ranking": ranking}


def latest_signal(strategy_id: str, code: str, params: Optional[Dict[str, Any]], runtime) -> Dict[str, Any]:
    strategy = get_strategy(strategy_id)
    clean = validate_params(strategy_id, params)
    if strategy_id in {"gem-valuation", "industry-trend"}:
        result = run_backtest(strategy_id, code, clean, runtime)
        if result.get("status") != "ok":
            return result
        signal = result.get("latestSignal") or {}
        return {"status": "ok", "strategyId": strategy_id, "strategyName": strategy["name"],
                "strategyVersion": strategy["version"], "fundCode": result.get("fundCode"),
                "dataAsOf": result.get("dataAsOf"), "state": signal.get("state"),
                "reason": signal.get("reason"), "indicator": signal.get("value"),
                "source": result.get("source"), "riskStatement": RISK_STATEMENT}
    try:
        rows = FuyaoClient(runtime).fund_nav(code)
    except FuyaoError as exc:
        return _blocked(strategy, str(exc), code)
    if not rows:
        return _blocked(strategy, "未返回可用复权净值。", code)
    values = [float(value) for _, value in rows]
    state, reason, value = _signal_for(strategy_id, values, clean)
    return {"status": "ok", "strategyId": strategy_id, "strategyName": strategy["name"], "strategyVersion": strategy["version"],
            "fundCode": code, "dataAsOf": rows[-1][0], "state": state, "reason": reason, "indicator": value,
            "source": "扶摇 Fuyao · 复权净值", "riskStatement": RISK_STATEMENT}
