# Model providers: any base URL and token, with the catalog from models.dev

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q34 (with the maintainer's answer in chat that models are listed from the endpoint) and the provider half of Q47 and Q105. Covers F-088 and, for what it leaves later, F-128 and F-130. **Amended 2026-11-19 by ADR 0065** (Q270 to Q278): a provider is one key, each project uses only the providers on its list, and a profile names its model by name ("Several keys for the same models" below). **Amended 2026-11-19 by ADR 0066** (Q286, Q290, Q291): the catalog keeps each model's reasoning controls, an organization admin sets a custom model's or overrides a catalog model's on one provider, and a model's real context window and output limit reach the agent. **Amended 2026-11-21 by ADR 0070** (Q335): the catalog keeps each model's models.dev `modalities.input`, and an organization admin can say a model reads images, which wins; unknown counts as no.

ostra never assumes a model provider. A **model provider** is an API base URL and a token that an organization adds. Nothing in the form fits only one vendor. Any product named in the panel or the docs is an interchangeable example.

**The form asks for:**
- a base URL and a token (a bearer token or a key header)
- the API format: OpenAI-compatible, or Anthropic's Messages API

**Test connection** calls the endpoint's model list and detects which API format it speaks. The admin can correct the detected format. It's the same call that lists models.

**Models come from the endpoint itself:**
- ostra calls `GET /v1/models`, which OpenAI-compatible APIs and Anthropic's API both serve. A gateway's own list works too, such as OpenRouter's, which carries prices.
- ostra matches each ID against the models.dev catalog for its name, logo, limits and prices. *Amended 2026-11-22* ("Matching a model to the catalog" below): the serving provider's own entry first.
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

## Several keys for the same models

Added 2026-11-19 by ADR 0065, for F-135.

- **A provider is one key.** An organization may hold several providers that serve the same models, one per client, each with its own base URL, token, prices, cap and personal-runner switch.
- **A project uses only the providers on its list,** the organization's default or its own, which only an organization admin edits. In each project each model is served by exactly one of them, and nothing moves it to another but an admin's save. The credentials endpoint issues a provider's token only for a task whose project allows it.
- **A profile names its model by name:** the models.dev catalog ID this ADR already matches each listed model against, or a custom model's endpoint ID. The model rows stay per provider, with that provider's own prices, so two clients' contracts can price one model differently.

## Matching a model to the catalog

Added 2026-11-22, after the live instance's OpenRouter model `deepseek/deepseek-v4.1-flash-1017` was matched to `ambient/deepseek/deepseek-v4.1-flash-1017`. That entry says text only, where OpenRouter's own and nearly all of the others say it reads images. The first entry in the catalog's order took the ID (first-party providers, then by provider ID), so an aggregator's model got whichever aggregator sorted first: its inputs, prices, limits and reasoning levels.

- **The serving provider is known by its base URL:** the models.dev provider whose `api` is the base URL, or holds it on the same host. Then a short table of well-known hosts, for providers whose entry has no `api` (Anthropic's, OpenAI's, Google's and others), and OpenRouter's, since the bundled copy kept no `api` before this date. The refresh script now keeps it.
- **A model matches, in order:**
  1. its serving provider's own entry, when that provider lists the model;
  2. else the lab's own: the provider the ID's vendor prefix names (`deepseek/…`, with `x-ai` read as `xai` and the like), or, for a bare ID, a first-party provider's;
  3. else the entry most of the catalog's entries for the model agree with on its inputs, by its ID with every variant stripped. Entries that say nothing don't vote, and a tie goes to the catalog's order. Never merely the first.
- **An ID none of its variants names stays custom,** as before.
- **The catalog ID is still the model's name** (ADR 0065). Two providers share a name when they are the same models.dev provider, such as two clients' OpenRouter keys. An OpenRouter model and the lab's own API's are two names, each with its own prices.
- **A model's inputs**, in order: its serving provider's entry, then what the endpoint's own list says (OpenRouter's `architecture.input_modalities`), then the matched entry, then what most entries agree on. A custom model takes the list's. An admin's "Reads images" still wins over all of them (ADR 0070).
- **Prices, limits and reasoning levels** come from the matched entry, so an OpenRouter model is priced at OpenRouter's models.dev prices, and spend is priced from the serving provider's prices (F-135). The model row says the prices came from models.dev (`priceSource: catalog`). An admin's prices still win. The endpoint's own listed prices are not read yet.
- **Existing installs heal at the next refresh.** It rewrites a row's catalog ID, inputs, reasoning, limits and catalog prices. What names the model by its old catalog ID follows it: a profile on that provider, once the provider lists nothing under the old name. Once no row of the organization keeps the old name, a profile with no provider and each list's choice for it follow too. A name another provider still serves stays, so nothing moves to another provider.
- **An aggregator's `vendor/model` shows its lab's logo,** when the catalog has that lab.
