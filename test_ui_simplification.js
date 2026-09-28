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
  assert.equal(h.run('state.nav'),'workbench');assert.equal(h.run('sent.length'),0);
  await h.run(`sendAgent('帮我分析')`);
  assert.equal(h.run('sent[0].pageContext.route'),'holdings');
  assert.equal(h.run('sent[0].pageContext.selectedFund.code'),'000001');
  assert.equal(h.run('sent[0].text'),'帮我分析');
  assert.equal(h.run('state.composerContext'),null);
});

test('current progress is not inferred from an answer in a previous turn', () => {
  const h=harness();h.run(`D.messages=[{role:'assistant',text:'旧回答'},{role:'user',text:'新问题'}];D.turnMessageStart=1;D.running=true;D.turnStartedAt=Date.now()`);
  assert.match(h.run('agentProgressMarkup()'),/正在分析问题/);
  h.run(`D.messages.push({type:'tool',tool:'list_holdings',status:'running'})`);
  assert.match(h.run('agentProgressMarkup()'),/读取真实持仓/);
  const process=h.run('renderAgentMessages()');
  assert.match(process,/<details class="agent-process/);assert.doesNotMatch(process,/<details[^>]* open/);
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
