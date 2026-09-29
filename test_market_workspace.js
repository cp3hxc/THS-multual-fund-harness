const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function workspace() {
  const saved = new Map();
  const opened = [];
  const context = vm.createContext({
    localStorage: {
      getItem: key => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
    document: { addEventListener() {} },
    state: {
      nav: 'market', watchlist: [{ code: '000001', name: '测试基金' }],
      marketIndices: { quotes: [{ code: 'sh000300', name: '沪深300', point: 4000, changePct: 1,
        asOf: '2026-09-29T10:00:00+08:00', status: '交易中' }] },
      holdings: null,
      selected: null, runFocus: null, selectedHoldingCode: '', holdingsAccountScope: 'all',
    },
    api: async () => ({}), render() {}, pageContext: () => ({ route: 'test' }),
    openWorkbench: (prompt, page) => opened.push({ prompt, page }),
    esc: value => String(value ?? ''),
    n: value => value === null || value === undefined ? null : Number(value),
    num: value => String(value), pct: value => String(value), tone: () => '', dt: value => String(value),
    $: () => null, Date, Map, Set, Intl, console,
    setTimeout() {}, clearTimeout() {}, queueMicrotask() {},
  });
  vm.runInContext(fs.readFileSync('market-studio.js', 'utf8'), context);
  return { run: expression => vm.runInContext(expression, context), saved, opened };
}

test('new page keeps page actions to template selection; Agent guidance stays in the bottom composer', () => {
  const { run } = workspace();
  const html = run('marketNewPage()');
  assert.match(html, /新建页面/);
  assert.match(html, /data-kind="home"/);
  assert.match(html, /data-kind="detail"/);
  assert.doesNotMatch(html, /data-ms-action="new-page-agent"/);
  assert.equal((html.match(/data-ms-action="new-page-template"/g) || []).length, 2);
});

test('index page can hand the selected index to Agent page design', () => {
  const { run, opened } = workspace();
  run("MS.view='indexes';MS.indexCode='sh000300';marketStartAgentDesign('home','','sh000300')");
  assert.equal(run('MS.view'), 'home');
  assert.match(opened[0].prompt, /沪深300/);
  assert.equal(run('marketPageContext().creationIntent'), 'create');
});

test('Agent page design opens in context and saves without a success banner', () => {
  const { run, opened } = workspace();
  run("MS.view='new-page';state.nav='pages';marketStartAgentDesign('home')");
  assert.equal(run('MS.view'), 'home');
  assert.equal(run('MS.newPageMode'), true);
  assert.equal(run('marketPageContext().creationIntent'), 'create');
  assert.match(opened[0].prompt, /设计/);
  const version = run('marketPageContext().baseVersion');
  const marker = `[[MARKET_PAGE_DRAFT:${JSON.stringify({
    mode: 'create', scope: 'home', name: '每日关注', baseVersion: version,
    widgets: ['indices', 'watchlist'],
  })}]]`;
  assert.equal(run(`marketAcceptAIDraft(${JSON.stringify(marker)})`), true);
  assert.equal(run('MS.newPageDraft.page.name'), '每日关注');
  assert.equal(run('MS.notice'), '');
  assert.equal(run('marketPageContext().creationIntent'), 'update');
  const updated = `[[MARKET_PAGE_DRAFT:${JSON.stringify({
    mode: 'update', scope: 'home', name: '每日关注',
    baseVersion: run('marketPageContext().baseVersion'), widgets: ['watchlist', 'indices'],
  })}]]`;
  assert.equal(run(`marketAcceptAIDraft(${JSON.stringify(updated)})`), true);
  assert.deepEqual(Array.from(run('MS.newPageDraft.page.widgets')), ['watchlist', 'indices']);
  assert.equal(run('marketCommitNewPage()'), true);
  assert.equal(run('MS.works[0].name'), '每日关注');
  assert.equal(run('MS.notice'), '');
  assert.match(run('MS.saveFeedback'), /已保存/);
  assert.doesNotMatch(run('marketStudioPage()'), /class="ms-notice"/);
});

test('AI creates a separate preview draft with only ready widgets', () => {
  const { run } = workspace();
  run("MS.view='community';MS.communityTab='home';state.nav='pages'");
  const version = run('marketPageContext().baseVersion');
  const marker = `[[MARKET_PAGE_DRAFT:${JSON.stringify({
    mode: 'create', scope: 'home', name: '我的市场页', baseVersion: version,
    widgets: ['indices', 'watchlist'],
  })}]]`;
  assert.equal(run(`marketAcceptAIDraft(${JSON.stringify(marker)})`), true);
  assert.equal(run('MS.newPageDraft.page.name'), '我的市场页');
  assert.equal(run('Object.keys(MS.pages).length'), 0);
  assert.equal(run('MS.works.length'), 0);
  assert.equal(run('state.nav'), 'market');
  assert.equal(run('MS.view'), 'home');

  const unsupported = `[[MARKET_PAGE_DRAFT:${JSON.stringify({
    mode: 'create', scope: 'home', name: '错误页面', baseVersion: version,
    widgets: ['fund-chart'],
  })}]]`;
  assert.equal(run(`marketAcceptAIDraft(${JSON.stringify(unsupported)})`), false);
});

test('reference NAV requires the previous official NAV date', () => {
  const { run } = workspace();
  const current = run("marketReferenceNav({date:'2026-09-28',value:1.2},{asOf:'2026-09-29T10:00:00+08:00',changePct:2})");
  assert.equal(current, 1.224);
  assert.equal(run("marketReferenceNav({date:'2026-09-25',value:1.2},{asOf:'2026-09-29T10:00:00+08:00',changePct:2})"), null);
});

test('saved page listing contains layout metadata without account figures', () => {
  const { run } = workspace();
  run("MS.pages.home={kind:'home',name:'测试行情',widgets:['indices'],revision:2};state.holdings={summary:{totalAmount:987654321}};");
  const html = run('marketMyPages()');
  assert.match(html, /测试行情/);
  assert.match(html, /v2/);
  assert.doesNotMatch(html, /987654321/);
});

test('行情默认页只展示大盘和自选，账户摘要不与市场指标混在一起', () => {
  const { run } = workspace();
  const page = run('marketCurrent()');
  assert.deepEqual(Array.from(page.widgets), ['indices', 'watchlist']);
  const html = run('marketHome()');
  assert.match(html, /大盘概览/);
  assert.match(html, /自选基金/);
  assert.doesNotMatch(html, /我的持仓/);
});

test('看行情入口固定两块，保存过的完整布局仍可从我的页面打开', () => {
  const { run } = workspace();
  run("MS.pages.home={id:'saved-home',kind:'home',name:'趋势观察',sourceTemplate:'trend-home',widgets:['index-focus','indices','watchlist','drawdown-list']};marketEnsureFunds=()=>{};marketEnsurePublic=()=>{};marketEnsureEstimates=()=>{};");
  assert.deepEqual(Array.from(run('marketCurrent().widgets')), ['indices', 'watchlist']);
  assert.deepEqual(Array.from(run('marketPageContext().widgets')), ['indices', 'watchlist']);
  assert.equal(run('marketPageContext().creationIntent'), 'create');
  const landing = run('marketStudioPage()');
  assert.deepEqual(Array.from(landing.matchAll(/data-widget="([^"]+)"/g), match => match[1]), ['indices', 'watchlist']);
  assert.doesNotMatch(landing, /切换视图|让 Agent 调整/);
  assert.match(run('marketMyPages()'), /趋势观察/);

  assert.equal(run("marketOpenSavedLayout('home')"), true);
  assert.deepEqual(Array.from(run('marketCurrent().widgets')), ['index-focus', 'indices', 'watchlist', 'drawdown-list']);
  run("marketShowFund('000001');marketBack()");
  assert.deepEqual(Array.from(run('marketCurrent().widgets')), ['index-focus', 'indices', 'watchlist', 'drawdown-list']);
  run('marketOpenLanding()');
  assert.deepEqual(Array.from(run('marketCurrent().widgets')), ['indices', 'watchlist']);
});

test('未保存的个人页面草稿不覆盖看行情入口或已保存布局', () => {
  const { run } = workspace();
  run("MS.pages.home={id:'saved-home',kind:'home',name:'已保存布局',widgets:['indices','watchlist','alerts']};MS.newPageDraft={scope:'home',page:{id:'pending',kind:'home',name:'未保存草稿',widgets:['indices','alerts']},updatedAt:'draft-version'};");
  assert.deepEqual(Array.from(run('marketCurrent().widgets')), ['indices', 'watchlist']);
  assert.doesNotMatch(run('marketStudioPage()'), /ms-preview-bar/);
  assert.equal(run("marketOpenSavedLayout('home')"), true);
  assert.deepEqual(Array.from(run('marketCurrent().widgets')), ['indices', 'watchlist', 'alerts']);
  assert.equal(run('MS.newPageDraft.page.name'), '未保存草稿');
});

test('旧行情布局的编辑草稿可从我的页面继续完成', () => {
  const { run } = workspace();
  run("MS.pages.home={id:'saved-home',kind:'home',name:'已保存布局',widgets:['indices','watchlist']};MS.draft={scope:'home',page:{id:'saved-home',kind:'home',name:'编辑中的布局',widgets:['watchlist','indices','alerts']},updatedAt:'draft-version'};");
  assert.deepEqual(Array.from(run('marketCurrent().widgets')), ['indices', 'watchlist']);
  assert.equal(run("marketOpenSavedLayout('home')"), true);
  assert.equal(run('MS.editing'), true);
  assert.equal(run('marketCurrent().name'), '编辑中的布局');
  assert.match(run('marketStudioPage()'), /保存页面/);
});

test('我的页面只列出本人已保存内容，视图选择单独展示', () => {
  const { run } = workspace();
  run("MS.pages.home={kind:'home',name:'我的布局',widgets:['indices']};MS.works=[{id:'w1',kind:'home',name:'我的自选页',widgets:['watchlist']}]");
  const myPages = run('marketMyPages()');
  assert.match(myPages, /我的布局/);
  assert.match(myPages, /我的自选页/);
  assert.doesNotMatch(myPages, /ms-template-grid|页面广场|综合行情/);
  const picker = run("MS.view='community';MS.communityTab='detail';marketPlaza()");
  assert.match(picker, /选择视图/);
  assert.match(picker, /基金详情/);
  assert.doesNotMatch(picker, /更多视图|ms-more-views/);
  assert.equal((picker.match(/data-ms-action="preview-work"/g) || []).length, 6);
  assert.doesNotMatch(picker, /总览工作台/);
});

test('新建页面分别保存，重新打开后编辑只更新当前页面', () => {
  const { run } = workspace();
  run('marketEnsureFunds=()=>{};marketEnsurePublic=()=>{};marketEnsureEstimates=()=>{};');
  run("marketStartWorkPreview(marketTemplate('balanced-home'),'',true);marketCommitNewPage()");
  const firstId = run('MS.works[0].id');
  run("marketStartWorkPreview(marketTemplate('compact-home'),'',true);marketCommitNewPage()");
  const secondId = run('MS.works[1].id');
  assert.notEqual(firstId, secondId);
  assert.equal(run('MS.works.length'), 2);

  run(`marketOpenSavedWork(MS.works.find(row=>row.id===${JSON.stringify(firstId)}));MS.draft={scope:marketScope(),page:{...marketCurrent(),name:'调整后的行情页'},updatedAt:new Date().toISOString()};marketSave()`);
  assert.equal(run('MS.works.length'), 2);
  assert.equal(run('MS.works.find(row=>row.id===MS.activeWorkId).id'), firstId);
  assert.equal(run('MS.works.find(row=>row.id===MS.activeWorkId).name'), '调整后的行情页');
  assert.equal(run('MS.works.find(row=>row.id===MS.activeWorkId).revision'), 2);
  assert.equal(run('Object.keys(MS.history).includes("work:"+MS.activeWorkId)'), true);

  const html = run('marketMyPages()');
  assert.match(html, /open-saved-work/);
  assert.match(html, /调整后的行情页/);
});

test('详情页新建需要明确基金代码并绑定到保存页面', () => {
  const { run } = workspace();
  run('marketEnsureFunds=()=>{};marketEnsurePublic=()=>{};marketEnsureEstimates=()=>{};');
  assert.equal(run("marketStartWorkPreview(marketTemplate('balanced-detail'),'',true)"), false);
  assert.equal(run("marketStartWorkPreview(marketTemplate('balanced-detail'),'000001',true)"), true);
  assert.equal(run('MS.newPageDraft.page.sourceFundCode'), '000001');
  run('marketCommitNewPage()');
  assert.equal(run('MS.works[0].kind'), 'detail');
  assert.equal(run('MS.works[0].sourceFundCode'), '000001');
  assert.equal(run('MS.activeWorkId'), run('MS.works[0].id'));
});

test('基金视图预览不会擅自选中第一只自选基金', () => {
  const { run } = workspace();
  run("MS.communityReturn='home';MS.fundCode='';");
  assert.equal(run("marketPreviewFundCode({kind:'detail'})"), '');
  run("MS.communityReturn='fund';MS.fundCode='000001';");
  assert.equal(run("marketPreviewFundCode({kind:'detail'})"), '000001');
  assert.equal(run("marketPreviewFundCode({kind:'detail',sourceFundCode:'000002'})"), '000002');
});

test('统一基金详情返回原页面，并支持基金间前进返回', () => {
  const { run } = workspace();
  run("marketEnsureFunds=()=>{};marketEnsurePublic=()=>{};marketEnsureEstimates=()=>{};state.nav='history';state.selected='strategy-a';state.runFocus='run-a';MS.view='home';");
  run("marketShowFund('000001')");
  assert.equal(run('state.nav'), 'market');
  assert.equal(run('MS.returnTo.nav'), 'history');
  assert.equal(run('MS.returnTo.selected'), 'strategy-a');
  run("marketShowFund('000002')");
  assert.equal(run('MS.fundTrail.length'), 1);
  run('marketBack()');
  assert.equal(run('MS.fundCode'), '000001');
  run("openRun=id=>{state.reopenedRun=id};marketBack()");
  assert.equal(run('state.nav'), 'history');
  assert.equal(run('state.reopenedRun'), 'run-a');
  assert.equal(run('state.selected'), 'strategy-a');
  assert.equal(run('MS.view'), 'home');
});
