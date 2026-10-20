import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newProject } from '../engine/project';
import { parseProject } from '../engine/schema';
import { DEMO_NAME, Library, sanitizeName, sortEntries, uniqueFileName } from './library';

describe('name and ordering helpers', () => {
  it('makes a project name safe to use as a file name', () => {
    expect(sanitizeName('  My / video: "1"  ')).toBe('My video 1');
    expect(sanitizeName('a\u0000b')).toBe('ab');
    expect(sanitizeName('   ')).toBe('Untitled project');
    expect(sanitizeName('...')).toBe('Untitled project');
    expect(sanitizeName('x'.repeat(200)).length).toBe(80);
  });

  it('puts pinned projects first, then the most recent', () => {
    const a = { name: 'a', pinned: false, updatedAt: 100 };
    const b = { name: 'b', pinned: true, updatedAt: 1 };
    const c = { name: 'c', pinned: false, updatedAt: 300 };
    expect(sortEntries([a, b, c]).map((e) => e.name)).toEqual(['b', 'c', 'a']);
  });

  it('finds a free file name', () => {
    expect(uniqueFileName('Clip', [])).toBe('Clip.looit');
    expect(uniqueFileName('Clip', ['C:\\x\\Clip.looit'])).toBe('Clip 2.looit');
    expect(uniqueFileName('Clip', ['C:\\x\\clip.looit', 'C:\\x\\Clip 2.looit'])).toBe('Clip 3.looit');
  });
});

describe('Library', () => {
  let dir: string;
  let trashed: string[];
  let lib: Library;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'looit-library-'));
    trashed = [];
    lib = new Library({
      indexFile: path.join(dir, 'state', 'projects.json'),
      folder: path.join(dir, 'Looit'),
      trash: async (file) => {
        trashed.push(file);
        await fs.rm(file, { force: true });
      },
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a project file and lists it', async () => {
    const opened = await lib.create('My tour');
    expect(opened.entry.name).toBe('My tour');
    expect(opened.entry.exists).toBe(true);
    const stat = await fs.stat(opened.entry.path);
    expect(stat.isFile()).toBe(true);
    const parsed = parseProject(opened.text);
    expect(parsed.name).toBe('My tour');
    // A new project starts as a blank browser card, not the demo site.
    const website = parsed.objects.find((o) => o.kind === 'website');
    expect(website && website.kind === 'website' && website.url).toBe('');
    expect(parsed.objects.some((o) => o.kind === 'cursor')).toBe(true);

    const snapshot = await lib.snapshot();
    expect(snapshot.entries.map((e) => e.name)).toEqual(['My tour']);
    expect(snapshot.folder).toBe(path.join(dir, 'Looit'));
  });

  it('avoids reusing a name', async () => {
    const first = await lib.create('Clip');
    const second = await lib.create('Clip');
    expect(second.entry.name).toBe('Clip');
    expect(second.entry.path).not.toBe(first.entry.path);
    expect(second.entry.path.endsWith('Clip 2.looit')).toBe(true);
  });

  it('opens, renames and re-reads a project', async () => {
    const created = await lib.create('Old name');
    const renamed = await lib.rename(created.entry.id, 'New name');
    expect(renamed.name).toBe('New name');
    expect(path.basename(renamed.path)).toBe('New name.looit');
    await expect(fs.stat(created.entry.path)).rejects.toThrow();
    const opened = await lib.open(created.entry.id);
    expect(parseProject(opened!.text).name).toBe('New name');
  });

  it('pins a project to the top', async () => {
    const older = await lib.create('Older');
    const newer = await lib.create('Newer');
    await lib.setPinned(older.entry.id, true);
    const snapshot = await lib.snapshot();
    expect(snapshot.entries[0].id).toBe(older.entry.id);
    expect(snapshot.entries[0].pinned).toBe(true);
    expect(snapshot.entries[1].id).toBe(newer.entry.id);
  });

  it('deletes through the trash and forgets the entry', async () => {
    const created = await lib.create('Bye');
    await lib.remove(created.entry.id);
    expect(trashed).toEqual([created.entry.path]);
    const snapshot = await lib.snapshot();
    expect(snapshot.entries).toEqual([]);
    await expect(fs.stat(created.entry.path)).rejects.toThrow();
  });

  it('creates the demo project once and reuses it', async () => {
    const demo = await lib.demo();
    expect(demo.entry.name).toBe(DEMO_NAME);
    expect(demo.entry.exists).toBe(true);
    expect(parseProject(demo.text).name).toBe(DEMO_NAME);
    const again = await lib.demo();
    expect(again.entry.id).toBe(demo.entry.id);
    const snapshot = await lib.snapshot();
    expect(snapshot.demo?.id).toBe(demo.entry.id);
    // It is also a normal project row, so the user can rename or delete it.
    expect(snapshot.entries.map((e) => e.id)).toContain(demo.entry.id);
  });

  it('indexes a file the user opened, and notes saves', async () => {
    const elsewhere = path.join(dir, 'elsewhere.looit');
    await fs.writeFile(elsewhere, JSON.stringify(newProject()), 'utf8');
    const entry = await lib.add(elsewhere, 'Imported');
    expect(entry.name).toBe('Imported');
    expect(entry.exists).toBe(true);
    await lib.noteSaved(elsewhere, 'Renamed outside');
    const snapshot = await lib.snapshot();
    expect(snapshot.entries[0].name).toBe('Renamed outside');
  });

  it('reports a moved file instead of crashing', async () => {
    const created = await lib.create('Gone');
    await fs.rm(created.entry.path);
    const snapshot = await lib.snapshot();
    expect(snapshot.entries[0].exists).toBe(false);
    await expect(lib.open(created.entry.id)).rejects.toThrow(/moved or deleted/);
  });

  it('survives a corrupt index', async () => {
    const broken = new Library({
      indexFile: path.join(dir, 'state', 'broken.json'),
      folder: path.join(dir, 'Looit'),
      trash: async () => {},
    });
    await fs.mkdir(path.join(dir, 'state'), { recursive: true });
    await fs.writeFile(path.join(dir, 'state', 'broken.json'), '{not json', 'utf8');
    expect(await broken.snapshot()).toMatchObject({ entries: [] });
  });
});
