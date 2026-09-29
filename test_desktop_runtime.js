const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CodexAgentRuntime, PUBLIC_TOOLS, ACCOUNT_DATA_TOOLS } = require('./desktop/agent-runtime');
const { validateFundLoginUrl } = require('./desktop/fund-login-url');
const { parseHoldingsRecognition } = require('./desktop/holdings-recognition');

test('fund login fallback opens only HTTPS URLs on the official fund domain', () => {
  assert.equal(
    validateFundLoginUrl('https://trade.5ifund.com/scan?session=temporary'),
    'https://trade.5ifund.com/scan?session=temporary'
  );
  assert.equal(
    validateFundLoginUrl('https://login.custom.example/scan', 'https://login.custom.example/api'),
    'https://login.custom.example/scan'
  );
  for (const url of [
    'http://trade.5ifund.com/scan',
    'https://trade.5ifund.com.evil.example/scan',
    'https://evil.example@trade.5ifund.com/scan',
    'https://trade.5ifund.com:8443/scan'
  ]) assert.throws(() => validateFundLoginUrl(url));
});

const enabledTools = [
  'open_workbench', 'read_uploaded_holdings_image', 'list_strategy_templates', 'create_strategy',
  'list_investment_strategies', 'run_investment_backtest', 'save_strategy_variant',
  'get_account_brief', 'list_holdings', 'analyze_portfolio', 'get_fund_accounts',
  'list_orders', 'get_order'
];

test('ordinary sessions expose research tools but require explicit consent for account data', () => {
  const runtime = new CodexAgentRuntime({ enabledTools });
  const tools = runtime.threadConfig(false).mcp_servers.fund_workbench.enabled_tools;
  assert.deepEqual(tools, enabledTools.filter(name => PUBLIC_TOOLS.has(name)));
  assert.equal(tools.includes('read_uploaded_holdings_image'), false);
  assert.equal(tools.includes('list_holdings'), false);
  assert.equal(tools.includes('start_fund_login'), false);
  assert.equal(tools.some(name => ['submit_buy', 'submit_redeem', 'cancel_order'].includes(name)), false);
  assert.equal(runtime.threadConfig(false).mcp_servers.fund_workbench.default_tools_approval_mode, 'approve');
});

test('local sessions load the remote strategy guidance under local app branding', () => {
  const runtime = new CodexAgentRuntime({
    enabledTools,
    recommendationSkillPath: path.join(__dirname, 'harness', 'skills', 'strategy-recommender', 'SKILL.md')
  });
  assert.match(runtime.instructions, /同花顺理财客户端的投资策略选择与推荐编排/);
  assert.match(runtime.instructions, /用户问法与追问/);
  assert.match(runtime.instructions, /证据与工具合同/);
  assert.doesNotMatch(runtime.instructions, /SUVI/);
});

test('turn pins model and reasoning effort and attaches local page context and skill', async () => {
  const runtime = new CodexAgentRuntime({ enabledTools, skillPath: '/workspace/fund-workbench/SKILL.md' });
  runtime.start = async () => {};
  let observed;
  runtime.request = async (method, params) => {
    observed = { method, params };
    return { turn: { id: 'turn-1' } };
  };
  await runtime.sendMessage('thread-1', '分析这只基金', { model: 'gpt-6-astra', effort: 'high' }, {
    route: 'holdings', selectedFund: { code: '110020', name: '测试基金' }
  });
  assert.equal(observed.method, 'turn/start');
  assert.equal(observed.params.model, 'gpt-6-astra');
  assert.equal(observed.params.effort, 'high');
  assert.equal(observed.params.input[0].text, '分析这只基金');
  assert.match(observed.params.input[1].text, /^\[WORKBENCH_PAGE_CONTEXT\]/);
  assert.deepEqual(observed.params.input[2], {
    type: 'skill', name: 'fund-workbench', path: '/workspace/fund-workbench/SKILL.md'
  });
});

test('newly started threads stay active without a premature resume', async () => {
  const runtime = new CodexAgentRuntime({ enabledTools });
  runtime.start = async () => {};
  runtime.request = async (method) => {
    assert.equal(method, 'thread/start');
    return { thread: { id: 'fresh-thread' } };
  };
  const thread = await runtime.startThread({ model: 'gpt-6-astra' });
  assert.equal(thread.id, 'fresh-thread');
  assert.equal(runtime.hasThread('fresh-thread'), true);
  assert.equal(runtime.hasThread('missing-thread'), false);
});

