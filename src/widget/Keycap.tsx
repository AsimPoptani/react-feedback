import type { ReactNode } from 'react';
export function Keycap({ children }: { children: ReactNode }) {
  return <kbd aria-hidden="true" tabIndex={-1}>{children}</kbd>;
}
