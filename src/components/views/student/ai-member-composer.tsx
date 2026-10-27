"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "radix-ui";
import { LoaderCircle, Maximize2, Minimize2, Send } from "lucide-react";
import styles from "./ai-member-composer.module.css";

type Props = {
  busy: boolean;
  disabled?: boolean;
  draft: string;
  maxLength: number;
  placeholder: string;
  onChangeDraft: (value: string) => void;
  onSubmit: () => void;
};

/** Both views edit the parent's draft so closing the dialog never discards text. */
export function AiMemberComposer({ busy, disabled = false, draft, maxLength, placeholder, onChangeDraft, onSubmit }: Props) {
  const [expanded, setExpanded] = useState(false);
  const expandedInput = useRef<HTMLTextAreaElement>(null);
  const blocked = busy || disabled;
  const canSend = !blocked && Boolean(draft.trim()) && draft.length <= maxLength;

  function send() {
    if (!canSend) return;
    onSubmit();
    setExpanded(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)
      || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  }

  function input(fullscreen: boolean) {
    return <textarea
      aria-label="发给 AI 组员的消息"
      className={fullscreen ? styles.fullscreenInput : styles.input}
      disabled={blocked}
      maxLength={maxLength}
      onChange={(event) => onChangeDraft(event.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      ref={fullscreen ? expandedInput : undefined}
      rows={4}
      value={draft}
    />;
  }

  function sendButton() {
    return <button aria-label="发送给 AI 组员" className={styles.send} disabled={!canSend} type="submit">
      {busy ? <LoaderCircle className="animate-spin" size={16} /> : <Send size={16} />}
      <span>发送</span>
    </button>;
  }

  const counter = <span className="text-xs tabular-nums text-stone-500" aria-live="off">{draft.length} / {maxLength}</span>;

  return <Dialog.Root open={expanded} onOpenChange={setExpanded}>
    <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); send(); }}>
      {input(false)}
      <div className={styles.toolbar}>
        <Dialog.Trigger asChild>
          <button className={styles.expand} type="button"><Maximize2 size={16} />全屏输入</button>
        </Dialog.Trigger>
        <div className="flex items-center gap-3">{counter}{sendButton()}</div>
      </div>
    </form>
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} />
      <Dialog.Content className={styles.dialog} onOpenAutoFocus={(event) => {
        event.preventDefault();
        expandedInput.current?.focus();
      }} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <div className="min-w-0">
            <Dialog.Title className="text-base font-semibold text-stone-950">给 AI 组员发消息</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-stone-500">Enter 换行，Ctrl / ⌘ + Enter 发送。收起后保留已输入内容。</Dialog.Description>
          </div>
          <Dialog.Close asChild>
            <button className={styles.expand} type="button"><Minimize2 size={16} />收起</button>
          </Dialog.Close>
        </div>
        <form className={styles.fullscreenForm} onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          send();
        }}>
          {input(true)}
          <div className={styles.toolbar}>{counter}{sendButton()}</div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
