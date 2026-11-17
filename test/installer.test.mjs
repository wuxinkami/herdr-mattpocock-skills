import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/installer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultsFile = 'templates/agent-defaults.json';
const defaults = JSON.parse(fs.readFileSync(path.join(root, defaultsFile), 'utf8'));
const receiptName = '.herdr-mattpocock-skills-install.json';
const read = file => fs.readFileSync(file, 'utf8');
const readJson = file => JSON.parse(read(file));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const writeJson = (file, data) => write(file, JSON.stringify(data, null, 2) + '\n');

function snapshot(directory) {
  const entries = {};
  const visit = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(current, entry.name);
      entries[relative] = entry.isDirectory() ? 'directory' : fs.readFileSync(file).toString('base64');
      if (entry.isDirectory()) visit(file, relative);
    }
  };
  visit(directory);
  return entries;
}

function failRenameOnce(t, matches) {
  const original = fs.renameSync;
  let fired = false;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (!fired && matches(from, to)) {
      fired = true;
      throw Object.assign(new Error('Injected EACCES during filesystem swap'), { code: 'EACCES' });
    }
    return original(from, to);
  });
  return () => { mocked.mock.restore(); assert.equal(fired, true, 'the injected write failure must be reached'); };
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-mattpocock-skills-installer-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  const packageRoot = path.join(base, 'package');
  fs.mkdirSync(project); fs.mkdirSync(home);
  writeJson(path.join(packageRoot, 'package.json'), { name: 'herdr-mattpocock-skills', version: '0.2.1' });
  write(path.join(packageRoot, 'SKILL.md'), '---\nname: herdr-mattpocock-skills\ndescription: Fixture role routing\n---\nOriginal skill\n');
  writeJson(path.join(packageRoot, defaultsFile), defaults);
  write(path.join(packageRoot, 'references/routing.md'), 'Routing reference\n');
  write(path.join(packageRoot, 'bin/private.mjs'), 'This executable must not enter an installed skill.');
  let stdout = '';
  const env = { cwd: project, home, packageRoot, interactive: false, env: { PATH: '' }, stdout: { write: s => { stdout += s; } }, stderr: { write() {} } };
  return {
    base, project, home, packageRoot, env,
    target: (agent = 'codex') => path.join(project, agent === 'claude-code' ? '.claude' : agent === 'cursor' ? '.cursor' : agent === 'dsh' ? '.dsh' : '.agents', 'skills/herdr-mattpocock-skills'),
    async invoke(args, changes = {}) { stdout = ''; const status = await run(args, { ...env, ...changes }); return { status, output: stdout }; },
  };
}

