import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENT, newProject, newTextObject } from './project';
import { ProjectFileError, parseProject, serializeProject } from './schema';

describe('project files', () => {
  it('round-trips a project unchanged', () => {
    const p = newProject();
    p.objects.push(newTextObject('Hello'));
    expect(parseProject(serializeProject(p))).toEqual(p);
  });

  it('keeps the optional skip-unchanged-frames setting', () => {
    const p = newProject();
    p.output.skipUnchangedFrames = false;
    expect(parseProject(serializeProject(p)).output.skipUnchangedFrames).toBe(false);
    expect(parseProject(serializeProject(newProject())).output.skipUnchangedFrames).toBeUndefined();
  });

  it('rejects non-JSON and foreign files', () => {
    expect(() => parseProject('not json')).toThrow(ProjectFileError);
    expect(() => parseProject('{"hello": 1}')).toThrow('not a Looit project');
  });

  it('rejects files from a newer version', () => {
    const p = { ...newProject(), version: 99 };
    expect(() => parseProject(JSON.stringify(p))).toThrow('newer version');
  });

  it('reports where a value is wrong', () => {
    const p = newProject();
    const i = p.objects.findIndex((o) => o.kind === 'website');
    (p.objects[i] as { url: string }).url = 'file:///C:/secret.txt';
    expect(() => parseProject(serializeProject(p))).toThrow(`project.objects[${i}].url`);
  });

  it('rejects a cursor whose website is missing', () => {
    const p = newProject();
    p.objects = p.objects.filter((o) => o.kind !== 'website');
    expect(() => parseProject(serializeProject(p))).toThrow('website panel is missing');
  });

  it('sorts keyframes that were saved out of order', () => {
    const p = newProject();
    const w = p.objects.find((o) => o.kind === 'website')!;
    if (w.kind !== 'website') throw new Error();
    w.transform.position.keyframes.reverse();
    const parsed = parseProject(serializeProject(p)).objects.find((o) => o.kind === 'website')!;
    if (parsed.kind !== 'website') throw new Error();
    const times = parsed.transform.position.keyframes.map((k) => k.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('camera and environment', () => {
  it('gives old projects (no camera) the default fixed camera', () => {
    const p = newProject();
    p.objects = p.objects.filter((o) => o.kind !== 'camera');
    const cams = parseProject(serializeProject(p)).objects.filter((o) => o.kind === 'camera');
    expect(cams).toHaveLength(1);
    expect(cams[0].kind === 'camera' && cams[0].position.value).toEqual([0, 0, 18]);
  });

  it('rejects a second camera', () => {
    const p = newProject();
    p.objects.push({ ...p.objects.find((o) => o.kind === 'camera')!, id: 'camera-2' });
    expect(() => parseProject(serializeProject(p))).toThrow('only one camera');
  });

  it('round-trips an environment and rejects non-image data', () => {
    const p = newProject();
    p.environment = {
      ...DEFAULT_ENVIRONMENT,
      background: 'image',
      image: 'data:image/png;base64,iVBORw0KGgo=',
      floor: 'grid',
    };
    expect(parseProject(serializeProject(p)).environment).toEqual(p.environment);
    p.environment = { ...p.environment, image: 'data:text/html;base64,PHNjcmlwdD4=' };
    expect(() => parseProject(serializeProject(p))).toThrow('embedded PNG, JPEG or WebP');
  });
});

describe('text overlays and cursor options', () => {
  it('round-trips screen text with a pill and a shadow', () => {
    const p = newProject();
    const text = newTextObject('HUD');
    text.space = 'screen';
    text.screen = { x: 0.5, y: 0.1 };
    text.background = { color: '#000000', opacity: 0.6, padding: 0.4, radius: 0.5 };
    text.shadow = { color: '#000000', opacity: 0.5, offsetX: 0, offsetY: 0.1, blur: 0.2 };
    p.objects.push(text);
    expect(parseProject(serializeProject(p)).objects.find((o) => o.id === text.id)).toEqual(text);
  });

  it('keeps old text files in world space', () => {
    const p = newProject();
    p.objects.push(newTextObject('Plain'));
    const parsed = parseProject(serializeProject(p)).objects.find((o) => o.kind === 'text')!;
    expect(parsed.kind === 'text' && parsed.space).toBeUndefined();
  });

  it('rejects an unknown space and a screen anchor outside 0..1', () => {
    const p = newProject();
    const text = newTextObject('HUD');
    text.space = 'overlay' as never;
    p.objects.push(text);
    expect(() => parseProject(serializeProject(p))).toThrow('expected world or screen');
    text.space = 'screen';
    text.screen = { x: 2, y: 0.5 };
    expect(() => parseProject(serializeProject(p))).toThrow('project.objects[3].screen.x');
  });

  it('keeps the optional fixed-size cursor flag', () => {
    const p = newProject();
    const cursor = p.objects.find((o) => o.kind === 'cursor')!;
    if (cursor.kind !== 'cursor') throw new Error();
    cursor.fixedScreenSize = true;
    expect(
      (parseProject(serializeProject(p)).objects.find((o) => o.kind === 'cursor') as typeof cursor).fixedScreenSize,
    ).toBe(true);
    expect(
      (parseProject(serializeProject(newProject())).objects.find((o) => o.kind === 'cursor') as typeof cursor)
        .fixedScreenSize,
    ).toBeUndefined();
  });
});
