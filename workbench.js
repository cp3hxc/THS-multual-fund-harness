'use strict';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n = v => v === null || v === undefined || v === '' || v === '-' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const num = v => n(v) === null ? '—' : n(v).toLocaleString('zh-CN', {minimumFractionDigits:2,maximumFractionDigits:2});
const money = v => n(v) === null ? '—' : '¥' + num(v);
const signed = v => n(v) === null ? '—' : (n(v)>0?'+':'') + num(v);
const color = v => n(v) === null || n(v) === 0 ? '' : n(v)>0 ? 'up' : 'down';
const dateTime = s => s ? new Date(s).toLocaleString('zh-CN',{hour12:false}) : '—';
const timeOnly = s => s ? new Date(s).toLocaleTimeString('zh-CN',{hour12:false}) : '—';
const fmtDate = v => /^\d{8}$/.test(String(v)) ? `${String(v).slice(0,4)}-${String(v).slice(4,6)}-${String(v).slice(6)}` : esc(v || '接口未提供');
const titles = {home:'问 AI', holdings:'我的持仓', trades:'订单中心', watchlist:'自选基金', library:'策略中心', strategies:'我的策略', 'strategy-invest':'策略投资', settings:'接入设置'};
const S = {csrf:'', state:{strategies:[],watchlist:[],drafts:[],strategyPlans:[],strategyEvents:[],strategyRuns:[]}, templates:[], strategyCatalog:[], strategyPlans:[], strategyEvents:[], strategyRuns:[], strategySelected:null, strategyResult:null, strategyBusy:false, strategyCode:'', ai:null, holdings:null,
  route:'holdings', holdingTab:'list', holdingError:'', loadingHoldings:false, orders:[], ordersLoaded:false,
  analysis:null, analysisError:'', analysisBusy:false,
  ordersError:'', orderNext:null, orderPage:1, orderBusy:false, orderTab:'records', orderFilter:'',
  modelMode:'subscription', messages:[], chatBusy:false, mineFilter:'current', fundConnected:false,
  selectedOrders:new Set()};
const D = {enabled:Boolean(window.fundDesktop), settings:null, status:null, sessions:[], current:null,
  messages:[], tools:new Map(), running:false, panelOpen:true, initialized:false, pendingInput:null, plan:null,
  subscriptionDraftModel:null, subscriptionDraftEffort:null};
let toastTimer, modalToken=0, activeFund=null, activePreview=null, lastFocus=null, strategyMonitorTimer=null;

async function api(path, body) {
  const ctrl = new AbortController();
  const timeout = setTimeout(()=>ctrl.abort(), path.includes('/ai/chat')?220000:90000);
  try {
    const res = await fetch(path,{method:body===undefined?'GET':'POST',cache:'no-store',signal:ctrl.signal,
      headers:body===undefined?{}:{'Content-Type':'application/json','X-Workbench-Token':S.csrf},
      body:body===undefined?undefined:JSON.stringify(body)});
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error?.message || '请求失败，请重试。');
    return data.data;
  } catch(e) {
    if(e.name==='AbortError') throw new Error('请求超时，请稍后手动重试。');
    if(e instanceof TypeError) throw new Error('本地服务未连接。请运行 npm run start:web，再打开本地工作台。');
    throw e;
  } finally {clearTimeout(timeout);}
}
function toast(message) {$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4200);}
const button = (text, action, attrs='', cls='') => `<button type="button" class="button ${cls}" data-action="${action}" ${attrs}>${text}</button>`;
const banner = (text, type='', action='') => `<div class="banner ${type}"><span class="banner-icon">${type==='error'?'!':'ⓘ'}</span><div class="grow">${text}</div>${action}</div>`;
const empty = (title, text, action='', symbol='◌') => `<div class="empty"><div class="empty-icon">${symbol}</div><h2>${title}</h2><p>${text}</p>${action}</div>`;
const stat = (label,value,note,cls='') => `<div class="stat ${cls}"><div class="stat-label">${label}</div><div class="stat-number">${value}</div><div class="stat-note">${note}</div></div>`;
const kv = (key,value) => `<div class="metric-row"><span>${key}</span><span>${value??'—'}</span></div>`;
const head = (eyebrow,title,desc,actions='') => `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="page-description">${desc}</p></div><div class="head-actions">${actions}</div></div>`;
const loading = text => `<div class="loading"><span class="spinner"></span>${text}</div>`;
const getFund = code => S.holdings?.funds.find(x=>x.fundCode===code);
const getStrategy = code => S.state.strategies.find(x=>x.status!=='archived' && x.codes.includes(code));
const getTemplate = id => S.templates.find(t=>t.id===id);
const aiConnected = () => S.ai?.mode==='subscription' ? S.ai?.subscription.connected : S.ai?.keyConfigured;

function shellStatus() {
  $('#holding-count').textContent=S.holdings?.summary.fundCount ?? '—';
  $('#strategy-count').textContent=S.state.strategies.filter(x=>x.status!=='archived').length;
  if($('#strategy-invest-count'))$('#strategy-invest-count').textContent=S.strategyCatalog.length||5;
  $('#fund-dot').className='dot '+(S.fundConnected?'green':'amber');
  $('#fund-connection').textContent=S.fundConnected?'账户已连接 · 数据来自真实接口':S.holdingError?'连接异常 · 请检查授权':'等待账户数据';
  $('#sync-status').innerHTML=S.holdings?`<span class="dot ${S.holdingError?'amber':'green'}"></span>${S.holdingError?'同步失败 · 保留上次快照':'账户同步于 '+esc(timeOnly(S.holdings.fetchedAt))}`:'尚未同步账户';
  $('#ai-side-status').textContent=aiConnected()?(S.ai.mode==='subscription'?'已登录':'已配置'):'待接入';
  $('#ai-top-status').textContent=aiConnected()?(S.ai.mode==='subscription'?'ChatGPT 订阅 ↗':'API 模型 ↗'):'接入 AI ↗';
  if(D.enabled && D.settings){
    const provider=D.settings.activeMode==='subscription'?'Codex 订阅':D.settings.providers.find(x=>x.id===D.settings.activeProviderId)?.name||'API 模型';
    $('#ai-side-status').textContent=provider;
    $('#ai-top-status').textContent=provider+' ↗';
  }
  document.querySelectorAll('.nav').forEach(e=>e.classList.toggle('active',e.dataset.route===S.route));
}
function navigate(route) {
  if(!titles[route]) return;
  if(location.hash==='#'+route) render(); else location.hash=route;
}
function routeChanged() {
  S.route=titles[location.hash.slice(1)]?location.hash.slice(1):'holdings';
  closeDialog();render();window.scrollTo({top:0});
  if(S.route==='trades' && !S.ordersLoaded && !S.orderBusy) loadOrders();
  if(S.route==='holdings' && S.holdingTab==='analysis' && S.holdings && !S.analysis && !S.analysisBusy) loadAnalysis();
  if(S.route==='strategy-invest' && !S.strategyCatalog.length && !S.strategyBusy) loadStrategyInvest();
}
function render() {
  shellStatus();
  // Keep the live Agent DOM (and its event listeners) while replacing page content.
  const agentShell=$('#agent-shell');
  if(agentShell&&$('#content').contains(agentShell))$('#agent-panel').append(agentShell);
  const views={holdings:renderHoldings,library:renderLibrary,strategies:renderStrategies,
    trades:renderTrades,watchlist:renderWatchlist,settings:renderSettings,home:renderHome,'strategy-invest':renderStrategyInvest};
  $('#content').innerHTML=views[S.route]();
  placeAgentSurface();
}

