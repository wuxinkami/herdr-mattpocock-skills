#!/usr/bin/env node
// herdr-mattpocock-skills 的机械操作脚本：解析职责配置、生成 CLI 参数、开关 Herdr 面板、
// 匿名执行、直接回报、单表会话记录。这里没有任何工作流逻辑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandProblems, configuredRoles, isSet, modeOptions, projectConfigPath, projectRoot, readRouting, toolId } from './routing.mjs';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_DIR = path.join(path.dirname(SKILL_DIR), 'herdr-setup');
const HMS = path.join(SKILL_DIR, 'scripts', 'hms.mjs');
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFAULT_MAIN = ['secretary', 'pm', 'backend'];
const PANEL_PLACES = { pm: 'tab', frontend: 'tab', backend: 'tab', wayfinder: 'split' };
const ROLE_USE = {
  secretary: '用户沟通与建图', pm: '团队派工与收尾', wayfinder: '一张决策票',
  frontend: '前端实现', backend: '后端实现', searcher: '搜索与研究',
  reviewer: '审查', designer: '独立方案', merger: '授权合并',
};
const CARRIER = { current: '当前会话', herdr: 'Herdr 面板', auto: '匿名，优先原生', background: '匿名 CLI', native: '宿主原生 subagent' };
const STATUSES = new Set(['completed', 'blocked', 'failed']);
const LEDGER_HEAD = '| 会话 ID | Agent 工具 | 实际模型 | 思考等级 |';
const BOOL = new Set(['headless', 'force', 'takeover', 'fresh', 'json', 'help']);

// ---------- 通用 ----------

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pad = n => String(Math.abs(n)).padStart(2, '0');
export function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}
export const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const out = data => process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, ' ');
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

function executable(tool, name) {
  const candidates = [tool.preferredExecutables?.[name], name, ...(tool.fallbackExecutables ?? [])];
  return candidates.find(exe => exe && onPath(exe)) ?? name;
}

// ---------- 配置解析 ----------

export const configCandidates = project => [projectConfigPath(project)];

