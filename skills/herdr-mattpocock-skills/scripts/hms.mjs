#!/usr/bin/env node
// herdr-mattpocock-skills 的机械操作脚本：解析职责配置、生成 CLI 参数、开关 Herdr 面板、
// 匿名执行、回报、团队执行记录与恢复。这里没有任何工作流逻辑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandProblems, configuredRoles, configuredTools, isSet, modeOptions, projectConfigPath, projectRoot, readRouting, toolId } from './routing.mjs';
import { isShortReference, loadReference, saveReference } from './references.mjs';
import * as store from './store.mjs';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_DIR = path.join(path.dirname(SKILL_DIR), 'herdr-setup');
const HMS = path.join(SKILL_DIR, 'scripts', 'hms.mjs');
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SESSION_UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DEFAULT_MAIN = ['secretary', 'pm', 'backend'];
const PANEL_ROLES = new Set(['pm', 'frontend', 'backend', 'wayfinder', 'spec-writer']);
const ROLE_USE = {
  secretary: '用户沟通与建图', pm: '团队派工与收尾', wayfinder: '一张决策票', 'spec-writer': '规格与工单',
  frontend: '前端实现', backend: '后端实现', searcher: '搜索与研究',
  reviewer: '审查', designer: '独立方案', merger: '授权合并',
};
const CARRIER = { current: '当前会话', herdr: 'Herdr 面板', auto: '匿名，优先原生', background: '匿名 CLI', native: '宿主原生 subagent' };
const STATUSES = new Set(['completed', 'blocked', 'failed']);
const INDEX_TITLE = '# HMS 会话索引';
const RECORD_COLUMNS = ['会话 ID', 'Agent 工具', '实际模型', '思考等级', '身份'];
const LEGACY_RECORD_DIR = '.agents/herdr';
const RECORD_DIR = `${LEGACY_RECORD_DIR}/session`;
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
  const tools = { ...configuredTools(registered) };
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
    const defaults = { carrier: PANEL_ROLES.has(name) ? 'herdr' : 'auto' };
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
    if (o.context.startsWith('ctx:')) {
      snap = loadReference(o.context);
    } else {
      try { snap = JSON.parse(Buffer.from(o.context, 'base64url').toString('utf8')); }
      catch { throw new Error('--context 需要本轮配置 ID'); }
    }
    if (![3, 4, 5, 6].includes(snap?.schemaVersion) || !(snap.roleConfig || snap.roles) || !snap.tools || !snap.project) throw new Error('--context 格式不完整');
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
    snap.roleConfig = configuredRoles({ roles: snap.roleConfig, tools: snap.tools });
    snap.tools = configuredTools(snap.tools);
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

