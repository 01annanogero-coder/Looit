# Looit

Turn real websites into 3D animated explainer videos. Windows desktop app (Electron + React + Three.js), distributed through the Microsoft Store as MSIX.

Product spec: [docs/app-spec.pdf](docs/app-spec.pdf). UI target: [docs/Canva-UI-sketch2.png](docs/Canva-UI-sketch2.png).

## Commands

| Command                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`                                  | Run the app in development mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm test`                                   | Unit tests (animation, keyframe editing, project files, rotation, input merging)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `npm run typecheck`                          | TypeScript check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `node scripts/ui-test.mjs`                   | End-to-end UI test: drives the real app (keyframe drag, undo, gizmo, shortcuts, website scrolling)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `node scripts/onboarding-test.mjs`           | End-to-end test of the project library: create, autosave, rename, pin, demo project, reopen, delete (uses a scratch folder)                                                                                                                                                                                                                                                                                                                                                                                                             |
| `node scripts/editor-features-test.mjs`      | End-to-end test of the editor: HUD text with a pill, fixed-size cursor, _Aim at the cursor_, and exporting a project with only a blank panel (`LOOIT_TEST_EXPORT_DIR` keeps the MP4 in a scratch folder)                                                                                                                                                                                                                                                                                                                                |
| `npm run selftest`                           | End-to-end export of `test-pages/clock.html`; writes frames, `export.mp4` and `report.json` (timings per stage) to `selftest-out/`. Options: `LOOIT_SELFTEST_OUTPUT=1920x1080@60`, `LOOIT_SELFTEST_ENV=1` or `=image` (background, floor and a moving camera), `LOOIT_SELFTEST_PROJECT=path.looit` (export a saved project, e.g. `demo/annandigitallabs.looit`; rebuild it with `node demo/make-annandigitallabs.mjs`), `LOOIT_SELFTEST_URL=https://…` (time a real site), `LOOIT_SELFTEST_LEAN=1` (no diagnostics, like a user export) |
| `node scripts/reuse-test.mjs [targets]`      | Exports test pages and real sites with frame reuse off and on and checks every frame matches                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `node scripts/determinism-test.mjs [copies]` | Exports `test-pages/determinism.html` twice with one website copy and once with several in parallel, and checks every frame matches                                                                                                                                                                                                                                                                                                                                                                                                     |
| `node scripts/inspect-mp4.mjs <file>`        | Print codec, duration and frame count of an MP4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run make:msix`                          | Build a dev-signed MSIX in `out/make/msix/x64/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `node scripts/make-icons.mjs`                | Rebuilds the icon set from `assets/logo.svg`: window icon, `build/icon.ico` and the MSIX tile images                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Branding

The logo is `assets/logo.svg` (the neon ribbon). `node scripts/make-icons.mjs` renders it with Electron on a white rounded tile and writes:

- `assets/icon.png` — the window icon (title bar and taskbar) at 512 px, also shipped in `resources/assets` for the packaged app.
- `build/icon.ico` — 16–256 px, used by the packaged `Looit.exe` and its taskbar shortcut.
- `build/msix/*.png` — the Store/Start tile images (square, wide, splash, lock screen).

`assets/icon.png` is also what the onboarding screen and the editor toolbar show, through Vite's asset pipeline.

## Projects

The app opens on the project library, not in the editor.

