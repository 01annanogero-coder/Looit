import { describe, expect, it } from 'vitest';
import { applyCameraPreset, applyObjectPreset } from './presets';
import { cameraOf, newProject, newTextObject, sample } from './project';

describe('animation presets', () => {
  it('fades in to the current opacity and stays hidden before', () => {
    const text = newTextObject('Hi');
    applyObjectPreset(text, 'fadeIn', 2, 1);
    expect(sample(text.transform.opacity, 0)).toBe(0);
    expect(sample(text.transform.opacity, 3)).toBe(1);
    expect(sample(text.transform.opacity, 2.5)).toBeGreaterThan(0);
  });

  it('flies in to where the object already is', () => {
    const text = newTextObject('Hi');
    text.transform.position.value = [1, 2, 3];
    applyObjectPreset(text, 'flyIn', 0, 1.5);
    expect(sample(text.transform.position, 1.5)).toEqual([1, 2, 3]);
    expect(sample(text.transform.position, 0)).not.toEqual([1, 2, 3]);
  });

  it('replaces keyframes inside the window and keeps the ones outside', () => {
    const text = newTextObject('Hi');
    const o = text.transform.opacity;
    o.keyframes = [
      { id: 'a', time: 0, value: 1 },
      { id: 'b', time: 1.5, value: 0.2 },
      { id: 'c', time: 5, value: 1 },
    ];
    applyObjectPreset(text, 'fadeOut', 1, 1);
    expect(o.keyframes.map((k) => k.time)).toEqual([0, 1, 2, 5]);
    expect(o.keyframes.find((k) => k.id === 'b')).toBeUndefined();
  });

  it('zooms the camera and pushes it toward its target', () => {
    const cam = cameraOf(newProject());
    applyCameraPreset(cam, 'zoomIn', 0, 2);
    expect(sample(cam.zoom, 2)).toBeCloseTo(1.5);
    applyCameraPreset(cam, 'pushIn', 2, 1);
    const [, , z] = sample(cam.position, 3);
    expect(z).toBeCloseTo(18 * 0.65);
    expect(sample(cam.zoom, 3)).toBeCloseTo(1.5);
  });
});
