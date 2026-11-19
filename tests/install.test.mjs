import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { codexHookCommand } from '../lib/codex-config.mjs';
import { run as runInstaller } from '../lib/install.mjs';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const name = 'herdr-mattpocock-skills';
const hookScript = path.join('.agents', 'skills', name, 'scripts', 'codex-session-start.mjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const project = path.join(root, "Project O'Brien %HMS_TEST% 中文");
  fs.mkdirSync(profile);
  fs.mkdirSync(project);
  const env = { ...process.env, HOME: profile, USERPROFILE: profile };
  delete env.CODEX_HOME;
  const run = (args, { expected = 0, extraEnv = {} } = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: project, env: { ...env, ...extraEnv }, encoding: 'utf8',
    });
    assert.equal(result.status, expected, result.stderr || result.stdout);
    return result;
  };
  return { root, profile, project, env, run };
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const statusLine = file => getStaticTOMLValue(parseTOML(read(file))).tui.status_line;

function terminal(t, env, answers) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 24 });
  let next = 0;
  stdout.setEncoding('utf8');
  stdout.on('data', text => {
    const answer = answers[next];
    if (!answer || !text.includes(answer[0])) return;
    next++;
    setImmediate(() => stdin.write(answer[1]));
  });
  t.after(() => {
    stdin.destroy();
    stdout.destroy();
  });
  return { stdin, stdout, env };
}

test('用方向键切换全局安装，空格勾选或取消，回车安装所选 agent', { timeout: 5000 }, async t => {
  const { profile, env } = fixture(t);
  const down = '\x1b[B';
  const up = '\x1b[A';
  const io = terminal(t, env, [
    ['选择安装范围', `${down}\r`],
    ['选择 agent', ` ${down} ${down}  ${up}\r`],
  ]);
  assert.equal(await runInstaller(['install'], io), 0);
  assert.ok(fs.existsSync(path.join(profile, '.codex', 'hooks.json')));
  assert.ok(fs.existsSync(path.join(profile, '.claude', 'skills', name, 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(profile, '.cursor')));
});

test('选择 agent 时按 Ctrl+C 取消，项目与用户目录均无写入', { timeout: 5000 }, async t => {
  const { project, profile, env } = fixture(t);
  const io = terminal(t, env, [['选择 agent', ' \x03']]);
  assert.equal(await runInstaller(['install', '--project', project], io), 130);
  assert.deepEqual(fs.readdirSync(project), []);
  assert.deepEqual(fs.readdirSync(profile), []);
});

test('选择 Codex 项目安装时合并已有配置，多选不重复安装，共享技能卸载只移除 HMS hook', t => {
  const { project, profile, run } = fixture(t);
  const configFile = path.join(project, '.codex', 'config.toml');
  const hooksFile = path.join(project, '.codex', 'hooks.json');
  const routing = path.join(project, '.agents', 'herdr', 'routing.json');
  const userHooks = {
    description: '已有个人 hook',
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo keep-start' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo keep-stop' }] }],
    },
  };
  put(configFile, [
    '# Keep this file', 'model = "custom"', '["tui"] # Existing section',
    'status_line = [', '  "current-dir", # Keep its note', '  "thread-id",', '  "context-used"', '  , "thread-id"',
    '] # Keep the array note', '', '[features]', 'foo = true', '',
  ].join('\r\n'));
  put(hooksFile, JSON.stringify(userHooks));
  put(routing, '{"active":false}\n');

  const args = ['install', '-a', 'codex,claude,agents', '--project', project];
  const { stdout } = run(args);
  assert.equal(stdout.match(/^codex: /gm).length, 2);
  assert.doesNotMatch(stdout, /^agents: /m);
  assert.ok(fs.existsSync(path.join(project, '.claude', 'skills', name, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(project, hookScript)));
  assert.equal(read(routing), '{"active":false}\n');
  assert.ok(!fs.existsSync(path.join(profile, '.codex')));

  const config = read(configFile);
  assert.deepEqual(statusLine(configFile), ['thread-id', 'current-dir', 'context-used']);
  for (const text of ['# Keep this file', '# Keep its note', '] # Keep the array note', '[features]\r\nfoo = true']) {
    assert.ok(config.includes(text), text);
  }
  const doc = json(hooksFile);
  assert.equal(doc.description, userHooks.description);
  assert.deepEqual(doc.hooks.Stop, userHooks.hooks.Stop);
  assert.deepEqual(doc.hooks.SessionStart.slice(0, -1), userHooks.hooks.SessionStart);
  const [handler] = doc.hooks.SessionStart.at(-1).hooks;
  assert.equal(handler.command, codexHookCommand(path.join(project, hookScript)));
  assert.match(run(['status', '--project', project]).stdout, /codex\/SessionStart: 已登记/);

  const hookText = read(hooksFile);
  run(args);
  assert.equal(read(hooksFile), hookText);
  assert.equal(read(configFile), config);
  run(['uninstall', '--target', 'agents', '--project', project]);
  assert.deepEqual(json(hooksFile), userHooks);
  assert.ok(!fs.existsSync(path.join(project, hookScript)));
  assert.ok(fs.existsSync(path.join(project, '.claude', 'skills', name, 'SKILL.md')));
});

