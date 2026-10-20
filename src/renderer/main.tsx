import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { serializeProject } from '../engine/schema';
import { App } from './App';
import { runSelfTest } from './self-test';
import { getEditor, useEditor } from './store';
import { registerStudioCommands } from './studio/commands';
import { Studio } from './studio/Studio';

// The same bundle runs the user's editor and the AI Studio window (#studio).
const isStudio = location.hash === '#studio';

createRoot(document.getElementById('root')!).render(<StrictMode>{isStudio ? <Studio /> : <App />}</StrictMode>);

if (isStudio) {
  document.title = 'Looit · AI Studio';
  registerStudioCommands();
} else {
  // AI apps may read (never change) the project open in the editor.
  window.looit.ai.onRequest((method) => {
    if (method === 'readProject') return serializeProject(getEditor().project);
    throw new Error(`Unknown request ${method}.`);
  });
  void window.looit.selfTest.config().then((config) => {
    if (config) void runSelfTest(config);
  });
}

// Development only: lets automated UI tests read editor state over DevTools.
if (import.meta.env.DEV) (window as unknown as { __looitEditor: unknown }).__looitEditor = useEditor;
