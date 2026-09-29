const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Pure renderer/interaction tests. No personal storage, account tools or network calls.
function harness() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', value: '', hidden: false, dataset: {}, elements: [],
      addEventListener() {}, focus() {}, append() {}, contains() { return false; },
      setAttribute(name,value) { this[name]=value; },
      querySelectorAll() { return []; }, classList: {add(){},remove(){},toggle(){}},
      showModal() { this.open = true; }, close() { this.open = false; },
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    window: {fundDesktop: {}}, URL, Date, console,
    document: {querySelector: node, querySelectorAll: () => [], addEventListener() {},
      body: {classList: {remove(){},add(){},toggle(){}},insertAdjacentHTML() {}}},
    requestAnimationFrame(fn) {fn();},
    setTimeout() {}, clearTimeout() {}, clearInterval() {}, setInterval() {},
    FormData: class { constructor(form) {this.entries=Object.entries(form.values||{});} [Symbol.iterator]() {return this.entries[Symbol.iterator]();} },
  });
  const source = fs.readFileSync('panda-strategy-agent.js', 'utf8').replace(/\nbootstrap\(\);\s*$/, '\n');
  vm.runInContext(source, context);
  return {node, run: code => vm.runInContext(code, context)};
}
const fixture = `state.catalog=[{id:'test',name:'测试策略',version:'1',description:'规则',defaultFundCode:'000001',defaultParams:{amount:1000,period:12,threshold:5},params:[{key:'amount',label:'单次投入',help:'每次投入金额',default:1000,min:100,max:10000,step:100,unit:'元'},{key:'period',label:'周期',default:12,min:1,max:36,step:1},{key:'threshold',label:'阈值',default:5,min:1,max:20,step:1}]}]; state.selected='test';state.result={status:'ok',strategyId:'test',strategyVersion:'1',fundCode:'000001',runId:'run-a',parameters:{amount:1000,period:12,threshold:5},metrics:{returnPct:10,excessReturnPct:3},cashFlow:{fees:null},trades:[],period:{start:'2020-01-01',end:'2023-01-01'},dataAsOf:'2023-01-01'};`;

test('expanding or refreshing parameters preserves edited values; cancel returns to result snapshot', () => {
  const h=harness();h.run(fixture);h.run('state.paramEditing=true');
  Object.assign(h.node('#panda-strategy-form'), {dataset:{editing:'true'},values:{code:'000002','param-amount':'2000','param-period':'18','param-threshold':'7'}});
  h.run('captureParameterDraft(); state.paramsExpanded=true');
  const expanded=h.run('detail(state.catalog[0])');
  assert.match(expanded,/value="2000"/);assert.match(expanded,/value="000002"/);
  assert.doesNotMatch(expanded,/data-action="save-plan"/);
  h.run('state.paramEditing=false;state.paramDraft=null');
  assert.match(h.run('detail(state.catalog[0])'),/>1000</);
  const collapsed=h.run('parameterModule(state.catalog[0],state.result.parameters,"000001",null,null)');
  assert.doesNotMatch(collapsed,/is-collapsed/);
  h.run('state.paramsExpanded=false');
  assert.equal((h.run('parameterModule(state.catalog[0],state.result.parameters,"000001",null,null)').match(/is-collapsed/g)||[]).length,1);
});

test('strategy guidance starts with direction, return and risk, and monthly budget', () => {
  const h=harness();
  h.run("state.nav='library';state.selected=null;renderQuickAgentPrompts()");
  const cards=h.node('#quick-agent-prompts').innerHTML;
  assert.match(cards,/想先解决什么/);
  assert.match(cards,/看好一个投资方向/);
  assert.match(cards,/想争取收益，也怕亏钱/);
  assert.match(cards,/每月有钱可以投/);
  assert.match(cards,/data-assistant-rotate/);
  assert.equal((cards.match(/class="panda-quick-agent-card"/g)||[]).length,4);
  assert.doesNotMatch(cards,/panda-quick-agent-card-arrow|↗/);
});

