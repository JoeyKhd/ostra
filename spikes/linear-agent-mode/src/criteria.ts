// The pass bar of milestone 0, spike 5 (context/build-order.md), one entry per bullet,
// worded as the bullet is. The harness prints one verdict per entry.

export const INPUT_NAMES = [
  "OSTRA_DEV_PUBLIC_URL",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "LINEAR_API_KEY",
  "LINEAR_TEST_TEAM_KEY",
] as const;
export type InputName = (typeof INPUT_NAMES)[number];

export type InputSpec = {
  readonly name: InputName;
  readonly file: string;
  readonly optional: boolean;
  readonly purpose: string;
};

export const INPUTS = [
  {
    name: "OSTRA_DEV_PUBLIC_URL",
    file: "tunnel.env",
    optional: false,
    purpose:
      "Public HTTPS address of this dev server (a tunnel or reverse proxy). Goes into the manifest as the webhook and callback host.",
  },
  {
    name: "LINEAR_CLIENT_ID",
    file: "linear.env",
    optional: false,
    purpose: "Client ID of the OAuth app that the manifest link creates in the test workspace.",
  },
  {
    name: "LINEAR_CLIENT_SECRET",
    file: "linear.env",
    optional: false,
    purpose: "Client secret of that app.",
  },
  {
    name: "LINEAR_WEBHOOK_SECRET",
    file: "linear.env",
    optional: false,
    purpose: "Signing secret of that app's webhook.",
  },
  {
    name: "LINEAR_API_KEY",
    file: "linear.env",
    optional: true,
    purpose:
      "A test-workspace admin's personal key. Lets `pnpm spike:real` create and delegate the 50 test issues itself, and archive them afterwards. Without it, a person delegates by hand. The run refuses to use a key whose workspace is not the one the app is installed in.",
  },
  {
    name: "LINEAR_TEST_TEAM_KEY",
    file: "linear.env",
    optional: true,
    purpose:
      "The key of the test team (such as OST) the 50 issues go in. Without it the workspace's first team is used, and its key is printed.",
  },
] as const satisfies readonly InputSpec[];

export const CRITERION_IDS = ["install", "latency", "stop-follow-up", "keep-alive", "sdk-strict"] as const;
export type CriterionId = (typeof CRITERION_IDS)[number];

export type CriterionSpec = {
  readonly id: CriterionId;
  readonly n: number;
  readonly passBar: string;
  /** Inputs the real-Linear tier needs. Empty: the criterion runs fully on this machine. */
  readonly realInputs: readonly InputName[];
  readonly realNeeds: string;
};

const APP_INPUTS = [
  "OSTRA_DEV_PUBLIC_URL",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
] as const satisfies readonly InputName[];

export const CRITERIA = [
  {
    id: "install",
    n: 1,
    passBar: "The app installs from a manifest link, as its own workspace user.",
    realInputs: APP_INPUTS,
    realNeeds: "a workspace admin clicking Create on the manifest link, then Authorize",
  },
  {
    id: "latency",
    n: 2,
    passBar:
      "Across 50 delegations, the webhook is answered in under 5 s and the first activity lands in under 10 s, with no runner involved.",
    realInputs: APP_INPUTS,
    realNeeds: "50 delegations in the test workspace (automated when LINEAR_API_KEY is set)",
  },
  {
    id: "stop-follow-up",
    n: 3,
    passBar: "Stop and follow-up arrive.",
    realInputs: APP_INPUTS,
    realNeeds: "a person pressing Send stop request and posting a follow-up in a Linear session",
  },
  {
    id: "keep-alive",
    n: 4,
    passBar: "A silent turn of 35 minutes stays alive.",
    realInputs: APP_INPUTS,
    realNeeds: "35 minutes of wall-clock time against a real session",
  },
  {
    id: "sdk-strict",
    n: 5,
    passBar:
      "`@linear/sdk` typechecks under ostra's strict flags and adds under 20 s to `tsc` (working value).",
    realInputs: [],
    realNeeds: "nothing: this criterion runs fully on this machine",
  },
] as const satisfies readonly CriterionSpec[];

export const criterionSpec = (id: CriterionId): CriterionSpec => {
  const spec = CRITERIA.find((c) => c.id === id);
  if (spec === undefined) throw new RangeError(`unknown criterion ${id}`);
  return spec;
};
