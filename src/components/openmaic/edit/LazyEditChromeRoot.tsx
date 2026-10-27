'use client';

import { useEffect, useState, type ComponentProps } from 'react';
import { preloadEditor } from '@openmaic/lib/edit/preload-editor';

type EditorRoot = typeof import('./EditChromeRoot').EditChromeRoot;

let loadedEditor: EditorRoot | null = null;
let editorReady: Promise<EditorRoot> | null = null;

/** Student playback never requests the teacher editor or its authoring dependencies. */
export function preloadEditChrome(): Promise<EditorRoot> {
  if (!editorReady) {
    editorReady = new Promise<EditorRoot>((resolve, reject) => {
      // Dynamic imports cannot be aborted. Bound the UI wait so a stalled chunk
      // still offers recovery, and ignore its eventual result after timeout.
      const timer = setTimeout(() => reject(new Error('编辑器加载超时，请重试。')), 30_000);
      Promise.all([import('./EditChromeRoot'), preloadEditor()]).then(
        ([module]) => { clearTimeout(timer); resolve(module.EditChromeRoot); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    }).then((Editor) => {
      loadedEditor = Editor;
      return Editor;
    }).catch((error: unknown) => {
      editorReady = null;
      throw error;
    });
  }
  return editorReady;
}

export function LazyEditChromeRoot(props: ComponentProps<EditorRoot>) {
  const [Editor, setEditor] = useState<EditorRoot | null>(() => loadedEditor);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void preloadEditChrome().then(
      (Root) => { if (active) setEditor(() => Root); },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error && reason.message.includes('加载超时')
          ? reason.message
          : '编辑器暂时加载失败，请检查网络后重试。');
      },
    );
    return () => { active = false; };
  }, [attempt]);

  if (Editor) return <Editor {...props} />;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-sm">
      <p role={error ? 'alert' : 'status'}>{error ?? '正在加载课堂编辑器…'}</p>
      <div className="flex gap-3">
        {error && <button
          type="button"
          className="rounded-lg border px-4 py-2"
          onClick={() => { setError(null); setAttempt((value) => value + 1); }}
        >重新加载编辑器</button>}
        {props.onToggleEditMode && <button
          type="button"
          className="rounded-lg border px-4 py-2"
          onClick={props.onToggleEditMode}
        >返回课堂</button>}
      </div>
    </div>
  );
}