test('config --template emits a complete JSON template without an installation or filesystem writes', async t => {
  const f = fixture(t);
  const before = snapshot(f.base);
  for (const flags of [[], ['--json']]) {
    const result = await f.invoke(['config', '--template', ...flags]);
    assert.equal(result.status, 0);
    const config = JSON.parse(result.output);
    assert.deepEqual(config, defaults);
    assert.equal(config.docsDir, '.agents/herdr/session');
    assert.equal(config.roles.griller.carrier, 'herdr');
    assert.deepEqual(config.roles.merger, { inheritRole: 'pm', carrier: 'native' });
    assert.deepEqual(snapshot(f.base), before);
  }
  for (const flags of [
    ['-a', 'codex'], ['--agent='], ['--config', 'routing.json'], ['--dir', 'skills'],
    ['--path'], ['--project', f.project], ['--global'],
  ]) await assert.rejects(f.invoke(['config', '--template', ...flags]), /--template cannot be combined/);
  for (const command of ['install', 'update', 'uninstall', 'doctor']) {
    await assert.rejects(f.invoke([command, '--template']), /--template is only valid with config/);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test('install --defaults seeds every selected host and update preserves each configuration byte-for-byte', async t => {
  const f = fixture(t);
  const agents = ['codex', 'claude-code', 'cursor', 'dsh'];
  const edited = structuredClone(defaults);
  edited.docsDir = 'team-docs/development-runs';
  edited.tools.personal = { command: ['personal-agent', 'run'] };
  edited.roles.backend = { ...edited.roles.backend, tool: 'personal', model: 'personal-model', effort: 'personal-effort' };
  edited.roles.griller = { ...edited.roles.griller, tool: 'personal', model: 'planning-model', effort: 'planning-effort' };
  edited.roles.merger = { tool: 'personal', model: 'merge-model', effort: 'merge-effort', carrier: 'background' };
  const file = path.join(f.base, 'my-agent-defaults.json');
  const seed = JSON.stringify(edited, null, '\t').replace(/\n/g, '\r\n');
  write(file, seed);
  const result = JSON.parse((await f.invoke(['install', '-a', agents.join(','), '--defaults', path.relative(f.project, file), '--json'])).output);
  assert.equal(result.installations.length, agents.length);
  const preserved = new Map();
  for (const agent of agents) {
    const routing = path.join(f.target(agent), 'routing.json');
    assert.equal(read(routing), seed);
    assert.equal(result.installations.find(entry => entry.agents.includes(agent)).configurationSource, file);
    const userConfig = readJson(routing);
    userConfig.roles.frontend.model = `${agent}-local-model`;
    const bytes = '\n' + JSON.stringify(userConfig, null, '\t').replace(/\n/g, '\r\n') + '\r\n\r\n';
    write(routing, bytes);
    preserved.set(routing, bytes);
  }
  const updated = structuredClone(defaults);
  updated.roles.backend.model = 'updated-package-example';
  writeJson(path.join(f.packageRoot, defaultsFile), updated);
  await f.invoke(['update', '-a', agents.join(',')]);
  for (const [routing, bytes] of preserved) assert.equal(read(routing), bytes);
});

test('legacy role configurations survive upgrades without injected defaults and receive explicit migration guidance', async t => {
  const f = fixture(t);
  const legacy = structuredClone(defaults);
  delete legacy.roles.griller;
  delete legacy.roles.merger;
  legacy.docsDir = 'docs/mulit-agent';
  legacy.roles.backend.model = 'legacy-backend-choice';
  writeJson(path.join(f.packageRoot, defaultsFile), legacy);
  await f.invoke(['install', '-a', 'codex,claude-code']);
  const saved = new Map();
  for (const agent of ['codex', 'claude-code']) {
    const routing = path.join(f.target(agent), 'routing.json');
    const bytes = '\n' + JSON.stringify(readJson(routing), null, '\t').replace(/\n/g, '\r\n') + '\r\n';
    write(routing, bytes);
    saved.set(routing, bytes);
  }
  writeJson(path.join(f.packageRoot, defaultsFile), defaults);
  for (const command of ['install', 'update']) {
    const result = JSON.parse((await f.invoke([command, '-a', 'codex,claude-code', '--json'])).output);
    assert.ok(result.warnings.some(w => /Missing role bindings: griller, merger/.test(w)));
    assert.ok(result.warnings.some(w => /Set docsDir to \.agents\/herdr\/session/.test(w)));
    for (const [routing, bytes] of saved) assert.equal(read(routing), bytes);
  }
  const inspected = JSON.parse((await f.invoke(['doctor', '-a', 'codex', '--json'], { which: command => `/fake/${command}` })).output);
  assert.equal(inspected.ok, true, 'legacy schema and available executables remain valid');
  assert.deepEqual(inspected.configurations[0].missingRoleBindings, ['griller', 'merger']);
  assert.ok(inspected.configurations[0].warnings.some(w => /No packaged defaults were merged/.test(w)));
  const config = JSON.parse((await f.invoke(['config', '-a', 'codex', '--json'])).output).configurations[0].config;
  assert.equal(Object.hasOwn(config.roles, 'griller'), false);
  assert.equal(Object.hasOwn(config.roles, 'merger'), false);
  assert.equal(config.roles.backend.model, 'legacy-backend-choice');
  assert.equal(config.docsDir, 'docs/mulit-agent');
  const text = (await f.invoke(['doctor', '-a', 'codex'], { which: command => `/fake/${command}` })).output;
  assert.match(text, /Add them explicitly to routing\.json before using those roles/);
});

test('install --defaults refuses an existing configuration on a later target before writing any target', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'claude-code']);
  const file = path.join(f.base, 'my-agent-defaults.json');
  writeJson(file, defaults);
  const before = snapshot(f.base);
  for (const flags of [[], ['--force']]) {
    await assert.rejects(f.invoke(['install', '-a', 'codex,claude-code', '--defaults', file, ...flags]), /--defaults.*routing\.json already exists:.*Edit the existing configuration directly/);
    assert.deepEqual(snapshot(f.base), before);
  }
});

