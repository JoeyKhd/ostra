import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RepoSlugSchema, TaskIdSchema } from '../src/ids.ts';
import type { RefUpdateCommand } from '../src/pkt-line.ts';
import { decidePush, type TaskGitPolicy } from '../src/policy.ts';

const policy: TaskGitPolicy = {
  taskId: TaskIdSchema.parse('t1'),
  repo: RepoSlugSchema.parse('ostra-sandbox/repo'),
  branches: ['ostra/t1'],
  mode: 'read-write',
};
const cmd = (ref: string, kind: RefUpdateCommand['kind'] = 'update'): RefUpdateCommand => ({ oldId: 'a'.repeat(40), newId: 'b'.repeat(40), ref, kind });

void test("allows the task's branch and hidden ref", () => {
  assert.equal(decidePush(policy, [cmd('refs/heads/ostra/t1'), cmd('refs/ostra/wip/t1', 'create')]).allowed, true);
});

void test('refuses everything else, exactly', () => {
  for (const ref of ['refs/heads/main', 'refs/heads/ostra/t1-evil', 'refs/heads/OSTRA/t1', 'refs/tags/v1', 'refs/ostra/wip/t2', 'refs/heads/ostra/t1/x']) {
    assert.equal(decidePush(policy, [cmd(ref)]).allowed, false, ref);
  }
});

void test('refuses deletes, even of its own branch', () => {
  const v = decidePush(policy, [cmd('refs/heads/ostra/t1', 'delete')]);
  assert.ok(!v.allowed);
  assert.deepEqual(v.codes, ['delete']);
});

void test('one bad ref refuses the whole push', () => {
  const v = decidePush(policy, [cmd('refs/heads/ostra/t1'), cmd('refs/heads/main')]);
  assert.equal(v.allowed, false);
  assert.deepEqual(
    v.verdicts.map((x) => x.allowed),
    [false, false],
  );
});

void test('a read-only policy refuses every update', () => {
  assert.equal(decidePush({ ...policy, mode: 'read-only' }, [cmd('refs/heads/ostra/t1')]).allowed, false);
});
