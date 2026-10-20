// The AI Studio window: shows what the AI is building. The user watches the
// live preview here; the only control is the finished video's player.

import { Bot } from 'lucide-react';
import { useEditor } from '../store';
import { Viewport } from '../ui/Viewport';
import { useStudio } from './commands';

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function Activity() {
  const exp = useStudio((s) => s.export);
  const activity = useStudio((s) => s.activity);
  const status = useEditor((s) => s.status);
  if (exp.phase === 'exporting') {
    const pct = exp.total ? Math.round((exp.done / exp.total) * 100) : 0;
    return (
      <span className="studio-activity">
        Rendering the video · frame {exp.done} of {exp.total || '…'}
        <progress max={100} value={pct} />
      </span>
    );
  }
  const text = status?.error ? status.text : activity;
  return <span className={`studio-activity${status?.error ? ' error' : ''}`}>{text}</span>;
}

export function Studio() {
  const name = useEditor((s) => s.project.name);
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.project.duration);
  const videoUrl = useStudio((s) => s.videoUrl);
  const path = useStudio((s) => s.export.path);

  return (
    <div className="studio">
      <header className="studio-bar">
        <span className="studio-title">
          <Bot size={16} /> AI Studio
        </span>
        <span className="studio-project">{name}</span>
        <Activity />
        {!videoUrl && (
          <span className="studio-time">
            {formatTime(time)} / {formatTime(duration)}
          </span>
        )}
      </header>
      <div className="studio-stage">
        <Viewport readOnly />
        {videoUrl && (
          <div className="studio-video">
            <video src={videoUrl} controls autoPlay />
            <p className="muted small">{path}</p>
          </div>
        )}
      </div>
      <footer className="studio-note muted small">
        An AI is working in this window. It can't change your projects in the editor, and it saves only where you
        choose.
      </footer>
    </div>
  );
}