function saveContext(snap) {
  const { roles, ...wire } = snap;
  return saveReference('ctx', wire);
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

function launchSnapshot(snap, role, { routeFrom, headless, fresh }) {
  if (routeFrom === undefined) return snap;
  if (role !== 'wayfinder' || headless || fresh) {
    throw new Error('--route-from 用于 argv wayfinder 和 spawn wayfinder 的显式面板');
  }
  const { config } = loadConfig({}, snap.project);
  const tools = configuredTools(config.tools);
  const route = resolveBindings(configuredRoles(config), tools, snap.host)[routeFrom];
  if (!route?.tool) throw new Error(`项目角色 ${routeFrom} 没有可借用的启动配置`);
  const { tool, model, effort } = route;
  const target = snap.roles[role];
  return { ...snap, tools, roles: { ...snap.roles, [role]: target && { ...target, tool, model, effort } } };
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

function dispatchPrompt(snap, { context, role, task, parent, self, cwd, body }) {
  const roleFile = path.join(SKILL_DIR, 'roles', role + '.md');
  const duties = /^[a-z][\w-]*$/.test(role) && fs.existsSync(roleFile)
    ? fs.readFileSync(roleFile, 'utf8').replace(/^#[^\r\n]*\r?\n/, '').trim()
    : '';
  const projectRules = path.join(snap.project, 'AGENTS.md');
  const hms = 'node ' + shellQuote(HMS);
  const lines = [`${role} · ${task}`];
  if (duties) lines.push(duties);
  if (fs.existsSync(projectRules)) lines.push(`仅当任务属于该主仓或其 worktree 且宿主尚未加载时读 ${projectRules}。`);
  if (cwd) lines.push(`本任务工作目录：${cwd}`);
  const id = context.startsWith('ctx:') ? context : saveContext(snap);
  lines.push(`如需再派工，用 ${hms}，沿用 --context ${id}`);
  if (self) lines.push(`显式再派工加 --parent ${self}`);
  lines.push(`仅在需要调度且当前上下文缺少命令用法时读 ${path.join(SKILL_DIR, 'SKILL.md')}。`);
  if (parent) {
    lines.push('执行后直回发起者，状态可填 completed、blocked、failed。',
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

function herdr(args, { socket, allowFail = false, timeout } = {}) {
  const env = { ...process.env };
  if (args[0] === 'session' && args[1] === 'list') {
    delete env.HERDR_SOCKET_PATH;
    delete env.HERDR_SESSION;
  }
  if (socket) {
    env.HERDR_SOCKET_PATH = socket;
    delete env.HERDR_SESSION;
  }
  const r = spawnSync('herdr', args, { env, encoding: 'utf8', timeout });
  const ok = !r.error && r.status === 0;
  const text = (ok ? r.stdout : r.stderr || r.stdout)?.trim() ?? '';
  let reply = {};
  if (text) {
    if (args[0] === 'pane' && args[1] === 'read') reply = { raw: text };
    else {
      try { reply = JSON.parse(text); } catch { reply = { raw: text }; }
    }
  }
  if (ok) return reply;
  if (allowFail) return null;
  const reason = r.error?.message || reply?.error?.message || text || 'Herdr 未返回回执';
  const error = new Error(`herdr ${args.slice(0, 2).join(' ')}${socket ? ` (${socket})` : ''} 失败：${reason}`);
  error.code = r.error?.code ?? reply?.error?.code;
  throw error;
}

function herdrSessions() {
  const sessions = herdr(['session', 'list', '--json'], { allowFail: true })?.sessions ?? [];
  return sessions.filter(s => s.running && path.isAbsolute(s.socket_path ?? ''));
}

function inheritedSocket() {
  const socket = process.env.HERDR_SOCKET_PATH;
  if (socket) return path.resolve(socket);
  const name = process.env.HERDR_SESSION;
  return name ? herdrSessions().find(s => s.name === name)?.socket_path : undefined;
}

function selectedSocket(o, ref) {
  if (!o.herdrSession) return ref?.socket;
  const socket = herdrSessions().find(s => s.name === o.herdrSession)?.socket_path;
  if (!socket) throw new Error(`Herdr 会话 ${o.herdrSession} 未运行或不可用；用 herdr session list 核对名称`);
  if (ref?.socket && ref.socket !== socket) {
    throw new Error(`--herdr-session ${o.herdrSession} (${socket}) 与面板地址的 socket ${ref.socket} 不一致`);
  }
  return socket;
}

function agentInfo(socket, target) {
  const res = herdr(['agent', 'get', target], { socket, allowFail: true })?.result;
  if (!res) return null;
  const a = typeof res.agent === 'object' && res.agent !== null ? res.agent : res;
  if (!a.agent_status) return null;
  if (['dsh-tui', 'dst'].includes(a.agent) && !a.agent_session?.value) {
    const id = dstPanelSession(socket, a.pane_id);
    if (id) return { ...a, agent_session: { value: id } };
  }
  return a;
}

function waitAgent(socket, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = agentInfo(socket, target);
    if (a?.agent && ['idle', 'done', 'blocked'].includes(a.agent_status)) return a;
    if (Date.now() >= deadline) return null;
    sleep(500);
  }
}

// 面板地址随派工传递，避免焦点变化或继承的旧环境变量造成错投。
function panelAddress(socket, agent, managed = false, task, pendingMember, tracking) {
  const binding = { socket, pane: agent.pane_id, terminal: agent.terminal_id,
    session: pendingMember ? undefined : agent.agent_session?.value, tool: agent.agent, managed, task, pendingMember, ...tracking };
  return saveReference('hms', binding);
}

function panelRef(target) {
  if (!target.startsWith('hms:')) return { pane: target };
  let ref;
  if (isShortReference(target)) {
    ref = loadReference(target);
  } else {
    try { ref = JSON.parse(Buffer.from(target.slice(4), 'base64url')); }
    catch { throw new Error('HMS 面板地址格式无效'); }
  }
  if (!ref?.pane || typeof ref.pane !== 'string' ||
      (ref.socket !== undefined && (typeof ref.socket !== 'string' || !path.isAbsolute(ref.socket)))) {
    throw new Error('HMS 面板地址缺少有效的面板 ID 或包含无效的 socket 路径');
  }
  return { ...ref, bound: true };
}

function panelTarget(socket, ref, { allowShell = false } = {}) {
  const { pane } = ref;
  const agent = agentInfo(socket, pane);
  const live = agent ?? (allowShell && herdr(['pane', 'get', pane], { socket, allowFail: true })?.result?.pane);
  if (!live?.pane_id) throw new Error(`面板 ${pane} 在 Herdr socket ${socket} 不可用，消息未送达`);
  const sessionId = agent && (agent.agent_status !== 'unknown' || agent.agent) ? agent.agent_session?.value ?? null : undefined;
  checkPanelBinding(socket, ref, live, sessionId);
  return live;
}

function checkPanelBinding(socket, ref, live, sessionId) {
  if (ref.bound && (live.pane_id !== ref.pane || (ref.terminal && live.terminal_id !== ref.terminal) ||
      (live.agent && ref.tool && live.agent !== ref.tool) || (sessionId !== undefined && ref.session && sessionId !== ref.session))) {
    throw new Error(`Herdr socket ${socket} 的面板 ${ref.pane} 会话身份已变更`);
  }
}

function ancestorPids(pid = process.pid, stopAtCodexServer = false) {
  const ids = new Map();
  while (pid > 1 && !ids.has(pid)) {
    try {
      if (stopAtCodexServer) {
        const [exe, ...args] = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (path.basename(exe) === 'codex' && args.includes('app-server')) break;
      }
      ids.set(pid, ids.size);
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return ids;
}

function paneProcessInfo(socket, pane) {
  return herdr(['pane', 'process-info', '--pane', pane], { socket, allowFail: true })?.result?.process_info;
}

function claudePanelSession(socket, pane) {
  const profile = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const processes = paneProcessInfo(socket, pane)?.foreground_processes ?? [];
  const ids = new Set();
  for (const { pid } of processes) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      const session = JSON.parse(fs.readFileSync(path.join(profile, 'sessions', `${pid}.json`), 'utf8'));
      if (session.pid !== pid || session.kind !== 'interactive' || !SESSION_UUID_RE.test(session.sessionId ?? '')) continue;
      if (process.platform === 'linux' && session.procStart) {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (String(session.procStart) !== stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) continue;
      }
      ids.add(session.sessionId);
    } catch { /* 该进程未提供可核对的 Claude 会话。 */ }
  }
  if (ids.size === 1) return ids.values().next().value;
}

function codexStatusFields(visible) {
  return visible?.split(/\r?\n/).map(line => line.trim().split(' · ')) ?? [];
}

function dstPanelSession(socket, pane) {
  try {
    const info = paneProcessInfo(socket, pane);
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

function agentList(socket) {
  return herdr(['agent', 'list'], { socket, allowFail: true })?.result?.agents ?? [];
}

export function findCodexPanel(threadId) {
  if (!SESSION_UUID_RE.test(threadId ?? '')) return null;
  const deadline = Date.now() + 5_000;
  const query = (args, socket) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('核对 Codex 面板超时');
    return herdr(args, { socket, timeout: Math.min(remaining, 1_500) });
  };
  const { sessions } = query(['session', 'list', '--json']);
  if (!Array.isArray(sessions)) throw new Error('Herdr 未返回会话列表，无法核对 Codex 面板');
  let match;
  for (const { name, socket_path: socket, running } of sessions) {
    if (!running) continue;
    if (!path.isAbsolute(socket ?? '')) throw new Error(`Herdr 会话 ${name} 缺少可核对的 socket`);
    const agents = query(['agent', 'list'], socket).result?.agents;
    if (!Array.isArray(agents)) throw new Error(`Herdr 会话 ${name} 未返回 agent 列表`);
    for (const live of agents) {
      if (live.agent !== 'codex') continue;
      const { raw } = query(['pane', 'read', live.pane_id, '--source', 'visible', '--lines', '2'], socket);
      if (!codexStatusFields(raw).some(fields => fields.includes(threadId))) continue;
      if (match) {
        throw new Error(`Codex 线程 ${threadId} 匹配多个 Herdr 面板（${match.herdrSession}/${match.live.pane_id}、${name}/${live.pane_id}）`);
      }
      match = { socket, herdrSession: name, live, sessionId: threadId };
    }
  }
  if (!match) return null;
  const { live, socket } = match;
  const current = query(['pane', 'get', live.pane_id], socket).result?.pane;
  if (current?.agent !== 'codex' || !live.terminal_id || current.terminal_id !== live.terminal_id || current.pane_id !== live.pane_id ||
      !current.tab_id || current.tab_id !== live.tab_id || !current.workspace_id || current.workspace_id !== live.workspace_id) {
    throw new Error(`核对时 Herdr 面板 ${match.herdrSession}/${live.pane_id} 的终端或标签页已变更，请重试`);
  }
  return match;
}

function callerDistance(socket, pane, ancestors) {
  const info = paneProcessInfo(socket, pane);
  if (!info) return Infinity;
  const pids = [info.shell_pid, info.foreground_process_group_id, ...(info.foreground_processes ?? []).map(p => p.pid)];
  return Math.min(...pids.map(pid => ancestors.get(pid) ?? Infinity));
}

function verifyCaller(o, ref, selected, { socket, live, sessionId, herdrSession }) {
  if (selected && selected !== socket) {
    throw new Error(`指定的 Herdr socket ${selected} 与发起者的 socket ${socket}（面板 ${live.pane_id}）不一致`);
  }
  if (sessionId) {
    if (ref && ref.pane !== live.pane_id && ref.pane !== live.name) {
      throw new Error(`--parent ${ref.pane} 与发起面板 ${live.pane_id} 不一致（Herdr 会话 ${herdrSession}，socket ${socket}）`);
    }
    if (ref) checkPanelBinding(socket, ref, live, sessionId);
    verifyCallerSession(o, socket, live, sessionId);
    // 回报地址只使用 Herdr 能核对的字段。当前线程 ID 来自 Codex 的状态栏。
    const parent = live.agent_session?.value === sessionId ? live : { ...live, agent_session: undefined };
    return { socket, live: parent, sessionId, herdrSession };
  }
  const parent = ref ? panelTarget(socket, ref) : agentInfo(socket, live.pane_id) ?? live;
  if (parent.pane_id !== live.pane_id) {
    throw new Error(`--parent ${parent.pane_id} 与发起面板 ${live.pane_id} 不一致（Herdr socket ${socket}）`);
  }
  verifyCallerSession(o, socket, parent);
  return { socket, live: parent };
}

function verifyCallerSession(o, socket, pane, actual = pane.agent_session?.value) {
  const native = pane.agent === 'codex' ? process.env.CODEX_THREAD_ID
    : ['claude', 'claude-code'].includes(pane.agent) ? process.env.CLAUDE_SESSION_ID : undefined;
  const expected = o.sessionId ?? native;
  if (expected && actual && expected !== actual) {
    throw new Error(`发起会话 ID ${expected} 与面板 ${pane.pane_id} 的原生会话 ID ${actual} 不一致（Herdr socket ${socket}）`);
  }
}

function callerPanel(o, { checkCodex = false } = {}) {
  if (!onPath('herdr')) return null;
  const ref = o.parent ? panelRef(o.parent) : undefined;
  const selected = selectedSocket(o, ref);
  const inherited = inheritedSocket();
  const threadId = process.env.CODEX_THREAD_ID;
  const codex = SESSION_UUID_RE.test(threadId ?? '');
  const ancestors = ancestorPids(process.pid, true);
  if (inherited && process.env.HERDR_PANE_ID) {
    const live = herdr(['pane', 'current', '--current'], { socket: inherited, allowFail: true })?.result?.pane;
    if (live && Number.isFinite(callerDistance(inherited, live.pane_id, ancestors))) {
      return verifyCaller(o, ref, selected, { socket: inherited, live });
    }
  }

  // 共享 app-server 可能继承其他客户端的面板环境，进程归属在 app-server 处截断。
  const sockets = new Set([inherited, selected, ...herdrSessions().map(s => s.socket_path)].filter(Boolean));
  const matches = [...sockets].flatMap(socket => agentList(socket).map(live =>
    ({ socket, live, distance: callerDistance(socket, live.pane_id, ancestors) })))
    .filter(m => Number.isFinite(m.distance)).sort((a, b) => a.distance - b.distance);
  if (matches.length && matches[0].distance !== matches[1]?.distance) {
    return verifyCaller(o, ref, selected, matches[0]);
  }
  if (codex && checkCodex) {
    const visible = findCodexPanel(threadId);
    if (visible) return verifyCaller(o, ref, selected, visible);
    if (!(ref?.managed === true && ref.socket && ref.terminal)) return null;
  }
  if (!selected || (!ref && !o.sessionId)) return null;

  const sessionId = o.sessionId ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_SESSION_ID;
  const nativeMatches = sessionId ? agentList(selected).filter(a => a.agent_session?.value === sessionId) : [];
  if (ref) {
    const live = panelTarget(selected, ref);
    verifyCallerSession(o, selected, live);
    if (nativeMatches.length && !nativeMatches.some(a => a.pane_id === live.pane_id)) {
      throw new Error(`--parent ${live.pane_id} 与发起会话 ID ${sessionId} 不一致（Herdr socket ${selected}，面板 ${nativeMatches.map(a => a.pane_id).join('、')}）`);
    }
    return { socket: selected, live };
  }
  if (nativeMatches.length === 1) return { socket: selected, live: nativeMatches[0] };
  if (nativeMatches.length > 1) {
    throw new Error(`发起会话 ID ${sessionId} 在 Herdr socket ${selected} 匹配多个面板，请用 --parent 指定面板`);
  }
  return null;
}

function senderPanel(o) {
  const caller = callerPanel(o, { checkCodex: true });
  if (caller) {
    const { socket, live } = caller;
    if (!live.agent || !live.tab_id || !live.workspace_id || !live.terminal_id) {
      throw new Error(`Herdr socket ${socket} 的面板 ${live.pane_id} 缺少发起 agent、终端或标签页坐标`);
    }
    return caller;
  }
  if (SESSION_UUID_RE.test(process.env.CODEX_THREAD_ID ?? '')) {
    throw new Error('无法确认发起面板：Herdr 可见的 Codex 状态栏未显示本线程的完整 ID。请在当前 Codex 的 /statusline 启用 thread-id 并移到最前，确认面板足够宽，重试 hms where');
  }
  const inherited = process.env.HERDR_SOCKET_PATH ?? process.env.HERDR_SESSION;
  throw new Error(`无法确认发起面板${inherited ? `（进程继承 ${inherited}，面板 ${process.env.HERDR_PANE_ID ?? '未知'}）` : ''}。请用 --herdr-session <名称> --parent <面板 ID>，或传入带 socket 的 --parent 地址`);
}

function targetSocket(o, ref) {
  const socket = selectedSocket(o, ref) ?? callerPanel(o)?.socket;
  if (socket) return socket;
  throw new Error(`无法确认面板 ${ref.pane} 所属的 Herdr 会话，请使用派工返回的地址或指定 --herdr-session <名称>`);
}

function currentHost(o, tools) {
  const caller = callerPanel(o);
  const pane = caller?.live;
  const inferred = process.env.CLAUDE_SESSION_ID ? 'claude-code' : process.env.CODEX_THREAD_ID ? 'codex' : undefined;
  const raw = pane?.agent || o.host || inferred;
  const tool = toolId(tools ?? {}, raw) ?? raw;
  const nativeId = tool === 'codex' ? process.env.CODEX_THREAD_ID : ['claude', 'claude-code'].includes(tool) ? process.env.CLAUDE_SESSION_ID : undefined;
  const meta = agentMetadata(pane);
  return { tool, observedTool: pane?.agent, sessionId: meta.sessionId || o.sessionId || nativeId || (caller && panelSessionId(caller.socket, pane)),
    model: meta.model || o.hostModel, effort: meta.effort || o.hostEffort };
}

// ---------- 台账 ----------

const splitRow = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(s => s.trim());
const makeRow = cells => `| ${cells.map(cell).join(' | ')} |`;

function readRecord(file) {
  let lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  if (lines[0] === INDEX_TITLE) lines = lines.slice(lines.findIndex(l => l.startsWith('| 会话 ID |')));
  const header = splitRow(lines[0] ?? '');
  const separator = splitRow(lines[1] ?? '');
  const width = header.length;
  if (![4, RECORD_COLUMNS.length].includes(width) || header.some((v, i) => v !== RECORD_COLUMNS[i]) ||
      separator.length !== width || !separator.every(v => /^:?-{3,}:?$/.test(v)) ||
      lines.slice(2).some(l => !l.trimStart().startsWith('|') || splitRow(l).length !== width)) {
    throw new Error('会话记录格式错误，应为 HMS 的会话表格');
  }
  return lines.slice(2).map(l => splitRow(l).map(v => v.replaceAll('\\|', '|'))).filter(([id]) => validSessionId(id));
}

const validSessionId = id => typeof id === 'string' && id.trim() !== '' && id.trim() !== '未取得';

function recordPath(snap, file = snap.record) {
  if (snap.mode !== 'complex') return null;
  if (!file) throw new Error('缺少团队成员表，请使用 hms init --mode complex 返回的 context');
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const inRecordDir = dir === path.join(snap.project, RECORD_DIR) || dir === path.join(snap.project, LEGACY_RECORD_DIR);
  if (!inRecordDir || !/^\d{8}-\d{6}-.+\.md$/.test(path.basename(abs))) {
    throw new Error(`会话表必须是 <项目>/${RECORD_DIR}/<时间戳>-<recap标题>.md，已有会话也可使用原路径`);
  }
  return abs;
}

function recordProject(file) {
  const dir = path.dirname(path.resolve(file));
  return path.resolve(dir, path.basename(dir) === path.basename(RECORD_DIR) ? '../../..' : '../..');
}

function standaloneRecord(file) {
  return recordPath({ mode: 'complex', project: recordProject(file) }, file);
}

function memberData(role, tool, meta) {
  if (!validSessionId(meta.sessionId)) return;
  const identity = Object.hasOwn(ROLE_USE, role) ? `${role}（${ROLE_USE[role]}）` : role || '未核实';
  return { sessionId: meta.sessionId.trim(), role, tool: meta.observedTool || tool || '未核实',
    model: isSet(meta.model) ? meta.model : '未核实', effort: isSet(meta.effort) ? meta.effort : '未核实', identity };
}

const memberCells = m => [m.sessionId, m.tool, m.model, m.effort, m.identity];
const nativeTool = tool => tool === 'claude' ? 'claude-code' : tool;

function resumeArgv(tool, id, { model, effort } = {}) {
  // A session ID supplied to a CLI must be a single positional value.
  if (!validSessionId(id) || /^-|[\s\u0000]/.test(id)) return;
  const flags = isSet(model) ? ['--model', model] : [];
  if (tool === 'codex') {
    if (isSet(effort)) flags.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    return ['codex', 'resume', ...flags, id];
  }
  if (nativeTool(tool) === 'claude-code') {
    if (isSet(effort)) flags.push('--effort', effort);
    return ['claude', '--resume', id, ...flags];
  }
}

function syncIndex(project, id) {
  const tableHeader = fs.readFileSync(path.join(SKILL_DIR, 'templates/session-log.md'), 'utf8').trimEnd();
  const render = () => {
    const round = store.getRound(project, id);
    const members = store.roundMembers(project, id);
    const secretary = round.secretary;
    const resume = secretary && resumeArgv(secretary.tool, secretary.sessionId);
    const header = [INDEX_TITLE, '', `轮次 \`${id}\``, ''];
    if (resume) {
      header.push('秘书恢复命令', '', '\`\`\`sh', `cd ${shellQuote(project)} && ${shellJoin(resume)}`, '\`\`\`', '',
        `恢复后，把轮次 ID 发给秘书，让它用 \`hms recover --round ${id}\` 接回本轮 worker。`, '');
    }
    return { file: round.record, text: [...header, tableHeader,
      ...members.map(m => makeRow(memberCells(m))), ''].join('\n') };
  };
  for (;;) {
    const { file, text } = render();
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const draft = path.join(path.dirname(file), `.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(draft, text, { flag: 'wx', flush: true });
      fs.renameSync(draft, file);
    } finally {
      fs.rmSync(draft, { force: true });
    }
    // A concurrent registration may have committed while the index was written.
    if (render().text === text) return;
  }
}

function teamRound(record, snap, mode = 'import', context) {
  const project = snap?.project ?? recordProject(record);
  const id = store.roundKey(project, record);
  const previous = store.getRound(project, id);
  if (mode === 'import' && previous && (previous.context || !snap)) return { ...previous, project };
  const members = mode !== 'create' && !previous ? readRecord(record).map(([sessionId, tool, model, effort, identity]) => {
    const role = /^([a-z][a-z0-9_-]*)(?:（|$)/.exec(identity ?? '')?.[1]
      ?? (sessionId === snap?.host.sessionId ? 'secretary' : undefined);
    return { ...memberData(role, tool, { sessionId, model, effort }), ...(identity && { identity }) };
  }) : [];
  const host = snap && memberData('secretary', snap.host.tool, snap.host);
  if (host) members.unshift(host);
  const secretary = (host ?? members.find(m => m.role === 'secretary'));
  const { roles, ...wire } = snap ?? {};
  store.putRound(project, { id, record, context, snapshot: snap && wire,
    secretary: secretary && { tool: secretary.tool, sessionId: secretary.sessionId } }, members, mode);
  return { ...store.getRound(project, id), project };
}

function loadTeam(snap, record, context) {
  if (!record) return;
  const known = store.getRound(snap.project, store.roundKey(snap.project, record));
  if (known?.context) return { ...known, project: snap.project };
  return teamRound(record, snap, 'import', context?.startsWith('ctx:') ? context : saveContext(snap));
}

function refreshIndex(team) {
  try { syncIndex(team.project, team.id); }
  catch (e) { process.stderr.write(`会话已入库，索引更新失败：${e.message}。可用 hms ls --round ${team.id} 重建。\n`); }
}

function saveMember(team, member, run, changes = {}) {
  if (run) store.updateRun(team.project, run, changes, member);
  else if (member) store.addMember(team.project, team.id, member);
  if (member) refreshIndex(team);
  return Boolean(member);
}

function reportedSessionId(agent) {
  const session = agent?.agent_session;
  if (!session?.kind || session.kind === 'id') return session?.value;
}

function agentMetadata(a, sessionId = reportedSessionId(a)) {
  const header = ['dst', 'dsh-tui'].includes(a?.agent) ? dstHeader(sessionId, a.foreground_cwd || a.cwd) : {};
  return { observedTool: a?.agent, sessionId, model: header.model || a?.agent_model?.value, effort: header.effort || a?.agent_effort?.value };
}

function panelSessionId(socket, agent) {
  if (agent.agent === 'codex') {
    const visible = herdr(['pane', 'read', agent.pane_id, '--source', 'visible', '--lines', '2'], { socket, allowFail: true })?.raw;
    const ids = new Set(codexStatusFields(visible).map(([first]) => first).filter(field => SESSION_UUID_RE.test(field)));
    if (ids.size === 1) return ids.values().next().value;
  }
  const id = reportedSessionId(agent);
  if (validSessionId(id)) return id;
  if (['claude', 'claude-code'].includes(agent.agent)) return claudePanelSession(socket, agent.pane_id);
}

function afterFirstPrompt(socket, initial, waitForId) {
  const agy = ['agy', 'gemini', 'antigravity_cli'].includes(initial.agent);
  const ref = { bound: true, pane: initial.pane_id, terminal: initial.terminal_id, tool: initial.agent };
  const deadline = Date.now() + (waitForId || agy ? 5000 : 0);
  for (;;) {
    const agent = agentInfo(socket, initial.pane_id);
    if (agent?.agent) {
      checkPanelBinding(socket, ref, agent);
      const sessionId = panelSessionId(socket, agent);
      // agy 可在空面板上保留前一会话 ID，收到第一条任务才分配新 ID。
      if (sessionId && (!agy || sessionId !== reportedSessionId(initial))) return { agent, sessionId };
    }
    if (Date.now() >= deadline) return { agent: { ...(agent ?? initial), agent_session: undefined }, sessionId: null };
    sleep(Math.min(250, deadline - Date.now()));
  }
}

function memberRecorded(team, sessionId, tool) {
  return validSessionId(sessionId) && store.roundMembers(team.project, team.id)
    .some(m => m.sessionId === sessionId && nativeTool(m.tool) === nativeTool(tool));
}

function submitPanelPrompt(socket, agent, prompt, confirmStart) {
  if (agent.agent_status === 'blocked') return false;
  const args = ['agent', 'prompt', agent.pane_id, prompt];
  if (confirmStart) {
    if (!['idle', 'done'].includes(agent.agent_status)) throw new Error('面板尚未空闲，无法核对首条任务是否开始');
    // 从空闲提交时，Herdr 先验证有新活动。若首个回合很快结束，idle/done 也能接住回执。
    args.push('--wait', '--until', 'working', '--until', 'blocked', '--until', 'idle', '--until', 'done', '--timeout', '8000');
  }
  try {
    herdr(args, { socket, timeout: confirmStart ? 10000 : undefined });
    return true;
  } catch (err) {
    if (err.code === 'agent_blocked') return false;
    if (confirmStart && ['agent_prompt_stalled', 'timeout', 'ETIMEDOUT'].includes(err.code)) {
      throw new Error(`无法确认首条任务已开始，请先检查面板中的任务或草稿再决定是否重发（${err.message}）`);
    }
    throw err;
  }
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
      if (e.is_error === true) meta.failed = true;
      const models = Object.keys(e.modelUsage ?? {});
      if (models.length) meta.model = models.join(', ');
    }
    if (tool && tool !== 'codex') continue;
    if (e?.type === 'thread.started') meta.sessionId = e.thread_id;
    if (e?.type === 'turn.failed') meta.failed = true;
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
  const launch = launchSnapshot(snap, role, o);
  const mode = o.headless ? 'headless' : 'interactive';
  const r = roleOf(launch, role, o.headless ? 'background' : 'herdr', o.fresh);
  const { argv, command, patch } = prepareArgv(launch, r, mode, o.headless ? '<派工正文>' : undefined);
  out({ role, tool: r.tool, model: r.model, effort: r.effort, argv, shell: command, patch });
}

function singletonRole(mode, role) {
  return (mode === 'simple' && role === 'frontend') || (mode === 'complex' && role === 'pm');
}

function singletonName(roundId, role, config) {
  const key = JSON.stringify([roundId, role, config.tool, config.model, config.effort]);
  return `hms-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}-${role}`;
}

function panelDirectory(socket, agent) {
  const info = paneProcessInfo(socket, agent.pane_id);
  if (info?.foreground_cwd) return info.foreground_cwd;
  for (const process of info?.foreground_processes ?? []) {
    if (process.pid !== info.foreground_process_group_id) continue;
    if (process.cwd) return process.cwd;
    try { return fs.readlinkSync(`/proc/${process.pid}/cwd`); } catch { /* Herdr 元数据仍可提供目录。 */ }
  }
  return agent.foreground_cwd || agent.cwd;
}

function cmdWhere(o) {
  requireHerdr();
  const { socket, live, sessionId, herdrSession = herdrSessions().find(s => s.socket_path === socket)?.name ?? null } = senderPanel(o);
  out({ herdrSession, herdrSocket: socket, workspace: live.workspace_id, tab: live.tab_id, pane: live.pane_id,
    terminalId: live.terminal_id, sessionId: sessionId ?? live.agent_session?.value ?? null, address: panelAddress(socket, live) });
}

function panelData(socket, agent, sessionId) {
  const session = reportedSessionId(agent) === sessionId ? sessionId : undefined;
  return { socket, pane: agent.pane_id, terminal: agent.terminal_id, tool: agent.agent, sessionId, session, name: agent.name };
}

function lockPanelCommands(lock) {
  if (process.env.HMS_SINGLETON_LOCK === lock || !onPath('flock')) return false;
  const child = spawnSync('flock', ['--exclusive', lock, process.execPath, HMS, ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, HMS_SINGLETON_LOCK: lock },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
  return true;
}

function launchPanel(socket, parent, { cwd, name, direction = 'right', startTimeout, command, tool, tracking, placed }) {
  const split = ['pane', 'split', '--pane', parent.pane_id, '--direction', direction, '--cwd', cwd, '--no-focus'];
  const created = herdr(split, { socket }).result?.pane;
  const pane = created?.pane_id;
  if (!pane) throw new Error('Herdr 没有返回新面板 ID');
  let agent;
  try {
    if (created.workspace_id !== parent.workspace_id || created.tab_id !== parent.tab_id) {
      throw new Error(`分屏返回的标签页 ${created.tab_id} 与发起标签页 ${parent.tab_id} 不一致（Herdr socket ${socket}）`);
    }
    placed?.(created);
    const launch = tool === 'dsh' ? shellJoin(['env', 'HERDR_ENV=1', 'HERDR_BIN_PATH=herdr', 'HERDR_PANE_ID=' + pane]) + ' ' + command : command;
    herdr(['pane', 'run', pane, launch], { socket });
    agent = waitAgent(socket, pane, startTimeout);
    if (!agent) throw new Error('Herdr 尚未确认 agent 已就绪');
    checkPanelBinding(socket, { bound: true, pane, terminal: created.terminal_id }, agent);
    herdr(['agent', 'rename', pane, name], { socket });
    return agent;
  } catch (err) {
    throw new Error(`${err.message}。已创建面板 ${pane}，派工未送达；管理地址 ${panelAddress(socket, agent ?? created, true, undefined, undefined, tracking)}`);
  }
}

function cmdSpawn(o) {
  requireHerdr();
  const role = o._[1];
  need({ role, ...o }, 'role', 'task', 'prompt', 'context');
  if (o.place !== undefined && o.place !== 'split') throw new Error('--place 仅支持 split，派工在发起者的标签页分屏');
  const { snap } = snapshotFrom(o, projectRoot(o));
  requireDevelopmentApproval(snap, role);
  if (o.fresh) need(o, 'cwd');
  const launch = launchSnapshot(snap, role, o);
  const r = roleOf(launch, role, 'herdr', o.fresh);
  const startTimeout = Number(o.startTimeout ?? 60000);
  if (!Number.isFinite(startTimeout) || startTimeout < 0) throw new Error('--start-timeout 需要非负毫秒数');
  const record = recordPath(snap);
  const { socket, live: parent, sessionId: senderId } = senderPanel(o);
  const singleton = !o.fresh && singletonRole(snap.mode, role);
  const name = singleton ? singletonName(snap.roundId, role, r) : (o.name ?? `hms-${crypto.randomUUID().slice(0, 8)}`);
  if (!NAME_RE.test(name)) throw new Error('面板名须匹配 [a-z][a-z0-9_-]{0,31}');

  // 索引会原子替换，单例锁使用稳定的目录。
  const lock = record ? path.dirname(record) : snap.project;
  if (singleton) {
    if (record) fs.mkdirSync(lock, { recursive: true });
    if (lockPanelCommands(lock)) return;
  }

  const formerPanels = new Set(snap.previousPanels?.[role] ?? []);
  if (role === 'pm') for (const name of snap.previousPanels?.frontend ?? []) formerPanels.add(name);
  for (const former of formerPanels) {
    const old = former !== name && agentInfo(socket, former);
    if (old) throw new Error(`旧面板 ${old.pane_id} 仍在使用，交接后用 close ${panelAddress(socket, old, true)} 再启用新配置`);
  }
  let agent = agentInfo(socket, name);
  const reused = Boolean(agent);
  if (reused && !singleton) throw new Error(`面板名 ${name} 已使用`);
  if (reused && (agent.tab_id !== parent.tab_id || agent.workspace_id !== parent.workspace_id)) {
    throw new Error(`本轮 ${role} 已在标签页 ${agent.tab_id}，发起面板在 ${parent.tab_id}（Herdr socket ${socket}）。请先交接，管理地址 ${panelAddress(socket, agent, true)}`);
  }
  const actualCwd = reused && panelDirectory(socket, agent);
  if (reused && o.cwd && (!actualCwd || fs.realpathSync(o.cwd) !== fs.realpathSync(actualCwd))) {
    throw new Error(`面板仍在 ${actualCwd || '未知目录'}。本票新实现者用 spawn --fresh --cwd；普通面板请先完成交接再重开`);
  }
  const cwd = reused ? actualCwd : path.resolve(o.cwd ?? process.cwd());
  const team = loadTeam(snap, record, o.context);
  const run = team && store.startRun(team.project, team.id, {
    task: o.task, role, tool: r.tool, carrier: 'herdr', cwd: cwd ?? process.cwd(), prompt: o.prompt,
    config: { model: r.model, effort: r.effort, name },
    parent: panelData(socket, parent, senderId ?? panelSessionId(socket, parent)),
  });
  const tracking = run && { run: run.id, project: team.project };
  const parentAddress = panelAddress(socket, parent, false, o.task, undefined, tracking);
  if (!reused) {
    try {
      const { command } = prepareArgv(launch, r, 'interactive');
      agent = launchPanel(socket, parent, { cwd, name, direction: o.direction, startTimeout, command, tool: r.tool, tracking,
        placed: run && (created => store.updateRun(team.project, run, { panel: panelData(socket, created) })) });
    } catch (err) {
      if (run) store.updateRun(team.project, run, { startup: 'failed', error: err.message });
      throw err;
    }
  }

  const pane = agent.pane_id;
  const report = { role, task: o.task, run: run?.id, name, pane, workspace: parent.workspace_id, tab: parent.tab_id,
    herdrSocket: socket, cwd, tool: r.tool, model: r.model, effort: r.effort, record, reused };
  let sessionId = reused && team ? panelSessionId(socket, agent) : reportedSessionId(agent);
  let recorded = team ? memberRecorded(team, reused ? sessionId : undefined, agent.agent) : undefined;
  const confirmStart = Boolean(team && !recorded);
  const pending = team && { file: record, role, tool: r.tool };
  const managementAddress = () => panelAddress(socket, agent, true, undefined,
    recorded && report.delivered ? undefined : pending, tracking);
  if (run) store.updateRun(team.project, run, { panel: panelData(socket, agent, recorded ? sessionId : undefined) });
  try {
    const address = panelAddress(socket, reused ? agent : { ...agent, agent_session: undefined }, true, undefined, undefined, tracking);
    const prompt = dispatchPrompt(snap, { context: o.context, role, task: o.task, parent: parentAddress, self: address, cwd, body: o.prompt });
    report.delivered = submitPanelPrompt(socket, agent, prompt, confirmStart);
    if (report.delivered && (confirmStart || !reused)) ({ agent, sessionId } = afterFirstPrompt(socket, agent, confirmStart));
    if (!report.delivered) report.prompt = prompt;
  } catch (err) {
    if (run) store.updateRun(team.project, run, { startup: 'unconfirmed', error: err.message });
    throw new Error(`${err.message}。面板 ${pane} 的管理地址 ${managementAddress()}`);
  }
  if (!report.delivered) {
    if (run) store.updateRun(team.project, run, { startup: 'blocked' });
    report.note = '面板等待交互，处理后用 prompt 将完整正文补发到 address';
    if (!reused && r.tool === 'gemini') sessionId = null;
  } else if (run) {
    const member = memberData(role, r.tool, agentMetadata(agent, sessionId));
    recorded = saveMember(team, member, run, {
      startup: 'started', sessionId: member?.sessionId, actualTool: member?.tool, panel: panelData(socket, agent, member?.sessionId),
    });
    if (!recorded) report.note = '首条任务已开始，待核实原生会话 ID 后用 record add --run 补登';
  }
  out({ ...report, address: managementAddress(), sessionId: sessionId ?? null, recorded });
}

function cmdPrompt(o) {
  requireHerdr();
  const target = o._[1];
  need({ target, ...o }, 'target', 'prompt');
  const ref = panelRef(target);
  const socket = targetSocket(o, ref);
  const live = panelTarget(socket, ref);
  const pending = ref.pendingMember;
  let team, run, already;
  if (pending) {
    if (!ref.managed || !ref.socket || !ref.terminal) throw new Error('补发需要派工返回的面板地址');
    need(pending, 'file', 'role', 'tool');
    team = teamRound(standaloneRecord(pending.file));
    run = ref.run && store.getRun(team.project, ref.run);
    if (run && run.round !== team.id) throw new Error('补发地址与执行记录不符');
    already = memberRecorded(team, panelSessionId(socket, live), live.agent);
  }
  const confirmStart = Boolean(pending && !already);
  if (!submitPanelPrompt(socket, live, o.prompt, confirmStart)) throw new Error(`${live.pane_id} 正在等待交互`);
  const result = { target: live.pane_id, delivered: true };
  if (confirmStart || (run && run.startup !== 'started')) {
    const { agent, sessionId } = afterFirstPrompt(socket, live, confirmStart);
    const member = memberData(pending.role, pending.tool, agentMetadata(agent, sessionId));
    result.sessionId = sessionId;
    if (run) result.run = run.id;
    result.recorded = saveMember(team, member, run, { startup: 'started', sessionId: member?.sessionId,
      actualTool: member?.tool, panel: panelData(socket, agent, member?.sessionId), error: null });
  }
  out(result);
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
  const team = loadTeam(snap, record, o.context);
  const run = team && store.startRun(team.project, team.id, { task: o.task, role, tool: r.tool, carrier: 'native', cwd,
    prompt: o.prompt, config: { model: r.model, effort: r.effort } });
  out({ role, tool: r.tool, model: r.model, effort: r.effort, cwd, record, run: run?.id,
    prompt: dispatchPrompt(snap, { context: o.context, role, task: o.task, cwd, body: o.prompt }) });
}

function cmdRun(o) {
  const role = o._[1];
  need({ role, ...o }, 'role', 'task', 'prompt', 'context');
  const { snap } = snapshotFrom(o, projectRoot(o));
  requireDevelopmentApproval(snap, role);
  const r = roleOf(snap, role, 'background', o.fresh);
  const record = recordPath(snap);
  const prompt = dispatchPrompt(snap, { context: o.context, role, task: o.task, body: o.prompt });
  const prepared = prepareArgv(snap, r, 'headless', prompt);
  let argv = prepared.argv;
  if (o.lock) {
    // 锁住已有共享目录，跨任务互斥且不创建 lock/owner 文件。
    const dir = path.resolve(o.lock);
    if (!fs.statSync(dir).isDirectory()) throw new Error('--lock 必须指向已有共享目录（如 git common dir）');
    argv = ['flock', '--exclusive', '--wait', String(Number(o.lockTimeout ?? 1800000) / 1000), dir, ...argv];
  }
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const team = loadTeam(snap, record, o.context);
  const run = team && store.startRun(team.project, team.id, { task: o.task, role, tool: r.tool,
    carrier: 'background', cwd, prompt: o.prompt, config: { model: r.model, effort: r.effort } });
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd, encoding: 'utf8',
    input: snap.tools[r.tool].promptInput === 'stdin' ? prompt : undefined,
    maxBuffer: Infinity, timeout: o.timeoutMin ? Number(o.timeoutMin) * 60000 : undefined,
  });
  const meta = executionMetadata(res.stdout ?? '', res.stderr ?? '', snap.tools[r.tool].metadata ?? r.tool);
  const exit = res.error ? null : res.status;
  const succeeded = exit === 0 && !meta.failed;
  let recorded;
  if (run) {
    if (succeeded && r.tool === 'dsh') Object.assign(meta, dstHeader(meta.sessionId, cwd));
    const member = succeeded ? memberData(role, r.tool, meta) : undefined;
    recorded = saveMember(team, member, run, {
      startup: succeeded ? 'started' : 'failed', status: succeeded ? 'completed' : 'failed',
      sessionId: validSessionId(meta.sessionId) ? meta.sessionId : null, actualTool: member?.tool,
      result: succeeded ? res.stdout : null,
      error: succeeded ? null : res.error?.message || oneLine(res.stderr).slice(0, 1000) || `CLI 执行失败（退出码 ${exit}）`,
    });
  }
  out({ role, task: o.task, run: run?.id, tool: r.tool, model: r.model, effort: r.effort, sessionId: meta.sessionId ?? null,
    exit, signal: res.signal ?? null, error: res.error?.message ?? null, stdout: res.stdout ?? '', stderr: res.stderr ?? '', record, recorded });
  process.exitCode = exit ?? 1;
}

function cmdNotify(o) {
  need(o, 'to', 'task', 'role', 'status', 'summary');
  if (!STATUSES.has(o.status)) throw new Error('--status 取 completed、blocked、failed');
  const ref = panelRef(o.to);
  if (!ref.task) throw new Error('回报未送达。请使用派工正文中绑定任务的 --to 地址；旧任务可核对发起者后用 prompt 补发');
  if (ref.task !== o.task) throw new Error(`回报任务 ${o.task} 与派工 ${ref.task} 不符，未送达`);
  const waitMs = Number(o.waitMs ?? 60000);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--wait-ms 需要非负毫秒数');
  const run = ref.run && store.getRun(ref.project, ref.run);
  if (ref.run && (!run || run.task !== o.task || run.role !== o.role)) throw new Error('回报与派工登记的任务或身份不符');
  const target = run?.parent ? { ...ref, ...run.parent, session: run.parent.session } : ref;
  const selected = o.herdrSession && selectedSocket(o, target);
  const report = run && store.recordReport(ref.project, run.id, o);
  if (report?.deliveredAt) return out({ delivered: true, report: report.id, task: o.task, reused: true });
  requireHerdr();
  const socket = selected || targetSocket(o, target);
  const text = `HERDR_RESULT task=${o.task} status=${o.status} role=${o.role}${o.result ? ' result=' + o.result : ''} summary=${o.summary}`;
  const deadline = Date.now() + Math.min(waitMs, 60000);
  for (;;) {
    const live = panelTarget(socket, target);
    if (run?.parent?.sessionId) {
      const id = panelSessionId(socket, live);
      if (id && id !== run.parent.sessionId) throw new Error('发起者的原生会话已变更，回报留在 SQLite');
    }
    if (live.agent_status !== 'blocked') {
      try {
        herdr(['agent', 'prompt', live.pane_id, text], { socket, timeout: waitMs ? Math.max(1, deadline - Date.now()) : 5000 });
        if (report) store.markDelivered(ref.project, report.id);
        out({ delivered: true, to: live.pane_id, task: o.task, report: report?.id });
        return;
      } catch (err) {
        if (err.code === 'ETIMEDOUT') throw new Error('Herdr 提交回执超时，先核对发起者是否已收到本任务结果');
        if (err.code !== 'agent_blocked' && !err.message.includes('agent_blocked')) {
          throw new Error(`回报未送达：${err.message}`);
        }
      }
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
  const ref = panelRef(target);
  const socket = targetSocket(o, ref);
  let live = panelTarget(socket, ref, { allowShell: true });
  if (ref.managed !== true && !o.takeover) throw new Error('借用面板保留；已明确移交管理时可用 --takeover');
  if (live.agent_status === 'working' && !o.force) {
    herdr(['agent', 'wait', live.pane_id, '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', '60000'], { socket, allowFail: true });
    live = panelTarget(socket, ref, { allowShell: true });
  }
  if (['working', 'blocked'].includes(live.agent_status) && !o.force) throw new Error(`agent 状态为 ${live.agent_status}，保留面板；处理完本回合后再关闭`);
  herdr(['pane', 'close', live.pane_id], { socket });
  if (ref.project) store.closePanel(ref.project, panelData(socket, live));
  out({ closed: live.pane_id });
}

function selectRound(o) {
  if (o.round) {
    const project = projectRoot(o);
    const round = store.getRound(project, o.round);
    if (!round) throw new Error(`项目 ${project} 中没有轮次 ${o.round}`);
    return { ...round, project };
  }
  if (o.context) {
    const { snap } = snapshotFrom(o, projectRoot(o));
    return loadTeam(snap, recordPath(snap, o.record), o.context);
  }
  need(o, 'record');
  return teamRound(standaloneRecord(o.record));
}

function liveRun(run) {
  const panel = run.panel;
  if (!panel?.terminal || panel.closed || !onPath('herdr')) return;
  const agent = agentInfo(panel.socket, panel.pane);
  if (agent?.terminal_id !== panel.terminal || (panel.tool && panel.tool !== agent.agent)) return;
  if (run.sessionId && panelSessionId(panel.socket, agent) !== run.sessionId) return;
  return agent;
}

function cmdLs(o) {
  const team = selectRound(o);
  if (!team) return out({ sessions: [], runs: [], live: [] });
  syncIndex(team.project, team.id);
  if (o.run) {
    const run = store.getRun(team.project, o.run);
    if (!run || run.round !== team.id) throw new Error(`轮次 ${team.id} 中没有 ${o.run}`);
    return out({ ...run, live: liveRun(run)?.agent_status ?? null });
  }
  const runs = store.roundRuns(team.project, team.id).map(({ prompt, config, seq, result, ...run }) => {
    const live = liveRun(run);
    return { ...run, live: live?.agent_status ?? null };
  });
  const socket = onPath('herdr') && (selectedSocket(o) ?? inheritedSocket());
  const live = socket ? agentList(socket) : [];
  out({ round: team.id, record: team.record, context: team.context,
    sessions: store.roundMembers(team.project, team.id).map(memberCells), runs, live });
}

const sessionKey = (tool, id) => validSessionId(id) ? JSON.stringify([nativeTool(tool), id]) : null;

function recoveryPanels(socket, needed) {
  const panels = new Map();
  const { sessions } = herdr(['session', 'list', '--json'], { timeout: 5000 });
  if (!Array.isArray(sessions)) throw new Error('Herdr 未返回会话列表，无法核对已在线的 worker');
  const sockets = new Set([socket]);
  for (const session of sessions.filter(s => s.running)) {
    if (!path.isAbsolute(session.socket_path ?? '')) throw new Error(`Herdr 会话 ${session.name} 缺少 socket 地址`);
    sockets.add(session.socket_path);
  }
  const tools = new Set([...needed].map(key => JSON.parse(key)[0]));
  for (const candidate of sockets) {
    const agents = herdr(['agent', 'list'], { socket: candidate, timeout: 5000 }).result?.agents;
    if (!Array.isArray(agents)) throw new Error(`Herdr 未返回 ${candidate} 的 agent 列表`);
    for (const agent of agents) {
      if (!agent.terminal_id || !tools.has(nativeTool(agent.agent))) continue;
      const sessionId = panelSessionId(candidate, agent);
      const key = sessionKey(agent.agent, sessionId);
      if (!needed.has(key)) continue;
      const matches = panels.get(key) ?? [];
      matches.push({ socket: candidate, agent, sessionId });
      panels.set(key, matches);
    }
  }
  return panels;
}

function recoverWorker(team, runs, matches, caller, startTimeout) {
  const latest = runs.at(-1);
  const tasks = runs.map(({ id, task, role, status }) => ({ run: id, task, role, status }));
  let current = matches[0];
  try {
    if (matches.length > 1) throw new Error('同一原生会话匹配多个在线面板');
    if (!current) {
      const argv = resumeArgv(latest.actualTool ?? latest.tool, latest.sessionId, latest.config);
      if (!argv) throw new Error('该工具没有已配置的原生恢复命令');
      if (!onPath(argv[0])) throw new Error(`找不到 ${argv[0]} 命令`);
      if (!fs.statSync(latest.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`工作目录已不存在 ${latest.cwd}`);
      const name = latest.config?.name ?? `hms-${latest.id.slice(4).toLowerCase().replaceAll('_', '-').slice(0, 8)}`;
      if (agentInfo(caller.socket, name)) throw new Error(`面板名 ${name} 已占用，请核对原生会话 ID`);
      const initial = launchPanel(caller.socket, caller.live, { cwd: latest.cwd, name, startTimeout,
        command: shellJoin(argv), tool: latest.tool, tracking: { project: team.project, run: latest.id } });
      const { agent, sessionId } = afterFirstPrompt(caller.socket, initial, true);
      if (sessionId !== latest.sessionId || nativeTool(agent.agent) !== nativeTool(latest.actualTool ?? latest.tool)) {
        const address = panelAddress(caller.socket, agent, true);
        throw new Error(`恢复后的原生会话未核实，检查面板 ${address}`);
      }
      current = { socket: caller.socket, agent, sessionId };
    }
    for (const run of runs) store.updateRun(team.project, run, { panel: panelData(current.socket, current.agent, current.sessionId) });
    return { current, worker: { sessionId: latest.sessionId, tool: latest.actualTool ?? latest.tool, tasks,
      address: panelAddress(current.socket, current.agent, true, undefined, undefined, { project: team.project, run: latest.id }),
      state: matches.length ? 'live' : 'resumed' } };
  } catch (e) {
    return { worker: { sessionId: latest.sessionId, tasks, state: 'needs_attention', error: e.message } };
  }
}

function cmdRecover(o) {
  const team = selectRound(o);
  if (!team?.secretary) throw new Error('本轮缺少已核实的秘书会话 ID');
  requireHerdr();
  const caller = senderPanel(o);
  const secretaryId = caller.sessionId ?? panelSessionId(caller.socket, caller.live);
  const secretaryKey = sessionKey(team.secretary.tool, team.secretary.sessionId);
  if (sessionKey(caller.live.agent, secretaryId) !== secretaryKey) throw new Error('请从会话索引恢复本轮秘书，再执行 recover');
  const startTimeout = Number(o.startTimeout ?? 60000);
  if (!Number.isFinite(startTimeout) || startTimeout < 0) throw new Error('--start-timeout 需要非负毫秒数');
  syncIndex(team.project, team.id);
  if (lockPanelCommands(path.dirname(team.record))) return;
  const context = team.snapshot ? saveContext(team.snapshot) : team.context;
  const runs = store.roundRuns(team.project, team.id);
  const groups = new Map();
  const manual = [];
  const needed = new Set([secretaryKey]);
  for (const run of runs) {
    const parent = sessionKey(run.parent?.tool, run.parent?.sessionId);
    if (parent) needed.add(parent);
    if (['completed', 'failed'].includes(run.status)) continue;
    const key = sessionKey(run.actualTool ?? run.tool, run.sessionId);
    if (!key || run.carrier !== 'herdr' || run.startup !== 'started' || run.panel?.closed) {
      manual.push({ run: run.id, task: run.task, role: run.role, carrier: run.carrier, startup: run.startup, closed: run.panel?.closed });
      continue;
    }
    needed.add(key);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const panels = recoveryPanels(caller.socket, needed);
  const workers = [];
  for (const [key, group] of groups) {
    const { current, worker } = recoverWorker(team, group, panels.get(key) ?? [], caller, startTimeout);
    if (current) panels.set(key, [current]);
    workers.push(worker);
  }
  panels.set(secretaryKey, [{ socket: caller.socket, agent: caller.live, sessionId: secretaryId }]);
  for (const run of runs) {
    const key = sessionKey(run.parent?.tool, run.parent?.sessionId);
    const matches = panels.get(key) ?? [];
    if (matches.length !== 1) continue;
    const { socket, agent, sessionId } = matches[0];
    store.updateRun(team.project, run, { parent: panelData(socket, agent, sessionId) });
    const task = workers.flatMap(w => w.tasks).find(t => t.run === run.id);
    if (task) task.replyAddress = panelAddress(socket, agent, false, run.task, undefined, { project: team.project, run: run.id });
  }
  const known = new Set(runs.map(r => sessionKey(r.actualTool ?? r.tool, r.sessionId)));
  const historical = store.roundMembers(team.project, team.id)
    .filter(m => m.role !== 'secretary' && !known.has(sessionKey(m.tool, m.sessionId)))
    .map(m => ({ sessionId: m.sessionId, tool: m.tool, identity: m.identity, resume: resumeArgv(m.tool, m.sessionId) }));
  out({ round: team.id, context, workers, manual, historical, pendingReports: store.pendingReports(team.project, team.id) });
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

function roundReference(snap, title, record, mode = 'update') {
  const roundId = snap.roundId ?? record ?? crypto.randomUUID();
  const snapshot = { ...snap, roundId, title, record };
  const context = saveContext(snapshot);
  if (!record) return { record, context };
  const team = teamRound(record, snapshot, mode, context);
  refreshIndex(team);
  return { record, context, round: team.id };
}

function createTeamRecord(snap, title, promote) {
  const dir = path.join(snap.project, RECORD_DIR);
  // 同一个简单 context 重试升级时，仍指向它自己的团队表。
  const suffix = promote ? '-' + crypto.createHash('sha256').update(snap.roundId).digest('hex').slice(0, 12) : '';
  const base = `${stamp(new Date(snap.createdAt))}-${title}${suffix}`;
  const known = record => fs.existsSync(record) || store.getRound(snap.project, store.roundKey(snap.project, record));
  if (promote && !known(path.join(dir, `${base}.md`))) {
    const legacy = path.join(snap.project, LEGACY_RECORD_DIR, `${base}.md`);
    if (known(legacy)) return roundReference(snap, title, recordPath(snap, legacy));
  }
  for (let n = 1; ; n++) {
    const record = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}.md`);
    if (known(record)) {
      if (promote) return roundReference(snap, title, record);
      continue;
    }
    try { return roundReference(snap, title, record, 'create'); }
    catch (e) {
      if (!e.message.includes('UNIQUE constraint failed: rounds.')) throw e;
      if (promote) return roundReference(snap, title, record);
    }
  }
}

function initRound(o) {
  const { snap: initial, changed, promote } = snapshotFrom(o, projectRoot(o));
  if ((initial.mode === 'complex' && initial.confirmed && changed?.length) || o._[1] === 'confirm') need(o, 'confirmed');
  const snap = o.confirmed ? confirmSnap(initial, o.confirmed) : initial;
  const title = sanitizeTitle(snap.title ?? o.title ?? o.recap ?? '团队');
  const existing = snap.mode === 'complex' && !promote ? snap.record ?? o.record : null;
  const reference = snap.mode === 'complex' && !existing
    ? createTeamRecord(snap, title, promote)
    : roundReference(snap, title, existing ? recordPath(snap, existing) : null);
  out({ ...reference, confirmed: snap.confirmed, changed });
}

function recordAdd(o) {
  need(o, 'tool');
  // 表路径本身无法区分历史简单模式和团队。脱离 context 补登须明示团队模式。
  let record, team;
  if (o.context) {
    const { snap } = snapshotFrom(o, projectRoot(o));
    record = recordPath(snap, o.record);
    team = loadTeam(snap, record, o.context);
  } else if (o.mode === 'complex') {
    need(o, 'record');
    record = standaloneRecord(o.record);
    team = teamRound(record);
  }
  if (!team) return out({ record: null, added: false });
  const run = o.run && store.getRun(team.project, o.run);
  if (o.run && (!run || run.round !== team.id || (o.role && run.role !== o.role))) throw new Error('补登与执行记录的轮次或身份不符');
  const member = memberData(run?.role ?? o.role, o.tool, { sessionId: o.sessionId, model: o.model, effort: o.effort });
  const added = member && saveMember(team, member, run, { startup: 'started', sessionId: member.sessionId, actualTool: member.tool,
    error: null, ...(run?.carrier === 'native' && { status: 'completed' }) });
  out({ record, added: Boolean(added) });
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
                                                        返回本轮短 ID，团队模式建库及会话索引
  record confirm --context C --confirmed 用户答复         确认本轮配置，返回新 context
  record update --context C [--mode complex] [--set ...] [--on a,b] [--off a,b] [--confirmed 用户答复]
  record add --context C --role ROLE --tool T --session-id ID [--run RUN --model M --effort E]
  where [--herdr-session NAME] [--parent PANE或地址] [--session-id ID]
  spawn ROLE --context C --task ID --prompt 正文 [--herdr-session NAME] [--parent PANE或地址] [--session-id ID] [--fresh --cwd DIR] [--route-from ROLE]
  prompt PANE或地址 --prompt 正文 [--herdr-session NAME]
  native ROLE --context C --caller 宿主工具 [--caller-model M] --task ID --prompt 正文 [--cwd DIR]
  run ROLE --context C --task ID --prompt 正文 [--cwd DIR] [--lock 目录]
  notify --to 地址 --task ID --role ROLE --status completed|blocked|failed --summary 正文 [--wait-ms 0..60000] [--herdr-session NAME]
  close 地址 [--force]                                   移交管理的既有面板用 close PANE --takeover [--herdr-session NAME]
  ls --round R | --context C | --record 索引路径 [--run RUN] [--herdr-session NAME]
  recover --round R [--project DIR]                     在恢复后的秘书会话中接回未完成的 worker
  argv ROLE [--context C] [--headless] [--fresh] [--route-from ROLE]  预览实际工具命令

--context 使用本轮 ctx:… 短 ID，--parent / --to 和面板管理使用 hms:… 短 ID。
where 核对当前发起面板，spawn 重新核对并在同一标签页分屏。--herdr-session 指定 Herdr 会话名，--session-id 指 agent 原生会话 ID。
--route-from ROLE 为当前 Wayfinder 票读取项目 roles.ROLE 的工具、模型和等级。
--fresh 用项目的 frontend 或 backend 配置，在本票 worktree 开显式新面板。--project DIR 指定主项目。`;

export function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  const table = { init: initRound, resolve: cmdResolve, argv: cmdArgv, where: cmdWhere, spawn: cmdSpawn, prompt: cmdPrompt, native: cmdNative, run: cmdRun, notify: cmdNotify, close: cmdClose, ls: cmdLs, record: cmdRecord, recover: cmdRecover };
  if (!cmd || o.help || cmd === 'help') return out(HELP);
  if (cmd === 'config') {
    const project = o.context ? snapshotFrom(o, projectRoot(o)).snap.project : projectRoot(o);
    const { file, active } = readRouting(projectConfigPath(project));
    return out(active ? { active, file } : { active, file, nextSkill: 'herdr-setup', skillFile: path.join(SETUP_DIR, 'SKILL.md') });
  }
  for (const key of ['snapshot', 'write', 'brief', 'file', 'out', 'inbox']) {
    if (o[key] !== undefined) throw new Error(`不再支持 --${key} 文件通信；使用 --context / --prompt 直接传递正文，输出直接返回调用方`);
  }
  if (o.session !== undefined) throw new Error('用 --herdr-session 指定 Herdr 会话名称，用 --session-id 指定 agent 原生会话 ID');
  if (o.routeFrom !== undefined && !['argv', 'spawn'].includes(cmd)) throw new Error('--route-from 用于 argv wayfinder 和 spawn wayfinder');
  if (!table[cmd]) throw new Error(`未知命令 ${cmd}；运行 hms help 查看用法`);
  return table[cmd](o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`hms: ${e.message}\n`);
    process.exitCode = 1;
  }
}
