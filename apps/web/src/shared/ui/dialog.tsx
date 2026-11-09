'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** A modal with focus trapping, Escape to close and a labelled title (Radix). */
export const Modal = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) => (
  <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(42rem,95vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close className="rounded-md p-1 hover:bg-muted" aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
);
