#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const venvPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python');
const sdkWheel = path.join(root, 'reference', 'thsfund', 'vendor', 'aijijin_sdk-0.2.3-py3-none-any.whl');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: process.env.PYTHONUTF8 || '1' },
    ...options
  });
  if (result.error) return { status: null, error: result.error };
  return { status: result.status, error: null };
}

function commandCandidates() {
  const preferred = process.env.FUND_PYTHON;
  if (preferred) return [{ command: preferred, prefix: [] }];
  if (process.platform === 'win32') {
    return [
      { command: 'py', prefix: ['-3'] },
      { command: 'python', prefix: [] },
      { command: 'python3', prefix: [] }
    ];
  }
  return [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];
}

function findPython() {
  for (const candidate of commandCandidates()) {
    const result = spawnSync(candidate.command, [...candidate.prefix, '--version'], {
      cwd: root, encoding: 'utf8', windowsHide: true
    });
    if (result.status !== 0) continue;
    const match = `${result.stdout || ''}${result.stderr || ''}`.match(/Python\s+(\d+)\.(\d+)/);
    if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
      throw new Error('需要 Python 3.10 或更高版本。');
    }
    return candidate;
  }
  throw new Error('没有找到 Python 3.10+。请安装 Python，或设置 FUND_PYTHON 指向 Python 可执行文件。');
}

function validateVenvPython() {
  const result = spawnSync(venvPython, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error('项目 Python 环境无法启动。请删除本机 .venv 后重新运行 npm run setup。');
  }
  const match = `${result.stdout || ''}${result.stderr || ''}`.match(/Python\s+(\d+)\.(\d+)/);
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
    throw new Error('项目虚拟环境需要 Python 3.10 或更高版本。请删除本机 .venv 后重新运行 npm run setup。');
  }
}

function checkSdk() {
  const result = spawnSync(venvPython, ['-c',
    'import importlib.metadata as m; v=tuple(map(int,m.version("aijijin-sdk").split(".")[:3])); raise SystemExit(0 if v >= (0,2,3) else 1)'],
  { cwd: root, stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

try {
  if (!fs.existsSync(venvPython)) {
    const python = findPython();
    const result = run(python.command, [...python.prefix, '-m', 'venv', path.join(root, '.venv')], { windowsHide: true });
    if (result.status !== 0) throw result.error || new Error('创建 Python 虚拟环境失败。');
  }
  validateVenvPython();
  if (!checkSdk()) {
    if (!fs.existsSync(sdkWheel)) throw new Error('仓库中的同花顺 SDK 安装包不存在。');
    const result = run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', sdkWheel], { windowsHide: true });
    if (result.status !== 0) throw result.error || new Error('安装同花顺 SDK 失败，请检查网络后重试。');
  }
  process.stdout.write(`项目 Python 环境已就绪：${venvPython}\n`);
} catch (error) {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
}
