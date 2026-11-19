import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";

import { CopyButton } from "@/components/code-block";
import { SectionIcon } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { navigation } from "@/lib/navigation";
import { basePath, versionLabel } from "@/lib/site";
import { source } from "@/lib/source";

/** A guide page's own first sentence (its `summary`), so the landing can't contradict it. */
const summaryOf = (slugs: readonly string[]): string => {
  const data: object | undefined = source.getPage([...slugs])?.data;
  const summary: unknown = data === undefined ? undefined : Object.entries(data).find(([key]) => key === "summary")?.[1];
  return typeof summary === "string" ? summary : "";
};

const beforeYouStart = [
  { text: "A Linux machine with Docker", href: "/docs/start/before-you-start#a-linux-machine-with-docker" },
  { text: "A GitHub organization you administer", href: "/docs/start/before-you-start#a-github-organization-you-administer" },
  { text: "A model provider's base URL and token", href: "/docs/start/before-you-start#a-model-providers-base-url-and-token" },
] as const;

const HomePage = () => {
  const sections = navigation();
  const path = [
    { title: "Start ostra", text: summaryOf(["install", "docker-compose"]), link: "Install with Docker Compose", href: "/docs/install/docker-compose", code: "docker compose up -d" },
    { title: "Set it up in the panel", text: summaryOf(["install", "setup"]), link: "Setup in the panel", href: "/docs/install/setup", code: null },
    { title: "Start a task", text: summaryOf(["using-ostra", "tasks"]), link: "Your first task", href: "/docs/using-ostra/tasks", code: null },
  ];
  return (
    <>
      <SiteHeader />
      <main id="content" className="home">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Documentation · {versionLabel}</p>
            <h1>
              Self-hosted cloud agents
              <br />
              for your team.
            </h1>
            <p className="hero-lede">
              ostra is the source-available, self-hosted control plane for coding agents. A Linear ticket or a prompt becomes a task, an agent works
              it on its own branch on your runners, and it opens a pull request on GitHub.
            </p>
            <div className="hero-actions">
              <Link href="/docs/install/docker-compose" className="button is-primary">
                Install ostra
                <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
              </Link>
              <Link href="/docs/reference/configuration" className="button is-outline">
                Configuration reference
              </Link>
            </div>
            <p className="hero-proof">Your agents, your machines, your tracker, your keys.</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <img src={`${basePath}/deep-water.webp`} alt="" />
          </div>
        </section>

        <section className="before-start" aria-labelledby="before-you-start">
          <h2 id="before-you-start">Before you start</h2>
          <ul>
            {beforeYouStart.map((item) => (
              <li key={item.text}>
                <CircleCheck size={15} strokeWidth={1.75} aria-hidden="true" />
                <Link href={item.href}>{item.text}</Link>
              </li>
            ))}
          </ul>
          <Link href="/docs/install/linear" className="linear-optional">
            Linear is optional
          </Link>
        </section>

        <section className="path" aria-labelledby="the-30-minute-path">
          <div className="path-head">
            <h2 id="the-30-minute-path">The 30-minute path</h2>
            <p>From docker compose up to your first agent-made pull request.</p>
          </div>
          <ol>
            {path.map((step, index) => (
              <li key={step.title}>
                <span className="path-number">{`0${String(index + 1)}`}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
                {step.code === null ? null : (
                  <div className="code-line">
                    <code>{step.code}</code>
                    <CopyButton text={step.code} className="copy-button is-small" />
                  </div>
                )}
                <Link href={step.href} className="teal-link">
                  {step.link}
                  <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <section className="sections" aria-labelledby="sections">
          <h2 id="sections">Sections</h2>
          <ul>
            {sections.map((section) => (
              <li key={section.title}>
                <Link href={section.pages[0]?.url ?? "/docs/start/what-ostra-is"} className="section-cell">
                  <SectionIcon name={section.icon} />
                  <span>
                    <span className="section-title">{section.title}</span>
                    <span className="section-text">{section.description}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <SiteFooter />
    </>
  );
};

export default HomePage;