function placeAgentSurface(){
  if(!D.enabled)return;
  const shell=$('#agent-shell'),panel=$('#agent-panel'),inline=$('#agent-inline-host');
  if(S.route==='home'&&inline){
    inline.append(shell);document.body.classList.add('home-agent');panel.hidden=true;
  }else{
    panel.append(shell);document.body.classList.remove('home-agent');panel.hidden=!D.panelOpen;
    document.body.classList.toggle('agent-collapsed',!D.panelOpen);
  }
  if(D.initialized)renderAgentPanel();
}
async function reloadState() {S.state=await api('/api/state');shellStatus();}
async function loadStrategyInvest(){
  if(S.strategyBusy)return;
  S.strategyBusy=true;
  if(S.route==='strategy-invest')render();
  try{
    const [catalog,plans,runs,events]=await Promise.all([
      api('/api/strategy-invest/catalog'),api('/api/strategy-plans'),api('/api/strategy-runs'),api('/api/strategy-events')
    ]);
    S.strategyCatalog=Array.isArray(catalog)?catalog:[];S.strategyPlans=Array.isArray(plans)?plans:[];S.strategyRuns=Array.isArray(runs)?runs:[];S.strategyEvents=Array.isArray(events)?events:[];
    S.state.strategyPlans=S.strategyPlans;S.state.strategyEvents=S.strategyEvents;S.state.strategyRuns=S.strategyRuns;
    startStrategyMonitor();
  }catch(e){toast(e.message);}
  finally{S.strategyBusy=false;if(S.route==='strategy-invest')render();}
}
function startStrategyMonitor(){
  if(strategyMonitorTimer)return;
  strategyMonitorTimer=setInterval(async()=>{
    if(!S.strategyPlans.some(x=>x.status==='active'))return;
    try{
      const plans=await api('/api/strategy-plans/check-all',{});if(Array.isArray(plans)){
        const current=new Map(S.strategyPlans.map(x=>[x.id,x]));plans.forEach(x=>current.set(x.id,x));S.strategyPlans=[...current.values()];S.state.strategyPlans=S.strategyPlans;if(S.route==='strategy-invest')render();
      }
    }catch(e){if(S.route==='strategy-invest')toast('策略检查失败：'+e.message);}
  },30*60*1000);
}
async function checkStrategyPlansOnStartup(){
  if(!S.strategyPlans.some(x=>x.status==='active'))return;
  try{const plans=await api('/api/strategy-plans/check-all',{});if(Array.isArray(plans)){const current=new Map(S.strategyPlans.map(x=>[x.id,x]));plans.forEach(x=>current.set(x.id,x));S.strategyPlans=[...current.values()];S.state.strategyPlans=S.strategyPlans;if(S.route==='strategy-invest')render();}}catch(e){if(S.route==='strategy-invest')toast('启动检查失败：'+e.message);}
}
async function refreshStrategyInvest(){
  const [plans,runs,events]=await Promise.all([api('/api/strategy-plans'),api('/api/strategy-runs'),api('/api/strategy-events')]);
  S.strategyPlans=Array.isArray(plans)?plans:[];S.strategyRuns=Array.isArray(runs)?runs:[];S.strategyEvents=Array.isArray(events)?events:[];S.state.strategyPlans=S.strategyPlans;S.state.strategyRuns=S.strategyRuns;S.state.strategyEvents=S.strategyEvents;
}
async function loadHoldings() {
  if(S.loadingHoldings)return;
  S.loadingHoldings=true;
  if(['holdings','home'].includes(S.route))render();
  try{S.holdings=await api('/api/holdings');S.holdingError='';S.fundConnected=true;S.analysis=null;S.analysisError='';}
  catch(e){S.holdingError=e.message;S.fundConnected=false;}
  finally{S.loadingHoldings=false;shellStatus();if(['home','holdings','watchlist','strategies','settings'].includes(S.route))render();}
}
async function loadAnalysis(){
  if(S.analysisBusy)return;
  S.analysisBusy=true;S.analysisError='';if(S.route==='holdings')render();
  try{S.analysis=await api('/api/portfolio-analysis');}
  catch(e){S.analysisError=e.message;}
  finally{S.analysisBusy=false;if(S.route==='holdings'&&S.holdingTab==='analysis')render();}
}
function holdingsSummary() {
  const d=S.holdings,s=d.summary,partial=d.fundApi.failedCategories.length>0;
  const pending=n(s.pendingAmount),pendingNote=pending>0?` · 含 ${s.pendingCount} 只待确认 ${money(pending)}`:'';
  return `<div class="stat-grid">${stat('基金资产总额',`<span class="currency">¥</span>${num(s.totalAmount)}`,`${esc(s.fundCount??'—')} 只基金${pendingNote} · ${partial?'部分账户数据':'接口汇总口径'}`,'featured')}
    ${stat('持有收益',`<span class="${color(s.holdIncome)}">${signed(s.holdIncome)}</span>`,'单位：元 · 当前持仓汇总')}
    ${stat('最新日收益',`<span class="${color(s.newestIncome)}">${signed(s.newestIncome)}</span>`,'各基金更新时间可能不同')}
    ${stat('钱包总份额',num(d.wallet.ok?d.wallet.total:null),'货币基金钱包 · 与基金持仓分列')}</div>`;
}
function renderHoldings() {
  const top=head('PORTFOLIO','我的持仓','直接从具体持仓发起申购或赎回，提交前核对真实规则与账户。',button(S.loadingHoldings?'同步中…':'⟳ 同步账户','refresh-holdings',S.loadingHoldings?'disabled':'')+button('查看订单 ↗','nav','data-to="trades"','primary'));
  if(!S.holdings)return top+(S.loadingHoldings?loading('正在从同花顺爱基金获取持仓…'):`<div class="card">${empty('账户数据尚未就绪',esc(S.holdingError||'连接账户后显示真实持仓与钱包数据。'),button('连接基金账户','nav','data-to="settings"','primary'))}</div>`);
  const d=S.holdings;
  let notice=S.holdingError?banner(esc(S.holdingError)+' 当前展示上次成功同步的快照。','error'):'';
  if(d.fundApi.failedCategories.length)notice+=banner(`部分持仓类别查询失败（${esc(d.fundApi.failedCategories.join('、'))}），当前合计不代表完整账户。`,'warning');
  if(!d.wallet.ok)notice+=banner('钱包数据获取失败，基金持仓已独立展示。','warning');
  const tabs=`<div class="tabs">${[['list','持仓明细'],['analysis','组合分析'],['wallet','钱包与账户']].map(([id,label])=>`<button class="tab ${S.holdingTab===id?'active':''}" data-action="holding-tab" data-tab="${id}">${label}${id==='list'?`<span class="count">${d.funds.length}</span>`:''}</button>`).join('')}</div>`;
  return top+notice+holdingsSummary()+tabs+(S.holdingTab==='list'?holdingsTable():S.holdingTab==='analysis'?holdingsAnalysis():walletView());
}
function holdingsTable() {
  const d=S.holdings,total=n(d.summary.totalAmount);
  const rows=d.funds.map(f=>{
    const s=getStrategy(f.fundCode);
    const pending=f.holdVol==='待确认';
    return `<tr data-holding-row data-search="${esc((f.fundCode+' '+f.fundName).toLowerCase())}"><td><span class="fund-name">${esc(f.fundName)}</span><span class="fund-code">${esc(f.fundCode)}</span></td><td class="right num">${money(f.totalAmount)}<span class="fund-code">${pending?'待确认份额':n(f.holdVol)===null?esc(f.holdVol||'—'):num(f.holdVol)+' 份'}</span></td><td class="right num ${color(f.holdIncome)}">${signed(f.holdIncome)}<span class="fund-code ${color(f.holdIncome)}">${esc(f.holdIncomeRate||'—')}</span></td><td class="right num ${color(f.newestIncome)}">${signed(f.newestIncome)}</td><td>${s?`<span class="tag amber" title="${esc(s.name)}">草稿关联</span>`:'<span class="tag">未关联</span>'}</td><td class="right"><div class="row-actions">${button('申购','buy-prepare',`data-code="${f.fundCode}"`,'small primary')}${button('赎回','redeem-prepare',`${pending?'disabled title="份额确认后才可赎回"':''} data-code="${f.fundCode}"`,'small')}${button('详情','fund-detail',`data-code="${f.fundCode}"`,'small subtle')}</div></td></tr>`;
  }).join('');
  const bars=d.funds.slice(0,5).map(f=>`<div class="allocation-row"><div class="allocation-name"><span>${esc(f.fundName)}${f.holdVol==='待确认'?' · 待确认':''}</span><span>${total>0?(n(f.totalAmount)/total*100).toFixed(1)+'%':'—'}</span></div><div class="bar"><i style="width:${total>0?Math.max(0,Math.min(100,n(f.totalAmount)/total*100)):0}%"></i></div></div>`).join('');
  const topShare=total>0 && d.funds.length?n(d.funds[0].totalAmount)/total*100:null;
  return `<div class="holdings-layout"><div class="card"><div class="table-top"><h2>全部持仓 <span class="tag green">真实数据</span></h2><input class="search" id="hold-search" placeholder="搜索名称或基金代码" aria-label="搜索持仓"></div><div class="table-scroll"><table><thead><tr><th>基金 / 代码</th><th class="right">金额 / 份额</th><th class="right">持有收益 / 收益率</th><th class="right">日收益</th><th>策略关联</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${!d.funds.length?empty('暂无基金持仓','账户接口成功返回空持仓。'):''}<div id="no-hold-results" class="empty" hidden>未找到匹配的持仓</div><div class="table-foot"><span>数据来自 thsfund · 金额与收益率保留接口口径</span><span>${esc(timeOnly(d.fetchedAt))} 同步</span></div></div><aside class="holdings-aside"><div class="card side-card"><h2>持仓分布</h2><p class="sub">按基金总金额 · 前 5 只</p>${bars}<div class="side-note">最大单只占比 <b>${topShare===null?'—':topShare.toFixed(1)+'%'}</b>。${d.fundApi.failedCategories.length?'基于部分已获取持仓。':'占比按本次接口汇总计算；待确认金额保留并标记。'}</div></div><div class="card side-card soft-card"><h2>让每一笔持仓有章可循</h2><p>先选规则，再明确预算。关联策略草稿不会改变已有持仓，也不会追溯归因历史收益。</p>${button('去策略中心 ↗','nav','data-to="library"','small')}</div></aside></div>`;
}
function holdingsAnalysis() {
  if(S.analysisBusy)return `<div class="card">${loading('正在从扶摇读取历史复权净值并计算组合…')}</div>`;
  if(S.analysisError)return `<div class="card">${empty('组合分析暂不可用',esc(S.analysisError),button('重新计算','refresh-analysis','','primary'),'↻')}</div>`;
  if(!S.analysis)return `<div class="card">${empty('生成真实数据分析','将当前持仓与扶摇历史净值对齐，计算波动、回撤、相关性与资产分布。',button('开始分析','refresh-analysis','','primary'),'⌁')}</div>`;
  const a=S.analysis,m=a.metrics,b=a.benchmarkMetrics;
  const allocations=a.allocations.map(x=>`<div class="legend-row"><i style="background:${x.color}"></i><span title="${esc(x.name)} · ${x.funds} 只">${esc(x.name)} · ${x.funds} 只</span><b>${x.percent.toFixed(1)}%</b><small>${money(x.amount)}</small></div>`).join('');
  let allocationEnd=0;const allocationTotal=n(a.totalAmount)||1;
  const stops=a.allocations.map((x,i)=>{const start=allocationEnd;allocationEnd=i===a.allocations.length-1?100:allocationEnd+(n(x.amount)||0)/allocationTotal*100;return `${x.color} ${start}% ${allocationEnd}%`;}).join(',');
  const corr=a.correlation,heat=corr.funds.length?`<div class="heatmap" style="--heat-cols:${corr.funds.length}"><span></span>${corr.funds.map(f=>`<span class="heat-label top" title="${esc(f.name)}">${f.code}</span>`).join('')}${corr.values.map((row,i)=>`<span class="heat-label" title="${esc(corr.funds[i].name)}">${corr.funds[i].code}</span>${row.map(v=>`<span class="heat-cell" style="--heat:${v===null?0:Math.abs(v)}" title="${v===null?'共同数据不足':v.toFixed(2)}">${v===null?'—':v.toFixed(2)}</span>`).join('')}`).join('')}</div>`:'<p class="muted small-text">可用基金不足，无法建立相关性矩阵。</p>';
  return `<div class="analysis-note">${esc(a.method)} <b>已确认持仓净值覆盖 ${a.dataCoveragePct.toFixed(1)}%</b></div>
    <div class="mini-stats">${stat('基金资产总额',money(a.totalAmount),a.pendingAmount>0?`已确认 ${money(a.confirmedAmount)} · 待确认 ${money(a.pendingAmount)}`:'真实账户快照')}${stat('近一年模拟收益',`<span class="${color(m.returnPct)}">${signed(m.returnPct)}%</span>`,`已确认持仓 · 沪深300 ${signed(b.returnPct)}%`)}${stat('年化波动',m.volatilityPct===null?'—':num(m.volatilityPct)+'%',`已确认持仓 · 沪深300 ${b.volatilityPct===null?'—':num(b.volatilityPct)+'%'}`)}${stat('策略覆盖率',num(a.coveragePct)+'%',`${money(a.coveredAmount)} 已关联草稿`,'featured')}</div>
    <div class="analysis-grid"><section class="card analysis-card"><div class="card-head"><h2>资产配置</h2><span class="tag green">净值截至 ${esc(a.asOf)}</span></div><div class="card-body allocation-analysis"><div class="analysis-donut" style="background:conic-gradient(${stops})"><div><strong>${money(a.totalAmount)}</strong><span>基金资产总额</span></div></div><div class="analysis-legend">${allocations}</div></div></section>
    <section class="card analysis-card wide"><div class="card-head"><h2>组合累计收益 vs 沪深300</h2><span class="tag">已确认权重模拟</span></div><div class="card-body">${lineChart(a.history,a.benchmark)}<div class="chart-legend"><span><i class="portfolio"></i>已确认持仓权重组合 ${signed(m.returnPct)}%</span><span><i class="benchmark"></i>沪深300 ${signed(b.returnPct)}%</span></div></div></section>
    <section class="card analysis-card"><div class="card-head"><h2>风险指标</h2><span class="tag">最近约 252 个交易日</span></div><div class="card-body">${kv('最大回撤',m.maxDrawdownPct===null?'—':num(m.maxDrawdownPct)+'%')}${kv('沪深300最大回撤',b.maxDrawdownPct===null?'—':num(b.maxDrawdownPct)+'%')}${kv('夏普比率（无风险 1.5%）',m.sharpe===null?'—':num(m.sharpe))}${kv('已确认持仓净值覆盖',num(a.dataCoveragePct)+'%')}${kv('参与模拟的持仓金额',money(a.simulationAmount))}${a.failures.length?banner(`${a.failures.length} 只已确认基金未纳入历史模拟；基金资产总额仍按真实快照展示。`,'warning'):''}</div></section>
    <section class="card analysis-card wide"><div class="card-head"><h2>相关性矩阵</h2><span class="tag">金额前 ${corr.funds.length} 只</span></div><div class="card-body">${heat}<p class="privacy-note">基于相同交易日的复权净值日收益；接近 1 表示历史同向程度较高。</p></div></section></div>
    <div class="health-grid">${a.findings.map(x=>`<div class="health ${x.tone}"><strong>${esc(x.title)}</strong><p>${esc(x.text)}</p></div>`).join('')}</div><p class="privacy-note">来源：${esc(a.source)}。组合曲线是研究用模拟，不等于账户实际收益；实际收益仍以同花顺持仓与订单确认为准。</p>`;
}
function lineChart(portfolio,benchmark){
  const rows=[...portfolio,...benchmark];if(!rows.length)return '<p class="muted">基准或组合历史不足。</p>';
  const values=rows.map(x=>Number(x.value)).filter(Number.isFinite),lo=Math.min(...values),hi=Math.max(...values),pad=Math.max((hi-lo)*.12,.01),min=lo-pad,max=hi+pad;
  const points=data=>data.map((x,i)=>`${40+i/(Math.max(1,data.length-1))*600},${18+(max-x.value)/(max-min)*160}`).join(' ');
  const label=v=>((v-1)*100).toFixed(1)+'%';
  return `<svg class="performance-chart" viewBox="0 0 660 215" role="img" aria-label="组合与沪深300累计收益曲线"><line x1="40" y1="18" x2="40" y2="178"/><line x1="40" y1="178" x2="640" y2="178"/><line class="grid" x1="40" y1="98" x2="640" y2="98"/><text x="34" y="22">${label(max)}</text><text x="34" y="102">${label((min+max)/2)}</text><text x="34" y="182">${label(min)}</text><polyline class="benchmark" points="${points(benchmark)}"/><polyline class="portfolio" points="${points(portfolio)}"/><text class="date" x="40" y="204">${esc(portfolio[0]?.date||'')}</text><text class="date" text-anchor="end" x="640" y="204">${esc(portfolio.at(-1)?.date||'')}</text></svg>`;
}
function walletView() {
  const w=S.holdings.wallet;
  if(!w.ok)return `<div class="card">${empty('钱包暂不可用','本次钱包查询失败，可稍后单独刷新账户。',button('重新同步','refresh-holdings'))}</div>`;
  return `<div class="split-grid"><div class="card"><div class="card-head"><h2>${esc(w.fundName||'基金钱包')}</h2><span class="tag green">${esc(w.fundCode||'钱包')}</span></div><div class="card-body">${kv('钱包总份额',num(w.total))}${kv('可用份额',num(w.avaiableVol))}${kv('可用可取份额',num(w.usableCashOutVol))}${kv('可用不可取份额',num(w.usableUnCashOutVol))}${kv('冻结份额 / 转换冻结',num(w.freezeMoney)+' / '+num(w.convertFreezeMoney))}${kv('昨日收益'+(w.yesterdayIncome?' · '+esc(w.yesterdayIncome):''),money(w.profits))}${kv('持有收益',money(w.holdProfits))}</div></div><div class="card"><div class="card-head"><h2>银行卡对应钱包份额</h2></div><div class="card-body">${w.banks.map(b=>kv(esc(b.name)+' <span class="mono">'+esc(b.account)+'</span>',num(b.total)+' 份')).join('')||'<p class="muted">接口未返回银行卡份额。</p>'}<div class="audit-note">仅展示脱敏卡号。策略月预算是本地计划，钱包份额是账户事实，两者独立记录。</div></div></div></div>`;
}
const workflow = () => `<div class="workflow">${[['规则模板','策略中心'],['参数与预算','我的策略'],['验证与信号','待接入计算引擎'],['订单与持仓','真实账户对账']].map((s,i)=>`<div class="workflow-item"><span class="step-num">0${i+1}</span><div><strong>${s[0]}</strong><small>${s[1]}</small></div></div>${i<3?'<span class="flow-arrow">→</span>':''}`).join('')}</div>`;
function strategyCard(item){
  const rules=(item.rules||[]).slice(0,3).map(x=>`<li>${esc(x)}</li>`).join('');
  return `<article class="strategy-invest-card"><div class="strategy-invest-card-top"><span class="strategy-symbol">${esc(item.symbol||'◈')}</span><span class="strategy-chip">${esc(item.category||'策略')} · v${esc(item.version||'—')}</span></div><h2>${esc(item.name)}</h2><p>${esc(item.description||'')}</p><ul>${rules}</ul><div class="strategy-card-meta"><span>适合：${esc(item.suitableFor||'按需研究')}</span><span>数据：${esc(item.dataBasis||'以实际接口为准')}</span></div><div class="strategy-card-bottom"><small>${esc(item.tradeoff||'参数调整后需重新回测。')}</small>${button('查看默认回测','strategy-open',`data-id="${esc(item.id)}"`,'small primary')}</div></article>`;
}
function strategyParamInput(spec,params){
  const value=params?.[spec.key]??spec.default??'';
  if(Array.isArray(spec.choices))return `<div class="field"><label for="strategy-param-${esc(spec.key)}">${esc(spec.label)}</label><select id="strategy-param-${esc(spec.key)}" name="param-${esc(spec.key)}">${spec.choices.map(choice=>`<option value="${esc(choice)}" ${String(choice)===String(value)?'selected':''}>${esc(choice)}</option>`).join('')}</select><small>${esc(spec.unit||'可调参数')}</small></div>`;
  return `<div class="field"><label for="strategy-param-${esc(spec.key)}">${esc(spec.label)}</label><div class="strategy-number-input"><input id="strategy-param-${esc(spec.key)}" name="param-${esc(spec.key)}" type="number" value="${esc(value)}" min="${esc(spec.min)}" max="${esc(spec.max)}" step="${esc(spec.step||1)}" required><span>${esc(spec.unit||'')}</span></div><small>范围 ${esc(spec.min)}–${esc(spec.max)} ${esc(spec.unit||'')}</small></div>`;
}
function strategyCurveChart(result){
  const curve=Array.isArray(result?.curve)?result.curve:[];
  if(!curve.length)return '<div class="strategy-chart-empty">暂无可绘制曲线。</div>';
  const vals=curve.map(x=>Number(x.value)).filter(Number.isFinite),bench=curve.map(x=>Number(x.benchmark)).filter(Number.isFinite),all=[...vals,...bench].filter(x=>x>0);
  if(!all.length)return '<div class="strategy-chart-empty">有效净值不足，无法绘图。</div>';
  const lo=Math.min(...all),hi=Math.max(...all),pad=Math.max((hi-lo)*.12,1),min=lo-pad,max=hi+pad;
  const points=(key,klass)=>curve.map((row,i)=>{const value=Number(row[key]);if(!Number.isFinite(value))return '';return `${42+i/(Math.max(1,curve.length-1))*596},${20+(max-value)/(max-min)*160}`;}).filter(Boolean).join(' ');
  const markerRows=(result.trades||[]).map(trade=>{const index=curve.findIndex(row=>row.date>=trade.date);if(index<0)return '';const value=Number(curve[index].value);return `<circle class="strategy-trade-${trade.side==='buy'?'buy':'sell'}" cx="${42+index/(Math.max(1,curve.length-1))*596}" cy="${20+(max-value)/(max-min)*160}" r="3"/>`;}).join('');
  const pct=value=>((value/Math.max(1,vals[0])-1)*100).toFixed(1)+'%';
  return `<svg class="strategy-chart" viewBox="0 0 660 220" role="img" aria-label="策略模拟与基金净值曲线"><line x1="42" y1="20" x2="42" y2="180"/><line x1="42" y1="180" x2="638" y2="180"/><line class="grid" x1="42" y1="100" x2="638" y2="100"/><text x="36" y="24">${esc(pct(max))}</text><text x="36" y="104">${esc(pct((min+max)/2))}</text><text x="36" y="184">${esc(pct(min))}</text><polyline class="strategy-benchmark" points="${points('benchmark','benchmark')}"/><polyline class="strategy-curve" points="${points('value','value')}"/>${markerRows}<text class="date" x="42" y="207">${esc(curve[0]?.date||'')}</text><text class="date" x="638" y="207" text-anchor="end">${esc(curve.at(-1)?.date||'')}</text></svg><div class="strategy-chart-legend"><span><i class="strategy-curve-key"></i>策略模拟</span><span><i class="strategy-benchmark-key"></i>基金复权净值基准</span><span><i class="strategy-buy-key"></i>买入</span><span><i class="strategy-sell-key"></i>卖出建议</span></div>`;
}
function strategyResultView(result){
  if(!result)return `<div class="strategy-result-placeholder"><span>◌</span><strong>输入基金代码后查看真实回测</strong><p>页面不会填充模拟业绩。需要扶摇复权净值和完整数据时，会在这里显示真实结果或具体缺项。</p></div>`;
  if(result.status!=='ok')return `<div class="strategy-blocked"><span>!</span><div><strong>本次暂无法判断</strong><p>${esc((result.missingData||[]).join('；')||'数据接口未返回可用结果。')}</p><small>来源：${esc(result.source||'策略数据契约')} · 不把缺失数据当作“无需操作”。</small></div></div>`;
  const m=result.metrics||{},flow=result.cashFlow||{};
  return `<div class="strategy-result-status"><span class="strategy-ok-dot"></span><div><strong>已完成真实历史模拟</strong><small>数据截至 ${esc(result.dataAsOf||'接口未提供')} · ${esc(result.period?.start||'')} 至 ${esc(result.period?.end||'')}</small></div><span class="strategy-version">v${esc(result.strategyVersion||'—')}</span></div><div class="strategy-metric-grid"><div><small>累计投入</small><strong>${money(flow.totalInvested)}</strong></div><div><small>期末金额</small><strong>${money(flow.endingValue)}</strong></div><div><small>模拟收益</small><strong class="${color(flow.netProfit)}">${signed(flow.netProfit)}</strong></div><div><small>收益率</small><strong class="${color(m.returnPct)}">${signed(m.returnPct)}%</strong></div><div><small>最大回撤</small><strong>${m.maxDrawdownPct===null?'—':num(m.maxDrawdownPct)+'%'}</strong></div><div><small>动作次数</small><strong>${esc(m.trades??'—')}</strong></div></div><div class="strategy-chart-wrap">${strategyCurveChart(result)}</div><div class="strategy-fee-note">费用：${flow.fees===null?'未计入（接口未返回完整费率结构）':money(flow.fees)}。${esc(flow.feeNote||'')}</div><p class="privacy-note">${esc(result.riskStatement||'历史模拟不代表未来收益。')} 本曲线是规则模拟，不等于账户实际收益。</p>`;
}
function strategyPlanCards(){
  if(!S.strategyPlans.length)return `<div class="strategy-plan-empty">还没有个人策略计划。先完成一次回测，再确认标的、资金安排和规则后保存。</div>`;
  return S.strategyPlans.map(plan=>{const signal=plan.latestSignal;const statusLabel={draft:'草稿',active:'跟踪中',paused:'已暂停',archived:'已归档'}[plan.status]||plan.status;const signalText=signal?(signal.status==='blocked'?'暂无法判断':signal.state||'已检查'):'尚未检查';return `<article class="strategy-plan-row"><div><div class="strategy-plan-title"><strong>${esc(plan.name)}</strong><span class="strategy-status ${plan.status}">${statusLabel}</span></div><small>${esc(plan.fundCode)} · ${esc(plan.strategyId)} v${esc(plan.strategyVersion)} · ${money(plan.amount)} 单次投入${plan.backtestDataAsOf?' · 回测截至 '+esc(plan.backtestDataAsOf):''}</small></div><div class="strategy-plan-signal"><span>${esc(signalText)}</span><small>${esc(signal?.dataAsOf?'数据截至 '+signal.dataAsOf:'尚未有数据日期')}</small></div><div class="strategy-plan-actions">${plan.status==='draft'?button('开启跟踪','strategy-plan-action',`data-id="${plan.id}" data-plan-action="enable"`,'small primary'):''}${plan.status==='active'?button('暂停','strategy-plan-action',`data-id="${plan.id}" data-plan-action="pause"`,'small'):''}${['active','paused'].includes(plan.status)?button('检查信号','strategy-plan-action',`data-id="${plan.id}" data-plan-action="check"`,'small subtle'):''}${plan.status!=='archived'?button('归档','strategy-plan-action',`data-id="${plan.id}" data-plan-action="archive"`,'small subtle'):''}</div></article>`;}).join('');
}
function renderStrategyInvestDetail(item){
  const params=S.strategyResult?.parameters||item.defaultParams||{};
  return `<div class="strategy-invest-detail"><div class="strategy-detail-toolbar">${button('← 返回策略广场','strategy-back','','subtle small')}<div><span class="strategy-chip">${esc(item.category)} · Skill v${esc(item.version)}</span><span class="muted small-text">数据源：${esc(item.dataBasis)}</span></div><div class="inline-actions">${button('操作少一点','strategy-agent-adjust',`data-prompt="请在当前 ${esc(item.name)} 方案中把操作频率降下来，只修改这个 Skill 支持的参数，说明调整前后代价并重新回测。"`,'small')}</div></div><div class="strategy-detail-grid"><section class="strategy-editor"><div class="strategy-section"><div class="eyebrow">RULES</div><h2>${esc(item.name)}</h2><p>${esc(item.description)}</p><ul class="strategy-rule-list">${(item.rules||[]).map(rule=>`<li>${esc(rule)}</li>`).join('')}</ul><div class="strategy-tradeoff"><strong>需要接受的代价</strong><p>${esc(item.tradeoff||'参数改变后需要重新回测。')}</p></div></div><form id="strategy-backtest-form" class="strategy-section strategy-parameter-form"><input type="hidden" name="strategyId" value="${esc(item.id)}"><div class="eyebrow">DEFAULT PARAMETERS</div><h3>调整方案</h3><div class="form-grid"><div class="field"><label for="strategy-code">场外基金代码</label><input id="strategy-code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="输入 6 位代码" value="${esc(S.strategyCode||S.strategyResult?.fundCode||'')}"><small>只用于读取复权净值，不会自动关联账户或下单。</small></div>${(item.params||[]).map(spec=>strategyParamInput(spec,params)).join('')}</div><div class="strategy-adjust-actions">${button('用当前参数回测','strategy-backtest-submit','','primary')}<span>默认值来自 Skill v${esc(item.version)}；自然语言调整只会改动页面列出的参数。</span></div></form></div><section class="strategy-results"><div class="eyebrow">BACKTEST</div><h2>默认回测与当前结果</h2>${strategyResultView(S.strategyResult)}${S.strategyResult?.status==='ok'?`<div class="strategy-save-box"><div><strong>把这次方案保存成个人计划</strong><p>保存前会记录实际标的、资金安排、Skill 版本、参数快照和数据日期；保存后仍需你明确开启跟踪。</p></div>${button('保存为我的计划','strategy-save-plan','','primary')}</div>`:''}</section></div></div>`;
}
function renderStrategyInvest(){
  if(S.strategyBusy&&!S.strategyCatalog.length)return head('STRATEGY INVEST','策略投资','正在读取五个已固定版本的策略 Skill…')+loading('正在加载策略目录…');
  const intro=head('STRATEGY INVEST','策略投资','先找方法，再看默认回测；保存后由你明确开启应用内信号跟踪。',button('打开基金 Agent','strategy-guide','','primary'));
  if(S.strategySelected){const item=S.strategyCatalog.find(x=>x.id===S.strategySelected);if(item)return `<div class="strategy-invest-page">${intro}${renderStrategyInvestDetail(item)}<section class="strategy-plans-section"><div class="strategy-section-head"><div><div class="eyebrow">MY PLANS</div><h2>我的策略计划</h2></div><span class="muted small-text">运行中每 30 分钟检查一次，退出应用即停止</span></div><div class="strategy-plan-list">${strategyPlanCards()}</div></section></div>`;}
  const active=S.strategyPlans.filter(x=>x.status!=='archived').length;
  return `<div class="strategy-invest-page">${intro}<section class="strategy-invest-hero"><div><span class="strategy-hero-mark">◈</span><div class="eyebrow">PANDAAI STYLE · LOCAL TRIAL</div><h2>不知道怎么投？先从目标和承受方式开始。</h2><p>你可以让 Agent 每次只问一个必要问题，得到主选方法、备选方法和各自代价；也可以直接点一张策略卡，从默认规则和真实数据回测开始。</p></div><div class="strategy-hero-actions">${button('帮我找策略','strategy-guide','','primary')}<span>不会自动读取账户，也不会自动下单</span></div></section><div class="strategy-invest-grid">${S.strategyCatalog.map(strategyCard).join('')}</div><section class="strategy-plans-section"><div class="strategy-section-head"><div><div class="eyebrow">MY PLANS</div><h2>我的策略计划 <span class="strategy-count-badge">${active}</span></h2></div><span class="muted small-text">保存与跟踪独立于旧版策略草稿</span></div><div class="strategy-plan-list">${strategyPlanCards()}</div></section><p class="privacy-note">首版只展示这五个固定 Skill。每次回测会记录策略版本、参数快照、数据日期和结果引用；缺少必要数据时显示“暂无法判断”。</p></div>`;
}
function renderLibrary() {
  return head('STRATEGY LIBRARY','策略中心','这里选择规则；具体基金、参数和预算保存在「我的策略」。',button('我的策略 ↗','nav','data-to="strategies"'))+workflow()+`<div class="template-grid">${S.templates.map(t=>`<article class="card template strategy-template"><div class="template-top"><span class="template-symbol">${t.symbol}</span><span class="tag">${esc(t.category)} · ${esc(t.rhythm)}</span></div><h2>${esc(t.name)}</h2><p class="template-desc">${esc(t.description)}</p><div class="strategy-metrics">${(t.cardMetrics||[]).map(x=>`<div><small>${esc(x.label)}</small><strong>${esc(x.value)}</strong></div>`).join('')}</div><div class="template-meta"><span>适用范围</span><span>${esc(t.scope)}</span></div><div class="template-footer"><span>模板 v1 · 参数可调整</span><div class="inline-actions">${button('了解规则','template-detail',`data-template="${t.id}"`,'subtle small')}${button('创建我的策略','create-strategy',`data-template="${t.id}"`,'small primary')}</div></div></article>`).join('')}</div><p class="privacy-note">卡片展示默认规则与执行节奏。创建后，基金、单次金额、月预算和阈值独立保存在「我的策略」；不会自动下单。</p>`;
}
function renderStrategies() {
  const mine=S.state.strategies.filter(s=>S.mineFilter==='archived'?s.status==='archived':s.status!=='archived');
  const active=S.state.strategies.filter(s=>s.status!=='archived');
  const total=active.reduce((sum,s)=>sum+Number(s.budget),0);
  return head('MY STRATEGIES','我的策略','一份策略实例 = 规则版本 + 研究标的 + 参数 + 独立预算。',button('＋ 创建策略','nav','data-to="library"','primary'))+
    `<div class="stat-grid">${stat('策略草稿',active.length,'计算前先核对适用范围','featured')}${stat('计划月预算',`<span class="currency">¥</span>${num(total)}`,'计划额度，不是钱包余额')}${stat('真实待处理信号','—','信号引擎待接入')}${stat('策略实际收益','—','尚未建立订单与仓位归因')}</div>`+
    banner('下一步需要接入历史净值与策略计算引擎。当前可保存参数、关联研究标的和管理预算。')+
    `<div class="tabs"><button class="tab ${S.mineFilter==='current'?'active':''}" data-action="mine-filter" data-filter="current">当前策略</button><button class="tab ${S.mineFilter==='archived'?'active':''}" data-action="mine-filter" data-filter="archived">已归档</button></div>`+
    (mine.length?`<div class="template-grid">${mine.map(s=>`<article class="card template"><div class="instance-head"><h2>${esc(s.name)}</h2><span class="tag ${s.status==='archived'?'':'amber'}">${s.status==='archived'?'已归档':'草稿'}</span></div><div class="muted small-text">${esc(getTemplate(s.templateId)?.name||s.templateId)} · 实例 v${s.version}</div><div class="instance-meta"><div><small>月预算</small><strong>${money(s.budget)}</strong></div><div><small>单次投入</small><strong>${money(s.amount)}</strong></div><div><small>研究基金</small><strong>${s.codes.length} 只</strong></div></div><div class="inline-actions">${s.codes.map(c=>`<span class="tag">${esc(c)} ${esc(getFund(c)?.fundName||'名称待核实')}</span>`).join('')}</div><div class="template-footer"><span>创建于 ${esc(s.createdAt.slice(0,10))}</span><div>${button('查看参数','instance-detail',`data-id="${s.id}"`,'small')}${s.status!=='archived'?button('归档','archive-strategy',`data-id="${s.id}"`,'subtle small'):''}</div></div></article>`).join('')}</div>`:`<div class="card">${empty(S.mineFilter==='archived'?'暂无归档策略':'把一个规则变成自己的计划',S.mineFilter==='archived'?'归档后保留参数和历史配置。':'从策略中心选择模板，再填写基金和预算。已有持仓不会自动获得策略归属。',button('浏览策略模板 ↗','nav','data-to="library"','primary'),'◫')}</div>`);
}
let orderForm={start:localDate(-30),end:localDate(0),kind:'all',processing:'true'};
function localDate(offset){const d=new Date();d.setDate(d.getDate()+offset);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
async function loadOrders(append=false) {
  if(S.orderBusy)return;
  S.orderBusy=true;S.ordersError='';if(S.route==='trades')render();
  const q=new URLSearchParams({start:orderForm.start.replaceAll('-',''),end:orderForm.end.replaceAll('-',''),kind:orderForm.kind,processing:orderForm.processing,page:append?S.orderPage+1:1});
  if(append && S.orderNext){q.set('lastTime',S.orderNext.lastTime);q.set('lastId',S.orderNext.lastId);}
  try{const d=await api('/api/orders?'+q);if(!append)S.selectedOrders.clear();S.orders=append?[...S.orders,...d.orders.filter(o=>!S.orders.some(x=>x.id===o.id))]:d.orders;S.orderNext=d.next;S.orderPage=d.page;S.ordersLoaded=true;}
  catch(e){S.ordersError=e.message;}
  finally{S.orderBusy=false;if(S.route==='trades')render();}
}
function renderTrades() {
  const top=head('ORDERS','订单中心','查询真实订单、跟踪确认与到账状态，并对当前可撤订单进行批量管理。',button('⟳ 刷新订单','refresh-orders',S.orderBusy?'disabled':''));
  const tabs=`<div class="tabs"><button class="tab ${S.orderTab==='records'?'active':''}" data-action="trade-tab" data-tab="records">真实订单</button><button class="tab ${S.orderTab==='drafts'?'active':''}" data-action="trade-tab" data-tab="drafts">交易待办 <span class="count">${S.state.drafts.length}</span></button></div>`;
  if(S.orderTab==='drafts')return top+tabs+banner('待办只记录交易意图。正式申购或赎回请从「我的持仓」选择具体基金发起。')+(S.state.drafts.length?`<div class="card table-scroll"><table><thead><tr><th>标的</th><th>计划动作</th><th>金额 / 份额</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>${S.state.drafts.map(d=>`<tr><td>${esc(d.name)}<span class="fund-code">${d.code}</span></td><td>${d.kind==='buy'?'买入':'赎回'}</td><td class="num">${d.kind==='buy'?money(d.value):num(d.value)+' 份'}</td><td><span class="tag amber">未提交</span></td><td class="small-text">${esc(dateTime(d.createdAt))}</td><td>${button('查看清单','draft-detail',`data-id="${d.id}"`,'small')}${button('移除','remove-draft',`data-id="${d.id}"`,'subtle small')}</td></tr>`).join('')}</tbody></table></div>`:`<div class="card">${empty('暂无交易待办','从持仓页的申购或赎回入口开始，或让 Agent 保存一条待办。',button('查看持仓','nav','data-to="holdings"','primary'),'⇄')}</div>`);
  const filter=`<form id="orders-form" class="filter-row"><div class="field"><label for="order-status">订单范围</label><select id="order-status" name="processing"><option value="true" ${orderForm.processing==='true'?'selected':''}>处理中订单</option><option value="false" ${orderForm.processing==='false'?'selected':''}>历史订单</option></select></div><div class="field"><label for="order-start">开始日期</label><input type="date" id="order-start" name="start" value="${orderForm.start}" required></div><div class="field"><label for="order-end">结束日期</label><input type="date" id="order-end" name="end" value="${orderForm.end}" required></div><div class="field"><label for="order-kind">交易类型</label><select id="order-kind" name="kind">${Object.entries({all:'全部',buy:'买入',sell:'卖出',aip:'定投',change:'转换',dividend:'分红',other:'其他'}).map(([k,v])=>`<option value="${k}" ${orderForm.kind===k?'selected':''}>${v}</option>`).join('')}</select></div><button class="button primary" ${S.orderBusy?'disabled':''}>${S.orderBusy?'查询中…':'查询'}</button></form>`;
  let rows=S.orderFilter?S.orders.filter(o=>o.code===S.orderFilter):S.orders;
  const eligible=rows.filter(o=>o.canCancel&&o.id),allChecked=eligible.length>0&&eligible.every(o=>S.selectedOrders.has(o.id));
  const selection=`<div class="selection-bar"><span>已选择 <strong>${S.selectedOrders.size}</strong> 笔可撤订单</span>${button('批量撤单','batch-revoke',S.selectedOrders.size?'':'disabled','danger')}</div>`;
  return top+tabs+filter+selection+(S.orderFilter?banner(`当前展示已加载订单中的基金 ${esc(S.orderFilter)}。${S.orderNext?'可继续加载后续页。':''}`,'',button('清除筛选','clear-order-filter','','small')):'')+(S.ordersError?banner(esc(S.ordersError)+(S.orders.length?' 当前保留上次查询结果。':''),'error'):'')+
    (S.orderBusy&&!S.orders.length?loading('正在读取交易记录…'):rows.length?`<div class="card"><div class="table-top"><h2>${orderForm.processing==='true'?'处理中订单':'历史订单'} <span class="tag green">来自账户</span></h2><span class="muted small-text">已加载 ${S.orders.length} 笔 · ${eligible.length} 笔可撤</span></div><div class="table-scroll"><table><thead><tr><th class="select-cell"><input type="checkbox" data-action="select-all-orders" aria-label="全选当前列表可撤订单" ${allChecked?'checked':''} ${eligible.length?'':'disabled'}></th><th>基金</th><th>业务</th><th class="right">申请金额 / 份额</th><th>状态</th><th>发起时间</th><th></th></tr></thead><tbody>${rows.map(o=>`<tr><td class="select-cell">${o.canCancel&&o.id?`<input type="checkbox" data-order-select="${esc(o.id)}" aria-label="选择订单 ${esc(o.id)}" ${S.selectedOrders.has(o.id)?'checked':''}>`:'<span class="faint">—</span>'}</td><td><span class="fund-name">${esc(o.name)}</span><span class="fund-code">${esc(o.code||'组合产品')}</span></td><td>${esc(o.type)}<span class="fund-code">${esc(o.subtype||'')}</span></td><td class="right num">${money(o.amount)}${n(o.shares)!==null?`<span class="fund-code">${num(o.shares)} 份</span>`:''}</td><td><span class="tag ${o.status==='确认成功'?'green':'amber'}">${esc(o.status)}</span><span class="fund-code">${esc(o.statusDetail)}</span></td><td class="num small-text">${esc(o.acceptedAt||'—')}</td><td class="right">${button('详情','order-detail',`data-id="${esc(o.id)}"`,'small subtle')}</td></tr>`).join('')}</tbody></table></div><div class="table-foot"><span>只有最新详情显示“可撤单”的订单才能选择</span><span>每页最多 20 笔</span></div></div>`:`<div class="card">${empty(S.ordersError?'订单查询未完成':'当前条件下暂无订单',S.ordersError?'请检查授权或网络后重新查询。':'可以切换订单范围、交易类型或日期区间。','','⇄')}</div>`)+
    (S.orderNext?`<div class="pagination">${button(S.orderBusy?'加载中…':'加载下一页','more-orders',S.orderBusy?'disabled':'')}</div>`:'');
}
function renderWatchlist() {
  return head('WATCHLIST','自选基金','只记录关注对象。添加自选不会生成持仓、策略或交易信号。',button('＋ 添加自选','add-watch','','primary'))+
    (S.state.watchlist.length?`<div class="card table-scroll"><table><thead><tr><th>基金</th><th>真实持仓</th><th>策略关联</th><th>添加时间</th><th></th></tr></thead><tbody>${S.state.watchlist.map(w=>{const f=getFund(w.code),s=getStrategy(w.code);return `<tr><td>${esc(f?.fundName||w.name)}<span class="fund-code">${w.code}</span></td><td>${S.holdings?f?money(f.totalAmount):'当前快照中无持仓':'尚未同步账户'}</td><td>${s?esc(s.name):'未关联'}</td><td class="small-text">${esc(w.createdAt.slice(0,10))}</td><td>${button('创建策略','select-template',`data-code="${w.code}"`,'small')}${button('移除','remove-watch',`data-code="${w.code}"`,'subtle small')}</td></tr>`;}).join('')}</tbody></table><div class="table-foot">净值行情尚未接入。未在持仓接口核实名称的自选基金仅按手动备注展示。</div></div>`:`<div class="card">${empty('建立你的关注清单','可以按基金代码添加，也可以从持仓管理中加入自选。',button('添加第一只自选','add-watch','','primary'),'☆')}</div>`);
}
function renderSettings() {
  if(D.enabled)return renderDesktopSettings();
  const ai=S.ai,mode=S.modelMode;
  return head('CONNECTIONS','接入设置','基金数据和模型独立连接；你可以先查看持仓，再选择 AI 的接入方式。')+
    `<div class="card settings-section"><div class="card-body"><div class="settings-header"><span class="provider-logo">▤</span><div><h2>同花顺爱基金</h2><p>真实持仓 · 钱包 · 订单 · 交易准备</p></div><span class="tag ${S.fundConnected?'green':'amber'}">${S.fundConnected?'账户已连接':'需要连接或检查授权'}</span></div><div class="inline-actions">${button('同步验证','refresh-holdings',S.loadingHoldings?'disabled':'')}${button('扫码登录','fund-login')}${button('查看账户持仓 ↗','nav','data-to="holdings"','subtle')}</div><p class="privacy-note" id="login-message">凭据由同花顺官方 SDK 管理，页面不读取或展示令牌。SDK ${esc(S.sdkVersion||'—')}。</p></div></div>`+
    `<div class="card settings-section"><div class="card-head"><h2>AI 模型</h2><span class="tag ${aiConnected()?'green':'amber'}">${aiConnected()?(ai.mode==='subscription'?'订阅已登录':'API 已配置'):'待配置'}</span></div><div class="card-body"><div class="split-grid"><button class="mode-card ${mode==='subscription'?'active':''}" data-action="ai-mode" data-mode="subscription"><span class="tag">方式一</span><strong>接入订阅计划</strong><p>使用本机 Codex 的 ChatGPT 登录。<br>模型权限与可用额度由订阅决定。</p></button><button class="mode-card ${mode==='api'?'active':''}" data-action="ai-mode" data-mode="api"><span class="tag">方式二</span><strong>使用 API Key</strong><p>配置模型服务地址与密钥。<br>按 API 平台的额度与账单使用。</p></button></div>
    ${mode==='subscription'?`<form id="subscription-form"><div class="settings-notice"><strong>${esc(ai?.subscription.message||'正在检测订阅连接')}</strong><br>当前支持 ChatGPT / Codex 订阅。通过本机 Codex CLI 使用官方登录，不导入浏览器 Cookie。${!ai?.subscription.connected?'<br>在本机终端执行 <code>codex login</code>，完成后点击“重新检测”。':''}</div><div class="field"><label for="subscription-model">模型名称（可选）</label><input id="subscription-model" name="model" placeholder="留空，使用 Codex 可用的默认模型" value="${esc(ai?.mode==='subscription'?ai.model:'')}"><small>只能使用当前订阅和 Codex 支持的模型。</small></div><div class="form-footer">${button('重新检测','check-ai')}<button class="button primary">使用订阅模式</button></div></form>`:
    `<form id="api-form"><div class="settings-notice">密钥仅保存在本地服务内存中，重启后需重新输入。浏览器不保存密钥，模型调用由本机服务转发。</div><div class="form-grid"><div class="field full"><label for="api-url">API Base URL</label><input id="api-url" name="baseUrl" type="url" required placeholder="https://api.openai.com/v1" value="${esc(ai?.baseUrl||'https://api.openai.com/v1')}"><small>填基础地址，不包含 /responses 或 /chat/completions。</small></div><div class="field"><label for="api-protocol">接口协议</label><select id="api-protocol" name="protocol"><option value="responses" ${ai?.protocol==='responses'?'selected':''}>OpenAI Responses</option><option value="chat-completions" ${ai?.protocol==='chat-completions'?'selected':''}>OpenAI 兼容 Chat Completions</option></select></div><div class="field"><label for="api-model">模型名称</label><input id="api-model" name="model" required placeholder="填写供应商提供的模型 ID" value="${esc(ai?.mode==='api'?ai.model:'')}"></div><div class="field full"><label for="api-key">API Key</label><input type="password" id="api-key" name="apiKey" autocomplete="off" placeholder="${ai?.keyConfigured?'本次服务已有密钥，留空保留；更换地址需重新输入':'输入你的 API Key'}"><small>保存配置不消耗模型额度；发送第一条消息时验证调用权限。</small></div></div><div class="form-footer">${ai?.keyConfigured?button('清除密钥','clear-api','','danger'):''}<button class="button primary">保存并使用 API Key</button></div></form>`}
    <div class="audit-note">两种方式独立计费。订阅登录用于 Codex 支持的订阅能力，不能把订阅当作通用 API Key。<a href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noopener noreferrer">官方接入说明 ↗</a><br>工作台不会把基金账户凭据发送给模型。只有在对话中勾选附带持仓，才会读取并发送该次快照。</div></div></div>`;
}
function renderHome() {
  const brief=accountBrief();
  if(D.enabled){
    const idle=!D.messages.length&&!D.running;
    return `<div class="home ${idle?'home-idle':''}"><div class="home-hero"><div class="hero-mark">✦</div><div class="eyebrow">CODEX HARNESS AGENT</div><h1>从真实账户出发，连续完成研究工作。</h1><p>直接在这里查询持仓与订单、分析组合、配置策略和准备交易。</p></div>${brief}<section id="agent-inline-host" class="agent-inline-host ${idle?'idle':''}" aria-label="基金 Agent 对话"></section><div class="quick-grid"><button class="quick" data-agent-prompt="分析我的持仓集中度、风险和数据限制。"><strong>▤ 持仓体检</strong><small>读取真实持仓与扶摇历史净值</small></button><button class="quick" data-agent-prompt="列出策略模板，并根据我的持仓说明各模板适用性。"><strong>▦ 策略研究</strong><small>先理解规则，再创建个人草稿</small></button><button class="quick" data-agent-prompt="查询最近30天订单，区分处理中和历史订单，并说明哪些订单当前可撤单。"><strong>⇄ 订单核对</strong><small>读取真实确认、撤单与到账状态</small></button></div><p class="privacy-note">Agent 可查询和准备交易；申购、赎回与撤单必须在交易确认页由你本人核对并明确提交。</p></div>`;
  }
  return `<div class="home"><div class="home-hero"><div class="hero-mark">✦</div><div class="eyebrow">YOUR RESEARCH DESK</div><h1>把问题聊清楚，把依据看明白。</h1><p>从持仓事实开始，研究适合自己的计划。</p></div>${brief}${!aiConnected()?banner('先选择订阅或 API Key 接入模型，即可开始对话。','',button('接入 AI','nav','data-to="settings"','small')):''}<form id="chat-form" class="chat-composer"><label for="chat-input" class="sr-only">向 AI 提问</label><textarea id="chat-input" name="message" placeholder="例如：帮我梳理这些持仓的集中度，以及还需要哪些信息才能做决策。" required maxlength="12000"></textarea><div class="composer-footer"><label class="checkbox-label"><input id="include-holdings" type="checkbox" name="includeHoldings">本次附带最新持仓快照<br>将发送到当前模型服务</label><button class="button primary" ${S.chatBusy?'disabled':''}>${S.chatBusy?'思考中…':'发送问题 ↑'}</button></div></form><p class="privacy-note">对话仅在本页会话内保留；发送时包含最近对话。开始新话题可清空对话。AI 不具备交易执行权限。</p><div class="quick-grid"><button class="quick" data-route="holdings"><strong>▤ 查看我的账户</strong><small>同步真实持仓、收益与钱包份额</small></button><button class="quick" data-route="library"><strong>▦ 探索策略规则</strong><small>先理解规则，再配置自己的计划</small></button><button class="quick" data-route="trades"><strong>⇄ 核对真实订单</strong><small>确认、撤单与回款进度一处查看</small></button></div>${S.messages.length?`<div class="inline-actions"><h2>当前对话</h2>${button('清空对话','clear-chat',S.chatBusy?'disabled':'','subtle small')}</div>`:''}<div id="messages">${S.messages.map(m=>`<div class="message ${m.role==='user'?'user':''} ${m.error?'error':''}"><div class="message-label">${m.role==='user'?'你':'✦ AI 研究助手'}${m.pending?'<span class="spinner"></span>':''}</div><div class="message-text">${esc(m.content)}</div>${m.contextAt?`<div class="chat-context">使用账户快照：${esc(dateTime(m.contextAt))}</div>`:''}</div>`).join('')}</div></div>`;
}

function openStrategy(id){
  const item=S.strategyCatalog.find(x=>x.id===id);if(!item)return;
  S.strategySelected=id;S.strategyResult=null;S.strategyCode='';render();
}
function strategyGuide(prompt='我还没有投资方法，请在这五个场外基金策略中帮我选择。请每次只问一个必要问题，并给出主选方法、备选方法和各自代价。'){
  if(D.enabled){openAgentPanel();$('#agent-input').value=prompt;$('#agent-input').focus();return;}
  navigate('home');toast('请先在接入设置中配置模型，然后让 Agent 帮你选择策略。');
}
function strategyAgentAdjust(prompt){strategyGuide(prompt||'请根据当前策略页面的方案，帮我减少操作频率，只修改这个 Skill 支持的参数，并说明代价后重新回测。');}
async function runStrategyFromForm(){
  const form=$('#strategy-backtest-form');if(!form||S.strategyBusy)return;
  const item=S.strategyCatalog.find(x=>x.id===S.strategySelected);if(!item)return;
  const raw=Object.fromEntries(new FormData(form));const params={};
  for(const spec of item.params||[]){const value=raw['param-'+spec.key];params[spec.key]=Array.isArray(spec.choices)?value:Number(value);}
  S.strategyCode=String(raw.code||'').trim();S.strategyBusy=true;render();
  try{S.strategyResult=await api('/api/strategy-invest/backtest',{strategyId:item.id,code:S.strategyCode,params});await refreshStrategyInvest();}
  catch(e){toast(e.message);}
  finally{S.strategyBusy=false;render();}
}
function confirmSaveStrategyPlan(){
  const result=S.strategyResult,item=S.strategyCatalog.find(x=>x.id===S.strategySelected);if(!result||result.status!=='ok'||!item)return;
  const code=result.fundCode||S.strategyCode;const amount=result.parameters?.amount;
  openDialog('保存为个人策略计划',`<div class="strategy-confirm"><p>请核对这份计划，再决定是否保存：</p>${kv('策略',esc(item.name)+' · Skill v'+esc(item.version))}${kv('实际标的',esc(code))}${kv('单次投入',money(amount))}${kv('数据日期',esc(result.dataAsOf||'接口未提供'))}<div class="audit-note">保存只记录研究方案和跟踪规则，不会提交申购、赎回、撤单或支付。保存后仍要点击“开启跟踪”。</div></div>`,button('取消','close-dialog')+button('确认保存','strategy-save-confirm','','primary'));
}
async function saveStrategyPlan(){
  const result=S.strategyResult,item=S.strategyCatalog.find(x=>x.id===S.strategySelected);if(!result||result.status!=='ok'||!item)return;
  const code=result.fundCode||S.strategyCode;
  try{await api('/api/strategy-plans',{strategyId:item.id,code,amount:result.parameters?.amount,params:result.parameters,name:`${item.name} · ${code}`,runId:result.runId,dataAsOf:result.dataAsOf});await refreshStrategyInvest();closeDialog();render();toast('个人策略计划已保存，尚未开启跟踪。');}
  catch(e){toast(e.message);}
}
async function strategyPlanAction(id,action){
  try{await api('/api/strategy-plans/action',{id,action});await refreshStrategyInvest();render();toast(action==='enable'?'已开启应用内跟踪':action==='pause'?'已暂停计划':action==='archive'?'已归档计划':'信号已检查');}
  catch(e){toast(e.message);}
}

function accountBrief(){
  if(S.loadingHoldings&&!S.holdings)return `<section class="account-brief card"><div class="brief-head"><div><span>账户晨报</span><small>正在同步真实账户数据…</small></div><span class="spinner"></span></div></section>`;
  if(!S.holdings)return `<section class="account-brief card"><div class="brief-head"><div><span>账户晨报</span><small>${esc(S.holdingError||'账户数据尚未同步')}</small></div>${button('同步账户','refresh-holdings','','small')}</div></section>`;
  const d=S.holdings,s=d.summary;
  const confirmed=d.funds.filter(f=>f.holdVol!=='待确认'),up=confirmed.filter(f=>n(f.newestIncome)>0),down=confirmed.filter(f=>n(f.newestIncome)<0),flat=confirmed.filter(f=>n(f.newestIncome)===0),missing=confirmed.filter(f=>n(f.newestIncome)===null);
  const ranked=[...confirmed].filter(f=>n(f.newestIncome)!==null).sort((a,b)=>n(b.newestIncome)-n(a.newestIncome));
  const best=ranked.find(f=>n(f.newestIncome)>0),worst=[...ranked].reverse().find(f=>n(f.newestIncome)<0),daily=n(s.newestIncome),pending=n(s.pendingAmount)||0;
  const confirmedAmount=n(s.confirmedAmount)??confirmed.reduce((sum,f)=>sum+(n(f.totalAmount)||0),0),openingAmount=daily===null?null:confirmedAmount-daily;
  const dailyRate=openingAmount>0?daily/openingAmount*100:null;
  const rate=v=>n(v)===null?'—':`${n(v)>0?'+':''}${n(v).toFixed(3)}%`,points=v=>n(v)===null?'—':`${n(v)>0?'+':''}${n(v).toFixed(3)}`,contribution=f=>openingAmount>0?n(f.newestIncome)/openingAmount*100:null;
  const direction=dailyRate===null?'最新日收益率暂缺':dailyRate>0?`基金最新日收益率约为 ${rate(dailyRate)}，整体收红`:dailyRate<0?`基金最新日收益率约为 ${rate(dailyRate)}，整体回落`:'基金最新日收益率持平';
  const contributors=[best?`主要正贡献来自 ${esc(best.fundName)}（${points(contribution(best))} 个百分点）`:'',worst?`主要拖累来自 ${esc(worst.fundName)}（${points(contribution(worst))} 个百分点）`:''].filter(Boolean).join('，');
  const coverage=`${up.length} 只上涨、${down.length} 只下跌、${flat.length} 只持平${missing.length?`、${missing.length} 只待更新`:''}`;
  const pendingText=pending>0?`另有 ${money(pending)} 待确认资金，暂不纳入历史表现。`:'';
  return `<section class="account-brief card"><div class="brief-head"><div><span>账户晨报</span><small>同步于 ${esc(timeOnly(d.fetchedAt))} · 本机整理，尚未发送给模型</small></div>${button('查看完整持仓','nav','data-to="holdings"','small subtle')}</div><div class="brief-grid"><div><small>基金资产总额</small><strong>${money(s.totalAmount)}</strong></div><div title="按最新日收益金额 ÷ 日初已确认基金资产估算"><small>基金最新日收益率</small><strong class="${color(dailyRate)}">${rate(dailyRate)}</strong></div><div><small>持有收益</small><strong class="${color(s.holdIncome)}">${signed(s.holdIncome)}</strong></div><div><small>钱包总份额</small><strong>${num(d.wallet.ok?d.wallet.total:null)}</strong></div></div><div class="brief-summary"><span>✦</span><p><strong>最新表现速览</strong>${direction}；${coverage}。${contributors?contributors+'。':''}${pendingText}<span class="brief-method">收益率按已确认基金资产估算，各基金净值日期可能不同。</span></p>${D.enabled?button('让 AI 深入解读','',`data-agent-prompt="结合我的最新账户快照，分析最新一日收益率、主要贡献和拖累、待确认资金影响，并说明各基金净值日期可能不同。"`,'small'):''}</div></section>`;
}
function openDialog(title,body,footer='',sub='') {
  const dialog=$('#dialog');if(!dialog.open)lastFocus=document.activeElement;
  modalToken++;
  $('#dialog-content').innerHTML=`<div class="dialog-head"><div><h2 id="dialog-title">${title}</h2>${sub?`<p class="dialog-sub">${sub}</p>`:''}</div><button class="close" data-action="close-dialog" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div>${footer?`<div class="dialog-footer">${footer}</div>`:''}`;
  if(!dialog.open)dialog.showModal();
  return modalToken;
}
function closeDialog(){if($('#dialog').open){$('#dialog').close();lastFocus?.focus?.();}modalToken++;}
async function fundDetail(code) {
  const f=getFund(code);if(!f)return;
  activeFund=f;
  const s=getStrategy(code);
  const token=openDialog(esc(f.fundName),`${kv('基金代码',code)}${kv('持有金额',money(f.totalAmount))}${kv('持有份额',n(f.holdVol)===null?esc(f.holdVol):num(f.holdVol)+' 份')}${kv('持有收益',`<span class="${color(f.holdIncome)}">${money(f.holdIncome)} / ${esc(f.holdIncomeRate||'—')}</span>`)}${kv('策略关联',s?esc(s.name)+'（草稿）':'未关联')}<div class="section-label">持仓账户与净值日期</div><div id="fund-accounts">${loading('正在读取账户明细…')}</div><div class="section-label">管理这只基金</div><div class="inline-actions">${button('申购','buy-prepare',`data-code="${code}"`,'primary')}${button('赎回','redeem-prepare',`data-code="${code}"`)}${button('关联策略','select-template',`data-code="${code}"`)}${button('加入自选','watch-fund',`data-code="${code}"`)}${button('查看订单','fund-orders',`data-code="${code}"`)}</div>`, '', '账户信息来自 thsfund；申购或赎回提交前会再次核对最新规则。');
  try{
    const d=await api('/api/fund/accounts?code='+code);if(token!==modalToken)return;
    $('#fund-accounts').innerHTML=d.dates.map((v,i)=>`${i===0?kv('单位净值 / 净值日期',esc(v.navValue??'—')+' / '+fmtDate(v.navDate))+kv('收益日期',fmtDate(v.incomeDate)):''}`).join('')+d.accounts.map(a=>kv(esc(a.bank||'银行名称未返回')+' '+esc(a.bankAccount),'可用 '+num(a.availableShares)+' 份')).join('')+(d.failedCategories.length?banner('部分账户类别获取失败，请刷新核对。','warning'):'')+(!d.accounts.length?'<p class="muted small-text">接口未返回可识别的具体交易账户。</p>':'');
  }catch(e){if(token===modalToken)$('#fund-accounts').innerHTML=banner(esc(e.message),'error');}
}
function templateDetail(id){const t=getTemplate(id);if(!t)return;openDialog(esc(t.name),`<p class="muted">${esc(t.description)}</p>${kv('默认单次投入',money(t.defaultAmount))}${kv('默认触发节奏',esc(t.rhythm))}${kv('适用基金',esc(t.scope))}${kv('所需数据',esc(t.needs))}<div class="section-label">本页可配置参数</div>${t.fields.map(f=>kv(esc(f.label),esc(f.value)+'（初始草稿值）')).join('')}<div class="audit-note">参数仅用于保存研究意图，尚未经过回测验证。实际算法、基金适用性和费用处理仍需对应策略引擎验证。</div>`,button('创建我的策略','create-strategy',`data-template="${id}"`,'primary'));}
function chooseTemplate(code){openDialog('为基金选择策略',`<p class="muted small-text">基金 ${esc(code)} · 先核实基金类型，模板不会自动判断适用性。</p><div class="section-label">选择规则模板</div>${S.templates.map(t=>`<div class="metric-row"><span>${esc(t.name)}<br><small>${esc(t.scope)}</small></span>${button('选择','create-strategy',`data-template="${t.id}" data-code="${code}"`,'small')}</div>`).join('')}`);}
function createStrategy(id,code=''){
  const t=getTemplate(id);if(!t)return;
  openDialog('创建我的策略',`<form id="strategy-form"><input type="hidden" name="templateId" value="${id}"><div class="form-grid"><div class="field full"><label for="strategy-name">策略名称</label><input id="strategy-name" name="name" required maxlength="60" value="${esc(t.name)} · 我的计划"></div><div class="field full"><label for="strategy-codes">研究基金代码</label><input id="strategy-codes" name="codes" required placeholder="6 位基金代码，多只以英文逗号分隔" value="${esc(code)}"><small>${esc(t.scope)}。同一只基金同时保留一份未归档策略。</small></div><div class="field"><label for="strategy-budget">每月预算（元）</label><input id="strategy-budget" name="budget" type="number" min="0.01" max="999999999999" step="0.01" placeholder="例如 2000" required></div><div class="field"><label for="strategy-amount">单次计划投入（元）</label><input id="strategy-amount" name="amount" type="number" min="0.01" step="0.01" value="${Number(t.defaultAmount)||200}" required><small>默认节奏：${esc(t.rhythm)}</small></div>${t.fields.map(f=>`<div class="field"><label for="param-${f.key}">${esc(f.label)}</label><input id="param-${f.key}" name="param-${f.key}" type="number" min="${f.min}" max="${f.max}" value="${f.value}" required></div>`).join('')}<label class="checkbox-label field full"><span><input type="checkbox" name="eligibilityConfirmed" required> 我已核对基金属于此模板的适用范围。</span></label></div><div class="audit-note">保存为策略草稿。预算独立记录，不占用钱包资金；待计算引擎接入并验证后，才可以生成真实信号。</div><div class="form-footer">${button('取消','close-dialog')}<button class="button primary">保存策略草稿</button></div></form>`, '',esc(t.name)+' · 模板 v1');
}
function instanceDetail(id){const s=S.state.strategies.find(x=>x.id===id);if(!s)return;const t=getTemplate(s.templateId);openDialog(esc(s.name),`${kv('规则模板',esc(t?.name||s.templateId))}${kv('模板 / 实例版本','v'+s.templateVersion+' / v'+s.version)}${kv('基金代码',s.codes.map(esc).join('、'))}${kv('月预算 / 单次投入',money(s.budget)+' / '+money(s.amount))}${(t?.fields||[]).map(f=>kv(esc(f.label),esc(s.params[f.key]))).join('')}<div class="audit-note">状态：${s.status==='archived'?'已归档':'草稿，等待引擎与数据验证'}。参数版本固定保存；修改规则时可归档并创建新版本，不改写旧配置。</div>`);}
async function buyPrepare(code){
  const token=openDialog('买入准备',loading('正在获取申购规则与账户风险信息…'));activePreview=null;
  try{const d=await api('/api/fund/buy-preview?code='+code);if(token!==modalToken)return;activePreview=d;
    const feeTable=d.rates?.length?`<div class="table-scroll"><table><thead><tr><th>申购金额区间</th><th>原始费率</th></tr></thead><tbody>${d.rates.map(x=>`<tr><td>${esc(x.money)}</td><td>${esc(x.rate)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted small-text">接口未提供完整费率。</p>';
    const discount=v=>n(v)===null?'未提供':n(v)===1?'不打折':n(v)===0?'0 折（免手续费）':String(Number((n(v)*10).toFixed(2)))+' 折';
    openDialog('申购准备 · '+esc(d.name),`${(d.blocked||[]).map(t=>banner(esc(t),'error')).join('')}${(d.notices||[]).map(t=>banner(esc(t),'warning')).join('')}${kv('基金代码',code)}${kv('产品 / 客户风险','R'+esc(d.risk||'—')+' / C'+esc(d.clientRisk||'—'))}${kv('首次 / 追加起购',money(d.minBuy)+' / '+money(d.minAdd))}${kv('申请日 / 预计确认',fmtDate(d.applicationDay)+' / '+fmtDate(d.confirmationDay))}<div class="section-label">费用信息</div>${feeTable}${kv('银行卡 / 钱包折扣',discount(d.bankDiscount)+' / '+discount(d.walletDiscount))}${kv('管理费 / 托管费 / 服务费',esc(d.managementFee||'—')+' / '+esc(d.custodyFee||'—')+' / '+esc(d.serviceFee||'—'))}${!(d.blocked||[]).length?`<form id="buy-transaction-form"><input type="hidden" name="code" value="${code}"><div class="field"><label for="buy-amount">本次申购金额（元）</label><input id="buy-amount" name="amount" type="number" min="0.01" step="0.01" required placeholder="填写本次真实申购金额"></div><div class="audit-note">下一步将重新校验风险、支付账户、限额和协议，并展示最终确认页。未点击最终提交前不会下单。</div><div class="form-footer"><button class="button primary">选择支付方式</button></div></form>`:''}`,'','真实规则来自 thsfund；当前尚未提交申购。');
  }catch(e){if(token===modalToken)openDialog('买入信息获取失败',banner(esc(e.message),'error'));}
}
async function redeemPrepare(code){
  const token=openDialog('赎回准备',loading('正在读取这只基金的交易账户…'));activePreview=null;
  try{const d=await api('/api/fund/accounts?code='+code);if(token!==modalToken)return;
    if(!d.accounts.length){openDialog('赎回准备',banner('未找到可识别的交易账户，请在同花顺 App 核对持仓。','warning'));return;}
    openDialog('选择赎回账户',`${d.failedCategories.length?banner('部分账户查询失败，以下仅为成功返回的账户。','warning'):''}<form id="redeem-account-form"><input type="hidden" name="code" value="${code}">${d.accounts.map(a=>`<label class="account-option"><input type="radio" name="account" value="${a.id}" required><span>${esc(a.bank||'银行名称未提供')} ${esc(a.bankAccount)}<small>接口可用份额 ${num(a.availableShares)} 份</small></span></label>`).join('')}<div class="form-footer"><button class="button primary">查询赎回规则</button></div></form>`, '',esc(getFund(code)?.fundName||code));
  }catch(e){if(token===modalToken)openDialog('账户查询失败',banner(esc(e.message),'error'));}
}
async function showRedeemPreview(code,account){
  const token=openDialog('赎回准备',loading('正在获取可赎回份额与费率…'));
  try{const d=await api('/api/fund/redeem-preview?'+new URLSearchParams({code,account}));if(token!==modalToken)return;activePreview=d;const f=d.fundInfo;
    openDialog('赎回准备 · '+esc(getFund(code)?.fundName||code),`${kv('基金代码',code)}${kv('参考净值 / 日期',esc(f.nav??'—')+' / '+fmtDate(f.navDate))}${kv('最小赎回份额',num(f.minRedemptionVol))}${kv('账户可用份额',num(d.availableShares))}${kv('最低保留份额',num(f.minAccountBalance))}${kv('接口单笔上限',num(f.maxRedemptionVol))}${kv('支持赎回至钱包',String(f.canRedeemToWallet)==='1'?'支持':'不支持')}<div class="section-label">持有期费率</div>${d.stepRates.length?`<div class="table-scroll"><table><tbody>${d.stepRates.map(r=>`<tr><td>${esc(r.range||'持有期区间')}</td><td>${esc(r.rate||'费率未提供')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted small-text">当前响应未提供可展示的阶梯费率。</p>'}${kv('申请日',fmtDate(d.applicationDay))}${(d.settlement||[]).map(x=>kv('预计到银行卡',esc(x.toBankTime||'接口未提供'))+kv('预计到钱包',esc(x.toDepositTime||'接口未提供'))).join('')}<form id="redeem-transaction-form"><input type="hidden" name="code" value="${code}"><input type="hidden" name="account" value="${esc(account)}"><div class="form-grid"><div class="field"><label for="redeem-shares">本次赎回份额</label><input id="redeem-shares" type="number" name="shares" min="0.01" step="0.01" required></div><div class="field"><label for="redeem-destination">回款方式</label><select id="redeem-destination" name="destination"><option value="0">赎回至银行卡</option>${String(f.canRedeemToWallet)==='1'?'<option value="1">赎回至钱包（通常更快）</option>':''}</select></div></div><div class="audit-note">下一步会用最新持仓重新校验份额，并展示最终确认页。参考净值不能确定实际到账金额。</div><div class="form-footer"><button class="button primary">核对赎回订单</button></div></form>`,'','真实规则来自 thsfund；当前尚未提交赎回。');
  }catch(e){if(token===modalToken)openDialog('赎回规则获取失败',banner(esc(e.message),'error'));}
}
async function orderDetail(id){
  let o=S.orders.find(x=>x.id===id);if(!o)return;
  const token=openDialog('交易详情',loading('读取订单确认结果…'));
  try{if(o.detailAvailable){const detail=await api('/api/order?id='+encodeURIComponent(id));o={...o,...Object.fromEntries(Object.entries(detail).filter(([,v])=>v!==null&&v!==undefined&&v!==''))};}if(token!==modalToken)return;
    openDialog('交易详情',`${kv('基金',esc(o.name)+' '+esc(o.code||''))}${kv('业务',esc(o.subtype||o.type))}${kv('订单号',esc(o.id))}${kv('当前状态',`<span class="tag amber">${esc(o.status)}</span>`)}${kv('处理说明',esc(o.statusDetail||'—'))}${kv('申请金额 / 份额',money(o.amount)+' / '+num(o.shares))}${kv('确认金额 / 份额',money(o.confirmedAmount)+' / '+num(o.confirmedShares))}${kv('发起时间',esc(o.acceptedAt||'—'))}${kv('预计确认',esc(o.expectedAt||'接口未提供'))}${kv('实际确认日',esc(o.confirmedAt||'—'))}${kv('预计回款',esc(o.returnAt||'—'))}${o.bank?kv('关联银行卡',esc(o.bank)+' '+esc(o.bankAccount)):''}${o.reason?banner(esc(o.reason),'warning'):''}<div class="audit-note">${o.canCancel?'当前最新详情显示可撤单。提交前还会再次锁定并校验该订单。':'该订单当前不可撤销。'}<br>申请成功不等于成交成功，最终状态以基金平台确认为准。</div>${o.canCancel?`<div class="form-footer">${button('准备撤单','revoke-prepare',`data-id="${esc(o.id)}"`,'danger')}</div>`:''}`);
  }catch(e){if(token===modalToken)openDialog('订单详情暂不可用',banner(esc(e.message),'error'));}
}
async function showBuyConfirmation(data){
  const payments=data.payments.map((p,i)=>`<label class="account-option"><input type="radio" name="paymentRef" value="${esc(p.ref)}" ${i===0?'':' '} required><span><strong>${esc(p.kind)} · ${esc(p.bank)} ${esc(p.account)}</strong><small>${p.kind==='钱包'?'可用份额 '+num(p.available):'单笔 / 单日限额 '+num(p.singleLimit)+' / '+num(p.dailyLimit)}</small></span></label>`).join('');
  const riskNotice=data.riskMismatch?banner('产品风险高于你的当前风险承受等级；点击确认申购表示你已知悉并继续。','warning'):'';
  openDialog('确认申购订单',`${riskNotice}${kv('基金',esc(data.name)+' '+esc(data.code))}${kv('申购金额',money(data.amount))}${kv('风险等级','产品 R'+esc(data.risk)+' / 客户 C'+esc(data.clientRisk))}<form id="confirm-buy-form"><input type="hidden" name="token" value="${esc(data.token)}"><div class="section-label">选择支付方式</div>${payments}<div class="audit-note">点击「确认申购」即表示你同意本次交易所需协议，并确认上述基金、金额、风险与支付方式。系统会先自动完成全部协议的阅读留痕，再提交一次申购；结果不明确时不会自动重试。</div><div class="form-footer">${button('取消','close-dialog')}<button class="button primary">确认申购</button></div></form>`,'','确认信息有效 10 分钟。');
}
async function showRedeemConfirmation(data){
  const agreement=data.agreement?`<div class="section-label">钱包赎回协议</div><div class="agreement-list"><a href="${esc(data.agreement.agreementUrl)}" target="_blank" rel="noopener noreferrer">${esc(data.agreement.title)} ↗</a></div><label class="checkbox-label"><input type="checkbox" name="agreementsAccepted" required>我已阅读基金赎回协议。</label>`:'';
  openDialog('确认赎回订单',`${kv('基金',esc(data.name)+' '+esc(data.code))}${kv('赎回账户',esc(data.account))}${kv('赎回方式',esc(data.destination))}${kv('赎回份额',num(data.shares)+' 份')}${kv('手续费','按持有批次与最终确认规则核定')}${kv('预估到账金额','以基金公司最终确认净值为准')}<form id="confirm-redeem-form"><input type="hidden" name="token" value="${esc(data.token)}">${agreement}<div class="field"><label for="redeem-confirm-word">输入 <span class="confirm-word">确认赎回</span></label><input id="redeem-confirm-word" name="confirmation" required autocomplete="off"></div><div class="audit-note">赎回只提交一次；结果不明确时不会自动重试。</div><div class="form-footer">${button('取消','close-dialog')}<button class="button primary">确认并提交赎回</button></div></form>`,'','确认信息有效 10 分钟。');
}
async function revokePrepare(orderId){
  const token=openDialog('撤单准备',loading('正在重新读取订单与可撤资格…'));
  try{const d=await api('/api/transactions/revoke/prepare',{orderId});if(token!==modalToken)return;const o=d.order;openDialog('确认撤单',`${kv('基金',esc(o.name)+' '+esc(o.code||''))}${kv('订单号',esc(o.id))}${kv('申请金额 / 份额',money(o.amount)+' / '+num(o.shares))}${kv('发起时间',esc(o.acceptedAt||'—'))}${banner(esc(d.refundNotice),'warning')}<form id="confirm-revoke-form"><input type="hidden" name="token" value="${esc(d.token)}"><div class="field"><label for="revoke-confirm-word">输入 <span class="confirm-word">确认撤单</span></label><input id="revoke-confirm-word" name="confirmation" required autocomplete="off"></div><div class="audit-note">撤单只针对上方订单，提交结果不明确时不会自动重试。</div><div class="form-footer">${button('取消','close-dialog')}<button class="button danger">确认并提交撤单</button></div></form>`,'','可撤资格会变化，确认信息有效 10 分钟。');}catch(e){if(token===modalToken)openDialog('无法撤单',banner(esc(e.message),'error'));}
}
async function batchRevokePrepare(){
  const orderIds=[...S.selectedOrders];
  if(!orderIds.length)throw new Error('请先选择至少一笔可撤订单。');
  const token=openDialog('批量撤单准备',loading('正在逐笔重新校验订单与可撤资格…'));
  try{
    const d=await api('/api/transactions/revoke/batch-prepare',{orderIds});if(token!==modalToken)return;
    const rows=d.orders.map(o=>`<tr><td>${esc(o.name)}<span class="fund-code">${esc(o.code||'组合产品')}</span></td><td class="num">${esc(o.id)}</td><td>${esc(o.subtype||o.type)}</td><td class="right num">${money(o.amount)}${n(o.shares)!==null?`<span class="fund-code">${num(o.shares)} 份</span>`:''}</td></tr>`).join('');
    openDialog('确认批量撤单',`${banner(esc(d.refundNotice),'warning')}<div class="table-scroll batch-review"><table><thead><tr><th>基金</th><th>订单号</th><th>业务</th><th class="right">申请金额 / 份额</th></tr></thead><tbody>${rows}</tbody></table></div><form id="confirm-batch-revoke-form"><input type="hidden" name="token" value="${esc(d.token)}"><div class="field"><label for="batch-revoke-confirm-word">输入 <span class="confirm-word">确认批量撤单</span></label><input id="batch-revoke-confirm-word" name="confirmation" required autocomplete="off"></div><div class="audit-note">上述 ${d.orders.length} 笔订单将逐笔提交，一笔失败不会重试，也不会阻止后续已确认订单。</div><div class="form-footer">${button('取消','close-dialog')}<button class="button danger">确认并批量撤单</button></div></form>`,'','可撤资格会变化，确认信息有效 10 分钟。');
  }catch(e){if(token===modalToken)openDialog('批量撤单无法准备',banner(esc(e.message),'error'));}
}
function batchTransactionResult(result){
  const rows=result.results.map(x=>`<tr><td class="num">${esc(x.orderId)}</td><td><span class="tag ${x.ok?'green':'amber'}">${x.ok?'已提交':'失败'}</span></td><td>${esc(x.ok?x.result?.message:x.message)}</td></tr>`).join('');
  openDialog('批量撤单结果',`<div class="transaction-result"><h3>已提交 ${result.successCount} 笔，失败 ${result.failureCount} 笔</h3><p>撤单申请与最终确认可能存在时间差，请继续查看真实订单状态。</p></div><div class="table-scroll batch-review"><table><thead><tr><th>订单号</th><th>提交结果</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></div><div class="audit-note">数据来源：${esc(result.source)}。失败项不会自动重试。</div>`,button('刷新订单','draft-to-orders','','primary'));
}
function transactionResult(title,result){
  const o=result.order;openDialog(title,`<div class="transaction-result"><h3>${esc(result.message)}</h3><p>${esc(result.refundNotice||'申请成功不等于最终确认成功，请继续核对订单。')}</p></div>${kv('订单号',esc(result.orderId||'接口暂未返回'))}${kv('提交时间',esc(dateTime(result.submittedAt)))}${o?kv('最新状态',esc(o.status)+' · '+esc(o.statusDetail||'')):''}<div class="audit-note">数据来源：${esc(result.source)}。如订单号或最终状态尚未返回，请刷新真实订单，切勿直接重复提交。</div>`,button('查看真实订单','draft-to-orders','','primary'));
}
function addWatch(){openDialog('添加自选基金',`<form id="watch-form"><div class="form-grid"><div class="field full"><label for="watch-code">基金代码</label><input id="watch-code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="6 位基金代码"></div><div class="field full"><label for="watch-name">名称或备注（可选）</label><input id="watch-name" name="name" maxlength="80" placeholder="持仓外的备注名称尚未经过行情接口核实"></div></div><div class="form-footer"><button class="button primary">添加自选</button></div></form>`);}
function draftDetail(id){const d=S.state.drafts.find(x=>x.id===id);if(!d)return;openDialog('交易待办 · 未提交',`${kv('基金',esc(d.name)+' '+d.code)}${kv('动作',d.kind==='buy'?'买入':'赎回')}${kv(d.kind==='buy'?'计划金额':'计划份额',d.kind==='buy'?money(d.value):num(d.value)+' 份')}${kv('创建时间',esc(dateTime(d.createdAt)))}<div class="audit-note">待办只记录意图。正式申购或赎回请从持仓页选择基金，订单中心用于核对提交与确认结果。</div>`,button('打开订单中心','draft-to-orders','','primary'));}

document.addEventListener('click',async e=>{
  const target=e.target.closest('[data-action],[data-route]');if(!target)return;
  if(target.dataset.route){navigate(target.dataset.route);return;}
  const a=target.dataset.action,d=target.dataset;
  try{
    if(a==='nav')navigate(d.to);
    else if(a==='refresh-holdings')await loadHoldings();
    else if(a==='holding-tab'){S.holdingTab=d.tab;render();if(d.tab==='analysis'&&!S.analysis&&!S.analysisBusy)loadAnalysis();}
    else if(a==='refresh-analysis'){S.analysis=null;await loadAnalysis();}
    else if(a==='fund-detail')await fundDetail(d.code);
    else if(a==='close-dialog')closeDialog();
    else if(a==='template-detail')templateDetail(d.template);
    else if(a==='create-strategy')createStrategy(d.template,d.code||'');
    else if(a==='select-template')chooseTemplate(d.code);
    else if(a==='strategy-open')openStrategy(d.id);
    else if(a==='strategy-guide')strategyGuide();
    else if(a==='strategy-back'){S.strategySelected=null;S.strategyResult=null;S.strategyCode='';render();}
    else if(a==='strategy-backtest-submit')await runStrategyFromForm();
    else if(a==='strategy-agent-adjust')strategyAgentAdjust(d.prompt);
    else if(a==='strategy-save-plan')confirmSaveStrategyPlan();
    else if(a==='strategy-save-confirm')await saveStrategyPlan();
    else if(a==='strategy-plan-action')await strategyPlanAction(d.id,d.planAction);
    else if(a==='mine-filter'){S.mineFilter=d.filter;render();}
    else if(a==='instance-detail')instanceDetail(d.id);
    else if(a==='archive-strategy'){openDialog('归档这份策略',`<p class="muted">归档后保留原有参数与预算记录，并解除基金的当前策略关联。实际持仓不变。</p>`,button('取消','close-dialog')+button('确认归档','confirm-archive',`data-id="${d.id}"`,'primary'));}
    else if(a==='confirm-archive'){target.disabled=true;S.state=await api('/api/strategies/archive',{id:d.id});closeDialog();render();toast('策略已归档');}
    else if(a==='trade-tab'){S.orderTab=d.tab;render();if(d.tab==='records'&&!S.ordersLoaded)loadOrders();}
    else if(a==='refresh-orders')await loadOrders();
    else if(a==='more-orders')await loadOrders(true);
    else if(a==='order-detail')await orderDetail(d.id);
    else if(a==='fund-orders'){S.orderFilter=d.code;S.orderTab='records';closeDialog();navigate('trades');}
    else if(a==='clear-order-filter'){S.orderFilter='';render();}
    else if(a==='select-all-orders'){
      const visible=(S.orderFilter?S.orders.filter(o=>o.code===S.orderFilter):S.orders).filter(o=>o.canCancel&&o.id);
      const select=visible.some(o=>!S.selectedOrders.has(o.id));visible.forEach(o=>select?S.selectedOrders.add(o.id):S.selectedOrders.delete(o.id));render();
    }else if(a==='batch-revoke')await batchRevokePrepare();
    else if(a==='buy-prepare')await buyPrepare(d.code);
    else if(a==='redeem-prepare')await redeemPrepare(d.code);
    else if(a==='revoke-prepare')await revokePrepare(d.id);
    else if(a==='draft-detail')draftDetail(d.id);
    else if(a==='draft-to-orders'){S.orderTab='records';closeDialog();navigate('trades');loadOrders();}
    else if(a==='remove-draft'){S.state=await api('/api/drafts/remove',{id:d.id});render();toast('已移除本地待办');}
    else if(a==='add-watch')addWatch();
    else if(a==='watch-fund'){S.state=await api('/api/watchlist',{code:d.code,name:getFund(d.code)?.fundName});toast('已加入自选');}
    else if(a==='remove-watch'){S.state=await api('/api/watchlist',{code:d.code,remove:true});render();}
    else if(a==='ai-mode'){S.modelMode=d.mode;render();}
    else if(a==='check-ai'){S.ai=await api('/api/ai/status');render();toast('已更新模型连接状态');}
    else if(a==='clear-api'){S.ai=await api('/api/ai/disconnect',{});render();toast('已清除服务内存中的密钥');}
    else if(a==='fund-login'){target.disabled=true;const r=await api('/api/fund/login',{});$('#login-message').textContent=r.message;pollLogin();}
    else if(a==='clear-chat'){S.messages=[];render();}
    else if(a==='focus-agent'){openAgentPanel();$('#agent-input').focus();}
    else if(a==='desktop-subscription'){await desktopSaveSubscription();}
    else if(a==='desktop-test-provider'){await desktopTestProvider(target);}
    else if(a==='focus-provider-form'){$('#desktop-provider-name')?.focus();}
  }catch(err){toast(err.message);target.disabled=false;}
});
document.addEventListener('click',e=>{const q=e.target.closest('[data-agent-prompt]');if(!q)return;openAgentPanel();$('#agent-input').value=q.dataset.agentPrompt;$('#agent-input').focus();});
document.addEventListener('input',e=>{
  if(e.target.id==='hold-search'){const q=e.target.value.trim().toLowerCase();let count=0;document.querySelectorAll('[data-holding-row]').forEach(row=>{row.hidden=!row.dataset.search.includes(q);if(!row.hidden)count++;});$('#no-hold-results').hidden=count>0;}
});
document.addEventListener('change',e=>{
  if(e.target.matches('[data-order-select]')){const id=e.target.dataset.orderSelect;e.target.checked?S.selectedOrders.add(id):S.selectedOrders.delete(id);render();}
});
document.addEventListener('keydown',e=>{if(e.target.id==='chat-input'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!S.chatBusy)$('#chat-form').requestSubmit();}});
$('#dialog').addEventListener('click',e=>{if(e.target===$('#dialog')){const r=$('#dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});
$('#dialog').addEventListener('cancel',()=>modalToken++);
document.addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target;if(!(form instanceof HTMLFormElement))return;
  if(form.id==='agent-question-form')return;
  const data=Object.fromEntries(new FormData(form));const submit=form.querySelector('button[type="submit"],button:not([type]):not([data-action])');if(submit)submit.disabled=true;
  form.querySelector('.form-error')?.remove();
  try{
    if(form.id==='strategy-backtest-form'){
      await runStrategyFromForm();
    }else if(form.id==='strategy-form'){
      const t=getTemplate(data.templateId),params={};t.fields.forEach(f=>params[f.key]=Number(data['param-'+f.key]));
      await api('/api/strategies',{...data,params,eligibilityConfirmed:data.eligibilityConfirmed==='on'});await reloadState();closeDialog();navigate('strategies');toast('策略草稿已保存');
    }else if(form.id==='orders-form'){orderForm={...orderForm,...data};S.orders=[];S.orderNext=null;S.ordersLoaded=false;await loadOrders();
    }else if(form.id==='watch-form'){S.state=await api('/api/watchlist',{...data,name:getFund(data.code)?.fundName||data.name||'名称待核实'});closeDialog();render();toast('已添加到自选');
    }else if(form.id==='desktop-subscription-form'){
      D.settings=await desktopCall(window.fundDesktop.saveProvider({mode:'subscription',...data}));
      D.subscriptionDraftModel=null;D.subscriptionDraftEffort=null;
      if(D.status)D.status.settings=D.settings;
      render();toast('订阅模型已保存，将用于之后新建的会话。');
    }else if(form.id==='desktop-provider-form'){
      await desktopSaveProvider(data);render();
    }else if(form.id==='subscription-form'||form.id==='api-form'){
      S.ai=await api('/api/ai/config',{...data,mode:form.id==='api-form'?'api':'subscription'});if(form.id==='api-form')form.reset();render();toast(S.ai.mode==='api'?'API 配置已保存，发送消息时验证调用':'已切换为订阅模式');
    }else if(form.id==='redeem-account-form'){await showRedeemPreview(data.code,data.account);
    }else if(form.id==='buy-transaction-form'){
      const review=await api('/api/transactions/buy/prepare',{code:data.code,amount:data.amount});await showBuyConfirmation(review);
    }else if(form.id==='confirm-buy-form'){
      const result=await api('/api/transactions/buy/submit',{token:data.token,paymentRef:data.paymentRef,confirmation:'确认申购',agreementsAccepted:true,riskAccepted:true});S.ordersLoaded=false;transactionResult('申购提交结果',result);
    }else if(form.id==='redeem-transaction-form'){
      const review=await api('/api/transactions/redeem/prepare',{code:data.code,account:data.account,shares:data.shares,destination:data.destination});await showRedeemConfirmation(review);
    }else if(form.id==='confirm-redeem-form'){
      const result=await api('/api/transactions/redeem/submit',{token:data.token,confirmation:data.confirmation,agreementsAccepted:data.agreementsAccepted==='on'});S.ordersLoaded=false;transactionResult('赎回提交结果',result);
    }else if(form.id==='confirm-revoke-form'){
      const result=await api('/api/transactions/revoke/submit',{token:data.token,confirmation:data.confirmation});S.ordersLoaded=false;transactionResult('撤单提交结果',result);
    }else if(form.id==='confirm-batch-revoke-form'){
      const result=await api('/api/transactions/revoke/batch-submit',{token:data.token,confirmation:data.confirmation});S.selectedOrders.clear();S.ordersLoaded=false;batchTransactionResult(result);
    }else if(form.id==='buy-draft-form'||form.id==='redeem-draft-form'){
      const buy=form.id==='buy-draft-form';const v=Number(data.value);
      if(!buy && n(activePreview?.availableShares)!==null && v>Number(activePreview.availableShares))throw new Error('计划份额超过当前账户可用份额。');
      if(!buy && n(activePreview?.fundInfo.maxRedemptionVol)!==null && v>Number(activePreview.fundInfo.maxRedemptionVol))throw new Error('计划份额超过本次接口返回的最大可赎回份额。');
      if(!buy && n(activePreview?.fundInfo.minRedemptionVol)!==null && v<Number(activePreview.fundInfo.minRedemptionVol))throw new Error('计划份额低于最小可赎回份额，请到官方页面核对全额赎回规则。');
      if(buy && n(activePreview?.maxBuy)!==null && v>Number(activePreview.maxBuy))throw new Error('金额超过接口返回的单笔上限。');
      await api('/api/drafts',{kind:buy?'buy':'redeem',code:data.code,name:getFund(data.code)?.fundName||activePreview?.name||'',value:data.value});await reloadState();closeDialog();S.orderTab='drafts';navigate('trades');toast('已保存待办，尚未提交基金交易');
    }else if(form.id==='chat-form'){
      if(S.chatBusy)return;
      const message=data.message.trim();if(!message)return;
      S.chatBusy=true;const history=S.messages.filter(m=>!m.pending&&!m.error).map(({role,content})=>({role,content}));
      S.messages.push({role:'user',content:message});const pending={role:'assistant',content:'正在读取问题并生成回答…',pending:true};S.messages.push(pending);render();
      try{const job=await api('/api/ai/chat',{message,history,includeHoldings:data.includeHoldings==='on'});let result;for(let attempt=0;attempt<150;attempt++){await new Promise(resolve=>setTimeout(resolve,1500));const state=await api('/api/ai/job?id='+encodeURIComponent(job.jobId));if(state.status==='error')throw new Error(state.message);if(state.status==='complete'){result=state.result;break;}}if(!result)throw new Error('模型仍未返回结果，请稍后重试。');Object.assign(pending,{content:result.reply,contextAt:result.contextAt,pending:false});}
      catch(err){Object.assign(pending,{content:err.message,error:true,pending:false});}
      finally{S.chatBusy=false;if(S.route==='home')render();}
    }
  }catch(err){if(document.contains(form))form.insertAdjacentHTML('beforeend',`<div class="form-error" role="alert">${esc(err.message)}</div>`);else toast(err.message);}
  finally{if(submit)submit.disabled=false;}
});
async function pollLogin(){
  try{const r=await api('/api/fund/login-status');if($('#login-message'))$('#login-message').textContent=r.message;if(r.running)setTimeout(pollLogin,2500);else{toast(r.message);if(r.message.startsWith('授权成功'))await loadHoldings();else if(S.route==='settings')render();}}
  catch(e){toast(e.message);}
}

function subscriptionModelRows(){
  const value=D.status?.models,rows=Array.isArray(value?.data)?value.data:Array.isArray(value?.models)?value.models:[];
  return rows.filter(row=>row&&typeof row.id==='string');
}
function modelEfforts(model){
  return (model?.supportedReasoningEfforts||[]).map(row=>typeof row==='string'?row:row?.reasoningEffort).filter(Boolean);
}
function renderDesktopSettings(){
  const settings=D.settings||{activeMode:'subscription',providers:[]},active=settings.providers.find(x=>x.id===settings.activeProviderId);
  const account=D.status?.account?.account,subscriptionConnected=account?.type==='chatgpt';
  const subscriptionModels=subscriptionModelRows();
  const selectedModelId=D.subscriptionDraftModel||settings.subscriptionModel||'gpt-6-astra';
  const selectedModel=subscriptionModels.find(row=>row.id===selectedModelId)||subscriptionModels[0];
  const efforts=modelEfforts(selectedModel),selectedEffort=D.subscriptionDraftEffort||(selectedModelId===settings.subscriptionModel?settings.subscriptionEffort:selectedModel?.defaultReasoningEffort)||'medium';
  const modelOptions=(subscriptionModels.length?subscriptionModels:[{id:selectedModelId,displayName:selectedModelId}]).map(row=>`<option value="${esc(row.id)}" ${row.id===selectedModelId?'selected':''}>${esc(row.displayName||row.id)}</option>`).join('');
  const effortOptions=(efforts.length?efforts:['low','medium','high','xhigh']).map(value=>`<option value="${esc(value)}" ${value===selectedEffort?'selected':''}>${effortLabel(value)}</option>`).join('');
  const subscriptionPicker=`<form id="desktop-subscription-form" class="subscription-model-form"><div class="form-grid"><div class="field"><label for="desktop-subscription-model">订阅模型</label><select id="desktop-subscription-model" name="model">${modelOptions}</select><small>列表由当前 Codex 订阅实时提供。</small></div><div class="field"><label for="desktop-subscription-effort">推理强度</label><select id="desktop-subscription-effort" name="effort">${effortOptions}</select><small>可选项随模型能力变化。</small></div></div><div class="form-footer"><span>选择仅用于之后新建的会话。</span><button class="button primary">保存订阅模型</button></div></form>`;
  const providers=settings.providers.map(p=>`<button type="button" class="provider-row ${p.id===settings.activeProviderId&&settings.activeMode==='api'?'active':''}" data-action="desktop-select-provider" data-id="${esc(p.id)}"><span><strong>${esc(p.name)}</strong><small>${esc(p.baseUrl)} · ${esc(p.model)} · ${effortLabel(p.effort)}推理</small></span><span class="tag ${p.keyConfigured?'green':'amber'}">${p.keyConfigured?'密钥已加密':'缺少密钥'}</span></button>`).join('');
  return head('CONNECTIONS','接入设置','基金数据和 Codex Agent 独立连接；模型服务固定到每个会话。')+
    `<div class="card settings-section"><div class="card-body"><div class="settings-header"><span class="provider-logo">▤</span><div><h2>同花顺爱基金</h2><p>真实持仓 · 钱包支付 · 申购赎回 · 订单撤销</p></div><span class="tag ${S.fundConnected?'green':'amber'}">${S.fundConnected?'账户已连接':'需要连接或检查授权'}</span></div><div class="inline-actions">${button('同步验证','refresh-holdings',S.loadingHoldings?'disabled':'')}${button('扫码登录','fund-login')}${button('打开订单中心 ↗','nav','data-to="trades"','subtle')}</div><p class="privacy-note" id="login-message">基金授权与交易由同花顺官方 SDK 管理；Agent 可准备交易，最终提交必须在工作台确认页由你本人完成。</p></div></div>`+
    `<div class="card settings-section"><div class="card-head"><h2>Codex Agent 模型</h2><span class="tag ${settings.activeMode==='subscription'&&subscriptionConnected||settings.activeMode==='api'&&active?'green':'amber'}">${settings.activeMode==='subscription'?(subscriptionConnected?'订阅已登录':'需要登录'):(active?esc(active.name):'待配置')}</span></div><div class="card-body"><div class="split-grid"><button class="mode-card ${settings.activeMode==='subscription'?'active':''}" data-action="desktop-subscription"><span class="tag">方式一</span><strong>ChatGPT / Codex 订阅</strong><p>通过官方登录使用订阅模型、持续会话和工具调用。</p></button><button class="mode-card ${settings.activeMode==='api'?'active':''}" type="button" data-action="focus-provider-form"><span class="tag">方式二</span><strong>Responses API</strong><p>支持 OpenAI API 及兼容 Responses 工具调用的第三方服务。</p></button></div>
      <div class="settings-notice"><strong>${subscriptionConnected?'已检测到 ChatGPT 登录':'尚未检测到桌面 Agent 的 ChatGPT 登录'}</strong><br>${subscriptionConnected?`新会话使用 ${esc(settings.subscriptionModel||'gpt-6-astra')} · ${effortLabel(settings.subscriptionEffort)}推理。`:'点击订阅卡片后会打开官方登录页面；首次启动已安全复用本机有效 Codex 登录（如存在）。'}</div>
      ${subscriptionPicker}
      ${providers?`<div class="section-label">已保存的 API 服务</div><div class="provider-list">${providers}</div>`:''}
      <div class="section-label">新增 Responses API 服务</div><form id="desktop-provider-form"><div class="form-grid"><div class="field"><label for="desktop-provider-name">服务名称</label><input id="desktop-provider-name" name="name" required maxlength="60" placeholder="例如 OpenAI API"></div><div class="field"><label for="desktop-provider-model">模型 ID</label><input id="desktop-provider-model" name="model" required placeholder="服务商提供的模型 ID"></div><div class="field"><label for="desktop-provider-effort">推理强度</label><select id="desktop-provider-effort" name="effort"><option value="high" selected>高</option><option value="medium">中</option><option value="low">低</option><option value="xhigh">很高</option></select><small>服务商不支持时，兼容性检测会明确报错。</small></div><div class="field full"><label for="desktop-provider-url">API Base URL</label><input id="desktop-provider-url" name="baseUrl" type="url" required value="https://api.openai.com/v1"><small>仅支持 HTTPS Responses 协议；不支持 Chat Completions 转换。</small></div><div class="field full"><label for="desktop-provider-key">API Key</label><input id="desktop-provider-key" name="apiKey" type="password" autocomplete="off" required><small>由当前操作系统安全存储加密，不进入页面存储、对话或日志。</small></div></div><div class="form-footer"><button class="button primary">加密保存并用于新会话</button>${active?button('检测当前 API 兼容性','desktop-test-provider','','subtle'):''}</div></form>
      <div class="audit-note">兼容性检测分别检查连接、流式文本、基金工具调用和工具结果续接。切换服务商只影响新会话，已有会话继续使用创建时的服务商。账户查询须在每个会话首次发送前单独授权。</div></div></div>`;
}

async function desktopCall(promise){const result=await promise;if(!result?.ok)throw new Error(result?.error||'桌面 Agent 操作失败。');return result.data;}

function openAgentPanel(){if(!D.enabled)return;if(S.route==='home'){placeAgentSurface();$('#agent-input')?.focus();return;}D.panelOpen=true;document.body.classList.remove('agent-collapsed');$('#agent-panel').hidden=false;}
function closeAgentPanel(){if(S.route==='home')return;D.panelOpen=false;document.body.classList.add('agent-collapsed');$('#agent-panel').hidden=true;}

function textFromUserContent(content){return (content||[]).filter(x=>x.type==='text'&&!String(x.text||'').startsWith('[WORKBENCH_PAGE_CONTEXT]')).map(x=>x.text||'').join('\n');}
function isConnectionNotice(text){return /^Reconnecting\.\.\.\s*\d+\/\d+\s*$/i.test(String(text||'').trim());}
function reasoningText(item){
  const values=[item?.text,item?.summaryText,item?.summary];
  for(const value of values){
    if(typeof value==='string'&&value.trim())return value;
    if(Array.isArray(value)){const text=value.map(x=>typeof x==='string'?x:x?.text||'').filter(Boolean).join('\n');if(text)return text;}
  }
  return '';
}
function inlineMarkdown(value){
  let text=esc(value);
  text=text.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  text=text.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  text=text.replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<em>$2</em>');
  text=text.replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return text;
}
function renderMarkdown(value){
  const parts=String(value||'').split(/```/);
  return parts.map((part,index)=>{
    if(index%2===1){const lines=part.replace(/^\w+\n/,'').replace(/\n$/,'');return `<pre><code>${esc(lines)}</code></pre>`;}
    const lines=part.split('\n'),out=[];
    for(let i=0;i<lines.length;){
      const line=lines[i];
      if(!line.trim()){i++;continue;}
      if(/^\s*\|?.+\|.+/.test(line)&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1])){
        const cells=row=>row.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim());
        const heads=cells(line);i+=2;const rows=[];
        while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()){rows.push(cells(lines[i]));i++;}
        out.push(`<div class="agent-table-wrap"><table><thead><tr>${heads.map(cell=>`<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue;
      }
      const heading=line.match(/^(#{1,3})\s+(.+)$/);if(heading){out.push(`<h${heading[1].length+2}>${inlineMarkdown(heading[2])}</h${heading[1].length+2}>`);i++;continue;}
      if(/^\s*[-*]\s+/.test(line)){const items=[];while(i<lines.length&&/^\s*[-*]\s+/.test(lines[i]))items.push(lines[i++].replace(/^\s*[-*]\s+/,''));out.push(`<ul>${items.map(item=>`<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);continue;}
      if(/^\s*\d+\.\s+/.test(line)){const items=[];while(i<lines.length&&/^\s*\d+\.\s+/.test(lines[i]))items.push(lines[i++].replace(/^\s*\d+\.\s+/,''));out.push(`<ol>${items.map(item=>`<li>${inlineMarkdown(item)}</li>`).join('')}</ol>`);continue;}
      if(/^>\s?/.test(line)){out.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/,''))}</blockquote>`);i++;continue;}
      const paragraph=[line];i++;while(i<lines.length&&lines[i].trim()&&!/^(#{1,3})\s+|^\s*[-*]\s+|^\s*\d+\.\s+|^>\s?/.test(lines[i]))paragraph.push(lines[i++]);out.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
    }
    return out.join('');
  }).join('');
}
function planText(plan){
  const rows=Array.isArray(plan)?plan:Array.isArray(plan?.steps)?plan.steps:[];
  return rows.map(row=>`${row.status==='completed'?'✓':row.status==='inProgress'||row.status==='in_progress'?'◌':'○'} ${row.step||row.text||row.description||''}`).join('\n');
}
function hydrateAgentThread(thread){
  D.messages=[];D.tools.clear();D.pendingInput=null;D.plan=null;
  for(const turn of thread?.turns||[])for(const item of turn.items||[]){
    if(item.type==='userMessage')D.messages.push({id:item.id,role:'user',text:textFromUserContent(item.content)});
    else if(item.type==='agentMessage'&&item.text&&!isConnectionNotice(item.text))D.messages.push({id:item.id,role:'assistant',text:item.text});
    else if(item.type==='reasoning'&&reasoningText(item))D.messages.push({id:item.id,type:'reasoning',text:reasoningText(item)});
    else if(item.type==='mcpToolCall'){const row={id:item.id,type:'tool',tool:item.tool,status:item.status,error:item.error};D.messages.push(row);D.tools.set(item.id,row);}
  }
  if(S.route==='home')render();else renderAgentPanel();
}

function effortLabel(value){return ({minimal:'极简',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'超高'})[value]||value||'高';}
function renderAgentQuestion(){
  const host=$('#agent-question'),request=D.pendingInput;if(!host)return;
  if(!request){host.hidden=true;host.innerHTML='';return;}
  const questions=request.questions||[];
  host.hidden=false;host.innerHTML=`<form id="agent-question-form"><strong>Agent 需要你补充信息</strong><p>回答后会从当前步骤继续。</p>${questions.map((q,index)=>{
    const options=Array.isArray(q.options)?q.options:[],name=`agent-answer-${index}`;
    const choices=options.map((option,choice)=>`<label class="agent-choice"><input type="radio" name="${name}" value="${esc(option.label)}" ${choice===0?'required':''}><span><b>${esc(option.label)}</b><small>${esc(option.description||'')}</small></span></label>`).join('');
    const other=q.isOther?`<label class="agent-choice"><input type="radio" name="${name}" value="__other__" ${options.length?'':'required'}><span><b>其他</b><input class="agent-other" name="agent-other-${index}" ${q.isSecret?'type="password" autocomplete="off"':'type="text"'} maxlength="1000" placeholder="请输入你的回答"></span></label>`:'';
    const free=!options.length&&!q.isOther?`<input class="agent-free-answer" name="${name}" ${q.isSecret?'type="password" autocomplete="off"':'type="text"'} required maxlength="1000">`:'';
    return `<fieldset data-question-id="${esc(q.id)}"><legend>${esc(q.header||'请确认')}</legend><p>${esc(q.question||'')}</p>${choices}${other}${free}</fieldset>`;
  }).join('')}<button class="button primary small">提交回答</button></form>`;
}
function renderAgentItem(m){
  if(m.type==='tool')return `<div class="agent-tool ${m.status==='failed'?'error':''}"><span>${m.status==='inProgress'||m.status==='running'?'<i class="spinner"></i>':'◇'}</span><div><strong>${esc(toolLabel(m.tool))}</strong><small>${m.status==='completed'?'工具已完成':m.status==='failed'?'工具调用失败':'正在调用真实数据工具'}</small></div></div>`;
  if(m.type==='reasoning')return `<details class="agent-reasoning" ${m.streaming?'open':''}><summary>${m.streaming?'<i class="spinner"></i> 正在梳理':'思考摘要'}</summary><div>${renderMarkdown(m.text||'')}</div></details>`;
  if(m.type==='plan')return `<div class="agent-plan"><strong>执行计划</strong>${renderMarkdown(m.text||'')}</div>`;
  return `<div class="agent-message ${m.role} ${m.error?'error':''}"><small>${m.role==='user'?'你':'✦ 基金 Agent'}</small><div class="agent-markdown">${m.role==='assistant'?renderMarkdown(m.text||''):esc(m.text||'').replaceAll('\n','<br>')}</div></div>`;
}

function renderAgentPanel(){
  if(!D.enabled||!D.initialized)return;
  const provider=D.current?.providerName||(D.settings?.activeMode==='subscription'?'ChatGPT / Codex 订阅':D.settings?.providers.find(x=>x.id===D.settings.activeProviderId)?.name)||'选择模型服务';
  const model=D.current?.model||(D.settings?.activeMode==='subscription'?D.settings?.subscriptionModel:D.settings?.providers.find(x=>x.id===D.settings.activeProviderId)?.model);
  const effort=D.current?.effort||(D.settings?.activeMode==='subscription'?D.settings?.subscriptionEffort:D.settings?.providers.find(x=>x.id===D.settings.activeProviderId)?.effort);
  $('#agent-provider').textContent=`${provider}${model?' · '+model:''}${effort?' · '+effortLabel(effort)+'推理':''}`;
  $('#agent-session-button').textContent=D.current?.title||'选择会话';
  $('#agent-archive').disabled=!D.current;
  $('#agent-sessions').innerHTML=D.sessions.length?D.sessions.map(s=>`<button type="button" data-agent-session="${esc(s.threadId)}" class="${s.threadId===D.current?.threadId?'active':''}"><strong>${esc(s.title)}</strong><small>${esc(s.providerName||'Codex')} · ${esc((s.updatedAt||s.createdAt||'').slice(0,16).replace('T',' '))}</small></button>`).join(''):'<p>暂无会话</p>';
  $('#agent-messages').innerHTML=D.messages.length?D.messages.map(renderAgentItem).join(''):'<div class="agent-empty"><span>✦</span><strong>开始一个基金研究任务</strong><p>例如：分析持仓集中度，或核对最近的订单。</p></div>';
  renderAgentQuestion();
  $('#agent-status').textContent=D.pendingInput?'Agent 正在等待你的回答。':D.running?'Agent 正在工作，可随时停止。':(D.current?'会话已就绪。':'新建或选择一个会话。');
  $('#agent-run-state').textContent=D.running?'运行中':'就绪';
  $('#agent-stop').hidden=!D.running;$('#agent-send').disabled=D.running;$('#agent-input').disabled=D.running;$('#agent-new').disabled=D.running;$('#agent-archive').disabled=!D.current||D.running;$('#agent-session-button').disabled=D.running;
  $('#agent-data-consent').checked=Boolean(D.current?.dataAuthorized);$('#agent-data-consent').disabled=Boolean(D.current?.dataAuthorized)||D.running;
  requestAnimationFrame(()=>{$('#agent-messages').scrollTop=$('#agent-messages').scrollHeight;});
}

function toolLabel(name){return ({get_account_brief:'读取账户简报',list_holdings:'读取真实持仓',analyze_portfolio:'分析组合风险',list_orders:'查询真实订单',get_order:'读取订单详情',list_strategy_templates:'读取策略模板',create_strategy:'保存策略草稿',set_watchlist:'更新自选基金',save_trade_draft:'保存交易待办',get_fund_accounts:'读取基金账户',get_buy_preview:'查询申购准备',get_redeem_preview:'查询赎回准备'})[name]||name||'基金工具';}

async function desktopNewSession(){const result=await desktopCall(window.fundDesktop.newSession());D.current=result.session;D.messages=[];D.tools.clear();D.pendingInput=null;D.sessions=await desktopCall(window.fundDesktop.listSessions());if(S.route==='home')render();else renderAgentPanel();openAgentPanel();}
async function desktopResume(threadId){const result=await desktopCall(window.fundDesktop.resumeSession(threadId));if(result.stale){D.sessions=result.sessions||[];D.current=null;D.messages=[];D.tools.clear();D.pendingInput=null;renderAgentPanel();toast('一个已失效的会话索引已清理。');return;}D.current=result.session;hydrateAgentThread(result.thread);$('#agent-sessions').hidden=true;}

function currentAgentPageContext(){
  const context={route:S.route,pageTitle:titles[S.route]||''};
  if(S.route==='holdings')context.tab=({list:'持仓明细',analysis:'组合分析',wallet:'钱包与账户'})[S.holdingTab]||S.holdingTab;
  if(S.route==='trades'){context.tab=S.orderTab==='drafts'?'交易待办':'真实订单';context.filter=orderForm.processing==='true'?'处理中订单':'历史订单';}
  if(S.route==='strategies')context.filter=S.mineFilter==='archived'?'已归档':'当前策略';
  if(S.route==='strategy-invest'){
    const item=S.strategyCatalog.find(x=>x.id===S.strategySelected);context.strategy=item?{id:item.id,name:item.name,version:item.version}:null;
    if(S.strategyResult)context.backtest={status:S.strategyResult.status,fundCode:S.strategyResult.fundCode||null,dataAsOf:S.strategyResult.dataAsOf||null};
  }
  if(activeFund?.fundCode)context.selectedFund={code:activeFund.fundCode,name:activeFund.fundName||''};
  return context;
}

function onDesktopEvent(event){
  const {method,params}=event;
  if(params?.threadId&&params.threadId!==D.current?.threadId)return;
  if(method==='turn/started'){D.running=true;}
  else if(method==='turn/completed'){D.running=false;D.pendingInput=null;window.fundDesktop.listSessions().then(desktopCall).then(rows=>{D.sessions=rows;D.current=rows.find(x=>x.threadId===D.current?.threadId)||D.current;renderAgentPanel();}).catch(()=>{});}
  else if(method==='item/tool/requestUserInput'){D.pendingInput=params;}
  else if(method==='item/tool/requestUserInput/resolved'){D.pendingInput=null;}
  else if(method==='item/agentMessage/delta'){
    let row=D.messages.find(x=>x.id===params.itemId);if(!row){row={id:params.itemId,role:'assistant',text:''};D.messages.push(row);}row.text+=params.delta||'';
  }else if(method==='item/reasoning/summaryTextDelta'){
    let row=D.messages.find(x=>x.id===params.itemId);if(!row){row={id:params.itemId,type:'reasoning',text:'',streaming:true};D.messages.push(row);}row.text+=params.delta||'';row.streaming=true;
  }else if(method==='item/completed'&&params.item?.type==='reasoning'){
    const text=reasoningText(params.item);let row=D.messages.find(x=>x.id===params.item.id);if(!row&&text){row={id:params.item.id,type:'reasoning',text};D.messages.push(row);}else if(row){row.text=text||row.text;row.streaming=false;}
  }else if(method==='turn/plan/updated'){
    const text=planText(params.plan);let row=D.messages.find(x=>x.type==='plan'&&x.turnId===params.turnId);if(!row){row={id:'plan-'+(params.turnId||Date.now()),turnId:params.turnId,type:'plan',text};D.messages.push(row);}else row.text=text;
  }else if(method==='item/started'&&params.item?.type==='mcpToolCall'){
    const row={id:params.item.id,type:'tool',tool:params.item.tool,status:params.item.status};D.messages.push(row);D.tools.set(row.id,row);
  }else if(method==='item/completed'&&params.item?.type==='mcpToolCall'){
    const row=D.tools.get(params.item.id);if(row)Object.assign(row,{status:params.item.status,error:params.item.error});
  }else if(method==='item/completed'&&params.item?.type==='agentMessage'){
    let row=D.messages.find(x=>x.id===params.item.id);if(isConnectionNotice(params.item.text)){D.messages=D.messages.filter(x=>x.id!==params.item.id);}else if(!row){row={id:params.item.id,role:'assistant',text:params.item.text||''};D.messages.push(row);}else row.text=params.item.text||row.text;
  }else if(method==='error'){const message=params.error?.message||params.message||'Agent 运行失败。';const last=D.messages.at(-1);if(last?.text!==message)D.messages.push({role:'assistant',text:message,error:true});}
  renderAgentPanel();
}

async function desktopSaveSubscription(){
  D.settings=await desktopCall(window.fundDesktop.saveProvider({mode:'subscription',model:D.settings?.subscriptionModel,effort:D.settings?.subscriptionEffort}));
  const connected=D.status?.account?.account?.type==='chatgpt';
  if(!connected)try{const login=await desktopCall(window.fundDesktop.startSubscriptionLogin());if(login.started)toast('已打开官方登录页面；完成后返回工作台。');}catch(e){toast(e.message);}
  D.status=await desktopCall(window.fundDesktop.getStatus());render();
}
async function desktopSaveProvider(data){D.settings=await desktopCall(window.fundDesktop.saveProvider({mode:'api',...data}));D.sessions=await desktopCall(window.fundDesktop.listSessions());toast('API Key 已由当前操作系统加密保存；新会话将使用该服务。');}
async function desktopSelectProvider(id){D.settings=await desktopCall(window.fundDesktop.saveProvider({mode:'api',selectId:id}));render();toast('已切换新会话使用的模型服务。');}
async function desktopTestProvider(target){target.disabled=true;toast('正在检测连接、流式响应和基金工具调用…');try{const r=await desktopCall(window.fundDesktop.testProvider());toast(r.connection&&r.textStream&&r.toolCall&&r.toolResult&&r.completed?'兼容性检测通过。':'检测未全部通过，请核对服务商的 Responses 工具能力。');}finally{target.disabled=false;}}

async function desktopInit(){
  document.body.classList.add('desktop-mode');D.initialized=true;placeAgentSurface();
  window.fundDesktop.onEvent(onDesktopEvent);
  window.fundDesktop.onBusinessChanged(async()=>{await reloadState();render();});
  window.fundDesktop.onNavigate(route=>navigate(route));
  $('#agent-toggle')?.addEventListener('click',openAgentPanel);$('#agent-close').addEventListener('click',closeAgentPanel);
  $('#agent-new').addEventListener('click',()=>desktopNewSession().catch(e=>toast(e.message)));
  $('#agent-session-button').addEventListener('click',()=>{$('#agent-sessions').hidden=!$('#agent-sessions').hidden;});
  $('#agent-sessions').addEventListener('click',e=>{const b=e.target.closest('[data-agent-session]');if(b)desktopResume(b.dataset.agentSession).catch(err=>toast(err.message));});
  $('#agent-archive').addEventListener('click',async()=>{if(!D.current)return;try{D.sessions=await desktopCall(window.fundDesktop.archiveSession(D.current.threadId));D.current=null;D.messages=[];D.pendingInput=null;if(S.route==='home')render();else renderAgentPanel();}catch(e){toast(e.message);}});
  $('#agent-stop').addEventListener('click',()=>window.fundDesktop.interrupt().then(desktopCall).catch(e=>toast(e.message)));
  $('#agent-question').addEventListener('submit',async e=>{
    if(e.target.id!=='agent-question-form')return;e.preventDefault();
    const request=D.pendingInput;if(!request)return;const form=new FormData(e.target),answers={};
    for(const [index,question] of (request.questions||[]).entries()){
      let value=String(form.get(`agent-answer-${index}`)||'').trim();
      if(value==='__other__')value=String(form.get(`agent-other-${index}`)||'').trim();
      if(!value){toast('请回答全部问题。');return;}
      answers[question.id]={answers:[value]};
    }
    const submit=e.target.querySelector('button');submit.disabled=true;
    try{await desktopCall(window.fundDesktop.answerUserInput({requestId:request.requestId,answers}));D.pendingInput=null;renderAgentPanel();}
    catch(error){toast(error.message);submit.disabled=false;}
  });
  $('#agent-form').addEventListener('submit',async e=>{e.preventDefault();const text=$('#agent-input').value.trim();if(!text||D.running)return;try{if(!D.current)await desktopNewSession();const authorized=D.current.dataAuthorized||$('#agent-data-consent').checked;D.messages.push({id:'local-'+Date.now(),role:'user',text});D.running=true;if(S.route==='home')render();else renderAgentPanel();await desktopCall(window.fundDesktop.sendMessage({threadId:D.current.threadId,text,authorizeAccountData:authorized,pageContext:currentAgentPageContext()}));D.current.dataAuthorized=authorized;$('#agent-input').value='';}catch(err){D.running=false;D.messages.push({role:'assistant',text:err.message,error:true});if(S.route==='home')render();else renderAgentPanel();}});
  $('#agent-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#agent-form').requestSubmit();}});
  D.settings=await desktopCall(window.fundDesktop.getSettings());D.sessions=await desktopCall(window.fundDesktop.listSessions());
  try{D.status=await desktopCall(window.fundDesktop.getStatus());}catch(e){D.status={error:e.message};}
  if(D.sessions.length)await desktopResume(D.sessions[0].threadId);else renderAgentPanel();
}

document.addEventListener('click',e=>{const target=e.target.closest('[data-action="desktop-select-provider"]');if(target)desktopSelectProvider(target.dataset.id).catch(err=>toast(err.message));});
document.addEventListener('change',e=>{
  if(e.target.id==='desktop-subscription-model'){
    const model=subscriptionModelRows().find(row=>row.id===e.target.value);
    D.subscriptionDraftModel=e.target.value;
    D.subscriptionDraftEffort=model?.defaultReasoningEffort||modelEfforts(model)[0]||'medium';
    render();
  }else if(e.target.id==='desktop-subscription-effort'){
    D.subscriptionDraftEffort=e.target.value;
  }
});
async function boot(){
  try{const b=await api('/api/bootstrap');Object.assign(S,{csrf:b.csrf,state:b.state,templates:b.templates,strategyCatalog:b.strategyCatalog||[],strategyPlans:b.state.strategyPlans||[],strategyEvents:b.state.strategyEvents||[],strategyRuns:b.state.strategyRuns||[],ai:b.ai,modelMode:b.ai.mode,sdkVersion:b.sdkVersion});startStrategyMonitor();if(D.enabled)await desktopInit();routeChanged();loadHoldings();checkStrategyPlansOnStartup();}
  catch(e){$('#content').innerHTML=head('LOCAL WORKSPACE','启动本地工作台','真实数据接入需要本机服务。')+`<div class="card">${empty('请先启动服务',esc(e.message)+'<br>运行 npm run start:web，然后访问 http://127.0.0.1:8765。')}</div>`;if($('#sync-status'))$('#sync-status').textContent='本地服务未连接';}
}
window.addEventListener('hashchange',routeChanged);
boot();
