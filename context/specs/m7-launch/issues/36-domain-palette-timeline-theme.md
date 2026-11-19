# 36: Domain: the palette's actions, setup's timeline and the theme

Status: ready-for-agent
Builder: core
Blocked by: 04
Features: F-081, F-076, F-082
Packages: `packages/domain`
Spec: `../spec.md`, sections 4, 5.4 and 12 (items 11 and 13)
Note: split out of ticket 05 by the spec's review, so tickets 13, 18 and 24 don't wait on the agent work.

## What to build

- **`PaletteAction`**, the registry's type, and the list of spec section 12, item 11, with each action's message key, shortcut, scope, role and the procedure it calls, so the API enforces what the panel offers.
- **`setupTimeline(organizationId)`**, pure over the audit entries of the setup steps and the first PR's event.
- **`setTheme`**, over `ThemePreference`.

## Done when

- [ ] Tests named for `F-081`: every action of the list has a scope, a role and a message key, and no two share a shortcut in one scope (break-it: a duplicate shortcut fails).
- [ ] Tests named for `F-076`: the timeline orders the steps and measures each from a given start, and a missing step is reported missing, not zero.
- [ ] Tests named for `F-082`: a theme other than the three is refused.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the palette, timeline and theme domain`.

## Comments
