import { useEffect, useState } from "react";
import { fetchCurated, getCachedCurated } from "./curatedCache";
import { itemToId } from "./search";

export function showcaseRouteId(pathname: string): number | null {
  const match = pathname.match(/^\/case\/(?:PanTS_?)?([0-9]{1,8})\/?$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return id >= 1 && id <= 9901 ? id : null;
}

/** null = checking; false = fail closed. Never admit from a search response. */
export function useShowcaseAccess(pathname: string, enabled: boolean): boolean | null {
  const id = showcaseRouteId(pathname);
  const [answer, setAnswer] = useState<{ id: number; allowed: boolean } | null>(null);
  const cached = enabled && id !== null ? getCachedCurated() : null;
  useEffect(() => {
    if (!enabled || id === null || cached) return;
    let cancelled = false;
    fetchCurated().then(
      (items) => { if (!cancelled) setAnswer({ id, allowed: items.some((item) => itemToId(item) === id) }); },
      () => { if (!cancelled) setAnswer({ id, allowed: false }); },
    );
    return () => { cancelled = true; };
  }, [id, enabled, cached]);
  if (!enabled || id === null) return false;
  if (cached) return cached.some((item) => itemToId(item) === id);
  return answer?.id === id ? answer.allowed : null;
}
