#!/usr/bin/env node
// herdr-mattpocock-skills 的机械操作脚本：解析职责配置、生成 CLI 参数、开关 Herdr 面板、
// 匿名执行、子会话回报、归档台账。这里没有任何工作流逻辑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HMS = path.join(SKILL_DIR, 'scripts', 'hms.mjs');
const UNSET = new Set(['default', 'inherit', 'current']);
const isSet = v => typeof v === 'string' && v !== '' && !UNSET.has(v);
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFAULT_MAIN = ['secretary', 'pm', 'backend'];
const ORDER = ['secretary', 'griller', 'pm', 'frontend', 'backend', 'searcher', 'reviewer', 'checker', 'merger', 'designer'];
const ROLE_FILE = { frontend: 'worker', backend: 'worker' };
const ROLE_USE = {
  secretary: '需求、设计、spec/tickets、开工确认', griller: '单张决策票访谈', pm: '实现调度与整合',
  frontend: '前端实现与自测', backend: '后端实现与自测', searcher: 'research 与查证', reviewer: '独立审查视角',
  checker: '构建与静态检查', merger: '授权合并', designer: '独立设计方案',
};
const CARRIER = { current: '当前会话', herdr: 'Herdr 面板', background: '匿名 CLI', native: '宿主原生 subagent' };
const STATUSES = new Set(['completed', 'blocked', 'failed']);
const LEDGER_HEAD = '| 身份 | 工具 | 模型 / 思考等级 | session_id | Herdr 面板 | agent 名 | 任务 | 状态 |';
const BOOL = new Set(['headless', 'force', 'json', 'help']);

// ---------- 通用 ----------

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pad = n => String(Math.abs(n)).padStart(2, '0');
export function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}
export const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); };
const out = data => process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);
const safeName = s => String(s).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 40) || 'task';
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
export const shellQuote = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const shellJoin = argv => argv.map(shellQuote).join(' ');

export function sanitizeTitle(title) {
  const t = String(title ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().replace(/\s+/g, '-').replace(/[. ]+$/, '').slice(0, 40);
  if (!t || t === '.' || t === '..') throw new Error('标题为空或无效，请提炼一个简短的中文标题');
  return t;
}

function parseArgs(argv) {
  const o = { _: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const name = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOL.has(key)) { o[name] = true; continue; }
    let val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (val === undefined) throw new Error(`--${key} 缺少值`);
    if (key === 'set') o.set.push(val); else o[name] = val;
  }
  return o;
}

