# 05: The docs: what a rule is, and what it binds on each executor

Status: ready-for-agent
Builder: docs
Blocked by: 01, 04
Features: F-052 (the words of c1, c4, c5)
Packages: `apps/docs` (`content/runners/egress.mdx`, `content/runners/executors.mdx`, `content/install/setup.mdx`)
Spec: `../spec.md`, section 5.7; ADR 0073

## What to build

- **`runners/egress.mdx`:** replace the closing paragraph ("Allowlists for each environment ... come after v1") with a **Network rules** section:
  - what a rule is (host, `*.suffix`, CIDR, ports), with one table example;
  - **what it binds on each executor**, in the panel's words: enforced on `docker`, a filter on `kubernetes` (the agent keeps direct public egress, ADR 0029's fourth difference, with the reason: every container in a pod shares one network namespace and a NetworkPolicy selects pods), advisory on `host` (not isolated);
  - the consequences: the setup script and the box's start-time install run through the proxy, so their package hosts belong in the rules; a service isn't proxied; a rule inside the baseline's ranges is refused, and a private endpoint is the runner admin's `OSTRA_EGRESS_ALLOW` (one sentence, linking the configuration reference's existing line);
  - that the rules take effect at the next task, and that a running task keeps the rules it started with;
  - webhook forwarders now work on `docker` once their host is a rule (Q302's `docker` half).
- **`install/setup.mdx`:** one paragraph in step 5, "Limit what the environment may reach", with the rule shape and a pointer to the Network tab and to `runners/egress.mdx`. It says in one line what a rule does not do on `kubernetes` and `host`.
- **`runners/executors.mdx`:** the `host` "not isolated" paragraph gains "and no network rule is enforced there (ADR 0029, ADR 0073)"; the `kubernetes` section's direct-egress note gains "so a network rule filters what uses the proxy, not what doesn't".
- **Nothing else:** no new setting, no configuration-reference row (the proxy's port is an internal free port; `OSTRA_EGRESS_ALLOW` is already there), and no claim stronger than the panel's three sentences.
- **The docs' own check:** `docs-commands` (proof.yml) runs the docs' commands; this change adds none, so nothing there changes. `apps/docs`' frontmatter and the sidebar's order stay as they are.

## Done when

- [ ] The three pages read as above, with the same words for the three executors as the panel (`environment-network-words.ts`) — the sentences are copied, not re-written; a reviewer can diff them.
- [ ] Every claim about enforcement matches ADR 0073's table; nothing says "the agent can't reach" where it means "the proxy refuses".
- [ ] `runners/egress.mdx` no longer says allowlists "come after v1", and no other page says they are unbuilt.
- [ ] A docs build/typecheck of `apps/docs` passes (the package's own command), and no link is broken (the existing link check, if the package has one).
- [ ] Committed as `📝 document network rules`.

## Comments
