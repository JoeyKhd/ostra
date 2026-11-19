// Memory's secret scan (F-109, ADR 0044 amended, Q201 and Q91): every note and every proposal is
// scanned before anything is stored. A hit refuses the save, naming the kind it found and never
// echoing the value. Three things are looked for:
// - the organization's own stored secret values, matched exactly, as the snapshot scan does;
// - a fixed list of credential shapes;
// - a short fixed list of model-control tokens (chat-template and role markers).
// No dependency; the patterns below are the whole list.

/** A secret value this short is too likely to appear by chance to refuse a note over. */
export const SECRET_VALUE_MIN_CHARS = 8;

type Shape = { readonly kind: string; readonly pattern: RegExp };

/** The credential shapes (ADR 0044, Q201). */
export const credentialShapes: readonly Shape[] = [
  { kind: "a GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/ },
  { kind: "a GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "a Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "an Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "an OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "an Authorization header", pattern: /\bAuthorization\s*:\s*(?!\s*$)\S+/im },
  { kind: "a bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/ },
  { kind: "a URL with a password", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
];

/** The model-control tokens (ADR 0044, Q91): found as "a model-control token". */
export const modelControlTokens: readonly string[] = [
  "<|im_start|>",
  "<|im_end|>",
  "<|im_sep|>",
  "<|endoftext|>",
  "<|start_header_id|>",
  "<|end_header_id|>",
  "<|eot_id|>",
  "<|begin_of_text|>",
  "<|system|>",
  "<|user|>",
  "<|assistant|>",
  "</system>",
  "[INST]",
  "[/INST]",
  "<<SYS>>",
  "<</SYS>>",
];

export const MODEL_CONTROL_TOKEN_KIND = "a model-control token";
export const ORGANIZATION_SECRET_KIND = "one of the organization's secrets";

export type SecretScan = { readonly ok: true } | { readonly ok: false; readonly found: readonly string[] };

/**
 * Scans a note's or a proposal's text. `secretValues` are the organization's stored secret values
 * (the environments', the providers' tokens, the MCP servers' headers); only their presence is
 * reported, never which one or where.
 */
export const scanMemoryText = (texts: readonly string[], secretValues: readonly string[]): SecretScan => {
  const found = new Set<string>();
  for (const text of texts) {
    for (const value of secretValues) {
      if (value.length >= SECRET_VALUE_MIN_CHARS && text.includes(value)) {
        found.add(ORGANIZATION_SECRET_KIND);
      }
    }
    for (const shape of credentialShapes) {
      if (shape.pattern.test(text)) {
        found.add(shape.kind);
      }
    }
    const lower = text.toLowerCase();
    if (modelControlTokens.some((token) => lower.includes(token.toLowerCase()))) {
      found.add(MODEL_CONTROL_TOKEN_KIND);
    }
  }
  return found.size === 0 ? { ok: true } : { ok: false, found: [...found] };
};

/** The words a refusal says, naming each kind found and never a value. */
export const secretScanMessage = (found: readonly string[]): string =>
  `This note holds ${found.join(", ")}, so it wasn't saved. Remove it and save again.`;
