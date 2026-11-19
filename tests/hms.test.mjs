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
  e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]).sort();

function fixture(t, { tool = {}, role = {}, output, fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  const socket = path.join(dir, 'herdr-default.sock');
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
    if (a[0] === 'session' && a[1] === 'list') {
      console.log(JSON.stringify({sessions:[{name:'default',default:true,running:true,socket_path:${JSON.stringify(socket)}}]}));
      process.exit(0);
    }
    let result = {};
    if (a[0] === 'pane' && a[1] === 'current') result = {pane:{pane_id:process.env.HERDR_PANE_ID||'w1:other',workspace_id:'w1',tab_id:'w1:tab-other',terminal_id:'term-other',agent:'codex',agent_status:'idle'}};
    if (a[0] === 'agent' && a[1] === 'list') result = {agents:[
      {pane_id:'w1:parent',workspace_id:'w1',tab_id:'w1:tab-parent',terminal_id:'term-parent',agent:'codex',agent_status:'idle',agent_session:{value:'main-session'},agent_model:{value:'host-model'},agent_effort:{value:'max'}},
      {pane_id:'w1:other',workspace_id:'w1',tab_id:'w1:tab-other',terminal_id:'term-other',agent:'codex',agent_status:'idle'},
    ]};
    if (a[0] === 'pane' && a[1] === 'process-info' && a[3] === 'w1:parent') result = {process_info:{shell_pid:process.ppid}};
    if (a[0] === 'pane' && a[1] === 'run' && process.env.HMS_TEST_FAIL_START) process.exit(1);
    if (a[0] === 'agent' && a[1] === 'get') {
      if (a[2] !== 'w1:child' && a[2] !== 'w1:parent') process.exit(1);
      if (a[2] === 'w1:child' && process.env.HMS_TEST_FAIL_START) process.exit(1);
      const child = a[2] === 'w1:child';
      result = {agent:{agent:child ? 'mock' : 'codex',agent_status:'idle',pane_id:a[2],workspace_id:'w1',tab_id:'w1:tab-parent',
        terminal_id:child ? 'term-child' : 'term-parent',agent_session:{value:child ? 'visible-session' : 'main-session'},
        agent_model:{value:child ? 'observed-model' : 'host-model'},agent_effort:{value:child ? 'high' : 'max'}}};
    }
    if (a[0] === 'pane' && a[1] === 'split') result = {pane:{pane_id:'w1:child',workspace_id:'w1',tab_id:'w1:tab-parent',terminal_id:'term-child'}};
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
    HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: 'w1:other', HERDR_WORKSPACE_ID: 'w1', CODEX_THREAD_ID: 'main-session' };
  delete env.HERDR_SESSION;
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
  return { dir, project, agent, config, calls, socket, env, command, run, init, team, read, sent };
}

test('每轮团队只有一份四列表格，确认与参数预览沿用此表', t => {
  const f = fixture(t);
  const r = f.team();
  assert.match(path.basename(r.record), /^\d{8}-\d{6}-排障信息\.md$/);
  assert.equal(path.dirname(r.record), path.join(f.project, '.agents/herdr/session'));
  assert.equal(f.read(r), `${header}\n| --- | --- | --- | --- |\n| main-session | codex | host-model | max |\n`);
  const confirmed = f.run(['record', 'confirm', '--context', r.context, '--confirmed', '同意当前配置']);
  assert.equal(confirmed.record, r.record);
  assert.equal(JSON.parse(Buffer.from(confirmed.context, 'base64url')).confirmed, true);
  f.run(['argv', 'searcher', '--context', confirmed.context, '--headless']);
  assert.deepEqual(files(f.project), [f.config, r.record]);
});

test('显式面板通过 Herdr 直接收到原文并登记原生 ID，不用派工文件', t => {
  const f = fixture(t);
  const r = f.team(['--confirmed', '同意当前配置']);
  const body = "核实入口\n包含 '引号'、`代码` 和 $(这不是命令)";
  const result = f.run(['spawn', 'frontend', '--context', r.context, '--name', 'fresh-worker', '--task', '781', '--prompt', body]);
  assert.equal(result.sessionId, 'visible-session');
  assert.equal(result.herdrSocket, f.socket);
  assert.equal(result.workspace, 'w1');
  assert.equal(result.tab, 'w1:tab-parent');
  assert.equal(result.pane, 'w1:child');
  assert.ok(f.sent().some(c => c[0] === 'pane' && c[1] === 'split' && c.includes('w1:parent')));
  assert.ok(!f.sent().some(c => c[0] === 'tab' && c[1] === 'create'));
  const dispatched = f.sent().find(c => c[0] === 'agent' && c[1] === 'prompt');
  assert.ok(dispatched[3].endsWith(body));
  assert.ok(dispatched[3].includes(`--context ${r.context}`));
  assert.match(dispatched[3], /纯前端票由你主责/);
  assert.doesNotMatch(dispatched[3], /roles\/frontend\.md/);
  assert.ok(!dispatched[3].includes('读取派工文件'));
  assert.ok(f.read(r).includes('| visible-session | mock | observed-model | high |'));
  assert.deepEqual(files(f.project), [f.config, r.record]);
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
    assert.deepEqual(files(f.project), [f.config, r.record]);
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
  assert.deepEqual(files(f.project), [f.config, r.record]);
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
  assert.deepEqual(files(f.project), [f.config, r.record]);
});

