"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";

/** A timed slideshow over two stationary paper outlines. Cards keep their
 * original DOM order; only the current card fades into the reading surface. */
export function GenerationCardDeck<T extends { id: string }>({
  items, running, intervalMs, children,
}: {
  items: readonly T[];
  running: boolean;
  intervalMs: number;
  children: (item: T, current: boolean, animating: boolean) => ReactNode;
}) {
  const reduced = useReducedMotion();
  const [turn, setTurn] = useState(0);
  const moving = running && !reduced;
  useEffect(() => {
    if (!moving || items.length < 2) return;
    const timer = window.setInterval(() => setTurn(value => value + 1), intervalMs);
    return () => window.clearInterval(timer);
  }, [moving, intervalMs, items.length]);
  const current = items.length - 1 - (turn % Math.max(1, items.length));

  return <>
    {[2, 1].map(layer => <div aria-hidden key={layer}
      className="absolute inset-0 rounded-[14px] border border-stone-200 bg-stone-50"
      style={{ transform: `translate(${layer * 5}px, ${layer * -8}px) rotate(${layer * -1.5}deg)` }} />)}
    {items.map((item, index) => {
      const visible = index === current;
      return <article key={item.id} aria-hidden={!visible} data-current-card={visible || undefined}
        className="absolute inset-0 overflow-hidden rounded-[14px] border border-stone-200 bg-white shadow-[0_20px_48px_rgba(41,37,36,.18)]"
        style={{ opacity: visible ? 1 : 0, zIndex: visible ? 2 : 1,
          pointerEvents: visible ? 'auto' : 'none', transform: `translateY(${visible ? 0 : 8}px)`,
          transition: moving ? 'opacity 360ms ease, transform 360ms ease' : 'none' }}>
        {children(item, visible, moving)}
      </article>;
    })}
  </>;
}
