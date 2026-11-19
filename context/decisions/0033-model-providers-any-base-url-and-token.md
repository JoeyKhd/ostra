# Model providers: any base URL and token, with the catalog from models.dev

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q34 (with the maintainer's answer in chat that models are listed from the endpoint) and the provider half of Q47 and Q105. Covers F-088 and, for what it leaves later, F-128 and F-130.

ostra never assumes a model provider. A **model provider** is an API base URL and a token that an organization adds. Nothing in the form fits only one vendor. Any product named in the panel or the docs is an interchangeable example.

**The form asks for:**
- a base URL and a token (a bearer token or a key header)
- the API format: OpenAI-compatible, or Anthropic's Messages API

**Test connection** calls the endpoint's model list and detects which API format it speaks. The admin can correct the detected format. It's the same call that lists models.

**Models come from the endpoint itself:**
- ostra calls `GET /v1/models`, which OpenAI-compatible APIs and Anthropic's API both serve. A gateway's own list works too, such as OpenRouter's, which carries prices.
- ostra matches each ID against the models.dev catalog for its name, logo, limits and prices.
- An ID with no match, such as a self-hosted or fine-tuned model, is a **custom model** with fields the admin can edit: name, limits and price.
- An endpoint with no model list lets the member type model IDs.
- The list refreshes daily, as a scheduled job (ADR 0037).

**The catalog:**
- The server fetches the models.dev catalog daily and serves the logos itself, so browsers never call a third party.
- Each release bundles a copy of the catalog, and one setting turns the fetch off. A closed network keeps working (ADR 0001, ADR 0021).
- The agent never fetches the catalog. ostra writes the provider config for each task, and a models.dev ID passes through to the agent as it is. For OpenCode the catalog goes in as a file the agent reads (`OPENCODE_MODELS_PATH`, with `OPENCODE_DISABLE_MODELS_FETCH=1`), which spike 1 used with no outbound call. Those switches aren't in OpenCode's docs, so the adapter's contract suite covers them (ADR 0032).

**Keys:**
- The token is stored encrypted, through the secret store adapter (ADR 0025). It reaches only the box's sidecar. The agent holds a fake key, and the key proxy swaps the real one in and counts every call in both API formats (ADR 0030, F-089).
- An organization's provider is usable on personal runners only when an admin switches that on for the provider. It's off by default, because a key sent to a member's laptop can be read by that member (Q47).
- A call is priced from models.dev, from the endpoint's own list where it carries prices, or from a price the admin enters for a custom model. A price has four parts: fresh input, output, cache read and cache write (ADR 0042). An endpoint that reports no usage in its stream gets an estimate from token counts, and the panel says so (Q105, ADR 0042).

**v1 covers endpoints that take a static token or key header.** Clouds that sign each request, and short-lived provider credentials, come later as auth strategies of the `ModelProviderAdapter` (F-130).

## Considered options

- **A fixed list of supported vendors.** Rejected: "any base URL works" is the rule, so the form can't ask for anything that fits one provider only. A list would also favour its entries.
- **models.dev alone, without asking the endpoint.** Rejected: only the endpoint knows what a given account can use, and a public catalog can't know a self-hosted or fine-tuned model.
- **A hand-typed model list.** Kept only as the fallback for endpoints with no list: it has no prices and goes stale.
- **Browsers fetch the catalog.** Rejected: every browser would call a third party. The server fetch keeps that out of the panel.
- **A fetch with no bundled copy.** Rejected: a closed network or a first install without egress would have no catalog.
- **Signed-request clouds in v1.** Later (F-130). Revisit if an organization's models sit behind a cloud that only accepts signed requests.
- **Subscription logins.** Rejected everywhere: no login is used, stored or passed on (Q47). The terms forbid a platform from routing them (`research/agent-harnesses.md` §1.4).

## Consequences

- The fetch of the catalog is the one call an install makes to a service that nobody on the install configured. It's a plain GET of a public file with no install data in it, and ADR 0021 names it with its setting and the bundled copy. The setting ships with a working default and a line in the configuration reference.
- The catalog and the model lists are vendor-owned formats, so their Zod schemas tolerate unknown fields (`AGENTS.md`).
- `ModelProviderAdapter`'s v1 adapter is "the models.dev catalog plus any base URL and token" (ADR 0025). Its contract suite runs against fakes in both API formats.
- Claude Code (F-018, after v1 since 2026-11-19) needs a provider whose format is Anthropic's Messages API (ADR 0032). OpenCode takes either.
- Spike 1 proves the pieces together: a turn against the endpoint in `model.env`, and against a local stub in each format, with the proxy's token count within 2% of the endpoint's. The spikes read one neutral file, `model.env` (base URL, token and model ID), and no spike, test or default assumes a provider (Q106).
- A member's own provider for their personal runner is later (F-128).
