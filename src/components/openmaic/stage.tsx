'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useStageStore } from '@openmaic/lib/store';
import { isCurrentSceneEditable } from '@openmaic/lib/edit/stage-mode';
import { isMaicEditorEnabled } from '@openmaic/lib/config/feature-flags';
import { LazyEditChromeRoot, preloadEditChrome } from '@openmaic/components/edit/LazyEditChromeRoot';
import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@openmaic/components/edit/PlaybackChromeRoot';
import { useEditModeLock } from '@openmaic/components/edit/use-edit-mode-lock';
import { MultiTabEditConflictPrompt } from '@openmaic/components/edit/MultiTabEditConflictPrompt';
import { InteractiveIframeHost } from '@openmaic/components/scene-renderers/InteractiveIframeHost';
import { CHROME_EASE } from '@openmaic/lib/edit/transitions';
import type { PlaybackSyncState, StageExperience } from '@openmaic/components/stage-experience';

/**
 * Stage — top-level classroom container. Dispatches between the two
 * chrome roots based on `useStageStore.mode`:
 *
 *   mode === 'edit'                → EditChromeRoot
 *   mode === 'playback' / 'autonomous' → PlaybackChromeRoot
 *
 * The two roots are wholly independent. Stage's only responsibilities
 * are: mode dispatch, edit-lock coordination (cross-tab), Pro Switch
 * toggle wiring (calls into PlaybackChromeRoot.teardown via ref before
 * flipping mode), and rendering the cross-tab conflict prompt (which
 * needs to be mountable from playback mode too, since the lock-conflict
 * dialog can surface when Pro Switch is clicked but acquire fails).
 */
