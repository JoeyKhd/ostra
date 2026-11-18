import { randomBytes } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_RESULT_FILE, type Conversion, type ManifestResult, type Salvage } from './manifest.ts';

// Writes what the manifest conversion returned into the dev config directory,
// outside the repo: the key as a .pem, the rest as a shell-sourceable env
// file. Existing files are never overwritten.

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

const quote = (value: string): string => {
  if (value.includes("'") || value.includes('\n')) throw new Error('unexpected character in a credential');
  return `'${value}'`;
};

export const writeCredentials = async (dir: string, conversion: Conversion, org: string): Promise<string> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = String(conversion.id);
  const pemPath = path.join(dir, `github-app-${id}.pem`);
  await writeFile(pemPath, conversion.pem, { mode: 0o600, flag: 'wx' });
  const envPath = (await exists(path.join(dir, 'github.env'))) ? path.join(dir, `github-app-${id}.env`) : path.join(dir, 'github.env');
  const lines = [
    `GITHUB_APP_ID=${id}`,
    `GITHUB_APP_SLUG=${quote(conversion.slug)}`,
    `GITHUB_APP_CLIENT_ID=${quote(conversion.client_id)}`,
    `GITHUB_APP_CLIENT_SECRET=${quote(conversion.client_secret)}`,
    `GITHUB_APP_PRIVATE_KEY_PATH=${quote(pemPath)}`,
    ...(conversion.webhook_secret === null ? [] : [`GITHUB_WEBHOOK_SECRET=${quote(conversion.webhook_secret)}`]),
    `GITHUB_TEST_ORG=${quote(org)}`,
    '',
  ];
  await writeFile(envPath, lines.join('\n'), { mode: 0o600, flag: 'wx' });
  const result: ManifestResult = {
    appId: conversion.id,
    slug: conversion.slug,
    owner: conversion.owner?.login ?? null,
    permissions: conversion.permissions,
    events: conversion.events,
    createdAt: new Date().toISOString(),
    via: 'manifest-flow',
  };
  await writeFile(path.join(dir, MANIFEST_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return envPath;
};

// The fallback when writeCredentials fails after GitHub made the App: the
// one-time key alone, under a name that can't collide, never overwriting.
export const writeFallbackKey = async (dir: string, salvage: Salvage): Promise<string> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = salvage.id === null ? 'unknown' : String(salvage.id);
  const file = path.join(dir, `github-app-${id}-recovered-${randomBytes(4).toString('hex')}.pem`);
  await writeFile(file, salvage.pem, { mode: 0o600, flag: 'wx' });
  return file;
};
