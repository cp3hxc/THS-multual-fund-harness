"""Contract tests for the fixed DeepSeek Harness MCP entry."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from harness import mcp_server


class HarnessMcp(unittest.TestCase):
    def test_catalog_covers_every_html_business_area(self):
        names = {x['name'] for x in mcp_server.TOOLS}
        expected = {
            'open_workbench', 'get_dashboard', 'get_account_brief', 'list_holdings', 'analyze_portfolio',
            'get_fund_accounts', 'get_buy_preview', 'get_redeem_preview',
            'list_orders', 'get_order', 'list_strategy_templates', 'list_strategies',
            'create_strategy', 'archive_strategy', 'list_watchlist', 'set_watchlist',
            'list_trade_drafts', 'save_trade_draft', 'remove_trade_draft',
            'get_connection_status', 'start_fund_login', 'get_fund_login_status',
            'list_investment_strategies', 'run_investment_backtest', 'save_strategy_variant',
        }
        self.assertEqual(names, expected)
        self.assertFalse(any(name in names for name in ('buy', 'redeem', 'cancel_order', 'pay')))

    def test_local_html_actions_share_one_state_contract(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(server, 'RUNTIME', Path(directory)), \
             patch.object(server, 'STATE_PATH', Path(directory) / 'state.json'):
            watch = mcp_server.call('set_watchlist', {'code': '110020', 'name': '沪深300'})
            self.assertEqual(watch['watchlist'][0]['code'], '110020')

            draft = mcp_server.call('save_trade_draft', {
                'kind': 'buy', 'code': '110020', 'name': '沪深300', 'value': 200,
            })
            self.assertEqual(mcp_server.call('list_trade_drafts', {})[0]['id'], draft['id'])
            self.assertEqual(mcp_server.call('remove_trade_draft', {'id': draft['id']})['drafts'], [])

            strategy = mcp_server.call('create_strategy', {
                'templateId': 'trend-strength', 'name': '周趋势计划', 'codes': ['110020'],
                'budget': 1000, 'amount': 100, 'params': {'shortWindow': 20, 'longWindow': 120},
                'eligibilityConfirmed': True,
            })
            self.assertEqual(mcp_server.call('list_strategies', {'status': 'current'})[0]['id'], strategy['id'])
            mcp_server.call('archive_strategy', {'id': strategy['id']})
            self.assertEqual(mcp_server.call('list_strategies', {'status': 'current'}), [])
            self.assertEqual(mcp_server.call('list_strategies', {'status': 'archived'})[0]['id'], strategy['id'])

    def test_read_tools_delegate_to_real_business_contracts(self):
        overview = {'summary': {'fundCount': 1}, 'wallet': {'ok': True}, 'funds': [{'fundCode': '110020'}]}
        with patch('harness.mcp_server.server.overview', return_value=overview), \
             patch('harness.mcp_server.server.holding_details', return_value={'code': '110020', 'accounts': [{'id': '123', 'bankAccount': '****0001'}]}) as accounts, \
             patch('harness.mcp_server.server.buy_preview', return_value={'code': '110020'}) as buy, \
             patch('harness.mcp_server.server.redeem_preview', return_value={'code': '110020'}) as redeem:
            self.assertEqual(mcp_server.call('list_holdings', {})['summary']['fundCount'], 1)
            self.assertEqual(mcp_server.call('get_fund_accounts', {'code': '110020'})['code'], '110020')
            self.assertEqual(mcp_server.call('get_buy_preview', {'code': '110020'})['code'], '110020')
            public = mcp_server.call('get_fund_accounts', {'code': '110020'})
            self.assertNotIn('id', public['accounts'][0])
            self.assertTrue(public['accounts'][0]['ref'].startswith('acct_'))
            self.assertEqual(mcp_server.call('get_redeem_preview', {
                'code': '110020', 'accountRef': public['accounts'][0]['ref'],
            })['code'], '110020')
        self.assertGreaterEqual(accounts.call_count, 3); buy.assert_called_once(); redeem.assert_called_once()

    def test_order_tool_forwards_cursor_pagination(self):
        with patch('harness.mcp_server.server.orders', return_value={'orders': [], 'page': 2}) as orders:
            result = mcp_server.call('list_orders', {
                'startDate': '20260901', 'endDate': '20260917', 'page': 2,
                'lastAcceptTime': '2026-09-16 12:00:00', 'lastOrderId': 'order_1',
                'kind': 'buy', 'processing': True,
            })
        self.assertEqual(result['page'], 2)
        query = orders.call_args.args[0]
        self.assertEqual(query['page'], '2')
        self.assertEqual(query['lastId'], 'order_1')
        self.assertEqual(query['start'], '20260901')

    def test_switch_account_login_uses_force_authorization(self):
        class InlineThread:
            def __init__(self, target, daemon=False):
                self.target = target

            def start(self):
                self.target()

        response = type('Result', (), {'stdout': json.dumps({'ok': True})})()
        mcp_server.AUTH_JOB.update(running=False, success=False, mode='login', message='')
        with patch('harness.mcp_server.threading.Thread', InlineThread), \
             patch('harness.mcp_server.subprocess.run', return_value=response) as run:
            result = mcp_server.call('start_fund_login', {'force': True})
        self.assertTrue(result['success'])
        self.assertEqual(result['mode'], 'switch')
        self.assertEqual(run.call_args.args[0][-1], '--force')

    def test_account_brief_aggregates_daily_performance_and_dates(self):
        overview = {
            'source': '同花顺爱基金 · thsfund', 'fetchedAt': '2026-09-18T09:30:00+08:00',
            'summary': {'totalAmount': '1500', 'confirmedAmount': '1000', 'pendingAmount': '500'},
            'wallet': {'ok': True, 'total': '88'},
            'funds': [
                {'fundCode': '110020', 'fundName': '上涨基金', 'totalAmount': '600', 'holdVol': '10', 'holdIncome': '20', 'holdIncomeRate': '3%', 'newestIncome': '12'},
                {'fundCode': '000001', 'fundName': '下跌基金', 'totalAmount': '400', 'holdVol': '20', 'holdIncome': '-8', 'holdIncomeRate': '-2%', 'newestIncome': '-2'},
                {'fundCode': '999999', 'fundName': '待确认基金', 'totalAmount': '500', 'holdVol': '待确认', 'holdIncome': None, 'holdIncomeRate': None, 'newestIncome': None},
            ],
        }
        dates = {
            'dates': {
                '110020': [{'navDate': '20260917', 'incomeDate': '20260917', 'navValue': '1.23'}],
                '000001': [{'navDate': '20260916', 'incomeDate': '20260916', 'navValue': '2.34'}],
            },
            'failedCategories': [], 'fetchedAt': '2026-09-18T09:30:01+08:00',
        }
        with patch('harness.mcp_server.server.overview', return_value=overview), \
             patch('harness.mcp_server.server.holding_dates', return_value=dates) as date_call:
            result = mcp_server.call('get_account_brief', {})
        self.assertEqual(result['latestPerformance']['income'], '10.0000')
        self.assertEqual(result['latestPerformance']['upCount'], 1)
        self.assertEqual(result['latestPerformance']['downCount'], 1)
        self.assertEqual(result['pending'], {'count': 1, 'amount': '500'})
        self.assertEqual(result['funds'][0]['navDate'], '20260917')
        self.assertEqual(result['latestPerformance']['topPositive']['code'], '110020')
        date_call.assert_called_once_with(['110020', '000001'])


if __name__ == '__main__':
    unittest.main()
