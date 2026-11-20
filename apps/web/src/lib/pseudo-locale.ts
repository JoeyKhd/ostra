// F-083 (ticket 20): the pseudo-locale. A build-time switch for development and tests only
// (`OSTRA_PSEUDO_LOCALE=1`, which next.config.ts bakes into the build): every message comes back
// wrapped as `⟦…⟧`, its letters accented, so a word on screen outside the brackets bypassed `t`.
// It imports nothing, so the e2e pass (`e2e/pseudo-locale.spec.ts`) words a key the same way.

/** Whether this build is the pseudo-locale one. */
export const pseudoLocale = process.env["OSTRA_PSEUDO_LOCALE"] === "1";

const ACCENTS: Readonly<Record<string, string>> = {
  a: "à", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ô", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Å", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ",
  N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** A message in the pseudo-locale: accented and bracketed, its `{placeholders}` and `%s` kept as written. */
export const pseudoText = (text: string): string =>
  `⟦${text
    .split(/(\{\w+\}|%s)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[a-z]/gi, (letter) => ACCENTS[letter] ?? letter)))
    .join("")}⟧`;
