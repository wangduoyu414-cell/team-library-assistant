import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NAME, SOURCE, install, inventory, repository, hostDirectory, createClient, connect } from '../manage-team-library/scripts/team-library.mjs';

const ok = data => ({ status: 0, stdout: data === undefined ? '' : JSON.stringify(data), stderr: '' });
const notFound = () => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
function temporary(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), '团队 assistant '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function github({ loggedIn = true, accessible = true, invitations = [], admin = false, member = false, pending = false, networkError = false } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    assert.equal(command, 'gh');
    if (args[0] === 'auth') return { status: loggedIn ? 0 : 1 };
    const endpoint = args[3];
    if (endpoint === 'user') return ok({ login: 'member' });
    if (endpoint === 'repos/company/library') return networkError ? { status: 1, stderr: 'network unavailable' } : accessible ? ok({ full_name: 'company/library', default_branch: 'main', permissions: { admin, push: true } }) : notFound();
    if (endpoint === 'user/repository_invitations') return ok([invitations]);
    if (endpoint === 'user/repository_invitations/41') { assert.ok(args.includes('PATCH')); accessible = true; return ok(); }
    if (endpoint === 'repos/company/library/collaborators/new-member/permission') return member ? ok({ permission: 'write' }) : notFound();
    if (endpoint === 'repos/company/library/invitations') return ok([pending ? [{ invitee: { login: 'new-member' } }] : []]);
    if (endpoint === 'repos/company/library/collaborators/new-member') { assert.ok(args.includes('PUT')); pending = true; return ok({ id: 42 }); }
    throw new Error(`Unexpected request: ${args.join(' ')}`);
  };
  return { calls, client: createClient(run), run };
}
const invitation = (full_name = 'company/library', login = 'member') => ({ id: 41, repository: { full_name }, invitee: { login } });
const writes = calls => calls.filter(call => call.includes('PATCH') || call.includes('PUT'));

test('repository identities normalize without accepting credentials, query strings or traversal', () => {
  for (const input of ['Company/Library', 'https://github.com/Company/Library.git', 'git@github.com:Company/Library.git', 'ssh://git@github.com/Company/Library.git']) assert.equal(repository(input), 'company/library');
  for (const input of ['../library', 'company/..', 'https://token@github.com/company/library', 'company/library?token=x', 'https://example.com/company/library', 'company/library;touch x']) assert.throws(() => repository(input));
});

test('host selection honors explicit roots and rejects Doubao before filesystem changes', t => {
  const home = temporary(t);
  assert.equal(hostDirectory('codex', home, {}), path.join(home, '.agents/skills', NAME));
  assert.equal(hostDirectory('workbuddy', home, { WORKBUDDY_CONFIG_DIR: path.join(home, 'WorkBuddy 工作区') }), path.join(home, 'WorkBuddy 工作区', 'skills', NAME));
  assert.throws(() => install({ agent: 'doubao', home, env: {} }), { code: 'UNSUPPORTED_HOST' });
  assert.deepEqual(fs.readdirSync(home), []);
});

for (const agent of ['codex', 'claude', 'workbuddy', 'qwen', 'dsh']) test(`${agent}: complete independent package installs, repeats and preserves runtime`, t => {
  const home = temporary(t);
  const first = install({ agent, home, env: {} });
  assert.equal(first.hostLoaded, false);
  assert.deepEqual(inventory(first.target), inventory(SOURCE));
  assert.equal(install({ agent, home, env: {} }).changed, false);
  const runtime = path.join(first.target, '.runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'notes.txt'), 'private');
  const next = path.join(home, 'download');
  fs.cpSync(SOURCE, next, { recursive: true });
  fs.appendFileSync(path.join(next, 'SKILL.md'), '\nUpdated package.\n');
  assert.equal(install({ agent, home, env: {}, source: next }).changed, true);
  assert.equal(fs.readFileSync(path.join(runtime, 'notes.txt'), 'utf8'), 'private');
});

test('local edits, unowned names and unknown extra files are preserved', t => {
  const home = temporary(t);
  const result = install({ agent: 'codex', home, env: {} });
  fs.appendFileSync(path.join(result.target, 'SKILL.md'), '\nMy edit');
  assert.throws(() => install({ agent: 'codex', home, env: {} }), { code: 'LOCAL_CHANGES' });
  assert.match(fs.readFileSync(path.join(result.target, 'SKILL.md'), 'utf8'), /My edit/);
  const target = hostDirectory('claude', home, {});
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'personal.txt'), 'mine');
  assert.throws(() => install({ agent: 'claude', home, env: {} }), { code: 'NAME_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(target, 'personal.txt'), 'utf8'), 'mine');
});

test('active TeamAI ownership and interrupted transaction block external overwrite', t => {
  const home = temporary(t);
  const target = hostDirectory('codex', home, {});
  fs.mkdirSync(path.join(home, '.teamai'));
  const file = path.join(home, '.teamai', 'managed-resources.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, resources: { [`skills:${NAME}`]: { targets: [{ path: target, tool: 'codex' }] } } }));
  assert.throws(() => install({ agent: 'codex', home, env: {} }), { code: 'TEAMAI_OWNED' });
  fs.writeFileSync(file, JSON.stringify({ version: 1, resources: {} }));
  const journal = path.join(home, '.teamai', 'managed-resources.journal.json');
  fs.writeFileSync(journal, JSON.stringify({ status: 'applying' }));
  assert.throws(() => install({ agent: 'codex', home, env: {} }), { code: 'TEAMAI_RECOVERY' });
  fs.writeFileSync(journal, JSON.stringify({ status: 'completed' }));
  assert.equal(install({ agent: 'codex', home, env: {} }).changed, true);
});

test('incomplete installation backup remains recoverable and is never deleted by retry', t => {
  const home = temporary(t);
  const result = install({ agent: 'codex', home, env: {} });
  fs.renameSync(result.target, `${result.target}.previous`);
  assert.throws(() => install({ agent: 'codex', home, env: {} }), { code: 'RECOVERY_REQUIRED' });
  assert.ok(fs.existsSync(path.join(`${result.target}.previous`, 'SKILL.md')));
  fs.renameSync(`${result.target}.previous`, result.target);
  assert.equal(install({ agent: 'codex', home, env: {} }).changed, false);
});

test('symbolic link target cannot redirect installation', { skip: process.platform === 'win32' ? 'Windows symlink creation requires machine policy; junction tested instead below' : false }, t => {
  const home = temporary(t);
  fs.mkdirSync(path.join(home, 'elsewhere'));
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, '.agents'));
  assert.throws(() => install({ agent: 'codex', home, env: {} }), { code: 'SYMLINK' });
  assert.deepEqual(fs.readdirSync(path.join(home, 'elsewhere')), []);
});