test('原生与直接 CLI 可以补登记在同一表里，不创建另一轮记录', t => {
  const f = fixture(t);
  const r = f.team();
  f.run(['record', 'add', '--context', r.context, '--tool', 'codex', '--session-id', 'native-session', '--model', 'native-model', '--effort', 'high']);
  assert.equal(f.run(['record', 'add', '--record', r.record, '--tool', 'dsh']).added, false);
  f.run(['record', 'add', '--mode', 'complex', '--record', r.record, '--tool', 'dsh']);
  assert.ok(f.read(r).includes('| native-session | codex | native-model | high |'));
  assert.ok(f.read(r).includes('| 未取得 | dsh | 未核实 | 未核实 |'));
  assert.deepEqual(files(f.project), [f.config, r.record]);
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
  assert.deepEqual(files(f.project), [f.config, r.record]);
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
  assert.deepEqual(files(f.project), [f.config, team.record]);
});

test('继续确认和补登旧路径团队表时沿用同一份表', t => {
  const f = fixture(t);
  const simple = f.init();
  const promote = ['record', 'update', '--context', simple.context, '--mode', 'complex'];
  const team = f.run(promote);
  const legacy = path.join(path.dirname(f.config), path.basename(team.record));
  fs.renameSync(team.record, legacy);

  const snap = JSON.parse(Buffer.from(team.context, 'base64url'));
  const context = Buffer.from(JSON.stringify({ ...snap, record: legacy })).toString('base64url');
  assert.equal(f.run(promote).record, legacy);
  const confirmed = f.run(['record', 'confirm', '--context', context, '--confirmed', '同意当前配置']);
  assert.equal(confirmed.record, legacy);
  f.run(['record', 'add', '--context', confirmed.context, '--tool', 'codex', '--session-id', 'native-session']);
  f.run(['record', 'add', '--mode', 'complex', '--record', legacy, '--tool', 'dsh']);
  const record = fs.readFileSync(legacy, 'utf8');
  assert.match(record, /native-session/);
  assert.match(record, /\| 未取得 \| dsh \| 未核实 \| 未核实 \|/);
  assert.deepEqual(files(f.project), [legacy, f.config]);
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

const decodeAddress = addr => JSON.parse(Buffer.from(addr.slice(4), 'base64url').toString('utf8'));

function multiSessionFixture(t, { sessions, roles = {}, env: extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-multi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  const sockets = {
    default: path.join(dir, 'herdr-default.sock'),
    main: path.join(dir, 'herdr-main.sock'),
  };
  const agent = path.join(dir, 'agent.mjs');
  fs.writeFileSync(agent, `console.log(JSON.stringify({type:'thread.started',thread_id:'mock-headless'}));`);
  const stateFile = path.join(dir, 'herdr-state.json');
  const callsFile = path.join(dir, 'herdr-calls.jsonl');
  const initialSessions = Object.fromEntries(Object.entries(sessions).map(([name, cfg]) => [name, {
    socket: sockets[name] ?? path.join(dir, `herdr-${name}.sock`),
    running: cfg.running !== false,
    seq: 0,
    splitIds: [...(cfg.splitIds ?? [])],
    panes: cfg.panes.map(p => ({ cwd: project, foreground_cwd: project, closed: false, ...p })),
  }]));
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: initialSessions }, null, 2));
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
    import fs from 'node:fs';
    const stateFile = ${JSON.stringify(stateFile)};
    const callsFile = ${JSON.stringify(callsFile)};
    const a = process.argv.slice(2);
    fs.appendFileSync(callsFile, JSON.stringify({
      socket: process.env.HERDR_SOCKET_PATH ?? null,
      herdrSession: process.env.HERDR_SESSION ?? null,
      args: a,
    }) + '\\n');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const fail = (code, message) => {
      process.stderr.write(JSON.stringify({ error: { code, message } }) + '\\n');
      process.exit(1);
    };
    if (a[0] === 'session' && a[1] === 'list') {
      console.log(JSON.stringify({
        sessions: Object.entries(state.sessions).map(([name, s]) => ({
          name, default: name === 'default', running: s.running !== false, socket_path: s.socket,
        })),
      }));
      process.exit(0);
    }
    const entries = Object.entries(state.sessions);
    const chosen = process.env.HERDR_SOCKET_PATH
      ? entries.find(([, s]) => s.socket === process.env.HERDR_SOCKET_PATH)
      : process.env.HERDR_SESSION
        ? entries.find(([name]) => name === process.env.HERDR_SESSION)
        : entries.find(([name]) => name === 'default');
    if (!chosen || chosen[1].running === false) fail('session_unavailable', 'session unavailable');
    const [sessionName, session] = chosen;
    const livePanes = () => session.panes.filter(p => !p.closed);
    const findPane = id => livePanes().find(p => p.pane_id === id);
    const findAgent = target => livePanes().find(p => p.agent && (p.pane_id === target || p.name === target));
    let result = {};
    if (a[0] === 'pane' && a[1] === 'current') {
      const pane = findPane(process.env.HERDR_PANE_ID);
      if (!pane) fail('pane_not_found', 'current pane not found');
      result = { pane };
    } else if (a[0] === 'agent' && a[1] === 'list') {
      result = { agents: livePanes().filter(p => p.agent) };
    } else if (a[0] === 'pane' && a[1] === 'list') {
      result = { panes: livePanes() };
    } else if (a[0] === 'pane' && a[1] === 'process-info') {
      const pane = findPane(a[a.indexOf('--pane') + 1]);
      if (!pane) fail('pane_not_found', 'pane not found');
      result = { process_info: {
        shell_pid: pane.matchCaller ? process.ppid : (pane.shell_pid ?? 999999),
        foreground_cwd: pane.foreground_cwd ?? pane.cwd,
      } };
    } else if (a[0] === 'agent' && a[1] === 'get') {
      const pane = findAgent(a[2]);
      if (!pane) fail('agent_not_found', 'agent not found');
      result = { agent: pane };
    } else if (a[0] === 'pane' && a[1] === 'get') {
      const pane = findPane(a[2]);
      if (!pane) fail('pane_not_found', 'pane not found');
      result = { pane };
    } else if (a[0] === 'pane' && a[1] === 'read') {
      const pane = findPane(a[2]);
      if (!pane) fail('pane_not_found', 'pane not found');
      const lines = Number(a[a.indexOf('--lines') + 1]);
      console.log((pane.visible ?? '').split('\\n').slice(-lines).join('\\n'));
      process.exit(0);
    } else if (a[0] === 'pane' && a[1] === 'split') {
      const parent = findPane(a[a.indexOf('--pane') + 1]);
      if (!parent) fail('pane_not_found', 'parent pane not found');
      const cwdIdx = a.indexOf('--cwd');
      const cwd = cwdIdx >= 0 ? a[cwdIdx + 1] : parent.cwd;
      const paneId = session.splitIds.length ? session.splitIds.shift() : parent.workspace_id + ':p-split-' + (++session.seq);
      const created = {
        pane_id: paneId, workspace_id: parent.workspace_id, tab_id: parent.tab_id,
        terminal_id: 'term-' + sessionName + '-' + paneId, cwd, foreground_cwd: cwd,
        agent: null, agent_status: 'unknown', closed: false,
      };
      session.panes.push(created);
      save();
      result = { pane: created };
    } else if (a[0] === 'tab' && a[1] === 'create') {
      result = { root_pane: { pane_id: 'unexpected:tab' }, tab: { tab_id: 'unexpected:t' } };
    } else if (a[0] === 'pane' && a[1] === 'run') {
      const pane = findPane(a[2]);
      if (!pane) fail('pane_not_found', 'pane not found');
      pane.agent = 'mock';
      pane.agent_status = 'idle';
      pane.agent_session = { value: 'session-' + sessionName + '-' + pane.pane_id };
      pane.agent_model = { value: 'observed-model' };
      pane.agent_effort = { value: 'high' };
      save();
      result = { ok: true };
    } else if (a[0] === 'agent' && a[1] === 'rename') {
      const pane = findPane(a[2]);
      if (!pane) fail('pane_not_found', 'pane not found');
      pane.name = a[3];
      save();
      result = { ok: true };
    } else if (a[0] === 'agent' && a[1] === 'prompt') {
      const pane = findAgent(a[2]);
      if (!pane) fail('agent_not_found', 'agent not found');
      if (pane.blockOnce) {
        pane.blockOnce = false;
        save();
        fail('agent_blocked', 'agent_blocked');
      }
      (pane.prompts ??= []).push(a[3]);
      save();
      result = { type: 'agent_prompted' };
    } else if (a[0] === 'agent' && a[1] === 'wait') {
      const pane = findAgent(a[2]);
      if (pane) { pane.agent_status = 'idle'; save(); }
      result = { status: 'idle' };
    } else if (a[0] === 'pane' && a[1] === 'close') {
      const pane = findPane(a[2]);
      if (!pane) fail('pane_not_found', 'pane not found');
      pane.closed = true;
      save();
      result = { closed: pane.pane_id };
    }
    console.log(JSON.stringify({ result }));`, { mode: 0o755 });

  const config = path.join(project, '.agents/herdr/routing.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({
    active: true,
    tools: {
      mock: {
        interactive: [process.execPath, agent, '{model}', '{effort}'],
        headless: [process.execPath, agent, '{model}', '{effort}', '{prompt}'],
        model: ['--model', '{value}'],
        effort: ['--effort', '{value}'],
        metadata: 'codex',
      },
    },
    roles: {
      secretary: { tool: 'current', model: 'inherit', effort: 'inherit', carrier: 'current' },
      pm: { tool: 'mock', model: 'requested-alias', effort: 'max', carrier: 'herdr', place: 'tab' },
      wayfinder: { tool: 'mock', model: 'requested-alias', effort: 'max', carrier: 'herdr', place: 'split' },
      frontend: { tool: 'mock', model: 'requested-alias', effort: 'max', carrier: 'herdr', place: 'tab' },
      backend: { tool: 'mock', model: 'requested-alias', effort: 'max', carrier: 'herdr', place: 'tab' },
      ...roles,
    },
  }));
  const baseEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HERDR_ENV: '1' };
  for (const key of ['HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID']) {
    delete baseEnv[key];
  }
  Object.assign(baseEnv, extraEnv);
  const run = (args, { expected = 0, env: overrideEnv = {}, script = hms, input } = {}) => {
    const merged = { ...baseEnv, ...overrideEnv };
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    const res = spawnSync(process.execPath, [script, ...args, '--project', project], { cwd: project, env: merged, encoding: 'utf8', input });
    assert.equal(res.status, expected, res.stderr || res.stdout);
    return expected === 0 || res.stdout ? JSON.parse(res.stdout) : res;
  };
  const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const clearCalls = () => fs.rmSync(callsFile, { force: true });
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const mutateState = fn => {
    const s = state();
    fn(s);
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  };
  return { dir, project, sockets, run, calls, clearCalls, state, mutateState };
}

test('手动 Codex 的启动 hook 和 HMS 从实时状态栏核对自身，在共享 app-server 下也只在自己的标签页分屏', t => {
  const mainThread = '01a10000-0000-7000-8000-000000000001';
  const defaultThread = '01a10000-0000-7000-8000-000000000002';
  const footer = id => `› Ask Codex to do anything\n\n  ${id} · Context 71% left\n  ← for agents · ? for shortcuts`;
  const codex = { pane_id: 'w1:p4', workspace_id: 'w1', agent: 'codex', agent_status: 'idle' };
  const f = multiSessionFixture(t, { sessions: {
    default: { panes: [{ ...codex, tab_id: 'w1:t4', terminal_id: 'term-default',
      agent_session: { value: mainThread }, visible: footer(defaultThread) }] },
    main: { panes: [{ ...codex, tab_id: 'w1:t9', terminal_id: 'term-main',
      agent_session: { value: defaultThread }, visible: footer(mainThread) }] },
  } });
  const env = { CODEX_THREAD_ID: mainThread, HERDR_SOCKET_PATH: f.sockets.default,
    HERDR_SESSION: 'default', HERDR_PANE_ID: 'w1:p4', HERDR_TAB_ID: 'w1:t4' };
  const team = f.run(['init', '--mode', 'complex', '--title', '核对秘书面板'], { env });
  const spawn = ['spawn', 'wayfinder', '--context', team.context, '--task', 'coordinates', '--prompt', '验证位于发起面板旁'];
  const where = f.run(['where'], { env });
  assert.deepEqual([where.herdrSession, where.herdrSocket, where.workspace, where.tab, where.pane, where.terminalId, where.sessionId],
    ['main', f.sockets.main, 'w1', 'w1:t9', 'w1:p4', 'term-main', mainThread]);
  assert.equal(decodeAddress(where.address).session, undefined);
  const child = f.run(spawn, { env });
  assert.deepEqual([child.herdrSocket, child.workspace, child.tab], [f.sockets.main, 'w1', 'w1:t9']);
  const split = f.calls().find(c => c.args[0] === 'pane' && c.args[1] === 'split');
  assert.deepEqual([split.socket, split.herdrSession, ...split.args.slice(2, 6)],
    [f.sockets.main, null, '--pane', 'w1:p4', '--direction', 'right']);
  const notifyAddress = /notify --to (hms:[A-Za-z0-9_-]+)/.exec(f.state().sessions.main.panes.find(p => p.pane_id === child.pane).prompts[0])[1];
  assert.equal(f.run(['notify', '--to', notifyAddress, '--task', 'coordinates', '--role', 'wayfinder', '--status', 'completed', '--summary', '完成'], { env }).to, 'w1:p4');

  const script = path.join(path.dirname(hms), 'codex-session-start.mjs');
  const hookInput = JSON.stringify({ hook_event_name: 'SessionStart', session_id: mainThread });
  const hook = f.run([], { script, input: hookInput, env: { ...env, CODEX_THREAD_ID: defaultThread } });
  assert.match(hook.hookSpecificOutput.additionalContext, /会话 main，工作区 w1，标签页 w1:t9，面板 w1:p4，终端 term-main/);
  const defaultWhere = f.run(['where'], { env: { ...env, CODEX_THREAD_ID: defaultThread, HERDR_SOCKET_PATH: f.sockets.main, HERDR_SESSION: 'main' } });
  assert.deepEqual([defaultWhere.herdrSocket, defaultWhere.tab, defaultWhere.sessionId], [f.sockets.default, 'w1:t4', defaultThread]);

  f.clearCalls();
  assert.match(f.run([...spawn, '--herdr-session', 'default', '--parent', 'w1:p4'], { expected: 1, env }).stderr, /不一致/);
  assert.match(f.run([...spawn, '--session-id', defaultThread], { expected: 1, env }).stderr, /不一致/);
  f.mutateState(s => { s.sessions.default.panes[0].visible = footer(mainThread); });
  assert.match(f.run(spawn, { expected: 1, env }).stderr, /匹配多个 Herdr 面板/);
  assert.deepEqual(f.run([], { script, input: hookInput, env }), {});
  f.mutateState(s => {
    s.sessions.default.panes[0].visible = `${mainThread}\n${footer(defaultThread)}`;
    s.sessions.main.panes[0].visible = footer(`${mainThread.slice(0, 29)}...`);
  });
  assert.match(f.run([...spawn, '--herdr-session', 'default', '--parent', 'w1:p4'], { expected: 1, env }).stderr, /状态栏未显示本线程的完整 ID/);
  assert.ok(!f.calls().some(c => c.args[0] === 'pane' && c.args[1] === 'split'));
});

test('双会话共存时按目标 socket 分屏启动 wayfinder，允许跨会话同名面板与同名 agent', t => {
  const f = multiSessionFixture(t, {
    sessions: {
      default: {
        splitIds: ['w1:p99'],
        panes: [
          { pane_id: 'w3:p19', workspace_id: 'w3', tab_id: 'w3:tA', terminal_id: 'term-def-p19', agent: 'codex', agent_status: 'idle', name: 'dup-wayfinder', agent_session: { value: 'stella-thread' } },
          { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t-def', terminal_id: 'term-def-p4', agent: 'codex', agent_status: 'idle', agent_session: { value: 'def-thread' } },
        ],
      },
      main: {
        splitIds: ['w1:p99'],
        panes: [
          { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t4', terminal_id: 'term-main-p4', agent: 'codex', agent_status: 'idle' },
        ],
      },
    },
  });
  const detachedDefaultEnv = {
    HERDR_SOCKET_PATH: f.sockets.default,
    HERDR_SESSION: 'default',
    HERDR_PANE_ID: 'w3:p19',
    HERDR_WORKSPACE_ID: 'w3',
    CODEX_THREAD_ID: 'main-demo-thread',
  };
  const team = f.run(['init', '--mode', 'complex', '--title', '双会话验证',
    '--host', 'codex', '--host-model', 'host-model', '--host-effort', 'max', '--session-id', 'main-demo-thread'], { env: detachedDefaultEnv });

  // 脱离面板时，不指定会话或仅传裸 --parent 必须在创建面板前报错。
  f.clearCalls();
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--task', 't0', '--prompt', '检查'], { expected: 1, env: detachedDefaultEnv }).stderr, /无法确认发起面板/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--parent', 'w3:p19', '--task', 't0', '--prompt', '检查'], { expected: 1, env: detachedDefaultEnv }).stderr, /无法确认发起面板/);
  assert.ok(!f.calls().some(c => (c.args[0] === 'pane' && c.args[1] === 'split') || (c.args[0] === 'tab' && c.args[1] === 'create')));

  // 显式定位 main/w1:p4，使用与 default 重名的 dup-wayfinder，验证分屏在 main/w1/w1:t4 且不干扰 default。
  f.clearCalls();
  const mainSpawn = f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'main', '--parent', 'w1:p4',
    '--name', 'dup-wayfinder', '--task', 't-main', '--prompt', '执行 main 票'], { env: detachedDefaultEnv });
  assert.equal(mainSpawn.herdrSocket, f.sockets.main);
  assert.equal(mainSpawn.workspace, 'w1');
  assert.equal(mainSpawn.tab, 'w1:t4');
  assert.equal(mainSpawn.pane, 'w1:p99');
  const mainChildAddr = decodeAddress(mainSpawn.address);
  assert.equal(mainChildAddr.socket, f.sockets.main);
  assert.equal(mainChildAddr.pane, 'w1:p99');
  assert.equal(mainChildAddr.terminal, 'term-main-w1:p99');
  assert.equal(mainChildAddr.managed, true);

  const mainWrites = f.calls().filter(c => ['split', 'run', 'rename', 'prompt'].includes(c.args[1]));
  assert.equal(mainWrites.length, 4);
  for (const call of mainWrites) {
    assert.equal(call.socket, f.sockets.main);
    assert.equal(call.herdrSession, null);
  }
  assert.ok(!f.calls().some(c => c.args[0] === 'tab' && c.args[1] === 'create'));

  // 同一会话内重复 agent 名在创建面板前报错。
  f.clearCalls();
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'main', '--parent', 'w1:p4',
    '--name', 'dup-wayfinder', '--task', 't-dup', '--prompt', '重复'], { expected: 1, env: detachedDefaultEnv }).stderr, /已使用/);
  assert.ok(!f.calls().some(c => c.args[0] === 'pane' && c.args[1] === 'split'));

  // 从 default 再验证一次（即使进程环境被污染为 main，且两边同为 w1:p4 / w1:p99）。
  const poisonedMainEnv = {
    HERDR_SOCKET_PATH: f.sockets.main,
    HERDR_SESSION: 'main',
    HERDR_PANE_ID: 'w1:p4',
    CODEX_THREAD_ID: 'def-thread',
  };
  f.clearCalls();
  const defSpawn = f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'default', '--parent', 'w1:p4',
    '--name', 'wf-default', '--task', 't-def', '--prompt', '执行 default 票'], { env: poisonedMainEnv });
  assert.equal(defSpawn.herdrSocket, f.sockets.default);
  assert.equal(defSpawn.workspace, 'w1');
  assert.equal(defSpawn.tab, 'w1:t-def');
  assert.equal(defSpawn.pane, 'w1:p99');
  const defChildAddr = decodeAddress(defSpawn.address);
  assert.equal(defChildAddr.socket, f.sockets.default);
  assert.equal(defChildAddr.terminal, 'term-default-w1:p99');
  const defWrites = f.calls().filter(c => ['split', 'run', 'rename', 'prompt'].includes(c.args[1]));
  assert.equal(defWrites.length, 4);
  for (const call of defWrites) {
    assert.equal(call.socket, f.sockets.default);
    assert.equal(call.herdrSession, null);
  }
});

test('prompt、notify、close 与再派工全程钉在绑定地址的 socket，不串会话且拒绝跨会话冲突', t => {
  const f = multiSessionFixture(t, {
    sessions: {
      default: {
        splitIds: ['w1:p99'],
        panes: [
          { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t-def', terminal_id: 'term-def-p4', agent: 'codex', agent_status: 'idle', agent_session: { value: 'def-thread' } },
        ],
      },
      main: {
        splitIds: ['w1:p99', 'w1:p100'],
        panes: [
          { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t4', terminal_id: 'term-main-p4', agent: 'codex', agent_status: 'idle', blockOnce: true },
        ],
      },
    },
  });
  const detachedDefaultEnv = {
    HERDR_SOCKET_PATH: f.sockets.default,
    HERDR_SESSION: 'default',
    HERDR_PANE_ID: 'w1:p4',
    CODEX_THREAD_ID: 'main-demo-thread',
  };
  const team = f.run(['init', '--mode', 'complex', '--title', '地址绑定',
    '--host', 'codex', '--host-model', 'host-model', '--host-effort', 'max', '--session-id', 'main-demo-thread'], { env: detachedDefaultEnv });

  const mainChild = f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'main', '--parent', 'w1:p4',
    '--name', 'wf-main', '--task', 't-main', '--prompt', '主任务'], { env: detachedDefaultEnv });
  const defChild = f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'default', '--parent', 'w1:p4',
    '--name', 'wf-def', '--task', 't-def', '--prompt', '默认任务'], { env: { ...detachedDefaultEnv, CODEX_THREAD_ID: 'def-thread' } });

  const mainDispatchPrompt = f.state().sessions.main.panes.find(p => p.pane_id === 'w1:p99').prompts[0];
  const notifyTo = /notify --to (\S+)/.exec(mainDispatchPrompt)[1];
  const selfParent = /--parent (\S+)/.exec(mainDispatchPrompt)[1];
  assert.equal(decodeAddress(notifyTo).socket, f.sockets.main);
  assert.equal(decodeAddress(notifyTo).pane, 'w1:p4');
  assert.equal(decodeAddress(selfParent).socket, f.sockets.main);
  assert.equal(decodeAddress(selfParent).pane, 'w1:p99');

  // prompt 在进程环境指向 default 时仍严格命中 main 的 w1:p99。
  f.clearCalls();
  f.run(['prompt', mainChild.address, '--prompt', '仅发给 main'], { env: detachedDefaultEnv });
  const promptCalls = f.calls().filter(c => c.args[0] === 'agent' && c.args[1] === 'prompt');
  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].socket, f.sockets.main);
  assert.equal(promptCalls[0].herdrSession, null);
  assert.deepEqual(f.state().sessions.default.panes.find(p => p.pane_id === 'w1:p99').prompts.length, 1);

  // notify（含 agent_blocked 重试）全部钉在 main socket，不回落到 default。
  f.clearCalls();
  f.run(['notify', '--to', notifyTo, '--task', 't-main', '--role', 'wayfinder', '--status', 'completed', '--summary', '已完成'], { env: detachedDefaultEnv });
  const notifyCalls = f.calls().filter(c => c.args[0] === 'agent' && c.args[1] === 'prompt');
  assert.equal(notifyCalls.length, 2);
  for (const call of notifyCalls) {
    assert.equal(call.socket, f.sockets.main);
    assert.equal(call.herdrSession, null);
  }
  assert.equal(f.state().sessions.main.panes.find(p => p.pane_id === 'w1:p4').prompts.length, 1);
  assert.equal(f.state().sessions.default.panes.find(p => p.pane_id === 'w1:p4').prompts, undefined);

  // 子面板通过派工正文中的带 socket --parent 再派工，无需 --herdr-session，仍在 main/w1:t4 分屏。
  f.clearCalls();
  const grandchild = f.run(['spawn', 'wayfinder', '--context', team.context, '--parent', selfParent,
    '--name', 'wf-grandchild', '--task', 't-sub', '--prompt', '子派工'], { env: detachedDefaultEnv });
  assert.equal(grandchild.herdrSocket, f.sockets.main);
  assert.equal(grandchild.tab, 'w1:t4');
  assert.equal(grandchild.pane, 'w1:p100');

  // 地址与显式 --herdr-session 冲突、或脱离面板使用裸面板 ID 时拒绝执行。
  f.clearCalls();
  assert.match(f.run(['prompt', mainChild.address, '--herdr-session', 'default', '--prompt', '冲突'], { expected: 1, env: detachedDefaultEnv }).stderr, /不一致/);
  assert.match(f.run(['prompt', 'w1:p99', '--prompt', '裸ID'], { expected: 1, env: detachedDefaultEnv }).stderr, /无法确认面板/);
  assert.match(f.run(['close', 'w1:p99', '--takeover'], { expected: 1, env: detachedDefaultEnv }).stderr, /无法确认面板/);
  assert.ok(!f.calls().some(c => (c.args[0] === 'agent' && c.args[1] === 'prompt') || (c.args[0] === 'pane' && c.args[1] === 'close')));

  // close 仅关闭各自绑定 socket 的 w1:p99，不误关另一会话同名面板。
  f.clearCalls();
  f.run(['close', mainChild.address], { env: detachedDefaultEnv });
  assert.equal(f.state().sessions.main.panes.find(p => p.pane_id === 'w1:p99').closed, true);
  assert.equal(f.state().sessions.default.panes.find(p => p.pane_id === 'w1:p99').closed, false);
  f.run(['close', defChild.address], { env: { ...detachedDefaultEnv, HERDR_SOCKET_PATH: f.sockets.main, HERDR_SESSION: 'main' } });
  assert.equal(f.state().sessions.default.panes.find(p => p.pane_id === 'w1:p99').closed, true);
});

test('进程归属、显式会话与原生会话 ID 冲突时均在创建面板前报错，脱离面板拒绝被污染的全局定位', t => {
  const f = multiSessionFixture(t, {
    sessions: {
      default: {
        panes: [
          // 模拟共享 app-server 的 herdr:codex hook 将 main 的 thread ID 污染登记到了 default/w3:p19。
          { pane_id: 'w3:p19', workspace_id: 'w3', tab_id: 'w3:tA', terminal_id: 'term-def-p19', agent: 'codex', agent_status: 'idle', agent_session: { value: 'main-demo-thread' } },
        ],
      },
      main: {
        panes: [
          { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t4', terminal_id: 'term-main-p4', agent: 'codex', agent_status: 'idle' },
          { pane_id: 'w1:p5', workspace_id: 'w1', tab_id: 'w1:t5', terminal_id: 'term-main-p5', agent: 'codex', agent_status: 'idle', agent_session: { value: 'unique-main-thread' } },
          { pane_id: 'w1:p6', workspace_id: 'w1', tab_id: 'w1:t6', terminal_id: 'term-main-p6', agent: 'codex', agent_status: 'idle', agent_session: { value: 'dup-thread' } },
          { pane_id: 'w1:p7', workspace_id: 'w1', tab_id: 'w1:t7', terminal_id: 'term-main-p7', agent: 'codex', agent_status: 'idle', agent_session: { value: 'dup-thread' } },
        ],
      },
    },
  });
  const poisonedEnv = {
    HERDR_SOCKET_PATH: f.sockets.default,
    HERDR_SESSION: 'default',
    HERDR_PANE_ID: 'w3:p19',
    CODEX_THREAD_ID: 'main-demo-thread',
  };
  const team = f.run(['init', '--mode', 'complex', '--title', '冲突校验',
    '--host', 'codex', '--host-model', 'host-model', '--host-effort', 'max', '--session-id', 'main-demo-thread'], { env: poisonedEnv });

  // 脱离面板：即使 default/w3:p19 被污染了相同的 CODEX_THREAD_ID，也绝不自动命中 default/w3:p19。
  f.clearCalls();
  assert.match(f.run(['where'], { expected: 1, env: poisonedEnv }).stderr, /无法确认发起面板/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--task', 't1', '--prompt', '禁止误投'], { expected: 1, env: poisonedEnv }).stderr, /无法确认发起面板/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'default', '--task', 't1a', '--prompt', '仅指定会话不凭env误投'], { expected: 1, env: poisonedEnv }).stderr, /无法确认发起面板/);
  // 显式指定会话但原生会话 ID 冲突或同会话内有多个匹配，或会话不存在，均在创建面板前报错。
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--session', 'main', '--parent', 'w1:p4',
    '--task', 't1b', '--prompt', '误用--session'], { expected: 1, env: poisonedEnv }).stderr, /--herdr-session/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'default', '--parent', 'w3:p19',
    '--session-id', 'other-thread', '--task', 't2', '--prompt', '冲突'], { expected: 1, env: poisonedEnv }).stderr, /不一致/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'main', '--parent', 'w1:p4',
    '--session-id', 'unique-main-thread', '--task', 't3', '--prompt', '冲突'], { expected: 1, env: poisonedEnv }).stderr, /不一致/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'main',
    '--session-id', 'dup-thread', '--task', 't4', '--prompt', '歧义'], { expected: 1, env: poisonedEnv }).stderr, /匹配多个面板/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'nonexistent', '--parent', 'w1:p4',
    '--task', 't5', '--prompt', '不存在'], { expected: 1, env: poisonedEnv }).stderr, /未运行或不可用/);
  assert.ok(!f.calls().some(c => c.args[0] === 'pane' && c.args[1] === 'split'));

  // 显式指定 main 后，可按该会话内唯一的原生会话 ID 定位到 w1:p5 并分屏。
  const byNative = f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'main',
    '--session-id', 'unique-main-thread', '--task', 't-native', '--prompt', '按原生ID定位'], { env: poisonedEnv });
  assert.equal(byNative.herdrSocket, f.sockets.main);
  assert.equal(byNative.tab, 'w1:t5');

  // 真实本地面板（PID 归属 main/w1:p4）：即使继承环境被污染到 default，where 仍定位到 main/w1:p4，冲突参数在分屏前报错。
  f.mutateState(s => {
    const p4 = s.sessions.main.panes.find(p => p.pane_id === 'w1:p4');
    p4.matchCaller = true;
    p4.agent_session = { value: 'main-demo-thread' };
  });
  const where = f.run(['where'], { env: poisonedEnv });
  assert.equal(where.herdrSession, 'main');
  assert.equal(where.herdrSocket, f.sockets.main);
  assert.equal(where.workspace, 'w1');
  assert.equal(where.tab, 'w1:t4');
  assert.equal(where.pane, 'w1:p4');
  assert.equal(where.sessionId, 'main-demo-thread');
  assert.equal(decodeAddress(where.address).socket, f.sockets.main);

  f.clearCalls();
  const defAddr = 'hms:' + Buffer.from(JSON.stringify({ socket: f.sockets.default, pane: 'w3:p19' })).toString('base64url');
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--herdr-session', 'default', '--task', 'c1', '--prompt', '冲突'], { expected: 1, env: poisonedEnv }).stderr, /不一致/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--parent', 'w1:p5', '--task', 'c2', '--prompt', '冲突'], { expected: 1, env: poisonedEnv }).stderr, /不一致/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--parent', defAddr, '--task', 'c3', '--prompt', '冲突'], { expected: 1, env: poisonedEnv }).stderr, /不一致/);
  assert.match(f.run(['spawn', 'wayfinder', '--context', team.context, '--session-id', 'wrong-id', '--task', 'c4', '--prompt', '冲突'], { expected: 1, env: poisonedEnv }).stderr, /不一致/);
  assert.ok(!f.calls().some(c => c.args[0] === 'pane' && c.args[1] === 'split'));
});

test('强制同标签页分屏，兼容旧 place=tab，拒绝 --place tab，singleton 与旧面板按 socket 和标签页隔离', t => {
  const f = multiSessionFixture(t, {
    sessions: {
      default: {
        panes: [
          { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t-def', terminal_id: 'term-def-p4', agent: 'codex', agent_status: 'idle' },
        ],
      },
      main: {
        panes: [
          { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t4', terminal_id: 'term-main-p4', agent: 'codex', agent_status: 'idle', matchCaller: true, agent_session: { value: 'main-thread' } },
          { pane_id: 'w1:p8', workspace_id: 'w1', tab_id: 'w1:t8', terminal_id: 'term-main-p8', agent: 'codex', agent_status: 'idle' },
        ],
      },
    },
  });
  const mainEnv = { HERDR_SOCKET_PATH: f.sockets.main, HERDR_PANE_ID: 'w1:p4', CODEX_THREAD_ID: 'main-thread' };
  const team = f.run(['init', '--mode', 'complex', '--title', '同标签分屏', '--confirmed', '同意',
    '--host', 'codex', '--host-model', 'host-model', '--host-effort', 'max', '--session-id', 'main-thread'], { env: mainEnv });

  // 显式 --place tab 必须在创建面板前报错。
  f.clearCalls();
  assert.match(f.run(['spawn', 'pm', '--context', team.context, '--place', 'tab', '--task', 'p0', '--prompt', '禁止建tab'], { expected: 1, env: mainEnv }).stderr, /--place 仅支持 split/);
  assert.ok(!f.calls().some(c => (c.args[0] === 'pane' && c.args[1] === 'split') || (c.args[0] === 'tab' && c.args[1] === 'create')));

  // 旧配置中的 pm (place=tab) 在 main/w1:t4 正常以 split 启动，随后将同名 singleton 放进 default 验证不串会话。
  const pmFirst = f.run(['spawn', 'pm', '--context', team.context, '--task', 'p1', '--prompt', '首次开 PM'], { env: mainEnv });
  assert.equal(pmFirst.herdrSocket, f.sockets.main);
  assert.equal(pmFirst.tab, 'w1:t4');
  assert.equal(pmFirst.reused, false);
  assert.ok(!f.calls().some(c => c.args[0] === 'tab' && c.args[1] === 'create'));

  // 同会话同标签页再次 spawn pm 直接复用，不新增 split。
  f.clearCalls();
  const pmReuse = f.run(['spawn', 'pm', '--context', team.context, '--task', 'p2', '--prompt', '复用 PM'], { env: mainEnv });
  assert.equal(pmReuse.reused, true);
  assert.equal(pmReuse.pane, pmFirst.pane);
  assert.ok(!f.calls().some(c => c.args[0] === 'pane' && c.args[1] === 'split'));

  // 同会话另一标签页存在同名 singleton 时报错并给出带 socket 的管理地址；跨会话 default 有同名 singleton 不阻止 main 启动。
  f.mutateState(s => {
    const mainPm = s.sessions.main.panes.find(p => p.pane_id === pmFirst.pane);
    mainPm.tab_id = 'w1:t-other';
  });
  f.clearCalls();
  const crossTabErr = f.run(['spawn', 'pm', '--context', team.context, '--task', 'p3', '--prompt', '跨tab'], { expected: 1, env: mainEnv }).stderr;
  assert.match(crossTabErr, /已在标签页 w1:t-other/);
  const mgmtAddr = /(hms:[A-Za-z0-9_-]+)/.exec(crossTabErr)[1];
  assert.equal(decodeAddress(mgmtAddr).socket, f.sockets.main);
  assert.ok(!f.calls().some(c => c.args[0] === 'pane' && c.args[1] === 'split'));

  // 关闭 main 的 PM，仅在 default 保留同名 singleton；main 应忽略 default 并新建分屏。
  f.mutateState(s => {
    s.sessions.main.panes.find(p => p.pane_id === pmFirst.pane).closed = true;
    s.sessions.default.panes.push({
      pane_id: 'w1:p-def-pm', workspace_id: 'w1', tab_id: 'w1:t-def', terminal_id: 'term-def-pm',
      name: pmFirst.name, agent: 'mock', agent_status: 'idle', closed: false,
    });
  });
  const pmFreshInMain = f.run(['spawn', 'pm', '--context', team.context, '--task', 'p4', '--prompt', '仅在 main 重开'], { env: mainEnv });
  assert.equal(pmFreshInMain.reused, false);
  assert.equal(pmFreshInMain.herdrSocket, f.sockets.main);
  assert.equal(pmFreshInMain.tab, 'w1:t4');

  // previousPanels（旧配置面板）同样按目标 socket 隔离：default 的旧面板不拦 main，main 的旧面板拦截并给带 socket 的 close 地址。
  const updated = f.run(['record', 'update', '--context', team.context, '--set', 'pm.effort=high', '--confirmed', '改等级'], { env: mainEnv });
  f.mutateState(s => {
    s.sessions.main.panes.find(p => p.pane_id === pmFreshInMain.pane).closed = true;
  });
  // 此时只有 default 里还挂着 pmFirst.name，main 可以直接按新配置启动。
  const pmNewConfig = f.run(['spawn', 'pm', '--context', updated.context, '--task', 'p5', '--prompt', '新配置 PM'], { env: mainEnv });
  assert.equal(pmNewConfig.reused, false);
  assert.equal(pmNewConfig.herdrSocket, f.sockets.main);

  // 如果 main 里仍存在旧配置面板，则必须在分屏前拦截并给出 main socket 的 close 地址。
  f.mutateState(s => {
    s.sessions.main.panes.find(p => p.pane_id === pmFreshInMain.pane).closed = false;
  });
  f.clearCalls();
  const formerErr = f.run(['spawn', 'pm', '--context', updated.context, '--task', 'p6', '--prompt', '被旧面板拦截'], { expected: 1, env: mainEnv }).stderr;
  assert.match(formerErr, /旧面板/);
  assert.equal(decodeAddress(/(hms:[A-Za-z0-9_-]+)/.exec(formerErr)[1]).socket, f.sockets.main);
  assert.ok(!f.calls().some(c => c.args[0] === 'pane' && c.args[1] === 'split'));
});
