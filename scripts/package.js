#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = process.argv[2] || (process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : '');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python');
const buildRoot = path.join(root, 'build');
const backendDir = path.join(buildRoot, 'backend');

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: process.env.PYTHONUTF8 || '1' }
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label}失败（退出码 ${result.status ?? 'unknown'}）。`);
}

function requireNativeTarget() {
  if (target === 'mac' && process.platform !== 'darwin') {
    throw new Error('macOS 应用需要在 macOS 上构建。');
  }
  if (target === 'win' && process.platform !== 'win32') {
    throw new Error('Windows 安装包需要在 Windows 上构建。');
  }
  if (target === 'win' && process.arch !== 'x64') {
    throw new Error('当前版本的 Windows 安装包需要在 x64 Windows 上构建。');
  }
  if (!['mac', 'win'].includes(target)) {
    throw new Error('仅支持 macOS（mac）和 Windows x64（win）构建目标。');
  }
}

function buildBackend() {
  const builderPackagePath = path.join(root, 'node_modules', 'electron-builder', 'package.json');
  if (!fs.existsSync(builderPackagePath)) throw new Error('构建依赖未安装，请先运行 npm ci。');
  run(process.execPath, [path.join(__dirname, 'setup.js')], '准备 Python 环境');

  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(root, 'requirements-build.txt')],
    '安装桌面构建工具');
  fs.rmSync(backendDir, { recursive: true, force: true });
  fs.mkdirSync(backendDir, { recursive: true });

  const programs = [
    { name: 'fund-workbench-server', entry: path.join(root, 'server.py'), metadata: true },
    { name: 'fund-workbench-mcp', entry: path.join(root, 'harness', 'mcp_server.py') },
    { name: 'aijijin', entry: path.join(__dirname, 'build_cli_entry.py') }
  ];
  for (const program of programs) {
    const workPath = path.join(buildRoot, 'pyinstaller', program.name);
    fs.mkdirSync(workPath, { recursive: true });
    const args = ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--paths', root,
      '--name', program.name, '--distpath', backendDir, '--workpath', workPath, '--specpath', workPath];
    if (program.metadata) args.push('--copy-metadata', 'aijijin-sdk');
    args.push(program.entry);
    run(python, args, `打包 ${program.name}`);
  }
}

function buildElectron() {
  const builderPackage = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron-builder', 'package.json'), 'utf8'));
  const binary = builderPackage.bin?.['electron-builder'];
  if (!binary) throw new Error('electron-builder 命令入口不存在。');
  const args = [path.join(root, 'node_modules', 'electron-builder', binary)];
  if (target === 'mac') args.push('--mac', 'dmg', process.arch === 'arm64' ? '--arm64' : '--x64');
  else args.push('--win', 'nsis', '--x64');
  args.push('--publish', 'never');
  run(process.execPath, args, `构建 ${target} 安装包`);
}

try {
  requireNativeTarget();
  buildBackend();
  buildElectron();
  process.stdout.write(`安装包构建完成，产物位于 ${path.join(root, 'dist')}。\n`);
} catch (error) {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
}
