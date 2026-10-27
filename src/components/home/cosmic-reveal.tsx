"use client";
import { createElement, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 滚动渐入动画组件（Cinematic Immersive 版）
 * - 支持 stagger（子元素错峰渐入）
 * - 支持 delay（自定义延迟）
 * - 自动适配 prefers-reduced-motion
 */
export function CosmicReveal({
  children,
  className,
  stagger = false,
  delay = 0,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  stagger?: boolean;
  delay?: number;
  as?: "div" | "section" | "article" | "li" | "span" | "ul" | "ol";
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = element;
    if (!el) return;

    // 可访问性：减少动画时直接显示
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-visible");
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const target = entry.target as HTMLElement;
            if (delay > 0) {
              target.style.transitionDelay = `${delay}ms`;
            }
            target.classList.add("is-visible");
            observer.unobserve(target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -60px 0px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [delay, element]);

  return createElement(
    Tag,
    {
      ref: setElement,
      className: cn(stagger ? "pbl-stagger" : "pbl-cosmic-reveal", className),
    },
    children,
  );
}