test('ephemeral Agent requests collect their result without using a visible session', async () => {
  const runtime = new CodexAgentRuntime({ enabledTools });
  runtime.startThread = async (_provider, ephemeral, toolAllowlist) => {
    assert.equal(ephemeral, true);
    assert.deepEqual(toolAllowlist, ['read_uploaded_holdings_image']);
    return { id: 'hidden-thread' };
  };
  runtime.sendMessage = async threadId => {
    runtime.emit('event', { method: 'item/completed', params: {
      threadId, item: { type: 'mcpToolCall', tool: 'read_uploaded_holdings_image', status: 'completed', arguments: { imageId: 'a'.repeat(32) } }
    } });
    runtime.emit('event', { method: 'item/agentMessage/delta', params: { threadId, itemId: 'answer', delta: '{"funds":[]}' } });
    runtime.emit('event', { method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: 'answer', text: '{"funds":[]}' } } });
    runtime.emit('event', { method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
  };
  const started = [];
  const result = await runtime.runEphemeralMessage('识别截图', {}, { route: 'holdings' }, {
    onThreadStarted: id => started.push(id), timeoutMs: 1000
  });
  assert.deepEqual(started, ['hidden-thread']);
  assert.equal(result.threadId, 'hidden-thread');
  assert.equal(result.text, '{"funds":[]}');
  assert.deepEqual(result.toolCalls, [{ tool: 'read_uploaded_holdings_image', status: 'completed', imageId: 'a'.repeat(32), error: '' }]);
});

test('hidden screenshot recognition enables no account or trading tools', () => {
  const runtime = new CodexAgentRuntime({ enabledTools });
  const tools = runtime.threadConfig(false, ['read_uploaded_holdings_image']).mcp_servers.fund_workbench.enabled_tools;
  assert.deepEqual(tools, ['read_uploaded_holdings_image']);
});

test('holdings screenshot output accepts fenced and localized field names', () => {
  const rows = parseHoldingsRecognition('识别结果如下：\n```fund-holdings-import\n{"funds":[{"基金名称":"测试基金","基金代码":"000001","持有市值":"￥1,234.50","浮动盈亏":"-12.3","当日收益":5}]}\n```');
  assert.deepEqual(rows, [{ fundName: '测试基金', fundCode: '000001', amount: 1234.5, holdingIncome: -12.3, dailyIncome: 5 }]);
});

test('holdings screenshot output handles alternate arrays and reports invalid results', () => {
  assert.deepEqual(parseHoldingsRecognition('[{"name":"备用基金","code":"123456","marketValue":100}]'), [
    { fundName: '备用基金', fundCode: '123456', amount: 100, holdingIncome: null, dailyIncome: null }
  ]);
  assert.throws(() => parseHoldingsRecognition('无法识别'), /AI 返回格式无法读取/);
  assert.throws(() => parseHoldingsRecognition('{"message":"暂无持仓"}'), /没有返回持仓清单/);
});

test('request_user_input waits for the renderer answer', () => {
  const runtime = new CodexAgentRuntime({ enabledTools });
  const writes = [];
  runtime.write = message => writes.push(message);
  let event;
  runtime.on('event', value => { event = value; });
  runtime.handleServerRequest({
    id: 42,
    method: 'item/tool/requestUserInput',
    params: { threadId: 'thread-1', questions: [{ id: 'scope', question: '分析范围？' }] }
  });
  assert.equal(writes.length, 0);
  assert.equal(event.params.requestId, '42');
  runtime.answerUserInput('42', { scope: { answers: ['全部持仓'] } });
  assert.deepEqual(writes[0], { id: 42, result: { answers: { scope: { answers: ['全部持仓'] } } } });
});

test('authorized sessions expose account tools while keeping screenshot and trading tools isolated', () => {
  const runtime = new CodexAgentRuntime({ enabledTools });
  const tools = runtime.threadConfig(true).mcp_servers.fund_workbench.enabled_tools;
  assert.deepEqual(tools, enabledTools.filter(name => PUBLIC_TOOLS.has(name) || ACCOUNT_DATA_TOOLS.has(name)));
  assert.equal(tools.includes('read_uploaded_holdings_image'), false);
  assert.equal(tools.includes('submit_buy'), false);
});

