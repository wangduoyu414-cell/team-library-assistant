#!/usr/bin/env node
// The assistant orchestrates existing tools; TeamAI remains the sync engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const NAME = 'manage-team-library';
export const VERSION = '0.1.0';
export const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = '.team-library-install.json';
const own = (value, key) => Object.hasOwn(value, key);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function need(condition, code, message) { if (!condition) fail(code, message); }
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function repository(value) {
  const match = /^(?:(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/))?([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(value ?? '');
  need(match, 'INVALID_REPO', '请提供明确的 GitHub owner/repo 或无凭据的仓库地址。');
  const key = `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  need(!['', '.', '..'].includes(key.split('/')[1]), 'INVALID_REPO', '仓库名称无效。');
  return key.toLowerCase();
}

function regularPath(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.existsSync(current) || (() => { try { fs.lstatSync(current); return true; } catch { return false; } })()) {
      const stat = fs.lstatSync(current);
      // macOS exposes its system temporary roots through these root-owned aliases.
      const systemAlias = process.platform === 'darwin' && stat.uid === 0
        && ['/var', '/tmp', '/etc'].includes(current)
        && fs.realpathSync(current) === `/private${current}`;
      need(!stat.isSymbolicLink() || systemAlias, 'SYMLINK', `路径含符号链接，保留现状：${current}`);
    }
    if (path.dirname(current) === current) break;
  }
}

export function hostDirectory(agent, home = os.homedir(), env = process.env) {
  const expand = value => value?.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  const roots = {
    codex: path.join(home, '.agents', 'skills'),
    claude: path.join(expand(env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude'), 'skills'),
    workbuddy: path.join(expand(env.WORKBUDDY_CONFIG_DIR) || path.join(home, '.workbuddy'), 'skills'),
    qwen: path.join(home, '.qwen', 'skills'),
    dsh: path.join(expand(env.DSH_HOME) || path.join(home, '.dsh'), 'skills'),
  };
  need(own(roots, agent), 'UNSUPPORTED_HOST', '此宿主尚无已验证的安装适配；不要写入猜测的目录或覆盖内置技能。');
  need(path.isAbsolute(roots[agent]), 'INVALID_ROOT', '宿主配置根必须是绝对路径。');
  return path.join(roots[agent], NAME);
}

export function inventory(root) {
  const files = {};
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && [RECEIPT, '.runtime'].includes(entry.name)) continue;
      const relative = prefix + entry.name;
      const file = path.join(dir, entry.name);
      need(!entry.isSymbolicLink(), 'SYMLINK', `技能包含符号链接：${relative}`);
      if (entry.isDirectory()) walk(file, `${relative}/`);
      else {
        need(entry.isFile(), 'INVALID_FILE', `技能包含非常规文件：${relative}`);
        files[relative] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
    }
  };
  walk(root);
  return files;
}
const sameFiles = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function checkOwnership(home, target) {
  const directory = path.join(home, '.teamai');
  const journal = path.join(directory, 'managed-resources.journal.json');
  if (fs.existsSync(journal)) {
    const status = json(journal).status;
    need(['completed', 'rolled-back'].includes(status), 'TEAMAI_RECOVERY', 'TeamAI 有未结束的同步事务；先由原同步程序恢复。');
  }
  const file = path.join(directory, 'managed-resources.json');
  if (!fs.existsSync(file)) return;
  const manifest = json(file);
  need(manifest.version === 1 && manifest.resources && typeof manifest.resources === 'object', 'INVALID_MANIFEST', 'TeamAI 受管清单无效，未安装助手。');
  for (const resource of Object.values(manifest.resources)) {
    need(Array.isArray(resource.targets), 'INVALID_MANIFEST', 'TeamAI 受管清单无效。');
    need(!resource.targets.some(item => path.resolve(item.path) === target), 'TEAMAI_OWNED', '此入口仍由团队同步管理。请从外置下载目录运行 connect，正常同步移除原入口后再安装。');
  }
}

export function install({ agent, home = os.homedir(), env = process.env, source = SOURCE }) {
  const target = hostDirectory(agent, home, env);
  regularPath(source); regularPath(target);
  checkOwnership(home, target);
  const files = inventory(source);
  need(files['SKILL.md'] && files['scripts/team-library.mjs'], 'INVALID_PACKAGE', '下载包缺少完整技能或脚本。');
  const previous = `${target}.previous`;
  need(!fs.existsSync(previous), 'RECOVERY_REQUIRED', `保留了安装恢复目录：${previous}。核对后恢复，勿强制覆盖。`);
  if (fs.existsSync(target)) {
    const actual = inventory(target);
    const receipt = path.join(target, RECEIPT);
    if (fs.existsSync(receipt)) {
      const recorded = json(receipt);
      need(recorded.name === NAME && recorded.version && sameFiles(recorded.files, actual), 'LOCAL_CHANGES', '助手有本地改动，已保留；先整理差异再更新。');
    } else need(sameFiles(actual, files) || Object.keys(actual).length === 0, 'NAME_CONFLICT', '同名目录不是本安装器管理的助手，已保留。');
    if (sameFiles(actual, files) && fs.existsSync(receipt)) return { state: 'installed', changed: false, agent, target, version: VERSION, hostLoaded: false };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(target), `.${NAME}-`));
  let moved = false;
  try {
    for (const relative of Object.keys(files)) {
      const destination = path.join(stage, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, relative), destination);
    }
    const runtime = path.join(target, '.runtime');
    if (fs.existsSync(runtime)) {
      regularPath(runtime);
      inventory(runtime); // Refuse symlink escapes inside private data too.
      fs.cpSync(runtime, path.join(stage, '.runtime'), { recursive: true });
    }
    fs.writeFileSync(path.join(stage, RECEIPT), JSON.stringify({ name: NAME, version: VERSION, files }, null, 2) + '\n');
    if (fs.existsSync(target)) { fs.renameSync(target, previous); moved = true; }
    fs.renameSync(stage, target);
  } catch (error) {
    if (moved && !fs.existsSync(target)) fs.renameSync(previous, target);
    throw error;
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
  if (moved) fs.rmSync(previous, { recursive: true });
  return { state: 'installed', changed: true, agent, target, version: VERSION, hostLoaded: false };
}

export function runner(command, args, options = {}) {
  // Only npm uses a Windows command shim. Its arguments here are fixed, not user text.
  if (process.platform === 'win32' && command === 'npm') {
    need(args.every(value => /^[A-Za-z0-9=-]+$/.test(value)), 'UNSAFE_ARGUMENT', 'npm 参数无效。');
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { encoding: 'utf8', ...options });
  }
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

export function createClient(run = runner) {
  function command(executable, args, options = {}) {
    const result = run(executable, args, options);
    need(result.status === 0, 'COMMAND_FAILED', `${path.basename(executable)} 执行失败（${result.status ?? '无法启动'}）。请检查工具、网络或权限后继续；未自动扩大授权。`);
    return result.stdout?.trim() ?? '';
  }
  function api(endpoint, args = [], missing = false) {
    const result = run('gh', ['api', '--hostname', 'github.com', endpoint, ...args]);
    if (missing && result.status !== 0 && /\(HTTP 404\)/.test(result.stderr ?? '')) return null;
    need(result.status === 0, 'GITHUB_FAILED', 'GitHub 请求未完成；检查当前账号、网络及所需权限。');
    return result.stdout?.trim() ? JSON.parse(result.stdout) : null;
  }
  function identity() {
    need(run('gh', ['auth', 'status', '--hostname', 'github.com']).status === 0, 'LOGIN_REQUIRED', '请运行 gh auth login --hostname github.com --web --git-protocol https，在官方页面授权后重跑本步骤。');
    const user = api('user');
    need(typeof user?.login === 'string', 'GITHUB_FAILED', '无法核实当前 GitHub 账号。');
    return user.login;
  }
  function access(repo, accept = false) {
    const key = repository(repo);
    const login = identity();
    let info = api(`repos/${key}`, [], true);
    if (!info) {
      const pages = api('user/repository_invitations', ['--paginate', '--slurp']);
      need(Array.isArray(pages), 'GITHUB_FAILED', '邀请列表无效。');
      const invitations = pages.flat().filter(item => item?.repository?.full_name?.toLowerCase() === key && (!item.invitee?.login || item.invitee.login.toLowerCase() === login.toLowerCase()));
      need(invitations.length <= 1, 'INVITATION_CONFLICT', '发现重复邀请，请管理员核对。');
      const invitation = invitations[0];
      if (!invitation) return { state: 'invitation-required', repository: key, login };
      if (!accept) return { state: 'invitation-pending', repository: key, login };
      need(Number.isSafeInteger(invitation.id) && invitation.id > 0, 'GITHUB_FAILED', '邀请编号无效。');
      api(`user/repository_invitations/${invitation.id}`, ['--method', 'PATCH']);
      info = api(`repos/${key}`);
    }
    need(info?.full_name?.toLowerCase() === key, 'REPO_MISMATCH', 'GitHub 返回了不同仓库，未继续连接。');
    return { state: 'accessible', repository: key, login, permissions: info.permissions ?? {}, defaultBranch: info.default_branch };
  }
  function invite(repo, username, apply = false) {
    const key = repository(repo);
    need(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username ?? ''), 'INVALID_USER', '请使用明确的 GitHub 用户名。');
    const current = access(key);
    need(current.state === 'accessible' && current.permissions.admin === true, 'ADMIN_REQUIRED', '当前账号不是此仓库管理员，不能发出邀请。');
    const endpoint = `repos/${key}/collaborators/${username}`;
    const membership = api(`${endpoint}/permission`, [], true);
    if (membership && membership.permission !== 'none') return { state: 'already-member', repository: key, username };
    const pending = api(`repos/${key}/invitations`, ['--paginate', '--slurp']).flat().find(item => item.invitee?.login?.toLowerCase() === username.toLowerCase());
    if (pending) return { state: 'invitation-pending', repository: key, username };
    if (!apply) return { state: 'ready-to-invite', repository: key, username, permission: 'push' };
    api(endpoint, ['--method', 'PUT', '-f', 'permission=push']);
    return { state: 'invited', repository: key, username };
  }
  return { command, api, access, invite };
}

function loadTeam(workspace, client) {
  const root = path.resolve(workspace);
  regularPath(root);
  need(fs.existsSync(path.join(root, 'package-lock.json')), 'INVALID_TEAM', '团队仓库缺少锁文件。');
  const core = json(path.join(root, 'teamai-core.lock.json'));
  const pkg = json(path.join(root, 'package.json'));
  need(core.schema_version === 1 && core.status === 'active' && core.auto_update === false, 'INVALID_TEAM', '不支持此 Core 锁格式。');
  need(/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(core.fork.package), 'INVALID_TEAM', 'Core 包名无效。');
  need(pkg.dependencies?.[core.fork.package] === core.fork.tarball, 'INVALID_TEAM', 'Core 来源和项目依赖不一致。');
  const npmLock = json(path.join(root, 'package-lock.json'));
  const pinned = npmLock.packages?.[`node_modules/${core.fork.package}`];
  need(pinned?.resolved === core.fork.tarball && pinned.integrity === core.fork.tarball_integrity && pinned.version === core.fork.version, 'INVALID_TEAM', 'Core 锁与安装摘要不一致。');
  const installed = path.join(root, 'node_modules', core.fork.package, 'package.json');
  if (!fs.existsSync(installed)) client.command('npm', ['ci', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
  need(json(installed).version === core.fork.version, 'CORE_MISMATCH', '已安装同步程序版本不符；先按锁文件安装依赖，不跳过版本检查。');
  const YAML = createRequire(path.join(root, 'package.json'))('yaml');
  const read = file => {
    regularPath(file);
    const document = YAML.parseDocument(fs.readFileSync(file, 'utf8'), { uniqueKeys: true });
    need(document.errors.length + document.warnings.length === 0, 'INVALID_CONFIG', 'YAML 配置有错误。');
    return document.toJSON();
  };
  const config = read(path.join(root, 'teamai.yaml'));
  const key = repository(config.repo);
  const remote = repository(client.command('git', ['remote', 'get-url', 'origin'], { cwd: root }));
  need(remote === key, 'REPO_MISMATCH', 'origin 和团队配置不一致。');
  need(!fs.existsSync(path.join(root, 'skills', NAME)), 'TEAM_OWNS_ASSISTANT', '此团队仍分发管理助手；负责人先采用外置入口配置，再接入。');
  need(config.provider === 'github' && config.autoUpdate === false && config.sharing?.hooks?.autoApply === false && config.sharing?.registration?.autoRegister === false, 'INVALID_TEAM', '团队未采用本助手支持的手动同步配置。');
  return { root, key, read, cli: path.join(root, 'node_modules', core.fork.package, 'dist', 'index.js') };
}

export function connect({ repo, workspace, agent, accept = false, home = os.homedir(), env = process.env, source = SOURCE, run = runner, updateOnly = false }) {
  need(workspace, 'WORKSPACE_REQUIRED', '请指定独立创作目录 --workspace。');
  const key = repository(repo);
  hostDirectory(agent, home, env); // Unsupported hosts fail before authorization or writes.
  const client = createClient(run);
  const access = client.access(key, accept);
  if (access.state !== 'accessible') return access;
  const root = path.resolve(workspace);
  regularPath(root);
  if (!fs.existsSync(root)) {
    need(!updateOnly, 'WORKSPACE_REQUIRED', '更新需要已有的创作目录。');
    fs.mkdirSync(path.dirname(root), { recursive: true });
    client.command('gh', ['repo', 'clone', key, root, '--', '-c', 'core.autocrlf=false'], { stdio: 'inherit' });
  }
  // Reject other checkouts before dependency installation.
  need(repository(client.command('git', ['remote', 'get-url', 'origin'], { cwd: root })) === key, 'REPO_MISMATCH', '此目录属于另一仓库，保留原内容。');
  const team = loadTeam(root, client);
  need(team.key === key, 'REPO_MISMATCH', '团队配置与请求不一致。');
  const localFile = path.join(home, '.teamai', 'config.yaml');
  const local = fs.existsSync(localFile) ? team.read(localFile) : null;
  if (local) need(local.scope === 'user' && !local.repo?.kind?.includes('http') && repository(local.repo?.remote) === key, 'OTHER_TEAM', '本机已连接其他团队或作用域；未切换、未覆盖。');
  if (updateOnly) need(local, 'NOT_CONNECTED', '尚未连接此团队，请先执行 connect。');
  if (local?.enabledAgents) need(local.enabledAgents.includes(agent) && !local.disabledAgents?.includes(agent), 'HOST_NOT_CONNECTED', '此团队未启用指定宿主。按连接说明保留既有宿主后，显式补充宿主。');
  const recipients = new Set([agent]);
  const manifestFile = path.join(home, '.teamai', 'managed-resources.json');
  if (fs.existsSync(manifestFile)) {
    const old = json(manifestFile).resources?.[`skills:${NAME}`];
    for (const target of old?.targets ?? []) {
      need(hostDirectory(target.tool, home, env) === path.resolve(target.path), 'HOST_PATH_CHANGED', '原入口的安装路径与宿主路径不同，先核对路径，未执行迁移。');
      recipients.add(target.tool);
    }
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'team-assistant-'));
  const stagedSource = path.join(stage, NAME);
  fs.cpSync(source, stagedSource, { recursive: true });
  try {
    const options = { cwd: stage, env: { ...env, HOME: home, USERPROFILE: home }, stdio: 'inherit' };
    if (!local) client.command(process.execPath, [team.cli, 'init', `https://github.com/${key}.git`, '--scope', 'user', '--agent', agent], options);
    const connected = team.read(localFile);
    need(connected.scope === 'user' && repository(connected.repo?.remote) === key && (!connected.enabledAgents || connected.enabledAgents.includes(agent)), 'NOT_CONNECTED', '初始化没有建立预期连接；未报告成功。');
    client.command(process.execPath, [team.cli, 'pull'], options);
    const installed = [...recipients].map(host => install({ agent: host, home, env, source: stagedSource }));
    return { state: 'synced', repository: key, workspace: root, assistants: installed, hostLoaded: false };
  } finally { fs.rmSync(stage, { recursive: true }); }
}

export function main(args = process.argv.slice(2)) {
  const [action, ...rest] = args;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    need(['--agent', '--repo', '--workspace', '--user', '--accept-invitation', '--apply'].includes(key) && !own(flags, key), 'USAGE', '参数未知或重复。');
    flags[key] = ['--accept-invitation', '--apply'].includes(key) ? true : rest[++i];
    need(flags[key] && !String(flags[key]).startsWith('--'), 'USAGE', '参数缺少值。');
  }
  const client = createClient();
  if (action === 'install') return install({ agent: flags['--agent'] });
  if (action === 'access') return client.access(flags['--repo'], flags['--accept-invitation']);
  if (action === 'invite') return client.invite(flags['--repo'], flags['--user'], flags['--apply']);
  if (['connect', 'update'].includes(action)) return connect({ repo: flags['--repo'], workspace: flags['--workspace'], agent: flags['--agent'], accept: flags['--accept-invitation'], updateOnly: action === 'update' });
  if (action === 'doctor') return { version: VERSION, node: process.version, tools: Object.fromEntries(['git', 'gh', 'npm'].map(tool => [tool, runner(tool, ['--version']).status === 0])), hostLoaded: false };
  fail('USAGE', '用法：node scripts/team-library.mjs doctor | install --agent HOST | access --repo OWNER/REPO [--accept-invitation] | invite --repo OWNER/REPO --user LOGIN [--apply] | connect/update --repo OWNER/REPO --workspace PATH --agent HOST [--accept-invitation]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    need(Number(process.versions.node.split('.')[0]) >= 22, 'NODE_REQUIRED', '需要 Node.js 22 或以上；按接入说明先准备环境。');
    const result = main();
    console.log(JSON.stringify(result, null, 2));
    if (['invitation-required', 'invitation-pending'].includes(result.state)) process.exitCode = 2;
  } catch (error) { console.error(JSON.stringify({ state: 'blocked', code: error.code ?? 'ERROR', message: error.message })); process.exitCode = 1; }
}
