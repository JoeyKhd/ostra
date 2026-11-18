import { access } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './git.ts';
import { configDir, DESCRIPTIONS, INPUT_NAMES, NEEDS, missing, present, readEnv } from './inputs.ts';
import { MANIFEST_RESULT_FILE } from './github/manifest.ts';

// Reports which inputs are present. Never prints a value.

const main = async (): Promise<void> => {
  const env = readEnv();
  console.log('Inputs (present / missing, values never shown):');
  for (const name of INPUT_NAMES) {
    console.log(`  ${present(name) ? 'present' : 'missing'}  ${name.padEnd(28)} ${DESCRIPTIONS[name]}`);
  }
  const marker = path.join(configDir(env), MANIFEST_RESULT_FILE);
  const markerFound = await access(marker).then(
    () => true,
    () => false,
  );
  console.log(`  ${markerFound ? 'present' : 'missing'}  ${'manifest result'.padEnd(28)} written by \`pnpm manifest\` to <config dir>/${MANIFEST_RESULT_FILE}`);
  if (env.GITHUB_APP_PRIVATE_KEY_PATH !== undefined) {
    const readable = await access(env.GITHUB_APP_PRIVATE_KEY_PATH).then(
      () => true,
      () => false,
    );
    console.log(`  ${readable ? 'readable' : 'NOT READABLE'}  the private key file`);
  }
  const tools = await Promise.all([
    runGit(['--version'], { cwd: process.cwd(), env: { PATH: process.env['PATH'] ?? '' } }),
    runGit(['lfs', 'version'], { cwd: process.cwd(), env: { PATH: process.env['PATH'] ?? '' } }),
  ]);
  console.log(`\nTools: git ${tools[0].code === 0 ? tools[0].stdout.trim() : 'MISSING'}; git-lfs ${tools[1].code === 0 ? tools[1].stdout.trim() : 'MISSING'}`);
  console.log('\nWhat each part needs beyond the local run:');
  for (const [part, names] of Object.entries(NEEDS)) {
    const m = missing(names);
    console.log(`  ${part.padEnd(12)} ${m.length === 0 ? 'ready' : `missing ${m.join(', ')}`}`);
  }
  console.log('  manifest     needs a browser signed in as an owner of GITHUB_TEST_ORG: run `pnpm manifest`');
  console.log('  box          the "agent\'s container" half of the token check needs spike 3\'s box (Docker on Linux)');
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'check:inputs failed');
  process.exit(1);
});
