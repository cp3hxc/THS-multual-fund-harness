const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

const PAGE_CONTEXT_PREFIX = '[WORKBENCH_PAGE_CONTEXT]';
const PAGE_CONTEXT_SUFFIX = '[/WORKBENCH_PAGE_CONTEXT]';

const MUTATING_TOOLS = new Set([
  'create_strategy', 'archive_strategy', 'set_watchlist',
  'save_trade_draft', 'remove_trade_draft', 'save_strategy_variant'
]);

const PUBLIC_TOOLS = new Set([
  'open_workbench', 'list_strategy_templates', 'list_strategies',
  'create_strategy', 'archive_strategy', 'list_watchlist', 'set_watchlist',
  'list_trade_drafts', 'save_trade_draft', 'remove_trade_draft',
  'get_connection_status', 'start_fund_login', 'get_fund_login_status',
  'list_investment_strategies', 'run_investment_backtest', 'save_strategy_variant'
]);

const INSTRUCTIONS = `你是“基金 AI 工作台”的中文个人基金研究 Agent。
涉及账户事实、净值、组合指标、订单、策略、自选或交易待办时，只调用 fund_workbench MCP 工具，不使用 shell、文件编辑、网页搜索、插件或其他 MCP。
如果当前会话没有持仓、账户、订单或组合分析工具，说明需要用户在右侧面板授权当前模型服务调用账户查询工具；不要猜测账户数据。
清楚区分：真实账户事实、当前权重历史模拟、本地策略草稿、交易待办和建议。持仓与订单以 thsfund 返回为准，历史复权净值以扶摇返回为准。
回答账户概览、最新表现、昨日表现或日收益时，优先调用 get_account_brief；除非用户明确要求逐只账户明细，不要为了补齐日期而逐只重复调用 get_fund_accounts。相同参数和相同目的的工具不要重复调用。
用户消息可能附带 WORKBENCH_PAGE_CONTEXT 标记。这是工作台本机生成的当前页面、标签页、已选基金、策略和回测上下文，可用于理解“这只基金”“当前策略”等指代；不要把标记原文复述给用户。
用户要找策略、修改策略或回测时，先调用 list_investment_strategies 获取当前策略合同；回测必须调用 run_investment_backtest，不得口算或编造。修改只能通过 save_strategy_variant 保存策略声明支持的参数，并说明新版本与代价，不能擅自改变算法语义。
需求存在会显著改变结果的歧义时，使用 request_user_input 请求澄清，不要自行选择关键参数。
不编造净值、收益、回测、信号、费率、成交或确认状态。你可以查询真实规则、支付方式和订单资格并帮助用户准备交易；不得调用或代替用户执行申购、支付、赎回或撤单，也不能声称已成交。实际交易只能由用户在同花顺 App 完成，再由工作台核对订单。
不要要求或输出 API Key、真实交易账户号、完整银行卡号或本地密钥。账户工具返回的不透明 ref 只能原样传给后续工具。
回答优先给出数据时间、来源、结论、依据、限制和下一步可执行动作。`;