function need(o, ...keys) {
  for (const k of keys) if (o[k] === undefined || o[k] === '') throw new Error(`缺少 --${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
}

function onPath(exe) {
  if (exe.includes('/')) return fs.existsSync(exe);
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, exe), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function projectRoot(o) {
  if (o.project) return path.resolve(o.project);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

// ---------- 配置解析 ----------

export function configCandidates(project, env = process.env) {
  const xdg = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return [
    path.join(project, '.agents/herdr/routing.json'),
    path.join(xdg, 'herdr-mattpocock-skills/routing.json'),
    path.join(SKILL_DIR, 'templates/routing.json'),
  ];
}

function loadConfig(o, project) {
  const files = o.config ? [path.resolve(o.config)] : configCandidates(project);
  const file = files.find(f => fs.existsSync(f));
  if (!file) throw new Error(`找不到 routing.json：${files.join('、')}`);
  return { file, config: readJson(file) };
}

export function resolveRoles(config, { sets = [], host = {}, simpleMain = [] } = {}) {
  const raw = structuredClone(config.roles ?? {});
  for (const s of sets) {
    const m = /^([a-z][\w-]*)\.(tool|model|effort|carrier|place|inherit)=(.*)$/.exec(s);
    if (!m) throw new Error(`--set 的格式应为 role.field=value：${s}`);
    (raw[m[1]] ??= {})[m[2]] = m[3];
  }
  const done = {};
  const visit = (name, chain) => {
    if (done[name]) return done[name];
    if (chain.includes(name)) throw new Error(`inherit 形成循环：${[...chain, name].join(' -> ')}`);
    const r = raw[name];
    if (!r) throw new Error(`routing.json 没有配置身份 ${name}`);
    const { inherit, ...own } = r;
    let res = { ...own };
    if (inherit) {
      const p = visit(inherit, [...chain, name]);
      res = { tool: p.tool, model: p.model, effort: p.effort, ...own, inherits: inherit };
    }
    if (simpleMain.includes(name)) res = { ...res, tool: 'current', model: 'inherit', effort: 'inherit', carrier: 'current', mergedMain: true };
    if (!res.tool) throw new Error(`身份 ${name} 缺少 tool`);
    res.model ??= 'default';
    res.effort ??= 'default';
    res.carrier ??= 'background';
    if (res.tool === 'current' && host.tool) res.tool = host.tool;
    if (res.model === 'inherit' && host.model) res.model = host.model;
    if (res.effort === 'inherit' && host.effort) res.effort = host.effort;
    return (done[name] = res);
  };
  for (const name of Object.keys(raw)) visit(name, []);
  return done;
}

export function checkRole(name, r, tools) {
  const problems = [];
  if (r.enabled === false || r.carrier === 'current') return problems;
  if (r.carrier === 'native') {
    if (r.tool === 'current') problems.push('native 需要明确的工具，或通过 --host 提供当前会话的工具');
    return problems;
  }
  if (r.carrier !== 'herdr' && r.carrier !== 'background') return [`未知载体 ${r.carrier}`];
  if (r.tool === 'current') return ['继承了当前会话的工具：请用 --host 提供，或为该身份单独配置'];
  const t = tools?.[r.tool];
  if (!t) return [`工具 ${r.tool} 没有在 tools 中定义`];
  const mode = r.carrier === 'herdr' ? 'interactive' : 'headless';
  if (!Array.isArray(t[mode])) problems.push(`工具 ${r.tool} 没有 ${mode} 命令`);
  for (const f of ['model', 'effort']) {
    if (isSet(r[f]) && !t[f] && !t.patch) problems.push(`工具 ${r.tool} 没有 ${f} 参数映射，不能设为 ${r[f]}`);
    if (r[f] === 'inherit') problems.push(`${f} 继承当前会话但值未知：请用 --host-${f} 提供，或改为具体值 / default`);
  }
  if (t.patch && isSet(r.model) && !r.model.includes('/')) problems.push(`工具 ${r.tool} 的 model 需写成 provider/model`);
  return problems;
}

export function makeSnapshot(config, { sets = [], mode, host = {}, off = [], source = null, project = process.cwd() } = {}) {
  mode ??= config.defaultMode ?? 'simple';
  if (mode !== 'simple' && mode !== 'complex') throw new Error(`未知模式 ${mode}`);
  const simpleMain = mode === 'simple' ? (config.simple?.main ?? DEFAULT_MAIN) : [];
  const roles = resolveRoles(config, { sets, host, simpleMain });
  for (const n of off) {
    if (!roles[n]) throw new Error(`--off 中的身份 ${n} 不存在`);
    roles[n].enabled = false;
  }
  const tools = {};
  for (const r of Object.values(roles)) if (config.tools?.[r.tool]) tools[r.tool] = config.tools[r.tool];
  return {
    schemaVersion: 2, createdAt: nowIso(), mode, project,
    docsDir: path.resolve(project, config.docsDir ?? '.agents/herdr/session'),
    runDir: path.resolve(project, config.runDir ?? '.agents/herdr/run'),
    configSource: source, host, simpleMain, roles, tools, confirmed: false,
  };
}

const showVal = v => (v === 'default' ? '工具默认（未核实）' : v === 'inherit' ? '当前会话（未知）' : v);
const showTool = r => (r.tool === 'current' ? '当前会话（未知）' : r.tool);

export function snapshotTable(s) {
  const names = [...ORDER.filter(n => s.roles[n]), ...Object.keys(s.roles).filter(n => !ORDER.includes(n))];
  const lines = ['| 身份 | 本轮用途 | 工具 | 模型 | 思考等级 | 执行方式 | 备注 |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const n of names) {
    const r = s.roles[n];
    if (r.enabled === false) { lines.push(`| ${n} | 本轮不启用 | — | — | — | — | |`); continue; }
    const notes = checkRole(n, r, s.tools);
    if (r.inherits) notes.push(`继承 ${r.inherits}`);
    if (r.mergedMain) notes.push(`合并于当前主会话（${s.simpleMain.join(' + ')}）`);
    const mode = r.carrier === 'herdr' ? 'interactive' : r.carrier === 'background' ? 'headless' : null;
    const exe = mode && s.tools[r.tool]?.[mode]?.[0];
    if (exe && !onPath(exe)) notes.push(`找不到可执行文件 ${exe}`);
    lines.push(`| ${n} | ${ROLE_USE[n] ?? '自定义身份'} | ${cell(showTool(r))} | ${cell(showVal(r.model))} | ${cell(showVal(r.effort))} | ${CARRIER[r.carrier] ?? r.carrier} | ${cell(notes.join('；'))} |`);
  }
  return lines.join('\n');
}

function snapshotFrom(o, project) {
  if (o.snapshot) {
    if (o.set.length || o.host || o.mode || o.off) throw new Error('快照已确定：变更配置需由 secretary 重新确认（hms record confirm）');
    const file = path.resolve(o.snapshot);
    return { snap: readJson(file), snapFile: file };
  }
  const { file, config } = loadConfig(o, project);
  const host = { tool: o.host, model: o.hostModel, effort: o.hostEffort };
  const off = o.off ? o.off.split(',').map(s => s.trim()).filter(Boolean) : [];
  return { snap: makeSnapshot(config, { sets: o.set, mode: o.mode, host, off, source: file, project }), snapFile: null };
}

function roleOf(snap, role, carrier) {
  const r = snap.roles[role];
  if (!r) throw new Error(`身份 ${role} 不在配置中`);
  if (r.enabled === false) throw new Error(`身份 ${role} 本轮不启用；需要启用时由 secretary 重新确认`);
  if (carrier && r.carrier !== carrier) {
    const hint = r.carrier === 'native' ? '：native 由宿主原生 subagent 执行' : r.carrier === 'current' ? '：由当前主会话直接承担' : '';
    throw new Error(`身份 ${role} 的载体是 ${r.carrier}，不是 ${carrier}${hint}。载体变更需 secretary 确认`);
  }
  const problems = checkRole(role, r, snap.tools);
  if (problems.length) throw new Error(`身份 ${role} 配置有问题：${problems.join('；')}`);
  return r;
}

// ---------- 参数生成 ----------

export function renderPatch(tool, role) {
  if (!tool.patch || (!isSet(role.model) && !isSet(role.effort))) return null;
  const vals = {};
  if (isSet(role.model)) {
    const i = role.model.indexOf('/');
    vals.provider = role.model.slice(0, i);
    vals.modelId = role.model.slice(i + 1);
  }
  if (isSet(role.effort)) vals.effortValue = role.effort;
  return tool.patch.template.split('\n')
    .filter(line => [...line.matchAll(/\{(\w+)\}/g)].every(m => vals[m[1]] !== undefined))
    .map(line => line.replace(/\{(\w+)\}/g, (_, k) => vals[k]))
    .join('\n');
}

export function buildArgv(tool, role, mode, ctx = {}) {
  const tpl = tool[mode];
  if (!Array.isArray(tpl)) throw new Error(`工具没有 ${mode} 命令`);
  const extra = role.args?.[mode] ?? [];
  const items = tpl.includes('{prompt}') ? tpl.flatMap(x => (x === '{prompt}' ? [...extra, x] : [x])) : [...tpl, ...extra];
  const flag = f => (isSet(role[f]) && tool[f] ? tool[f].map(s => s.replaceAll('{value}', role[f])) : []);
  return items.flatMap(x => {
    if (x === '{model}') return flag('model');
    if (x === '{effort}') return flag('effort');
    if (x === '{patch}') return ctx.patchFile ? [tool.patch.flag ?? '--patch', ctx.patchFile] : [];
    if (x === '{prompt}') {
      if (ctx.prompt == null) throw new Error('缺少 prompt');
      return [ctx.prompt];
    }
    if (x.includes('{sessionId}')) {
      if (!ctx.sessionId) throw new Error('缺少 sessionId');
      return [x.replaceAll('{sessionId}', ctx.sessionId)];
    }
    return [x];
  });
}

function prepareArgv(snap, r, mode, prompt) {
  const tool = snap.tools[r.tool];
  const sessionId = tool[mode].some(x => x.includes('{sessionId}')) ? crypto.randomUUID() : undefined;
  const patch = renderPatch(tool, r);
  let patchFile;
  if (patch) {
    patchFile = path.join(snap.runDir, 'patches', `${stamp()}-${crypto.randomUUID().slice(0, 8)}.yml`);
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, patch);
  }
  return { argv: buildArgv(tool, r, mode, { prompt, sessionId, patchFile }), sessionId };
}

// ---------- 派工文件 ----------

function ensureSnapFile(snap, snapFile, label) {
  if (snapFile) return snapFile;
  const file = path.join(snap.runDir, 'snapshots', `${stamp()}-${safeName(label)}.json`);
  writeJson(file, snap);
  return file;
}

function writeBrief(snap, { explicit, role, task, parent, inbox, bodyFile, snapFile }) {
  const body = fs.readFileSync(path.resolve(bodyFile), 'utf8');
  const roleFile = path.join(SKILL_DIR, 'roles', `${ROLE_FILE[role] ?? role}.md`);
  const hms = `node ${shellQuote(HMS)}`;
  const roleLine = fs.existsSync(roleFile)
    ? `- 你的身份：${role}。先读 \`${roleFile}\`。`
    : `- 你的身份：${role}（自定义身份），按下方正文履行职责。`;
  const lines = [
    `# ${explicit ? 'Herdr 派工' : '匿名派工'}：${role} · ${task}`,
    '',
    roleLine,
    `- 不要加载 \`${path.join(SKILL_DIR, 'SKILL.md')}\`，不要扮演 secretary，也不要创建团队。`,
    `- 执行配置快照：\`${snapFile}\`。再派工时一律用 \`${hms} spawn|run <role> --snapshot ${shellQuote(snapFile)} ...\`，不得改用自己的默认配置。`,
  ];
  if (explicit) {
    lines.push(
      `- 父会话：\`${parent}\`；任务标识：\`${task}\`。`,
      '- 结果落盘后执行回报（status 取 completed / blocked / failed）。只有满足完成条件才能报 completed；等待用户回答不算完成：',
      '',
      '```sh',
      `${hms} notify --to ${shellQuote(parent)} --inbox ${shellQuote(inbox)} --task ${shellQuote(task)} --role ${role} --status completed --result '<结果路径或票据>' --summary '<一句话>'`,
      '```',
    );
  } else {
    lines.push('- 不开面板，不再委派同类工作。你的最终回复就是交给调用方的报告；派工要求的文件产物写到指定路径。');
  }
  lines.push('', '---', '', body);
  const file = path.join(snap.runDir, 'briefs', `${stamp()}-${role}-${safeName(task)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

// ---------- Herdr ----------

function requireHerdr() {
  if (process.env.HERDR_ENV !== '1') throw new Error('当前不在 Herdr 管理的面板内，无法创建或控制 Herdr 会话');
}

function herdr(args, { allowFail = false } = {}) {
  const r = spawnSync('herdr', args, { encoding: 'utf8' });
  if (r.error) throw new Error(`无法执行 herdr：${r.error.message}`);
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`herdr ${args.join(' ')} 失败：${(r.stderr || r.stdout).trim()}`);
  }
  const text = r.stdout.trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function agentInfo(target) {
  const res = herdr(['agent', 'get', target], { allowFail: true })?.result;
  if (!res) return null;
  const a = typeof res.agent === 'object' && res.agent !== null ? res.agent : res;
  return a.agent_status ? a : null;
}

function waitAgent(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = agentInfo(target);
    if (a && a.agent_status !== 'unknown') return a;
    if (Date.now() > deadline) return a;
    sleep(1000);
  }
}

const promptText = brief => `请读取派工文件并按其执行：${brief}`;

// ---------- 台账 ----------

const splitRow = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(s => s.trim());
const makeRow = cells => `| ${cells.map(cell).join(' | ')} |`;

function ledgerBounds(lines) {
  const h = lines.findIndex(l => l.trim() === LEDGER_HEAD);
  if (h < 0) throw new Error('归档中找不到显式会话台账表');
  let end = h + 1;
  while (end + 1 < lines.length && lines[end + 1].trim().startsWith('|')) end++;
  return [h, end];
}

export function ledgerAdd(text, cells, { replaceRole } = {}) {
  const lines = text.split('\n');
  const [h, end] = ledgerBounds(lines);
  if (replaceRole) {
    for (let i = h + 2; i <= end; i++) {
      const old = splitRow(lines[i]);
      if (old[0] !== replaceRole) continue;
      const merged = [...cells];
      merged[6] = `${cells[6]}（曾：${old[1]} ${old[3]} ${old[6]}）`;
      lines[i] = makeRow(merged);
      return lines.join('\n');
    }
  }
  lines.splice(end + 1, 0, makeRow(cells));
  return lines.join('\n');
}

export function ledgerStatus(text, pane, status) {
  const lines = text.split('\n');
  const [h, end] = ledgerBounds(lines);
  for (let i = h + 2; i <= end; i++) {
    const c = splitRow(lines[i]);
    if (c[4] === pane) { c[7] = status; lines[i] = makeRow(c); }
  }
  return lines.join('\n');
}

function editRecord(file, fn) {
  if (!file) return;
  const abs = path.resolve(file);
  fs.writeFileSync(abs, fn(fs.readFileSync(abs, 'utf8')));
}

// ---------- 命令 ----------

function cmdResolve(o) {
  const project = projectRoot(o);
  const { snap } = snapshotFrom(o, project);
  if (o.write) writeJson(path.resolve(o.write), snap);
  const problems = Object.entries(snap.roles).flatMap(([n, r]) => checkRole(n, r, snap.tools).map(p => `${n}: ${p}`));
  if (o.json) out(snap);
  else out(`${snapshotTable(snap)}\n\n模式：${snap.mode}；配置来源：${snap.configSource ?? '快照'}${o.write ? `；快照已写入 ${path.resolve(o.write)}（待确认）` : ''}`);
  if (problems.length) {
    process.stderr.write(`配置问题：\n${problems.map(p => `- ${p}`).join('\n')}\n`);
    process.exitCode = 2;
  }
}

function cmdArgv(o) {
  const role = o._[1];
  need({ role }, 'role');
  const { snap } = snapshotFrom(o, projectRoot(o));
  const r = roleOf(snap, role, o.headless ? 'background' : 'herdr');
  const { argv, sessionId } = prepareArgv(snap, r, o.headless ? 'headless' : 'interactive', o.headless ? promptText('<派工文件>') : undefined);
  out({ role, tool: r.tool, model: r.model, effort: r.effort, argv, shell: shellJoin(argv), sessionId: sessionId ?? null });
}

function cmdSpawn(o) {
  requireHerdr();
  const role = o._[1];
  need({ role, ...o }, 'role', 'name', 'task', 'brief');
  if (!NAME_RE.test(o.name)) throw new Error('--name 须匹配 [a-z][a-z0-9_-]{0,31}，且在 Herdr 中唯一');
  if (agentInfo(o.name)) throw new Error(`Herdr 中已有名为 ${o.name} 的 agent`);
  const project = projectRoot(o);
  const { snap, snapFile: given } = snapshotFrom(o, project);
  if (role === 'pm' && !snap.confirmed) throw new Error('PM 需要 secretary 已确认的快照（hms record init --confirmed / record confirm）');
  const r = roleOf(snap, role, 'herdr');
  const snapFile = ensureSnapFile(snap, given, o.name);
  const parent = o.parent ?? process.env.HERDR_PANE_ID;
  const inbox = path.resolve(o.inbox ?? path.join(snap.runDir, 'inbox.jsonl'));
  const brief = writeBrief(snap, { explicit: true, role, task: o.task, parent, inbox, bodyFile: o.brief, snapFile });
  const { argv, sessionId: presetSession } = prepareArgv(snap, r, 'interactive');
  const cwd = path.resolve(o.cwd ?? process.cwd());

  const place = o.place ?? r.place ?? 'split';
  let pane;
  let tab = process.env.HERDR_TAB_ID ?? null;
  if (place === 'tab') {
    const res = herdr(['tab', 'create', '--workspace', process.env.HERDR_WORKSPACE_ID, '--cwd', cwd, '--label', o.name, '--no-focus']).result ?? {};
    pane = res.root_pane?.pane_id ?? res.root_pane;
    tab = res.tab?.tab_id ?? tab;
  } else {
    const res = herdr(['pane', 'split', '--current', '--direction', o.direction ?? 'right', '--cwd', cwd, '--no-focus']).result ?? {};
    pane = res.pane?.pane_id;
  }
  if (!pane) throw new Error('Herdr 没有返回新面板 ID');

  const report = { role, name: o.name, task: o.task, pane, tab, cwd, tool: r.tool, model: r.model, effort: r.effort, brief, snapshot: snapFile };
  try {
    herdr(['pane', 'run', pane, shellJoin(argv)]);
  } catch (e) {
    throw new Error(`${e.message}\n面板 ${pane} 已创建，请检查后关闭或重试`);
  }
  let agent = waitAgent(pane, Number(o.startTimeout ?? 60000));
  report.recognized = Boolean(agent);
  if (agent) {
    herdr(['agent', 'rename', pane, o.name]);
    if (agent.agent_status === 'blocked') {
      report.delivered = false;
      report.note = `agent 停在启动对话框；请用户在面板 ${pane} 中处理，然后运行：node ${HMS} prompt ${o.name} --file ${brief}`;
    } else {
      herdr(['agent', 'prompt', o.name, promptText(brief)]);
      report.delivered = true;
    }
    for (let i = 0; i < 10 && !agent?.agent_session?.value; i++) { sleep(1000); agent = agentInfo(o.name) ?? agent; }
  } else {
    herdr(['pane', 'send-text', pane, promptText(brief)]);
    herdr(['pane', 'send-keys', pane, 'enter']);
    report.delivered = true;
    report.note = 'Herdr 未识别该 agent：状态与 session ID 不可用，回报依赖子会话执行 notify';
  }
  report.sessionId = agent?.agent_session?.value ?? presetSession ?? null;
  report.sessionSource = agent?.agent_session?.value ? agent.agent_session.source : presetSession ? 'preset-uuid' : null;

  editRecord(o.record, text => ledgerAdd(text, [
    role, r.tool, `${r.model} / ${r.effort}`, report.sessionId ?? '未取得', pane,
    report.recognized ? o.name : '—', oneLine(o.title ? `${o.task} ${o.title}` : o.task), report.delivered ? '运行中' : '等待启动确认',
  ], { replaceRole: snap.mode === 'simple' && role === 'frontend' ? 'frontend' : undefined }));
  out(report);
}

function cmdPrompt(o) {
  requireHerdr();
  const target = o._[1];
  need({ target, ...o }, 'target', 'file');
  const a = agentInfo(target);
  if (!a) throw new Error(`${target} 上没有被 Herdr 识别的 agent`);
  if (a.agent_status === 'blocked') throw new Error(`${target} 正停在对话框上，请用户先处理`);
  herdr(['agent', 'prompt', target, promptText(path.resolve(o.file))]);
  out({ target, delivered: true });
}

function acquireLock(dir, timeoutMs) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), `${process.pid}\n${os.hostname()}\n${nowIso()}\n`);
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = [];
      try { owner = fs.readFileSync(path.join(dir, 'owner'), 'utf8').split('\n'); } catch { /* 尚未写入 */ }
      const pid = Number(owner[0]);
      let alive = true;
      if (pid && owner[1] === os.hostname()) {
        try { process.kill(pid, 0); } catch (err) { alive = err.code === 'EPERM'; }
      }
      if (!alive) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`等待锁超时：${dir}`);
      sleep(2000);
    }
  }
}

function cmdRun(o) {
  const role = o._[1];
  need({ role, ...o }, 'role', 'task', 'brief');
  const project = projectRoot(o);
  const { snap, snapFile: given } = snapshotFrom(o, project);
  const r = roleOf(snap, role, 'background');
  const snapFile = ensureSnapFile(snap, given, `${role}-${o.task}`);
  const brief = writeBrief(snap, { explicit: false, role, task: o.task, bodyFile: o.brief, snapFile });
  const outFile = path.resolve(o.out ?? path.join(snap.runDir, 'out', `${stamp()}-${role}-${safeName(o.task)}-${crypto.randomUUID().slice(0, 6)}.md`));
  const errFile = `${outFile}.stderr.log`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const { argv } = prepareArgv(snap, r, 'headless', promptText(brief));
  const release = o.lock ? acquireLock(path.resolve(o.lock), Number(o.lockTimeout ?? 30 * 60 * 1000)) : () => {};
  let res;
  try {
    const so = fs.openSync(outFile, 'w');
    const se = fs.openSync(errFile, 'w');
    res = spawnSync(argv[0], argv.slice(1), {
      cwd: path.resolve(o.cwd ?? process.cwd()), stdio: ['ignore', so, se],
      timeout: o.timeoutMin ? Number(o.timeoutMin) * 60000 : undefined,
    });
    fs.closeSync(so);
    fs.closeSync(se);
  } finally {
    release();
  }
  const exit = res.error ? null : res.status;
  out({ role, task: o.task, tool: r.tool, model: r.model, effort: r.effort, exit, signal: res.signal ?? null, error: res.error?.message ?? null, out: outFile, stderr: errFile, brief });
  process.exitCode = exit ?? 1;
}

function cmdNotify(o) {
  need(o, 'to', 'task', 'role', 'status', 'result', 'summary');
  if (!STATUSES.has(o.status)) throw new Error('--status 只能是 completed、blocked、failed');
  const msg = { time: nowIso(), task: o.task, role: o.role, status: o.status, result: o.result, summary: oneLine(o.summary), from: process.env.HERDR_PANE_ID ?? null };
  if (o.inbox) {
    fs.mkdirSync(path.dirname(path.resolve(o.inbox)), { recursive: true });
    fs.appendFileSync(path.resolve(o.inbox), `${JSON.stringify(msg)}\n`);
  }
  requireHerdr();
  const text = `HERDR_RESULT task=${o.task} status=${o.status} role=${o.role} result=${o.result} summary=${msg.summary}${o.inbox ? ` inbox=${path.resolve(o.inbox)}` : ''}`;
  const deadline = Date.now() + Number(o.waitMs ?? 30 * 60 * 1000);
  for (;;) {
    const a = agentInfo(o.to);
    if (!a) throw new Error(`父会话 ${o.to} 不存在或没有 agent${o.inbox ? '；结果已写入 inbox' : ''}`);
    if (a.agent_status !== 'working' && a.agent_status !== 'blocked') {
      const r = spawnSync('herdr', ['agent', 'prompt', o.to, text], { encoding: 'utf8' });
      if (r.status === 0) { out({ delivered: true, to: o.to, task: o.task }); return; }
      if (!/agent_blocked/.test(`${r.stderr}${r.stdout}`)) throw new Error(`回报投递失败：${(r.stderr || r.stdout).trim()}${o.inbox ? '；结果已写入 inbox' : ''}`);
    }
    if (Date.now() > deadline) {
      process.stderr.write(`父会话一直忙碌，未能投递${o.inbox ? '；结果保留在 inbox' : ''}\n`);
      process.exitCode = 3;
      return;
    }
    sleep(5000);
  }
}

function cmdClose(o) {
  requireHerdr();
  const target = o._[1];
  need({ target }, 'target');
  const a = agentInfo(target);
  if (a?.agent_status === 'working' && !o.force) throw new Error(`${target} 仍在 working；确认成果已交接后再加 --force`);
  const pane = a?.pane_id ?? target;
  herdr(['pane', 'close', pane]);
  editRecord(o.record, text => ledgerStatus(text, pane, o.status ?? '已关闭'));
  out({ closed: pane });
}

function cmdLs(o) {
  requireHerdr();
  need(o, 'record');
  const lines = fs.readFileSync(path.resolve(o.record), 'utf8').split('\n');
  const [h, end] = ledgerBounds(lines);
  const rows = [];
  for (let i = h + 2; i <= end; i++) {
    const c = splitRow(lines[i]);
    const pane = c[4];
    const live = /^w\w*:p\w+$/.test(pane) ? herdr(['pane', 'get', pane], { allowFail: true }) : null;
    const a = live ? agentInfo(pane) : null;
    rows.push({ role: c[0], tool: c[1], session: c[3], pane, name: c[5], task: c[6], ledger: c[7], alive: Boolean(live), agent: a?.agent_status ?? null });
  }
  out(rows);
}

function fillTemplate(vars) {
  const tpl = fs.readFileSync(path.join(SKILL_DIR, 'templates/session-log.md'), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function confirmSnap(snap, note) {
  return { ...snap, confirmed: true, confirmedAt: nowIso(), confirmation: oneLine(note) };
}

function mainRow(snap, task) {
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID) return '';
  const a = agentInfo(process.env.HERDR_PANE_ID);
  const sec = snap.roles.secretary ?? { tool: 'current', model: 'inherit', effort: 'inherit' };
  const label = snap.mode === 'simple' ? snap.simpleMain.join(' + ') : 'secretary';
  return makeRow([label, showTool(sec), `${showVal(sec.model)} / ${showVal(sec.effort)}`, a?.agent_session?.value ?? '未取得', process.env.HERDR_PANE_ID, a?.name ?? '—', oneLine(task), '运行中']);
}

function cmdRecord(o) {
  const sub = o._[1];
  if (sub === 'init') return recordInit(o);
  if (sub === 'confirm') return recordConfirm(o);
  throw new Error('用法：hms record init|confirm ...');
}

function recordInit(o) {
  need(o, 'title', 'recap', 'source');
  const project = projectRoot(o);
  let { snap } = snapshotFrom(o, project);
  if (o.confirmed) snap = confirmSnap(snap, o.confirmed);
  const title = sanitizeTitle(o.title);
  fs.mkdirSync(snap.docsDir, { recursive: true });
  let base = `${stamp()}-${title}`;
  for (let n = 2; fs.existsSync(path.join(snap.docsDir, `${base}.md`)); n++) base = `${stamp()}-${title}-${n}`;
  const md = path.join(snap.docsDir, `${base}.md`);
  const sj = path.join(snap.docsDir, `${base}.snapshot.json`);
  writeJson(sj, snap);
  fs.writeFileSync(md, fillTemplate({
    title, time: nowIso(), recap: oneLine(o.recap), source: o.source, mode: snap.mode, workflow: o.workflow ?? '未指定',
    docs: o.docs ?? '—', snapshotFile: sj, table: snapshotTable(snap),
    status: snap.confirmed ? `已确认（${snap.confirmedAt}）；用户确认：${snap.confirmation}` : '待确认',
    mainRow: mainRow(snap, o.task ?? title),
  }));
  out({ record: md, snapshot: sj, confirmed: snap.confirmed });
}

function recordConfirm(o) {
  need(o, 'record', 'snapshot', 'confirmed');
  const md = path.resolve(o.record);
  const sj = md.replace(/\.md$/, '.snapshot.json');
  const snap = confirmSnap(readJson(path.resolve(o.snapshot)), o.confirmed);
  const revision = fs.existsSync(sj) && readJson(sj).confirmed;
  let text = fs.readFileSync(md, 'utf8');
  if (revision) {
    const block = `### ${snap.confirmedAt}\n\n用户确认：${snap.confirmation}\n\n${snapshotTable(snap)}\n\n`;
    const i = text.indexOf('## 交付引用');
    text = i < 0 ? `${text}\n${block}` : `${text.slice(0, i)}${block}${text.slice(i)}`;
  } else {
    const a = text.indexOf('## 本轮身份配置');
    const b = text.indexOf('## 显式会话台账');
    if (a < 0 || b < 0) throw new Error('归档格式不完整：缺少“本轮身份配置”或“显式会话台账”章节');
    text = `${text.slice(0, a)}## 本轮身份配置\n\n状态：已确认（${snap.confirmedAt}）；用户确认：${snap.confirmation}\n\n${snapshotTable(snap)}\n\n${text.slice(b)}`;
  }
  writeJson(sj, snap);
  fs.writeFileSync(md, text);
  out({ record: md, snapshot: sj, revision });
}

const HELP = `hms — herdr-mattpocock-skills 机械操作脚本

  resolve  [--mode simple|complex] [--host T --host-model M --host-effort E] [--set role.field=v]... [--off a,b] [--write F] [--json]
           生成本轮身份配置表；--write 保存待确认快照
  argv     <role> [--headless] [--snapshot F | --set ...]       打印将执行的命令，不执行
  spawn    <role> --name N --task ID --brief F [--snapshot F] [--record R] [--cwd D] [--place split|tab] [--direction right|down] [--title T]
           创建 Herdr 面板、启动 CLI、投递派工、登记台账
  prompt   <name|pane> --file F                                  补发派工
  run      <role> --task ID --brief F [--snapshot F] [--out F] [--lock DIR] [--cwd D] [--timeout-min N]
           匿名执行，退出码等于 CLI 退出码
  notify   --to PANE --task ID --role R --status completed|blocked|failed --result REF --summary S [--inbox F] [--wait-ms N]
           子会话回报：先写 inbox，等父会话空闲后投递
  close    <name|pane> [--record R] [--force] [--status S]        关闭面板并更新台账
  ls       --record R                                            对账：台账中的面板是否仍存活
  record   init --title T --recap S --source native-recap|secretary-generated [--workflow W] [--docs D] [--task T] [--snapshot F] [--confirmed NOTE]
  record   confirm --record R --snapshot F --confirmed NOTE        确认或修订本轮配置

通用：--project DIR 指定项目根目录；--config F 指定 routing.json。`;

export function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  const table = { resolve: cmdResolve, argv: cmdArgv, spawn: cmdSpawn, prompt: cmdPrompt, run: cmdRun, notify: cmdNotify, close: cmdClose, ls: cmdLs, record: cmdRecord };
  if (!cmd || o.help || cmd === 'help') return out(HELP);
  if (!table[cmd]) throw new Error(`未知命令 ${cmd}；运行 hms help 查看用法`);
  return table[cmd](o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`hms: ${e.message}\n`);
    process.exitCode = 1;
  }
}
