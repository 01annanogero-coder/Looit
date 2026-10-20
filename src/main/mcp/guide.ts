// What an AI app is told about Looit: short instructions sent when it connects,
// and the full guide returned by the looit_guide tool.

/** Replaces an embedded background image in project JSON shown to the AI; set_project restores it. */
export const IMAGE_PLACEHOLDER = 'looit:keep-current-image';

export const SERVER_INSTRUCTIONS = `Looit makes videos of real, live websites: a website is shown on a panel in 3D, a virtual cursor hovers, clicks, scrolls and types on it at exact times, the camera moves, and the result is exported as an MP4.

You work in the AI Studio, a separate Looit window the user watches. You build your own project there. You can read the user's editor project but never change it. Exports and project saves always ask the user where to save.

Change an existing project with patch_project (one operation per edit), and check a project you built offline with validate_project. screenshot takes several times in one call; render_frame renders frames that match the MP4 exactly.

Before your first edit, call looit_guide. It has the project format, the workflow and recipes.`;

export const GUIDE = `# Looit guide for AI assistants

## What Looit is
Looit is a Windows app for making videos of real websites. A live website is shown on a panel in a 3D scene. A virtual cursor moves over it and hovers, clicks, scrolls and types at exact moments. The camera can move and zoom, and the scene has a background and an optional floor. The video is exported frame by frame as an MP4 (H.264) at 1280x720 or 1920x1080, 30 or 60 fps. Every frame is exact: page animations, smooth scrolling and dropdowns look the same in every export.

## Your permissions
You can:
- Read the project the user has open in Looit's editor, including unsaved changes (read_user_project), and copy it into your own project (new_project with copy_user_project: true).
- Create and edit your own project in the AI Studio window (new_project, get_project, set_project, apply_preset). The user sees that window but has no controls in it.
- Load any http/https website in your project, and inspect it (inspect_page) or look at it (screenshot) at any moment of the timeline.
- Play the animation in the studio window for the user (preview).
- Export the video (export_video) and save your project (save_project). Both open a Save dialog where the user chooses the folder and file name. You can only suggest a name.

You cannot:
- Change the user's editor project, their files or their settings. Nothing you do touches their work.
- Choose where files go, or read or write any other file on the computer.
- Use local files (file:// addresses) as websites.
- Act on a website outside the timeline. Everything the website does in the video comes from the cursor events in your project.
- Use the user's browser logins. Each export is a fresh first visit to the site, with no cookies, so cookie banners and first-visit popups appear.

If a tool says AI access is turned off, ask the user to open Looit and use Help → Connect an AI app.

Be considerate. Tell the user what you are about to make before a long export. Don't type private information into websites unless the user gave it to you for that purpose.

## The one rule: the timeline is the script
Looit replays the project on a fresh copy of each website. Hover, clicks, scrolls and typing only happen if they are in the project at a time. The page starts fully loaded at time 0 (it gets 1 second to load beforehand).

## Units and coordinates
- Time is in seconds. Put events on frame boundaries when you can (multiples of 1/30 s at 30 fps).
- Cursor positions are website CSS pixels inside the panel's browser viewport: [x, y] from the top-left, 0..viewport.width by 0..viewport.height (1280x720 by default). Positions in view from inspect_page are exactly these coordinates.
- 3D positions are world units. A website panel at scale 1 is 16 units wide and 9 units tall for a 16:9 viewport. Its centre is its position. The optional browser bar sits *above* that page area and is 0.5 units tall (40 px), so the whole window is 16 x 9.5.
- The camera is a perspective camera. Its vertical field of view is 35° at zoom 1 and narrowing with zoom: \`fov = 2 * atan(tan(17.5°) / zoom)\`. Anything at distance \`d\` in front of it covers \`2 * d * tan(fov / 2)\` units of frame height.
- The default camera stands at [0, 0, 18] and looks at [0, 0, 0], so the page area fills 9 / 11.35 = 79% of the frame height (83% with the browser bar). At distance 18 the frame is 11.35 units tall and 20.2 wide.
- Website pixel to world, on a panel at the origin with scale 1: \`worldX = (px / viewport.width - 0.5) * 16\` and \`worldY = 4.5 - (py / viewport.height) * 9\`. The y is the same whether or not the panel has a browser bar, because the bar is outside the page.
- To put website pixel (px, py) in the middle of the frame at zoom Z, with the panel at the origin and facing the camera: aim the camera at \`[worldX, worldY, 0]\` and stand at \`[worldX, worldY, d]\` with \`d = 18 / Z\`. To show a region \`H\` world units tall instead, use \`d = H * Z / (2 * tan(17.5°))\`, which is about \`H * Z / 0.63\`.
- Rotation is in degrees (X, Y, Z). Opacity runs from 0 to 1.

## Project JSON
\`\`\`json
{
  "format": "looit-project", "version": 1,
  "name": "My video", "duration": 20,
  "output": { "width": 1280, "height": 720, "fps": 30 },
  "background": "#0f172a",
  "environment": { "background": "gradient", "gradientTo": "#1e3a5f", "gradientAngle": 90, "image": null,
                   "floor": "reflection", "floorY": -5.2, "floorColor": "#111827" },
  "objects": [
    { "id": "camera-1", "kind": "camera", "name": "Camera", "visible": true,
      "position": { "value": [0, 0, 18], "keyframes": [] },
      "target":   { "value": [0, 0, 0],  "keyframes": [] },
      "zoom":     { "value": 1, "keyframes": [] } },
    { "id": "site-1", "kind": "website", "name": "Website", "visible": true,
      "url": "https://example.com/", "viewport": { "width": 1280, "height": 720 }, "interactive": true,
      "transform": {
        "position": { "value": [0, 0, 0], "keyframes": [] },
        "rotation": { "value": [0, 0, 0], "keyframes": [] },
        "scale":    { "value": [1, 1, 1], "keyframes": [] },
        "opacity":  { "value": 1, "keyframes": [] } },
      "shadow": { "enabled": true, "color": "#000000", "opacity": 0.5, "blur": 1.2, "offsetY": -0.35 },
      "frame": "light", "cornerRadius": 14, "border": { "width": 0, "color": "#ffffff" } },
    { "id": "cursor-1", "kind": "cursor", "name": "Cursor", "visible": true, "targetId": "site-1",
      "size": 0.55, "style": "arrow", "clickColor": "#3b82f6",
      "position": { "value": [640, 360], "keyframes": [
        { "id": "k1", "time": 0, "value": [900, 500], "easing": "easeInOut" },
        { "id": "k2", "time": 1.5, "value": [420, 90], "easing": "easeInOut" },
        { "id": "k3", "time": 2.8, "value": [420, 90] } ] },
      "clicks":  [ { "id": "c1", "time": 2.5 } ],
      "scrolls": [ { "id": "s1", "time": 4, "deltaY": 700 } ],
      "keys":    [ { "id": "t1", "time": 6, "kind": "type", "text": "hello", "cps": 12 },
                   { "id": "p1", "time": 7, "kind": "press", "key": "Enter" } ] },
    { "id": "text-1", "kind": "text", "name": "Title", "visible": true, "text": "Hello",
      "size": 1.2, "color": "#ffffff", "weight": 700,
      "transform": { "position": { "value": [0, 6, 1], "keyframes": [] },
                     "rotation": { "value": [0, 0, 0], "keyframes": [] },
                     "scale": { "value": [1, 1, 1], "keyframes": [] },
                     "opacity": { "value": 1, "keyframes": [] } } }
  ]
}
\`\`\`
Rules:
- Animated values have a static "value" and "keyframes". When there are keyframes they decide the value: it holds the first keyframe's value before it, moves between keyframes, and holds the last one after it.
- Each keyframe needs a unique "id" within its list, a "time" and a "value". "easing" (optional) shapes the movement from that keyframe to the next: "linear" (the default), "easeIn", "easeOut", "easeInOut" or "hold" (stay, then jump).
- Clicks, scrolls and keys each need a unique "id" and a "time".
- Object ids must be unique. Keep the ids of existing objects when you edit.
- Each website panel needs exactly one cursor ("targetId" is the panel's id). There is exactly one camera.
- "scrolls[].deltaY" is a mouse-wheel distance in CSS pixels: positive scrolls down, negative scrolls up.
- "keys": kind "type" types "text" at "cps" characters per second (1-100). Kind "press" presses a special key: Enter, Tab, Backspace, Delete, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp or PageDown.
- Limits: duration 0.5 s to 4 h. fps 30 or 60. Panel viewport 320x240 to 3840x2160 (common sizes are 1280x720, 1366x768, 1440x900 and 1920x1080). Up to 200 objects.
- Cursor styles: arrow, arrow-white, hand, ibeam, dot. Window frames: none, light, dark.
- "weight" is 400, 600 or 700. Nothing else is accepted.
- **Text overlays** (kind "text") have "size" (line height: world units in world space, a fraction of the frame height in screen space), "color", "weight" and an optional "space":
  - "space": "world" (the default) puts the text in the 3D scene at its transform.
  - "space": "screen" pins it to the video frame like a HUD: it does not move or grow when the camera moves or zooms. Set the anchor with "screen": { "x": 0.5, "y": 0.08 }, where 0..1 runs left to right and top to bottom, and "size" as a fraction of the frame height (0.09 is a large title). Only "transform.opacity" animates in screen space; position, rotation and scale are ignored.
  - Optional "background" draws a pill behind the text: { "color": "#000000", "opacity": 0.55, "padding": 0.45, "radius": 0.5 } (padding and radius are multiples of the text height). This is how to keep white text readable over a light page.
  - Optional "shadow": { "color": "#000000", "opacity": 0.6, "offsetX": 0, "offsetY": 0.06, "blur": 0.12 } for a softer drop shadow instead of a pill.
- Cursor objects accept "fixedScreenSize": true to keep the pointer the same size on screen when the camera zooms.
- environment.background is "solid" (uses "background"), "gradient" (from "background" to "gradientTo") or "image". A background image can only be added by the user. In get_project output it appears as "${IMAGE_PLACEHOLDER}"; keep that string to keep the image. environment.floor is "none", "reflection" or "grid".
- set_project validates the whole project. On an error nothing changes and the message names the field, for example project.objects[2].clicks[0].time. To avoid resending everything, use patch_project or validate_project (below).

## Editing part of the project
Prefer patch_project to a full set_project once the project exists. It applies operations to a copy, validates the result, and only then replaces the studio project. A bad operation changes nothing and its message starts with the failing operation's index, for example \`patch[1] project.objects[3].weight: expected 400, 600 or 700\`.

- \`{ "op": "set", "path": "/objects/1/viewport/width", "value": 1440 }\` sets any field. Paths are JSON Pointers: \`/objects/2/transform/position/value/0\`, \`/environment/floor\`, \`/duration\`.
- \`{ "op": "remove", "path": "/objects/3" }\` removes a field or list entry.
- \`{ "op": "add_object", "object": { ... } }\` adds a text, website or cursor object (see the project JSON above).
- \`{ "op": "remove_object", "id": "text-1" }\` removes an object (and a website panel's cursor with it).
- \`{ "op": "add_keyframe", "object_id": "camera-1", "property": "zoom", "time": 3, "value": 1.3, "easing": "easeInOut" }\` adds one keyframe. "property" is position, rotation, scale, opacity, zoom, target or cursor.
- \`{ "op": "remove_keyframe", "object_id": "camera-1", "property": "zoom", "time": 3 }\` removes the keyframe nearest that time.
- \`{ "op": "add_event", "object_id": "cursor-1", "kind": "click", "time": 4.5 }\` adds a click; "kind": "scroll" takes "deltaY", "kind": "type" takes "text" and "cps", "kind": "press" takes "key".
- \`{ "op": "remove_event", "object_id": "cursor-1", "id": "click-3" }\` removes one event by id.

validate_project { project } checks any project JSON with the same rules as set_project and reports the first problem, without changing anything. Use it before a large set_project, or after building a project offline.

## How the cursor drives the website
- **Hover:** the page sees the cursor at its position on every frame, so hover effects and dropdown menus open and close exactly as with a real mouse.
- **Clicks** happen at the cursor's position at that time. A click on a link opens the new page in the same panel; give it about 1 s to load before the next action. Links that would open a new tab also open in the same panel.
- **Scrolls** are mouse-wheel turns at the cursor's position. They are relative to wherever the page is. Many sites glide over 0.3-1 s. If the cursor is over an open dropdown, a popup or a scrollable box, that element scrolls instead of the page.
- **Typing** goes to whatever is focused, usually the field the cursor clicked just before.

## Workflow
1. Start a project: new_project with the url (or copy_user_project: true to build on the user's work). Set a duration that fits the story, typically 15-40 s.
2. Learn the page: inspect_page at time 0 for the navigation and buttons in view, and inspect_page with a query to find sections or links further down (pageY).
3. Plan the beats, for example: intro, hover the menu, open a dropdown, scroll to a section, click through to another page, scroll there, end. Give each beat time to be seen, usually 1-3 s.
4. Write the project: get_project, then patch_project for each change (or set_project for a full rewrite). Build offline if you like, and check it with validate_project first.
5. Check your work: screenshot with several times in one call for a quick contact sheet, and render_frame for the frames that must match the video exactly (after a scroll has landed, a reveal animation, a dropdown). Adjust and repeat.
6. Show the user with preview (play: true) if they want to watch it first.
7. Export: export_video, then get_status with wait_seconds until it is done. Tell the user where it was saved (get_status gives the path).

## Recipes
- **Intro:** apply_preset flyIn (or fadeIn) on the website panel at time 0 with length 1.5-2. Keep the cursor still or off to the side until the panel has arrived.
- **Show a dropdown:** add a cursor keyframe on the menu item, and a second keyframe at the same spot 1-1.5 s later (a hold). Then move into the dropdown to point at an entry, or move off to close it. Closing only happens when the cursor leaves both the menu item and the dropdown panel, so check its box with inspect_page while it is open. The menu swap animates for a moment, so check the frame you will use with render_frame rather than assuming it is open the instant the cursor arrives.
- **Scroll to a section:** inspect_page with a query for the heading. The scroll needed is about pageY minus the current scroll position minus 100 (to leave room under a sticky header). Before scrolling, park the cursor over plain page content and away from menus. Split long distances into steps of 400-900 px about 0.6-1 s apart. Check with render_frame about 0.5-1 s after the last scroll: positions from inspect_page describe the preview, and the export lands scrolls slightly differently.
- **Back to the top:** one scroll of minus the total scrolled (or more; the page stops at the top).
- **Go to another page:** move to the link, hold 0.3-0.5 s, click, then wait about 1 s. inspect_page about 1.5 s after the click confirms the new address.
- **Search or form:** click the field, add a "type" event 0.3 s later at 8-14 cps, then press Enter after the last character (time + characters / cps).
- **Camera emphasis:** keyframe camera target and zoom (for example zoom 1 to 1.3 over 0.8 s with easeInOut) to lean in on a detail, then back out. Camera presets do common moves. To lean in on website pixel (px, py), use the formulas in "Units and coordinates" so the point lands in the middle of the frame.
- **Screen text (HUD):** add a text object with "space": "screen", "screen": { "x": 0.5, "y": 0.5 } and "size": 0.09, plus a "background" pill if the page behind it is light. It stays put while the camera moves, so one text can label several shots.
- **Cookie banners:** inspect_page at time 0. If a banner covers the page, click its accept or close button early on (0.5-1.5 s).

## Limits to know
- Embedded videos and some canvas or WebGL graphics run on their own clock and are not frame-exact.
- Native browser popups (a \`<select>\` dropdown, autofill, file pickers, native context menus) are separate windows and never appear in a frame. Pick options with keyboard presses (click the select, then ArrowDown and Enter) or avoid those fields.
- The studio preview and the export now step the page the same way, but the preview is built live: use render_frame when a frame has to be exact (scroll landing, reveal animations, hover swaps).
- Exports take time: roughly 1-3x the video length at 720p30, and about twice that at 60 fps. Pages that animate constantly can't skip frames.
- One export or Save dialog runs at a time. set_project and patch_project are refused while exporting.
`;
