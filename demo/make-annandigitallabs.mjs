// Builds demo/annandigitallabs.looit: a tour of https://annandigitallabs.com
// (nav dropdowns on hover, scrolling, clicking through to another page).
//   node demo/make-annandigitallabs.mjs
// Cursor positions are website CSS pixels at the 1280x720 panel size.
import { writeFileSync } from 'node:fs';

let n = 0;
const id = (p) => `${p}-${++n}`;
const keyed = (keys) => ({
  value: keys[0][1],
  keyframes: keys.map(([time, value, easing]) => ({ id: id('k'), time, value, ...(easing ? { easing } : {}) })),
});
const still = (value) => ({ value, keyframes: [] });
const E = 'easeInOut';

// Nav link centres (from the live site at 1280x720).
const NAV = { products: [428, 90], services: [546, 90], industries: [668, 90], about: [793, 90], resources: [919, 90] };

const cursorPath = [
  [0, [1150, 640], E],
  [1.8, [760, 380], E],
  [2.8, NAV.products, E], // Products dropdown
  [3.9, NAV.products, E],
  [4.5, NAV.services, E], // Services dropdown
  [5.6, NAV.services, E],
  [6.2, NAV.industries, E], // Industries dropdown, then into it
  [6.9, NAV.industries, E],
  [7.4, [668, 215], E],
  [8.0, [428, 273], E],
  [8.6, [428, 273], E],
  [9.4, NAV.about, E], // About Us dropdown
  [10.3, NAV.about, E],
  [11.0, [420, 520], E], // off the nav (and its dropdown): it closes
  [16.8, [420, 520], E],
  [17.8, NAV.about, E], // back to About Us and click it
  [18.6, NAV.about, E],
  [19.6, [420, 520], E],
];

const websiteId = 'website-annan';
const project = {
  format: 'looit-project',
  version: 1,
  name: 'Annan Digital Labs tour',
  duration: 24,
  output: { width: 1280, height: 720, fps: 30 },
  background: '#0f172a',
  environment: {
    background: 'gradient',
    gradientTo: '#1e3a5f',
    gradientAngle: 90,
    image: null,
    floor: 'reflection',
    floorY: -5.2,
    floorColor: '#111827',
  },
  objects: [
    {
      id: 'camera-main',
      kind: 'camera',
      name: 'Camera',
      visible: true,
      position: still([0, 0, 18]),
      // Lean in on the navigation while the dropdowns open, then back out for the scroll.
      target: keyed([
        [2.2, [0, 0, 0], E],
        [3.0, [0, 1, 0], E],
        [10.4, [0, 1, 0], E],
        [11.4, [0, 0, 0]],
      ]),
      zoom: keyed([
        [2.2, 1, E],
        [3.0, 1.25, E],
        [10.4, 1.25, E],
        [11.4, 1, E],
        [22.5, 1, E],
        [24, 1.08],
      ]),
    },
    {
      id: websiteId,
      kind: 'website',
      name: 'Annan Digital Labs',
      visible: true,
      url: 'https://annandigitallabs.com/',
      viewport: { width: 1280, height: 720 },
      interactive: true,
      shadow: { enabled: true, color: '#000000', opacity: 0.55, blur: 1.2, offsetY: -0.35 },
      frame: 'light',
      cornerRadius: 14,
      border: { width: 0, color: '#ffffff' },
      transform: {
        position: keyed([
          [0, [-3, -1.5, -10], E],
          [2, [0, 0, 0]],
        ]),
        rotation: keyed([
          [0, [12, 35, -6], E],
          [2, [0, 0, 0]],
        ]),
        scale: keyed([
          [0, [0.6, 0.6, 0.6], 'easeOut'],
          [2, [1, 1, 1]],
        ]),
        opacity: keyed([
          [0, 0, E],
          [0.6, 1],
        ]),
      },
    },
    {
      id: 'cursor-annan',
      kind: 'cursor',
      name: 'Cursor',
      visible: true,
      targetId: websiteId,
      size: 0.55,
      style: 'arrow',
      clickColor: '#3b82f6',
      position: keyed(cursorPath),
      clicks: [{ id: id('click'), time: 18.3 }],
      scrolls: [
        // Down the home page...
        ...[11.6, 12.4, 13.2, 14.0].map((time) => ({ id: id('scroll'), time, deltaY: 700 })),
        // ...and back to the top.
        { id: id('scroll'), time: 15.2, deltaY: -1400 },
        { id: id('scroll'), time: 15.8, deltaY: -1400 },
        // Down the About page.
        ...[20.4, 21.4, 22.4].map((time) => ({ id: id('scroll'), time, deltaY: 600 })),
      ],
      keys: [],
    },
  ],
};

writeFileSync(new URL('./annandigitallabs.looit', import.meta.url), JSON.stringify(project, null, 2));
console.log('wrote demo/annandigitallabs.looit');
