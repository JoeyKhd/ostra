import { randomBytes } from 'node:crypto';
import { configDir, readEnv } from '../inputs.ts';
import { describePermissions, permissionGaps, startManifestServer, type Conversion } from './manifest.ts';
import { writeCredentials, writeFallbackKey } from './manifest-store.ts';

// `pnpm manifest`: creates the sandbox App from a manifest, interactively.
// Open the printed address in a browser signed in as an owner of the sandbox
// org. Prints IDs and paths only, never a secret. It gives up after an hour,
// as GitHub's code would expire by then anyway.

const TIMEOUT_MS = 60 * 60_000;

const main = async (): Promise<void> => {
  const env = readEnv();
  if (env.GITHUB_TEST_ORG === undefined) {
    console.error('Set GITHUB_TEST_ORG to the sandbox org first.');
    process.exit(1);
  }
  const org = env.GITHUB_TEST_ORG;
  const dir = configDir(env);
  const server = await startManifestServer({
    org,
    appName: `ostra-sandbox-${randomBytes(3).toString('hex')}`,
    webUrl: env.GITHUB_WEB_URL.replace(/\/$/, ''),
    apiUrl: env.GITHUB_API_URL,
    publicUrl: env.OSTRA_DEV_PUBLIC_URL?.replace(/\/$/, '') ?? null,
    port: env.OSTRA_DEV_MANIFEST_PORT,
    onCreated: (conversion) => writeCredentials(dir, conversion, org),
    onStoreFailed: (salvage) => writeFallbackKey(dir, salvage),
  });
  console.log(`Open ${server.url} in a browser signed in as an owner of ${org}.`);
  if (env.OSTRA_DEV_PUBLIC_URL === undefined) console.log('No OSTRA_DEV_PUBLIC_URL: the App is created with its webhook off.');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('no answer from GitHub within an hour; run `pnpm manifest` again'));
    }, TIMEOUT_MS);
  });
  let conversion: Conversion;
  try {
    conversion = await Promise.race([server.done, timeout]);
  } finally {
    clearTimeout(timer);
    await server.close();
  }
  const gaps = permissionGaps(conversion.permissions);
  console.log(`Created App ${String(conversion.id)} (${conversion.slug}). Credentials are in ${dir}.`);
  // The keys as GitHub spelled them (research S6).
  console.log(`GitHub returned the permissions: ${describePermissions(conversion.permissions)}`);
  console.log(`and the events: ${[...conversion.events].sort().join(', ')}`);
  console.log(gaps.length === 0 ? 'It has every permission v1 needs, checks: write among them.' : `Missing: ${gaps.map((g) => `${g.name}:${g.wanted}`).join(', ')}`);
  console.log(`Install it on both sandbox repos: ${conversion.html_url}/installations/new`);
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'manifest flow failed');
  process.exit(1);
});
