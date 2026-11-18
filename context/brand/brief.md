# Brand brief

What we decided about the ostra brand, and why. The identity itself (palette, logo, type) is built with the `higgsfield-brandkit` skill, and approved files land in `context/brand/kit/`. Every brand file we need is tracked in `assets.md`. Screens are designed afterwards, image first, through the `ui-taste` skill, against this identity.

**Status:** palette, logo and typography chosen (2026-11-17). The whole identity on one board: `kit/reviews/identity.png`. Derived files: `assets.md`.

## Name

**ostra**: one word, always lowercase.
- Spanish and Portuguese for oyster: a hard shell around something valuable. Your agents' work, protected inside your own walls: your machines, your tracker, your keys.
- Polish and Czech for sharp: precise, exact work.

## Audience

- **Engineers and engineering leads** at software teams that use a tracker (Linear, later Jira), GitHub and CLI coding agents. They choose ostra, deploy it and live in its panel.
- **Everyone else in the tracker** (product, design, support). They meet ostra as an agent on their tickets in Linear, and through its PRs on GitHub.
- **Open-source contributors and self-hosters.** They meet ostra on GitHub, in its docs and in its Docker images.

## Positioning

From `context/project.md`:
- **Tagline:** Self-hosted cloud agents for your team. It's the category word people already know.
- **Headline:** the open-source, self-hosted control plane for coding agents, where your tracker stays the source of truth. It explains the tagline.
- **Words:** "cloud agents" is for describing ostra from outside (the site, the README, launch posts). Inside the product, the words are task, session and runner (`GLOSSARY.md`).
- **Proof points:** your agents, your machines, your tracker, and tasks you can reopen months later.
- **Character the brand must carry:** robust above all (ADR 0011), and open (ADR 0001, ADR 0009).

## Voice

Plain, precise and calm, like engineers talking to engineers:
- short sentences and exact words
- no hype, no "AI-powered magic", no exclamation marks
- the same voice in the panel, the docs, the CLI and on tickets

## Visual direction

- **Mood:** calm, precise, built to last.
- **Visual axes:** mostly restrained (25), mostly geometric (25), halfway between familiar and experimental (50).
- **Dark mode first.** The maintainer: "we want more of a darkmode btw". Abyss is the default background for the docs, the README and social images. Light mode still exists and still works.
- **The panel is the exception:** its chrome is neutral graphite, and the brand colours are only accents there (`app-design.md`, chosen 2026-11-18 after Abyss made the app look muddy).

## Colour direction

- A near-black and a warm off-white.
- One sharp signal colour that means "this needs you" (an approval, a question from the agent). It marks one thing at a time.

## Palette: Deep Water and Buoy (chosen)

Chosen on 2026-11-17. The maintainer delegated the choice ("work on the palette and brand", then "and logo") after seeing three options. It's the "Deep Water" option, with its coral signal swapped for amber. The palette lives in the brandkit state (`kit/state.json`, revision 1), and the board is `kit/reviews/palette-deep-water-and-buoy.png`.

| Name | Hex | Role |
|---|---|---|
| Abyss | `#0C1D21` | text on light and on amber; the background of dark brand surfaces (not the panel) |
| Shell | `#F3F0E8` | the background in light mode; text on dark |
| Kelp | `#2F4A47` | secondary text on light (8.4:1 on Shell); raised surfaces in dark mode |
| Mist | `#CFD8D4` | lines and quiet surfaces |
| Buoy Amber | `#FFB224` | the signal: "this needs you" |

- **Why amber:**
  - Amber already means "waiting on you" in developer tools, such as pending checks.
  - A red or coral signal would read as "failed" beside the panel's error states.
- **Rules for amber:**
  - One thing at a time.
  - Use it as a fill or on dark backgrounds, with Abyss text on it (9.6:1).
  - Never use it as text on Shell, where it's unreadable.
- **Why Abyss instead of black:** the blue-green dark gives ostra a dark mode that's recognisably its own, and keeps it apart from neutral-black tools.
- **Not part of the brand palette:** status colours for success and error are defined with the panel's design, and must stay clearly apart from Buoy Amber.

## Logo: Hinge (chosen)

Chosen by the maintainer on 2026-11-17 ("3"), from three Recraft marks.

**The mark:** a solid rounded shell split by one diagonal channel, with a small notch at the top-left where the halves meet. It's robust and machined, and reads as a shell that opens.

**Files:**
- **Master source:** `kit/logo/hinge.svg`, the exact Recraft SVG (job `3af65604…`). Never redraw or retouch it.
- **Exports** in `kit/logo/export/`, all with the same geometry fingerprint:
  - `ostra-hinge.svg` and `-2048.png`: Abyss, for light backgrounds
  - `ostra-hinge-single-color.svg` and `-2048.png`: Shell, the dark-mode default
- Everything else gets built from these files.

**Colour on dark:** Shell on Abyss. Amber is never part of the mark; it stays reserved for "needs you".

## Typography: Rounded Geometry (chosen)

Chosen by the maintainer on 2026-11-17 ("ROUNDED GEOMETRY"), from three pairs.

- **Display:** Manrope ExtraBold 800, for headings and the wordmark. Its round, even letter shapes match the hinge's generous corners.
- **Body:** IBM Plex Sans Regular 400, for the interface and running text. It has a calm, technical warmth.
- **Mono:** IBM Plex Mono, for code, logs, ticket IDs and branch names.
- **Licenses:** all three are under the SIL Open Font License, free for the web app, docs and images. The font files and licenses are in `fonts/`.
- **The wordmark** is always lowercase "ostra" in Manrope 800, outlined (`files/logo/`). Never type it live.

## Avoid

- AI clichés: robots, sparkles, brains and neural networks, chat bubbles, purple-to-blue gradients.
- Octopuses and krakens: the "many arms" image every orchestration tool uses.
- Literal oysters or seafood.
- The `>_` terminal prompt.
- Network-node "hub" icons.

## References

None. We work from this brief.
