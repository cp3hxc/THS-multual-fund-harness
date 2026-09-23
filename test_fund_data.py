"""Deterministic checks for the portfolio-analysis contract."""
import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fund_data


class FakeFuyao:
    def __init__(self):
        start = dt.date(2026, 1, 1)
        self.dates = [(start + dt.timedelta(days=i)).isoformat() for i in range(45)]

    def fund_nav(self, code):
        if code == '000001':
            return list(zip(self.dates, [100 + i for i in range(45)]))
        return list(zip(self.dates, [100 - i * .4 for i in range(45)]))

    def fund_profile(self, code):
        return {'manager_name': '测试经理'}

    def benchmark(self, start, end):
        return list(zip(self.dates, [100 + i * .2 for i in range(45)]))


class PortfolioAnalysis(unittest.TestCase):
    def test_current_weight_analysis_and_strategy_coverage(self):
        holdings = [
            {'fundCode': '000001', 'fundName': '示例混合A', 'totalAmount': '600'},
            {'fundCode': '110020', 'fundName': '示例沪深300指数A', 'totalAmount': '400'},
        ]
        strategies = [{'status': 'draft', 'codes': ['110020']}]
        with tempfile.TemporaryDirectory() as directory, patch('fund_data.FuyaoClient', return_value=FakeFuyao()):
            result = fund_data.portfolio_analysis(holdings, strategies, Path(directory))
        self.assertEqual(result['totalAmount'], 1000)
        self.assertEqual(result['coveragePct'], 40)
        self.assertEqual(result['dataCoveragePct'], 100)
        self.assertGreaterEqual(len(result['history']), 20)
        self.assertEqual(len(result['correlation']['values']), 2)
        self.assertIn('已确认持仓金额为固定权重', result['method'])

    def test_pending_position_is_separate_and_excluded_from_history(self):
        holdings = [
            {'fundCode': '000001', 'fundName': '示例混合A', 'totalAmount': '600',
             'holdVol': '100.00'},
            {'fundCode': '110020', 'fundName': '示例沪深300指数A', 'totalAmount': '400',
             'holdVol': '待确认'},
        ]
        with tempfile.TemporaryDirectory() as directory, patch('fund_data.FuyaoClient', return_value=FakeFuyao()):
            result = fund_data.portfolio_analysis(holdings, [], Path(directory))
        self.assertEqual(result['totalAmount'], 1000)
        self.assertEqual(result['confirmedAmount'], 600)
        self.assertEqual(result['pendingAmount'], 400)
        self.assertEqual(result['simulationAmount'], 600)
        self.assertEqual(result['dataCoveragePct'], 100)
        self.assertEqual(result['funds'][0]['code'], '000001')
        pending = next(x for x in result['allocations'] if x['name'] == '待确认资金')
        self.assertEqual(pending['amount'], 400)
        self.assertEqual(pending['percent'], 40)


if __name__ == '__main__':
    unittest.main()