- **Create project** writes `%USERPROFILE%\Looit Projects\<name>.looit` and opens it. A new project is a **blank browser card** with a resting cursor: nothing loads until the user types an address in _Properties → Website Panel_. The folder is in the user's profile, deliberately outside any OneDrive-synced Documents folder.
- **Continue with** opens a project from the list. `%APPDATA%\Looit\projects.json` only stores each project's id, name, pin and last-used time; the `.looit` files are the source of truth, and a project whose file was moved shows as _file missing_.
- **Demo project** copies the tour bundled at `assets/demo.looit` (a finished 52-second video of `annandigitallabs.com` with captions) into `%USERPROFILE%\Looit Projects\Demo project.looit` on first use, then opens it. Edits to that copy persist; when a later build ships a different tour, the copy is replaced so the tile always shows the current demo.
- Each project can be renamed (the file is renamed too, and the name inside it updated), pinned to the top, shared (saves a copy to a location of the user's choosing), shown in Explorer, or deleted (the file goes to the recycle bin). **Open a .looit file…** imports any project into the list.
- **Every accepted change is written back** to the open project file about half a second after editing stops; the save indicator goes back to _Saved_ by itself. _Save as_ still copies the project somewhere else.
- Development only: `LOOIT_LIBRARY_DIR=<folder>` points the library at a scratch folder (the end-to-end test uses it).

## Using the editor

- **Viewport tools:** Select (click objects; move/rotate/scale handles), Cursor (C: drag on the page to place the virtual cursor at the playhead, double-click = a click there, wheel = a scroll), Interact (Tab: use the live website yourself).
- **Blender-style transforms:** G / R / S, then X / Y / Z to lock an axis (Shift+axis = the other two), type a number for an exact value, Enter or click to confirm, Esc or right-click to cancel. Alt+G/R/S resets. I inserts a keyframe, Alt+I deletes one.
- **Animating:** move the playhead, then transform or type a value. Properties that already have keyframes get a new keyframe at the playhead. The ◇ button next to a property starts or stops animating it.
- **Timeline:** any length up to 4 hours (End field: `90`, `1:30` or `1:00:00`). Wheel zooms, Ctrl+wheel pans, Fit shows everything. Drag diamonds to retime (snapped to frames), Shift-click to select several, double-click a row to add a keyframe, Delete or X to remove.
- **Several websites:** _Add website_ in the Scene Hierarchy adds another panel with its own cursor. Each panel has its own live page, preview and export rendering; Interact mode and the Cursor tool act on the panel under the mouse.
- **Panel style:** in the website panel's properties, _Window_ adds a light or dark browser bar (window buttons and the page address), rounded corners and a border; _Shadow_ has a drop distance (0 with a bright colour makes a glow). The cursor has styles (arrow, white arrow, hand, I-beam, touch dot) and a click-ring colour.
- **Scroll to here:** in Interact mode, scroll the live page to a spot and press _Scroll to here_: a scroll event of exactly that distance is added at the playhead (measured from where the timeline has the page, once earlier scrolls have finished gliding).
- **Typing:** in the cursor's properties, _Type text_ types into whatever is focused (make the cursor click a field first), one character every 1/speed seconds, as real key presses; _Press key_ sends Enter, Tab, arrows and so on. Both show as a Typing row in the timeline. In Interact mode (Tab) your own keyboard types into the website; Esc leaves.
- **Dropdowns:** native `<select>` menus are drawn inside the panel, so you can open one in Interact mode and pick an entry (click, or arrow keys + Enter, Esc closes) and it appears in the preview and the export. File pickers and other OS-level popups are still outside the frame.
- **Text overlays:** a text object can live in the scene or be pinned to the video frame (_Placement → On screen (HUD)_; its size is then a percentage of the video height). A _Pill_ or _Shadow_ under _Readability_ keeps light text readable over a busy page.
- **Camera:** select _Camera_ in the Scene Hierarchy. It stays still until you animate its Position, Look at (the point it aims at) and Zoom like any other property. _Aim at the cursor_ moves _Look at_ to the spot under the virtual cursor, then raise Zoom to close in. The viewport always shows the camera's view, which is what gets exported.
- **Presets:** select an object or the camera, open the Animation tab and click a preset (Fade in/out, Fly in, Slide in, Pop in/out; camera: Zoom in/out, Push in, Pull out, Pan, Rise). It adds keyframes from the playhead for the chosen length, ending at the current values, so place the object first and add the entrance after.
- **Environment:** in Scene settings, the background can be a solid colour, a gradient or an image (PNG, JPEG or WebP up to 8 MB, embedded in the project and cropped to fill the frame). A floor can be added under the panels: a soft reflection or a grid.
- **Preview follows the timeline:** the website in the viewport shows its state at the playhead. Scrubbing back rebuilds the page and replays the cursor's clicks and scrolls up to that moment; playing advances the page's clock with the playhead.
- **Layout:** T / N hide the left and properties panels, drag panel edges to resize, Ctrl+Space maximizes the viewport. Sizes are remembered.
- **All shortcuts:** Help → Keyboard shortcuts (F1).
- **Projects** are saved as `.looit` files (JSON, validated on open). Exports stream straight to the chosen file.

## Architecture

```
src/
  engine/      Pure data and logic, no rendering, no Electron: project model, keyframe
               evaluation and editing, rotation continuity, project-file validation.
  main/        Electron main process: editor window, IPC validation, file dialogs,
               website pages (website.ts), the timeline-synced preview (preview.ts)
               and live input merging (input-queue.ts).
  preload/     The only bridge between UI and main (window.looit).
  renderer/    Editor UI (React + Zustand store with undo/redo), Three.js scene and
               Blender-style modal transforms (viewport/), keymap (shortcuts.ts),
               panel layout (layout.ts), exporter.
  shared/      Types shared across processes.
```

**Websites are untrusted.** They run in a separate sandboxed, offscreen Chromium page with its own session, no Node access, every permission denied and downloads blocked. The editor checks the sender of every IPC message. Project files are saved only to paths the user picked in a dialog.

**Deterministic export.** Each export opens a fresh offscreen copy of the website whose clock is Chromium virtual time, frozen from before the page starts loading (blank page, then DevTools navigation) and starting from a fixed date, so every load of a page behaves identically. The page then settles for 1 s of virtual time while the clock waits for the network. For every output frame `n`, at `t = n / fps`:

1. The cursor's hover, clicks and scrolls for `(t-1, t]` are sent to the page.
2. The page clock advances exactly `1000/fps` ms. While network requests are pending the clock doesn't move, so slow networks don't change the result.
3. CSS animations, transitions and Web Animations (frozen at playback rate 0) advance by the same amount, and the page draws one animation frame at exactly `t`. `requestAnimationFrame` callbacks get the page clock as their timestamp (Chromium leaves it frozen under virtual time), so smooth-scroll libraries such as Lenis and other frame-time driven animation move as they would in a browser.
4. A fresh frame is captured at the output's pixel density (1.5× for 1080p) as PNG with `Page.captureScreenshot` (the page renders at 240 Hz so this is quick; the PNG is decoded off the main thread by the editor), the 3D scene is evaluated at `t`, and the frame is H.264-encoded (WebCodecs + mediabunny; no FFmpeg or GPL code), streaming to disk. The next frame is prepared while this one is encoded.

**Skipping unchanged frames** (Export panel → "Skip unchanged website frames", on by default). When the page provably didn't change since the previous frame, the previous website frame is reused instead of captured; the 3D scene is still rendered every frame. A frame is reused only if every signal is quiet: no click or scroll input, no navigation, no network activity, no style recalculation or layout (Chromium's counters; these catch DOM, text and hover changes, including inside shadow DOM), no resource loads, no scroll events, no running animations, and the page contains no content that can change by itself (canvas, video, iframes, GIFs, SVG animation). The check waits two animation frames so pending work is counted, the two frames after any change are always captured, and on pages that keep changing the check backs off exponentially (skipped checks always capture). `LOOIT_EXPORT_VERIFY_REUSE=1` captures every frame anyway and checks each reuse decision against the real frame; it found no wrong reuses on the test pages, Wikipedia, example.com, electronjs.org and GitHub. Typical gains: 1.35–1.7× at 720p30 and 1.7–2.6× at 1080p60 on mostly-static pages; no cost on busy pages.