// 只有本轮显式点名了项目以外的 CLI，才向 setup 取这一项适配。
function toolsForOverrides(registered, sets) {
  const tools = { ...registered };
  for (const set of sets) {
    const name = /^[a-z][\w-]*\.tool=(.+)$/.exec(set)?.[1];
    if (!name || name === 'current' || toolId(tools, name)) continue;
    const r = spawnSync(process.execPath, [path.join(SETUP_DIR, 'scripts/setup.mjs'), 'adapter', name], { encoding: 'utf8' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(r.stderr.trim() || `没有找到 ${name} 的适配`);
    Object.assign(tools, JSON.parse(r.stdout));
  }
  return tools;
}

function loadConfig(o, project) {
  const file = projectConfigPath(project);
  if (o.config && path.resolve(o.config) !== file) throw new Error(`本项目使用 ${file}，切换项目请用 --project`);
  const state = readRouting(file);
  if (!state.active) throw new Error(`项目尚未激活 HMS 配置，请用 $herdr-setup 填表：${state.file}`);
  if ((state.config.schemaVersion ?? 0) < 6) {
    const migrated = spawnSync(process.execPath, [path.join(SETUP_DIR, 'scripts/setup.mjs'), 'current', '--project', project], { encoding: 'utf8' });
    if (migrated.error) throw migrated.error;
    if (migrated.status !== 0) throw new Error(migrated.stderr.trim());
    state.config = JSON.parse(migrated.stdout);
  }
  return state;
}

function projectModelChoices(bindings) {
  const result = Object.create(null);
  for (const role of Object.values(bindings)) {
    if (!role.tool || role.tool === 'current' || !isSet(role.model)) continue;
    const models = result[role.tool] ??= [];
    if (!models.includes(role.model)) models.push(role.model);
  }
  return result;
}

function overrideRoles(raw, sets, tools, before, choices) {
  const changes = new Map();
  for (const s of sets) {
    const match = /^([a-z][\w-]*)\.(tool|model|effort|carrier|place|inherit)=(.+)$/.exec(s);
    if (!match) throw new Error(`--set 的格式应为 role.field=value：${s}`);
    const [, name, field, value] = match;
    if (!changes.has(name)) changes.set(name, {});
    changes.get(name)[field] = value;
  }
  for (const [name, fields] of changes) {
    if (fields.tool) {
      const tool = toolId(tools, fields.tool) ?? fields.tool;
      if (tool !== 'current' && tool !== before[name]?.tool && !fields.model) {
        const models = choices[tool] ?? [];
        if (models.length !== 1) {
          const hint = models.length ? `候选：${models.join('、')}` : '项目尚无候选';
          throw new Error(`${tool}（${hint}）。请用户选一次型号或明确 default，再传 --set ${name}.model=型号`);
        }
        fields.model = models[0];
      }
    }
    const defaults = Object.hasOwn(PANEL_PLACES, name) ? { carrier: 'herdr', place: PANEL_PLACES[name] } : { carrier: 'auto' };
    raw[name] = { ...(Object.hasOwn(raw, name) ? raw[name] : defaults), ...fields };
  }
  return raw;
}

function resolveBindings(raw, tools, host = {}, simpleMain = []) {
  const done = Object.create(null);
  const visit = (name, chain) => {
    if (done[name]) return done[name];
    if (chain.includes(name)) throw new Error(`inherit 形成循环：${[...chain, name].join(' -> ')}`);
    const r = Object.hasOwn(raw, name) ? raw[name] : (simpleMain.includes(name) ? {} : undefined);
    if (!r) throw new Error(`routing.json 没有配置身份 ${name}`);
    const { inherit, ...own } = r;
    let res = { ...own };
    if (inherit) {
      const p = visit(inherit, [...chain, name]);
      res = { tool: p.tool, model: p.model, effort: p.effort, ...own, inherits: inherit };
    }
    if (name === 'secretary' || simpleMain.includes(name)) res = { ...res, tool: 'current', model: 'inherit', effort: 'inherit', carrier: 'current', mergedMain: simpleMain.includes(name) };
    if (!res.tool && res.enabled !== false) throw new Error(`身份 ${name} 缺少 tool`);
    res.model ??= 'default';
    res.effort ||= 'high';
    res.carrier ??= 'background';
    if (res.tool === 'current' && host.tool) res.tool = host.tool;
    res.tool = toolId(tools, res.tool) ?? res.tool;
    if (res.model === 'inherit' && host.model) res.model = host.model;
    if (res.effort === 'inherit' && host.effort) res.effort = host.effort;
    return (done[name] = res);
  };
  for (const name of new Set([...Object.keys(raw), ...simpleMain])) visit(name, []);
  return done;
}

export function resolveRoles(config, { sets = [], host = {}, simpleMain = [] } = {}) {
  const raw = configuredRoles(config);
  const tools = toolsForOverrides(config.tools, sets);
  if (sets.length) {
    const before = resolveBindings(raw, tools);
    overrideRoles(raw, sets, tools, before, config.projectModels ?? projectModelChoices(before));
  }
  return resolveBindings(raw, tools, host, simpleMain);
}

export function checkRole(name, r, tools, caller) {
  const problems = [];
  if (r.enabled === false || r.carrier === 'current') return problems;
  const same = caller && r.tool === caller.tool && isSet(r.model) && r.model === caller.model;
  if (r.carrier === 'native' || (r.carrier === 'auto' && same)) {
    if (r.carrier === 'native' && caller && !same) problems.push('原生调用需要同工具、同型号的宿主');
    if (r.tool === 'current') problems.push('请用 --host 指明当前工具');
    return problems;
  }
  if (!['herdr', 'background', 'auto'].includes(r.carrier)) return [`未知载体 ${r.carrier}`];
  if (r.tool === 'current') return ['继承了当前会话的工具：请用 --host 提供，或为该身份单独配置'];
  const t = tools?.[r.tool];
  if (!t) return [`工具 ${r.tool} 没有在 tools 中定义`];
  const mode = r.carrier === 'herdr' ? 'interactive' : 'headless';
  problems.push(...commandProblems(t, mode, r));
  for (const f of ['model', 'effort']) {
    if (r[f] === 'inherit') problems.push(`${f} 继承当前会话但值未知：请用 --host-${f} 提供，或改为具体值 / default`);
  }
  return problems;
}

export function makeSnapshot(config, { sets = [], mode = 'simple', host = {}, off = [], on = [], source = null, project = process.cwd() } = {}) {
  if (mode !== 'simple' && mode !== 'complex') throw new Error(`未知模式 ${mode}`);
  const simpleMain = mode === 'simple' ? DEFAULT_MAIN : [];
  const tools = toolsForOverrides(config.tools, sets);
  if (host.tool) host = { ...host, tool: toolId(tools, host.tool) ?? host.tool };
  const raw = configuredRoles(config);
  const before = resolveBindings(raw, tools);
  const projectModels = config.projectModels ?? projectModelChoices(before);
  const roleConfig = overrideRoles(raw, sets, tools, before, projectModels);
  const required = new Set(config.required ?? []);
  for (const [enabled, names] of [[false, off], [true, on]]) {
    for (const n of names) {
      if (enabled) required.add(n); else required.delete(n);
      if (Object.hasOwn(roleConfig, n)) roleConfig[n].enabled = enabled;
    }
  }
  const roles = resolveBindings(roleConfig, tools, host, simpleMain);
  return {
    schemaVersion: 6, createdAt: nowIso(), mode, project, projectModels,
    configSource: source, host, simpleMain, roles, roleConfig, tools, required: [...required], confirmed: false,
  };
}

const showVal = (v, label) => (v === 'default' ? `工具默认，${label}未核实` : v === 'inherit' ? '当前会话（未知）' : v);
const showTool = r => (r.tool === 'current' ? '当前会话（未知）' : r.tool);

export function snapshotTable(s, selected) {
  const names = selected ?? [...Object.keys(ROLE_USE).filter(n => s.roles[n]), ...Object.keys(s.roles).filter(n => !Object.hasOwn(ROLE_USE, n))];
  const lines = ['| 身份 | 本轮用途 | 工具 | 模型 | 思考等级 | 执行方式 | 备注 |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const n of new Set([...(s.mode === 'complex' ? ['pm'] : []), ...(s.required ?? [])])) {
    if (!s.roles[n]) lines.push(`| ${cell(n)} | ${ROLE_USE[n] ?? '本轮需要'} | 待填写 | 待填写 | 待填写 | — | 开发前补齐 |`);
  }
  for (const n of names) {
    const r = s.roles[n];
    if (!r) continue;
    if (r.enabled === false) { lines.push(`| ${n} | 本轮不启用 | — | — | — | — | |`); continue; }
    const notes = checkRole(n, r, s.tools, s.host);
    if (r.carrier === 'auto' && r.tool === s.host.tool && isSet(r.model) && r.model === s.host.model && commandProblems(s.tools[r.tool], 'headless', r).length) notes.push('仅当原生子代理可落实此配置时可用');
    if (r.inherits) notes.push(`继承 ${r.inherits}`);
    if (r.mergedMain) notes.push(`合并于当前主会话（${s.simpleMain.join(' + ')}）`);
    const mode = r.carrier === 'herdr' ? 'interactive' : r.carrier === 'background' ? 'headless' : null;
    const exe = mode && s.tools[r.tool]?.[mode]?.[0];
    if (exe && !onPath(executable(s.tools[r.tool], exe))) notes.push(`找不到可执行文件 ${exe}`);
    lines.push(`| ${n} | ${ROLE_USE[n] ?? '自定义身份'} | ${cell(showTool(r))} | ${cell(showVal(r.model, '具体型号'))} | ${cell(showVal(r.effort, '等级'))} | ${CARRIER[r.carrier] ?? r.carrier} | ${cell(notes.join('；'))} |`);
  }
  return lines.join('\n');
}

const roleList = s => s ? s.split(',').map(n => n.trim()).filter(Boolean) : [];

function snapshotFrom(o, project) {
  if (o.context) {
    let snap;
    try { snap = JSON.parse(Buffer.from(o.context, 'base64url').toString('utf8')); }
    catch { throw new Error('--context 不是有效的本轮配置'); }
    if (![3, 4, 5, 6].includes(snap.schemaVersion) || !(snap.roleConfig || snap.roles) || !snap.tools || !snap.project) throw new Error('--context 格式不完整');
    if (snap.schemaVersion === 3) {
      const migrated = makeSnapshot({ roles: snap.roles, tools: snap.tools }, { mode: snap.mode, host: snap.host, project: snap.project, source: snap.configSource });
      snap = { ...snap, ...migrated, createdAt: snap.createdAt ?? migrated.createdAt, confirmed: snap.confirmed };
    }
    if (snap.schemaVersion === 4 && snap.mode === 'simple') {
      for (const n of ['pm', 'backend']) {
        const old = snap.roleConfig[n];
        if (old?.tool === 'current' && old.carrier === 'current' && Object.keys(old).length === 2) delete snap.roleConfig[n];
      }
    }
    snap.roles = resolveBindings(snap.roleConfig, snap.tools, snap.host, snap.simpleMain);
    if (snap.mode === 'complex' && o.record && path.resolve(o.record) !== snap.record) throw new Error('同一轮必须使用同一份团队成员表');
    // 旧版用表路径命名单例面板。保留这个键以便交接，简单模式不再读写旧表。
    snap.roundId ??= snap.record;
    if (!snap.roundId) throw new Error('请使用 hms init 返回的本轮 context');
    if (snap.mode === 'simple' && snap.record) {
      snap.title ??= path.basename(snap.record, '.md').replace(/^\d{8}-\d{6}-/, '');
      snap.record = null;
    }
    snap.schemaVersion = 6;
    if (o.host || o.hostModel || o.hostEffort || o.config) throw new Error('context 已绑定本轮宿主和配置来源');
    const promote = snap.mode === 'simple' && o.mode === 'complex';
    if (o.mode && o.mode !== snap.mode && !promote) throw new Error('本轮可以从简单模式升级为团队模式');
    if (o.set.length || o.on || o.off || promote) {
      if (!(o._[0] === 'resolve' || (o._[0] === 'record' && ['update', 'confirm'].includes(o._[1])))) {
        throw new Error('使用 record update 更新本轮配置并传递新 context');
      }
      let base = { roles: snap.roleConfig, tools: snap.tools, projectModels: snap.projectModels, required: snap.required };
      // setup 可在本轮补填缺失身份；已有本轮绑定及临时覆盖仍优先。
      if ((promote || o.on) && readRouting(projectConfigPath(snap.project)).active) {
        const { config } = loadConfig({}, snap.project);
        base = { ...base, roles: { ...configuredRoles(config), ...base.roles }, tools: { ...config.tools, ...base.tools },
          projectModels: projectModelChoices(resolveBindings(configuredRoles(config), config.tools)) };
      }
      const next = makeSnapshot(base, {
        sets: o.set, on: roleList(o.on), off: roleList(o.off), mode: o.mode ?? snap.mode, host: snap.host, project: snap.project, source: snap.configSource,
      });
      const changed = [...new Set([...Object.keys(next.roles), ...(snap.required ?? []), ...next.required])].filter(n =>
        JSON.stringify(next.roles[n]) !== JSON.stringify(snap.roles[n]) || (snap.required ?? []).includes(n) !== next.required.includes(n));
      const previousPanels = { ...snap.previousPanels };
      const handoffs = new Set(changed);
      if (promote) handoffs.add('frontend');
      for (const n of handoffs) {
        if (snap.roundId && snap.roles[n] && singletonRole(snap.mode, n)) {
          const oldName = singletonName(snap.roundId, n, snap.roles[n]);
          previousPanels[n] = [...new Set([...(previousPanels[n] ?? []), oldName])];
        }
      }
      return { snap: { ...snap, ...next, createdAt: snap.createdAt, confirmed: promote ? false : snap.confirmed, previousPanels }, changed: promote ? undefined : changed, promote };
    }
    return { snap };
  }
  const { file, config } = loadConfig(o, project);
  const host = currentHost(o, config.tools);
  return { snap: makeSnapshot(config, { sets: o.set, mode: o.mode, host, off: roleList(o.off), on: roleList(o.on), source: file, project }) };
}

function encodeContext(snap) {
  const { roles, ...wire } = snap;
  return Buffer.from(JSON.stringify(wire)).toString('base64url');
}

function roleOf(snap, role, carrier, fresh = false) {
  const implementer = ['frontend', 'backend'].includes(role);
  if (fresh && (!implementer || carrier !== 'herdr')) throw new Error('票级新实现者用 spawn frontend|backend --fresh --cwd <本票 worktree>');
  const r = fresh ? resolveBindings(snap.roleConfig, snap.tools, snap.host)[role] : snap.roles[role];
  if (!r) throw new Error(`项目尚未配置 ${role}，用 $herdr-setup 补这一行，或用 --set 指定本轮配置`);
  if (r.enabled === false) throw new Error(`身份 ${role} 本轮未启用，可用 record update --on ${role}`);
  const anonymous = carrier === 'native' || carrier === 'background';
  if (carrier && r.carrier !== carrier && !(anonymous && r.carrier === 'auto')) {
    throw new Error(`身份 ${role} 使用 ${CARRIER[r.carrier] ?? r.carrier}`);
  }
  const problems = checkRole(role, { ...r, carrier: carrier ?? r.carrier }, snap.tools);
  if (problems.length) throw new Error(`身份 ${role} 配置有问题：${problems.join('；')}`);
  return r;
}

function requireDevelopmentApproval(snap, role) {
  if (role === 'wayfinder' && snap.mode !== 'complex') throw new Error('HMS 内使用 wayfinder，先用 record update --context C --mode complex 转团队');
  if (snap.mode === 'complex' && !snap.confirmed && ['pm', 'frontend', 'backend', 'merger'].includes(role)) {
    throw new Error('团队开发派工前，秘书须取得用户的配置确认');
  }
}

// ---------- 参数生成 ----------

export function renderPatch(tool, role, mode = 'interactive') {
  if (!tool.patch || (!isSet(role.model) && !isSet(role.effort))) return null;
  const selected = {};
  if (isSet(role.model)) {
    const slash = role.model.indexOf('/');
    if (slash <= 0 || slash === role.model.length - 1) throw new Error('模型需写成 provider/model');
    selected.provider = role.model.slice(0, slash);
    selected.model = role.model.slice(slash + 1);
  }
  if (isSet(role.effort)) selected.reasoningEffort = role.effort;
  if (tool.patch.adapter === 'dst') {
    const patch = [];
    if (selected.model) patch.push({ id: 'agent-default-model', config: selected });
    // TUI 的持久化选择优先于默认配置。只指定等级时也要保留原 provider/model。
    if (mode === 'interactive' || !selected.model) {
      patch.push({ insert: [{ id: 'hms-dst-selection', name: path.join(SKILL_DIR, 'scripts/dst-selection.mjs'), config: selected }] });
    }
    return JSON.stringify(patch);
  }
  const values = { provider: selected.provider, modelId: selected.model, effortValue: selected.reasoningEffort };
  if (!selected.model && tool.patch.template.includes('{provider}')) throw new Error('此补丁需要完整的 provider/model');
  return tool.patch.template.split('\n')
    .filter(line => [...line.matchAll(/\{(\w+)\}/g)].every(m => values[m[1]] !== undefined))
    .map(line => line.replace(/\{(\w+)\}/g, (_, key) => /^[\w./-]+$/.test(values[key]) ? values[key] : JSON.stringify(values[key])))
    .join('\n');
}

function launchValues(tool, role, mode) {
  let model = isSet(role.model) ? role.model : undefined;
  const effort = isSet(role.effort) ? role.effort : undefined;
  if (model && effort) {
    const variant = tool.modelWithEffort?.[mode];
    if (tool.modelVariants?.[model]?.[effort]) model = tool.modelVariants[model][effort];
    else if (variant) {
      if (variant === '{model}#{effort}') model = model.split('#')[0];
      model = variant.replaceAll('{model}', () => model).replaceAll('{effort}', () => effort);
    }
  }
  return { model, effort };
}

function settingValues(value, fields) {
  if (typeof value === 'string') {
    if ([...value.matchAll(/\{(model|effort)\}/g)].some(match => fields[match[1]] === undefined)) return undefined;
    return value.replace(/\{(model|effort)\}/g, (_, key) => fields[key]);
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => settingValues(item, fields));
  const entries = Object.entries(value).map(([k, v]) => [k, settingValues(v, fields)]).filter(([, v]) => v !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function buildArgv(tool, role, mode, ctx = {}) {
  tool = modeOptions(tool, mode);
  const tpl = tool[mode];
  if (!Array.isArray(tpl)) throw new Error(`工具没有 ${mode} 命令`);
  const fields = launchValues(tool, role, mode);
  const extra = role.args?.[mode] ?? [];
  const items = tpl.includes('{prompt}') ? tpl.flatMap(x => (x === '{prompt}' ? [...extra, x] : [x])) : [...tpl, ...extra];
  return items.flatMap(x => {
    if (x === '{model}' || x === '{effort}') {
      const field = x.slice(1, -1);
      return fields[field] ? (tool[field] ?? []).map(s => s.replaceAll('{value}', () => fields[field])) : [];
    }
    if (x === '{profile}') {
      const profile = fields.effort && tool.effortProfiles?.[fields.effort];
      return profile ? ['--profile', profile] : [];
    }
    if (x === '{patch}') return ctx.patchFile ? [tool.patch.flag ?? '--patch', ctx.patchFile] : [];
    if (x === '{settings}') return ctx.settingsFile ? [tool.settings.flag, ctx.settingsFile] : [];
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
  const tool = modeOptions(snap.tools[r.tool], mode);
  const sessionId = tool[mode].some(x => x.includes('{sessionId}')) ? crypto.randomUUID() : undefined;
  const patch = tool[mode].includes('{patch}') ? renderPatch(tool, r, mode) : null;
  const fields = launchValues(tool, r, mode);
  const settings = settingValues(tool.settings?.values, fields);
  const marker = '<HMS_CONFIG>';
  const argv = buildArgv(tool, r, mode, { prompt, sessionId, patchFile: patch && marker, settingsFile: settings && marker });
  argv[0] = executable(tool, argv[0]);
  const env = Object.entries(settingValues(tool.env, fields) ?? {}).map(([key, value]) => `${key}=${value}`);
  if (env.length) argv.unshift('env', ...env);
  if (patch || settings) {
    const spec = { base: tool.settings?.base, variable: tool.settings?.env, index: argv.indexOf(marker), content: patch || JSON.stringify(settings) };
    argv.unshift(process.execPath, path.join(SKILL_DIR, 'scripts/with-settings.mjs'), JSON.stringify(spec));
  }
  return { argv, sessionId, patch, command: shellJoin(argv) };
}

// ---------- 直接派工 ----------

function dispatchPrompt(snap, { role, task, parent, self, cwd, body }) {
  const roleFile = path.join(SKILL_DIR, 'roles', role + '.md');
  const projectRules = path.join(snap.project, 'AGENTS.md');
  const hms = 'node ' + shellQuote(HMS);
  const lines = [
    `${role} · ${task}`,
    fs.existsSync(roleFile) ? `职责：${roleFile}` : '职责见派工正文。',
    `Herdr 约定：${path.join(SKILL_DIR, 'AGENTS.md')}`,
    `HMS（${snap.mode === 'complex' ? '团队' : '简单'}模式）：${hms}　--context ${encodeContext(snap)}`,
  ];
  if (fs.existsSync(projectRules)) lines.push(`项目约定：${projectRules}`);
  if (cwd) lines.push(`本任务工作目录：${cwd}`);
  if (parent) {
    lines.push(`再派工用 --parent ${self}。结果直回发起者，状态可填 completed、blocked、failed。`,
      `${hms} notify --to ${parent} --task ${shellQuote(task)} --role ${shellQuote(role)} --status completed --summary '<结果>'`);
  } else {
    lines.push('直接返回结果给调用方。');
  }
  return [...lines, '', body].join('\n');
}

// ---------- Herdr ----------

function requireHerdr() {
  if (!onPath('herdr')) throw new Error('找不到 herdr 命令');
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
  if (!a.agent_status) return null;
  if (['dsh-tui', 'dst'].includes(a.agent) && !a.agent_session?.value) {
    const id = dstPanelSession(a.pane_id);
    if (id) return { ...a, agent_session: { value: id } };
  }
  return a;
}

function waitAgent(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = agentInfo(target);
    if (a && a.agent_status !== 'unknown') return a;
    if (Date.now() >= deadline) return null;
    sleep(500);
  }
}

// 面板地址随派工传递，避免焦点变化或继承的旧环境变量造成错投。
function panelAddress(agent, managed = false, task) {
  const binding = { pane: agent.pane_id, terminal: agent.terminal_id, session: agent.agent_session?.value, tool: agent.agent, managed, task };
  return 'hms:' + Buffer.from(JSON.stringify(binding)).toString('base64url');
}

function panelTarget(target, { allowShell = false } = {}) {
  const bound = target.startsWith('hms:') ? JSON.parse(Buffer.from(target.slice(4), 'base64url')) : null;
  const pane = bound ? bound.pane : target;
  const agent = agentInfo(pane);
  const live = agent ?? (allowShell && herdr(['pane', 'get', pane], { allowFail: true })?.result?.pane);
  if (!live?.pane_id) throw new Error(`面板 ${pane} 不可用，消息未送达`);
  if (bound && (live.pane_id !== bound.pane || (bound.terminal && live.terminal_id !== bound.terminal) ||
      (live.agent && bound.tool && live.agent !== bound.tool) ||
      (agent && (agent.agent_status !== 'unknown' || agent.agent) && bound.session && agent.agent_session?.value !== bound.session))) {
    throw new Error(`面板 ${pane} 的会话身份已变更`);
  }
  return { live, managed: bound?.managed === true, task: bound?.task };
}

function ancestorPids(pid = process.pid) {
  const ids = new Map();
  while (pid > 1 && !ids.has(pid)) {
    ids.set(pid, ids.size);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return ids;
}

function dstPanelSession(pane) {
  try {
    const info = herdr(['pane', 'process-info', '--pane', pane], { allowFail: true })?.result?.process_info;
    if (!info?.shell_pid) return;
    const servers = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-tui/inject/servers.json'), 'utf8'));
    const matches = servers.filter(entry => Number.isInteger(entry.pid) && typeof entry.sessionId === 'string' &&
      ancestorPids(entry.pid).has(info.shell_pid) && fs.statSync(entry.socketPath, { throwIfNoEntry: false })?.isSocket());
    if (matches.length === 1) return matches[0].sessionId;
  } catch { /* TUI 未暴露唯一会话时留空。 */ }
}

function dstHeader(sessionId, cwd) {
  if (!sessionId) return {};
  const read = spawnSync('dst', ['session', 'show', sessionId, '--output-format', 'json'], {
    cwd, encoding: 'utf8', timeout: 4000, maxBuffer: 8 * 1024 * 1024,
  });
  try {
    if (read.status !== 0) return {};
    const reply = JSON.parse(read.stdout);
    if (!reply.ok || reply.data?.session?.id !== sessionId) return {};
    const events = reply.data.events.slice(reply.data.inheritedEventCount ?? 0);
    const config = events.findLast(event => event.type === 'request/header')?.data?.header?.config;
    return config?.model ? { model: config.provider ? `${config.provider}/${config.model}` : config.model, effort: config.reasoningEffort } : {};
  } catch { return {}; }
}

function callerPanel(o) {
  const explicit = o.parent ? panelTarget(o.parent).live : undefined;
  if (!onPath('herdr')) return null;
  const agents = herdr(['agent', 'list'], { allowFail: true })?.result?.agents ?? [];
  const ancestors = ancestorPids();
  const matches = [];
  for (const a of agents) {
    const info = herdr(['pane', 'process-info', '--pane', a.pane_id], { allowFail: true })?.result?.process_info;
    if (!info) continue;
    const pids = [info.shell_pid, info.foreground_process_group_id, ...(info.foreground_processes ?? []).map(p => p.pid)];
    const distance = Math.min(...pids.map(pid => ancestors.get(pid) ?? Infinity));
    if (Number.isFinite(distance)) matches.push({ a, distance });
  }
  matches.sort((a, b) => a.distance - b.distance);
  if (matches.length && matches[0].distance !== matches[1]?.distance) {
    const pane = matches[0].a;
    if (explicit && explicit.pane_id !== pane.pane_id) throw new Error('--parent 与当前进程所属面板不一致');
    return explicit ?? agentInfo(pane.pane_id) ?? pane;
  }
  if (o.sessionId) {
    const matches = agents.filter(a => a.agent_session?.value === o.sessionId);
    if (matches.length === 1) {
      if (explicit && explicit.pane_id !== matches[0].pane_id) throw new Error('--parent 与发起会话 ID 不一致');
      return matches[0];
    }
  }
  return explicit ?? null;
}

function senderPanel(o) {
  const caller = callerPanel(o);
  if (caller) return caller;
  throw new Error('请用 --parent 传入已核对的发起者面板或其 address');
}

function currentHost(o, tools) {
  const pane = callerPanel(o);
  const inferred = process.env.CLAUDE_SESSION_ID ? 'claude-code' : process.env.CODEX_THREAD_ID ? 'codex' : undefined;
  const raw = pane?.agent || o.host || inferred;
  const tool = toolId(tools ?? {}, raw) ?? raw;
  const nativeId = tool === 'codex' ? process.env.CODEX_THREAD_ID : ['claude', 'claude-code'].includes(tool) ? process.env.CLAUDE_SESSION_ID : undefined;
  const meta = agentMetadata(pane);
  if (o.sessionId && meta.sessionId && o.sessionId !== meta.sessionId) throw new Error('指定会话 ID 与实际发起面板不一致');
  return { tool, observedTool: pane?.agent, sessionId: meta.sessionId || o.sessionId || nativeId,
    model: meta.model || o.hostModel, effort: meta.effort || o.hostEffort };
}

// ---------- 台账 ----------

const splitRow = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(s => s.trim());
const makeRow = cells => `| ${cells.map(cell).join(' | ')} |`;

function recordRows(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = splitRow(lines[0] ?? '');
  const separator = splitRow(lines[1] ?? '');
  if (header.length !== 4 || splitRow(LEDGER_HEAD).some((v, i) => header[i] !== v) ||
      separator.length !== 4 || !separator.every(v => /^:?-{3,}:?$/.test(v)) ||
      lines.slice(2).some(l => !l.trimStart().startsWith('|') || splitRow(l).length !== 4)) {
    throw new Error('会话记录必须只有四列表格；旧归档请保留，另起新一轮记录');
  }
  return lines.slice(2).map(splitRow);
}

function recordPath(snap, file = snap.record) {
  if (snap.mode !== 'complex') return null;
  if (!file) throw new Error('缺少团队成员表，请使用 hms init --mode complex 返回的 context');
  const abs = path.resolve(file);
  if (path.dirname(abs) !== path.join(snap.project, '.agents/herdr') || !/^\d{8}-\d{6}-.+\.md$/.test(path.basename(abs))) {
    throw new Error('会话表必须是 <项目>/.agents/herdr/<时间戳>-<recap标题>.md');
  }
  recordRows(abs);
  return abs;
}

function appendRecord(file, cells) {
  recordRows(file);
  // 每行用一次 O_APPEND 写入，多个匿名调用并行回报时不会覆盖彼此。
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, `${makeRow(cells)}\n`); }
  finally { fs.closeSync(fd); }
}

const sessionCells = (r, meta = {}) => [meta.sessionId || '未取得', meta.observedTool || r.tool, isSet(meta.model) ? meta.model : '未核实', isSet(meta.effort) ? meta.effort : '未核实'];
function agentMetadata(a) {
  const sessionId = a?.agent_session?.value;
  const header = ['dst', 'dsh-tui'].includes(a?.agent) ? dstHeader(sessionId, a.foreground_cwd || a.cwd) : {};
  return { observedTool: a?.agent, sessionId, model: header.model || a?.agent_model?.value, effort: header.effort || a?.agent_effort?.value };
}

function afterFirstPrompt(agent) {
  const initial = agent.agent_session?.value;
  const agy = ['agy', 'gemini', 'antigravity_cli'].includes(agent.agent);
  let live = agentInfo(agent.pane_id) ?? agent;
  for (let n = 0; agy && n < 10 && (!live.agent_session?.value || live.agent_session.value === initial); n++) {
    sleep(500);
    live = agentInfo(agent.pane_id) ?? live;
  }
  // agy 可在空面板上保留前一会话 ID，收到第一条任务才分配新 ID。
  if (agy && initial && live.agent_session?.value === initial) {
    return { ...live, agent_session: undefined, agent_model: undefined, agent_effort: undefined };
  }
  return live;
}

export function executionMetadata(stdout = '', stderr = '', tool) {
  const meta = {};
  if (tool && !['codex', 'claude-code', 'gemini', 'dsh'].includes(tool)) return meta;
  let events;
  try { events = [JSON.parse(stdout)]; }
  catch { events = stdout.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); }
  for (const e of events) {
    if (tool === 'gemini') {
      const agy = e?.type === 'result' ? e.result : e;
      if ((!e?.type || ['init', 'result'].includes(e.type)) && typeof agy?.conversation_id === 'string' && agy.conversation_id) meta.sessionId = agy.conversation_id;
      continue;
    }
    if ((tool === 'dsh' || !tool) && e?.type === 'result' && e.schemaVersion === 1 && e.ok === true && typeof e.sessionId === 'string') meta.sessionId = e.sessionId;
    if ((!tool || tool === 'claude-code') && e?.type === 'system' && e.subtype === 'init') {
      meta.sessionId = e.session_id ?? meta.sessionId;
      meta.model = e.model ?? meta.model;
    }
    if ((!tool || tool === 'claude-code') && e?.type === 'result') {
      meta.sessionId = e.session_id ?? meta.sessionId;
      const models = Object.keys(e.modelUsage ?? {});
      if (models.length) meta.model = models.join(', ');
    }
    if (tool && tool !== 'codex') continue;
    if (e?.type === 'thread.started') meta.sessionId = e.thread_id;
    if (e?.type === 'session_meta') meta.sessionId = e.payload?.id ?? meta.sessionId;
    if (e?.type === 'turn_context') {
      meta.model = e.payload?.model ?? meta.model;
      meta.effort = e.payload?.effort ?? e.payload?.reasoning_effort ?? meta.effort;
    }
  }
  // Codex 非 JSON 模式的启动头；不从模型生成的正文猜测自身身份。
  for (const [key, label] of tool && tool !== 'codex' ? [] : [['sessionId', 'session id'], ['model', 'model'], ['effort', 'reasoning effort']]) {
    const m = new RegExp(`^${label}:\\s*(\\S+)\\s*$`, 'm').exec(stderr);
    if (m && !meta[key]) meta[key] = m[1];
  }
  return meta;
}

// ---------- 命令 ----------

function cmdResolve(o) {
  const { snap, changed } = snapshotFrom(o, projectRoot(o));
  const problems = developmentProblems(snap);
  out(o.json ? snap : `${snapshotTable(snap, changed)}\n\n模式：${snap.mode}　配置来源：${snap.configSource ?? '本轮配置'}`);
  if (problems.length) {
    process.stderr.write(problems.join('\n') + '\n');
    process.exitCode = 2;
  }
}

function cmdArgv(o) {
  const role = o._[1];
  need({ role }, 'role');
  const { snap } = snapshotFrom(o, projectRoot(o));
  const r = roleOf(snap, role, o.headless ? 'background' : 'herdr', o.fresh);
  const { argv, command, patch } = prepareArgv(snap, r, o.headless ? 'headless' : 'interactive', o.headless ? '<派工正文>' : undefined);
  out({ role, tool: r.tool, model: r.model, effort: r.effort, argv, shell: command, patch });
}

function singletonRole(mode, role) {
  return (mode === 'simple' && role === 'frontend') || (mode === 'complex' && role === 'pm');
}

function singletonName(roundId, role, config) {
  const key = JSON.stringify([roundId, role, config.tool, config.model, config.effort]);
  return `hms-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}-${role}`;
}

function panelDirectory(agent) {
  const info = herdr(['pane', 'process-info', '--pane', agent.pane_id], { allowFail: true })?.result?.process_info;
  if (info?.foreground_cwd) return info.foreground_cwd;
  for (const process of info?.foreground_processes ?? []) {
    if (process.pid !== info.foreground_process_group_id) continue;
    if (process.cwd) return process.cwd;
    try { return fs.readlinkSync(`/proc/${process.pid}/cwd`); } catch { /* Herdr 元数据仍可提供目录。 */ }
  }
  return agent.foreground_cwd || agent.cwd;
}

function cmdSpawn(o) {
  requireHerdr();
  const role = o._[1];
  need({ role, ...o }, 'role', 'task', 'prompt', 'context');
  const { snap } = snapshotFrom(o, projectRoot(o));
  requireDevelopmentApproval(snap, role);
  if (o.fresh) need(o, 'cwd');
  const r = roleOf(snap, role, 'herdr', o.fresh);
  const record = recordPath(snap);
  const parent = senderPanel(o);
  const parentAddress = panelAddress(parent, false, o.task);
  const singleton = !o.fresh && singletonRole(snap.mode, role);
  const name = singleton ? singletonName(snap.roundId, role, r) : (o.name ?? `hms-${crypto.randomUUID().slice(0, 8)}`);
  if (!NAME_RE.test(name)) throw new Error('面板名须匹配 [a-z][a-z0-9_-]{0,31}');

  // 并发首次派工复用同一面板。简单模式锁已有项目目录，无需创建文件。
  const lock = record ?? snap.project;
  if (singleton && process.env.HMS_SINGLETON_LOCK !== lock && onPath('flock')) {
    const child = spawnSync('flock', ['--exclusive', lock, process.execPath, HMS, ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, HMS_SINGLETON_LOCK: lock },
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }

  const formerPanels = new Set(snap.previousPanels?.[role] ?? []);
  if (role === 'pm') for (const name of snap.previousPanels?.frontend ?? []) formerPanels.add(name);
  for (const former of formerPanels) {
    const old = former !== name && agentInfo(former);
    if (old) throw new Error(`旧面板 ${old.pane_id} 仍在使用，交接后用 close ${panelAddress(old, true)} 再启用新配置`);
  }
  let agent = agentInfo(name);
  const reused = Boolean(agent);
  if (reused && !singleton) throw new Error(`面板名 ${name} 已使用`);
  const actualCwd = reused && panelDirectory(agent);
  if (reused && o.cwd && (!actualCwd || fs.realpathSync(o.cwd) !== fs.realpathSync(actualCwd))) {
    throw new Error(`面板仍在 ${actualCwd || '未知目录'}。本票新实现者用 spawn --fresh --cwd；普通面板请先完成交接再重开`);
  }
  const cwd = reused ? actualCwd : path.resolve(o.cwd ?? process.cwd());
  let pane = agent?.pane_id;
  let tab = agent?.tab_id ?? parent.tab_id;
  if (!reused) {
    const { command } = prepareArgv(snap, r, 'interactive');
    if ((o.place ?? r.place ?? 'split') === 'tab') {
      const workspace = parent.workspace_id ?? parent.pane_id.split(':')[0];
      const res = herdr(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', name, '--no-focus']).result;
      pane = res?.root_pane?.pane_id ?? res?.root_pane;
      tab = res?.tab?.tab_id;
    } else {
      const res = herdr(['pane', 'split', '--pane', parent.pane_id, '--direction', o.direction ?? 'right', '--cwd', cwd, '--no-focus']).result;
      pane = res?.pane?.pane_id;
    }
    if (!pane) throw new Error('Herdr 没有返回新面板 ID');
    try {
      const launch = r.tool === 'dsh' ? shellJoin(['env', 'HERDR_ENV=1', 'HERDR_BIN_PATH=herdr', 'HERDR_PANE_ID=' + pane]) + ' ' + command : command;
      herdr(['pane', 'run', pane, launch]);
      agent = waitAgent(pane, Number(o.startTimeout ?? 60000));
      if (!agent) throw new Error('Herdr 尚未识别 agent');
      herdr(['agent', 'rename', pane, name]);
    } catch (err) {
      if (record) appendRecord(record, sessionCells(r, agentMetadata(agent)));
      const created = agent ?? herdr(['pane', 'get', pane], { allowFail: true })?.result?.pane ?? { pane_id: pane };
      throw new Error(`${err.message}。已创建面板 ${pane}，派工未送达；管理地址 ${panelAddress(created, true)}`);
    }
  }

  const report = { role, task: o.task, name, pane, tab, cwd, tool: r.tool, model: r.model, effort: r.effort, record, reused };
  try {
    const address = panelAddress(reused ? agent : { ...agent, agent_session: undefined }, true);
    const prompt = dispatchPrompt(snap, { role, task: o.task, parent: parentAddress, self: address, cwd, body: o.prompt });
    if (agent.agent_status === 'blocked') {
      report.delivered = false;
      report.prompt = prompt;
      report.note = '面板等待交互，处理后用 prompt 将完整正文补发到 address';
      if (!reused && r.tool === 'gemini') agent = { ...agent, agent_session: undefined, agent_model: undefined, agent_effort: undefined };
    } else {
      herdr(['agent', 'prompt', pane, prompt]);
      report.delivered = true;
      if (!reused) agent = afterFirstPrompt(agent);
    }
  } catch (err) {
    throw new Error(`${err.message}。面板 ${pane} 的管理地址 ${panelAddress(agent, true)}`);
  } finally {
    if (record && !reused) appendRecord(record, sessionCells(r, agentMetadata(agent)));
  }
  out({ ...report, address: panelAddress(agent, true), sessionId: agent.agent_session?.value ?? null });
}

function cmdPrompt(o) {
  requireHerdr();
  const target = o._[1];
  need({ target, ...o }, 'target', 'prompt');
  const { live } = panelTarget(target);
  if (live.agent_status === 'blocked') throw new Error(`${live.pane_id} 正在等待交互`);
  herdr(['agent', 'prompt', live.pane_id, o.prompt]);
  out({ target: live.pane_id, delivered: true });
}

function cmdNative(o) {
  const role = o._[1];
  need({ role, ...o }, 'role', 'caller', 'task', 'prompt', 'context');
  const { snap } = snapshotFrom(o, projectRoot(o));
  requireDevelopmentApproval(snap, role);
  const r = roleOf(snap, role, 'native', o.fresh);
  const caller = currentHost({ host: o.caller, hostModel: o.callerModel }, snap.tools);
  const callerModel = caller.model || (caller.sessionId && caller.sessionId === snap.host.sessionId ? snap.host.model : undefined);
  if (r.tool !== caller.tool || !isSet(r.model) || r.model !== callerModel) throw new Error('仅同工具同型号可走原生；宿主型号可用 --caller-model 提供，其他情况用 run');
  const record = recordPath(snap);
  const cwd = path.resolve(o.cwd ?? process.cwd());
  out({ role, tool: r.tool, model: r.model, effort: r.effort, cwd, record,
    prompt: dispatchPrompt(snap, { role, task: o.task, cwd, body: o.prompt }) });
}

function cmdRun(o) {
  const role = o._[1];
  need({ role, ...o }, 'role', 'task', 'prompt', 'context');
  const { snap } = snapshotFrom(o, projectRoot(o));
  requireDevelopmentApproval(snap, role);
  const r = roleOf(snap, role, 'background', o.fresh);
  const record = recordPath(snap);
  const prompt = dispatchPrompt(snap, { role, task: o.task, body: o.prompt });
  const prepared = prepareArgv(snap, r, 'headless', prompt);
  let argv = prepared.argv;
  if (o.lock) {
    // 锁住已有共享目录，跨任务互斥且不创建 lock/owner 文件。
    const dir = path.resolve(o.lock);
    if (!fs.statSync(dir).isDirectory()) throw new Error('--lock 必须指向已有共享目录（如 git common dir）');
    argv = ['flock', '--exclusive', '--wait', String(Number(o.lockTimeout ?? 1800000) / 1000), dir, ...argv];
  }
  let res;
  let meta = {};
  try {
    res = spawnSync(argv[0], argv.slice(1), {
      cwd: path.resolve(o.cwd ?? process.cwd()), encoding: 'utf8',
      input: snap.tools[r.tool].promptInput === 'stdin' ? prompt : undefined,
      maxBuffer: Infinity, timeout: o.timeoutMin ? Number(o.timeoutMin) * 60000 : undefined,
    });
    meta = executionMetadata(res.stdout ?? '', res.stderr ?? '', snap.tools[r.tool].metadata ?? r.tool);
    if (record && r.tool === 'dsh') Object.assign(meta, dstHeader(meta.sessionId, path.resolve(o.cwd ?? process.cwd())));
  } finally {
    if (record) appendRecord(record, sessionCells(r, meta));
  }
  const exit = res.error ? null : res.status;
  out({ role, task: o.task, tool: r.tool, model: r.model, effort: r.effort, sessionId: meta.sessionId ?? null,
    exit, signal: res.signal ?? null, error: res.error?.message ?? null, stdout: res.stdout ?? '', stderr: res.stderr ?? '', record });
  process.exitCode = exit ?? 1;
}

function cmdNotify(o) {
  need(o, 'to', 'task', 'role', 'status', 'summary');
  if (!STATUSES.has(o.status)) throw new Error('--status 取 completed、blocked、failed');
  requireHerdr();
  const text = `HERDR_RESULT task=${o.task} status=${o.status} role=${o.role}${o.result ? ' result=' + o.result : ''} summary=${o.summary}`;
  const waitMs = Number(o.waitMs ?? 60000);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--wait-ms 需要非负毫秒数');
  const deadline = Date.now() + Math.min(waitMs, 60000);
  for (;;) {
    const { live, task } = panelTarget(o.to);
    if (!task) throw new Error('回报需使用派工正文中绑定任务的 --to 地址；旧任务可核对发起者后用 prompt 补发');
    if (task !== o.task) throw new Error(`回报任务 ${o.task} 与派工 ${task} 不符，未送达`);
    if (live.agent_status !== 'blocked') {
      const sent = spawnSync('herdr', ['agent', 'prompt', live.pane_id, text], { encoding: 'utf8', timeout: waitMs ? Math.max(1, deadline - Date.now()) : 5000 });
      if (sent.status === 0) { out({ delivered: true, to: live.pane_id, task: o.task }); return; }
      if (sent.error?.code === 'ETIMEDOUT') throw new Error('Herdr 提交回执超时，先核对发起者是否已收到本任务结果');
      const reason = sent.error?.message || sent.stderr || sent.stdout || 'Herdr 未返回回执';
      if (!reason.includes('agent_blocked')) throw new Error(`回报未送达：${reason.trim()}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`发起者面板仍在等待交互，回报未送达。保留本面板和任务 ${o.task} 的结果，稍后重发`);
    sleep(Math.min(1000, remaining));
  }
}

function cmdClose(o) {
  requireHerdr();
  const target = o._[1];
  need({ target }, 'target');
  let { live, managed } = panelTarget(target, { allowShell: true });
  if (!managed && !o.takeover) throw new Error('借用面板保留；已明确移交管理时可用 --takeover');
  if (live.agent_status === 'working' && !o.force) {
    herdr(['agent', 'wait', live.pane_id, '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', '60000'], { allowFail: true });
    live = panelTarget(target, { allowShell: true }).live;
  }
  if (['working', 'blocked'].includes(live.agent_status) && !o.force) throw new Error(`agent 状态为 ${live.agent_status}，保留面板；处理完本回合后再关闭`);
  herdr(['pane', 'close', live.pane_id]);
  out({ closed: live.pane_id });
}

function cmdLs(o) {
  requireHerdr();
  need(o, 'record');
  out({ sessions: recordRows(path.resolve(o.record)), live: herdr(['agent', 'list']) });
}

function developmentProblems(snap) {
  const issues = Object.entries(snap.roles).flatMap(([n, r]) => checkRole(n, r, snap.tools, snap.host).map(p => `${n}: ${p}`));
  if (snap.mode === 'complex' && (!snap.roles.pm || snap.roles.pm.enabled === false || snap.roles.pm.carrier !== 'herdr')) {
    issues.unshift('团队开发需要一个已配置的显式 PM。请补 pm 的工具、模型和等级');
  }
  for (const n of snap.required ?? []) if (!snap.roles[n] && n !== 'pm') issues.push(`本轮需要 ${n}，请补该身份的工具、型号和等级`);
  return issues;
}

function confirmSnap(snap, note) {
  if (snap.mode === 'complex') {
    const issues = developmentProblems(snap);
    if (issues.length) throw new Error(issues.join('；'));
  }
  return { ...snap, confirmed: true, confirmedAt: nowIso(), confirmation: oneLine(note) };
}

function createTeamRecord(snap, title, promote) {
  const dir = path.join(snap.project, '.agents/herdr');
  fs.mkdirSync(dir, { recursive: true });
  const cells = sessionCells({ tool: snap.host.tool || '未核实' }, snap.host);
  const template = fs.readFileSync(path.join(SKILL_DIR, 'templates/session-log.md'), 'utf8');
  // 同一个简单 context 重试升级时，仍指向它自己的团队表。
  const suffix = promote ? '-' + crypto.createHash('sha256').update(snap.roundId).digest('hex').slice(0, 12) : '';
  const base = `${stamp(new Date(snap.createdAt))}-${title}${suffix}`;
  const draft = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(draft, `${template.trimEnd()}\n${makeRow(cells)}\n`, { flag: 'wx' });
    for (let n = 1; ; n++) {
      const record = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}.md`);
      try { fs.linkSync(draft, record); return record; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (promote) return recordPath(snap, record);
      }
    }
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

function initRound(o) {
  const { snap: initial, changed, promote } = snapshotFrom(o, projectRoot(o));
  if ((initial.mode === 'complex' && initial.confirmed && changed?.length) || o._[1] === 'confirm') need(o, 'confirmed');
  const snap = o.confirmed ? confirmSnap(initial, o.confirmed) : initial;
  const title = sanitizeTitle(snap.title ?? o.title ?? o.recap ?? '团队');
  let record = null;
  if (snap.mode === 'complex') {
    const existing = promote ? null : snap.record ?? o.record;
    record = existing ? recordPath(snap, existing) : createTeamRecord(snap, title, promote);
  }
  const roundId = snap.roundId ?? record ?? crypto.randomUUID();
  out({ record, context: encodeContext({ ...snap, roundId, title, record }), confirmed: snap.confirmed, changed });
}

function recordAdd(o) {
  need(o, 'tool');
  // 表路径本身无法区分历史简单模式和团队。脱离 context 补登须明示团队模式。
  if (!o.context && o.mode !== 'complex') return out({ record: null, added: false });
  if (!o.context) need(o, 'record');
  const snap = o.context ? snapshotFrom(o, projectRoot(o)).snap
    : { mode: 'complex', project: path.resolve(path.dirname(o.record), '../..') };
  const record = recordPath(snap, o.record ?? snap.record);
  if (!record) return out({ record: null, added: false });
  appendRecord(record, sessionCells({ tool: o.tool }, { sessionId: o.sessionId, model: o.model, effort: o.effort }));
  out({ record, added: true });
}

function cmdRecord(o) {
  const action = o._[1];
  if (action === 'add') return recordAdd(o);
  if (!['init', 'confirm', 'update'].includes(action)) throw new Error('用法：hms record init|confirm|update|add ...');
  if (action !== 'init' && !(o.mode === 'complex' && o.record)) need(o, 'context');
  return initRound(o);
}

const HELP = `hms — Herdr 角色调度

  config [--project DIR]                                查询项目激活状态
  resolve [--mode simple|complex] [--host T --host-model M --host-effort E] [--set role.field=value] [--on a,b] [--off a,b]
  resolve --context C --set role.model=M                 仅展示受影响的身份
  init [--title 简称] [同 resolve 的配置] [--session-id ID] [--confirmed 用户答复]
                                                        返回本轮 context，团队模式才建成员表
  record confirm --context C --confirmed 用户答复         确认本轮配置，返回新 context
  record update --context C [--mode complex] [--set ...] [--on a,b] [--off a,b] [--confirmed 用户答复]
  record add --context C --tool T [--session-id ID --model M --effort E]
  spawn ROLE --context C --task ID --prompt 正文 [--parent PANE或地址] [--fresh --cwd DIR]
  prompt PANE或地址 --prompt 正文
  native ROLE --context C --caller 宿主工具 [--caller-model M] --task ID --prompt 正文 [--cwd DIR]
  run ROLE --context C --task ID --prompt 正文 [--cwd DIR] [--lock 目录]
  notify --to 地址 --task ID --role ROLE --status completed|blocked|failed --summary 正文 [--wait-ms 0..60000]
  close 地址 [--force]                                   移交管理的既有面板用 close PANE --takeover
  ls --record 表路径
  argv ROLE [--context C] [--headless] [--fresh]          预览实际工具命令

--fresh 用项目的 frontend 或 backend 配置，在本票 worktree 开显式新面板。--project DIR 指定主项目。`;

export function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  const table = { init: initRound, resolve: cmdResolve, argv: cmdArgv, spawn: cmdSpawn, prompt: cmdPrompt, native: cmdNative, run: cmdRun, notify: cmdNotify, close: cmdClose, ls: cmdLs, record: cmdRecord };
  if (!cmd || o.help || cmd === 'help') return out(HELP);
  if (cmd === 'config') {
    const project = o.context ? snapshotFrom(o, projectRoot(o)).snap.project : projectRoot(o);
    const { file, active } = readRouting(projectConfigPath(project));
    return out(active ? { active, file } : { active, file, nextSkill: 'herdr-setup', skillFile: path.join(SETUP_DIR, 'SKILL.md') });
  }
  for (const key of ['snapshot', 'write', 'brief', 'file', 'out', 'inbox']) {
    if (o[key] !== undefined) throw new Error(`不再支持 --${key} 文件通信；使用 --context / --prompt 直接传递正文，输出直接返回调用方`);
  }
  if (!table[cmd]) throw new Error(`未知命令 ${cmd}；运行 hms help 查看用法`);
  return table[cmd](o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`hms: ${e.message}\n`);
    process.exitCode = 1;
  }
}
