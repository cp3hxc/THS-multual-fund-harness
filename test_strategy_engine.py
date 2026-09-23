import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import server
import strategy_engine


class FakeFuyao:
    def __init__(self, runtime):
        self.runtime = runtime

    def fund_nav(self, code, range_='tyear'):
        rows = []
        value = 1.0
        start = __import__('datetime').date(2024, 1, 2)
        for index in range(420):
            value *= 1 + (0.006 if index % 23 < 9 else -0.004)
            rows.append(((start + __import__('datetime').timedelta(days=index)).isoformat(), value))
        return rows

    def fund_series(self, code, years=5):
        return [
            {'date': date, 'adj_nav': value, 'pe_ttm_5y_pct': 15 + (index % 75),
             'donchian_channel': 10 if index % 40 < 24 else -10}
            for index, (date, value) in enumerate(self.fund_nav(code, 'fyear'))
        ]

    def index_history(self, code, start, end):
        return [(date, value * 1000) for date, value in self.fund_nav('000300', 'fyear') if start <= date <= end]


class FakeIndustryFuyao(FakeFuyao):
    def fund_nav(self, code, range_='tyear'):
        rows = []
        value = 1.0 + (int(code[-2:]) % 7) / 100
        start = __import__('datetime').date(2021, 1, 4)
        for index in range(1500):
            value *= 1 + (((index + int(code[-2:])) % 31) - 13) / 10000
            rows.append(((start + __import__('datetime').timedelta(days=index)).isoformat(), value))
        return rows


class StrategyEngineTests(unittest.TestCase):
    def test_catalog_has_the_five_fixed_skill_versions(self):
        catalog = {item['id']: item for item in strategy_engine.catalog()}
        self.assertEqual(set(catalog), {'rsi-profit', 'nav-swing', 'trend-strength', 'gem-valuation', 'industry-trend'})
        self.assertEqual(catalog['rsi-profit']['version'], '2.1.10')
        self.assertEqual(catalog['nav-swing']['version'], '2.4.1')
        self.assertEqual(catalog['trend-strength']['version'], '2.2.5')
        self.assertEqual(catalog['gem-valuation']['version'], '0.3.21')
        self.assertEqual(catalog['industry-trend']['version'], '0.3.9')
        self.assertTrue(all(spec.get('help') for item in catalog.values() for spec in item['params']))
        self.assertTrue(all(item.get('defaultFundCode') for item in catalog.values()
                            if item.get('codeRequired') is not False))

    def test_specialized_strategies_use_their_real_data_contracts(self):
        with patch.object(strategy_engine, 'FuyaoClient', FakeIndustryFuyao):
            gem = strategy_engine.run_backtest('gem-valuation', '007664', {}, Path('/tmp'))
            industry = strategy_engine.run_backtest('industry-trend', None, {}, Path('/tmp'))
        self.assertEqual(gem['status'], 'ok')
        self.assertIn('PE 分位', gem['source'])
        self.assertTrue(gem['trades'])
        self.assertEqual(industry['status'], 'ok')
        self.assertEqual(len(industry['fundPool']), len(strategy_engine.INDUSTRY_POOL))
        self.assertIn('行业基金复权净值池', industry['source'])

    def test_single_fund_backtest_uses_real_nav_adapter_and_returns_auditable_result(self):
        with patch.object(strategy_engine, 'FuyaoClient', FakeFuyao):
            result = strategy_engine.run_backtest('trend-strength', '000001', {}, Path('/tmp'))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['fundCode'], '000001')
        self.assertEqual(result['source'], '扶摇 Fuyao · 复权净值 + Donchian 趋势状态')
        self.assertIn('dataAsOf', result)
        self.assertIn('riskStatement', result)
        self.assertIn('curve', result)
        self.assertIsNone(result['cashFlow']['fees'])
        self.assertIn('absoluteReturnPct', result['metrics'])
        self.assertIn('benchmarkReturnPct', result['metrics'])
        self.assertIn('excessReturnPct', result['metrics'])
        self.assertEqual(result['curve'][0]['value'], 100.0)
        self.assertEqual(result['curve'][-1]['date'], result['period']['end'])
        self.assertTrue(result['audit']['passed'])
        self.assertAlmostEqual(
            result['metrics']['excessReturnPct'],
            result['metrics']['absoluteReturnPct'] - result['metrics']['benchmarkReturnPct'],
            places=2,
        )

    def test_showcase_uses_default_params_and_selects_highest_excess_return(self):
        strategy = strategy_engine.get_strategy('trend-strength')
        candidates = strategy['showcaseCandidates']

        def fake_backtest(strategy_id, code, params, runtime):
            rank = {candidate['code']: index for index, candidate in enumerate(candidates)}
            excess = float(rank[code])
            return {
                'status': 'ok', 'strategyId': strategy_id, 'strategyVersion': strategy['version'],
                'fundCode': code, 'parameters': dict(params), 'dataAsOf': '2026-09-18',
                'metrics': {'absoluteReturnPct': 10 + excess, 'benchmarkReturnPct': 10, 'excessReturnPct': excess},
                'audit': {'passed': True},
            }

        with patch.object(strategy_engine, 'run_backtest', side_effect=fake_backtest):
            report = strategy_engine.run_showcase('trend-strength', Path('/tmp'))
        self.assertEqual(report['best']['fundCode'], candidates[-1]['code'])
        self.assertEqual(report['candidateCount'], len(candidates))
        self.assertEqual(report['selectionMetric'], 'excessReturnPct')
        self.assertEqual(report['best']['parameters'], strategy['defaultParams'])

    def test_parameter_boundary_is_rejected(self):
        with self.assertRaises(ValueError):
            strategy_engine.validate_params('industry-trend', {'ma_fast': 300, 'ma_slow': 100})

    def test_amount_step_accepts_round_hundreds_and_rejects_legacy_offset(self):
        for strategy_id in ('rsi-profit', 'nav-swing', 'trend-strength'):
            self.assertEqual(strategy_engine.validate_params(strategy_id, {'amount': 1000})['amount'], 1000)
            with self.assertRaises(ValueError):
                strategy_engine.validate_params(strategy_id, {'amount': 901})

    def test_default_trend_uses_real_state_and_honors_staged_buy_limit(self):
        with patch.object(strategy_engine, 'FuyaoClient', FakeFuyao):
            result = strategy_engine.run_backtest('trend-strength', '000001', {}, Path('/tmp'))
        buys = [row for row in result['trades'] if row['side'] == 'buy']
        self.assertIn('Donchian 趋势状态', result['source'])
        self.assertGreater(len(buys), 4)
        self.assertTrue(all(row.get('holdingAmount') is not None for row in result['trades']))
        per_month = {}
        for row in buys:
            per_month[row['date'][:7]] = per_month.get(row['date'][:7], 0) + 1
        self.assertLessEqual(max(per_month.values()), 3)


