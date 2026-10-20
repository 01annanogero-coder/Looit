// Autosave: the onboarding library keeps every project as a .looit file, so
// every accepted change is written back shortly after the user stops editing.

import { useEffect } from 'react';
import { savePending } from './actions';
import { useEditor } from './store';

/** How long an edit rests before it is written. Long enough to group a drag. */
const DEBOUNCE_MS = 500;

export function useAutosave(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (s.project === prev.project) return;
      if (!s.filePath || s.exporting) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void savePending();
      }, DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