test('invalid defaults and defaults on other commands fail without filesystem writes', async t => {
  const f = fixture(t);
  const file = path.join(f.base, 'my-agent-defaults.json');
  const invalid = structuredClone(defaults);
  invalid.roles.checker.carrier = 'current';
  for (const [content, expected] of [
    ['{"schemaVersion":', SyntaxError],
    [JSON.stringify(invalid), /roles\.checker\.carrier must remain background/],
  ]) {
    write(file, content);
    const before = snapshot(f.base);
    await assert.rejects(f.invoke(['install', '-a', 'codex,claude-code,cursor,dsh', '--defaults', file]), expected);
    assert.deepEqual(snapshot(f.base), before);
  }
  writeJson(file, defaults);
  const before = snapshot(f.base);
  for (const command of ['update', 'uninstall', 'config', 'doctor']) {
    await assert.rejects(f.invoke([command, '-a', 'codex', '--defaults', file]), /--defaults is only valid with install/);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test('update migrates the old managed defaults resource while preserving the runtime configuration', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex']);
  const legacyFile = 'assets/routing.defaults.json';
  const receiptFile = path.join(f.target(), receiptName);
  const receipt = readJson(receiptFile);
  receipt.version = '0.2.0';
  receipt.files[legacyFile] = receipt.files[defaultsFile];
  delete receipt.files[defaultsFile];
  fs.mkdirSync(path.dirname(path.join(f.target(), legacyFile)), { recursive: true });
  fs.renameSync(path.join(f.target(), defaultsFile), path.join(f.target(), legacyFile));
  writeJson(receiptFile, receipt);
  const routing = path.join(f.target(), 'routing.json');
  const preserved = read(routing) + '\r\n';
  write(routing, preserved);
  await f.invoke(['update', '-a', 'codex']);
  assert.equal(fs.existsSync(path.join(f.target(), legacyFile)), false);
  assert.deepEqual(readJson(path.join(f.target(), defaultsFile)), defaults);
  assert.equal(read(routing), preserved);
  const updated = readJson(receiptFile);
  assert.equal(updated.version, '0.2.1');
  assert.equal(Object.hasOwn(updated.files, legacyFile), false);
  assert.ok(Object.hasOwn(updated.files, defaultsFile));
  const result = await f.invoke(['doctor', '-a', 'codex', '--json'], { which: command => `/fake/${command}` });
  assert.equal(result.status, 0);
});

test('update removes bundled Matt files and empty managed directories without changing external skills or user data', async t => {
  const f = fixture(t);
  const legacy = path.join(f.packageRoot, 'references/matt');
  write(path.join(legacy, 'skills/tdd/PROCEDURE.md'), 'Legacy bundled workflow\n');
  write(path.join(legacy, 'upstream-source.zip'), 'Legacy source archive\n');
  await f.invoke(['install', '-a', 'codex,claude-code']);

  const external = path.join(f.project, '.agents/skills/tdd');
  write(path.join(external, 'SKILL.md'), '---\nname: tdd\ndescription: External test fixture\n---\nEnvironment workflow\n');
  write(path.join(external, 'tests.md'), 'External workflow resource\n');
  const externalBefore = snapshot(external);
  const personal = path.join(f.target('claude-code'), 'references/matt/personal.md');
  write(personal, 'User-owned notes\n');
  const emptyUserDirectory = path.join(f.target(), 'references/user-empty');
  fs.mkdirSync(emptyUserDirectory);
  const preserved = new Map();
  for (const agent of ['codex', 'claude-code']) {
    const routing = path.join(f.target(agent), 'routing.json');
    const config = readJson(routing);
    config.roles.backend.model = `${agent}-personal-model`;
    const bytes = JSON.stringify(config, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
    write(routing, bytes);
    preserved.set(routing, bytes);
  }

  fs.rmSync(legacy, { recursive: true });
  await f.invoke(['update', '-a', 'codex,claude-code']);
  assert.equal(fs.existsSync(path.join(f.target(), 'references/matt')), false);
  assert.equal(fs.existsSync(path.join(f.target('claude-code'), 'references/matt/skills')), false);
  assert.equal(fs.existsSync(path.join(f.target('claude-code'), 'references/matt/upstream-source.zip')), false);
  assert.equal(read(personal), 'User-owned notes\n');
  assert.ok(fs.statSync(emptyUserDirectory).isDirectory());
  for (const [routing, bytes] of preserved) assert.equal(read(routing), bytes);
  assert.deepEqual(snapshot(external), externalBefore);
  for (const agent of ['codex', 'claude-code']) {
    assert.equal(Object.keys(readJson(path.join(f.target(agent), receiptName)).files).some(name => name.startsWith('references/matt/')), false);
  }
});

test('installs only the skill payload, preserves pre-existing rules byte-for-byte after uninstall', async t => {
  const f = fixture(t);
  const rules = path.join(f.project, 'AGENTS.md');
  const original = '# Existing rules\r\nKeep this exact text without a trailing newline.';
  write(rules, original);
  const result = await f.invoke(['install', '-a', 'codex']);
  assert.match(result.output, /packaged tool\/model\/effort combinations are examples/);
  assert.match(result.output, /The secretary must present and archive the effective role\/tool\/model\/effort\/carrier table and obtain user confirmation before starting a new PM/);
  assert.ok(read(rules).startsWith(original));
  assert.match(read(rules), /herdr-mattpocock-skills:codex:begin/);
  assert.ok(fs.existsSync(path.join(f.target(), 'references/routing.md')));
  assert.equal(fs.existsSync(path.join(f.target(), 'bin')), false);
  assert.equal(fs.existsSync(path.join(f.target(), 'package.json')), false);
  assert.deepEqual(readJson(path.join(f.target(), 'routing.json')), defaults);
  await f.invoke(['uninstall', '-a', 'codex']);
  assert.equal(read(rules), original);
  assert.equal(fs.existsSync(f.target()), false);
});

test('an existing empty instructions file survives install and uninstall', async t => {
  const f = fixture(t);
  const rules = path.join(f.project, 'AGENTS.md');
  write(rules, '');
  await f.invoke(['install', '-a', 'codex,dsh']);
  await f.invoke(['uninstall', '-a', 'codex,dsh']);
  assert.equal(read(rules), '');
});

test('updates payload and version while preserving user tool/model/effort configuration', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'claude-code']);
  const configFile = path.join(f.target('claude-code'), 'routing.json');
  const config = readJson(configFile);
  config.roles.frontend = { ...config.roles.frontend, model: 'my-model', effort: 'my-effort' };
  writeJson(configFile, config);
  const preservedBytes = read(configFile);
  writeJson(path.join(f.packageRoot, 'package.json'), { name: 'herdr-mattpocock-skills', version: '0.3.0' });
  write(path.join(f.packageRoot, 'SKILL.md'), 'New skill version\n');
  await f.invoke(['update', '-a', 'claude-code']);
  assert.equal(read(configFile), preservedBytes);
  assert.equal(read(path.join(f.target('claude-code'), 'SKILL.md')), 'New skill version\n');
  assert.equal(readJson(path.join(f.target('claude-code'), receiptName)).version, '0.3.0');
  assert.equal(read(path.join(f.project, 'CLAUDE.md')).split('herdr-mattpocock-skills:claude-code:begin').length - 1, 1);
});

