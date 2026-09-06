import { useLayoutEffect, useRef } from "react";

/** Components holding credentials are keyed by that credential. Abort every
 * read/download when that scope is replaced, including pending file saves. */
export function useRequestScope() {
  const scope = useRef(new AbortController());
  // Revoke before the replacement screen is painted, including file saves.
  useLayoutEffect(() => () => scope.current.abort(), []);
  return scope.current.signal;
}
