import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { askBeforeLeaving, holdLeaves } from "./leave-guard";
import { useGuardedRouter } from "./use-leave-guard";

// F-006/c4 (app-targets/m10-gaps/github-events.md, "Leaving the result any other way … asks
// first"): while Turn on's result holds the webhook secret, a leave through the router the shell
// navigates with (its keys, its palette, its panels' buttons) and signing out go to the page's
// guard, which runs them once the person says Leave. Links, Back and Esc are the browser's:
// `e2e/28-github-events.spec.ts`.

type Navigation = { readonly how: "push" | "replace"; readonly href: string; readonly options: unknown };

const next = vi.hoisted(() => {
  const navigations: Navigation[] = [];
  return { navigations };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string, options?: unknown) => { next.navigations.push({ how: "push", href, options }); },
    replace: (href: string, options?: unknown) => { next.navigations.push({ how: "replace", href, options }); },
    back: () => undefined,
    forward: () => undefined,
    refresh: () => undefined,
    prefetch: () => undefined,
  }),
}));

type Router = ReturnType<typeof useGuardedRouter>;

/** The guarded router, as a component in the shell gets it. */
const guardedRouter = (): Router => {
  const routers: Router[] = [];
  const Probe = () => {
    routers.push(useGuardedRouter());
    return null;
  };
  renderToStaticMarkup(<Probe />);
  const router = routers[0];
  if (router === undefined) throw new Error("the probe didn't render");
  return router;
};

describe("leaving a page that holds what it can't show again", () => {
  it("F-006/c4: while the page holds the secret, the shell's router waits for its guard, and goes once the guard says Leave", () => {
    next.navigations.length = 0;
    const router = guardedRouter();
    router.push("/needs-you");
    expect(next.navigations).toEqual([{ how: "push", href: "/needs-you", options: undefined }]);

    const asked: (() => void)[] = [];
    const release = holdLeaves((go) => { asked.push(go); });
    router.push("/tasks/new", { scroll: false });
    router.replace("/sign-in");
    expect(next.navigations).toHaveLength(1);
    expect(asked).toHaveLength(2);
    // Leave: the navigation it held, as the shell asked for it.
    asked[0]?.();
    expect(next.navigations[1]).toEqual({ how: "push", href: "/tasks/new", options: { scroll: false } });
    asked[1]?.();
    expect(next.navigations[2]).toEqual({ how: "replace", href: "/sign-in", options: undefined });

    // Done: nothing holds, and the router goes at once.
    release();
    router.push("/");
    expect(next.navigations[3]).toEqual({ how: "push", href: "/", options: undefined });
    expect(asked).toHaveLength(2);
  });

  it("F-006/c4: signing out asks the page that holds the secret first, and the last page to hold asks", () => {
    const signedOut: string[] = [];
    askBeforeLeaving(() => { signedOut.push("now"); });
    expect(signedOut).toEqual(["now"]);

    const first: (() => void)[] = [];
    const second: (() => void)[] = [];
    const releaseFirst = holdLeaves((go) => { first.push(go); });
    const releaseSecond = holdLeaves((go) => { second.push(go); });
    askBeforeLeaving(() => { signedOut.push("after the second's Leave"); });
    expect([first.length, second.length]).toEqual([0, 1]);
    second[0]?.();
    expect(signedOut).toEqual(["now", "after the second's Leave"]);

    releaseSecond();
    askBeforeLeaving(() => { signedOut.push("after the first's Leave"); });
    expect(first).toHaveLength(1);
    releaseFirst();
    // A release twice, or of a guard already gone, holds nothing back.
    releaseFirst();
    askBeforeLeaving(() => { signedOut.push("at once"); });
    expect(signedOut).toEqual(["now", "after the second's Leave", "at once"]);
  });
});
