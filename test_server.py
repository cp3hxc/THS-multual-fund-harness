"""Behavioral checks; never submit real financial orders or call a model."""
import copy
import json
import tempfile
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import urlopen
from unittest.mock import patch
import server as app


class Contracts(unittest.TestCase):
    def test_root_serves_current_dark_agent_and_legacy_page_is_not_available(self):
        httpd = HTTPServer(('127.0.0.1', 0), app.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(f'http://127.0.0.1:{httpd.server_port}/') as response:
                html = response.read().decode('utf-8')
                self.assertEqual(response.status, 200)
                self.assertIn('content="dark"', html)
                self.assertIn('panda-strategy-agent.js', html)
            with self.assertRaises(HTTPError) as error:
                urlopen(f'http://127.0.0.1:{httpd.server_port}/fund-ai-workbench.html')
            self.assertEqual(error.exception.code, 404)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

    def test_live_business_envelope_is_unwrapped(self):
        for payload in [{'ok': True, 'data': {'funds': []}},
                        {'ok': True, 'data': {'status_code': '0000', 'data': {'funds': []}}},
                        {'ok': True, 'data': {'data': {'tradeInitTreaty': [{'title': '协议'}]},
                                              'error': {'id': 0, 'msg': 'is access'}}}]:
            with patch('server.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(payload))):
                result = app.cli_run(['holding', 'overview'])
            if 'tradeInitTreaty' in json.dumps(payload):
                self.assertEqual(result['tradeInitTreaty'][0]['title'], '协议')
            else:
                self.assertEqual(result, {'funds': []})

    def test_business_failure_is_not_an_empty_portfolio(self):
        payload = {'ok': True, 'data': {'status_code': '9001', 'status_msg': '当前业务不可用'}}
        with patch('server.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(payload))):
            with self.assertRaisesRegex(app.AppError, '当前业务不可用'):
                app.cli_run(['holding', 'overview'])

    def test_only_documented_financial_write_commands_are_allowed(self):
        payload = {'ok': True, 'data': {'accepted': True}}
        for args in [['fund', 'buy'], ['fund', 'redeem'], ['trade', 'revoke'], ['fund', 'trade-record']]:
            with patch('server.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(payload))) as run:
                self.assertEqual(app.cli_run(args), {'accepted': True})
                run.assert_called_once()
        with patch('server.subprocess.run') as run:
            with self.assertRaises(app.AppError):
                app.cli_run(['trade-account', 'create'])
            run.assert_not_called()

    def test_buy_submission_is_single_use_and_locks_payment_account(self):
        app.TRANSACTION_INTENTS.clear()
        token = app._intent('buy', {
            'code': '110020', 'amount': '100', 'name': '测试基金', 'riskMismatch': False,
            'payments': [{'ref': 'pay_ref', 'raw': '6001234', 'buyType': '0', 'kind': '银行卡',
                          'bank': '测试银行', 'account': '****1234', 'singleLimit': '1000', 'dailyLimit': '2000'}],
            'agreements': [{'title': '协议', 'agreementUrl': 'https://example.com/a'}],
            'minBuy': '10', 'minAdd': '1', 'maxBuy': '10000', 'existingAccounts': []
        })
        calls = []
        def fake_cli(args, timeout=60):
            calls.append(args)
            if args[:2] == ['fund', 'buy']:
                return {'appSheetSerialNo': 'order001'}
            return {'appSheetSerialNo': 'order001', 'confirmFlag': '0', 'processStatus': '1'}
        body = {'token': token, 'paymentRef': 'pay_ref', 'confirmation': '确认申购',
                'agreementsAccepted': True, 'riskAccepted': False}
        with patch('server._trade_record', return_value='record001') as record, \
             patch('server.cli_run', side_effect=fake_cli):
            result = app.submit_buy(body)
            self.assertTrue(result['submitted'])
            record.assert_called_once_with(
                [{'title': '协议', 'agreementUrl': 'https://example.com/a'}], 'BUY')
            buy = next(x for x in calls if x[:2] == ['fund', 'buy'])
            self.assertEqual(buy[buy.index('--transaction-account-id') + 1], '6001234')
            self.assertEqual(buy[buy.index('--trade-id') + 1], '6001234')
            self.assertEqual(buy[buy.index('--agreement-record') + 1], 'record001')
            with self.assertRaisesRegex(app.AppError, '提交过'):
                app.submit_buy(body)
        self.assertEqual(sum(x[:2] == ['fund', 'buy'] for x in calls), 1)

    def test_live_treaty_action_urls_are_all_recorded(self):
        actions = [
            'action=openpdf,url=http://notice.10jqka.com.cn/api/pdf/a.pdf,filesize=,fundname=测试',
            'action=openpdf,url=https%3A%2F%2Fnotice.10jqka.com.cn%2Fapi%2Fpdf%2Fb.pdf,filesize=',
            'https://fund.10jqka.com.cn/reveal.html?code=110020',
            {'agreementUrl': 'https://fund.10jqka.com.cn/maintenance.html?code=110020'},
        ]
        self.assertEqual(app._agreement_url(actions[0]),
                         'http://notice.10jqka.com.cn/api/pdf/a.pdf')
        self.assertEqual(app._agreement_url(actions[1]),
                         'https://notice.10jqka.com.cn/api/pdf/b.pdf')
        self.assertEqual(app._agreement_url(actions[2]), actions[2])
        self.assertEqual(app._agreement_url(actions[3]), actions[3]['agreementUrl'])

        init = {
            'paramOpenFundAccBean': {'fundCode': '110020', 'fundName': '测试基金',
                                     'productType': '0101', 'minAddBuy': '1'},
            'accountValidateResult': {'validateCode': '0000'},
            'fundRiskLevel': '2', 'ov_clientriskrate': '3', 'ov_flag': '2',
            'bankCardSplitListResult': [{'transActionAccountId': '6001234',
                                         'bankName': '测试银行', 'bankAccount': '1234'}],
            'subOrAddResult': [], 'minBuy': '10', 'maxBuy': '10000'
        }
        treaties = {'tradeInitTreaty': [
            {'title': '协议 ' + str(index), 'jumpAction': action}
            for index, action in enumerate(actions)
        ]}
        app.TRANSACTION_INTENTS.clear()
        with patch('server.cli_run', side_effect=[init, treaties]):
            prepared = app.prepare_buy({'code': '110020', 'amount': '100'})
        self.assertEqual(prepared['agreementCount'], len(actions))
        stored = app.TRANSACTION_INTENTS[prepared['token']]['agreements']
        self.assertEqual([row['agreementUrl'] for row in stored],
                         [app._agreement_url(action) for action in actions])

    def test_trade_record_accepts_live_scalar_record_id(self):
        agreements = [{'title': '协议', 'agreementUrl': 'https://example.com/a'}]
        with patch('server.cli_run', return_value='153000123') as run:
            self.assertEqual(app._trade_record(agreements, 'BUY'), '153000123')
        args = run.call_args.args[0]
        self.assertEqual(args[:2], ['fund', 'trade-record'])

    def test_trade_record_rejects_non_numeric_or_missing_record_id(self):
        agreements = [{'title': '协议', 'agreementUrl': 'https://example.com/a'}]
        for response in (None, {}, 'success', True):
            with patch('server.cli_run', return_value=response):
                with self.assertRaisesRegex(app.AppError, '未返回有效编号'):
                    app._trade_record(agreements, 'BUY')

    def test_incomplete_treaty_stops_before_confirmation(self):
        init = {
            'paramOpenFundAccBean': {'fundCode': '110020', 'fundName': '测试基金',
                                     'productType': '0101'},
            'accountValidateResult': {'validateCode': '0000'},
            'fundRiskLevel': '2', 'ov_clientriskrate': '3', 'ov_flag': '2',
            'bankCardSplitListResult': [{'transActionAccountId': '6001234'}]
        }
        treaties = {'tradeInitTreaty': [
            {'title': '完整协议', 'jumpAction': 'https://example.com/a'},
            {'title': '缺失协议', 'jumpAction': 'action=openpdf,filesize='},
        ]}
        with patch('server.cli_run', side_effect=[init, treaties]):
            with self.assertRaisesRegex(app.AppError, '未完整返回'):
                app.prepare_buy({'code': '110020', 'amount': '100'})

    def test_buy_preflight_failure_can_be_corrected_without_burning_token(self):
        app.TRANSACTION_INTENTS.clear()
        token = app._intent('buy', {
            'code': '110020', 'amount': '100', 'name': '测试基金', 'riskMismatch': True,
            'payments': [{'ref': 'pay_ref', 'raw': '6001234', 'buyType': '0', 'kind': '银行卡',
                          'bank': '测试银行', 'account': '****1234', 'singleLimit': '1000', 'dailyLimit': '2000'}],
            'agreements': [{'title': '协议', 'agreementUrl': 'https://example.com/a'}],
            'minBuy': '10', 'minAdd': '1', 'maxBuy': '10000', 'existingAccounts': []
        })
        body = {'token': token, 'paymentRef': 'pay_ref', 'confirmation': '确认申购',
                'agreementsAccepted': True, 'riskAccepted': False}
        with self.assertRaisesRegex(app.AppError, '单独确认风险'):
            app.submit_buy(body)
        self.assertFalse(app.TRANSACTION_INTENTS[token]['used'])
        body['riskAccepted'] = True
        with patch('server._trade_record', return_value='record001'), \
             patch('server.cli_run', side_effect=[{'appSheetSerialNo': 'order001'},
                                                  {'appSheetSerialNo': 'order001', 'confirmFlag': '0'}]):
            self.assertTrue(app.submit_buy(body)['submitted'])
        self.assertTrue(app.TRANSACTION_INTENTS[token]['used'])

    def test_agreement_record_failure_does_not_mark_buy_as_submitted(self):
        app.TRANSACTION_INTENTS.clear()
        token = app._intent('buy', {
            'code': '110020', 'amount': '100', 'name': '测试基金', 'riskMismatch': False,
            'payments': [{'ref': 'pay_ref', 'raw': '6001234', 'buyType': '0', 'kind': '银行卡',
                          'bank': '测试银行', 'account': '****1234', 'singleLimit': '1000',
                          'dailyLimit': '2000'}],
            'agreements': [{'title': '协议', 'agreementUrl': 'https://example.com/a'}],
            'minBuy': '10', 'minAdd': '1', 'maxBuy': '10000', 'existingAccounts': []
        })
        body = {'token': token, 'paymentRef': 'pay_ref', 'confirmation': '确认申购',
                'agreementsAccepted': True, 'riskAccepted': False}
        with patch('server._trade_record', side_effect=app.AppError('协议留痕失败')), \
             patch('server.cli_run') as run:
            with self.assertRaisesRegex(app.AppError, '协议留痕失败'):
                app.submit_buy(body)
        self.assertFalse(app.TRANSACTION_INTENTS[token]['used'])
        run.assert_not_called()

        with patch('server._trade_record', return_value='record001'), \
             patch('server.cli_run', side_effect=[{'appSheetSerialNo': 'order001'},
                                                  {'appSheetSerialNo': 'order001', 'confirmFlag': '0'}]):
            self.assertTrue(app.submit_buy(body)['submitted'])
        self.assertTrue(app.TRANSACTION_INTENTS[token]['used'])

    def test_revoke_confirmation_typo_does_not_burn_token(self):
        app.TRANSACTION_INTENTS.clear()
        token = app._intent('revoke', {'orderId': 'order001', 'account': '6009988',
                                       'refund': '1', 'raw': {}})
        with self.assertRaisesRegex(app.AppError, '确认撤单'):
            app.submit_revoke({'token': token, 'confirmation': '输入错误'})
        self.assertFalse(app.TRANSACTION_INTENTS[token]['used'])
        with patch('server._submit_revoke_item', return_value={'submitted': True}) as submit:
            self.assertTrue(app.submit_revoke({'token': token, 'confirmation': '确认撤单'})['submitted'])
            submit.assert_called_once()

    def test_revoke_uses_fresh_detail_fields_and_cannot_be_replayed(self):
        app.TRANSACTION_INTENTS.clear()
        detail = {'appSheetSerialNo': 'order001', 'transactionAccountId': '6009988',
                  'businessCode': '020', 'feeSource': '0', 'cancelFlag': '0',
                  'confirmFlag': '0', 'fundCode': '110020', 'fundName': '测试基金'}
        with patch('server.cli_run', return_value=detail):
            prepared = app.prepare_revoke({'orderId': 'order001'})
        calls = []
        def fake_cli(args, timeout=60):
            calls.append(args)
            return {**detail, 'confirmFlag': '1'}
        body = {'token': prepared['token'], 'confirmation': '确认撤单'}
        with patch('server.cli_run', side_effect=fake_cli):
            result = app.submit_revoke(body)
            self.assertTrue(result['final'])
            revoke = calls[0]
            self.assertEqual(revoke, ['trade', 'revoke', '--order-id', 'order001',
                                     '--transaction-account-id', '6009988', '--refund-source', '1'])
            with self.assertRaisesRegex(app.AppError, '提交过'):
                app.submit_revoke(body)
        self.assertEqual(sum(x[:2] == ['trade', 'revoke'] for x in calls), 1)

    def test_batch_revoke_revalidates_each_order_and_reports_partial_failure(self):
        app.TRANSACTION_INTENTS.clear()
        details = {
            'order001': {'appSheetSerialNo': 'order001', 'transactionAccountId': '6001001',
                         'businessCode': '020', 'feeSource': '0', 'cancelFlag': '0',
                         'confirmFlag': '0', 'fundCode': '110020', 'fundName': '测试基金 A'},
            'order002': {'appSheetSerialNo': 'order002', 'transactionAccountId': '6001002',
                         'businessCode': '022', 'feeSource': '1', 'cancelFlag': '0',
                         'confirmFlag': '0', 'fundCode': '000001', 'fundName': '测试基金 B'},
        }
        with patch('server.cli_run', side_effect=lambda args, timeout=60: details[args[-1]]) as run:
            prepared = app.prepare_revoke_batch({'orderIds': ['order001', 'order002']})
        self.assertEqual(run.call_count, 2)
        self.assertEqual([x['id'] for x in prepared['orders']], ['order001', 'order002'])
        success = {'submitted': True, 'orderId': 'order001', 'message': '撤单申请已提交。'}
        body = {'token': prepared['token'], 'confirmation': '确认批量撤单'}
        with patch('server._submit_revoke_item', side_effect=[success, app.AppError('当前不可撤')]) as submit:
            result = app.submit_revoke_batch(body)
            self.assertEqual(submit.call_count, 2)
        self.assertEqual(result['successCount'], 1)
        self.assertEqual(result['failureCount'], 1)
        self.assertTrue(result['results'][0]['ok'])
        self.assertEqual(result['results'][1]['message'], '当前不可撤')
        with self.assertRaisesRegex(app.AppError, '提交过'):
            app.submit_revoke_batch(body)

    def test_overview_masks_bank_and_excludes_identifiers(self):
        source = {'fundApi': {'okCategories': ['01'], 'failedCategories': ['02']},
                  'fundSummary': {'totalAmount': '100', 'fundCount': '1'},
                  'funds': [{'fundCode': '110020', 'totalAmount': '100', 'holdVol': '待确认', 'holdIncomeRate': '-3.61%',
                             'custId': 'secret', 'raw': {'secret': 'hidden'}}],
                  'wallet': {'ok': True, 'bank_total': '0', 'data': {'custId': 'secret',
                             'bankAccountShareList': [{'bankName': '测试银行', 'bankAccount': '1234567890', 'totalShare': '0'}]}}}
        with patch('server.cli_run', return_value=source):
            d = app.overview()
        self.assertEqual(d['wallet']['banks'][0]['account'], '****7890')
        self.assertEqual(d['funds'][0]['holdVol'], '待确认')
        self.assertEqual(d['funds'][0]['holdIncomeRate'], '-3.61%')
        self.assertEqual(d['summary']['pendingAmount'], '100.00')
        self.assertEqual(d['summary']['confirmedAmount'], '0.00')
        self.assertEqual(d['summary']['pendingCount'], 1)
        self.assertNotIn('secret', json.dumps(d))
        self.assertEqual(d['fundApi']['failedCategories'], ['02'])

    def test_pending_order_is_not_a_fill_and_detail_keeps_eligibility(self):
        o = app.order_view({'confirmFlag': '0', 'processStatus': '1', 'endFlag': '0',
                           'cancelFlag': '0', 'totalFee': '100.00', 'bankAccount': '5535'})
        self.assertEqual(o['status'], '待确认')
        self.assertIsNone(o['confirmedAmount'])
        self.assertTrue(o['canCancel'])
        self.assertEqual(o['bankAccount'], '****5535')

    def test_orders_preserve_cursor_and_request_range(self):
        rows = [{'appSheetSerialNo': str(x), 'acceptTime': '2026-09-16 10:00:00', 'confirmFlag': '0'} for x in range(20)]
        with patch('server.cli_run', return_value=rows) as run:
            data = app.orders({'start': '20260901', 'end': '20260916', 'processing': 'true'})
        self.assertEqual(data['next']['lastId'], '19')
        self.assertIn('--query-processing', run.call_args.args[0])
        with patch('server.cli_run', return_value={'data': []}) as run:
            app.orders({'start': '20260901', 'end': '20260916', 'page': '2', 'lastId': '19',
                        'lastTime': '2026-09-16 10:00:00'})
        self.assertIn('--last-order-id', run.call_args.args[0])
        self.assertIn('19', run.call_args.args[0])

    def test_minimum_risk_blocks_buy_preparation(self):
        data = {'paramOpenFundAccBean': {'fundCode': '110020', 'productType': '0101'},
                'fundRiskLevel': '3', 'ov_clientriskrate': '1', 'ov_flag': '2',
                'accountValidateResult': {'validateCode': '0000'}}
        with patch('server.cli_run', return_value=data) as run:
            d = app.buy_preview('110020')
        self.assertTrue(d['blocked'])
        self.assertEqual(run.call_count, 1)

    def test_unsupported_product_stops_before_fee_requests(self):
        data = {'paramOpenFundAccBean': {'fundCode': '110020', 'productType': '0105'}}
        with patch('server.cli_run', return_value=data) as run:
            self.assertTrue(app.buy_preview('110020')['blocked'])
        self.assertEqual(run.call_count, 1)

    def test_redeem_cannot_substitute_an_account(self):
        with patch('server._resolve_account_ref', side_effect=app.AppError('账户选择已过期')), patch('server.cli_run') as run:
            with self.assertRaises(app.AppError):
                app.redeem_preview('110020', 'acct_wrong')
            run.assert_not_called()

    def test_redeem_distinguishes_account_shares_and_rule_cap(self):
        response = {'fundInfo': {'fundCode': '110020', 'maxRedemptionVol': '999999999999',
                    'stepRates': [{'lwLimit': '7', 'upLimit': '365', 'containsLwLimit': True,
                                   'containsUpLimit': False, 'rate': '0.005'}]}, 'shareList': []}
        with patch('server._resolve_account_ref', return_value='6001234'), patch('server.holding_details', return_value={'accounts': [{'id': 'acct_test', 'availableShares': '83.83'}]}), patch('server.cli_run', return_value=response):
            d = app.redeem_preview('110020', 'acct_test')
        self.assertEqual(d['availableShares'], '83.83')
        self.assertEqual(d['stepRates'][0], {'range': '持有天数 ≥ 7 且 < 365', 'rate': '0.500%'})

    def test_account_reference_is_opaque_scoped_and_expiring(self):
        app.ACCOUNT_REFS.clear()
        ref = app._account_ref('110020', '600123456789')
        self.assertTrue(ref.startswith('acct_'))
        self.assertNotIn('600123456789', ref)
        self.assertEqual(app._resolve_account_ref('110020', ref), '600123456789')
        with self.assertRaises(app.AppError):
            app._resolve_account_ref('000001', ref)

    def test_model_receives_holdings_only_with_message_opt_in(self):
        original = copy.copy(app.AI_CONFIG)
        app.AI_CONFIG.update(mode='api', apiKey='test-only-secret', protocol='responses', model='test')
        fake = SimpleNamespace(status_code=200, json=lambda: {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '测试通过'}]}]})
        try:
            with patch('server.api_url', return_value='https://test.example/v1'), patch('requests.post', return_value=fake) as post, patch('server.overview', return_value={'funds': [{'fundCode': '110020'}], 'wallet': {'secret': 'never send'}, 'fetchedAt': 'today'}) as holdings:
                self.assertEqual(app.ai_chat({'message': '测试连接'})['reply'], '测试通过')
                holdings.assert_not_called()
                self.assertNotIn('110020', json.dumps(post.call_args.kwargs['json']))
                app.ai_chat({'message': '测试连接', 'includeHoldings': True})
                self.assertIn('110020', json.dumps(post.call_args.kwargs['json']))
                self.assertNotIn('never send', json.dumps(post.call_args.kwargs['json']))
                self.assertFalse(post.call_args.kwargs['allow_redirects'])
        finally:
            app.AI_CONFIG.clear()
            app.AI_CONFIG.update(original)

    def test_state_persistence_and_duplicate_fund_conflict(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'RUNTIME', Path(directory)), patch.object(app, 'STATE_PATH', Path(directory)/'state.json'):
            body = {'templateId': 'trend-strength', 'name': '测试策略', 'codes': '110020', 'budget': '2000',
                    'amount': '200', 'params': {'shortWindow': 20, 'longWindow': 120}, 'eligibilityConfirmed': True}
            item = app.save_strategy(body)
            self.assertEqual(app.state_read()['strategies'][0]['status'], 'draft')
            with self.assertRaisesRegex(app.AppError, '已关联'):
                app.save_strategy(body)
            state = app.state_read()
            state['strategies'][0]['status'] = 'archived'
            app.state_write(state)
            self.assertNotEqual(app.save_strategy(body)['id'], item['id'])

    def test_budget_and_parameter_constraints(self):
        body = {'templateId': 'trend-strength', 'name': '测试', 'codes': '110020', 'budget': '100',
                'amount': '200', 'params': {'shortWindow': 20, 'longWindow': 120}, 'eligibilityConfirmed': True}
        with self.assertRaisesRegex(app.AppError, '单次投入'):
            app.save_strategy(body)
        body.update(amount='10', params={'shortWindow': 200, 'longWindow': 100})
        with self.assertRaisesRegex(app.AppError, '短周期'):
            app.save_strategy(body)

    def test_api_key_not_reused_for_new_host(self):
        original = copy.copy(app.AI_CONFIG)
        app.AI_CONFIG.update(apiKey='test-only-secret', baseUrl='https://old.example/v1')
        try:
            with patch('server.api_url', return_value='https://new.example/v1'):
                with self.assertRaisesRegex(app.AppError, '重新填写'):
                    app.ai_save({'mode': 'api', 'baseUrl': 'https://new.example/v1', 'protocol': 'responses', 'model': 'test'})
            with patch('server.codex_status', return_value={'connected': False}):
                self.assertNotIn('apiKey', app.ai_status())
        finally:
            app.AI_CONFIG.clear()
            app.AI_CONFIG.update(original)

    def test_api_configuration_rejects_local_targets(self):
        for value in ['http://example.com/v1', 'https://secret@example.com/v1', 'https://127.0.0.1/v1']:
            with self.assertRaises(app.AppError):
                app.api_url(value)


if __name__ == '__main__':
    unittest.main()