test('modified skill files block update; --force preserves a complete backup', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex']);
  write(path.join(f.target(), 'SKILL.md'), 'User edited skill\n');
  await assert.rejects(f.invoke(['update', '-a', 'codex']), /Modified installed files/);
  assert.equal(read(path.join(f.target(), 'SKILL.md')), 'User edited skill\n');
  const result = await f.invoke(['update', '-a', 'codex', '--force', '--json']);
  const output = JSON.parse(result.output);
  assert.equal(output.backups.length, 1);
  assert.equal(read(path.join(output.backups[0], 'SKILL.md')), 'User edited skill\n');
  assert.match(read(path.join(f.target(), 'SKILL.md')), /Original skill/);
});

test('a new package file cannot silently replace a previously unowned user file', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex']);
  write(path.join(f.target(), 'references/new.md'), 'User reference');
  write(path.join(f.packageRoot, 'references/new.md'), 'New package reference');
  await assert.rejects(f.invoke(['update', '-a', 'codex']), /conflict with unowned files/);
  assert.equal(read(path.join(f.target(), 'references/new.md')), 'User reference');
  const result = JSON.parse((await f.invoke(['update', '-a', 'codex', '--force', '--json'])).output);
  assert.equal(read(path.join(result.backups[0], 'references/new.md')), 'User reference');
  assert.equal(read(path.join(f.target(), 'references/new.md')), 'New package reference');
});

test('foreign same-name directory is never silently replaced or uninstalled', async t => {
  const f = fixture(t);
  write(path.join(f.target(), 'SKILL.md'), 'Existing personal skill\n');
  await assert.rejects(f.invoke(['install', '-a', 'codex']), /not managed/);
  await assert.rejects(f.invoke(['uninstall', '-a', 'codex', '--force']), /unowned/);
  assert.equal(read(path.join(f.target(), 'SKILL.md')), 'Existing personal skill\n');
  const result = JSON.parse((await f.invoke(['install', '-a', 'codex', '--force', '--json'])).output);
  assert.equal(read(path.join(result.backups[0], 'SKILL.md')), 'Existing personal skill\n');
});

test('dry-run does not create project, skill, rules, config, receipts or backups', async t => {
  const f = fixture(t);
  const destination = path.join(f.base, 'not-created');
  const result = await f.invoke(['install', '-a', 'codex,claude-code,cursor,dsh', '--project', destination, '--dry-run', '--json']);
  assert.equal(JSON.parse(result.output).installations.length, 4);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(f.project), []);
});

test('a conflict on a later target leaves all earlier targets untouched', async t => {
  const f = fixture(t);
  write(path.join(f.target('claude-code'), 'SKILL.md'), 'Do not overwrite');
  await assert.rejects(f.invoke(['install', '-a', 'codex,claude-code']), /not managed/);
  assert.equal(fs.existsSync(f.target()), false);
  assert.equal(fs.existsSync(path.join(f.project, 'AGENTS.md')), false);
});