test('every page has a bottom prompt that opens the right chat drawer', () => {
  const html = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent.js'), 'utf8');
  assert.ok(html.indexOf('panda-workbench-nav') < html.indexOf('id="agent-new"'));
  assert.match(html, /id="quick-agent-form"/);
  assert.doesNotMatch(html, /id="agent-toggle"/);
  assert.match(html, /id="agent-panel"/);
  assert.match(script, /panel\.hidden=!state\.agentOpen/);
  assert.match(script, /\$\('#quick-agent-form'\)\.hidden=state\.agentOpen/);
  assert.match(script, /state\.agentOpen=true;render\(\)/);
  assert.doesNotMatch(script, /id="agent-conversation-host"/);
});

test('strategy research UI exposes default results, run replay and agent feedback', () => {
  const html = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent-fixes.css'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'desktop', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'desktop', 'main.js'), 'utf8');
  assert.match(script, /async function openStrategy/);
  assert.match(script, /async function openRun/);
  assert.match(script, /agentProgressMarkup/);
  assert.match(script, /策略累计收益/);
  assert.match(script, /同期基准收益/);
  assert.match(script, /超额收益/);
  assert.match(script, /年化波动率/);
  assert.match(script, /loadShowcases/);
  assert.match(script, /function sortedStrategies/);
  assert.match(script, /sortedStrategies\(\)\.slice\(0,3\)\.map\(strategyCard\)/);
  assert.match(script, /visible\.map\(strategyCard\)/);
  assert.match(script, /refreshPlanPerformance/);
  assert.match(script, /本次回测配置/);
  assert.match(script, /查看全部参数/);
  assert.match(script, /交易后持仓金额/);
  assert.match(script, /alignComparison/);
  assert.match(css, /panda-backtest-params/);
  assert.match(script, /deleteSession/);
  assert.match(script, /wasCurrent&&D\.sessions\.length/);
  assert.match(html, /id="agent-delete"/);
  assert.match(preload, /agent:delete-session/);
  assert.match(main, /handle\('agent:delete-session'/);
  assert.match(main, /return \{ sessions: rows, warning \}/);
  assert.doesNotMatch(html, /投资研究|实盘交易|Fund Research/);
  assert.match(html, /panda-brand[^>]*><div><strong class="ths-finance-brand">同花顺<span>理财<\/span>/);
  assert.doesNotMatch(html, /panda-top-actions[^>]*><strong class="ths-finance-brand"/);
  assert.doesNotMatch(html, /<img src="assets\/paradoxai-mark\.png"/);
  assert.match(css, /\.ths-finance-brand span\{[^}]*#ff2635[^}]*font-size:inherit/);
  assert.match(css, /--gain:#f04444;--loss:#22c55e/);
  assert.match(script, /切换账户/);
  assert.match(script, /confirm-switch-account/);
  assert.match(script, /api\('\/api\/fund\/login',\{force\}\)/);
  assert.match(css, /panda-login-body/);
  assert.match(css, /panda-phone-mark/);
  assert.match(fs.readFileSync(path.join(__dirname, 'server.py'), 'utf8'), /command\.append\('--force'\)/);
  assert.equal(fs.existsSync(path.join(__dirname, 'assets', 'paradoxai-mark.png')), true);
});

test('holdings analysis uses the shared drawer and updates prompts for the selected account or fund', () => {
  const script = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent.html'), 'utf8');
  assert.match(script, /function quickAgentPrompts\(\)/);
  assert.match(script, /钱主要亏在哪/);
  assert.match(script, /哪些基金拖累最多/);
  assert.match(script, /state\.holdingsQuestionFocus='account'/);
  assert.match(script, /state\.holdingsQuestionFocus='fund'/);
  assert.match(html, /id="quick-agent-form"/);
  assert.match(html, /id="agent-panel"/);
  assert.doesNotMatch(script, /holdingsQuestionBox|holdingsAgentSection|data-holdings-question/);
  assert.doesNotMatch(script, /holding-card-ai|holding-detail-ask|data-holding-analyze/);
  assert.match(script, /freshContext=pageContext\(\{includeAccountData:requestedConsent\}\)/);
  assert.match(script, /capturedContext=state\.composerContext/);
});