test('assistant guidance changes with the selected page module', () => {
  const h=harness();
  h.run("globalThis.MS={view:'home',fundCode:''};state.nav='market';state.assistantFocus={scope:assistantScope(),key:'widget:indices',label:'大盘概览'}");
  assert.match(h.run("quickAgentPrompts().map(row=>row[0]).join('、')"),/今天市场怎么了/);
  h.run("MS.view='fund';MS.fundCode='000001';state.assistantFocus={scope:assistantScope(),key:'widget:fund-chart',label:'净值走势'}");
  assert.match(h.run("quickAgentPrompts().map(row=>row[0]).join('、')"),/这段走势怎么看/);
  assert.equal(h.run("activeAssistantFocus()?.label"),'净值走势');
  h.run("MS.view='my-pages';state.nav='pages'");
  assert.equal(h.run("assistantDesignKind('新建基金详情')"),'detail');
  h.run("MS.view='fund';state.nav='market'");
  assert.equal(h.run("assistantDesignKind('另做详情页')"),'detail');
});

test('plan confirmation saves the reviewed snapshot and rejects duplicate requests', async () => {
  const h=harness();h.run(fixture);
  h.run(`render=()=>{};toast=()=>{};globalThis.writes=[];api=async(path,body)=>{if(body)writes.push(JSON.parse(JSON.stringify(body)));return []}`);
  await h.run('savePlan()');
  assert.equal(h.run('writes.length'),0);
  h.run(`state.result.parameters.amount=9000;state.result.runId='run-b'`);
  await h.run('Promise.all([confirmSavePlan(),confirmSavePlan()])');
  assert.equal(h.run('writes.length'),1);
  assert.equal(h.run('writes[0].params.amount'),1000);
  assert.equal(h.run('writes[0].runId'),'run-a');
  h.run('state.paramEditing=true;state.planToSave=null');
  await h.run('savePlan()');assert.equal(h.run('state.planToSave'),null);
});

test('contextual analysis keeps original page context and waits for user send', async () => {
  const h=harness();h.run(`render=()=>{};renderAgentPanel=()=>{};D.enabled=true;D.current={threadId:'session'};globalThis.sent=[];window.fundDesktop.sendMessage=async p=>{sent.push(p);return {ok:true,data:{}}}`);
  h.run(`openWorkbench('帮我分析',{route:'holdings',pageTitle:'我的持仓',selectedFund:{code:'000001'}})`);
  assert.equal(h.run('state.nav'),'workbench');assert.equal(h.run('state.agentOpen'),true);assert.equal(h.run('sent.length'),0);
  await h.run(`sendAgent('帮我分析')`);
  assert.equal(h.run('sent[0].pageContext.route'),'holdings');
  assert.equal(h.run('sent[0].pageContext.selectedFund.code'),'000001');
  assert.equal(h.run('sent[0].text'),'帮我分析');
  assert.equal(h.run('state.composerContext'),null);
});

