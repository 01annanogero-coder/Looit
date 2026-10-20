// Help → Connect an AI app: turn AI access on, and the snippet to add to the
// AI app's config (Claude Desktop) so it can start Looit's MCP server.

import { Copy, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AiConnectionInfo } from '../../shared/ipc';
import { Toggle } from './controls';

export function AiConnectDialog({ onClose }: { onClose(): void }) {
  const [info, setInfo] = useState<AiConnectionInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.looit.ai.connection().then(setInfo, (e: unknown) => setError(String(e)));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const setEnabled = async (enabled: boolean) => {
    await window.looit.ai.setEnabled(enabled);
    setInfo(await window.looit.ai.connection());
  };
  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy. Select the text and copy it with Ctrl+C.');
    }
  };

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="overlay-card ai-connect">
        <strong>Connect an AI app</strong>
        <p className="muted">
          Let an AI app such as Claude Desktop make videos with Looit. The AI works in its own AI Studio window: it can
          read the project you have open but never change it, and every video or project it saves goes where you choose
          in a Save dialog.
        </p>
        {info && (
          <>
            <Toggle checked={info.enabled} onChange={(v) => void setEnabled(v)} label="Allow AI apps to use Looit" />

            <h4>1. Add Looit to Claude Desktop</h4>
            <p className="muted">
              Open Claude Desktop's config file and add this. If the file already has an <code>mcpServers</code>{' '}
              section, put the <code>looit</code> entry inside it.
            </p>
            <div className="snippet">
              <pre>{info.snippet}</pre>
              <button onClick={() => void copy()}>
                <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="config-list">
              {info.configs.map((c) => (
                <div className="config-row" key={c.path}>
                  <div>
                    <div>
                      {c.label}{' '}
                      <span className={`badge${c.exists ? ' found' : ''}`}>{c.exists ? 'Found' : 'Not found'}</span>
                    </div>
                    <div className="muted small path">{c.path}</div>
                  </div>
                  <button title="Show in File Explorer" onClick={() => void window.looit.ai.showConfig(c.path)}>
                    <FolderOpen size={14} /> Show
                  </button>
                </div>
              ))}
            </div>
            <p className="muted small">
              In Claude Desktop you can also open the file from Settings → Developer → Edit Config.
            </p>

            <h4>2. Restart Claude Desktop and ask</h4>
            <p className="muted">
              Quit Claude Desktop completely (also from the system tray) and start it again. Then ask, for example:{' '}
              <em>
                “Make a 20-second Looit video of https://example.com that hovers the menu and scrolls down the page.”
              </em>
            </p>
            {info.development && (
              <p className="muted small">Development build: keep Looit running (npm start) while the AI app uses it.</p>
            )}
          </>
        )}
        {error && <p className="error-text">{error}</p>}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
