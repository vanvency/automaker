import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '@/lib/utils';

// Type-safe wrappers for Radix UI primitives (React 19 compatibility)
const PopoverTriggerPrimitive = PopoverPrimitive.Trigger as React.ForwardRefExoticComponent<
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger> & {
    children?: React.ReactNode;
    asChild?: boolean;
  } & React.RefAttributes<HTMLButtonElement>
>;

const PopoverContentPrimitive = PopoverPrimitive.Content as React.ForwardRefExoticComponent<
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    className?: string;
  } & React.RefAttributes<HTMLDivElement>
>;

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  children,
  asChild,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger> & {
  children?: React.ReactNode;
  asChild?: boolean;
}) {
  return (
    <PopoverTriggerPrimitive data-slot="popover-trigger" asChild={asChild} {...props}>
      {children}
    </PopoverTriggerPrimitive>
  );
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  className?: string;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverContentPrimitive
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain origin-(--radix-popover-content-transform-origin) rounded-xl border border-border/70 p-4 shadow-lg outline-hidden motion-reduce:animate-none',
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