export function Stage({
  active = true,
  onRetryOutline,
  experience = 'student-course',
  autoplaySceneId,
  playbackState,
  onPlaybackStateChange,
  interactionState,
  allowSceneDirectory = false,
  onCourseReviewStart,
  sidebarCollapsed,
  onSidebarCollapsedChange,
  editorCourseId,
}: {
  active?: boolean;
  onRetryOutline?: (outlineId: string) => Promise<void>;
  experience?: StageExperience;
  /** Starts this scene as soon as its playback engine is ready. */
  autoplaySceneId?: string;
  playbackState?: PlaybackSyncState;
  onPlaybackStateChange?: (state: Omit<PlaybackSyncState, 'version'>) => void;
  /**
   * Teacher-side interaction state to apply to the student's interactive
   * iframe (projected-readonly experience only). PlaybackChromeRoot watches
   * this and sends `apply-state` postMessages into the iframe so students
   * see the teacher's manipulations replayed on their device.
   */
  interactionState?: Record<string, unknown> | null;
  /** Teacher preview and students reviewing a course may browse its directory. */
  allowSceneDirectory?: boolean;
  onCourseReviewStart?: () => void;
  /** Controlled page-thumbnail rail state for embedded preview surfaces. */
  sidebarCollapsed?: boolean;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  /** Authorizes AI editing when Stage is embedded in a teacher preparation route. */
  editorCourseId?: string;
}) {
  const { mode, setMode, scenes, currentSceneId, generatingOutlines, stage } = useStageStore();
  const currentScene = useStageStore((s) => s.getCurrentScene());

  // Predicate for "can the user enter Pro mode for the current scene?".
  // Single source of truth feeds the Header's Pro Switch state and the
  // auto-exit effect below; keeping them in lock-step prevents an
  // edit-mode entry that would immediately auto-exit.
  const isEditable = isCurrentSceneEditable({
    currentSceneId,
    sceneCount: scenes.length,
    generatingOutlineCount: generatingOutlines.length,
    hasCurrentScene: !!currentScene,
  });

  // Cross-tab edit lock (#571). Lives at this layer because entry must
  // be refused BEFORE the live session is torn down; PlaybackChromeRoot
  // can't own this since it can't refuse its own unmount path.
  const editLock = useEditModeLock(stage?.id);

  const playbackRef = useRef<PlaybackChromeRootHandle>(null);
  const editorLoadingRef = useRef(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Pro Switch handler. Edit→playback is a plain flip (PlaybackChromeRoot
  // will mount fresh; its engine effect re-inits). Playback→edit must
  // (1) refuse on lock conflict, (2) await SSE / engine / TTS teardown
  // so PlaybackChromeRoot is quiescent before it unmounts.
  const handleToggleEditMode = useCallback(async () => {
    if (mode === 'edit') {
      setMode('playback');
      return;
    }
    if (editorLoadingRef.current) return;
    if (!editLock.acquire()) return;
    editorLoadingRef.current = true;
    setEditorLoading(true);
    setEditorError(null);
    try {
      // Keep the current player usable while editor-only code and surfaces
      // download. A failed import must not tear down the working lesson.
      await preloadEditChrome();
      await playbackRef.current?.teardown();
    } catch (err) {
      // Loading or teardown failed after the lock was acquired but before we
      // flipped into edit mode. Release the lock we just took: otherwise it
      // stays HELD while mode stays 'playback', and the release effect (keyed
      // on `mode`) never re-fires, stranding the lock until tab close and
      // blocking this and every other tab from Pro mode. Stay in playback so
      // the failure surfaces rather than half-entering edit mode.
      editLock.release();
      console.error('[Stage] Pro mode entry failed', err);
      setEditorError('编辑器暂时加载失败，当前课堂仍可继续使用。');
      return;
    } finally {
      editorLoadingRef.current = false;
      setEditorLoading(false);
    }
    setMode('edit');
  }, [editLock, mode, setMode]);

  // Auto-exit edit mode when the current scene becomes uneditable
  // (pending generation, no scenes, currently generating).
  useEffect(() => {
    if (mode === 'edit' && !isEditable) {
      setMode('playback');
    }
  }, [mode, isEditable, setMode]);

  // Release the lock whenever we're not in edit mode (covers manual
  // exit, auto-exit, scene becomes uneditable). The hook also self-
  // releases on unmount / tab close.
  const releaseEditLock = editLock.release;
  useEffect(() => {
    if (mode !== 'edit') releaseEditLock();
  }, [mode, releaseEditLock]);

  const toggleHandler = isMaicEditorEnabled() ? handleToggleEditMode : undefined;

  // Mode swap choreography — a clean opacity cross-fade. Both roots layer
  // via `absolute inset-0` so they coexist for the ~280ms window without
  // one popping out before the other arrives. The outgoing root keeps
  // rendering its canvas during exit so `canvasStore` (the shared scale
  // writer) doesn't briefly read zero.
  //
  // Deliberately NO transform (translateY) on these layers: the edit
  // chrome hosts the Pro Switch / settings pill, which morph across the
  // swap via `layoutId`. A transform on this ancestor distorts motion's
  // layout measurement (the pill visibly drifts) and the blurred chrome
  // would repaint its backdrop-filter every frame while translating. A
  // pure fade keeps layout static so the shared elements land precisely.
  return (
    <div className="relative flex flex-1 overflow-hidden">
      <AnimatePresence initial={false}>
        {mode === 'edit' && currentScene ? (
          <motion.div
            key="edit"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: CHROME_EASE }}
            className="absolute inset-0 flex"
          >
            <LazyEditChromeRoot
              scene={currentScene}
              isEditable={isEditable}
              onToggleEditMode={toggleHandler}
              courseId={editorCourseId}
            />
          </motion.div>
        ) : (
          <motion.div
            key="playback"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: CHROME_EASE }}
            className="absolute inset-0 flex"
          >
            <PlaybackChromeRoot
              active={active}
              ref={playbackRef}
              onRetryOutline={onRetryOutline}
              canEnterProMode={isEditable}
              onEnterProMode={toggleHandler}
              experience={experience}
              autoplaySceneId={autoplaySceneId}
              playbackState={playbackState}
              onPlaybackStateChange={onPlaybackStateChange}
              interactionState={interactionState}
              allowSceneDirectory={allowSceneDirectory}
              onCourseReviewStart={onCourseReviewStart}
              sidebarCollapsed={sidebarCollapsed}
              onSidebarCollapsedChange={onSidebarCollapsedChange}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {(editorLoading || editorError) && mode !== 'edit' && (
        <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-lg border bg-background px-4 py-3 text-sm shadow">
          <p role={editorError ? 'alert' : 'status'}>{editorError ?? '正在加载课堂编辑器…'}</p>
          {editorError && <button type="button" className="mt-2 underline" onClick={handleToggleEditMode}>重试</button>}
        </div>
      )}
      <MultiTabEditConflictPrompt
        open={editLock.conflictOpen}
        onDismiss={editLock.dismissConflict}
      />
      {/* Keep-alive host for interactive scene iframes (#619). Lives here, above
          the mode-swap subtree, so its iframes survive Pro mode toggles and
          scene switches instead of reloading on every remount. */}
      <InteractiveIframeHost />
    </div>
  );
}
