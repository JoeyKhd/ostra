import type { ReactNode } from "react";

export const metadata = { title: "Next app" };

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>{children}</body>
  </html>
);
export default RootLayout;