test('account page context follows this conversation’s explicit data consent', async () => {
  const h=harness();
  h.run(`render=()=>{};renderAgentPanel=()=>{};D.enabled=true;D.current={threadId:'session',dataAuthorized:false};state.nav='holdings';state.composerContext={route:'holdings',pageTitle:'我的持仓',holdingsSnapshot:{notAuthorized:true}};globalThis.sent=[];pageContext=options=>({route:'holdings',pageTitle:'我的持仓',holdingsSnapshot:options.includeAccountData?{funds:[{code:'000001',amount:1234}]}:{notAuthorized:true}});window.fundDesktop.sendMessage=async p=>{sent.push(p);return {ok:true,data:{}}}`);
  await h.run(`sendAgent('诊断我的持仓')`);
  assert.equal(h.run('JSON.stringify(sent[0].pageContext.holdingsSnapshot)'),JSON.stringify({notAuthorized:true}));

  const authorized=harness();
  authorized.run(`render=()=>{};renderAgentPanel=()=>{};D.enabled=true;D.current={threadId:'session',dataAuthorized:false};state.nav='holdings';state.composerContext={route:'holdings',pageTitle:'我的持仓',holdingsSnapshot:{notAuthorized:true}};$('#agent-data-consent').checked=true;globalThis.sent=[];pageContext=options=>({route:'holdings',pageTitle:'我的持仓',holdingsSnapshot:options.includeAccountData?{funds:[{code:'000001',amount:1234}]}:{notAuthorized:true}});window.fundDesktop.sendMessage=async p=>{sent.push(p);return {ok:true,data:{session:{threadId:'session',dataAuthorized:true}}}};window.fundDesktop.listSessions=async()=>({ok:true,data:[{threadId:'session',dataAuthorized:true}]})`);
  await authorized.run(`sendAgent('诊断我的持仓')`);
  assert.equal(authorized.run('JSON.stringify(sent[0].pageContext.holdingsSnapshot)'),JSON.stringify({funds:[{code:'000001',amount:1234}]}));
  assert.equal(authorized.run('sent[0].authorizeAccountData'),true);
});

test('screenshot recognition runs invisibly and fills the review list', async () => {
  const h=harness();
  h.run(`render=()=>{};toast=()=>{};D.running=false;D.messages=[{id:'existing',role:'assistant',text:'已有聊天'}];state.nav='holdings';state.holdingsImport={accountId:'',asOf:'2026-09-28',images:[{name:'holdings.jpg',dataUrl:'data:image/jpeg;base64,test'}],rows:[],phase:'upload'};state.composerContext={route:'holdings'};globalThis.hiddenRequest=null;uploadHoldingsImages=async()=>{Object.assign(state.holdingsImport.images[0],{id:'a'.repeat(32),agentPath:'/runtime/holdings-import-images/'+('a'.repeat(32))+'.jpg'})};pageContext=()=>({route:'holdings',holdingsImport:{images:[{name:'holdings.jpg',imageId:'a'.repeat(32),agentPath:'/runtime/holdings-import-images/'+('a'.repeat(32))+'.jpg'}]}});window.fundDesktop.recognizeHoldingsImages=async payload=>{hiddenRequest=payload;return {ok:true,data:{funds:[{fundName:'测试基金',fundCode:'000001',amount:1234.5,holdingIncome:null,dailyIncome:-2.3}]}}};window.fundDesktop.sendMessage=async()=>{throw new Error('不应进入可见聊天')}`);
  await h.run('recognizeHoldingsImages()');
  assert.equal(h.run('state.holdingsImport.phase'),'review');
  assert.equal(h.run('state.holdingsImport.rows[0].fundName'),'测试基金');
  assert.equal(h.run('state.holdingsImport.rows[0].amount'),'1234.5');
  assert.equal(h.run('state.holdingsImport.rows[0].holdingIncome'),'');
  assert.equal(h.run('state.composerContext'),null);
  assert.equal(h.run('D.messages.length'),1);
  assert.equal(h.run('hiddenRequest.text.includes("read_uploaded_holdings_image")'),true);
  assert.equal(h.run('hiddenRequest.pageContext.holdingsImport.images.length'),1);
});

