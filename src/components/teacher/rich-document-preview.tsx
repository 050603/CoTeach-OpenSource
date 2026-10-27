"use client";

import { Plate, usePlateEditor } from "platejs/react";
import { BaseEditorKit } from "@/components/editor/editor-base-kit";
import { EditorStatic } from "@/components/ui/editor-static";

const EMPTY_DOCUMENT = "<p></p>";

/** Read-only renderer shared by teacher monitoring and archived snapshots. */
export function RichDocumentPreview({
  html,
  className,
  minHeight = 180,
}: {
  html: string;
  className?: string;
  minHeight?: number;
}) {
  const editor = usePlateEditor({
    plugins: BaseEditorKit,
    value: html || EMPTY_DOCUMENT,
  }, [html]);
  return (
    <div
      className={className}
      style={{ minHeight }}
      data-document-preview="true"
    >
      <Plate editor={editor} readOnly>
        <EditorStatic
          className="pointer-events-none min-h-full whitespace-pre-wrap px-1 py-1 text-sm leading-7 text-stone-700"
          editor={editor}
          value={editor.children}
        />
      </Plate>
    </div>
  );
}