test('Codex and DSH coexist in AGENTS.md; uninstalling one preserves the other entry', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex,dsh']);
  const rules = path.join(f.project, 'AGENTS.md');
  assert.match(read(rules), /herdr-mattpocock-skills:codex:begin/);
  assert.match(read(rules), /herdr-mattpocock-skills:dsh:begin/);
  await f.invoke(['uninstall', '-a', 'codex']);
  assert.doesNotMatch(read(rules), /herdr-mattpocock-skills:codex:begin/);
  assert.match(read(rules), /herdr-mattpocock-skills:dsh:begin/);
  assert.ok(fs.existsSync(f.target('dsh')));
  await f.invoke(['uninstall', '-a', 'dsh']);
  assert.equal(fs.existsSync(rules), false);
});

test('Codex and universal share one payload; removing one alias retains the other', async t => {
  const f = fixture(t);
  const result = JSON.parse((await f.invoke(['install', '-a', 'codex,universal', '--json'])).output);
  assert.equal(result.installations.length, 1);
  await f.invoke(['uninstall', '-a', 'codex']);
  assert.ok(fs.existsSync(path.join(f.target(), 'SKILL.md')));
  assert.deepEqual(readJson(path.join(f.target(), receiptName)).agents, ['universal']);
  await f.invoke(['uninstall', '-a', 'universal']);
  assert.equal(fs.existsSync(f.target()), false);
});

test('uninstall preserves unrelated files and edited routing.json', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex']);
  write(path.join(f.target(), 'my-notes.txt'), 'Keep my notes');
  const config = readJson(path.join(f.target(), 'routing.json'));
  config.roles.checker.effort = 'custom';
  writeJson(path.join(f.target(), 'routing.json'), config);
  await f.invoke(['uninstall', '-a', 'codex']);
  assert.equal(read(path.join(f.target(), 'my-notes.txt')), 'Keep my notes');
  assert.equal(readJson(path.join(f.target(), 'routing.json')).roles.checker.effort, 'custom');
  assert.equal(fs.existsSync(path.join(f.target(), 'SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(f.target(), receiptName)), false);
});

test('edited routing entry blocks uninstall unless backed up explicitly', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex']);
  const rules = path.join(f.project, 'AGENTS.md');
  write(rules, read(rules).replace('before acting', 'when I choose'));
  const edited = read(rules);
  await assert.rejects(f.invoke(['uninstall', '-a', 'codex']), /Routing entry was changed/);
  assert.ok(fs.existsSync(path.join(f.target(), 'SKILL.md')));
  const result = JSON.parse((await f.invoke(['uninstall', '-a', 'codex', '--force', '--json'])).output);
  const ruleBackup = result.backups.find(file => file.startsWith(rules + '.backup-'));
  assert.equal(read(ruleBackup), edited);
  assert.equal(fs.existsSync(rules), false);
});

test('forcing an edited Cursor block does not duplicate its frontmatter or separators', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'cursor']);
  const rules = path.join(f.project, '.cursor/rules/herdr-mattpocock-skills.mdc');
  const original = read(rules);
  write(rules, original.replace('before acting', 'when I choose'));
  await assert.rejects(f.invoke(['update', '-a', 'cursor']), /Routing entry was changed/);
  await f.invoke(['update', '-a', 'cursor', '--force']);
  assert.equal(read(rules), original);
  await f.invoke(['uninstall', '-a', 'cursor']);
  assert.equal(fs.existsSync(rules), false);
});

test('literal JavaScript replacement tokens in destination paths survive update and uninstall', async t => {
  const f = fixture(t);
  const destination = path.join(f.base, "skills-$&-$`-$'-$$");
  const rules = path.join(f.project, 'AGENTS.md');
  const original = '# User rules\nKeep these bytes.\n';
  write(rules, original);
  const args = ['-a', 'codex', '--dir', destination];
  await f.invoke(['install', ...args]);
  const installed = read(rules);
  await f.invoke(['update', ...args]);
  await f.invoke(['update', ...args, '--force']);
  assert.equal(read(rules), installed);
  assert.equal(read(rules).split('herdr-mattpocock-skills:codex:begin').length - 1, 1);
  await f.invoke(['uninstall', ...args]);
  assert.equal(read(rules), original);
});

