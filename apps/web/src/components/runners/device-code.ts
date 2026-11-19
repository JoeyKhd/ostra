// A device code as `ostra runner` prints it (RFC 8628, `userCodeLength: 8`): letters and digits,
// shown as two groups of four.

/** Letters and digits only, upper case: any dashes or spaces the member typed are dropped. */
export const normalizeUserCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** `WDJBMJHT` → `WDJB-MJHT`, so it reads like the terminal's. A code of another length stays whole. */
export const formatUserCode = (code: string): string => {
  const normal = normalizeUserCode(code);
  return normal.length === 8 ? `${normal.slice(0, 4)}-${normal.slice(4)}` : normal;
};
