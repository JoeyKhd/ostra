# License: the Sustainable Use License for the server, Apache-2.0 for the runner and SDK

**Status:** accepted (2026-11-18, the maintainer's choice). Supersedes ADR 0009. The maintainer: "i want it to be opensource but you cant sell or distribute this software in any way". **Amended 2026-11-19:** the contributor agreement and how a contributor agrees to it (Q109), and the licensor (Q110), are settled in the two sections below, and the launch no longer waits for a lawyer. The maintainer: "this shouldn't be that complex. I don't need legal advice to do any of this stuff".

The code is public. Nobody but the maintainer may sell the server and the panel, or distribute them except free of charge for non-commercial purposes. No OSI-approved license can say that, so ostra is **source-available**, not open source. The runner, protocol, adapter SDK, adapters and tooling stay Apache-2.0 on purpose.

- **The server and the web panel** move from AGPL-3.0 to n8n's **Sustainable Use License, version 1.0**. That covers `apps/web`, `apps/core` and every package that isn't Apache-2.0: `db`, `domain`, `api`, `jobs` and `task-view`.
  - A company may use it for its own internal business purposes. Anyone may use it for non-commercial or personal use.
  - Nobody may sell it. Nobody may offer it to others as a paid service.
  - Sharing is allowed only free of charge and for non-commercial purposes.
- **The runner, the protocol, the adapter SDK, the adapters and the tooling stay Apache-2.0:** `apps/runner`, `packages/protocol`, `packages/adapter-sdk`, `packages/adapters/*` and `packages/tooling`. Companies can run runners and write adapters without a legal review. That half of ADR 0009 stands.
- **The word for ostra is "source-available".** The code is public, and anyone can self-host it for their own team. "Open source" is an OSI term that ostra no longer meets, so it describes ostra nowhere in the present tense.
- **Contributions come under ostra's contributor agreement,** a short license grant (a CLA) whose text is in `CONTRIBUTING.md`. The DCO-only rule of ADR 0009 is replaced. With the agreement, the maintainer can still offer the hosted version and commercial licenses with contributed code in them. A contributor agrees by ticking a box in their pull request ("The contributor agreement", below).
- **The paid hosted version stays the maintainer's alone.** The license of the server and the panel is what protects it (ADR 0001).
- **The licensor and copyright holder:** "JoeyKhd (https://github.com/JoeyKhd), the maintainer of ostra", which means the person who holds that GitHub account. The line stays as it is, and changes only if a company takes ostra over ("The licensor", below).
- **The earlier AGPL copies stay AGPL.** The plan and the repo skeleton were pushed under AGPL-3.0 earlier on 2026-11-18. Anyone who already has those copies keeps them under AGPL-3.0. Every version from this change on is under the new terms.

## The contributor agreement (Q109, settled 2026-11-19)

**Who a contributor is.** Anyone but the licensor whose work is merged into this repo: someone on the maintainer's own team, a contractor, a stranger with a pull request. Opening an issue, commenting and reviewing aren't contributions.

**Why ostra needs an agreement at all.** Without one, a contribution arrives under the license of the file it changes. GitHub's terms say so: content added to a repo that has a license is licensed "under the same terms", unless there is "a separate agreement to license that Content under different terms, such as a contributor license agreement" (GitHub Terms of Service, D.6, https://docs.github.com/en/site-policy/github-terms/github-terms-of-service). For the server and the panel those terms are the Sustainable Use License: internal or non-commercial use only, sharing only free of charge, and "non-sublicensable" (`LICENSE`). The maintainer would hold the contributed lines on those terms like everyone else. So ostra would contain lines that the maintainer may not put in a paid hosted version or a commercial license, and one merged pull request is enough for that.

**What it says.** The text is in `CONTRIBUTING.md`, version 1.0, in six short points:

1. The contributor keeps their copyright. It is a license, not a transfer.
2. The licensor may use the contribution, and license it to anyone, on any terms. That is all the hosted version and commercial licenses need.
3. The same for any patent of the contributor's that the contribution touches.
4. The contributor has the right to give this: it's their own work, or they have their employer's or client's permission.
5. The contribution comes as is, without a warranty.
6. One yes covers every contribution the person makes, in the whole repo, the Apache-2.0 packages included, so code can move between packages.

The grant is to the licensor "and its successors and assigns", so it moves with ostra if a company takes it over, and nobody agrees twice.

**How a contributor agrees.**

- **A checkbox in the pull request,** from `.github/pull_request_template.md`: "I agree to the ostra contributor agreement, for this and all my contributions to ostra". The ticked pull request is the record: GitHub keeps it with the author's account and the date.
- **A check fails a pull request without the ticked box:** `.github/workflows/contributor-agreement.yml`. It is ostra's own, about thirty lines of shell, with no action, no checkout, no permission, no secret and no outside service. It's a workflow of its own, so `ci.yml` keeps to the everyday checks (the CI scope in `AGENTS.md`).
- **It passes without a box** for the repository's owner, who is the licensor, and for Dependabot, which only bumps versions.
- **Only a person agrees.** The check refuses a pull request that any other bot opened, whatever its text says, because a bot can't agree for anyone.
- **Someone with write access agrees once first,** in a pull request of their own. That covers what they push afterwards and the pull requests a bot opens for them. When ostra's own tickets run through ostra (Q101), its App's bot is added to the workflow's list, which is one line, once everyone who can start tasks there has agreed.

**What the maintainer does:** nothing now. Before giving someone else write access, the maintainer asks them for one pull request with the box ticked.

## The licensor (Q110, settled 2026-11-19)

- **The licensor is the person who holds the GitHub account `JoeyKhd`,** and the line in `LICENSE` and `NOTICE` stays as it is. A handle is a pseudonym, and a work belongs to the person who wrote it whatever name its notice shows: copyright "vests initially in the author" (17 U.S.C. § 201(a), https://www.law.cornell.edu/uscode/text/17/201). Copyright law has a term for exactly this case, a "pseudonymous work", in which "the author is identified under a fictitious name" (17 U.S.C. § 101, https://www.law.cornell.edu/uscode/text/17/101), and the Berne Convention treats a pseudonym that leaves no doubt about who is meant like a name (Article 15(1), https://www.law.cornell.edu/treaties/berne/15.html). A handle with its profile's address names one account, and one person holds it.
- **No personal detail enters the repo.** No legal name, address or email is added, and nothing in the repo needs one.
- **A legal name appears only outside the repo,** in a document that needs a signature or a registration: a commercial license, the hosted version's terms and invoices, a trademark or a company registration. Each names its own party when it's made, and none of them is needed to build or release v1.
- **If a company is formed later,** the maintainer picks one of two ways at that time:
  - **The company becomes the licensor.** The maintainer signs one short transfer of their rights in ostra to the company, outside the repo, and one commit changes the licensor line in `LICENSE` and `NOTICE` and this ADR. Contributors agree to nothing new, because their grant was to the licensor "and its successors and assigns".
  - **The person stays the licensor** and lets the company sell the hosted version. Nothing in the repo changes.
- **The name "ostra"** is the licensor's to use for the product, and the license leaves trademarks to "applicable law" (`LICENSE`). Registering the name is optional, takes a legal name on the registration and not in the repo, and v1 doesn't wait for it.

## Considered options

- **AGPL-3.0, as before (ADR 0009).** Rejected: it is real open source, and that is the problem. It lets anyone sell ostra, and sell hosting of it, as long as they publish their changes.
- **The Functional Source License (FSL-1.1).** Rejected: it allows use for anything except a competing product, so a company can distribute ostra freely if the copy doesn't compete. Each release also turns into Apache-2.0 after two years, which gives the code away on a timer.
- **The Elastic License 2.0 and PolyForm Shield.** Rejected: they forbid competing services, but they allow other kinds of distribution. That is the same gap as FSL.
- **PolyForm Noncommercial.** Rejected: it forbids even a company's own internal use, and that is ostra's main audience.
- **Apache-2.0 for everything.** Rejected in ADR 0009, and still rejected: anyone could sell hosting of the same code.

For the contributor agreement (2026-11-19):

- **A DCO sign-off alone.** Rejected again. The sign-off certifies where a contribution comes from and that its author may submit it "under the open source license indicated in the file" (https://developercertificate.org). It gives the licensor no right beyond that license, so contributed code would stay under the Sustainable Use License's limits for the maintainer too.
- **No outside code until it's needed.** Rejected: "outside" means anyone but the licensor, and the maintainer's team works on ostra through ostra from milestone 3 (Q101). The agreement costs three small files, and deciding it later would mean deciding it with a pull request waiting.
- **A CLA service or bot.** Rejected: an outside service, or the archived action most projects used (`history/answers-2026-11-19.md`, section 3), for what a checkbox and a few lines of shell do. `AGENTS.md` asks before a dependency or a vendor is added.
- **A copyright assignment.** Rejected: it takes the contributor's ownership, which the hosted version and commercial licenses don't need. A license on any terms is enough, and it is what n8n, whose license ostra uses, asks for: "I give n8n permission to license my contributions on any terms they like" (https://github.com/n8n-io/n8n/blob/master/CONTRIBUTOR_LICENSE_AGREEMENT.md).
- **A list of signers in the repo,** signed once per person. Rejected: every first pull request would also edit a shared file, and the check would have to read the pull request's files. The box is checked from the pull request's text alone.
- **An individual form and a company form.** Rejected for now: point 4 covers an employer's permission. A company that wants its own form is the day to add one.

For the licensor (2026-11-19):

- **A legal name on the line now,** which the earlier recommendation asked for. Rejected: it puts a personal detail in a public repo for good, and it changes nobody's rights. The same person holds the copyright under either name.
- **A company first.** Rejected as a condition: the agreement's grant moves with ostra, so forming one later costs one transfer and one commit, not a round of new signatures.

## Consequences

- **ostra is source-available, not open source.** The README, the docs, the site and the brand files say "source-available" and never "open source" for ostra. ADR 0009 rejected a source-available license over the friction that Multica shows with self-hosters and contributors (`research/landscape.md`). The maintainer accepts that cost.
- **The contributor agreement replaces the DCO.** Its text is in `CONTRIBUTING.md`, its box is in the pull request template and its check is `.github/workflows/contributor-agreement.yml`. The README says that pull requests are welcome under it.
- **Companies can self-host ostra for their own team for free.** Nobody else may sell the server or the panel, offer them as a paid service, or hand them on except free of charge for non-commercial purposes.
- **The license check in CI guards a different line.** The rule of ADR 0045 now says that an Apache-2.0 package must not depend on a Sustainable Use package, directly or through another. `protocol`, `adapter-sdk`, `adapters/*` and `runner` still never import `db`, `domain` or `api`. The Sustainable Use License has no SPDX entry, so a package under it declares the custom reference `LicenseRef-Sustainable-Use-1.0` in its `license` field. The check treats every license that is not on its permissive list as restricted.
- **The earlier AGPL copies remain AGPL.** They can't be recalled, and this decision doesn't try to.
- **Apache-2.0 code stays free to redistribute.** The runner and the adapters can be copied and shipped by anyone under Apache-2.0. That is on purpose, since the value of those packages is that others write adapters and run runners.
- **The license is the protection, so it has to hold.** Its text is n8n's, unchanged (`NOTICE`). A lawyer's review of the license, the licensor line or the agreement is the maintainer's choice at any time. It is a paid service the maintainer hasn't chosen, so the launch doesn't wait for one (amended 2026-11-19; ADR 0064's legal gate is now the agreement, its check and one licensor line).
- **Anything only the hosted version needs,** such as billing, still lives in separate services, not in the server packages.
