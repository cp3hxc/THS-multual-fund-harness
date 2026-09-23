#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'desktop';
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python');
const setup = spawnSync(process.execPath, [path.join(__dirname, 'setup.js')], { cwd: root, stdio: 'inherit' });
if (setup.status !== 0) process.exit(setup.status || 1);

let executable;
let args;
if (mode === 'web') {
  executable = python;
  args = [path.join(root, 'server.py'), '--open-browser', ...process.argv.slice(3)];
} else if (mode === 'desktop') {
  try {
    executable = require('electron');
  } catch {
    process.stderr.write('Electron 未安装。请先在项目目录运行 npm ci。\n');
    process.exit(1);
  }
  if (!fs.existsSync(executable)) {
    process.stderr.write('Electron 程序不存在。请先运行 npm ci。\n');
    process.exit(1);
  }
  args = [root, ...process.argv.slice(3)];
} else {
  process.stderr.write('用法：node scripts/run.js [desktop|web]\n');
  process.exit(2);
}

const child = spawn(executable, args, {
  cwd: root,
  env: { ...process.env, PYTHONUTF8: process.env.PYTHONUTF8 || '1' },
  stdio: 'inherit',
  windowsHide: mode === 'web'
});
child.once('error', error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
  else process.exitCode = code ?? 1;
});
