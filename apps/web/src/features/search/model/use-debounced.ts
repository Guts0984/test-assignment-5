import { useEffect, useState } from 'react';

/** The value, but only after it has stopped changing for `delayMs`. */
export const useDebounced = <T>(value: T, delayMs: number): T => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
};
