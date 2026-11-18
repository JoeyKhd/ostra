import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LFS_ACTION_HOSTS, isAllowedLfsActionHref } from '../src/git-proxy.ts';

const upstream = 'https://github.com';
const allowed = (href: string, hosts: readonly string[] = DEFAULT_LFS_ACTION_HOSTS): boolean => isAllowedLfsActionHref(new URL(href), upstream, hosts);

void test("allows the upstream's origin and GitHub's LFS storage hosts", () => {
  assert.equal(allowed('https://github.com/o/r.git/info/lfs/objects/abc'), true);
  assert.equal(allowed('https://github-cloud.githubusercontent.com/alambic/media/1'), true);
  assert.equal(allowed('https://media.githubusercontent.com/x'), true);
});

void test('refuses IP literals, localhost, other schemes, ports and look-alikes', () => {
  for (const href of [
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://localhost/x',
    'https://api.localhost/x',
    'http://github-cloud.githubusercontent.com/x',
    'https://github-cloud.githubusercontent.com:8443/x',
    'https://user:pass@github-cloud.githubusercontent.com/x',
    'https://githubusercontent.com.evil.example/x',
    'https://github-cloud.githubusercontent.com.evil.example/x',
    'https://evilgithubusercontent.com/x',
    'https://internal.example.invalid/x',
  ]) {
    assert.equal(allowed(href), false, href);
  }
});

void test('a configured host (GitHub Enterprise Server storage) is allowed, and only it', () => {
  assert.equal(allowed('https://lfs.ghes.example.com/x', ['lfs.ghes.example.com']), true);
  assert.equal(allowed('https://github-cloud.githubusercontent.com/x', ['lfs.ghes.example.com']), false);
});
