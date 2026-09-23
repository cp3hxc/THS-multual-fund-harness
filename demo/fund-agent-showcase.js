'use strict';

const STORAGE_KEY = 'fund-agent-four-prototypes:v3';

const OFFICIAL_FUNCTIONS = [
  { id: 'holding', icon: '▤', name: '持仓体检与下一步', short: '把持仓集中度、费用与风险变成一条本月可执行的建议。' },
  { id: 'cash', icon: '▦', name: '三个月资金安排', short: '结合月预算、现有仓位和用款灵活性，形成资金计划。' }
];

const PROTOTYPES = [
  { id: 'brief', no: '01', name: '体检结果', tag: '一页持仓体检', note: '适合想先知道本月要不要处理持仓的用户。' },
  { id: 'dialogue', no: '02', name: 'AI 问诊', tag: '连续问题与建议', note: '适合想通过一两轮对话说清个人限制的用户。' },
  { id: 'scenario', no: '03', name: '资金试算', tag: '三个月计划对比', note: '适合在投入比例与波动之间选择的用户。' },
  { id: 'notebook', no: '04', name: '投资决定单', tag: '保存选择与复核', note: '适合把今天的结论沉淀为下次可继续的计划。' }
];

const DEFAULT_STATE = {
  prototype: 'brief',
  view: 'home',
  activeFunction: null,
  stage: 'start',
  preference: 'stable',
  budget: 2000,
  scenario: 'protect',
  bookChoice: null,
  bookNote: '',
  lastQuestion: '',
  lastInteraction: '',
  savedFunctions: [],
  history: [],
  recorded: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `¥${Math.round(Number(value || 0)).toLocaleString('zh-CN')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const nowLabel = () => new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...clone(DEFAULT_STATE), savedFunctions: saved.savedFunctions || [], history: saved.history || [] };
  } catch {
    return clone(DEFAULT_STATE);
  }
}

let state = loadState();
let toastTimer;

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedFunctions: state.savedFunctions, history: state.history }));
}

function prototype() { return PROTOTYPES.find(item => item.id === state.prototype) || PROTOTYPES[0]; }
function currentFunction() { return OFFICIAL_FUNCTIONS.find(item => item.id === state.activeFunction) || OFFICIAL_FUNCTIONS[0]; }
function preferenceName(value = state.preference) {
  return value === 'return' ? '长期收益' : value === 'simple' ? '尽量少操作' : '少亏一点';
}
function closeSidebar() { $('#sidebar').classList.remove('is-open'); }
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('is-visible'), 2400);
}

function taskInfo() {
  if (state.activeFunction === 'cash') {
    return {
      name: '三个月资金安排',
      context: '账户快照（演示） · 3 只持仓 · 权益类占比 80% · 近三年净值口径已同步。',
      briefQuestion: '这笔新增资金，你更在意什么？',
      dialogueQuestion: '你每月计划投入多少？',
      bookQuestion: '未来三个月的新增资金，是先控制回撤，还是尽量提高参与度？'
    };
  }
  return {
    name: '持仓体检与下一步',
    context: '账户快照（演示） · 稳健成长混合占比 48% · 风险暴露、持有成本与费用口径已同步。',
    briefQuestion: '本月这只基金，你希望先解决什么？',
    dialogueQuestion: '面对这只基金，你最担心的是哪件事？',
    bookQuestion: '这只基金本月是继续投、暂停追加，还是先保留资金？'
  };
}

function outcome(preference = state.preference) {
  const isCash = state.activeFunction === 'cash';
  if (isCash) {
    if (preference === 'return') return {
      label: '收益优先的资金安排',
      title: `每月${money(state.budget)}：先投入 90%，保留 10%`,
      action: `第 1 个月投入 ${money(state.budget * .9)}；第 2、3 个月在组合权益权重不超过 85% 时投入全额。`,
      reason: ['组合已有较高权益仓位，仍保留少量资金处理突发波动。', '演示历史中，较高参与度带来更多上涨参与，但回撤扩大约 1.2 个百分点。', '只在月末检查一次，避免因为短期波动频繁调整。'],
      metric: { return: '+11.8%', drawdown: '-12.0%', effort: '6 次／年' }
    };
    if (preference === 'simple') return {
      label: '低操作频率安排',
      title: `每月${money(state.budget)}固定投入，月末只复核一次`,
      action: '每月固定日期投入；只有权益类权重超过 85% 或未来半年有用款计划时才暂停。',
      reason: ['把判断条件提前写清，减少临时决策。', '固定节奏不会错过长期参与，也不需要跟踪日内波动。', '演示费用与投入频率保持在可控范围。'],
      metric: { return: '+10.5%', drawdown: '-12.4%', effort: '12 次／年' }
    };
    return {
      label: '优先控制波动',
      title: `每月${money(state.budget)}：先投入 75%，保留 25%`,
      action: `本月投入 ${money(state.budget * .75)}，保留 ${money(state.budget * .25)}；下月趋势稳定时再投入全额。`,
      reason: ['当前权益类占比 80%，新增资金不宜继续全额放大同一类风险。', '保留一部分资金能降低演示历史中的最大阶段亏损。', '方案只需要三次月度判断，普通用户能完成。'],
      metric: { return: '+11.3%', drawdown: '-10.8%', effort: '4 次／年' }
    };
  }
  if (preference === 'return') return {
    label: '长期参与优先',
    title: '继续持有，每月最多小额追加 1,000 元',
    action: '本月不赎回；新增资金不超过 1,000 元，其余资金留待下月复核趋势与组合权重。',
    reason: ['基金仍有长期参与价值，但 48% 的权重已是组合主要波动来源。', '小额分批能保留上涨参与，避免一次性进一步集中。', '演示短期赎回成本较高，没有直接卖出的充分理由。'],
    metric: { return: '+10.9%', drawdown: '-12.2%', effort: '12 次／年' }
  };
  if (preference === 'simple') return {
    label: '低操作频率处理',
    title: '继续持有，每月只检查一次，暂不频繁加减仓',
    action: '固定每月最后一个交易日复核；只有这只基金权重超过 50% 或趋势明显转弱时才调整。',
    reason: ['当前没有必须马上处理的账户状态。', '频繁调整在演示历史中没有明显改善结果。', '把重新判断条件写清后，用户不必每天跟盘。'],
    metric: { return: '+10.2%', drawdown: '-11.9%', effort: '12 次／年' }
  };
  return {
    label: '优先控制集中风险',
    title: '继续持有，未来三个月暂停给这只基金追加资金',
    action: '本月不赎回；原计划的新增资金暂时保留或转向组合中风险相关性更低的部分。',
    reason: ['这只基金占组合 48%，继续追加会提高单一方向的集中度。', '它与另一只权益基金存在风险暴露重合，新增投入的分散价值有限。', '演示持有期下赎回成本偏高，不能因为短期波动直接给出卖出结论。'],
    metric: { return: '+10.4%', drawdown: '-10.8%', effort: '4 次／年' }
  };
}

function scenarioOptions() {
  if (state.activeFunction === 'cash') return [
    { id: 'protect', label: '稳健安排', detail: '投入 75%，保留 25% 备用', preference: 'stable', score: 74, risk: 38 },
    { id: 'balanced', label: '提高参与', detail: '投入 90%，保留一次复核', preference: 'return', score: 83, risk: 56 },
    { id: 'allin', label: '固定全投', detail: '每月固定全额投入', preference: 'simple', score: 88, risk: 72 }
  ];
  return [
    { id: 'protect', label: '暂停追加', detail: '持有现有份额，新增资金保留', preference: 'stable', score: 70, risk: 34 },
    { id: 'balanced', label: '小额追加', detail: '每月最多追加 1,000 元', preference: 'return', score: 81, risk: 54 },
    { id: 'allin', label: '维持原计划', detail: '每月继续追加 2,000 元', preference: 'simple', score: 87, risk: 74 }
  ];
}

function scenarioOutcome() {
  const option = scenarioOptions().find(item => item.id === state.scenario) || scenarioOptions()[0];
  const result = outcome(option.preference);
  if (state.scenario === 'allin') {
    result.title = state.activeFunction === 'cash' ? `每月${money(state.budget)}全部投入，取消备用资金` : '继续持有，并按原计划每月追加 2,000 元';
    result.action = state.activeFunction === 'cash' ? '三个月均按固定日期全额投入；月底只检查组合权重。' : '维持当前持有，并在固定日期继续投入；当权重超过 50% 才重新评估。';
    result.metric = { return: '+11.0%', drawdown: '-12.8%', effort: '12 次／年' };
  }
  return { option, result };
}

function scenarioPlanMetrics() {
  if (state.activeFunction === 'cash') {
    const monthly = state.scenario === 'protect' ? state.budget * .75 : state.scenario === 'balanced' ? state.budget * .9 : state.budget;
    const reserve = state.budget * 3 - (state.scenario === 'protect' ? state.budget * 2.5 : state.scenario === 'balanced' ? state.budget * 2.8 : state.budget * 3);
    return [
      ['三个月计划投入', money(monthly + state.budget + monthly)],
      ['保留可用现金', money(reserve)],
      ['近三年模拟回撤', scenarioOutcome().result.metric.drawdown]
    ];
  }
  const monthly = state.scenario === 'protect' ? 0 : state.scenario === 'balanced' ? 1000 : 2000;
  return [
    ['本月新增投入', money(monthly)],
    ['持仓处理', '继续持有，不赎回'],
    ['近三年模拟回撤', scenarioOutcome().result.metric.drawdown]
  ];
}

function renderPrototypeBar() {
  return `<section class="prototype-bar" aria-label="四套交互原型"><div><span>交互原型</span><strong>${prototype().no} · ${prototype().name}</strong></div><div class="prototype-tabs">${PROTOTYPES.map(item => `<button class="prototype-tab${item.id === state.prototype ? ' is-active' : ''}" data-action="switch-prototype" data-prototype="${item.id}"><b>${item.no}</b>${item.name}</button>`).join('')}</div></section>`;
}

function topContext() {
  const text = state.activeFunction ? `正在体验 ${prototype().name} · ${currentFunction().name}` : `当前原型：${prototype().tag}`;
  return `<span class="context-chip"><i></i>${text}</span>`;
}

function sidebarItem(item, type) {
  if (type === 'official') {
    const active = state.activeFunction === item.id;
    return `<button class="function-nav${active ? ' is-active' : ''}" data-action="open-function" data-function-id="${item.id}"><span class="nav-icon">${item.icon}</span><span><strong>${item.name}<em>官方</em></strong><small>${item.short}</small></span></button>`;
  }
  const config = item.config;
  const prototypeLabel = PROTOTYPES.find(entry => entry.id === config.prototype)?.name || '体检结果';
  return `<button class="function-nav" data-action="load-${type}" data-item-id="${item.id}"><span class="nav-icon">${type === 'saved' ? '☆' : '↺'}</span><span><strong>${esc(item.name || item.title)}</strong><small>${prototypeLabel} · ${esc(item.createdAt)}</small></span></button>`;
}

function renderSidebar() {
  const saved = state.savedFunctions.length ? state.savedFunctions.map(item => sidebarItem(item, 'saved')).join('') : '<p class="sidebar-empty">完成一次方案后，可以把满意的做法保存到这里。</p>';
  const history = state.history.length ? state.history.slice(0, 5).map(item => sidebarItem(item, 'history')).join('') : '<p class="sidebar-empty">完成过的任务会保留在这里，方便继续追问。</p>';
  $('#sidebar-content').innerHTML = `
    <button class="new-task-button" data-action="new-task"><span>＋</span>新建问题</button>
    <section class="sidebar-group"><div class="sidebar-heading"><span>官方功能</span><span>从账户问题直接开始</span></div>${OFFICIAL_FUNCTIONS.map(item => sidebarItem(item, 'official')).join('')}</section>
    <section class="sidebar-group"><div class="sidebar-heading"><span>我的功能</span><span>${state.savedFunctions.length || ''}</span></div>${saved}</section>
    <section class="sidebar-group"><div class="sidebar-heading"><span>历史任务</span><span>${state.history.length || ''}</span></div>${history}</section>
    <div class="sidebar-info"><strong>工作台边界</strong>Agent 可以分析、生成计划和保存复核待办；真实申购、赎回和支付仍需用户在同花顺 App 完成。<small>固定演示数据 · 不读取真实账户 · 不发起交易 · 不代表真实收益</small></div>`;
}

function renderHome() {
  const intro = {
    brief: ['先看本月建议，再决定是否深入', '适合用户打开工作台后，快速确认“要不要动”“下月看什么”和“这条建议基于哪些账户事实”。'],
    dialogue: ['把个人限制聊清，再生成建议', 'Agent 已带入持仓快照，只补问会影响结论的信息，例如预算、用款时间和风险优先级。'],
    scenario: ['把每月预算换成看得见的三个月计划', '不展示复杂策略参数。用户只需选择投入意愿，就能看到计划投入、现金缓冲和历史演示风险的变化。'],
    notebook: ['把今天的判断存成一张投资决定单', '用户选择候选方案、写下原因并生成复核节点；下次回来时能先看到自己当时为什么这样做。']
  }[state.prototype];
  return `<div class="prototype-view mode-${state.prototype}"><section class="hero prototype-hero"><div class="eyebrow">${prototype().tag}</div><h1>${intro[0]}</h1><p>${intro[1]}</p><div class="workspace-status"><span><i></i>账户快照：演示数据</span><span>数据日期 2026-09-18</span><span>不发起真实交易</span></div><form class="question-box" id="home-question-form"><textarea id="home-question" maxlength="500" placeholder="例如：我每月有 2,000 元，这只基金下个月还要继续追加吗？"></textarea><div class="question-box-foot"><span>也可以直接打开一个官方功能</span><button class="primary-button" type="submit">开始分析 ↑</button></div></form><div class="quick-prompts"><button data-action="ask-example" data-question="帮我做一次持仓体检，告诉我本月要不要处理。">做一次持仓体检</button><button data-action="ask-example" data-question="每月 2000 元，帮我做未来三个月资金安排。">生成三个月计划</button></div></section><section class="function-section"><div class="section-title"><h2>官方功能</h2><p>从账户问题出发，完成分析、行动建议和下次复核安排。</p></div><div class="function-grid">${OFFICIAL_FUNCTIONS.map(item => `<button class="function-card" data-action="open-function" data-function-id="${item.id}"><span class="function-card-icon">${item.icon}</span><strong>${item.name}</strong><p>${item.short}</p><footer><span>官方功能 v1.0</span><span>打开 →</span></footer></button>`).join('')}</div></section><p class="demo-disclaimer">本页面仅使用固定演示数据，不读取真实账户、不发起交易，模拟结果不代表真实收益。</p></div>`;
}

function taskHeader() {
  const info = taskInfo();
  return `<header class="task-head"><div><div class="eyebrow">官方功能 v1.0</div><h1>${info.name}</h1><p>${info.context}</p></div><span class="mode-label">${prototype().tag}</span></header>`;
}

function snapshotStrip() {
  const items = state.activeFunction === 'cash'
    ? [['当前权益仓位','80%'],['本月可安排资金',money(state.budget)],['历史数据口径','近 3 年演示']]
    : [['持仓基金','稳健成长混合'],['组合权重','48%'],['当前处理限制','短期赎回成本偏高']];
  return `<section class="snapshot-strip"><div class="snapshot-title"><span class="dot green"></span><strong>已读取的账户信息</strong><small>演示快照 · 仅用于本次分析</small></div><div class="snapshot-items">${items.map(item => `<div><small>${item[0]}</small><strong>${item[1]}</strong></div>`).join('')}</div></section>`;
}

function taskTodo() {
  return `<section class="task-todo"><div><span>下一步</span><strong>${state.activeFunction === 'cash' ? '把这份三个月计划加入下月复核' : '把这只基金的复核条件加入待办'}</strong><p>仅创建本地待办，不会发起申购、赎回或扣款。</p></div><button class="secondary-button" data-action="create-todo">${state.lastInteraction === 'todo' ? '已加入演示待办' : '加入下月复核'}</button></section>`;
}

function preferenceChoices(action = 'brief-preference') {
  return `<div class="choice-row"><button class="choice-chip" data-action="${action}" data-preference="stable">优先控制回撤</button><button class="choice-chip" data-action="${action}" data-preference="return">更多参与长期收益</button><button class="choice-chip" data-action="${action}" data-preference="simple">按固定节奏，少操作</button></div>`;
}

function budgetChoices(action = 'brief-budget') {
  return `<div class="choice-row"><button class="choice-chip" data-action="${action}" data-budget="1000">1,000 元／月</button><button class="choice-chip" data-action="${action}" data-budget="2000">2,000 元／月</button><button class="choice-chip" data-action="${action}" data-budget="3000">3,000 元／月</button></div>`;
}

function metrics(result) {
  return `<div class="metric-row"><div><small>近三年模拟收益</small><strong>${result.metric.return}</strong></div><div><small>最大阶段亏损</small><strong>${result.metric.drawdown}</strong></div><div><small>年均复核次数</small><strong>${result.metric.effort}</strong></div></div>`;
}

function standardAnswer(className = '') {
  const result = outcome();
  return `<section class="outcome-card ${className}"><div class="outcome-top"><span>本月建议 · ${result.label}</span><h2>${result.title}</h2><p>${result.action}</p></div>${metrics(result)}<div class="reason-block"><h3>这条建议考虑了什么</h3><ol>${result.reason.map((item, index) => `<li><b>${index + 1}</b><span>${item}</span></li>`).join('')}</ol></div><div class="result-boundary">历史指标为当前权重下的演示模拟，不是账户实际收益，也不构成收益承诺。</div></section>`;
}

function renderBriefTask() {
  const info = taskInfo();
  if (state.stage === 'start') {
    const choices = state.activeFunction === 'cash' ? budgetChoices() : preferenceChoices();
    return `<div class="prototype-view mode-brief task-view">${taskHeader()}${snapshotStrip()}<section class="brief-question"><span>✦ 基金 Agent</span><h2>${info.briefQuestion}</h2><p>其余持仓、费用和风险口径已经带入。本次只补问一个会影响行动建议的问题。</p>${choices}</section></div>`;
  }
  return `<div class="prototype-view mode-brief task-view">${taskHeader()}${snapshotStrip()}${standardAnswer('brief-answer')}<div class="brief-actions"><button class="secondary-button" data-action="brief-stable">改成更稳的版本</button><button class="secondary-button" data-action="brief-compare">查看同口径比较</button><button class="quiet-button" data-action="toggle-evidence">${state.lastInteraction === 'evidence' ? '收起分析依据' : '查看分析依据'}</button><button class="primary-button" data-action="open-save">保存为我的功能</button></div>${taskTodo()}${state.lastInteraction === 'compare' ? comparisonTable() : ''}${state.lastInteraction === 'evidence' ? evidenceStrip() : ''}</div>`;
}

function comparisonTable() {
  const result = outcome();
  return `<section class="comparison"><h3>同一预算、同一演示区间下的差别</h3><table><thead><tr><th>近三年演示口径</th><th>普通定投</th><th>当前做法</th></tr></thead><tbody><tr><td>期末资产</td><td>¥78,400</td><td><strong>${state.activeFunction === 'cash' ? '¥80,100' : '¥76,400'}</strong></td></tr><tr><td>最大阶段亏损</td><td>-12.8%</td><td><strong>${result.metric.drawdown}</strong></td></tr><tr><td>年均需判断</td><td>12 次</td><td><strong>${result.metric.effort}</strong></td></tr></tbody></table></section>`;
}

function evidenceStrip() {
  return `<section class="evidence-strip"><div><small>组合集中度</small><strong>48% 单一基金权重</strong><p>是当前首先影响新增资金安排的因素。</p></div><div><small>风险暴露</small><strong>权益风险部分重合</strong><p>继续追加的分散价值有限。</p></div><div><small>交易约束</small><strong>短期赎回成本偏高</strong><p>不足以支持直接卖出的建议。</p></div></section>`;
}

function chatBubble(who, content, kind = '') { return `<div class="chat-line ${who} ${kind}"><span class="chat-avatar">${who === 'agent' ? '✦' : '我'}</span><div class="chat-bubble">${content}</div></div>`; }

function renderDialogueTask() {
  const info = taskInfo();
  const ask = state.activeFunction === 'cash' ? budgetChoices('dialogue-budget') : preferenceChoices('dialogue-preference');
  let transcript = `${chatBubble('agent', `<strong>我已经带入了本次账户快照、风险口径和费用限制。</strong><br>${info.dialogueQuestion}`)}<div class="chat-choices">${ask}</div>`;
  if (state.stage === 'result') {
    const userAnswer = state.activeFunction === 'cash' ? `每月大约 ${money(state.budget)}` : `我想优先 ${preferenceName()}`;
    const result = outcome();
    transcript += `${chatBubble('user', esc(userAnswer))}${chatBubble('agent', `<span class="chat-kicker">本月可执行建议</span><h2>${result.title}</h2><p>${result.action}</p><ul>${result.reason.slice(0, 2).map(item => `<li>${item}</li>`).join('')}</ul><small class="chat-scope">依据为演示账户快照与历史模拟；不会直接执行交易。</small>`, 'answer')}`;
    if (state.lastInteraction === 'safer') transcript += chatBubble('agent', '我已把方案改成“少亏一点”优先，并保留了当前持仓不动。', 'update');
    transcript += `<div class="chat-follow"><button data-action="dialogue-safer">我希望回撤更小</button><button data-action="dialogue-why">为什么不建议马上卖？</button><button class="primary-button" data-action="open-save">保存为我的功能</button></div>${state.lastInteraction === 'why' ? chatBubble('agent', '因为演示持有期下的赎回成本仍然较高，而且当前问题是新增资金的集中风险，并不是已有份额必须立刻处理。', 'update') : ''}`;
  }
  return `<div class="prototype-view mode-dialogue task-view">${taskHeader()}${snapshotStrip()}<section class="dialogue-shell"><div class="chat-day">本次会话 · 已读取账户快照</div>${transcript}</section>${state.stage === 'result' ? taskTodo() : ''}</div>`;
}

function renderScenarioTask() {
  const { option, result } = scenarioOutcome();
  const planMetrics = scenarioPlanMetrics();
  return `<div class="prototype-view mode-scenario task-view">${taskHeader()}${snapshotStrip()}<section class="scenario-shell"><div class="scenario-intro"><div><span>选择资金安排方式</span><h2>${state.activeFunction === 'cash' ? '未来三个月，这笔钱你准备怎么安排？' : '本月要不要继续给这只基金追加资金？'}</h2></div><p>每个选项都是可执行的资金安排，不需要先理解策略参数。</p></div><div class="scenario-options">${scenarioOptions().map(item => `<button class="scenario-option${item.id === state.scenario ? ' is-selected' : ''}" data-action="scenario-select" data-scenario="${item.id}"><span>${item.id === 'protect' ? '◒' : item.id === 'balanced' ? '◐' : '●'}</span><strong>${item.label}</strong><small>${item.detail}</small></button>`).join('')}</div><section class="scenario-result"><div class="scenario-result-head"><div><span>当前方案 · ${option.label}</span><h2>${result.title}</h2><p>${result.action}</p></div><button class="primary-button" data-action="open-save">保存为我的功能</button></div><div class="scenario-meters">${planMetrics.map(item => `<div><small>${item[0]}</small><strong>${item[1]}</strong><p>${item[0].includes('回撤') ? '当前权重下的历史模拟结果。' : item[0].includes('现金') ? '不代表钱包余额，作为计划缓冲记录。' : '生成计划后可继续调整。'}</p></div>`).join('')}</div><div class="scenario-tradeoff"><strong>选择这个方案的好处</strong><span>${result.reason[0]}</span><strong>需要接受的代价</strong><span>${option.id === 'protect' ? '市场快速上涨时，一部分资金不会立刻参与。' : option.id === 'balanced' ? '仍会面对权益类集中带来的短期波动。' : '没有现金缓冲，遇到回撤只能继续承受。'}</span></div></section></section>${taskTodo()}</div>`;
}

function notebookProposals() {
  const cash = state.activeFunction === 'cash';
  return cash ? [
    { id: 'protect', title: '方案 A：保留 25% 备用', detail: `每月先投入 ${money(state.budget * .75)}，趋势稳定时再提高投入。`, tag: '把减少亏损放在第一位' },
    { id: 'balanced', title: '方案 B：投入 90%，保留一次复核', detail: `每月先投入 ${money(state.budget * .9)}，月底根据组合权重复核。`, tag: '更多参与，也接受更多波动' }
  ] : [
    { id: 'protect', title: '方案 A：继续持有，暂停追加', detail: '现有份额不处理，新增资金先留在组合外。', tag: '先降低集中风险' },
    { id: 'balanced', title: '方案 B：继续持有，小额追加', detail: '每月最多追加 1,000 元，权重超过 50% 时暂停。', tag: '保留长期参与机会' }
  ];
}

function notebookFacts() {
  return state.activeFunction === 'cash'
    ? [['每月预算', money(state.budget), '用户本次填写的新增资金'], ['权益类占比', '80%', '新增资金会继续影响组合波动'], ['计划时间', '3 个月', '每月月末可重新复核']]
    : [['组合权重', '48%', '稳健成长混合当前占比'], ['历史回撤', '-12.8%', '近三年演示最大阶段亏损'], ['费用限制', '短期偏高', '不建议因短期波动直接赎回']];
}

function renderNotebookTask() {
  const info = taskInfo();
  const selected = notebookProposals().find(item => item.id === state.bookChoice);
  const done = state.stage === 'done';
  return `<div class="prototype-view mode-notebook task-view">${taskHeader()}${snapshotStrip()}<section class="notebook"><div class="notebook-spine"><span class="is-done">1</span><i></i><span class="is-done">2</span><i></i><span class="${state.bookChoice ? 'is-done' : ''}">3</span><i></i><span class="${done ? 'is-done' : ''}">4</span></div><div class="notebook-page"><section class="book-section"><span>01 · 本次要做的投资决定</span><h2>${info.bookQuestion}</h2><p>先把账户事实和个人限制写清，再选择方案；页面不会替你发起交易。</p></section><section class="book-section facts"><span>02 · Agent 已确认的账户事实</span>${notebookFacts().map(item => `<div><b>${item[1]}</b><strong>${item[0]}</strong><p>${item[2]}</p></div>`).join('')}</section><section class="book-section"><span>03 · 选择一条可以执行的计划</span><div class="proposal-grid">${notebookProposals().map(item => `<button class="proposal${item.id === state.bookChoice ? ' is-selected' : ''}" data-action="book-select" data-choice="${item.id}"><small>${item.tag}</small><strong>${item.title}</strong><p>${item.detail}</p><em>${item.id === state.bookChoice ? '已选择' : '选择这个计划'}</em></button>`).join('')}</div></section>${selected ? `<section class="book-section decision-note"><span>04 · 记录原因和下次复核</span><h3>${selected.title}</h3><p>${selected.detail}</p>${done ? `<div class="saved-note"><strong>我的选择原因</strong><p>${esc(state.bookNote || '我希望先控制集中风险，再参与后续机会。')}</p><small>复核节点：下月最后一个交易日；触发条件：基金权重超过 50% 或未来半年有用款计划。</small><div class="saved-note-actions"><button class="quiet-button" data-action="create-todo">${state.lastInteraction === 'todo' ? '已加入演示待办' : '加入下月复核'}</button><button class="primary-button" data-action="open-save">另存为我的功能</button></div></div>` : `<div class="note-entry"><textarea id="book-note" maxlength="120" placeholder="例如：我未来半年有用款计划，所以先保留一部分资金。">${esc(state.bookNote)}</textarea><button class="primary-button" data-action="book-confirm">确认并保存这次决定</button></div>`}</section>` : '<section class="book-placeholder">先选择一个候选计划，Agent 才会生成复核条件和可回看的决定记录。</section>'}</div></section></div>`;
}

function render() {
  $('#top-context').innerHTML = topContext();
  renderSidebar();
  const view = state.view === 'home' ? renderHome() : state.prototype === 'brief' ? renderBriefTask() : state.prototype === 'dialogue' ? renderDialogueTask() : state.prototype === 'scenario' ? renderScenarioTask() : renderNotebookTask();
  $('#workspace-content').innerHTML = `${renderPrototypeBar()}${view}`;
  $('#composer-input').placeholder = state.activeFunction ? '继续说：我希望更稳一点 / 每月改成 3,000 元' : '直接问：这只基金还要继续投吗？';
}

function resetTask() {
  state.activeFunction = null;
  state.view = 'home';
  state.stage = 'start';
  state.preference = 'stable';
  state.budget = 2000;
  state.scenario = 'protect';
  state.bookChoice = null;
  state.bookNote = '';
  state.lastQuestion = '';
  state.lastInteraction = '';
  state.recorded = false;
}

function openPrototype(id) {
  state.prototype = id;
  resetTask();
  closeSidebar();
  render();
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

function openFunction(id, config = null) {
  state.view = 'task';
  state.activeFunction = id;
  state.stage = config?.stage || (state.prototype === 'scenario' ? 'result' : 'start');
  state.preference = config?.preference || 'stable';
  state.budget = Number(config?.budget || 2000);
  state.scenario = config?.scenario || 'protect';
  state.bookChoice = config?.bookChoice || null;
  state.bookNote = config?.bookNote || '';
  state.lastQuestion = config?.lastQuestion || state.lastQuestion;
  state.lastInteraction = '';
  state.recorded = Boolean(config?.recorded);
  if (state.prototype === 'notebook' && config?.bookChoice) state.stage = config.stage || 'done';
  closeSidebar();
  render();
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

function recordHistory() {
  if (state.recorded) return;
  state.recorded = true;
  state.history = [{
    id: `history-${Date.now()}`,
    title: currentFunction().name,
    createdAt: nowLabel(),
    config: currentConfig()
  }, ...state.history.filter(item => !(item.config.functionId === state.activeFunction && item.config.prototype === state.prototype))].slice(0, 8);
  persist();
}

function currentConfig() {
  return { prototype: state.prototype, functionId: state.activeFunction, stage: state.stage, preference: state.preference, budget: state.budget, scenario: state.scenario, bookChoice: state.bookChoice, bookNote: state.bookNote, lastQuestion: state.lastQuestion, recorded: true };
}

function completePreference(value) {
  state.preference = value;
  state.stage = 'result';
  state.lastInteraction = '';
  recordHistory();
  render();
}

function completeBudget(value) {
  state.budget = Math.max(500, Number(value) || 2000);
  state.stage = 'result';
  state.lastInteraction = '';
  recordHistory();
  render();
}

function handleQuestion(value) {
  const question = value.trim();
  if (!question) return;
  const budget = question.match(/(\d{3,6})\s*元?/);
  if (!state.activeFunction) {
    const id = /预算|资金|三个月|定投|每月|怎么投/.test(question) ? 'cash' : 'holding';
    state.lastQuestion = question;
    openFunction(id);
    if (state.prototype === 'brief' || state.prototype === 'dialogue') {
      if (id === 'cash' && budget) completeBudget(budget[1]);
      if (id === 'holding' && /稳|少亏|回撤/.test(question)) completePreference('stable');
    }
    return;
  }
  if (budget && state.activeFunction === 'cash') {
    state.budget = Math.max(500, Number(budget[1]));
    state.stage = state.prototype === 'notebook' ? state.stage : 'result';
  }
  if (/稳|少亏|回撤/.test(question)) state.preference = 'stable';
  if (/收益|多投|参与/.test(question)) state.preference = 'return';
  if (/全部|全投|不留/.test(question)) state.scenario = 'allin';
  state.lastQuestion = question;
  state.lastInteraction = state.prototype === 'dialogue' ? 'safer' : '';
  if (state.prototype !== 'notebook') { state.stage = 'result'; recordHistory(); }
  render();
}

function openSaveDialog() {
  const fn = currentFunction();
  $('#save-name').value = `${prototype().name} · ${fn.name}`;
  $('#save-preview').innerHTML = `官方功能：${fn.name} · 官方 v1.0<br>交互形式：${prototype().tag}<br>${state.activeFunction === 'cash' ? `默认月预算：${money(state.budget)}` : `优先目标：${preferenceName()}`}`;
  $('#save-dialog').showModal();
  setTimeout(() => $('#save-name').focus(), 20);
}

function saveCurrent(name) {
  state.savedFunctions = [{ id: `saved-${Date.now()}`, name, createdAt: nowLabel(), config: currentConfig() }, ...state.savedFunctions.filter(item => item.name !== name)].slice(0, 8);
  persist();
  toast(`已保存「${name}」`);
  render();
}

function loadItem(type, id) {
  const item = (type === 'saved' ? state.savedFunctions : state.history).find(entry => entry.id === id);
  if (!item) return;
  state.prototype = item.config.prototype || 'brief';
  state.lastQuestion = '';
  openFunction(item.config.functionId, item.config);
  toast(type === 'saved' ? `已加载「${item.name}」` : '已恢复历史任务');
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'toggle-sidebar') return $('#sidebar').classList.toggle('is-open');
  if (action === 'switch-prototype') return openPrototype(target.dataset.prototype);
  if (action === 'new-task') { resetTask(); closeSidebar(); render(); requestAnimationFrame(() => window.scrollTo(0, 0)); return; }
  if (action === 'open-function') { state.lastQuestion = ''; openFunction(target.dataset.functionId); return; }
  if (action === 'ask-example') return handleQuestion(target.dataset.question || '');
  if (action === 'brief-preference' || action === 'dialogue-preference') return completePreference(target.dataset.preference);
  if (action === 'brief-budget' || action === 'dialogue-budget') return completeBudget(target.dataset.budget);
  if (action === 'brief-stable') { state.preference = 'stable'; state.lastInteraction = ''; render(); return; }
  if (action === 'brief-compare') { state.lastInteraction = 'compare'; render(); return; }
  if (action === 'toggle-evidence') { state.lastInteraction = state.lastInteraction === 'evidence' ? '' : 'evidence'; render(); return; }
  if (action === 'dialogue-safer') { state.preference = 'stable'; state.lastInteraction = 'safer'; render(); return; }
  if (action === 'dialogue-why') { state.lastInteraction = 'why'; render(); return; }
  if (action === 'create-todo') { state.lastInteraction = 'todo'; render(); toast('已加入演示复核待办，不会发起真实交易'); return; }
  if (action === 'scenario-select') { state.scenario = target.dataset.scenario; state.preference = scenarioOptions().find(item => item.id === state.scenario)?.preference || 'stable'; state.stage = 'result'; recordHistory(); render(); return; }
  if (action === 'book-select') { state.bookChoice = target.dataset.choice; state.stage = 'choice'; render(); return; }
  if (action === 'book-confirm') { state.bookNote = $('#book-note')?.value.trim() || '我希望先控制集中风险，再参与后续机会。'; state.stage = 'done'; recordHistory(); render(); return; }
  if (action === 'open-save') return openSaveDialog();
  if (action === 'load-saved') return loadItem('saved', target.dataset.itemId);
  if (action === 'load-history') return loadItem('history', target.dataset.itemId);
  if (action === 'reset-demo') { localStorage.removeItem(STORAGE_KEY); state = clone(DEFAULT_STATE); closeSidebar(); render(); toast('演示数据已恢复初始状态'); }
});

document.addEventListener('submit', event => {
  if (event.target.id === 'home-question-form' || event.target.id === 'composer-form') {
    event.preventDefault();
    const input = event.target.id === 'home-question-form' ? $('#home-question') : $('#composer-input');
    handleQuestion(input.value);
    input.value = '';
    return;
  }
  if (event.target.id === 'save-form') {
    event.preventDefault();
    const name = $('#save-name').value.trim();
    if (!name) return;
    saveCurrent(name);
    $('#save-dialog').close();
  }
});

window.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });

render();