test('Windows junction target cannot redirect installation', { skip: process.platform !== 'win32' }, t => {
  const home = temporary(t);
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(home, '.agents'), 'junction');
  assert.throws(() => install({ agent: 'codex', home, env: {} }), { code: 'SYMLINK' });
});

test('browser-only session yields login-required with no API write', () => {
  const fixture = github({ loggedIn: false });
  assert.throws(() => fixture.client.access('company/library', true), { code: 'LOGIN_REQUIRED' });
  assert.equal(fixture.calls.length, 1);
});

test('accepts only the authorized repository invitation, then verifies access and repeats safely', () => {
  const fixture = github({ accessible: false, invitations: [invitation('other/private'), invitation()] });
  assert.equal(fixture.client.access('company/library').state, 'invitation-pending');
  assert.equal(writes(fixture.calls).length, 0);
  assert.equal(fixture.client.access('company/library', true).state, 'accessible');
  assert.equal(fixture.client.access('company/library', true).state, 'accessible');
  assert.equal(writes(fixture.calls).length, 1);
  assert.equal(writes(fixture.calls)[0][4], 'user/repository_invitations/41');
});

test('no invitation and wrong invitee never grant or invent access', () => {
  for (const invitations of [[], [invitation('company/library', 'somebody-else')], [invitation('other/library')]]) {
    const fixture = github({ accessible: false, invitations });
    assert.deepEqual(fixture.client.access('company/library', true), { state: 'invitation-required', repository: 'company/library', login: 'member' });
    assert.equal(writes(fixture.calls).length, 0);
  }
});

test('network errors are not reported as missing invitation', () => {
  const fixture = github({ networkError: true });
  assert.throws(() => fixture.client.access('company/library', true), { code: 'GITHUB_FAILED' });
  assert.equal(fixture.calls.some(call => call.includes('user/repository_invitations')), false);
});

test('administrator invitation requires authority and explicit apply and never resends', () => {
  const member = github();
  assert.throws(() => member.client.invite('company/library', 'new-member', true), { code: 'ADMIN_REQUIRED' });
  assert.equal(writes(member.calls).length, 0);
  const admin = github({ admin: true });
  assert.equal(admin.client.invite('company/library', 'new-member').state, 'ready-to-invite');
  assert.equal(writes(admin.calls).length, 0);
  assert.equal(admin.client.invite('company/library', 'new-member', true).state, 'invited');
  assert.equal(admin.client.invite('company/library', 'new-member', true).state, 'invitation-pending');
  assert.equal(writes(admin.calls).length, 1);
  const existing = github({ admin: true, member: true });
  assert.equal(existing.client.invite('company/library', 'new-member', true).state, 'already-member');
  assert.equal(writes(existing.calls).length, 0);
});

test('connect resumes at an outstanding invitation without cloning or installing', t => {
  const home = temporary(t);
  const fixture = github({ accessible: false });
  const result = connect({ repo: 'company/library', workspace: path.join(home, 'work'), agent: 'codex', home, env: {}, run: fixture.run });
  assert.equal(result.state, 'invitation-required');
  assert.deepEqual(fs.readdirSync(home), []);
});

test('an unsupported host fails before touching GitHub', t => {
  const home = temporary(t);
  assert.throws(() => connect({ repo: 'company/library', workspace: path.join(home, 'work'), agent: 'doubao', home, run: () => { throw new Error('must not run'); } }), { code: 'UNSUPPORTED_HOST' });
});

test('wrong working repository fails before dependency install', t => {
  const home = temporary(t);
  const workspace = path.join(home, 'work');
  fs.mkdirSync(workspace);
  const fixture = github();
  const run = (command, args, options) => command === 'git' ? { status: 0, stdout: 'https://github.com/other/repository.git' } : fixture.run(command, args, options);
  assert.throws(() => connect({ repo: 'company/library', workspace, agent: 'codex', home, env: {}, run }), { code: 'REPO_MISMATCH' });
  assert.deepEqual(fs.readdirSync(workspace), []);
});

test('CLI launches independently and rejects unknown arguments', () => {
  const script = path.join(SOURCE, 'scripts', 'team-library.mjs');
  const result = spawnSync(process.execPath, [script, 'install', '--force'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'USAGE');
});

test('all local links in shipped Markdown resolve within the package', () => {
  for (const relative of Object.keys(inventory(SOURCE)).filter(file => file.endsWith('.md'))) {
    const file = path.join(SOURCE, relative);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(match[1])) continue;
      const target = path.resolve(path.dirname(file), match[1].split('#')[0]);
      assert.ok(target.startsWith(SOURCE + path.sep));
      assert.ok(fs.existsSync(target), `${relative}: missing ${match[1]}`);
    }
  }
});