test('Cursor requires a real top-level boolean in the first frontmatter on install and update', async t => {
  const f = fixture(t);
  const rules = path.join(f.project, '.cursor/rules/herdr-mattpocock-skills.mdc');
  const invalid = [
    '---\nalwaysApply: false\n# alwaysApply: true\n---\n',
    '---\nalwaysApply: false\n---\nalwaysApply: true\n---\n',
    '---\nmetadata:\n  alwaysApply: true\n---\n',
    '---\nalwaysApply: "true"\n---\n',
    '---\nalwaysApply: false\nalwaysApply: true\n---\n',
    '---\n"alwaysApply": false\nalwaysApply: true\n---\n',
    '---\nalwaysApply: true\nalwaysApply: true\n---\n',
    '---\nalwaysApply:true\n---\n',
    '---\ndescription: "open string\nalwaysApply: true\nglobs: "\n---\n',
  ];
  for (const header of invalid) {
    write(rules, header + '# Personal instructions\n');
    await assert.rejects(f.invoke(['install', '-a', 'cursor']), /top-level boolean alwaysApply/);
    assert.equal(read(rules), header + '# Personal instructions\n');
    assert.equal(fs.existsSync(f.target('cursor')), false);
  }
  const valid = '---\ndescription: "Personal rules"\n"alwaysApply": true # Boolean, not a string\n---\n';
  write(rules, valid + '# Personal instructions\n');
  await f.invoke(['install', '-a', 'cursor']);
  const installed = read(rules);
  const receipt = read(path.join(f.target('cursor'), receiptName));
  for (const header of invalid) {
    const changed = header + installed.slice(valid.length);
    write(rules, changed);
    for (const flags of [[], ['--force']]) {
      await assert.rejects(f.invoke(['update', '-a', 'cursor', ...flags]), /top-level boolean alwaysApply/);
      assert.equal(read(rules), changed);
      assert.equal(read(path.join(f.target('cursor'), receiptName)), receipt);
    }
  }
  write(rules, installed);
  await f.invoke(['uninstall', '-a', 'cursor']);
  assert.equal(read(rules), valid + '# Personal instructions\n');
});

test('uninstall restores the full installation when removing its routing file is denied', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex']);
  const rules = path.join(f.project, 'AGENTS.md');
  const before = snapshot(f.project);
  const restore = failRenameOnce(t, from => from === rules);
  await assert.rejects(f.invoke(['uninstall', '-a', 'codex']), /Injected EACCES.*state restored/);
  restore();
  assert.deepEqual(snapshot(f.project), before);
  await f.invoke(['uninstall', '-a', 'codex']);
  assert.equal(fs.existsSync(f.target()), false);
  assert.equal(fs.existsSync(rules), false);
});

test('a later target swap failure rolls back earlier install and update targets', async t => {
  for (const command of ['install', 'update']) await t.test(command, async t => {
    const f = fixture(t);
    write(path.join(f.project, 'AGENTS.md'), '# Existing main instructions\n');
    write(path.join(f.project, 'CLAUDE.md'), '# Existing Claude instructions\n');
    if (command === 'update') {
      await f.invoke(['install', '-a', 'codex,claude-code']);
      write(path.join(f.packageRoot, 'SKILL.md'), 'Updated package content\n');
    }
    const before = snapshot(f.project);
    const restore = failRenameOnce(t, (from, to) => to === f.target('claude-code') && from.includes('.tmp-'));
    await assert.rejects(f.invoke([command, '-a', 'codex,claude-code']), /Injected EACCES.*state restored/);
    restore();
    assert.deepEqual(snapshot(f.project), before);
    await f.invoke([command, '-a', 'codex,claude-code']);
  });
});

test('a later rule swap failure rolls back earlier rules, installations and receipts', async t => {
  for (const command of ['install', 'uninstall']) await t.test(command, async t => {
    const f = fixture(t);
    const claudeRules = path.join(f.project, 'CLAUDE.md');
    write(path.join(f.project, 'AGENTS.md'), '# Existing main instructions\n');
    write(claudeRules, '# Existing Claude instructions\n');
    if (command === 'uninstall') await f.invoke(['install', '-a', 'codex,claude-code']);
    const before = snapshot(f.project);
    const restore = failRenameOnce(t, (from, to) => to === claudeRules && from.includes('.tmp-'));
    await assert.rejects(f.invoke([command, '-a', 'codex,claude-code']), /Injected EACCES.*state restored/);
    restore();
    assert.deepEqual(snapshot(f.project), before);
    await f.invoke([command, '-a', 'codex,claude-code']);
  });
});

test('rejects symlink destinations and symlinks inside managed installations', async t => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.project, '.agents'), 'dir');
  await assert.rejects(f.invoke(['install', '-a', 'codex']), /symbolic-link/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(f.project, '.agents'));
  await f.invoke(['install', '-a', 'codex']);
  fs.symlinkSync(outside, path.join(f.target(), 'foreign'), 'dir');
  await assert.rejects(f.invoke(['uninstall', '-a', 'codex', '--force']), /symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('rejects malicious receipt traversal before touching files', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex']);
  const protectedFile = path.join(f.project, 'protected.txt');
  write(protectedFile, 'Keep me');
  const file = path.join(f.target(), receiptName);
  const receipt = readJson(file);
  receipt.files['../../../protected.txt'] = '0'.repeat(64);
  writeJson(file, receipt);
  await assert.rejects(f.invoke(['uninstall', '-a', 'codex', '--force']), /Invalid managed path/);
  assert.equal(read(protectedFile), 'Keep me');
});

