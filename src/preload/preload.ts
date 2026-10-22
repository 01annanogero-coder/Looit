// The only bridge between the editor UI and the main process. Exposes a small,
// typed API; the renderer never gets direct access to ipcRenderer or Node.

import { contextBridge, ipcRenderer } from 'electron';
import type { AiRequest, AiResponse, LooitApi, SiteFrame, SiteStatus } from '../shared/ipc';

// The main process asks the editor to save when the window is closing with
// unsaved changes; one handler answers, however often the UI re-registers it.
let saveHandler: (() => Promise<boolean>) | null = null;
ipcRenderer.on('project:save-request', (_e, id: number) => {
  void (async () => {
    let ok = false;
    try {
      ok = saveHandler ? await saveHandler() : false;
    } catch {
      ok = false;
    }
    ipcRenderer.send('project:save-result', id, ok);
  })();
});

const api: LooitApi = {
  site: {
    sync: (target) => ipcRenderer.send('site:sync', target),
    advance: (step) => ipcRenderer.send('site:advance', step),
    keep: (ids) => ipcRenderer.send('site:keep', ids),
    setInteractive: (on) => ipcRenderer.send('site:interactive', on),
    input: (id, events) => ipcRenderer.send('site:input', id, events),
    scrollSinceInteract: (id) => ipcRenderer.invoke('site:scroll-since-interact', id),
    ackFrame: (id) => ipcRenderer.send('site:ack', id),
    refresh: () => ipcRenderer.send('site:refresh'),
    onFrame: (cb) => {
      ipcRenderer.on('site:frame', (_e, frame: SiteFrame) => cb(frame));
    },
    onStatus: (cb) => {
      ipcRenderer.on('site:status', (_e, status: SiteStatus) => cb(status));
    },
  },
  exporter: {
    begin: (opts) => ipcRenderer.invoke('export:begin', opts),
    frame: (id, n) => ipcRenderer.invoke('export:frame', id, n),
    end: () => ipcRenderer.invoke('export:end'),
    createFile: (name) => ipcRenderer.invoke('export:create-file', name),
    write: (id, position, data) => ipcRenderer.invoke('export:write', id, position, data),
    closeFile: (id, keep) => ipcRenderer.invoke('export:close-file', id, keep),
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    save: (text, path, name) => ipcRenderer.invoke('project:save', text, path, name),
    setDirty: (dirty) => ipcRenderer.send('project:dirty', dirty),
    pickImage: () => ipcRenderer.invoke('project:pick-image'),
    onSaveRequest: (handler) => {
      saveHandler = handler;
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    showLogs: () => ipcRenderer.invoke('app:show-logs'),
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    create: (name) => ipcRenderer.invoke('library:create', name),
    demo: () => ipcRenderer.invoke('library:demo'),
    open: (id) => ipcRenderer.invoke('library:open', id),
    add: (path, name) => ipcRenderer.invoke('library:add', path, name),
    rename: (id, name) => ipcRenderer.invoke('library:rename', id, name),
    setPinned: (id, pinned) => ipcRenderer.invoke('library:set-pinned', id, pinned),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    share: (id) => ipcRenderer.invoke('library:share', id),
    noteSaved: (path, name) => ipcRenderer.invoke('library:note-saved', path, name),
    reveal: (id) => ipcRenderer.invoke('library:reveal', id),
  },
  ai: {
    onRequest: (handler) => {
      ipcRenderer.on('ai:request', (_e, req: AiRequest) => {
        void (async () => {
          let response: AiResponse;
          try {
            response = { id: req.id, result: await handler(req.method, req.params) };
          } catch (err) {
            response = { id: req.id, error: err instanceof Error ? err.message : String(err) };
          }
          ipcRenderer.send('ai:response', response);
        })();
      });
      ipcRenderer.send('ai:ready');
    },
    connection: () => ipcRenderer.invoke('ai:connection'),
    setEnabled: (enabled) => ipcRenderer.invoke('ai:set-enabled', enabled),
    showConfig: (path) => ipcRenderer.invoke('ai:show-config', path),
  },
  studio: {
    settle: () => ipcRenderer.invoke('studio:settle'),
  },
  selfTest: {
    config: () => ipcRenderer.invoke('selftest:config'),
    writeFile: (name, data) => ipcRenderer.invoke('selftest:write', name, data),
    finish: (ok) => ipcRenderer.send('selftest:finish', ok),
  },
};

contextBridge.exposeInMainWorld('looit', api);