class StrategyPlanTests(unittest.TestCase):
    def test_strategy_variant_versions_only_supported_parameters(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            with patch.object(server, 'RUNTIME', runtime), \
                 patch.object(server, 'STATE_PATH', runtime / 'state.json'):
                first = server.strategy_variant_save({
                    'strategyId': 'trend-strength', 'name': '低频趋势', 'code': '000001',
                    'description': '每月检查', 'params': {'max_buy_times': 1}
                })
                second = server.strategy_variant_save({
                    'id': first['id'], 'strategyId': 'trend-strength', 'name': '低频趋势',
                    'code': '000001', 'description': '降低操作次数',
                    'params': {'max_buy_times': 2}
                })
                self.assertEqual(second['version'], 2)
                self.assertEqual(server.strategy_variants()[0]['params']['max_buy_times'], 2)
                with self.assertRaises(ValueError):
                    strategy_engine.validate_params('trend-strength', {'max_buy_times': 99})

    def test_async_backtest_job_reports_stages_and_persists_result(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            result = {'status': 'blocked', 'strategyId': 'trend-strength',
                      'strategyVersion': '2.2.5', 'fundCode': '000001',
                      'missingData': ['测试缺项']}
            with patch.object(server, 'RUNTIME', runtime), \
                 patch.object(server, 'STATE_PATH', runtime / 'state.json'), \
                 patch.object(server, 'run_backtest', return_value=result):
                started = server.strategy_job_start({
                    'strategyId': 'trend-strength', 'code': '000001', 'params': {}
                })
                for _ in range(100):
                    job = server.strategy_job_read(started['jobId'])
                    if job['status'] != 'running':
                        break
                    time.sleep(.005)
                self.assertEqual(job['status'], 'completed')
                self.assertEqual(job['progress'], 100)
                self.assertGreaterEqual(len(job['logs']), 5)
                self.assertEqual(len(server.state_read()['strategyRuns']), 1)
                self.assertEqual(server.state_read()['strategyRuns'][0]['result']['status'], 'blocked')

    def test_plan_keeps_linked_backtest_performance_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            result = {
                'status': 'ok', 'strategyId': 'trend-strength', 'strategyVersion': '2.2.5',
                'fundCode': '000001', 'dataAsOf': '2026-09-18', 'parameters': {},
                'metrics': {'returnPct': 8.0, 'absoluteReturnPct': 8.0, 'benchmarkReturnPct': 6.0, 'excessReturnPct': 2.0},
                'cashFlow': {'totalInvested': 10000, 'netProfit': 800, 'endingValue': 10800},
                'audit': {'passed': True, 'formula': '超额收益 = 策略同期累计收益率 - 同期基准收益率'},
            }
            with patch.object(server, 'RUNTIME', runtime), patch.object(server, 'STATE_PATH', runtime / 'state.json'):
                persisted = server._persist_strategy_run(result, {'params': {}})
                plan = server.strategy_plan_create({
                    'strategyId': 'trend-strength', 'code': '000001', 'amount': 1000,
                    'params': {}, 'name': '测试计划', 'runId': persisted['runId'],
                    'dataAsOf': persisted['dataAsOf'],
                })
                self.assertEqual(plan['performance']['kind'], 'backtest_snapshot')
                self.assertEqual(plan['performance']['totalInvested'], 10000)
                self.assertEqual(plan['performance']['benchmarkReturnPct'], 6.0)
                self.assertEqual(plan['performance']['excessReturnPct'], 2.0)

    def test_legacy_plan_performance_is_recomputed_with_same_plan_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            state_path = runtime / 'state.json'
            params = strategy_engine.validate_params('trend-strength', {})
            legacy = {
                'id': 'plan-1', 'name': '旧计划', 'strategyId': 'trend-strength',
                'strategyVersion': '2.2.5', 'fundCode': '000628', 'params': params,
                'status': 'active', 'performance': None,
            }
            state_path.write_text(__import__('json').dumps({
                'strategies': [], 'watchlist': [], 'drafts': [], 'strategyPlans': [legacy],
                'strategyEvents': [], 'strategyRuns': [], 'strategyVariants': [],
            }), encoding='utf-8')
            result = {
                'status': 'ok', 'strategyId': 'trend-strength', 'strategyVersion': '2.2.5',
                'fundCode': '000628', 'dataAsOf': '2026-09-18', 'parameters': params,
                'metrics': {'absoluteReturnPct': 10.0, 'benchmarkReturnPct': 12.0, 'excessReturnPct': -2.0},
                'cashFlow': {'totalInvested': 4000, 'netProfit': 400, 'endingValue': 4400},
                'audit': {'passed': True, 'formula': '超额收益 = 策略同期累计收益率 - 同期基准收益率'},
            }
            with patch.object(server, 'RUNTIME', runtime), patch.object(server, 'STATE_PATH', state_path), \
                 patch.object(server, 'run_backtest', return_value=result) as backtest:
                plans = server.strategy_plans_refresh_performance()
            backtest.assert_called_once_with('trend-strength', '000628', params, runtime)
            self.assertEqual(plans[0]['performance']['benchmarkReturnPct'], 12.0)
            self.assertEqual(plans[0]['performance']['excessReturnPct'], -2.0)

    def test_plan_lifecycle_and_signal_deduplication(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            state_path = runtime / 'state.json'
            with patch.object(server, 'RUNTIME', runtime), patch.object(server, 'STATE_PATH', state_path):
                params = strategy_engine.get_strategy('trend-strength')['defaultParams']
                plan = server.strategy_plan_create({
                    'strategyId': 'trend-strength', 'code': '000001', 'amount': 1000,
                    'params': params, 'name': '测试趋势计划'
                })
                self.assertEqual(plan['status'], 'draft')
                enabled = server.strategy_plan_action({'id': plan['id'], 'action': 'enable'})
                self.assertEqual(enabled['status'], 'active')
                signal = {
                    'status': 'ok', 'state': '趋势偏强', 'reason': '测试信号', 'indicator': 0.03,
                    'dataAsOf': '2026-09-18', 'source': '测试复权净值', 'missingData': []
                }
                with patch.object(server, 'latest_signal', return_value=signal):
                    server.strategy_plan_action({'id': plan['id'], 'action': 'check'})
                    server.strategy_plan_action({'id': plan['id'], 'action': 'check'})
                state = server.state_read()
                self.assertEqual(len(state['strategyEvents']), 1)
                self.assertEqual(state['strategyPlans'][0]['latestSignal']['state'], '趋势偏强')
                paused = server.strategy_plan_action({'id': plan['id'], 'action': 'pause'})
                self.assertEqual(paused['status'], 'paused')
                archived = server.strategy_plan_action({'id': plan['id'], 'action': 'archive'})
                self.assertEqual(archived['status'], 'archived')


if __name__ == '__main__':
    unittest.main()
