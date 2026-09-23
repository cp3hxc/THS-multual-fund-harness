const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fundDesktop', Object.freeze({
  getStatus: () => ipcRenderer.invoke('agent:get-status'),
  listSessions: () => ipcRenderer.invoke('agent:list-sessions'),
  newSession: (options) => ipcRenderer.invoke('agent:new-session', options),
  resumeSession: (threadId) => ipcRenderer.invoke('agent:resume-session', { threadId }),
  archiveSession: (threadId) => ipcRenderer.invoke('agent:archive-session', { threadId }),
  deleteSession: (threadId) => ipcRenderer.invoke('agent:delete-session', { threadId }),
  updateSession: (payload) => ipcRenderer.invoke('agent:update-session', payload),
  readSession: (threadId) => ipcRenderer.invoke('agent:read-session', { threadId }),
  sendMessage: (payload) => ipcRenderer.invoke('agent:send-message', payload),
  answerUserInput: (payload) => ipcRenderer.invoke('agent:answer-user-input', payload),
  interrupt: () => ipcRenderer.invoke('agent:interrupt'),
  startSubscriptionLogin: () => ipcRenderer.invoke('agent:login-subscription'),
  getSettings: () => ipcRenderer.invoke('agent:get-settings'),
  saveProvider: (settings) => ipcRenderer.invoke('agent:save-provider', settings),
  testProvider: () => ipcRenderer.invoke('agent:test-provider'),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  onBusinessChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('agent:business-changed', handler);
    return () => ipcRenderer.removeListener('agent:business-changed', handler);
  },
  onNavigate: (listener) => {
    const handler = (_event, route) => listener(route);
    ipcRenderer.on('agent:navigate', handler);
    return () => ipcRenderer.removeListener('agent:navigate', handler);
  }
}));
