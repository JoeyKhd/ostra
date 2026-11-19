# Contributing to ostra

ostra is source-available ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)) and built in the open. Ideas, questions and bug reports are welcome in [issues](https://github.com/JoeyKhd/ostra/issues). Code is welcome in pull requests, under the contributor agreement below.

## Before you write code

- **Open an issue first for anything big.** ostra is still on its way to v1 ([status](README.md#status)), and the plan in [`context/`](context/README.md) decides what's built when. A small fix can go straight to a pull request.
- **Build and test** as [`docs/development.md`](docs/development.md) describes: `pnpm install`, then `pnpm typecheck`, `pnpm lint` and `pnpm test`.
- **The code's rules** are in [`AGENTS.md`](AGENTS.md), under "Code" and "Boundaries". They hold for people and for coding agents.

## The contributor agreement

Version 1.1, 2026-11-19. It differs from version 1.0, of the same day, only in no longer naming a paid hosted version among the licensor's terms: ostra is self-hosted only. The license you give is the same.

ostra's server and panel are under the Sustainable Use License, and the licensor can also offer ostra on other terms, such as commercial licenses. Code you contribute can be part of those only if you allow it. This agreement is that permission, and nothing more. It covers the whole repository, the Apache-2.0 packages included, so code can move between packages.

**The words.** "You" are the person contributing. "Your contribution" is anything you offer for this repository, such as code, tests, docs and designs, in a pull request, a push or a patch, whether you send it yourself or a tool or an agent sends it for you. "The licensor" is the licensor that the [`LICENSE`](LICENSE) file at the root of this repository names on the day you contribute, and its successors and assigns: whoever the licensor later hands its rights in ostra to, such as a company formed to run it.

1. **You keep your copyright.** Nothing here transfers ownership. Your contribution stays yours, and you can use it anywhere else.
2. **The licensor may use your contribution on any terms.** You give the licensor a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, copy, change, distribute and sell your contribution, and to license it to anyone on any terms the licensor chooses. Those terms include ostra's own licenses and commercial licenses.
3. **The same goes for patents.** If you hold, or can license, a patent claim that your contribution infringes, alone or combined with ostra, you give the licensor, and everyone who gets ostra from the licensor, a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to it: to make, use, sell, offer for sale, import and distribute your contribution and ostra with it.
4. **It's yours to give.** You wrote your contribution yourself, or you have the right to contribute it on these terms. If your employer or a client has rights in what you write, you have their permission. If part of it is someone else's work, your pull request says which part, where it comes from and under which license.
5. **As is.** As far as the law allows, your contribution comes as is, without any warranty or condition, and you will not be liable to anyone for any damages related to it or to this agreement, under any kind of legal claim.
6. **One yes covers everything.** Your agreement covers every contribution you make to ostra, the earlier ones and the later ones.

If this text changes, the new version covers only what you contribute after you agree to it.

### How you agree

- **In a pull request:** tick the box the pull request form shows, "I agree to the ostra contributor agreement". A small check (`.github/workflows/contributor-agreement.yml`) fails the pull request until it's ticked. Your ticked pull request is the record.
- **With write access:** agree once first, in a pull request of your own with the box ticked. That covers what you push afterwards, and the pull requests a bot opens for you, such as ostra's own when ostra works on ostra.
- **Only a person agrees, and only for themselves.** A tool or an agent can send your contribution, and it can't say yes for you. The check refuses a pull request that a bot opened, whatever its text says, unless the bot is on the check's short list.
- **Nothing to agree to:** opening issues, commenting and reviewing; the licensor's own work; Dependabot's version bumps.

Why ostra asks for this, and what else was weighed, is in [ADR 0048](context/decisions/0048-license-sustainable-use-and-apache.md).
