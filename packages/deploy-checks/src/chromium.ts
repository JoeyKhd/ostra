// Milestone 8 (ticket 11, ADR 0068, Q311): the box's browser in the base image, Debian bookworm's
// `chromium` package at this version, and the Debian snapshot archive's time that holds it once
// bookworm-security has moved on (it keeps only its newest Chromium). `pnpm check:images` holds the
// base image's Dockerfile and its Chromium notice (`deploy/notices/chromium.json`) to these.
//
// 156.0.8078.79-1~deb12u1 was bookworm-security's Chromium on 2026-11-21 (its Packages index), first
// seen there on 2026-11-03 (snapshot.debian.org's record of `chromium_156.0.8078.79-1~deb12u1_amd64.deb`),
// and the snapshot below serves it. Bumping it: the new version from bookworm-security's index, a
// snapshot time at or after it was published there, and the notice's version, in one change.

export const CHROMIUM_PIN = {
  /** The Debian package's version, for `chromium` and `chromium-common` alike. */
  version: "156.0.8078.79-1~deb12u1",
  /** A snapshot.debian.org time (`YYYYMMDDTHHMMSSZ`) at which debian-security's bookworm-security holds it. */
  snapshot: "20261120T000000Z",
} as const;

/** What the base image installs beside Chromium, so a page's text and emoji render. */
export const CHROMIUM_FONTS = ["fonts-liberation", "fonts-noto-color-emoji"] as const;
