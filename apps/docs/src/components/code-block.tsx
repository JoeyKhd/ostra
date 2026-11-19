"use client";

import { Check, Copy, Play } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

/** A copy button: `check` and an announced `Copied` for 2 s. */
export const CopyButton = ({ text, className = "copy-button" }: { readonly text: string; readonly className?: string }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  return (
    <button
      type="button"
      className={`${className} needs-js`}
      aria-label={copied ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
        });
      }}
    >
      {copied ? <Check size={15} strokeWidth={1.75} aria-hidden="true" className="copied-icon" /> : <Copy size={15} strokeWidth={1.75} aria-hidden="true" />}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
};

/** The languages drawn as commands, without line numbers. */
const shellLanguages = new Set(["sh", "bash", "shell", "console", "text", "powershell"]);

/**
 * A code block (docs-guide.md, "Code block"): the language strip, the `run` marker on blocks ostra
 * runs before each release, the copy button, and a body that scrolls sideways and never wraps.
 */
export const CodeBlock = ({ code, lang, run }: { readonly code: string; readonly lang: string; readonly run: boolean }) => {
  const tipId = useId();
  const body = useRef<HTMLPreElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = body.current;
    if (element === null) {
      return undefined;
    }
    const measure = () => {
      setOverflows(element.scrollWidth > element.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const text = code.replace(/\n$/, "");
  const numbered = !shellLanguages.has(lang);
  return (
    <div className="code-block" data-run={run ? "true" : undefined}>
      <div className="code-strip">
        <span className="code-lang">{lang}</span>
        <span className="code-actions">
          {run ? (
            <span className="run-chip" tabIndex={0} aria-describedby={tipId}>
              <Play size={12} strokeWidth={1.75} aria-hidden="true" />
              run
              <span role="tooltip" id={tipId} className="tooltip">
                ostra runs this block on a fresh machine before each release.
              </span>
            </span>
          ) : null}
          <CopyButton text={text} />
        </span>
      </div>
      <pre ref={body} className={overflows ? "code-body is-overflowing" : "code-body"} tabIndex={overflows ? 0 : undefined}>
        <code>
          {numbered
            ? text.split("\n").map((line, index) => (
                <span className="code-line numbered" key={`${String(index)}-${line}`}>
                  {line}
                  {"\n"}
                </span>
              ))
            : text}
        </code>
      </pre>
    </div>
  );
};
