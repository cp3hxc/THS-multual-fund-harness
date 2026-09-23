const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CodexAgentRuntime, PUBLIC_TOOLS } = require('./desktop/agent-runtime');

const enabledTools = [
  'open_workbench', 'list_strategy_templates', 'create_strategy',
  'list_investment_strategies', 'run_investment_backtest', 'save_strategy_variant',
  'get_account_brief', 'list_holdings', 'analyze_portfolio', 'get_fund_accounts',
  'list_orders', 'get_order'
];

test('unapproved sessions expose only non-account fund tools', () => {
  const runtime = new CodexAgentRuntime({ enabledTools });
  const tools = runtime.threadConfig(false).mcp_servers.fund_workbench.enabled_tools;
  assert.deepEqual(tools, enabledTools.filter(tool => PUBLIC_TOOLS.has(tool)));
  assert.equal(tools.includes('list_holdings'), false);
  assert.equal(tools.includes('get_account_brief'), false);
  assert.equal(tools.includes('list_orders'), false);
  assert.equal(tools.includes('create_strategy'), true);
  assert.equal(tools.includes('run_investment_backtest'), true);
  assert.equal(runtime.threadConfig(false).mcp_servers.fund_workbench.default_tools_approval_mode, 'approve');
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

test('approved sessions expose the complete configured fund tool set', () => {
  const runtime = new CodexAgentRuntime({ enabledTools });
  assert.deepEqual(
    runtime.threadConfig(true).mcp_servers.fund_workbench.enabled_tools,
    enabledTools
  );
});

test('workbench owns the only chat composer and switches to a conversation page', () => {
  const html = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'panda-strategy-agent.js'), 'utf8');
  assert.ok(html.indexOf('panda-workbench-nav') < html.indexOf('id="agent-new"'));
  assert.match(script, /id="agent-composer-host"/);
  assert.match(script, /id="agent-conversation-host"/);
  assert.match(script, /function conversationActive\(\)/);
  assert.doesNotMatch(script, /让 Agent 修改|agent-adjust/);
  assert.match(script, /panel\.hidden=true/);
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
  assert.match(script, /sortedStrategies\(\)\.map\(strategyCard\)/);
  assert.match(script, /refreshPlanPerformance/);
  assert.match(script, /本次回测配置/);
  assert.match(script, /展开全部/);
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
