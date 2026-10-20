import { Eye, EyeOff, Globe, Layers, MousePointer2, Plus, Settings2, Type, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SceneObject } from '../../engine/project';
import { addText, addWebsite, setVisible } from '../actions';
import { select, useEditor } from '../store';

const ICONS: Record<SceneObject['kind'], ReactNode> = {
  website: <Globe size={15} />,
  text: <Type size={15} />,
  cursor: <MousePointer2 size={15} />,
  camera: <Video size={15} />,
};

function ObjectRow({ obj, depth }: { obj: SceneObject; depth: number }) {
  const selected = useEditor((s) => s.selectedId === obj.id);
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}${obj.visible ? '' : ' hidden-obj'}`}
      style={{ paddingLeft: 10 + depth * 16 }}
      onClick={() => select(obj.id)}
    >
      {ICONS[obj.kind]}
      <span className="tree-name">{obj.name}</span>
      <button
        className="icon-btn ghost"
        title={obj.visible ? 'Hide' : 'Show'}
        onClick={(e) => {
          e.stopPropagation();
          setVisible(obj.id, !obj.visible);
        }}
      >
        {obj.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    </div>
  );
}

export function Hierarchy() {
  const objects = useEditor((s) => s.project.objects);
  const sceneSelected = useEditor((s) => s.selectedId === null);
  const websites = objects.filter((o) => o.kind === 'website');
  const camera = objects.find((o) => o.kind === 'camera');
  const cameraSelected = useEditor((s) => !!camera && s.selectedId === camera.id);
  const cameraAnimated =
    camera?.kind === 'camera' &&
    camera.position.keyframes.length + camera.target.keyframes.length + camera.zoom.keyframes.length > 0;
  const texts = objects.filter((o) => o.kind === 'text');
  return (
    <div className="hierarchy">
      <div className="panel-title">
        <Layers size={15} /> Scene Hierarchy
      </div>
      <div className="tree">
        {camera && (
          <div
            className={`tree-row${cameraSelected ? ' selected' : ''}`}
            title="The camera stays still unless you animate it"
            onClick={() => select(camera.id)}
          >
            <Video size={15} />
            <span className="tree-name">{cameraAnimated ? 'Camera' : 'Camera (fixed)'}</span>
          </div>
        )}
        <div className={`tree-row${sceneSelected ? ' selected' : ''}`} onClick={() => select(null)}>
          <Settings2 size={15} />
          <span className="tree-name">Scene settings</span>
        </div>
        {websites.map((w) => (
          <div key={w.id}>
            <ObjectRow obj={w} depth={0} />
            {objects
              .filter((o) => o.kind === 'cursor' && o.targetId === w.id)
              .map((c) => (
                <ObjectRow key={c.id} obj={c} depth={1} />
              ))}
          </div>
        ))}
        {texts.map((t) => (
          <ObjectRow key={t.id} obj={t} depth={0} />
        ))}
      </div>
      <div className="btn-pair add-btn">
        <button className="wide-btn" onClick={addWebsite}>
          <Plus size={14} /> Add website
        </button>
        <button className="wide-btn" onClick={addText}>
          <Plus size={14} /> Add text
        </button>
      </div>
    </div>
  );
}
