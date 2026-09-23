# 当前场外基金策略 Agent 验收

## 唯一界面入口

- `npm start` 打开当前 Electron 策略 Agent。
- `npm run start:web` 的 `/` 与 `/panda-strategy-agent.html` 都打开同一套深色策略 Agent。
- 旧白色工作台、旧策略样例页和专用 DeepSeek Harness 启动入口已从当前分支移除；桌面包不再携带旧页面资源。

## 运行能力

- Codex 对话支持会话持续、恢复、模型/思考强度选择、工具运行进度、中断和历史管理。
- 页面与 Agent 共用固定的 MCP 基金工具和确定性策略引擎；五个策略入口均保留回测参数、数据日期和计算版本。
- 策略详情展示回测曲线、交易依据、参数快照与结果；保存计划前由用户确认标的和资金安排。
- 账户数据仅按用户授权读取；个人密钥、授权和账户资料保存在本机，不进入代码库。

## 自动化检查

```sh
npm run test:python
npm run test:desktop
node --check desktop/main.js
node --check desktop/agent-runtime.js
node --check panda-strategy-agent.js
```

GitHub Actions 在 macOS 与 Windows 上执行 Python、Electron 运行时和 JavaScript 检查，并分别构建桌面安装包。回测和策略结果必须来自实际数据接口与确定性计算；数据缺失时明确展示缺项，不生成模拟业绩。
