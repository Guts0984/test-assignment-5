'use client';

import { useSyncExternalStore } from 'react';

type Toast = { id: number; message: string; kind: 'error' | 'success' | 'info' };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Shows a short message. Works from anywhere (event handlers, mutation callbacks). */
export const toast = (message: string, kind: Toast['kind'] = 'info'): void => {
  const id = nextId++;
  toasts = [...toasts, { id, message, kind }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== id);
    emit();
  }, 6_000);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Messages are announced to assistive technology as they appear. */
export const Toaster = () => {
  const items = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => [],
  );
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 grid max-w-sm gap-2"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={`pointer-events-auto rounded-md border px-4 py-3 text-sm shadow-lg ${item.kind === 'error' ? 'border-danger bg-background text-danger' : 'border-border bg-background'}`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
};