test('receipt activation cannot redirect deletion to another file', async t => {
  const f = fixture(t);
  await f.invoke(['install', '-a', 'codex']);
  const protectedFile = path.join(f.project, 'protected.txt');
  write(protectedFile, 'Keep me');
  const file = path.join(f.target(), receiptName);
  const receipt = readJson(file);
  receipt.activations[0].path = protectedFile;
  writeJson(file, receipt);
  await assert.rejects(f.invoke(['uninstall', '-a', 'codex', '--force']), /Activation path/);
  assert.equal(read(protectedFile), 'Keep me');
});

test('global DSH_HOME and Cursor always-loaded rules use their verified locations', async t => {
  const f = fixture(t);
  const dshHome = path.join(f.base, 'custom-dsh');
  await f.invoke(['install', '-a', 'dsh,cursor', '--global'], { env: { PATH: '', DSH_HOME: dshHome } });
  assert.ok(fs.existsSync(path.join(dshHome, 'skills/herdr-mattpocock-skills/routing.json')));
  assert.match(read(path.join(dshHome, 'AGENTS.md')), /herdr-mattpocock-skills:dsh:begin/);
  assert.match(read(path.join(f.home, '.cursor/rules/herdr-mattpocock-skills.mdc')), /alwaysApply: true/);
  assert.ok(fs.existsSync(path.join(f.home, '.cursor/skills/herdr-mattpocock-skills/SKILL.md')));
  assert.equal(fs.existsSync(path.join(f.project, 'AGENTS.md')), false);
});

test('global Codex instructions respect CODEX_HOME while skills use the shared directory', async t => {
  const f = fixture(t);
  const codexHome = path.join(f.base, 'custom-codex');
  const overrides = { env: { PATH: '', CODEX_HOME: codexHome } };
  await f.invoke(['install', '-a', 'codex', '--global'], overrides);
  assert.match(read(path.join(codexHome, 'AGENTS.md')), /herdr-mattpocock-skills:codex:begin/);
  assert.ok(fs.existsSync(path.join(f.home, '.agents/skills/herdr-mattpocock-skills/SKILL.md')));
  assert.equal(fs.existsSync(path.join(f.home, '.codex')), false);
  await f.invoke(['uninstall', '-a', 'codex', '--global'], overrides);
  assert.equal(fs.existsSync(path.join(codexHome, 'AGENTS.md')), false);
});

test('no-activate and custom directory install without modifying project instructions', async t => {
  const f = fixture(t);
  const destination = path.join(f.base, 'custom skills');
  await f.invoke(['install', '--dir', destination, '--no-activate']);
  assert.ok(fs.existsSync(path.join(destination, 'herdr-mattpocock-skills/SKILL.md')));
  assert.equal(fs.existsSync(path.join(f.project, 'AGENTS.md')), false);
  await f.invoke(['uninstall', '--dir', destination]);
  assert.equal(fs.existsSync(path.join(destination, 'herdr-mattpocock-skills')), false);
});

test('doctor validates custom models and reports executable availability without invoking agents', async t => {
  const f = fixture(t);
  const file = path.join(f.packageRoot, defaultsFile);
  const commands = [];
  const result = await f.invoke(['doctor', '--config', file, '--json'], { which: command => { commands.push(command); return `/fake/${command}`; } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.output).ok, true);
  assert.ok(commands.includes('herdr'));
  const optional = await f.invoke(['doctor', '--config', file, '--json'], { which: command => command === 'agent' ? null : `/fake/${command}` });
  assert.equal(optional.status, 0, 'an unused optional tool must not make configured roles fail doctor');
  assert.equal(JSON.parse(optional.output).configurations[0].tools.find(tool => tool.name === 'cursor').required, false);
  const missing = await f.invoke(['doctor', '--config', file, '--json'], { which: () => null });
  assert.equal(missing.status, 1);
  const config = readJson(file);
  config.roles.backend.tool = 'missing-tool';
  writeJson(file, config);
  await assert.rejects(f.invoke(['doctor', '--config', file]), /does not name a configured tool/);
});

