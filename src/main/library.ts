// The onboarding project library: the .looit files the user can continue.
//
// The files are the source of truth and live in Documents/Looit (or wherever
// the user opened one from). A small index in the app's data folder only adds
// what a file cannot say about itself: a stable id, a pin and recency. Losing
// the index never loses a project; the files stay readable.

import fs from 'node:fs/promises';
import path from 'node:path';
import { blankProject, newId, newProject } from '../engine/project';
import { parseProject, ProjectFileError, serializeProject } from '../engine/schema';
import type { LibraryEntry, LibrarySnapshot, OpenedLibraryProject } from '../shared/ipc';

/** The demo project: the app's default blank project on the Electron site. */
export const DEMO_NAME = 'Demo project';

export const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const MAX_NAME = 80;
const INDEX_VERSION = 1;

interface StoredEntry {
  id: string;
  name: string;
  path: string;
  pinned: boolean;
  updatedAt: number;
}

interface IndexFile {
  version: number;
  entries: StoredEntry[];
}

/** A safe project name (also a safe file name): no separators or control characters. */
export function sanitizeName(raw: string, fallback = 'Untitled project'): string {
  const cleaned = raw
    .replace(/\p{Cc}/gu, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_NAME)
    .trim();
  return cleaned || fallback;
}

/** Pinned first, then most recently used. */
export function sortEntries<T extends { pinned: boolean; updatedAt: number; name: string }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.updatedAt - a.updatedAt ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