test('全局安装只配置用户目录，项目安装只写项目且继承用户状态栏', t => {
  const { project, profile, root, run } = fixture(t);
  const userDir = path.join(profile, '.codex');
  const userConfig = path.join(userDir, 'config.toml');
  const userHooks = path.join(userDir, 'hooks.json');
  put(userConfig, 'tui = { status_line = ["context-used"], status_line_use_colors = false }\n');
  run(['install', '--agent=codex', '--global']);
  assert.deepEqual(statusLine(userConfig), ['thread-id', 'context-used']);
  assert.ok(read(userConfig).includes('status_line_use_colors = false'));
  assert.equal(json(userHooks).hooks.SessionStart[0].hooks[0].command, codexHookCommand(path.join(profile, hookScript)));
  assert.ok(!fs.existsSync(path.join(project, '.codex')));

  const custom = path.join(root, 'Custom Codex');
  run(['install', '--agent', 'codex', '-g'], { extraEnv: { CODEX_HOME: custom } });
  assert.ok(fs.existsSync(path.join(custom, 'hooks.json')));

  const original = read(userConfig);
  run(['install', '--target', 'agents,claude', '--project', project]);
  assert.ok(!fs.existsSync(path.join(project, '.codex')));
  const projectConfig = path.join(project, '.codex', 'config.toml');
  put(projectConfig, 'tui.status_line_use_colors = true\n');
  run(['install', '--target', 'codex', '--project', project]);
  assert.deepEqual(statusLine(projectConfig), ['thread-id', 'context-used']);
  assert.equal(read(userConfig), original);
  assert.ok(read(projectConfig).includes('tui.status_line_use_colors = true'));
});

test('重新安装会用用户状态栏补全旧项目的 thread-id 数组', t => {
  const { project, profile, run } = fixture(t);
  const userConfig = path.join(profile, '.codex', 'config.toml');
  const projectDir = path.join(project, '.codex');
  const projectConfig = path.join(projectDir, 'config.toml');
  const items = ['model-with-reasoning', 'context-remaining', 'current-dir', 'git-branch', 'context-used', 'run-state',
    'context-window-size', 'total-input-tokens', 'total-output-tokens', 'fast-mode', 'task-progress'];
  const userText = `[tui]\nstatus_line = ${JSON.stringify(items)}\n`;
  const old = '[tui]\nstatus_line = [\n  "thread-id", # Keep this note\n]\nstatus_line_use_colors = false\n';
  put(userConfig, userText);
  const args = ['install', '--agent', 'codex', '--project', project];
  for (const extraEnv of [{}, { CODEX_HOME: projectDir }]) {
    put(projectConfig, old);
    run(args, { extraEnv });
    assert.deepEqual(statusLine(projectConfig), ['thread-id', ...items]);
    const updated = read(projectConfig);
    assert.ok(updated.includes('# Keep this note\n'));
    assert.ok(updated.includes('status_line_use_colors = false\n'));
    run(args, { extraEnv });
    assert.equal(read(projectConfig), updated);
    assert.equal(read(userConfig), userText);
  }
});

test('合并前发现 Codex 配置无效时保留文件并中止安装', t => {
  const { project, run } = fixture(t);
  const args = ['install', '--agent', 'codex', '--project', project];
  const hook = path.join(project, '.codex', 'hooks.json');
  const config = path.join(project, '.codex', 'config.toml');
  put(hook, '{"hooks":{"SessionStart":false}}');
  assert.match(run(args, { expected: 1 }).stderr, /无法合并 Codex hook/);
  assert.equal(read(hook), '{"hooks":{"SessionStart":false}}');
  assert.ok(!fs.existsSync(config));
  put(hook, '{}');
  put(config, '[tui]\nstatus_line = false\n');
  assert.match(run(args, { expected: 1 }).stderr, /无法合并 Codex 配置/);
  assert.equal(read(config), '[tui]\nstatus_line = false\n');
  assert.equal(read(hook), '{}');
  assert.ok(!fs.existsSync(path.join(project, hookScript)));
});

test('生成的 hook 命令可从其他目录执行，路径中的空格和 shell 特殊字符为字面值', t => {
  const { project, profile, run } = fixture(t);
  run(['install', '--agent', 'codex', '--project', project]);
  const script = path.join(project, hookScript);
  for (const platform of new Set([process.platform, 'win32'])) {
    const result = spawnSync(codexHookCommand(script, platform), {
      shell: true, cwd: profile, encoding: 'utf8', input: '{"hook_event_name":"Stop"}',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
});
