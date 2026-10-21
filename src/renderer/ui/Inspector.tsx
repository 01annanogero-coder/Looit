// Right-hand inspector: Properties (of the selected object or the scene) and
// Animation (easing and timing of selected keyframes).

import type { Draft } from 'immer';
import { Keyboard, MousePointerClick, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import * as THREE from 'three';
import type { Easing, Vec2 } from '../../engine/animation';
import { keyframeAt, setValueAt } from '../../engine/edit';
import {
  DEFAULT_TYPING_CPS,
  environmentOf,
  evaluateTransform,
  SPECIAL_KEYS,
  getAnimated,
  hasTransform,
  newId,
  sample,
  type Animated,
  type CameraObject,
  type CursorKeys,
  type CursorObject,
  type CursorStyle,
  type WindowFrame,
  type SpecialKey,
  type Project,
  type PropName,
  type SceneObject,
  type TextObject,
  type TransformObject,
  type WebsiteObject,
} from '../../engine/project';
import { MAX_DURATION } from '../../engine/schema';
import { CAMERA_PRESETS, OBJECT_PRESETS } from '../../engine/presets';
import { applyPreset, pickBackgroundImage, setEnvironment, toggleKey } from '../actions';
import { edit, getEditor, isCursorEventProp, useEditor, type KeyRef } from '../store';
import { reloadWebsite } from '../viewport/runtime';
import { PANEL_WIDTH } from '../viewport/scene-view';
import { ColorField, NumberField, Row, Section, TextField, Toggle, VecRow, type KeyState } from './controls';

function keyState(a: Animated<unknown>, time: number): KeyState {
  if (a.keyframes.length === 0) return 'static';
  return keyframeAt(a, time) ? 'keyed' : 'animated';
}

/** Edits one object in the project by id. */
function editObject<K extends SceneObject['kind']>(
  id: string,
  fn: (o: Draft<Extract<SceneObject, { kind: K }>>, p: Draft<Project>) => void,
  mergeKey?: string,
): void {
  edit((p) => {
    const o = p.objects.find((x) => x.id === id);
    if (o) fn(o as Draft<Extract<SceneObject, { kind: K }>>, p);
  }, mergeKey);
}

/** Drops floating-point noise (e.g. -1.1159999999) from interpolated components. */
const tidy = (v: number) => Math.round(v * 1e4) / 1e4;
const DEG = Math.PI / 180;

function setAnimated(id: string, prop: PropName, raw: number | number[], gesture: boolean): void {
  const time = getEditor().time;
  const value = typeof raw === 'number' ? tidy(raw) : raw.map(tidy);
  editObject(
    id,
    (o) => {
      const a = getAnimated(o as SceneObject, prop);
      if (a) setValueAt(a as Animated<number | number[]>, time, value);
    },
    gesture ? `prop:${id}:${prop}` : undefined,
  );
}

function TransformSection({
  obj,
  time,
  opacityOnly = false,
}: {
  obj: TransformObject;
  time: number;
  opacityOnly?: boolean;
}) {
  const t = obj.transform;
  return (
    <Section title="Transform">
      {!opacityOnly && (
        <>
          <VecRow
            label="Position"
            value={sample(t.position, time)}
            step={0.05}
            onChange={(v, g) => setAnimated(obj.id, 'position', v, g)}
            keyState={keyState(t.position, time)}
            onToggleKey={() => toggleKey(obj.id, 'position')}
          />
          <VecRow
            label="Rotation"
            value={sample(t.rotation, time)}
            step={0.5}
            precision={1}
            suffix="°"
            onChange={(v, g) => setAnimated(obj.id, 'rotation', v, g)}
            keyState={keyState(t.rotation, time)}
            onToggleKey={() => toggleKey(obj.id, 'rotation')}
          />
          <VecRow
            label="Scale"
            value={sample(t.scale, time)}
            step={0.01}
            onChange={(v, g) => setAnimated(obj.id, 'scale', v, g)}
            keyState={keyState(t.scale, time)}
            onToggleKey={() => toggleKey(obj.id, 'scale')}
          />
        </>
      )}
      <VecRow
        label="Opacity"
        value={[sample(t.opacity, time)]}
        axes={['']}
        step={0.01}
        onChange={(v, g) => setAnimated(obj.id, 'opacity', Math.min(Math.max(v[0], 0), 1), g)}
        keyState={keyState(t.opacity, time)}
        onToggleKey={() => toggleKey(obj.id, 'opacity')}
      />
    </Section>
  );
}

const VIEWPORTS = [
  { label: 'Laptop 1280 × 720', width: 1280, height: 720 },
  { label: 'Laptop 1366 × 768', width: 1366, height: 768 },
  { label: 'Desktop 1440 × 900', width: 1440, height: 900 },
  { label: 'Desktop 1920 × 1080', width: 1920, height: 1080 },
];

function WebsiteProps({ obj, time }: { obj: WebsiteObject; time: number }) {
  const vpKey = `${obj.viewport.width}x${obj.viewport.height}`;
  return (
    <>
      <Section title="Website Panel">
        <Row label="URL">
          <div className="url-row">
            <TextField
              value={obj.url}
              placeholder="https://example.com"
              onCommit={(raw) => {
                let url = raw.trim();
                if (url === '') {
                  // Back to a blank card: no page, just the browser window.
                  editObject<'website'>(obj.id, (o) => {
                    o.url = '';
                  });
                  return;
                }
                if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
                try {
                  const { protocol } = new URL(url);
                  if (protocol !== 'http:' && protocol !== 'https:') return;
                } catch {
                  return;
                }
                editObject<'website'>(obj.id, (o) => {
                  o.url = url;
                });
              }}
            />
            <button className="icon-btn" title="Reload website" onClick={reloadWebsite}>
              <RotateCw size={14} />
            </button>
          </div>
        </Row>
        <Row label="Browser size">
          <select
            value={vpKey}
            onChange={(e) => {
              const vp = VIEWPORTS.find((v) => `${v.width}x${v.height}` === e.target.value);
              if (vp)
                editObject<'website'>(obj.id, (o) => {
                  o.viewport = { width: vp.width, height: vp.height };
                });
            }}
          >
            {VIEWPORTS.map((v) => (
              <option key={v.label} value={`${v.width}x${v.height}`}>
                {v.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Interaction">
          <Toggle
            checked={obj.interactive}
            label="Clickable in editor"
            onChange={(v) =>
              editObject<'website'>(obj.id, (o) => {
                o.interactive = v;
              })
            }
          />
        </Row>
      </Section>
      <Section title="Shadow">
        <Row label="Enabled">
          <Toggle
            checked={obj.shadow.enabled}
            onChange={(v) =>
              editObject<'website'>(obj.id, (o) => {
                o.shadow.enabled = v;
              })
            }
          />
        </Row>
        <Row label="Color">
          <ColorField
            value={obj.shadow.color}
            onChange={(v) =>
              editObject<'website'>(
                obj.id,
                (o) => {
                  o.shadow.color = v;
                },
                `shadow-color:${obj.id}`,
              )
            }
          />
        </Row>
        <Row label="Opacity">
          <NumberField
            value={obj.shadow.opacity}
            min={0}
            max={1}
            label="↔"
            onChange={(v, g) =>
              editObject<'website'>(
                obj.id,
                (o) => {
                  o.shadow.opacity = v;
                },
                g ? `shadow-op:${obj.id}` : undefined,
              )
            }
          />
        </Row>
        <Row label="Blur">
          <NumberField
            value={obj.shadow.blur}
            min={0}
            max={10}
            step={0.05}
            label="↔"
            onChange={(v, g) =>
              editObject<'website'>(
                obj.id,
                (o) => {
                  o.shadow.blur = v;
                },
                g ? `shadow-blur:${obj.id}` : undefined,
              )
            }
          />
        </Row>
        <Row label="Drop">
          <NumberField
            value={obj.shadow.offsetY}
            min={-10}
            max={10}
            step={0.02}
            label="↕"
            title="How far the shadow falls below the panel. 0 with a bright colour makes a glow."
            onChange={(v, g) =>
              editObject<'website'>(
                obj.id,
                (o) => {
                  o.shadow.offsetY = v;
                },
                g ? `shadow-drop:${obj.id}` : undefined,
              )
            }
          />
        </Row>
      </Section>
      <WindowSection obj={obj} />
      {/* Last, so the address and page settings are what a new panel shows first. */}
      <TransformSection obj={obj} time={time} />
    </>
  );
}

function WindowSection({ obj }: { obj: WebsiteObject }) {
  return (
    <Section title="Window">
      <Row label="Frame">
        <select
          value={obj.frame}
          onChange={(e) =>
            editObject<'website'>(obj.id, (o) => {
              o.frame = e.target.value as WindowFrame;
            })
          }
        >
          <option value="none">None (page only)</option>
          <option value="light">Browser, light</option>
          <option value="dark">Browser, dark</option>
        </select>
      </Row>
      <Row label="Corners">
        <NumberField
          value={obj.cornerRadius}
          min={0}
          max={400}
          step={1}
          precision={0}
          suffix=" px"
          label="↔"
          title="Corner radius, in website pixels"
          onChange={(v, g) =>
            editObject<'website'>(
              obj.id,
              (o) => {
                o.cornerRadius = v;
              },
              g ? `corners:${obj.id}` : undefined,
            )
          }
        />
      </Row>
      <Row label="Border">
        <NumberField
          value={obj.border.width}
          min={0}
          max={200}
          step={1}
          precision={0}
          suffix=" px"
          label="↔"
          title="Border width, in website pixels (0 = none)"
          onChange={(v, g) =>
            editObject<'website'>(
              obj.id,
              (o) => {
                o.border.width = v;
              },
              g ? `border:${obj.id}` : undefined,
            )
          }
        />
      </Row>
      {obj.border.width > 0 && (
        <Row label="Border color">
          <ColorField
            value={obj.border.color}
            onChange={(v) =>
              editObject<'website'>(
                obj.id,
                (o) => {
                  o.border.color = v;
                },
                `border-color:${obj.id}`,
              )
            }
          />
        </Row>
      )}
    </Section>
  );
}

function TextProps({ obj, time }: { obj: TextObject; time: number }) {
  const screen = obj.space === 'screen';
  const bg = obj.background ?? null;
  const shadow = obj.shadow ?? null;
  const setBackground = (patch: Partial<NonNullable<TextObject['background']>>) =>
    editObject<'text'>(obj.id, (o) => {
      o.background = o.background ? { ...o.background, ...patch } : null;
    });
  const setShadow = (patch: Partial<NonNullable<TextObject['shadow']>>) =>
    editObject<'text'>(obj.id, (o) => {
      o.shadow = o.shadow ? { ...o.shadow, ...patch } : null;
    });
  return (
    <>
      <Section title="Text">
        <Row label="Content">
          <TextField
            multiline
            value={obj.text}
            onCommit={(v) =>
              editObject<'text'>(obj.id, (o) => {
                o.text = v.slice(0, 2000);
              })
            }
          />
        </Row>
        <Row label="Placement">
          <select
            value={screen ? 'screen' : 'world'}
            onChange={(e) =>
              editObject<'text'>(obj.id, (o) => {
                if (e.target.value === 'screen') {
                  o.space = 'screen';
                  o.screen = o.screen ?? { x: 0.5, y: 0.12 };
                  // World sizes (roughly 0.1–20) do not mean anything as fractions.
                  if (o.size > 0.6) o.size = 0.08;
                } else {
                  o.space = 'world';
                  if (o.size < 0.6) o.size = 1.2;
                }
              })
            }
          >
            <option value="world">In the scene</option>
            <option value="screen">On screen (HUD)</option>
          </select>
        </Row>
        {screen && (
          <Row label="Anchor">
            <div className="vec" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <NumberField
                value={Math.round((obj.screen?.x ?? 0.5) * 100)}
                min={0}
                max={100}
                step={1}
                precision={0}
                suffix="%"
                title="Horizontal position: 0% = left edge, 100% = right edge."
                onChange={(v) =>
                  editObject<'text'>(obj.id, (o) => {
                    o.screen = { x: Math.min(Math.max(v, 0), 100) / 100, y: o.screen?.y ?? 0.5 };
                  })
                }
              />
              <NumberField
                value={Math.round((obj.screen?.y ?? 0.5) * 100)}
                min={0}
                max={100}
                step={1}
                precision={0}
                suffix="%"
                title="Vertical position: 0% = top edge, 100% = bottom edge."
                onChange={(v) =>
                  editObject<'text'>(obj.id, (o) => {
                    o.screen = { x: o.screen?.x ?? 0.5, y: Math.min(Math.max(v, 0), 100) / 100 };
                  })
                }
              />
            </div>
          </Row>
        )}
        <Row label="Size">
          <NumberField
            value={screen ? Math.round(obj.size * 1000) / 10 : obj.size}
            min={screen ? 1 : 0.1}
            max={screen ? 60 : 20}
            step={screen ? 0.5 : 0.02}
            precision={screen ? 1 : 2}
            suffix={screen ? '% of frame' : undefined}
            title={screen ? 'Text height as a percentage of the video height.' : 'Line height in world units.'}
            onChange={(v, g) =>
              editObject<'text'>(
                obj.id,
                (o) => {
                  o.size = screen ? Math.min(Math.max(v, 1), 60) / 100 : v;
                },
                g ? `text-size:${obj.id}` : undefined,
              )
            }
          />
        </Row>
        <Row label="Color">
          <ColorField
            value={obj.color}
            onChange={(v) =>
              editObject<'text'>(
                obj.id,
                (o) => {
                  o.color = v;
                },
                `text-color:${obj.id}`,
              )
            }
          />
        </Row>
        <Row label="Weight">
          <select
            value={obj.weight}
            onChange={(e) =>
              editObject<'text'>(obj.id, (o) => {
                o.weight = Number(e.target.value) as TextObject['weight'];
              })
            }
          >
            <option value={400}>Regular</option>
            <option value={600}>Semibold</option>
            <option value={700}>Bold</option>
          </select>
        </Row>
      </Section>
      <Section title="Readability">
        <Row label="Pill">
          <Toggle
            checked={!!bg}
            onChange={(on) =>
              editObject<'text'>(obj.id, (o) => {
                o.background = on ? { color: '#0b1220', opacity: 0.65, padding: 0.45, radius: 0.5 } : null;
              })
            }
          />
        </Row>
        {bg && (
          <>
            <Row label="Fill">
              <ColorField value={bg.color} onChange={(v) => setBackground({ color: v })} />
            </Row>
            <Row label="Fill opacity">
              <NumberField
                value={bg.opacity}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setBackground({ opacity: Math.min(Math.max(v, 0), 1) })}
              />
            </Row>
            <Row label="Padding">
              <NumberField
                value={bg.padding}
                min={0}
                max={2}
                step={0.05}
                title="Space around the text, in multiples of its height."
                onChange={(v) => setBackground({ padding: Math.min(Math.max(v, 0), 2) })}
              />
            </Row>
            <Row label="Corner">
              <NumberField
                value={bg.radius}
                min={0}
                max={2}
                step={0.05}
                title="Corner roundness, in multiples of the text height."
                onChange={(v) => setBackground({ radius: Math.min(Math.max(v, 0), 2) })}
              />
            </Row>
          </>
        )}
        <Row label="Shadow">
          <Toggle
            checked={!!shadow}
            onChange={(on) =>
              editObject<'text'>(obj.id, (o) => {
                o.shadow = on ? { color: '#000000', opacity: 0.6, offsetX: 0, offsetY: 0.08, blur: 0.15 } : null;
              })
            }
          />
        </Row>
        {shadow && (
          <>
            <Row label="Shadow color">
              <ColorField value={shadow.color} onChange={(v) => setShadow({ color: v })} />
            </Row>
            <Row label="Shadow opacity">
              <NumberField
                value={shadow.opacity}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setShadow({ opacity: Math.min(Math.max(v, 0), 1) })}
              />
            </Row>
            <Row label="Shadow drop">
              <NumberField
                value={shadow.offsetY}
                min={-2}
                max={2}
                step={0.02}
                title="How far the shadow falls below the text, in multiples of its height."
                onChange={(v) => setShadow({ offsetY: Math.min(Math.max(v, -2), 2) })}
              />
            </Row>
            <Row label="Shadow blur">
              <NumberField
                value={shadow.blur}
                min={0}
                max={2}
                step={0.02}
                onChange={(v) => setShadow({ blur: Math.min(Math.max(v, 0), 2) })}
              />
            </Row>
          </>
        )}
        <p className="hint">
          {screen
            ? 'Pinned to the frame: camera moves and zooms do not move it. Only opacity can be animated.'
            : 'A pill or shadow keeps light text readable over a busy page.'}
        </p>
      </Section>
      <TransformSection obj={obj} time={time} opacityOnly={screen} />
    </>
  );
}

function CursorProps({ obj, time }: { obj: CursorObject; time: number }) {
  const pos = sample(obj.position, time);
  return (
    <>
      <Section title="Cursor">
        <VecRow
          label="Position"
          value={pos}
          axes={['X', 'Y']}
          step={2}
          precision={0}
          suffix="px"
          onChange={(v, g) => setAnimated(obj.id, 'cursor', v as Vec2, g)}
          keyState={keyState(obj.position, time)}
          onToggleKey={() => toggleKey(obj.id, 'cursor')}
        />
        <Row label="Size">
          <NumberField
            value={obj.size}
            min={0.1}
            max={3}
            step={0.01}
            label="↔"
            onChange={(v, g) =>
              editObject<'cursor'>(
                obj.id,
                (o) => {
                  o.size = v;
                },
                g ? `cursor-size:${obj.id}` : undefined,
              )
            }
          />
        </Row>
        <Row label="Same size when zoomed">
          <Toggle
            checked={obj.fixedScreenSize === true}
            onChange={(v) =>
              editObject<'cursor'>(obj.id, (o) => {
                o.fixedScreenSize = v;
              })
            }
          />
        </Row>
        <Row label="Style">
          <select
            value={obj.style}
            onChange={(e) =>
              editObject<'cursor'>(obj.id, (o) => {
                o.style = e.target.value as CursorStyle;
              })
            }
          >
            <option value="arrow">Arrow</option>
            <option value="arrow-white">Arrow, white</option>
            <option value="hand">Hand (link pointer)</option>
            <option value="ibeam">Text I-beam</option>
            <option value="dot">Touch dot</option>
          </select>
        </Row>
        <Row label="Click ring">
          <ColorField
            value={obj.clickColor}
            onChange={(v) =>
              editObject<'cursor'>(
                obj.id,
                (o) => {
                  o.clickColor = v;
                },
                `click-color:${obj.id}`,
              )
            }
          />
        </Row>
        <p className="hint">
          Position is in website pixels. Tip: set the playhead, then type or drag a position to add a keyframe.
        </p>
      </Section>
      <Section title="Clicks">
        {obj.clicks.length === 0 && <p className="hint">No clicks yet.</p>}
        {[...obj.clicks]
          .sort((a, b) => a.time - b.time)
          .map((c) => (
            <div className="event-row" key={c.id}>
              <MousePointerClick size={14} />
              <NumberField
                value={c.time}
                min={0}
                max={useEditor.getState().project.duration}
                step={1 / 30}
                suffix=" s"
                onChange={(v) =>
                  editObject<'cursor'>(obj.id, (o) => {
                    const ev = o.clicks.find((x) => x.id === c.id);
                    if (ev) ev.time = v;
                  })
                }
              />
              <button
                className="icon-btn"
                title="Delete click"
                onClick={() =>
                  editObject<'cursor'>(obj.id, (o) => {
                    o.clicks = o.clicks.filter((x) => x.id !== c.id);
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        <button
          className="wide-btn"
          onClick={() =>
            editObject<'cursor'>(obj.id, (o) => {
              if (!o.clicks.some((c) => Math.abs(c.time - time) < 1e-4)) o.clicks.push({ id: newId('click'), time });
            })
          }
        >
          <Plus size={14} /> Add click at playhead
        </button>
      </Section>
      <Section title="Scrolls">
        {obj.scrolls.length === 0 && <p className="hint">No scrolls yet.</p>}
        {[...obj.scrolls]
          .sort((a, b) => a.time - b.time)
          .map((s) => (
            <div className="event-row" key={s.id}>
              <NumberField
                value={s.time}
                min={0}
                step={1 / 30}
                suffix=" s"
                onChange={(v) =>
                  editObject<'cursor'>(obj.id, (o) => {
                    const ev = o.scrolls.find((x) => x.id === s.id);
                    if (ev) ev.time = v;
                  })
                }
              />
              <NumberField
                value={s.deltaY}
                step={10}
                precision={0}
                suffix=" px"
                title="Scroll distance (positive scrolls down)"
                onChange={(v) =>
                  editObject<'cursor'>(obj.id, (o) => {
                    const ev = o.scrolls.find((x) => x.id === s.id);
                    if (ev) ev.deltaY = v;
                  })
                }
              />
              <button
                className="icon-btn"
                title="Delete scroll"
                onClick={() =>
                  editObject<'cursor'>(obj.id, (o) => {
                    o.scrolls = o.scrolls.filter((x) => x.id !== s.id);
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        <button
          className="wide-btn"
          onClick={() =>
            editObject<'cursor'>(obj.id, (o) => {
              o.scrolls.push({ id: newId('scroll'), time, deltaY: 400 });
            })
          }
        >
          <Plus size={14} /> Add scroll at playhead
        </button>
      </Section>
      <KeysSection obj={obj} time={time} />
    </>
  );
}

const KEY_LABELS: Record<SpecialKey, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Esc',
  ArrowUp: 'Arrow up',
  ArrowDown: 'Arrow down',
  ArrowLeft: 'Arrow left',
  ArrowRight: 'Arrow right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page up',
  PageDown: 'Page down',
};

/** Typing and key presses: they go to whatever is focused on the page (click a field first). */
function KeysSection({ obj, time }: { obj: CursorObject; time: number }) {
  const editKey = (id: string, fn: (k: Draft<CursorKeys>) => void) =>
    editObject<'cursor'>(obj.id, (o) => {
      const k = o.keys.find((x) => x.id === id);
      if (k) fn(k);
    });
  return (
    <Section title="Typing & keys">
      {obj.keys.length === 0 && (
        <p className="hint">Make the cursor click a text field first, then add typing at the moment it should start.</p>
      )}
      {[...obj.keys]
        .sort((a, b) => a.time - b.time)
        .map((k) => (
          <div className="key-event" key={k.id}>
            <div className="event-row">
              <Keyboard size={14} />
              <NumberField
                value={k.time}
                min={0}
                step={1 / 30}
                suffix=" s"
                title="Start time"
                onChange={(v) =>
                  editKey(k.id, (x) => {
                    x.time = v;
                  })
                }
              />
              <button
                className="icon-btn"
                title="Delete"
                onClick={() =>
                  editObject<'cursor'>(obj.id, (o) => {
                    o.keys = o.keys.filter((x) => x.id !== k.id);
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
            {k.kind === 'type' ? (
              <>
                <TextField
                  value={k.text}
                  placeholder="Text to type"
                  onCommit={(v) =>
                    editKey(k.id, (x) => {
                      if (x.kind === 'type') x.text = v.slice(0, 5000);
                    })
                  }
                />
                <Row label="Speed">
                  <NumberField
                    value={k.cps}
                    min={1}
                    max={100}
                    step={0.5}
                    precision={1}
                    suffix=" chars/s"
                    label="↔"
                    onChange={(v, g) =>
                      editObject<'cursor'>(
                        obj.id,
                        (o) => {
                          const x = o.keys.find((y) => y.id === k.id);
                          if (x?.kind === 'type') x.cps = v;
                        },
                        g ? `cps:${k.id}` : undefined,
                      )
                    }
                  />
                </Row>
                <p className="hint">Takes {(Math.max(k.text.length - 1, 0) / k.cps).toFixed(2)} s.</p>
              </>
            ) : (
              <Row label="Key">
                <select
                  value={k.key}
                  onChange={(e) =>
                    editKey(k.id, (x) => {
                      if (x.kind === 'press') x.key = e.target.value as SpecialKey;
                    })
                  }
                >
                  {SPECIAL_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {KEY_LABELS[key]}
                    </option>
                  ))}
                </select>
              </Row>
            )}
          </div>
        ))}
      <div className="btn-pair">
        <button
          className="wide-btn"
          onClick={() =>
            editObject<'cursor'>(obj.id, (o) => {
              o.keys.push({ id: newId('keys'), time, kind: 'type', text: 'Hello', cps: DEFAULT_TYPING_CPS });
            })
          }
        >
          <Plus size={14} /> Type text
        </button>
        <button
          className="wide-btn"
          onClick={() =>
            editObject<'cursor'>(obj.id, (o) => {
              o.keys.push({ id: newId('keys'), time, kind: 'press', key: 'Enter' });
            })
          }
        >
          <Plus size={14} /> Press key
        </button>
      </div>
    </Section>
  );
}

function CameraProps({ obj, time }: { obj: CameraObject; time: number }) {
  /** Where the cursor is on its page, in world units (panel transform applied). */
  const aimAtCursor = (): void => {
    const project = getEditor().project;
    const cursor = project.objects.find((o): o is CursorObject => o.kind === 'cursor' && o.visible);
    if (!cursor) return;
    const panel = project.objects.find((o): o is WebsiteObject => o.kind === 'website' && o.id === cursor.targetId);
    if (!panel) return;
    const [px, py] = sample(cursor.position, time);
    const w = PANEL_WIDTH;
    const h = (w * panel.viewport.height) / panel.viewport.width;
    const point = new THREE.Vector3((px / panel.viewport.width - 0.5) * w, (0.5 - py / panel.viewport.height) * h, 0);
    const t = evaluateTransform(panel.transform, time);
    point.multiply(new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]));
    point.applyEuler(new THREE.Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG));
    point.add(new THREE.Vector3(t.position[0], t.position[1], t.position[2]));
    setAnimated(obj.id, 'target', [point.x, point.y, point.z], false);
  };
  return (
    <Section title="Camera">
      <VecRow
        label="Position"
        value={sample(obj.position, time)}
        step={0.05}
        onChange={(v, g) => setAnimated(obj.id, 'position', v, g)}
        keyState={keyState(obj.position, time)}
        onToggleKey={() => toggleKey(obj.id, 'position')}
      />
      <VecRow
        label="Look at"
        value={sample(obj.target, time)}
        step={0.05}
        onChange={(v, g) => setAnimated(obj.id, 'target', v, g)}
        keyState={keyState(obj.target, time)}
        onToggleKey={() => toggleKey(obj.id, 'target')}
      />
      <VecRow
        label="Zoom"
        value={[sample(obj.zoom, time)]}
        axes={['']}
        step={0.01}
        onChange={(v, g) => setAnimated(obj.id, 'zoom', Math.min(Math.max(v[0], 0.1), 20), g)}
        keyState={keyState(obj.zoom, time)}
        onToggleKey={() => toggleKey(obj.id, 'zoom')}
      />
      <Row label="Framing">
        <button onClick={aimAtCursor} title="Move 'Look at' to the spot under the cursor, so it sits in the middle">
          Aim at the cursor
        </button>
      </Row>
      <p className="hint">
        The camera stays still unless you add keyframes. Try the presets in the Animation tab for zooms and pans;{' '}
        <em>Aim at the cursor</em> centres whatever the cursor points at, then raise Zoom to close in.
      </p>
    </Section>
  );
}

function SceneProps({ project }: { project: Project }) {
  return (
    <Section title="Scene">
      <Row label="Project">
        <TextField
          value={project.name}
          onCommit={(v) =>
            edit((p) => {
              p.name = v.trim().slice(0, 200) || 'Untitled project';
            })
          }
        />
      </Row>
      <Row label="Duration">
        <NumberField
          value={project.duration}
          min={1}
          max={MAX_DURATION}
          step={0.1}
          precision={1}
          suffix=" s"
          label="↔"
          onChange={(v, g) =>
            edit(
              (p) => {
                p.duration = v;
              },
              g ? 'duration' : undefined,
            )
          }
        />
      </Row>
    </Section>
  );
}

function EnvironmentSection({ project }: { project: Project }) {
  const env = environmentOf(project);
  const setColor = (v: string) =>
    edit((p) => {
      p.background = v;
    }, 'background');
  return (
    <Section title="Environment">
      <Row label="Background">
        <select
          value={env.background}
          onChange={(e) => {
            const background = e.target.value as typeof env.background;
            if (background === 'image' && !env.image) void pickBackgroundImage();
            else setEnvironment({ background });
          }}
        >
          <option value="solid">Solid colour</option>
          <option value="gradient">Gradient</option>
          <option value="image">Image…</option>
        </select>
      </Row>
      {env.background !== 'image' && (
        <Row label={env.background === 'gradient' ? 'From' : 'Colour'}>
          <ColorField value={project.background} onChange={setColor} />
        </Row>
      )}
      {env.background === 'gradient' && (
        <>
          <Row label="To">
            <ColorField value={env.gradientTo} onChange={(v) => setEnvironment({ gradientTo: v }, 'gradient-to')} />
          </Row>
          <Row label="Angle">
            <NumberField
              value={env.gradientAngle}
              min={-360}
              max={360}
              step={1}
              precision={0}
              suffix="°"
              label="∠"
              onChange={(v, g) => setEnvironment({ gradientAngle: v }, g ? 'gradient-angle' : undefined)}
            />
          </Row>
        </>
      )}
      {env.background === 'image' && (
        <Row label="Image">
          <div className="btn-pair">
            <button className="wide-btn" onClick={() => void pickBackgroundImage()}>
              Change…
            </button>
            <button className="wide-btn" onClick={() => setEnvironment({ background: 'solid', image: null })}>
              Remove
            </button>
          </div>
        </Row>
      )}
      <Row label="Floor">
        <select value={env.floor} onChange={(e) => setEnvironment({ floor: e.target.value as typeof env.floor })}>
          <option value="none">None</option>
          <option value="reflection">Reflection</option>
          <option value="grid">Grid</option>
        </select>
      </Row>
      {env.floor !== 'none' && (
        <>
          <Row label="Floor colour">
            <ColorField value={env.floorColor} onChange={(v) => setEnvironment({ floorColor: v }, 'floor-color')} />
          </Row>
          <Row label="Height">
            <NumberField
              value={env.floorY}
              min={-100}
              max={100}
              step={0.05}
              precision={2}
              label="Y"
              onChange={(v, g) => setEnvironment({ floorY: v }, g ? 'floor-y' : undefined)}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

function PropertiesTab() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const time = useEditor((s) => s.time);
  const obj = project.objects.find((o) => o.id === selectedId);
  if (!obj)
    return (
      <>
        <SceneProps project={project} />
        <EnvironmentSection project={project} />
      </>
    );
  return (
    <>
      <Section title="Object">
        <Row label="Name">
          <TextField
            value={obj.name}
            onCommit={(v) =>
              editObject(obj.id, (o) => {
                o.name = v.trim().slice(0, 200) || o.name;
              })
            }
          />
        </Row>
      </Section>
      {obj.kind === 'website' && <WebsiteProps obj={obj} time={time} />}
      {obj.kind === 'text' && <TextProps obj={obj} time={time} />}
      {obj.kind === 'cursor' && <CursorProps obj={obj} time={time} />}
      {obj.kind === 'camera' && <CameraProps obj={obj} time={time} />}
    </>
  );
}

const EASINGS: { value: Easing; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'easeIn', label: 'Ease in' },
  { value: 'easeOut', label: 'Ease out' },
  { value: 'easeInOut', label: 'Ease in-out' },
  { value: 'hold', label: 'Hold (jump)' },
];

const PROP_LABELS: Record<KeyRef['prop'], string> = {
  position: 'Position',
  rotation: 'Rotation',
  scale: 'Scale',
  opacity: 'Opacity',
  cursor: 'Cursor position',
  clicks: 'Click',
  scrolls: 'Scroll',
  keys: 'Typing',
  target: 'Look at',
  zoom: 'Zoom',
};

function PresetsSection({ obj }: { obj: SceneObject }) {
  const [duration, setDuration] = useState(1);
  const presets = obj.kind === 'camera' ? CAMERA_PRESETS : OBJECT_PRESETS;
  return (
    <Section title={obj.kind === 'camera' ? 'Camera moves' : 'Presets'}>
      <Row label="Length">
        <NumberField
          value={duration}
          min={0.1}
          max={60}
          step={0.1}
          precision={1}
          suffix=" s"
          label="↔"
          onChange={(v) => setDuration(v)}
        />
      </Row>
      <div className="preset-grid">
        {presets.map((p) => (
          <button key={p.value} onClick={() => applyPreset(obj.id, p.value, p.label, duration)}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="hint">
        Adds keyframes from the playhead. It ends at the {obj.kind === 'camera' ? "camera's" : "object's"} current
        values, and replaces keyframes in that range.
      </p>
    </Section>
  );
}

function AnimationTab() {
  const project = useEditor((s) => s.project);
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const selectedId = useEditor((s) => s.selectedId);
  const selected = project.objects.find((o) => o.id === selectedId);
  const presets =
    selected && (selected.kind === 'camera' || hasTransform(selected)) ? (
      <PresetsSection key={selected.id} obj={selected} />
    ) : null;
  const keys = selectedKeys
    .map((k) => {
      const o = project.objects.find((x) => x.id === k.objectId);
      if (!o || isCursorEventProp(k.prop)) return null;
      const a = getAnimated(o, k.prop);
      const kf = a?.keyframes.find((x) => x.id === k.keyId);
      return kf ? { ref: k, obj: o, kf } : null;
    })
    .filter((x) => x !== null);

  if (keys.length === 0)
    return (
      <>
        {presets}
        <p className="hint pad">
          {presets ? '' : 'Select an object or the camera for one-click animations. '}
          Select keyframes in the timeline to change their easing and timing. Shift-click to select several.
        </p>
      </>
    );

  const easing = new Set(keys.map((k) => k.kf.easing ?? 'linear'));
  const setEasing = (e: Easing) =>
    edit((p) => {
      for (const { ref } of keys) {
        const o = p.objects.find((x) => x.id === ref.objectId);
        const a = o && getAnimated(o as SceneObject, ref.prop as PropName);
        const kf = a?.keyframes.find((x) => x.id === ref.keyId);
        if (kf) {
          if (e === 'linear') delete kf.easing;
          else kf.easing = e;
        }
      }
    });

  return (
    <>
      {presets}
      <Section title={keys.length === 1 ? 'Keyframe' : `${keys.length} keyframes`}>
        <Row label="Easing">
          <select value={easing.size === 1 ? [...easing][0] : ''} onChange={(e) => setEasing(e.target.value as Easing)}>
            {easing.size > 1 && <option value="">Mixed</option>}
            {EASINGS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </Row>
        <p className="hint">Easing shapes the movement from each selected keyframe to the next one.</p>
        {keys.slice(0, 8).map(({ ref, obj, kf }) => (
          <div className="key-summary" key={ref.keyId}>
            <span>
              {obj.name} · {PROP_LABELS[ref.prop]}
            </span>
            <span className="muted">{kf.time.toFixed(2)} s</span>
          </div>
        ))}
        {keys.length > 8 && <p className="hint">…and {keys.length - 8} more</p>}
      </Section>
    </>
  );
}

export function Inspector() {
  const [tab, setTab] = useState<'props' | 'anim'>('props');
  return (
    <div className="inspector">
      <div className="tabs">
        <button className={tab === 'props' ? 'active' : ''} onClick={() => setTab('props')}>
          Properties
        </button>
        <button className={tab === 'anim' ? 'active' : ''} onClick={() => setTab('anim')}>
          Animation
        </button>
      </div>
      <div className="inspector-body">{tab === 'props' ? <PropertiesTab /> : <AnimationTab />}</div>
    </div>
  );
}