test('current progress is not inferred from an answer in a previous turn', () => {
  const h=harness();h.run(`D.messages=[{role:'assistant',text:'旧回答'},{role:'user',text:'新问题'}];D.turnMessageStart=1;D.running=true;D.turnStartedAt=Date.now()`);
  assert.match(h.run('agentProgressMarkup()'),/正在分析问题/);
  h.run(`D.messages.push({type:'tool',tool:'list_holdings',status:'running'})`);
  assert.match(h.run('agentProgressMarkup()'),/读取真实持仓/);
  const process=h.run('renderAgentMessages()');
  assert.match(process,/<details class="agent-process/);assert.doesNotMatch(process,/<details[^>]* open/);
});

test('connection retries do not appear as assistant answers', () => {
  const h=harness();
  h.run(`D.messages=[{id:'retry',role:'assistant',text:'Reconnecting... 2/5'},{id:'answer',role:'assistant',text:'已核对数据。'}]`);
  const messages=h.run('renderAgentMessages()');
  assert.doesNotMatch(messages,/Reconnecting/);
  assert.match(messages,/已核对数据/);
});

test('late backtest results do not replace the newly selected strategy', async () => {
  const h=harness();h.run(fixture);
  h.run(`state.backtestRevision=2;api=async path=>path.includes('strategy-runs')?[]:{status:'completed',result:{strategyId:'old'}}`);
  await h.run('pollJob("old-job",1)');
  assert.equal(h.run('state.result.strategyId'),'test');
});

test('missing signals and metrics stay unknown rather than zero or no-action', () => {
  const h=harness();h.run(fixture);
  h.run(`state.plans=[{id:'p',name:'计划',strategyId:'test',status:'active',latestSignal:{status:'blocked',missingData:['净值缺失']}}]`);
  const html=h.run('planCards()');
  assert.match(html,/暂无法判断/);assert.match(html,/净值缺失/);
  assert.doesNotMatch(html,/panda-return-bar|\+0\.00%/);
  assert.match(h.run(`detailBacktest({status:'ok',metrics:{},cashFlow:{fees:null}})`),/手续费未计入/);
  assert.doesNotMatch(h.run(`detailBacktest({status:'ok',metrics:{},cashFlow:{}})`),/null%|undefined%/);
});

test('strategy detail shows every trade in one scrollable table and a clear parameter toggle', () => {
  const h=harness();h.run(fixture);
  const trades=Array.from({length:8},(_,i)=>({date:`2026-01-${String(i+1).padStart(2,'0')}`,side:'buy',amount:100,nav:1,reason:'定期买入'}));
  const html=h.run(`tradesTable({fundCode:'000001',trades:${JSON.stringify(trades)}})`);
  assert.equal((html.match(/<tr>/g)||[]).length,9);
  assert.doesNotMatch(html,/查看其余|panda-disclosure/);
  const params=h.run('parameterModule(state.catalog[0],state.result.parameters,"000001",null,null)');
  assert.match(params,/aria-expanded="false"/);
  assert.match(params,/查看全部参数/);
});

test('strategy cards sort verified showcases, share valid examples and filter by remote categories', () => {
  const h=harness();
  h.run(`state.catalog=[{id:'higher',name:'较高策略',category:'趋势',description:'规则一',version:'1'},{id:'lower',name:'较低策略',category:'波动',description:'规则二',version:'1'}];state.showcases={higher:{status:'ok',best:{status:'ok',candidateName:'真实案例基金',dataAsOf:'2026-09-28',metrics:{excessReturnPct:8,absoluteReturnPct:12,volatilityPct:10},curve:[{value:1,benchmark:1},{value:1.08,benchmark:1.02}]}},lower:{status:'ok',best:{status:'ok',metrics:{excessReturnPct:-2,absoluteReturnPct:1,volatilityPct:4},curve:[]}}}`);
  assert.equal(h.run(`sortedStrategies().map(row=>row.id).join(',')`),'higher,lower');
  const card=h.run(`strategyCard(state.catalog[0])`);
  assert.match(card,/真实案例基金/);
  assert.match(card,/strategy-sparkline/);
  assert.match(card,/share-strategy-card/);
  assert.doesNotMatch(card,/toggle-strategy-favorite|toggle-strategy-compare/);
  h.run(`D.enabled=true;state.showcases.higher.best.strategyVersion='1'`);
  assert.doesNotMatch(h.run(`strategyCard(state.catalog[0])`),/data-action="share-strategy-card"[^>]* disabled/);
  h.run(`state.strategyCategory='波动'`);
  const filtered=h.run('library()');
  assert.match(filtered,/data-strategy-category="波动"/);
  assert.match(filtered,/较低策略/);
  assert.doesNotMatch(filtered,/较高策略/);
  h.run(`state.strategyCompare=['higher','lower'];state.strategyCompareOpen=true;state.nav='library'`);
  assert.equal(h.run(`quickAgentPrompts()[0][0]`),'哪种更适合我');
  h.run(`state.showcases.lower={status:'blocked',missingData:['基准净值缺失']}`);
  assert.match(h.run(`strategyCard(state.catalog[1])`),/基准净值缺失/);
});

test('pinned run remains first without adding a prefix to its strategy title', () => {
  const h=harness();h.run(fixture);
  h.run(`state.historyView.pinned=['run-a'];state.runs=[{id:'run-a',strategyId:'test',status:'ok',createdAt:'2026-01-01',metrics:{returnPct:10}}]`);
  const row=h.run('historyCard(state.runs[0])');
  assert.match(row,/is-pinned/);
  assert.match(row,/<strong>测试策略<\/strong>/);
  assert.doesNotMatch(row,/置顶 · 测试策略/);
});

test('holdings diagnosis uses the shared page-specific bottom composer prompts', () => {
  const h=harness();
  h.run(`state.nav='holdings';state.holdingsAccountScope='all';state.selectedHoldingCode='000001';state.holdingsQuestionFocus='fund';holdingsPortfolio=()=>({funds:[{fundCode:'000001',fundName:'测试基金'}]});holdingsAccountOptions=()=>[]`);
  assert.match(h.run(`quickAgentPrompts().map(row=>row.join(' ')).join(' ')`),/测试基金对我的持有收益贡献了多少/);
  h.run(`state.holdingsTab='backtest'`);
  assert.match(h.run(`quickAgentPrompts().map(row=>row.join(' ')).join(' ')`),/当前权重口径/);
  h.run(`state.holdingsTab='list'`);
  h.run(`state.holdingsQuestionFocus='account'`);
  const account=h.run(`quickAgentPrompts().map(row=>row.join(' ')).join(' ')`);
  assert.match(account,/钱主要亏在哪/);
  assert.match(account,/哪些基金拖累/);
});

test('holdings overview keeps incomplete daily income out of the main numbers', () => {
  const h=harness();
  h.run(`state.nav='holdings';state.holdingsLoaded=true;state.holdingsAccounts=[{id:'snapshot',platform:'天天基金',name:'长期账户',latestSnapshot:{asOf:'2026-09-28'}}];holdingsPortfolio=()=>({summary:{totalAmount:1000,holdingIncome:30},dailyIncome:null,latestAsOf:'2026-09-28',missingAmountCount:0,funds:[],accountCount:1})`);
  const html=h.run('holdingsPage()');
  assert.match(html,/基金资产/);
  assert.match(html,/持有收益/);
  assert.match(html,/日收益待核对/);
  assert.match(html,/最近记录 2026-09-28/);
  assert.doesNotMatch(html,/基金 \/ 账户/);
  assert.match(html,/class="holdings-actions-menu"/);
});

test('holdings account tabs and overview show complete rates without guessing missing daily income', () => {
  const h=harness();
  h.run(`state.nav='holdings';state.holdingsLoaded=true;state.holdings={fetchedAt:'2026-09-29',summary:{holdIncome:30,confirmedAmount:1030},funds:[{fundCode:'000001',fundName:'基金甲',totalAmount:1030,holdIncome:30,holdIncomeRate:'3.00%',newestIncome:10,holdVol:'100'}]};state.holdingsAccounts=[{id:'snapshot',platform:'天天基金',name:'长期账户',latestSnapshot:{asOf:'2026-09-28',funds:[{fundCode:'000002',fundName:'基金乙',amount:550,holdingIncome:50,dailyIncome:null}]}}];state.holdingsAccountScope='ths-live';state.selectedHoldingCode='000001';holdingDetail=()=>'<div>基金详情</div>'`);
  const tabs=h.run('holdingsAccountTabs()');
  assert.match(tabs,/role="tablist"/);
  assert.match(tabs,/data-holdings-scope="all"/);
  assert.match(tabs,/data-holdings-scope="ths-live"[^>]*aria-selected="true"/);
  assert.match(tabs,/data-holdings-scope="snapshot"/);
  assert.match(tabs,/data-action="holdings-add-account"/);
  const html=h.run('holdingsPage()');
  assert.match(html,/持有收益率/);
  assert.match(html,/估算日收益率/);
  assert.match(html,/\+3\.00%/);
  assert.match(html,/\+10\.00/);
  assert.match(html,/holding-fund-rate/);
  assert.doesNotMatch(html,/<i aria-hidden="true"><em style="width:/);
  h.run(`state.holdingsAccountScope='all'`);
  assert.equal(h.run('holdingsPortfolio().dailyIncome'),null);
  h.run(`state.holdingsAccounts[0].latestSnapshot.funds=[]`);
  assert.equal(h.run('holdingsPortfolio().dailyIncome'),10);
  h.run(`state.holdingsAccounts[0].latestSnapshot.funds=[{fundCode:'000002',fundName:'基金乙',amount:550,holdingIncome:50,dailyIncome:null}]`);
  h.run(`state.holdings.funds[0].newestIncome=null`);
  const incomplete=h.run('holdingsPortfolio()');
  assert.equal(incomplete.dailyIncome,null);
  assert.equal(incomplete.dailyRate,null);
  h.run(`state.holdingsAccountScope='snapshot'`);
  assert.equal(h.run('holdingsPortfolio().funds[0].holdingRate'),10);
});

test('fund detail leads with the NAV chart and keeps account facts in secondary sections', () => {
  const h=harness();
  h.run(`state.holdingDetails['000001']={nav:{points:[],dataAsOf:'2026-09-28'},history:{orders:[]}};lineChart=()=>'<svg></svg>'`);
  const html=h.run(`holdingDetail({fundCode:'000001',fundName:'测试基金',totalAmount:1000,holdIncome:30,newestIncome:null,holdVol:100,accounts:[{platform:'同花顺',accountName:'实时账户',source:'thsfund',amount:1000,holdingIncome:30}]})`);
  assert.ok(html.indexOf('holding-detail-chart')<html.indexOf('交易记录'));
  assert.match(html,/不代表个人账户收益/);
  assert.match(html,/持仓来源与份额/);
  assert.doesNotMatch(html,/账户分布/);
  assert.doesNotMatch(html,/持有收益率/);
});

test('holding rows and assistant fund cards expose the shared full fund detail route', () => {
  const h=harness();
  const card=h.run("renderFundCard({name:'测试基金',code:'000001',nav:1.25,source:'测试数据',dataAsOf:'2026-09-28'})");
  assert.match(card,/data-open-fund="000001"/);
  const rows=h.run("state.holdingsSearch='';state.holdingsSort='amount';state.holdingsMetric='holding';holdingsList([{fundCode:'000001',fundName:'测试基金',totalAmount:1000,holdIncome:10,holdingRate:1}],1000)");
  assert.match(rows,/data-open-fund="000001"/);
  assert.match(rows,/data-holding-select="000001"/);
});

test('portfolio comparison is explicitly a current-weight simulation', () => {
  const h=harness();
  h.run(`state.analysis={metrics:{returnPct:5,maxDrawdownPct:-2,volatilityPct:10,sharpe:1},benchmarkMetrics:{returnPct:2},simulationAmount:1000,history:[{date:'2026-01-01',value:1},{date:'2026-09-28',value:1.05}],benchmark:[],asOf:'2026-09-28',findings:[],allocations:[{name:'宽基',funds:2,percent:60,color:'#aaa'}]};lineChart=()=>'<svg></svg>'`);
  const html=h.run('portfolioPanel()');
  assert.match(html,/按当前权重模拟，非账户实际收益/);
  assert.match(html,/相对基准/);
  assert.match(html,/不含历史申赎现金流、个人费率与税费/);
  assert.match(html,/class="holdings-backtest-secondary" aria-label="更多指标"/);
  assert.match(html,/模拟盈亏 <b class="up">\+50\.00 元<\/b>/);
  assert.ok(html.indexOf('holdings-backtest-kpis')<html.indexOf('holdings-backtest-secondary'));
  assert.ok(html.indexOf('holdings-backtest-secondary')<html.indexOf('holdings-analysis-grid'));
  assert.match(html,/<div class="holdings-analysis-side"><section class="holdings-classification"/);
  assert.match(html,/持仓分类[\s\S]*宽基[\s\S]*60\.00%/);
  assert.doesNotMatch(html,/<summary>[^<]*持仓分类/);
});

test('multiple conversations stay open as tabs and preserve their own messages', async () => {
  const h=harness();
  h.run(`render=()=>{};globalThis.started=0;window.fundDesktop.newSession=async()=>({ok:true,data:{session:{threadId:'t'+(++started),title:'新会话'}}});window.fundDesktop.listSessions=async()=>({ok:true,data:[{threadId:'t1',title:'一'},{threadId:'t2',title:'二'}]});window.fundDesktop.resumeSession=async id=>({ok:true,data:{session:{threadId:id,title:id},thread:{turns:[]}}})`);
  await h.run('newSession()');
  h.run(`D.messages.push({id:'m1',role:'assistant',text:'第一段'})`);
  await h.run('newSession()');
  assert.equal(h.run('state.openSessionIds.length'),2);
  assert.equal(h.run('D.messages.length'),0);
  await h.run(`resumeSession('t1')`);
  assert.equal(h.run('D.messages[0].text'),'第一段');
  assert.equal(h.run('D.current.threadId'),'t1');
});

test('background conversation updates do not replace the visible conversation', () => {
  const h=harness();
  h.run(`renderAgentPanel=()=>{};renderOpenTabs=()=>{};D.current={threadId:'visible'};D.messages=[{id:'v',role:'assistant',text:'当前对话'}];D.threadViews.set('background',{messages:[{id:'b',role:'user',text:'另一对话'}],tools:new Map(),running:true,pendingInput:null,turnStartedAt:Date.now(),turnMessageStart:0});D.activeThreadId='background'`);
  h.run(`onAgentEvent({method:'item/agentMessage/delta',params:{threadId:'background',itemId:'answer',delta:'后台回复'}})`);
  assert.equal(h.run('D.messages.length'),1);
  assert.equal(h.run('D.messages[0].text'),'当前对话');
  assert.equal(h.run(`D.threadViews.get('background').messages[1].text`),'后台回复');
  h.run(`window.fundDesktop.listSessions=async()=>({ok:true,data:[]});onAgentEvent({method:'turn/completed',params:{threadId:'background'}})`);
  assert.equal(h.run('D.activeThreadId'),null);
  assert.equal(h.run(`D.threadViews.get('background').running`),false);
  assert.equal(h.run('D.current.threadId'),'visible');
});

test('resuming a conversation loads recorded turns when a notification made an empty cache', async () => {
  const h=harness();
  h.run(`render=()=>{};renderAgentPanel=()=>{};D.current={threadId:'first'};D.threadViews.set('older',{messages:[],tools:new Map(),running:false});window.fundDesktop.resumeSession=async()=>({ok:true,data:{session:{threadId:'older',title:'旧会话'},thread:{turns:[{items:[{id:'u',type:'userMessage',content:[{type:'text',text:'历史提问'}]},{id:'a',type:'agentMessage',text:'历史回答'}]}]}}})`);
  await h.run(`resumeSession('older')`);
  assert.equal(h.run('D.messages.length'),2);
  assert.equal(h.run('D.messages[0].text'),'历史提问');
  assert.equal(h.run('D.messages[1].text'),'历史回答');
});
