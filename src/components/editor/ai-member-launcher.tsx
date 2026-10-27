'use client';

import Image from 'next/image';
import { useOpenPblEditorContext } from './openpbl-editor-context';

/** Pinned outside the formatting toolbar's overflow groups. */
export function AiMemberLauncher() {
  const { aiMember, openAiMember } = useOpenPblEditorContext();
  if (!openAiMember || aiMember?.phase === 'open') return null;
  const returning = aiMember?.phase === 'closing';
  const leaving = aiMember?.phase === 'opening';

  return (
    <div className="mr-1 flex shrink-0 items-center border-r border-stone-200 pr-1" data-toolbar-overflow-group="ai-member">
      <button
        aria-label="唤醒 AI 组员"
        aria-controls={aiMember?.panelId}
        aria-expanded={leaving}
        aria-busy={returning || leaving || undefined}
        className="inline-flex h-11 items-center gap-2 rounded-md px-2 text-stone-600 transition-colors hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-700"
        disabled={returning || leaving}
        onClick={openAiMember}
        onMouseDown={(event) => event.preventDefault()}
        ref={aiMember?.launcherRef}
        style={{ visibility: returning ? 'hidden' : undefined }}
        type="button"
      >
        <span className="block size-8 shrink-0" ref={aiMember?.avatarRef} style={{ visibility: leaving ? 'hidden' : undefined }}>
          <Image alt="" className="size-8 rounded-full object-cover" height={32} src="/openmaic/avatars/ai-teammate.webp" width={32} />
        </span>
        <span className="text-[11px] font-medium transition-opacity duration-150 motion-reduce:transition-none" style={{ opacity: leaving ? 0 : 1 }}>点击唤醒组员</span>
      </button>
    </div>
  );
}
