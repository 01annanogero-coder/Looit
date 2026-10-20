// Whether the user allows AI apps to use Looit (Help → Connect an AI app).
// Off until the user turns it on; remembered in the app's data folder.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

interface AiSettingsFile {
  enabled: boolean;
}

function file(): string {
  return path.join(app.getPath('userData'), 'ai-connection.json');
}

let cached: AiSettingsFile | null = null;

export function aiAccessEnabled(): boolean {
  // Development only: automated tests of the AI connection, without changing the saved setting.
  if (!app.isPackaged && process.env.LOOIT_AI_TEST_ENABLE === '1') return true;
  if (!cached) {
    try {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<AiSettingsFile>;
      cached = { enabled: data.enabled === true };
    } catch {
      cached = { enabled: false };
    }
  }
  return cached.enabled;
}

export function setAiAccessEnabled(enabled: boolean): void {
  cached = { enabled };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cached), 'utf8');
}
