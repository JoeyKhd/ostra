import type { Page } from "../cdp/page.ts";
import type { InputEvent } from "../wire.ts";

// The member's input onto the shared page: mouse and wheel as Input.dispatchMouseEvent, keys as
// dispatchKeyEvent (keyDown with text for a printable key, rawKeyDown for the rest), and pasted text as
// insertText. Events are applied one at a time, in order.

export const dispatchInput = async (page: Page, event: InputEvent): Promise<void> => {
  switch (event.t) {
    case "mouse":
      await page.send("Input.dispatchMouseEvent", {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button,
        buttons: event.buttons,
        clickCount: event.clickCount,
        modifiers: event.modifiers,
      });
      return;
    case "wheel":
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: event.modifiers,
      });
      return;
    case "key": {
      const printable = event.type === "keyDown" && event.text !== undefined;
      const params: Record<string, unknown> = {
        type: event.type === "keyUp" ? "keyUp" : printable ? "keyDown" : "rawKeyDown",
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        nativeVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers,
        autoRepeat: event.repeat,
      };
      if (printable) {
        params["text"] = event.text;
        params["unmodifiedText"] = event.text;
      }
      await page.send("Input.dispatchKeyEvent", params);
      return;
    }
    case "text":
      await page.send("Input.insertText", { text: event.text });
      return;
    default:
      event satisfies never;
  }
};

export const createInputQueue = (page: () => Page | null) => {
  let chain: Promise<void> = Promise.resolve();
  let applied = 0;
  let failed = 0;
  const push = (events: readonly InputEvent[]) => {
    for (const event of events) {
      chain = chain.then(async () => {
        const current = page();
        if (current === null) return;
        try {
          await dispatchInput(current, event);
          applied += 1;
        } catch {
          failed += 1;
        }
      });
    }
  };
  return { push, counts: () => ({ applied, failed }) };
};
