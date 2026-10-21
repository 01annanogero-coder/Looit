// The onboarding screen: the project library a user lands on after launch.
// It lists the .looit projects they can continue, and creates new ones, opens
// the demo project or imports a file. Everything else happens in the editor.

import { FolderOpen, Pencil, Pin, Play, Plus, Share2, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryEntry, LibrarySnapshot } from '../../shared/ipc';
import { openLibraryProject } from '../actions';
import { ProjectFileError, parseProject } from '../../engine/schema';
import { setStatus } from '../store';

/** The app icon, emitted by Vite from the project's assets folder. */
const LOGO = new URL('../../../assets/icon.png', import.meta.url).href;

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}

/** "just now", "12 min ago", "Yesterday", "3 Mar". */
function when(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const date = new Date(ms);
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return `today ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return 'yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function Home() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [name, setName] = useState('Untitled project');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await window.looit.library.list());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (renaming) renameInput.current?.select();
  }, [renaming]);

  function open(text: string, path: string | null, label: string): void {
    openLibraryProject(text, path);
    setStatus({ text: `Opened ${label}` });
  }

  async function create(): Promise<void> {
    const projectName = name.trim() || 'Untitled project';
    setBusy('new');
    try {
      const opened = await window.looit.library.create(projectName);
      open(opened.text, opened.entry.path, opened.entry.name);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function openDemo(): Promise<void> {
    setBusy('demo');
    try {
      const opened = await window.looit.library.demo();
      open(opened.text, opened.entry.path, 'the demo project');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function openEntry(entry: LibraryEntry): Promise<void> {
    if (!entry.exists) {
      setError(`"${entry.name}" was moved or deleted. Remove it from the list, or open the file again.`);
      return;
    }
    setBusy(entry.id);
    try {
      const opened = await window.looit.library.open(entry.id);
      if (opened) open(opened.text, opened.entry.path, opened.entry.name);
      await refresh();
    } catch (err) {
      setError(err instanceof ProjectFileError ? err.message : errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function openFile(): Promise<void> {
    setBusy('open');
    try {
      const opened = await window.looit.project.open();
      if (!opened) return;
      const project = parseProject(opened.text);
      // Register it in the list, then open it.
      await window.looit.library.add(opened.path, project.name);
      open(opened.text, opened.path, project.name);
    } catch (err) {
      setError(err instanceof ProjectFileError ? err.message : errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function commitRename(): Promise<void> {
    if (!renaming) return;
    const value = renaming.value.trim();
    if (!value) {
      setRenaming(null);
      return;
    }
    try {
      await window.looit.library.rename(renaming.id, value);
      setRenaming(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function togglePin(entry: LibraryEntry): Promise<void> {
    try {
      await window.looit.library.setPinned(entry.id, !entry.pinned);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function share(entry: LibraryEntry): Promise<void> {
    try {
      const target = await window.looit.library.share(entry.id);
      if (target) setStatus({ text: `Shared a copy to ${target}` });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function remove(entry: LibraryEntry): Promise<void> {
    if (!window.confirm(`Delete "${entry.name}"? The file goes to the recycle bin.`)) return;
    try {
      await window.looit.library.remove(entry.id);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const entries = snapshot?.entries ?? [];
  const demo = snapshot?.demo ?? null;

  return (
    <div className="home">
      <header className="home-top">
        <img className="logo" src={LOGO} alt="" />
        <div>
          <strong>Looit</strong>
          <span className="muted">Turn websites into 3D explainer videos</span>
        </div>
      </header>

      <main className="home-body">
        <section className="home-start">
          <h1>Start a new project</h1>
          <label className="new-row">
            <input
              ref={nameInput}
              value={name}
              maxLength={80}
              placeholder="Project name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
            />
            <button className="primary" onClick={() => void create()} disabled={busy !== null}>
              <Plus size={16} /> Create project
            </button>
          </label>
          <p className="muted home-hint">
            {snapshot ? `Saved in ${snapshot.folder}` : 'Your projects are saved as .looit files.'}
          </p>
          <button className="demo-card" onClick={() => void openDemo()} disabled={busy !== null}>
            <span className="demo-icon">
              <Play size={18} />
            </span>
            <span>
              <strong>Demo project</strong>
              <span className="muted">A ready-made project on electronjs.org</span>
            </span>
          </button>
        </section>

        <section className="home-continue">
          <div className="home-continue-head">
            <h2>Continue with</h2>
            <button onClick={() => void openFile()} disabled={busy !== null}>
              <Upload size={15} /> Open a .looit file…
            </button>
          </div>

          {entries.length === 0 ? (
            <div className="home-empty">
              <p>No projects yet.</p>
              <p className="muted">Create one above, or open the demo project.</p>
            </div>
          ) : (
            <ul className="project-list">
              {entries.map((entry) => (
                <li key={entry.id} className={`project-row${entry.pinned ? ' pinned' : ''}`}>
                  {renaming?.id === entry.id ? (
                    <input
                      ref={renameInput}
                      className="rename-input"
                      value={renaming.value}
                      maxLength={80}
                      onChange={(e) => setRenaming({ id: entry.id, value: e.target.value })}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <button
                      className="project-main"
                      onClick={() => void openEntry(entry)}
                      disabled={busy !== null}
                      title={entry.path}
                    >
                      <span className="project-name">
                        {entry.pinned && <Pin size={13} />}
                        {entry.name}
                      </span>
                      <span className={`project-meta${entry.exists ? '' : ' missing'}`}>
                        {entry.exists ? when(entry.updatedAt) : 'file missing'}
                      </span>
                    </button>
                  )}
                  <div className="project-actions">
                    <button title={entry.pinned ? 'Unpin' : 'Pin to top'} onClick={() => void togglePin(entry)}>
                      <Pin size={16} fill={entry.pinned ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      title="Rename"
                      onClick={() => setRenaming({ id: entry.id, value: entry.name })}
                      disabled={!entry.exists}
                    >
                      <Pencil size={16} />
                    </button>
                    <button title="Share a copy" onClick={() => void share(entry)} disabled={!entry.exists}>
                      <Share2 size={16} />
                    </button>
                    <button
                      title="Show in Explorer"
                      onClick={() => void window.looit.library.reveal(entry.id)}
                      disabled={!entry.exists}
                    >
                      <FolderOpen size={16} />
                    </button>
                    <button title="Delete" className="danger" onClick={() => void remove(entry)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {demo && (
            <p className="muted home-demo-note">
              Demo project: {demo.exists ? 'ready' : 'will be created when opened'} — electronjs.org
            </p>
          )}
        </section>
      </main>

      {error && (
        <div className="home-error" role="alert">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
