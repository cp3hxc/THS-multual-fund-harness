const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { CodexAgentRuntime, PUBLIC_TOOLS } = require('./agent-runtime');

function venvPython(root = ROOT) {
  return process.env.FUND_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python');
}

function resolveWorkbenchRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'workbench');
  if (process.env.FUND_WORKBENCH_ROOT) return path.resolve(process.env.FUND_WORKBENCH_ROOT);
  return path.resolve(__dirname, '..');
}

const ROOT = resolveWorkbenchRoot();
const WORKBENCH_URL = 'http://127.0.0.1:8765';
const DEFAULT_SUBSCRIPTION_MODEL = 'gpt-6-astra';
const DEFAULT_REASONING_EFFORT = 'high';
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const TOOLS = [
  'open_workbench', 'get_dashboard', 'get_account_brief', 'list_holdings', 'analyze_portfolio',
  'get_fund_accounts', 'get_buy_preview', 'get_redeem_preview', 'list_orders',
  'get_order', 'list_strategy_templates', 'list_strategies', 'create_strategy',
  'archive_strategy', 'list_watchlist', 'set_watchlist', 'list_trade_drafts',
  'save_trade_draft', 'remove_trade_draft', 'get_connection_status',
  'start_fund_login', 'get_fund_login_status', 'list_investment_strategies',
  'run_investment_backtest', 'save_strategy_variant'
];

let mainWindow = null;
let pythonProcess = null;
let ownsPythonProcess = false;
let runtime = null;
let currentThreadId = null;
let isQuitting = false;

const appData = () => app.getPath('userData');
const settingsPath = () => path.join(appData(), 'settings.json');
const sessionsPath = () => path.join(appData(), 'sessions.json');
const codexHome = () => path.join(appData(), 'codex-home');

