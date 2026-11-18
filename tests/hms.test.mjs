import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executionMetadata, makeSnapshot, renderPatch } from '../skills/herdr-mattpocock-skills/scripts/hms.mjs';
import { commandProblems } from '../skills/herdr-mattpocock-skills/scripts/routing.mjs';

const skillsDir = fileURLToPath(new URL('../skills/', import.meta.url));
const hms = path.join(skillsDir, 'herdr-mattpocock-skills/scripts/hms.mjs');
const header = '| 会话 ID | Agent 工具 | 实际模型 | 思考等级 |';
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);

function fixture(t, { tool = {}, role = {}, output, fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  const agent = path.join(dir, 'agent.mjs');
  fs.writeFileSync(agent, output ?? `console.log(JSON.stringify({type:'thread.started',thread_id:'anonymous-session'}));
    console.log(JSON.stringify({type:'turn_context',payload:{model:'actual-model',effort:'high'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.argv.at(-1)}}));
    process.exit(${fail ? 7 : 0});`);
  const calls = path.join(dir, 'herdr-calls.jsonl');
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
    import fs from 'node:fs';
    const a = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a)+'\\n');
    let result = {};
    if (a[0] === 'agent' && a[1] === 'list') result = {agents:[{pane_id:'w1:parent'},{pane_id:'w1:other'}]};
    if (a[0] === 'pane' && a[1] === 'process-info' && a[3] === 'w1:parent') result = {process_info:{shell_pid:process.ppid}};
    if (a[0] === 'pane' && a[1] === 'run' && process.env.HMS_TEST_FAIL_START) process.exit(1);
    if (a[0] === 'agent' && a[1] === 'get') {
      if (a[2] !== 'w1:child' && a[2] !== 'w1:parent') process.exit(1);
      if (a[2] === 'w1:child' && process.env.HMS_TEST_FAIL_START) process.exit(1);
      const child = a[2] === 'w1:child';
      result = {agent:{agent:child ? 'mock' : 'codex',agent_status:'idle',pane_id:a[2],agent_session:{value:child ? 'visible-session' : 'main-session'},
        agent_model:{value:child ? 'observed-model' : 'host-model'},agent_effort:{value:child ? 'high' : 'max'}}};
    }
    if (a[0] === 'pane' && a[1] === 'split') result = {pane:{pane_id:'w1:child'}};
    if (a[0] === 'tab' && a[1] === 'create') result = {root_pane:'w1:child',tab:{tab_id:'w1:tab'}};
    console.log(JSON.stringify({result}));`, { mode: 0o755 });
  const config = path.join(project, '.agents/herdr/routing.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({
    active: true, defaultMode: 'complex', docsDir: 'legacy-session', runDir: 'legacy-runtime',
    tools: { mock: { interactive: [process.execPath, agent, '{model}', '{effort}'], headless: [process.execPath, agent, '{model}', '{effort}', '{prompt}'],
      model: ['--model', '{value}'], effort: ['--effort', '{value}'], metadata: 'codex', ...tool } },
    roles: {
      secretary: { tool: 'current', model: 'inherit', effort: 'inherit', carrier: 'current' },
      searcher: { tool: 'mock', model: 'requested-alias', effort: 'max', carrier: 'background', ...role },
      frontend: { tool: 'mock', model: 'requested-alias', effort: 'max', carrier: 'herdr', place: 'tab' },
      pm: { tool: 'mock', model: 'requested-alias', effort: 'max', carrier: 'herdr' },
    },
  }));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HERDR_ENV: '1',
    HERDR_PANE_ID: 'w1:other', HERDR_WORKSPACE_ID: 'w1', CODEX_THREAD_ID: 'main-session' };
  const command = args => [hms, ...args, '--project', project];
  const run = (args, expected = 0) => {
    const res = spawnSync(process.execPath, command(args), { cwd: project, env, encoding: 'utf8' });
    assert.equal(res.status, expected, res.stderr || res.stdout);
    return expected === 0 || res.stdout ? JSON.parse(res.stdout) : res;
  };
  const init = (extra = []) => run(['init', '--title', '排障信息',
    '--host', 'codex', '--host-model', 'host-model', '--host-effort', 'max', '--session-id', 'main-session', ...extra]);
  const team = (extra = []) => init(['--mode', 'complex', ...extra]);
  const read = r => fs.readFileSync(r.record, 'utf8');
  const sent = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, project, agent, config, calls, env, command, run, init, team, read, sent };
}

test('每轮团队只有一份四列表格，确认与参数预览沿用此表', t => {
  const f = fixture(t);
  const r = f.team();
  assert.match(path.basename(r.record), /^\d{8}-\d{6}-排障信息\.md$/);
  assert.equal(path.dirname(r.record), path.join(f.project, '.agents/herdr'));
  assert.equal(f.read(r), `${header}\n| --- | --- | --- | --- |\n| main-session | codex | host-model | max |\n`);
  const confirmed = f.run(['record', 'confirm', '--context', r.context, '--confirmed', '同意当前配置']);
  assert.equal(confirmed.record, r.record);
  assert.equal(JSON.parse(Buffer.from(confirmed.context, 'base64url')).confirmed, true);
  f.run(['argv', 'searcher', '--context', confirmed.context, '--headless']);
  assert.deepEqual(files(f.project), [r.record, f.config]);
});

test('显式面板通过 Herdr 直接收到原文并登记原生 ID，不用派工文件', t => {
  const f = fixture(t);
  const r = f.team(['--confirmed', '同意当前配置']);
  const body = "核实入口\n包含 '引号'、`代码` 和 $(这不是命令)";
  const result = f.run(['spawn', 'frontend', '--context', r.context, '--name', 'fresh-worker', '--task', '781', '--prompt', body]);
  assert.equal(result.sessionId, 'visible-session');
  assert.ok(f.sent().some(c => c[0] === 'tab' && c[1] === 'create'));
  const dispatched = f.sent().find(c => c[0] === 'agent' && c[1] === 'prompt');
  assert.ok(dispatched[3].endsWith(body));
  assert.ok(dispatched[3].includes(`--context ${r.context}`));
  assert.match(dispatched[3], /纯前端票由你主责/);
  assert.doesNotMatch(dispatched[3], /roles\/frontend\.md/);
  assert.ok(!dispatched[3].includes('读取派工文件'));
  assert.ok(f.read(r).includes('| visible-session | mock | observed-model | high |'));
  assert.deepEqual(files(f.project), [r.record, f.config]);
});

test('匿名成功与失败调用都登记，输出直接返回并保留退出码', t => {
  for (const fail of [false, true]) {
    const f = fixture(t, { fail });
    const r = f.team();
    const body = "报告结论直接返回\n保留 '原文'";
    const result = f.run(['run', 'searcher', '--context', r.context, '--task', 'research', '--prompt', body], fail ? 7 : 0);
    assert.equal(result.exit, fail ? 7 : 0);
    assert.ok(result.stdout.includes('anonymous-session'));
    const events = result.stdout.trim().split('\n').map(JSON.parse);
    const prompt = events.at(-1).item.text;
    assert.ok(prompt.endsWith(body));
    assert.match(prompt, /承担搜索、代码探索或 research/);
    assert.doesNotMatch(prompt, /roles\/searcher\.md/);
    assert.ok(f.read(r).includes('| anonymous-session | mock | actual-model | high |'));
    assert.deepEqual(files(f.project), [r.record, f.config]);
  }
});

test('PM 保留配置确认边界，显式启动失败同样登记', t => {
  const f = fixture(t);
  const r = f.team();
  f.run(['spawn', 'pm', '--context', r.context, '--name', 'new-pm', '--task', 'implement', '--prompt', '执行已批准任务'], 1);
  assert.ok(!f.sent().some(c => c[0] === 'pane' && c[1] === 'split'));
  const confirmed = f.run(['record', 'confirm', '--context', r.context, '--confirmed', '同意当前配置']);
  f.env.HMS_TEST_FAIL_START = '1';
  f.run(['spawn', 'pm', '--context', confirmed.context, '--name', 'new-pm', '--task', 'implement', '--prompt', '执行已批准任务'], 1);
  assert.ok(f.read(r).includes('| 未取得 | mock | 未核实 | 未核实 |'));
  assert.deepEqual(files(f.project), [r.record, f.config]);
});

test('Claude 原生结果记录实际模型映射，未核实的 effort 不冒充实际值', t => {
  const f = fixture(t, { tool: { metadata: 'claude-code' }, output: `console.log(JSON.stringify({type:'result',session_id:'claude-session',result:'ok',modelUsage:{'deepseek-v4.1-flash':{}}}));` });
  const r = f.team();
  f.run(['run', 'searcher', '--context', r.context, '--task', 'claude', '--prompt', '只读']);
  assert.ok(f.read(r).includes('| claude-session | mock | deepseek-v4.1-flash | 未核实 |'));
});

test('没有启动成功的 CLI 也登记，不把预设 UUID 或面板 ID 冒充原生 ID', t => {
  const f = fixture(t, { tool: { headless: ['/nonexistent/hms-agent', '--session-id', '{sessionId}', '{model}', '{effort}', '{prompt}'] } });
  const r = f.team();
  const result = f.run(['run', 'searcher', '--context', r.context, '--task', 'missing', '--prompt', '只读'], 1);
  assert.equal(result.sessionId, null);
  assert.ok(f.read(r).includes('| 未取得 | mock | 未核实 | 未核实 |'));
  assert.deepEqual(files(f.project), [r.record, f.config]);
});

test('原生与直接 CLI 可以补登记在同一表里，不创建另一轮记录', t => {
  const f = fixture(t);
  const r = f.team();
  f.run(['record', 'add', '--context', r.context, '--tool', 'codex', '--session-id', 'native-session', '--model', 'native-model', '--effort', 'high']);
  assert.equal(f.run(['record', 'add', '--record', r.record, '--tool', 'dsh']).added, false);
  f.run(['record', 'add', '--mode', 'complex', '--record', r.record, '--tool', 'dsh']);
  assert.ok(f.read(r).includes('| native-session | codex | native-model | high |'));
  assert.ok(f.read(r).includes('| 未取得 | dsh | 未核实 | 未核实 |'));
  assert.deepEqual(files(f.project), [r.record, f.config]);
});

test('派工补发、回报与关闭全部直接走 Herdr，不创建 inbox 或回执', t => {
  const f = fixture(t);
  f.init();
  f.run(['prompt', 'w1:child', '--prompt', '继续核实，不另写报告']);
  const address = 'hms:' + Buffer.from(JSON.stringify({ pane: 'w1:parent', task: '780' })).toString('base64url');
  f.run(['notify', '--to', address, '--task', '780', '--role', 'wayfinder', '--status', 'completed', '--summary', '已确认，直接回报']);
  assert.match(f.run(['notify', '--to', address, '--task', '781', '--role', 'wayfinder', '--status', 'completed', '--summary', '错票'], 1).stderr, /不符/);
  f.run(['close', 'w1:child', '--takeover']);
  const prompts = f.sent().filter(c => c[0] === 'agent' && c[1] === 'prompt');
  assert.equal(prompts[0][3], '继续核实，不另写报告');
  assert.equal(prompts[1][3], 'HERDR_RESULT task=780 status=completed role=wayfinder summary=已确认，直接回报');
  assert.deepEqual(files(f.project), [f.config]);
});

test('回报无法送达时明确失败，不创建回执或擅自关闭子会话', t => {
  const f = fixture(t);
  f.init();
  const result = f.run(['notify', '--to', 'missing-parent', '--task', '780', '--role', 'wayfinder', '--status', 'completed', '--summary', '结果正文'], 1);
  assert.match(result.stderr, /未送达/);
  assert.ok(!f.sent().some(c => c[0] === 'pane' && c[1] === 'close'));
  assert.deepEqual(files(f.project), [f.config]);
});

test('并行调用只追加同一表，跨 worktree 仍使用父任务记录', async t => {
  const f = fixture(t, { output: `console.log(JSON.stringify({type:'thread.started',thread_id:process.argv.at(-1).match(/任务-(\\d+)/)[0]}));` });
  const r = f.team();
  const worktree = path.join(f.dir, 'worktree');
  fs.mkdirSync(worktree);
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, f.command(['run', 'searcher', '--context', r.context, '--task', `task-${i}`, '--prompt', `任务-${i}`, '--cwd', worktree]), { cwd: worktree, env: f.env });
    let err = '';
    child.stdout.resume();
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
  })));
  assert.equal(f.read(r).trim().split('\n').length, 11);
  for (let i = 0; i < 8; i++) assert.ok(f.read(r).includes(`| 任务-${i} |`));
  assert.deepEqual(files(f.project), [r.record, f.config]);
  assert.deepEqual(files(worktree), []);
});

test('旧文件通信参数及没有 context 的派工会失败，不创建文件或窗口', t => {
  const f = fixture(t);
  for (const flag of ['write', 'snapshot', 'brief', 'out', 'inbox', 'file']) {
    f.run(['resolve', `--${flag}`, path.join(f.project, 'unexpected.md')], 1);
  }
  f.run(['run', 'searcher', '--task', 'research', '--prompt', '只读'], 1);
  assert.deepEqual(files(f.project), [f.config]);
  assert.deepEqual(f.sent(), []);
});

test('DSH 无头与交互命令均能读取本次启动的补丁，简单模式只保留路由配置', t => {
  const f = fixture(t, { tool: { interactive: [process.execPath, '', '{patch}'], headless: [process.execPath, '', '{patch}', '{prompt}'], patch: {
    flag: '--patch', template: 'provider: {provider}\nmodel: {modelId}\neffort: {effortValue}\n',
  } }, role: { model: 'provider/actual-model' }, output: `import fs from 'node:fs';
    const patch = fs.readFileSync(process.argv[process.argv.indexOf('--patch')+1], 'utf8');
    console.log(JSON.stringify({type:'result',session_id:'dsh-session',result:patch}));` });
  const config = JSON.parse(fs.readFileSync(f.config));
  config.tools.mock.headless[1] = f.agent;
  config.tools.mock.interactive[1] = f.agent;
  for (const role of Object.values(config.roles)) if (role.tool === 'mock') role.model = 'provider/actual-model';
  fs.writeFileSync(f.config, JSON.stringify(config));
  const r = f.init();
  const result = f.run(['run', 'searcher', '--context', r.context, '--task', 'patch', '--prompt', '只读']);
  assert.equal(JSON.parse(result.stdout).result, 'provider: provider\nmodel: actual-model\neffort: max\n');
  const preview = f.run(['argv', 'frontend', '--context', r.context]);
  const interactive = spawnSync(preview.argv[0], preview.argv.slice(1), { encoding: 'utf8' });
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.equal(JSON.parse(interactive.stdout).result, 'provider: provider\nmodel: actual-model\neffort: max\n');
  assert.deepEqual(files(f.project), [f.config]);
});

test('只读取原生元数据，不从模型回答中猜测会话和模型', () => {
  assert.deepEqual(executionMetadata(JSON.stringify({ type: 'item.completed', item: { text: 'model: invented\nsession id: invented' } })), {});
  assert.deepEqual(executionMetadata('', 'model: observed\nreasoning effort: high\nsession id: actual-id\n'), {
    model: 'observed', effort: 'high', sessionId: 'actual-id',
  });
});

test('只换 CLI 取项目唯一具体型号，有歧义或无型号就要求补选', () => {
  const tools = { a: {}, b: { aliases: ['bee'] } };
  const roles = { frontend: { tool: 'a', model: 'old' }, reviewer: { tool: 'b', model: 'new' } };
  const options = { sets: ['frontend.tool=bee'] };
  assert.equal(makeSnapshot({ tools, roles }, options).roles.frontend.model, 'new');
  const ambiguous = { ...roles, designer: { tool: 'b', model: 'other' } };
  assert.throws(() => makeSnapshot({ tools, roles: ambiguous }, options), /请用户选一次型号/);
  assert.throws(() => makeSnapshot({ tools, roles: { frontend: roles.frontend } }, options), /项目尚无候选/);
  assert.equal(makeSnapshot({ tools, roles: ambiguous }, { sets: [...options.sets, 'frontend.model=default'] }).roles.frontend.model, 'default');
});

test('简单模式的显式、无头、原生调用和补登记均不写成员表', t => {
  const f = fixture(t);
  const simple = f.init(['--set', 'reviewer.tool=codex', '--set', 'reviewer.model=host-model', '--set', 'reviewer.carrier=native']);
  const task = ['--context', simple.context, '--task', 'simple', '--prompt', '直接返回'];
  assert.equal(simple.record, null);
  assert.equal(f.run(['spawn', 'frontend', ...task]).sessionId, 'visible-session');
  assert.equal(f.run(['run', 'searcher', ...task]).sessionId, 'anonymous-session');
  assert.equal(f.run(['native', 'reviewer', '--caller', 'codex', ...task]).record, null);
  assert.equal(f.run(['record', 'add', '--context', simple.context, '--tool', 'codex', '--session-id', 'native-session']).added, false);
  assert.equal(f.run(['record', 'init', '--context', simple.context]).context, simple.context);
  assert.deepEqual(files(f.project), [f.config]);
});

test('转团队时首次建表，保留临时配置，重试升级复用本团队的表', t => {
  const f = fixture(t);
  const simple = f.init(['--set', 'frontend.effort=high']);
  const panel = f.run(['spawn', 'frontend', '--context', simple.context, '--task', 'before-team', '--prompt', '前端任务']);
  const promote = ['--context', simple.context, '--mode', 'complex'];
  f.run(['resolve', ...promote, '--json']);
  assert.deepEqual(files(f.project), [f.config]);
  const team = f.run(['record', 'update', ...promote]);
  assert.equal(f.run(['record', 'update', ...promote]).record, team.record);
  const snap = JSON.parse(Buffer.from(team.context, 'base64url'));
  assert.equal(team.confirmed, false);
  assert.equal(snap.roleConfig.frontend.effort, 'high');
  assert.deepEqual(snap.previousPanels.frontend, [panel.name]);
  assert.equal(f.run(['record', 'confirm', '--context', team.context, '--on', 'frontend', '--confirmed', '纯前端']).record, team.record);
  assert.match(f.run(['record', 'confirm', '--context', team.context, '--on', 'backend', '--confirmed', '跨端'], 1).stderr, /需要 backend/);
  assert.equal(f.read(team), `${header}\n| --- | --- | --- | --- |\n| main-session | codex | host-model | max |\n`);
  assert.deepEqual(files(f.project), [team.record, f.config]);
});

test('旧简单 context 停止追加历史表，转团队另起一表', t => {
  const f = fixture(t);
  const old = JSON.parse(Buffer.from(f.init().context, 'base64url'));
  delete old.roundId;
  delete old.title;
  old.schemaVersion = 5;
  old.record = path.join(path.dirname(f.config), '20261118-000000-旧任务.md');
  const history = `${header}\n| --- | --- | --- | --- |\n| old-frontend | claude | 实际型号 | high |\n`;
  fs.writeFileSync(old.record, history);
  const args = ['--context', Buffer.from(JSON.stringify(old)).toString('base64url'), '--record', old.record];
  assert.equal(f.run(['record', 'add', ...args, '--tool', 'codex']).added, false);
  assert.equal(f.run(['run', 'searcher', ...args, '--task', 'legacy', '--prompt', '直接返回']).record, null);
  const team = f.run(['record', 'update', ...args, '--mode', 'complex']);
  assert.notEqual(team.record, old.record);
  assert.ok(!f.read(team).includes('old-frontend'));
  assert.equal(fs.readFileSync(old.record, 'utf8'), history);
});

test('dst 的等级覆盖保留默认路由，完整型号作为结构化配置传递', () => {
  const { tools } = JSON.parse(fs.readFileSync(path.join(skillsDir, 'herdr-setup/templates/routing.json')));
  const effortOnly = { model: 'default', effort: 'high' };
  assert.deepEqual(commandProblems(tools.dsh, 'interactive', effortOnly), []);
  const patch = JSON.parse(renderPatch(tools.dsh, effortOnly));
  assert.deepEqual(patch[0].insert[0].config, { reasoningEffort: 'high' });
  const role = { model: 'project/model:b', effort: 'high' };
  assert.deepEqual(JSON.parse(renderPatch(tools.dsh, role, 'headless')), [
    { id: 'agent-default-model', config: { provider: 'project', model: 'model:b', reasoningEffort: 'high' } },
  ]);
  assert.ok(commandProblems(tools.dsh, 'interactive', { ...role, model: 'no-provider' }).length);
});

test('agy 只登记根 conversation_id，普通文本 CLI 的回答不作为身份凭证', () => {
  const printed = JSON.stringify({ conversation_id: 'root', status: 'ok', response: 'model: guess' });
  assert.deepEqual(executionMetadata(printed, '', 'gemini'), { sessionId: 'root' });
  assert.deepEqual(executionMetadata('{"type":"turn_context","payload":{"model":"guess"}}', '', 'goose'), {});
});
