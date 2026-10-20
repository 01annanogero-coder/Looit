// The MCP tools Looit offers to AI apps. The bridge lists them (so an AI app
// sees them even before Looit is running); the app carries them out.

import { CAMERA_PRESETS, OBJECT_PRESETS } from '../../engine/presets';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const PRESET_NAMES = [...OBJECT_PRESETS, ...CAMERA_PRESETS].map((p) => p.value);

const time = { type: 'number', minimum: 0, description: 'Timeline time in seconds.' };
const websiteId = {
  type: 'string',
  description: 'Website panel id (from get_project). Defaults to the first website panel.',
};
const fileName = {
  type: 'string',
  maxLength: 120,
  description: 'Suggested file name, without folder. The user picks the folder and can change the name.',
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'looit_guide',
    title: 'Looit guide',
    description:
      'The full guide to making videos with Looit: how the project, timeline, cursor, scrolls, clicks, typing, camera and export work, the project JSON format, a step-by-step workflow, and exactly what you are and are not allowed to do. Read it before your first edit.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_user_project',
    title: "Read the user's project",
    description:
      "Returns a read-only copy of the project the user has open in Looit's editor (including unsaved changes), as JSON. Use it to see or copy their edits. You can never change the user's project; to build on it, call new_project with copy_user_project: true.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'new_project',
    title: 'Start a studio project',
    description:
      "Opens the AI Studio window (the user watches it) and starts a new project there: either a copy of the user's editor project (copy_user_project: true) or a clean project showing `url` on one website panel with a still camera, a still cursor and no animation. Replaces whatever the studio had. Returns the project summary with object ids.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) address of the website to show (ignored when copying).' },
        copy_user_project: { type: 'boolean', description: "Start from a copy of the user's editor project." },
        name: { type: 'string', maxLength: 200, description: 'Project name.' },
        duration: { type: 'number', minimum: 1, maximum: 14400, description: 'Video length in seconds.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'get_project',
    title: 'Get the studio project',
    description:
      'Returns the AI Studio project as JSON (the format is described in looit_guide). An embedded background image is shown as a placeholder string; keep that string to keep the image.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'set_project',
    title: 'Replace the studio project',
    description:
      'Replaces the AI Studio project with `project` (the full JSON, usually get_project output with your changes). It is validated first; on an error nothing changes and the message names the bad field. This is how you add keyframes, cursor moves, clicks, scrolls, typing, camera moves, panels, text and settings.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'object', description: 'The complete project JSON.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'apply_preset',
    title: 'Apply an animation preset',
    description:
      'Adds a ready-made animation to an object or the camera in the studio project, from `start` for `length` seconds, ending at the values the object has at `start`. Object presets: fadeIn, fadeOut, flyIn, slideIn, pop, popOut. Camera presets: zoomIn, zoomOut, pushIn, pullOut, panLeft, panRight, rise.',
    inputSchema: {
      type: 'object',
      properties: {
        object_id: { type: 'string', description: 'Website panel, text or camera id.' },
        preset: { type: 'string', enum: PRESET_NAMES },
        start: time,
        length: { type: 'number', minimum: 0.05, maximum: 60, description: 'Seconds (default 1).' },
      },
      required: ['object_id', 'preset', 'start'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'inspect_page',
    title: 'Inspect the website',
    description:
      'Plays the studio project to `time` and describes the website as it is then: address, title, scroll position and page height, the clickable elements (links, buttons, menus with dropdowns, fields) and headings, each with its box in website pixels. `x`/`y` of an element in view are cursor coordinates for that moment; `pageY` is its distance from the top of the page, for planning scroll distances. Use `query` to find elements anywhere on the page by text, label or link.',
    inputSchema: {
      type: 'object',
      properties: {
        time,
        website_id: websiteId,
        query: {
          type: 'string',
          maxLength: 200,
          description: 'Only elements whose text, label or link contains this.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Most elements to list (default 80).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'screenshot',
    title: 'Screenshot',
    description:
      "Shows you a frame of the studio project at `time`: target 'scene' (default) is the 3D view the video will show (camera, panels, cursor, background); target 'website' is the page itself at full size. The preview is close to, but not exactly, the exported video (hover effects between events are approximate).",
    inputSchema: {
      type: 'object',
      properties: {
        time,
        target: { type: 'string', enum: ['scene', 'website'] },
        website_id: websiteId,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'preview',
    title: 'Show the preview',
    description:
      'Moves the AI Studio window to `time`, and with play: true plays the animation from there for the user to watch.',
    inputSchema: {
      type: 'object',
      properties: { time, play: { type: 'boolean' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'export_video',
    title: 'Export the video',
    description:
      'Asks the user where to save the MP4 (a Save dialog in the AI Studio window), then renders the studio project frame by frame. Returns at once; call get_status with wait_seconds to follow it. Rendering takes roughly 1-3x the video length at 720p30 (longer for 1080p or 60 fps). When it finishes the studio window plays the video for the user.',
    inputSchema: {
      type: 'object',
      properties: { file_name: fileName },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'save_project',
    title: 'Save the studio project',
    description:
      'Asks the user where to save the studio project as a .looit file (Save dialog), so they can open and edit it in Looit later. Returns at once; get_status reports the result.',
    inputSchema: {
      type: 'object',
      properties: { file_name: fileName },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'get_status',
    title: 'Studio status',
    description:
      "The AI Studio's state: project summary, preview time, and the export and save progress or result. With wait_seconds it waits (up to 50 s) for a running export or open Save dialog to finish before answering.",
    inputSchema: {
      type: 'object',
      properties: { wait_seconds: { type: 'number', minimum: 0, maximum: 50 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];