function backendExecutable(name) {
  return path.join(process.resourcesPath, 'backend', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
}

function mcpCommand() {
  return app.isPackaged ? backendExecutable('fund-workbench-mcp') : venvPython();
}

function mcpArgs() {
  return app.isPackaged ? [] : ['-u', path.join(ROOT, 'harness/mcp_server.py')];
}

function runtimeDirectory() {
  return app.isPackaged ? path.join(appData(), 'runtime') : path.join(ROOT, '.runtime');
}

function runtimeEnvironment() {
  const env = { FUND_WORKBENCH_ROOT: ROOT, PYTHONUTF8: process.env.PYTHONUTF8 || '1' };
  if (app.isPackaged) {
    env.FUND_WORKBENCH_DATA_DIR = runtimeDirectory();
    env.FUND_WORKBENCH_CLI = backendExecutable('aijijin');
    env.FUND_WORKBENCH_SERVER = backendExecutable('fund-workbench-server');
  }
  return env;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readSettingsRaw() {
  const value = readJson(settingsPath(), { activeMode: 'subscription', activeProviderId: null, providers: [] });
  if (!Array.isArray(value.providers)) value.providers = [];
  if (!['subscription', 'api'].includes(value.activeMode)) value.activeMode = 'subscription';
  if (!/^[A-Za-z0-9._:/-]{1,160}$/.test(String(value.subscriptionModel || ''))) {
    value.subscriptionModel = DEFAULT_SUBSCRIPTION_MODEL;
  }
  if (!REASONING_EFFORTS.has(value.subscriptionEffort)) value.subscriptionEffort = DEFAULT_REASONING_EFFORT;
  value.providers = value.providers.map(row => ({
    ...row,
    effort: REASONING_EFFORTS.has(row.effort) ? row.effort : DEFAULT_REASONING_EFFORT
  }));
  return value;
}

function publicSettings(value = readSettingsRaw()) {
  return {
    activeMode: value.activeMode,
    activeProviderId: value.activeProviderId,
    subscriptionModel: value.subscriptionModel || DEFAULT_SUBSCRIPTION_MODEL,
    subscriptionEffort: value.subscriptionEffort || DEFAULT_REASONING_EFFORT,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    providers: value.providers.map(({ encryptedKey, ...row }) => ({ ...row, keyConfigured: Boolean(encryptedKey) }))
  };
}

function decryptKey(provider) {
  if (!provider?.encryptedKey || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(provider.encryptedKey, 'base64')); } catch { return ''; }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function writeCodexConfig(settings) {
  fs.mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
  const lines = [
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'project_doc_max_bytes = 32768',
    'cli_auth_credentials_store = "file"',
    '',
    '[features]',
    'shell_tool = false',
    'apps = false',
    'plugins = false',
    'multi_agent = false',
    'skill_mcp_dependency_install = false',
    '',
    '[mcp_servers.fund_workbench]',
    `command = ${tomlString(mcpCommand())}`,
    `args = [${mcpArgs().map(tomlString).join(', ')}]`,
    `env = { ${Object.entries(runtimeEnvironment()).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`,
    `cwd = ${tomlString(ROOT)}`,
    'required = true',
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 180',
    'default_tools_approval_mode = "approve"',
    `enabled_tools = [${TOOLS.filter(tool => PUBLIC_TOOLS.has(tool)).map(tomlString).join(', ')}]`
  ];
  for (const provider of settings.providers) {
    if (!/^fund_api_[a-f0-9]{12}$/.test(provider.id)) continue;
    lines.push('', `[model_providers.${provider.id}]`, `name = ${tomlString(provider.name)}`,
      `base_url = ${tomlString(provider.baseUrl)}`, `env_key = ${tomlString(provider.envKey)}`,
      'wire_api = "responses"', 'requires_openai_auth = false');
  }
  fs.writeFileSync(path.join(codexHome(), 'config.toml'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

function importExistingCodexLogin() {
  const target = path.join(codexHome(), 'auth.json');
  const source = path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(target) && fs.existsSync(source)) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
}

function codexExecutable() {
  const npmBin = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')
    : path.join(os.homedir(), '.npm-global', 'bin');
  const candidates = [
    process.env.CODEX_BIN,
    path.join(npmBin, process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'])
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  try {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(lookup, ['codex'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch { return ''; }
}

function createRuntime() {
  const settings = readSettingsRaw();
  writeCodexConfig(settings);
  importExistingCodexLogin();
  const env = {
    ...process.env,
    ...runtimeEnvironment(),
    CODEX_HOME: codexHome(),
    FUND_WORKBENCH_DESKTOP: '1',
    PATH: [
      path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Roaming/npm' : '.npm-global/bin'),
      ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin']),
      process.env.PATH || ''
    ].filter(Boolean).join(path.delimiter)
  };
  for (const provider of settings.providers) env[provider.envKey] = decryptKey(provider);
  const codexPath = codexExecutable();
  if (!codexPath) throw new Error('未找到 Codex CLI。');
  const next = new CodexAgentRuntime({
    codexPath,
    cwd: ROOT,
    env,
    pythonPath: mcpCommand(),
    mcpArgs: mcpArgs(),
    mcpEnv: runtimeEnvironment(),
    mcpScript: path.join(ROOT, 'harness/mcp_server.py'),
    skillPath: path.join(ROOT, 'harness/skills/fund-workbench/SKILL.md'),
    enabledTools: TOOLS
  });
  next.on('event', payload => sendToRenderer('agent:event', payload));
  next.on('status', payload => sendToRenderer('agent:event', { method: 'runtime/status', params: payload }));
  next.on('business-changed', payload => sendToRenderer('agent:business-changed', payload));
  next.on('navigate', route => sendToRenderer('agent:navigate', route));
  return next;
}

async function restartRuntime() {
  runtime?.stop();
  currentThreadId = null;
  runtime = createRuntime();
  await runtime.start();
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function workbenchHealthy() {
  return new Promise(resolve => {
    const request = http.get(`${WORKBENCH_URL}/api/bootstrap`, { timeout: 900 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function ensureWorkbench() {
  if (await workbenchHealthy()) return;
  const packaged = app.isPackaged;
  const executable = packaged ? backendExecutable('fund-workbench-server') : venvPython();
  if (!fs.existsSync(executable)) {
    throw new Error(packaged ? '安装包中的基金服务不存在，请重新安装应用。' : '项目虚拟环境不存在，请先运行 npm run setup。');
  }
  const logDir = runtimeDirectory();
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(path.join(logDir, 'desktop-service.log'), 'a', 0o600);
  const args = packaged ? ['--port', '8765'] : [path.join(ROOT, 'server.py'), '--port', '8765'];
  pythonProcess = spawn(executable, args, {
    cwd: ROOT, env: { ...process.env, ...runtimeEnvironment() },
    detached: false, stdio: ['ignore', logFd, logFd], windowsHide: true
  });
  ownsPythonProcess = true;
  pythonProcess.once('exit', () => {
    const exitedUnexpectedly = !isQuitting && ownsPythonProcess;
    pythonProcess = null;
    ownsPythonProcess = false;
    if (exitedUnexpectedly) {
      sendToRenderer('agent:event', { method: 'runtime/status', params: { type: 'service-restarting', message: '基金业务服务正在恢复。' } });
      setTimeout(() => ensureWorkbench().then(() => mainWindow?.webContents.reload()).catch(error => {
        sendToRenderer('agent:event', { method: 'runtime/status', params: { type: 'service-error', message: error.message } });
      }), 800);
    }
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (await workbenchHealthy()) return;
    if (pythonProcess.exitCode !== null) break;
  }
  throw new Error('基金业务服务启动失败，请查看 .runtime/desktop-service.log。');
}

function readSessions() {
  const rows = readJson(sessionsPath(), []);
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({
    ...row,
    pinned: row.pinned === true,
    model: row.model || (row.mode === 'api' ? null : DEFAULT_SUBSCRIPTION_MODEL),
    effort: REASONING_EFFORTS.has(row.effort) ? row.effort : DEFAULT_REASONING_EFFORT
  })).sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function writeSessions(rows) {
  atomicWriteJson(sessionsPath(), rows.slice(0, 100));
}

function activeProvider() {
  const settings = readSettingsRaw();
  if (settings.activeMode === 'api') {
    const provider = settings.providers.find(row => row.id === settings.activeProviderId);
    if (!provider) throw new Error('请选择已配置的 API 模型服务。');
    return { id: provider.id, model: provider.model, effort: provider.effort, name: provider.name, mode: 'api' };
  }
  return { id: null, model: settings.subscriptionModel, effort: settings.subscriptionEffort,
    name: 'ChatGPT / Codex 订阅', mode: 'subscription' };
}

function modelCatalogRows(result) {
  const rows = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : [];
  return rows.filter(row => row && typeof row === 'object' && typeof row.id === 'string');
}

function providerForSession(session) {
  if (!session || session.mode !== 'api') return {
    id: null,
    model: session?.model || DEFAULT_SUBSCRIPTION_MODEL,
    effort: session?.effort || DEFAULT_REASONING_EFFORT,
    name: session?.providerName || 'ChatGPT / Codex 订阅',
    mode: 'subscription'
  };
  const provider = readSettingsRaw().providers.find(row => row.id === session.providerId);
  if (!provider) throw new Error('这个会话使用的 API 服务已被移除。');
  return { id: provider.id, model: provider.model, effort: session.effort || provider.effort,
    name: provider.name, mode: 'api' };
}

function recordSession(thread, provider, title = '新会话') {
  const rows = readSessions().filter(row => row.threadId !== thread.id);
  rows.unshift({
    threadId: thread.id,
    title,
    mode: provider.mode,
    providerId: provider.id,
    providerName: provider.name,
    model: provider.model,
    effort: provider.effort,
    dataAuthorized: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  writeSessions(rows);
  return rows[0];
}

function sanitizePageContext(value) {
  if (!value || typeof value !== 'object') return null;
  const routes = new Set(['home', 'workbench', 'holdings', 'account', 'trades', 'watchlist', 'library', 'strategies', 'strategy-invest', 'settings', 'plans', 'history']);
  const context = {};
  if (routes.has(value.route)) context.route = value.route;
  if (typeof value.pageTitle === 'string') context.pageTitle = value.pageTitle.slice(0, 30);
  if (typeof value.tab === 'string') context.tab = value.tab.slice(0, 40);
  if (typeof value.filter === 'string') context.filter = value.filter.slice(0, 60);
  if (value.selectedFund && typeof value.selectedFund === 'object' && /^\d{6}$/.test(String(value.selectedFund.code || ''))) {
    context.selectedFund = {
      code: String(value.selectedFund.code),
      name: String(value.selectedFund.name || '').slice(0, 80)
    };
  }
  if (value.strategy && typeof value.strategy === 'object') {
    context.strategy = {
      id: String(value.strategy.id || '').slice(0, 80),
      name: String(value.strategy.name || '').slice(0, 80),
      version: String(value.strategy.version || '').slice(0, 40)
    };
  }
  if (value.backtest && typeof value.backtest === 'object') {
    context.backtest = {
      status: String(value.backtest.status || '').slice(0, 30),
      fundCode: /^\d{6}$/.test(String(value.backtest.fundCode || '')) ? String(value.backtest.fundCode) : null,
      dataAsOf: String(value.backtest.dataAsOf || '').slice(0, 20)
    };
  }
  return Object.keys(context).length ? context : null;
}

function validateSender(event) {
  const url = event.senderFrame?.url || '';
  if (!url.startsWith(`${WORKBENCH_URL}/`)) throw new Error('无效的桌面调用来源。');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    validateSender(event);
    try { return { ok: true, data: await fn(payload || {}) }; }
    catch (error) { return { ok: false, error: error.message || '操作失败。' }; }
  });
}

function registerIpc() {
  handle('agent:get-status', async () => {
    await runtime.start();
    let account = null;
    let rateLimits = null;
    let models = null;
    try { account = await runtime.account(); } catch {}
    try { rateLimits = await runtime.rateLimits(); } catch {}
    try { models = await runtime.models(); } catch {}
    return { ready: true, active: runtime.active, account, rateLimits, models,
      activeProfile: activeProvider(), settings: publicSettings() };
  });
  handle('agent:list-sessions', async () => readSessions());
  handle('agent:new-session', async () => {
    if (runtime.active) throw new Error('请先停止或等待当前 Agent 任务完成。');
    const provider = activeProvider();
    const thread = await runtime.startThread(provider, false, false);
    currentThreadId = thread.id;
    const session = recordSession(thread, provider);
    return { session, thread };
  });
  handle('agent:resume-session', async ({ threadId }) => {
    if (runtime.active) throw new Error('请先停止或等待当前 Agent 任务完成。');
    const session = readSessions().find(row => row.threadId === threadId);
    if (!session) throw new Error('未找到这个基金工作台会话。');
    let thread;
    try {
      thread = await runtime.resumeThread(threadId, providerForSession(session), session.dataAuthorized);
    } catch (error) {
      if (/no rollout found|thread.*not found|not found.*thread/i.test(error.message || '')) {
        const sessions = readSessions().filter(row => row.threadId !== threadId);
        writeSessions(sessions);
        if (currentThreadId === threadId) currentThreadId = null;
        return { stale: true, sessions };
      }
      throw error;
    }
    currentThreadId = threadId;
    return { session, thread };
  });
  handle('agent:read-session', async ({ threadId }) => runtime.readThread(String(threadId || '')));
  handle('agent:archive-session', async ({ threadId }) => {
    if (runtime.active) throw new Error('请先停止或等待当前 Agent 任务完成。');
    await runtime.archiveThread(String(threadId || ''));
    const rows = readSessions().filter(row => row.threadId !== threadId);
    writeSessions(rows);
    if (currentThreadId === threadId) currentThreadId = null;
    return rows;
  });
  handle('agent:delete-session', async ({ threadId }) => {
    if (runtime.active) throw new Error('请先停止或等待当前 Agent 任务完成。');
    const id = String(threadId || '');
    if (!readSessions().some(row => row.threadId === id)) throw new Error('未找到这个基金工作台会话。');
    let warning = null;
    try {
      await runtime.archiveThread(id);
    } catch (error) {
      warning = `模型服务未完成归档：${String(error?.message || '未知错误')}`;
    }
    const rows = readSessions().filter(row => row.threadId !== id);
    writeSessions(rows);
    if (currentThreadId === id) currentThreadId = null;
    return { sessions: rows, warning };
  });
  handle('agent:update-session', async ({ threadId, pinned, title }) => {
    if (runtime.active) throw new Error('请先停止或等待当前 Agent 任务完成。');
    const rows = readSessions();
    const session = rows.find(row => row.threadId === String(threadId || ''));
    if (!session) throw new Error('未找到这个基金工作台会话。');
    if (typeof pinned === 'boolean') session.pinned = pinned;
    if (title !== undefined) {
      const clean = String(title || '').trim();
      if (!clean || clean.length > 60) throw new Error('会话名称须为 1 至 60 字。');
      session.title = clean;
    }
    session.updatedAt = new Date().toISOString();
    writeSessions(rows);
    return readSessions();
  });
  handle('agent:send-message', async ({ threadId, text, authorizeAccountData, pageContext }) => {
    const message = String(text || '').trim();
    if (!message || message.length > 12000) throw new Error('请输入 1 至 12000 字的问题。');
    if (!threadId || threadId !== currentThreadId) throw new Error('请先选择或新建会话。');
    const sessions = readSessions();
    const session = sessions.find(row => row.threadId === threadId);
    if (!session) throw new Error('会话索引不存在。');
    if (!session.dataAuthorized && authorizeAccountData === true) {
      await runtime.resumeThread(threadId, providerForSession(session), true);
      session.dataAuthorized = true;
    }
    if (session.title === '新会话') session.title = message.slice(0, 28);
    session.updatedAt = new Date().toISOString();
    writeSessions(sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    return runtime.sendMessage(threadId, message, providerForSession(session), sanitizePageContext(pageContext));
  });
  handle('agent:answer-user-input', async ({ requestId, answers }) => {
    if (!requestId || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new Error('澄清问题答案格式无效。');
    }
    const clean = {};
    for (const [id, value] of Object.entries(answers)) {
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(id)) continue;
      const list = Array.isArray(value?.answers) ? value.answers : [];
      clean[id] = { answers: list.map(item => String(item).slice(0, 1000)).slice(0, 10) };
    }
    if (!Object.keys(clean).length) throw new Error('请先回答 Agent 的问题。');
    return runtime.answerUserInput(String(requestId), clean);
  });
  handle('agent:interrupt', async () => runtime.interrupt());
  handle('agent:login-subscription', async () => {
    const result = await runtime.loginSubscription();
    if (result.authUrl) {
      const target = new URL(result.authUrl);
      if (target.protocol !== 'https:' || !['chatgpt.com', 'auth.openai.com'].some(host => target.hostname === host || target.hostname.endsWith(`.${host}`))) {
        throw new Error('登录地址不是受信任的 OpenAI 地址。');
      }
      await shell.openExternal(result.authUrl);
    }
    return { loginId: result.loginId || null, started: true };
  });
  handle('agent:get-settings', async () => publicSettings());
  handle('agent:save-provider', async input => {
    const settings = readSettingsRaw();
    if (input.mode === 'subscription') {
      const requestedModel = String(input.model || settings.subscriptionModel || DEFAULT_SUBSCRIPTION_MODEL).trim();
      const requestedEffort = String(input.effort || settings.subscriptionEffort || DEFAULT_REASONING_EFFORT);
      const catalog = modelCatalogRows(await runtime.models());
      const selectedModel = catalog.find(row => row.id === requestedModel);
      if (!selectedModel) throw new Error('所选订阅模型当前不可用，请刷新后重新选择。');
      const supported = (selectedModel.supportedReasoningEfforts || [])
        .map(row => typeof row === 'string' ? row : row?.reasoningEffort)
        .filter(Boolean);
      if (!REASONING_EFFORTS.has(requestedEffort) || (supported.length && !supported.includes(requestedEffort))) {
        throw new Error('所选模型不支持该推理强度。');
      }
      settings.activeMode = 'subscription';
      settings.activeProviderId = null;
      settings.subscriptionModel = requestedModel;
      settings.subscriptionEffort = requestedEffort;
      atomicWriteJson(settingsPath(), settings);
      return publicSettings(settings);
    } else {
      if (input.selectId) {
        const selected = settings.providers.find(row => row.id === input.selectId);
        if (!selected) throw new Error('未找到该 API 模型服务。');
        settings.activeMode = 'api';
        settings.activeProviderId = selected.id;
        atomicWriteJson(settingsPath(), settings);
        await restartRuntime();
        return publicSettings(settings);
      }
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串暂不可用，不能安全保存 API Key。');
      const name = String(input.name || '').trim();
      const model = String(input.model || '').trim();
      const baseUrl = String(input.baseUrl || '').replace(/\/+$/, '');
      const effort = REASONING_EFFORTS.has(input.effort) ? input.effort : DEFAULT_REASONING_EFFORT;
      if (!name || name.length > 60) throw new Error('服务名称须为 1 至 60 字。');
      if (!/^[A-Za-z0-9._:/-]{1,160}$/.test(model)) throw new Error('模型 ID 格式无效。');
      const url = new URL(baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('API 地址须为不含凭据和查询参数的 HTTPS 地址。');
      let provider = settings.providers.find(row => row.id === input.id);
      if (!provider) {
        const id = `fund_api_${crypto.randomBytes(6).toString('hex')}`;
        provider = { id, envKey: `FUND_PROVIDER_KEY_${id.slice(-12).toUpperCase()}` };
        settings.providers.push(provider);
      }
      const key = String(input.apiKey || '').trim();
      if (!key && !provider.encryptedKey) throw new Error('请输入 API Key。');
      Object.assign(provider, { name, model, effort, baseUrl, protocol: 'responses' });
      if (key) provider.encryptedKey = safeStorage.encryptString(key).toString('base64');
      settings.activeMode = 'api';
      settings.activeProviderId = provider.id;
    }
    atomicWriteJson(settingsPath(), settings);
    await restartRuntime();
    return publicSettings(settings);
  });
  handle('agent:test-provider', async () => {
    const provider = activeProvider();
    if (provider.mode !== 'api') throw new Error('请先选择 API 模式。');
    const thread = await runtime.startThread(provider, true, false);
    const observed = { textStream: false, toolCall: false, toolResult: false };
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('兼容性检测超时。')); }, 150000);
      const listener = event => {
        if (event.params?.threadId !== thread.id) return;
        if (event.method === 'item/agentMessage/delta') observed.textStream = true;
        if (event.method === 'item/started' && event.params.item?.type === 'mcpToolCall') observed.toolCall = true;
        if (event.method === 'item/completed' && event.params.item?.type === 'mcpToolCall') observed.toolResult = event.params.item.status === 'completed';
        if (event.method === 'turn/completed') { cleanup(); resolve(event.params.turn); }
      };
      const cleanup = () => { clearTimeout(timer); runtime.off('event', listener); };
      runtime.on('event', listener);
    });
    await runtime.sendMessage(thread.id, '只调用 list_strategy_templates 工具，然后用一句话回答模板数量。', provider);
    const turn = await done;
    return { connection: true, ...observed, completed: turn.status === 'completed' };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1510,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    title: '基金 AI 工作台',
    backgroundColor: '#f7f7f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${WORKBENCH_URL}/`)) event.preventDefault();
  });
  mainWindow.loadURL(`${WORKBENCH_URL}/panda-strategy-agent.html`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    app.setName('基金 AI 工作台');
    await ensureWorkbench();
    runtime = createRuntime();
    registerIpc();
    createWindow();
    runtime.start().catch(error => sendToRenderer('agent:event', { method: 'runtime/status', params: { type: 'error', message: error.message } }));
  }).catch(error => {
    const { dialog } = require('electron');
    dialog.showErrorBox('基金 AI 工作台无法启动', error.message);
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  isQuitting = true;
  runtime?.stop();
  if (ownsPythonProcess && pythonProcess && pythonProcess.exitCode === null) {
    if (process.platform === 'win32' && pythonProcess.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(pythonProcess.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true
      });
      killer.unref();
    } else {
      pythonProcess.kill('SIGTERM');
    }
  }
});
