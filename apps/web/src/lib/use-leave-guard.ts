import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { askBeforeLeaving, holdLeaves } from "./leave-guard";
import type { LeaveGuard } from "./leave-guard";

// The leave guard's hooks (`leave-guard.ts`): the router the shell navigates with, and a page's hold.

type Router = ReturnType<typeof useRouter>;

/**
 * The app router, for the shell around every page: its `push` and `replace` ask a page that holds
 * its leaves first. Next's router has no way to stop a navigation, so the shell navigates with this.
 */
export const useGuardedRouter = (): Router => {
  const router = useRouter();
  return useMemo(
    (): Router => ({
      ...router,
      push: (href, options) => { askBeforeLeaving(() => { router.push(href, options); }); },
      replace: (href, options) => { askBeforeLeaving(() => { router.replace(href, options); }); },
    }),
    [router],
  );
};

/**
 * While `holding`, every way out of the page goes to `onLeave` first: the guarded router's
 * navigations and signing out, a click on a link to another of the panel's pages, Back and
 * Forward, and the browser's own leave (reload, close, another address), which the browser asks
 * about itself.
 */
export const useLeaveGuard = (holding: boolean, onLeave: LeaveGuard): void => {
  const router = useRouter();
  useEffect(() => {
    if (!holding) return undefined;
    // The entry the page is on, put back when Back or Forward moves off it.
    const here: { readonly state: unknown; readonly url: string } = { state: window.history.state, url: window.location.href };
    // Back and Forward: the browser has moved already. The router hasn't (this runs before its own
    // listener, which it stops), so the page stays as it is, its entry goes back on top, and the
    // move waits for the guard.
    const release = holdLeaves(onLeave, (event) => {
      const to = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      event.stopImmediatePropagation();
      window.history.pushState(here.state, "", here.url);
      onLeave(() => { router.push(to); });
    });
    const beforeUnload = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    const click = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      event.stopPropagation();
      const to = `${url.pathname}${url.search}`;
      onLeave(() => { router.push(to); });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      release();
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [holding, onLeave, router]);
};