/** "Name.looit", "Name 2.looit", … that no file in `taken` already uses. */
export function uniqueFileName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((p) => path.basename(p).toLowerCase()));
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${base}.looit` : `${base} ${i}.looit`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export interface LibraryDeps {
  /** The index file in the app's data folder. */
  indexFile: string;
  /** Where new projects are created. */
  folder: string;
  /** Moves a file to the recycle bin (electron's shell.trashItem). */
  trash(file: string): Promise<void>;
}

export class Library {
  private index: IndexFile | null = null;
  /** Index writes run one at a time, so two quick actions can't lose one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LibraryDeps) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<IndexFile> {
    if (this.index) return this.index;
    try {
      const raw = JSON.parse(await fs.readFile(this.deps.indexFile, 'utf8')) as Partial<IndexFile>;
      const entries = Array.isArray(raw.entries) ? raw.entries.filter(isStoredEntry) : [];
      this.index = { version: INDEX_VERSION, entries };
    } catch {
      this.index = { version: INDEX_VERSION, entries: [] };
    }
    return this.index;
  }

  private async persist(): Promise<void> {
    const index = await this.load();
    await fs.mkdir(path.dirname(this.deps.indexFile), { recursive: true });
    const tmp = `${this.deps.indexFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
    await fs.rename(tmp, this.deps.indexFile);
  }

  private async decorate(entry: StoredEntry): Promise<LibraryEntry> {
    let exists = false;
    try {
      const stat = await fs.stat(entry.path);
      exists = stat.isFile();
    } catch {
      exists = false;
    }
    return { ...entry, exists };
  }

  /** Every file already in the library folder, so a new name doesn't collide on disk. */
  private async folderFiles(): Promise<string[]> {
    try {
      const names = await fs.readdir(this.deps.folder);
      return names.filter((n) => n.toLowerCase().endsWith('.looit'));
    } catch {
      return [];
    }
  }

  private async takenNames(except?: string): Promise<string[]> {
    const index = await this.load();
    const used = index.entries.filter((e) => !except || e.id !== except).map((e) => e.path);
    return [...used, ...(await this.folderFiles())];
  }

  private find(id: string): StoredEntry {
    const entry = this.index?.entries.find((e) => e.id === id);
    if (!entry) throw new Error('That project is no longer in the list.');
    return entry;
  }

  private async write(file: string, project: Parameters<typeof serializeProject>[0]): Promise<void> {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, serializeProject(project), 'utf8');
    await fs.rename(tmp, file);
  }

  /** Reads a project file with the same limits as opening one. */
  private async read(file: string): Promise<string> {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('That path is not a file.');
    if (stat.size > MAX_PROJECT_BYTES) throw new Error('This file is too large to be a Looit project.');
    return fs.readFile(file, 'utf8');
  }

  async snapshot(): Promise<LibrarySnapshot> {
    return this.run(async () => {
      const index = await this.load();
      const entries = await Promise.all(index.entries.map((e) => this.decorate(e)));
      const demo = entries.find((e) => samePath(e.path, this.demoPath)) ?? null;
      // The demo is a normal project too, so it can be renamed, pinned or deleted.
      return { entries: sortEntries(entries), demo, folder: this.deps.folder };
    });
  }

  get demoPath(): string {
    return path.join(this.deps.folder, `${DEMO_NAME}.looit`);
  }

  async create(rawName: string): Promise<OpenedLibraryProject> {
    return this.run(async () => {
      const index = await this.load();
      const name = sanitizeName(rawName);
      await fs.mkdir(this.deps.folder, { recursive: true });
      const file = uniqueFileName(name, await this.takenNames());
      const target = path.join(this.deps.folder, file);
      const project = blankProject();
      project.name = name;
      await this.write(target, project);
      const entry: StoredEntry = {
        id: newId('project'),
        name,
        path: target,
        pinned: false,
        updatedAt: Date.now(),
      };
      index.entries.push(entry);
      await this.persist();
      return { entry: await this.decorate(entry), text: serializeProject(project) };
    });
  }

  /** The demo project, created on first use and reused after that (its edits persist). */
  async demo(): Promise<OpenedLibraryProject> {
    return this.run(async () => {
      const index = await this.load();
      await fs.mkdir(this.deps.folder, { recursive: true });
      const target = this.demoPath;
      let entry = index.entries.find((e) => samePath(e.path, target));
      let text: string;
      try {
        text = await this.read(target);
        parseProject(text); // a corrupt demo is rebuilt rather than offered
      } catch {
        const project = newProject();
        project.name = DEMO_NAME;
        text = serializeProject(project);
        await this.write(target, project);
      }
      if (!entry) {
        entry = { id: newId('project'), name: DEMO_NAME, path: target, pinned: false, updatedAt: 0 };
        index.entries.push(entry);
      }
      entry.updatedAt = Date.now();
      await this.persist();
      return { entry: await this.decorate(entry), text };
    });
  }

  async open(id: string): Promise<OpenedLibraryProject | null> {
    return this.run(async () => {
      await this.load();
      const entry = this.find(id);
      let text: string;
      try {
        text = await this.read(entry.path);
        parseProject(text);
      } catch (err) {
        if (err instanceof ProjectFileError) throw new Error(`${entry.name}: ${err.message}`);
        throw new Error(`"${entry.name}" was moved or deleted. Locate it again, or remove it from the list.`);
      }
      entry.updatedAt = Date.now();
      await this.persist();
      return { entry: await this.decorate(entry), text };
    });
  }

  /** Indexes a file the user opened (already validated by the open dialog). */
  async add(filePath: string, name: string): Promise<LibraryEntry> {
    return this.run(async () => {
      const index = await this.load();
      const existing = index.entries.find((e) => samePath(e.path, filePath));
      if (existing) {
        existing.name = sanitizeName(name, existing.name);
        existing.updatedAt = Date.now();
        await this.persist();
        return this.decorate(existing);
      }
      const entry: StoredEntry = {
        id: newId('project'),
        name: sanitizeName(name, path.basename(filePath, '.looit')),
        path: filePath,
        pinned: false,
        updatedAt: Date.now(),
      };
      index.entries.push(entry);
      await this.persist();
      return this.decorate(entry);
    });
  }

  async rename(id: string, rawName: string): Promise<LibraryEntry> {
    return this.run(async () => {
      await this.load();
      const entry = this.find(id);
      const name = sanitizeName(rawName, entry.name);
      const dir = path.dirname(entry.path);
      const file = uniqueFileName(name, await this.takenNames(entry.id));
      const target = path.join(dir, file);
      if (!samePath(target, entry.path)) {
        try {
          await fs.rename(entry.path, target);
        } catch {
          throw new Error(`"${entry.name}" was moved or deleted, so it cannot be renamed.`);
        }
      }
      // Keep the name inside the file in step with the file name.
      try {
        const project = parseProject(await fs.readFile(target, 'utf8'));
        project.name = name;
        await this.write(target, project);
      } catch {
        // An unreadable project keeps its old contents; the list still shows the new name.
      }
      entry.name = name;
      entry.path = target;
      entry.updatedAt = Date.now();
      await this.persist();
      return this.decorate(entry);
    });
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    return this.run(async () => {
      await this.load();
      const entry = this.find(id);
      entry.pinned = pinned;
      await this.persist();
    });
  }

  async remove(id: string): Promise<void> {
    return this.run(async () => {
      const index = await this.load();
      const entry = this.find(id);
      try {
        await this.deps.trash(entry.path);
      } catch {
        // Already gone (or locked): still remove it from the list.
      }
      index.entries = index.entries.filter((e) => e.id !== id);
      await this.persist();
    });
  }

  /** Copies the project file to `target` (the caller picks it with a dialog). */
  async copyTo(id: string, target: string): Promise<string> {
    return this.run(async () => {
      await this.load();
      const entry = this.find(id);
      await fs.copyFile(entry.path, target);
      return target;
    });
  }

  /** After a save: keep the displayed name and recency current. */
  async noteSaved(filePath: string, name: string): Promise<void> {
    return this.run(async () => {
      const index = await this.load();
      const entry = index.entries.find((e) => samePath(e.path, filePath));
      if (!entry) return;
      entry.name = sanitizeName(name, entry.name);
      entry.updatedAt = Date.now();
      await this.persist();
    });
  }

  async entry(id: string): Promise<LibraryEntry> {
    return this.run(async () => {
      await this.load();
      return this.decorate(this.find(id));
    });
  }
}

function isStoredEntry(value: unknown): value is StoredEntry {
  const e = value as Partial<StoredEntry> | null;
  return (
    !!e &&
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.name === 'string' &&
    typeof e.path === 'string' &&
    e.path.length > 0 &&
    typeof e.pinned === 'boolean' &&
    typeof e.updatedAt === 'number'
  );
}
