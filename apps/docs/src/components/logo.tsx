import { basePath } from "@/lib/site";

/**
 * The Hinge mark and the outlined wordmark, from the brand's files (never typed or redrawn): Shell
 * on dark, Abyss on light. Both colours are in the page; the theme shows one.
 */
export const Logo = () => (
  <span className="logo">
    <img className="logo-dark" src={`${basePath}/brand/ostra-mark-shell.svg`} alt="" width={22} height={22} />
    <img className="logo-light" src={`${basePath}/brand/ostra-mark-abyss.svg`} alt="" width={22} height={22} />
    <img className="logo-dark logo-word" src={`${basePath}/brand/wordmark-shell.svg`} alt="ostra" width={64} height={18} />
    <img className="logo-light logo-word" src={`${basePath}/brand/wordmark-abyss.svg`} alt="ostra" width={64} height={18} />
  </span>
);
