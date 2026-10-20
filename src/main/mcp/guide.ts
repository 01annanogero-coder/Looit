// What an AI app is told about Looit: short instructions sent when it connects,
// and the full guide returned by the looit_guide tool.

/** Replaces an embedded background image in project JSON shown to the AI; set_project restores it. */
export const IMAGE_PLACEHOLDER = 'looit:keep-current-image';

export const SERVER_INSTRUCTIONS = `Looit makes videos of real, live websites: a website is shown on a panel in 3D, a virtual cursor hovers, clicks, scrolls and types on it at exact times, the camera moves, and the result is exported as an MP4.

You work in the AI Studio, a separate Looit window the user watches. You build your own project there. You can read the user's editor project but never change it. Exports and project saves always ask the user where to save.

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
- 3D positions are world units. A website panel at scale 1 is 16 units wide, and 9 units tall for a 16:9 viewport. Its centre is its position.
- The default camera stands at [0, 0, 18] and looks at [0, 0, 0], so a panel at the origin fills about 80% of the frame. Zoom 2 makes everything twice as large. To focus on the panel's top part (the navigation bar), aim the camera higher: target [0, 1, 0] with zoom 1.25 still shows the top edge.
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
- environment.background is "solid" (uses "background"), "gradient" (from "background" to "gradientTo") or "image". A background image can only be added by the user. In get_project output it appears as "${IMAGE_PLACEHOLDER}"; keep that string to keep the image. environment.floor is "none", "reflection" or "grid".
- set_project validates the whole project. On an error nothing changes and the message names the field, for example project.objects[2].clicks[0].time.

## How the cursor drives the website
- **Hover:** the page sees the cursor at its position on every frame, so hover effects and dropdown menus open and close exactly as with a real mouse.
- **Clicks** happen at the cursor's position at that time. A click on a link opens the new page in the same panel; give it about 1 s to load before the next action. Links that would open a new tab also open in the same panel.
- **Scrolls** are mouse-wheel turns at the cursor's position. They are relative to wherever the page is. Many sites glide over 0.3-1 s. If the cursor is over an open dropdown, a popup or a scrollable box, that element scrolls instead of the page.
- **Typing** goes to whatever is focused, usually the field the cursor clicked just before.

## Workflow
1. Start a project: new_project with the url (or copy_user_project: true to build on the user's work). Set a duration that fits the story, typically 15-40 s.
2. Learn the page: inspect_page at time 0 for the navigation and buttons in view, and inspect_page with a query to find sections or links further down (pageY).
3. Plan the beats, for example: intro, hover the menu, open a dropdown, scroll to a section, click through to another page, scroll there, end. Give each beat time to be seen, usually 1-3 s.
4. Write the project: get_project, edit the JSON, then set_project. Prefer a few complete set_project calls over many tiny ones.
5. Check your work: inspect_page and screenshot at the moments that matter (a dropdown open, after a scroll has landed, after a click opened a page). Adjust and repeat.
6. Show the user with preview (play: true) if they want to watch it first.
7. Export: export_video, then get_status with wait_seconds until it is done. Tell the user where it was saved (get_status gives the path).

## Recipes
- **Intro:** apply_preset flyIn (or fadeIn) on the website panel at time 0 with length 1.5-2. Keep the cursor still or off to the side until the panel has arrived.
- **Show a dropdown:** add a cursor keyframe on the menu item, and a second keyframe at the same spot 1-1.5 s later (a hold). Then move into the dropdown to point at an entry, or move off to close it. Closing only happens when the cursor leaves both the menu item and the dropdown panel, so check its box with inspect_page while it is open.
- **Scroll to a section:** inspect_page with a query for the heading. The scroll needed is about pageY minus the current scroll position minus 100 (to leave room under a sticky header). Before scrolling, park the cursor over plain page content and away from menus. Split long distances into steps of 400-900 px about 0.6-1 s apart. Check with inspect_page about 1 s after the last scroll.
- **Back to the top:** one scroll of minus the total scrolled (or more; the page stops at the top).
- **Go to another page:** move to the link, hold 0.3-0.5 s, click, then wait about 1 s. inspect_page about 1.5 s after the click confirms the new address.
- **Search or form:** click the field, add a "type" event 0.3 s later at 8-14 cps, then press Enter after the last character (time + characters / cps).
- **Camera emphasis:** keyframe camera target and zoom (for example zoom 1 to 1.3 over 0.8 s with easeInOut) to lean in on a detail, then back out. Camera presets do common moves.
- **Cookie banners:** inspect_page at time 0. If a banner covers the page, click its accept or close button early on (0.5-1.5 s).

## Limits to know
- Embedded videos and some canvas or WebGL graphics run on their own clock and are not frame-exact.
- The studio preview is close to the export but approximate for hover effects between events. The export replays the cursor on every frame.
- Exports take time: roughly 1-3x the video length at 720p30, and about twice that at 60 fps. Pages that animate constantly can't skip frames.
- One export or Save dialog runs at a time. set_project is refused while exporting.
`;