test('doctor reports native bindings for verification and permits independently configured anonymous roles', async t => {
  const f = fixture(t);
  const file = path.join(f.base, 'custom-routing.json');
  const config = structuredClone(defaults);
  config.docsDir = 'my-custom/archive';
  config.roles.pm = { ...config.roles.pm, tool: 'cursor', model: 'custom-pm', effort: 'custom-pm-effort' };
  for (const carrier of ['current', 'herdr', 'background', 'native']) {
    config.roles.searcher.carrier = carrier;
    writeJson(file, config);
    const before = snapshot(f.base);
    const { status, output } = await f.invoke(['doctor', '--config', file, '--json'], { which: command => `/fake/${command}` });
    const report = JSON.parse(output);
    assert.equal(status, 0);
    assert.deepEqual(report.configurations[0].nativeBindingsNeedVerification, carrier === 'native' ? ['searcher', 'merger'] : ['merger']);
    assert.ok(report.configurations[0].effectiveDefaultsNeedConfirmation.includes('merger'));
    assert.equal(report.configurations[0].tools.find(tool => tool.name === 'cursor').required, true);
    assert.deepEqual(report.configurations[0].missingRoleBindings, []);
    assert.deepEqual(report.configurations[0].warnings, []);
    assert.match(report.note, /does not.*verify login or native-carrier compatibility/);
    assert.deepEqual(snapshot(f.base), before);
  }
  for (const carrier of ['background', 'native']) {
    config.roles.merger = { tool: 'dsh', model: 'custom-merger', effort: 'custom-merge-effort', carrier };
    writeJson(file, config);
    const { status } = await f.invoke(['doctor', '--config', file, '--json'], { which: command => `/fake/${command}` });
    assert.equal(status, 0);
  }
  const text = (await f.invoke(['doctor', '--config', file], { which: command => `/fake/${command}` })).output;
  assert.match(text, /Verify matching native tool\/model\/effort before use: searcher, merger/);
});

test('invalid native carriers and ambiguous inheritance are rejected before any installation changes', async t => {
  const f = fixture(t);
  const file = path.join(f.base, 'custom-routing.json');
  const cases = [
    ['griller', { ...defaults.roles.griller, carrier: 'background' }, /roles\.griller\.carrier must be herdr/],
    ['backend', { ...defaults.roles.backend, carrier: 'native' }, /only searcher and merger support it/],
    ['pm', { ...defaults.roles.pm, carrier: 'native' }, /only searcher and merger support it/],
    ['reviewer', { ...defaults.roles.reviewer, carrier: 'native' }, /roles\.reviewer\.carrier must remain background/],
    ['checker', { ...defaults.roles.checker, carrier: 'native' }, /roles\.checker\.carrier must remain background/],
    ['searcher', { ...defaults.roles.searcher, carrier: 'unsupported' }, /roles\.searcher\.carrier must be/],
    ['searcher', { inheritRole: 'pm', carrier: 'native' }, /inheritRole is only supported for roles\.merger/],
    ['merger', { inheritRole: 'secretary', carrier: 'native' }, /inheritRole must be pm/],
    ['merger', { inheritRole: 'pm', model: 'ambiguous', carrier: 'native' }, /not both/],
    ['merger', { inheritRole: 'pm', carrier: 'herdr' }, /roles\.merger\.carrier must be native or background/],
    ['merger', { tool: 'codex', effort: 'default', carrier: 'background' }, /nonempty model and effort/],
    ['merger', null, /roles\.merger must be an object/],
  ];
  for (const [role, binding, expected] of cases) {
    const config = structuredClone(defaults);
    config.roles[role] = binding;
    writeJson(file, config);
    const before = snapshot(f.base);
    await assert.rejects(f.invoke(['install', '-a', 'codex,claude-code,cursor,dsh', '--defaults', file]), expected);
    assert.deepEqual(snapshot(f.base), before);
  }
});

test('unknown options, missing target and incompatible scopes fail without writes', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke(['install', '-a', 'codex', '--surprise']), /Unknown argument/);
  await assert.rejects(f.invoke(['install']), /Specify --agent/);
  await assert.rejects(f.invoke(['install', '-a', 'codex', '--global', '--project', f.project]), /cannot be combined/);
  await assert.rejects(f.invoke(['install', '-a', 'codex', '--project', '-g']), /Missing value/);
  await assert.rejects(f.invoke(['install', '-a', 'not-a-tool']), /Unknown agent/);
  assert.deepEqual(fs.readdirSync(f.project), []);
});

test('uninstall dry-run preserves installation and rules, and update needs an existing receipt', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke(['update', '-a', 'codex']), /requires a managed installation/);
  await f.invoke(['install', '-a', 'codex']);
  const before = read(path.join(f.project, 'AGENTS.md'));
  await f.invoke(['uninstall', '-a', 'codex', '--dry-run']);
  assert.equal(read(path.join(f.project, 'AGENTS.md')), before);
  assert.ok(fs.existsSync(path.join(f.target(), 'SKILL.md')));
});