The export can also split frames across several website copies (`src/main/export-session.ts`): each fast-forwards through the frames the others render, replaying the identical inputs, and `scripts/determinism-test.mjs` verifies the output matches a single copy. Inside the app this didn't pay off on the development PC (the copies compete with the editor's rendering and encoding), so one copy is the default.

Verified by `npm run selftest`: page time advances 33.3 ms per frame at 30 fps and 16.7 ms at 60 fps, CSS animations move exactly per frame, and clicks and scrolls land on the scheduled frame. `scripts/determinism-test.mjs` checks that repeated exports produce the same frames (differences of at most 3/255 on a few pixels, which is GPU rasterisation noise, are tolerated).

## Known limits

- **Export speed:** a 5 s clip takes roughly 4–14 s at 720p30 depending on how much the page changes (it was ~40 s), and 10–75 s at 1080p60. Pages that animate constantly (or contain canvas/video) get no benefit from frame reuse. Most of the remaining time is Chromium producing exact website frames; `npm run selftest` reports the breakdown.
- Pages that print sub-millisecond timings (`performance.now()`) can differ by 0.1 ms between exports: Chromium adds random jitter to that timer on purpose.
- `<video>` elements and WebGL/canvas content that runs on its own real-time clock are not yet frame-locked.
- Content in cross-origin iframes is not animation-stepped.
- A focused text field's blinking caret follows Chromium's real clock, so its blink phase can differ by a frame or two between exports (most often with several parallel website copies).
- In the preview, hover effects are replayed only around clicks and scrolls when seeking; the export replays the cursor on every frame.
- Scrubbing backwards reloads the website, which takes a moment on slow sites.

## MSIX and the Store

`npm run make:msix` signs with a local dev certificate (`certs/`, git-ignored). To install that package locally, trust `certs/dev-cert.cer` once (Trusted People, Local Machine), then open the `.msix`.

For the Store, replace the package identity in `forge.config.mts` (`packageIdentity`, `publisher`) with the values from Partner Center (Product identity page). The Store signs the package, so you don't need to buy a code-signing certificate.
