import { describe, expect, it } from 'vitest';
import { applyPatch, type PatchOp } from './patch';
import { newProject, newTextObject, type CursorObject, type TextObject } from './project';
import { ProjectFileError, parseProject, serializeProject } from './schema';

function project() {
  const p = newProject();
  p.objects.push(newTextObject('Hello'));
  return p;
}

const cameraId = (p = project()) => p.objects.find((o) => o.kind === 'camera')!.id;
const cursorOf = (p: ReturnType<typeof project>) => p.objects.find((o): o is CursorObject => o.kind === 'cursor')!;
const textsOf = (p: ReturnType<typeof project>) => p.objects.filter((o): o is TextObject => o.kind === 'text');

/** Pointers that empty a cursor's events, so tests start from a known state. */
function clearEvents(p: ReturnType<typeof project>): PatchOp[] {
  const i = p.objects.findIndex((o) => o.kind === 'cursor');
  return (['clicks', 'scrolls', 'keys'] as const).map((key) => ({
    op: 'set',
    path: `/objects/${i}/${key}`,
    value: [],
  }));
}

describe('applyPatch', () => {
  it('sets a field by JSON Pointer', () => {
    const p = project();
    const next = applyPatch(p, [{ op: 'set', path: '/duration', value: 12 }]);
    expect(next.duration).toBe(12);
    expect(p.duration).toBe(5);
  });

  it('sets nested values and list entries', () => {
    const p = project();
    const website = p.objects.findIndex((o) => o.kind === 'website');
    const next = applyPatch(p, [
      { op: 'set', path: `/objects/${website}/viewport/width`, value: 1440 },
      { op: 'set', path: `/objects/${website}/transform/position/value/0`, value: 2.5 },
    ]);
    const w = next.objects[website] as { viewport: { width: number }; transform: { position: { value: number[] } } };
    expect(w.viewport.width).toBe(1440);
    expect(w.transform.position.value[0]).toBe(2.5);
  });

  it('adds a keyframe to any animatable property', () => {
    const p = project();
    const next = applyPatch(p, [
      { op: 'add_keyframe', object_id: cameraId(p), property: 'zoom', time: 3, value: 1.4, easing: 'easeInOut' },
      { op: 'add_keyframe', object_id: cameraId(p), property: 'zoom', time: 1, value: 1 },
    ]);
    const zoom = (
      next.objects.find((o) => o.kind === 'camera') as { zoom: { keyframes: { time: number; easing?: string }[] } }
    ).zoom;
    expect(zoom.keyframes.map((k) => k.time)).toEqual([1, 3]);
    expect(zoom.keyframes[1].easing).toBe('easeInOut');
  });

  it('rejects a keyframe with a bad value and leaves the project alone', () => {
    const p = project();
    const before = serializeProject(p);
    expect(() =>
      applyPatch(p, [{ op: 'add_keyframe', object_id: cameraId(p), property: 'zoom', time: 1, value: 'big' as never }]),
    ).toThrow(ProjectFileError);
    expect(serializeProject(p)).toBe(before);
  });

  it('names the failing operation', () => {
    const p = project();
    expect(() =>
      applyPatch(p, [
        { op: 'set', path: '/duration', value: 10 },
        { op: 'add_keyframe', object_id: 'nope', property: 'zoom', time: 1, value: 2 },
      ]),
    ).toThrow(/^patch\[1\] /);
  });

  it('adds cursor events', () => {
    const p = applyPatch(project(), clearEvents(project()));
    const c = cursorOf(p);
    const next = applyPatch(p, [
      { op: 'add_event', object_id: c.id, kind: 'click', time: 2 },
      { op: 'add_event', object_id: c.id, kind: 'scroll', time: 3, deltaY: 400 },
      { op: 'add_event', object_id: c.id, kind: 'type', time: 4, text: 'hi', cps: 10 },
    ]);
    const nc = cursorOf(next);
    expect(nc.clicks.map((e) => e.time)).toEqual([2]);
    expect(nc.scrolls[0].deltaY).toBe(400);
    expect(nc.keys[0]).toMatchObject({ kind: 'type', text: 'hi', cps: 10 });
  });

  it('removes an event by id', () => {
    const p = applyPatch(project(), clearEvents(project()));
    const c = cursorOf(p);
    const withEvent = applyPatch(p, [{ op: 'add_event', object_id: c.id, kind: 'click', time: 2 }]);
    const clickId = cursorOf(withEvent).clicks[0].id;
    const next = applyPatch(withEvent, [{ op: 'remove_event', object_id: c.id, id: clickId }]);
    expect(cursorOf(next).clicks).toEqual([]);
  });

  it('removes a website panel and its cursor together', () => {
    const p = project();
    const website = p.objects.find((o) => o.kind === 'website')!;
    const next = applyPatch(p, [{ op: 'remove_object', id: website.id }]);
    expect(next.objects.some((o) => o.kind === 'cursor')).toBe(false);
  });

  it('adds an object and keeps the project valid', () => {
    const p = project();
    const text = newTextObject('HUD');
    const next = applyPatch(p, [
      { op: 'add_object', object: { ...text, id: 'text-2' } },
      { op: 'set', path: '/name', value: 'Patched' },
    ]);
    expect(() => parseProject(serializeProject(next))).not.toThrow();
    expect(next.name).toBe('Patched');
    expect(textsOf(next)).toHaveLength(2);
  });

  it('refuses an empty or unknown patch', () => {
    expect(() => applyPatch(project(), [])).toThrow('non-empty');
    expect(() => applyPatch(project(), [{ op: 'nope' } as unknown as PatchOp])).toThrow('unknown operation');
  });
});
