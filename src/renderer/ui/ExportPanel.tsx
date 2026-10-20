import { Film } from 'lucide-react';
import { runExport } from '../actions';
import { estimateSize } from '../exporter';
import { edit, useEditor } from '../store';
import { Row, Toggle } from './controls';

const RESOLUTIONS = [
  { label: '1280 × 720 (HD)', width: 1280, height: 720 },
  { label: '1920 × 1080 (Full HD)', width: 1920, height: 1080 },
];

function formatBytes(b: number): string {
  return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
}

export function ExportPanel() {
  const project = useEditor((s) => s.project);
  const exporting = useEditor((s) => s.exporting);
  const { output } = project;
  return (
    <div className="export-panel">
      <h3>
        <Film size={16} /> Export Video
      </h3>
      <Row label="Resolution">
        <select
          value={`${output.width}x${output.height}`}
          onChange={(e) => {
            const r = RESOLUTIONS.find((x) => `${x.width}x${x.height}` === e.target.value);
            if (r)
              edit((p) => {
                p.output.width = r.width;
                p.output.height = r.height;
              });
          }}
        >
          {RESOLUTIONS.map((r) => (
            <option key={r.label} value={`${r.width}x${r.height}`}>
              {r.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Frame rate">
        <select
          value={output.fps}
          onChange={(e) =>
            edit((p) => {
              p.output.fps = Number(e.target.value);
            })
          }
        >
          <option value={30}>30 fps</option>
          <option value={60}>60 fps (smoother, exports take 2× longer)</option>
        </select>
      </Row>
      <Row label="Format">
        <select value="mp4" disabled>
          <option value="mp4">MP4 (H.264)</option>
        </select>
      </Row>
      <Row label="Speed">
        <Toggle
          checked={output.skipUnchangedFrames !== false}
          label="Skip unchanged website frames"
          onChange={(v) =>
            edit((p) => {
              p.output.skipUnchangedFrames = v;
            })
          }
        />
      </Row>
      <button className="primary wide-btn" disabled={exporting} onClick={() => void runExport()}>
        <Film size={16} /> Export
      </button>
      <p className="hint center">
        Estimated size: ~{formatBytes(estimateSize(project))} ({project.duration.toFixed(1)} s)
      </p>
    </div>
  );
}
