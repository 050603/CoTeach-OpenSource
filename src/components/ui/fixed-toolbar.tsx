'use client';

import { cn } from '@/lib/utils';

import { Toolbar } from './toolbar';

export function FixedToolbar({
  className,
  style,
  ...props
}: React.ComponentProps<typeof Toolbar>) {
  return (
    <Toolbar
      {...props}
      className={cn(
        'sticky left-0 z-[60] w-full justify-between overflow-hidden rounded-t-lg border-b border-b-border bg-background/95 p-1 backdrop-blur-sm supports-backdrop-blur:bg-background/60',
        className
      )}
      style={{ top: 'var(--plate-toolbar-sticky-top, 0px)', ...style }}
    />
  );
}