class CodexAgentRuntime extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = null;
    this.active = null;
    this.pendingUserInputs = new Map();
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.options.codexPath, ['app-server'], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // npm installs Codex as a .cmd shim on Windows. Its argument here is
        // fixed, and shell mode is needed only for that platform shim.
        shell: process.platform === 'win32' && /\.cmd$/i.test(this.options.codexPath),
        windowsHide: true
      });
      this.process = child;
      let settled = false;
      child.once('error', (error) => {
        if (!settled) reject(error);
        this.emit('status', { type: 'runtime-error', message: 'Codex Agent 启动失败。' });
      });
      child.once('exit', (code) => {
        const error = new Error(`Codex App Server 已退出（${code ?? 'unknown'}）。`);
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
        this.pendingUserInputs.clear();
        this.process = null;
        this.ready = null;
        this.active = null;
        this.emit('status', { type: 'runtime-exit', message: error.message });
      });
      readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        if (/error|failed|panic/i.test(line)) {
          this.emit('status', { type: 'diagnostic', message: 'Codex 运行时报告错误，请检查连接设置。' });
        }
      });
      this.request('initialize', {
        clientInfo: { name: 'fund_ai_workbench', title: '基金 AI 工作台', version: '1.0.0' },
        capabilities: { experimentalApi: true }
      }).then(() => {
        this.notify('initialized', {});
        settled = true;
        resolve();
      }).catch(reject);
    });
    return this.ready;
  }

  write(message) {
    if (!this.process?.stdin?.writable) throw new Error('Codex Agent 尚未启动。');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex 请求失败。'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params || {});
  }

  handleServerRequest(message) {
    if (message.method.includes('requestApproval')) {
      this.respond(message.id, { decision: 'decline' });
    } else if (message.method === 'item/tool/requestUserInput' || message.method === 'tool/requestUserInput') {
      this.pendingUserInputs.set(String(message.id), message);
      this.emit('event', {
        method: 'item/tool/requestUserInput',
        params: { ...(message.params || {}), requestId: String(message.id) }
      });
    } else if (message.method === 'attestation/generate') {
      this.respond(message.id, { token: null });
    } else {
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
    }
  }

  handleNotification(method, params) {
    if (method === 'item/completed' && params.item?.type === 'mcpToolCall') {
      const tool = params.item.tool;
      if (MUTATING_TOOLS.has(tool)) this.emit('business-changed', { tool, at: Date.now() });
      if (tool === 'open_workbench') this.emit('navigate', 'holdings');
    }
    if (method === 'turn/started') {
      this.active = { threadId: params.threadId, turnId: params.turn?.id };
    } else if (method === 'turn/completed') {
      this.active = null;
    }
    if (/^(thread|turn|item|account|mcpServer|error|warning)/.test(method)) {
      this.emit('event', { method, params });
    }
  }

  threadConfig(dataAuthorized = false) {
    const enabledTools = dataAuthorized
      ? this.options.enabledTools
      : this.options.enabledTools.filter(tool => PUBLIC_TOOLS.has(tool));
    return {
      features: {
        shell_tool: false,
        apps: false,
        plugins: false,
        multi_agent: false,
        skill_mcp_dependency_install: false
      },
      web_search: 'disabled',
      mcp_servers: {
        fund_workbench: {
          command: this.options.pythonPath,
          args: this.options.mcpArgs ?? ['-u', this.options.mcpScript],
          env: this.options.mcpEnv || {},
          cwd: this.options.cwd,
          required: true,
          startup_timeout_sec: 15,
          tool_timeout_sec: 180,
          default_tools_approval_mode: 'approve',
          enabled_tools: enabledTools
        }
      }
    };
  }

  async account() {
    await this.start();
    return this.request('account/read', { refreshToken: false });
  }

  async rateLimits() {
    await this.start();
    return this.request('account/rateLimits/read', {});
  }

  async models() {
    await this.start();
    return this.request('model/list', {});
  }

  async loginSubscription() {
    await this.start();
    return this.request('account/login/start', {
      type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex'
    });
  }

  async startThread(provider, ephemeral = false, dataAuthorized = false) {
    await this.start();
    const params = {
      cwd: this.options.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: INSTRUCTIONS,
      ephemeral,
      config: this.threadConfig(dataAuthorized)
    };
    if (provider?.model) params.model = provider.model;
    if (provider?.id) params.modelProvider = provider.id;
    const result = await this.request('thread/start', params);
    return result.thread;
  }

  async resumeThread(threadId, provider, dataAuthorized = false) {
    await this.start();
    const params = {
      threadId,
      cwd: this.options.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: INSTRUCTIONS,
      config: this.threadConfig(dataAuthorized)
    };
    if (provider?.model) params.model = provider.model;
    if (provider?.id) params.modelProvider = provider.id;
    const result = await this.request('thread/resume', params);
    return result.thread;
  }

  async readThread(threadId) {
    await this.start();
    const result = await this.request('thread/read', { threadId, includeTurns: true });
    return result.thread;
  }

  async archiveThread(threadId) {
    await this.start();
    await this.request('thread/archive', { threadId });
  }

  async sendMessage(threadId, text, provider = {}, pageContext = null) {
    await this.start();
    if (this.active) throw new Error('已有一个 Agent 任务正在运行。');
    const input = [{ type: 'text', text }];
    if (pageContext && typeof pageContext === 'object') {
      input.push({ type: 'text', text: `${PAGE_CONTEXT_PREFIX}${JSON.stringify(pageContext)}${PAGE_CONTEXT_SUFFIX}` });
    }
    if (this.options.skillPath) {
      input.push({ type: 'skill', name: 'fund-workbench', path: this.options.skillPath });
    }
    const params = {
      threadId,
      input,
      summary: 'concise',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    };
    if (provider?.model) params.model = provider.model;
    if (provider?.effort) params.effort = provider.effort;
    const result = await this.request('turn/start', {
      ...params
    });
    this.active = { threadId, turnId: result.turn?.id };
    return result.turn;
  }


  answerUserInput(requestId, answers) {
    const key = String(requestId || '');
    const pending = this.pendingUserInputs.get(key);
    if (!pending) throw new Error('这个澄清问题已失效，请重新发送问题。');
    this.pendingUserInputs.delete(key);
    this.respond(pending.id, { answers });
    this.emit('event', {
      method: 'item/tool/requestUserInput/resolved',
      params: { ...(pending.params || {}), requestId: key }
    });
    return { answered: true };
  }

  async interrupt() {
    if (!this.active) return { interrupted: false };
    await this.request('turn/interrupt', this.active);
    return { interrupted: true };
  }

  stop() {
    if (this.process && !this.process.killed) {
      if (process.platform === 'win32' && this.process.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(this.process.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true
        });
        killer.unref();
      } else {
        this.process.kill('SIGTERM');
      }
    }
    this.process = null;
    this.ready = null;
    this.pendingUserInputs.clear();
  }
}

module.exports = { CodexAgentRuntime, MUTATING_TOOLS, PUBLIC_TOOLS, PAGE_CONTEXT_PREFIX, PAGE_CONTEXT_SUFFIX };
