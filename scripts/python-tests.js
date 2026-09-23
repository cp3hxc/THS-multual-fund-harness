#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python');
const result = spawnSync(python, ['-m', 'unittest', '-v',
  'test_server.py', 'test_fund_data.py', 'test_mcp_server.py', 'test_strategy_engine.py'], {
  cwd: root, stdio: 'inherit', windowsHide: true
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
