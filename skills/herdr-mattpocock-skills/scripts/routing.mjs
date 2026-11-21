import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function projectRoot({ project } = {}) {
  if (project) return path.resolve(project);
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return git.status === 0 ? git.stdout.trim() : process.cwd();
}

export const projectConfigPath = project => path.join(project, '.agents', 'herdr', 'routing.json');
export const isSet = v => typeof v === 'string' && v.trim() !== '' && !['default', 'inherit', 'current'].includes(v);
export const isRolePlaceholder = role => role?.tool === '' && role.model === '' && !role.inherit && role.enabled === undefined;
const formerGrillRoles = ['wayfinder', 'griller', 'spec-writer'];
const retiredRoles = new Set([...formerGrillRoles, 'checker', 'worker']);
export const currentRole = name => formerGrillRoles.includes(name) ? 'grill' : name;

export function roleSkills(value) {
  const names = typeof value === 'string' ? (value.trim() ? value.split(',') : []) : value;
  if (!Array.isArray(names)) throw new Error('skills 需要技能名称列表');
  const skills = names.map(name => typeof name === 'string' ? name.trim().replace(/^[$\/]/, '') : '');
  if (skills.some(name => !name || /[\s,$]/.test(name))) throw new Error('请填写有效的技能名称，多个技能用逗号分隔');
  return [...new Set(skills)];
}

export function readRouting(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { file, active: false };
    throw new Error(`无法读取 ${file}：${e.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file} 需要 JSON 对象`);
  const bindings = Object.entries(config.roles ?? {}).filter(([name, role]) =>
    name !== 'secretary' && role?.enabled !== false && !isRolePlaceholder(role));
  const filled = bindings.length > 0 && bindings.every(([, role]) =>
    role && (role.inherit || (role.tool && typeof role.model === 'string' && role.model.trim())));
  return { file, config, active: config.active === true && Boolean(config.tools && filled) };
}

// 迁移旧身份时，保留仍在用的身份所继承的项目路由。
export function configuredRoles(config, { includePlaceholders = false } = {}) {
  const entries = Object.entries(config.roles ?? {}).filter(([, role]) => includePlaceholders || !isRolePlaceholder(role) || role.skills !== undefined);
  const roles = structuredClone(Object.fromEntries(entries));
  const candidates = [roles.grill, ...formerGrillRoles.map(name => roles[name])].filter(Boolean);
  if (candidates.length) {
    const binding = candidates.find(role => !isRolePlaceholder(role)) ?? candidates[0];
    roles.grill = { ...binding, ...(roles.grill?.skills !== undefined && { skills: roles.grill.skills }) };
  }
  for (const role of Object.values(roles)) {
    // 旧身份合并后，原本继承不同型号的其他成员仍使用原来的启动配置。
    const visited = new Set();
    while (retiredRoles.has(role.inherit) && roles[role.inherit]) {
      if (visited.has(role.inherit)) throw new Error(`inherit 形成循环：${role.inherit}`);
      visited.add(role.inherit);
      const parent = roles[role.inherit];
      for (const field of ['tool', 'model', 'effort']) role[field] ??= parent[field];
      if (parent.inherit) role.inherit = parent.inherit;
      else delete role.inherit;
    }
    if (role.inherit) role.inherit = currentRole(role.inherit);
    if (role.skills !== undefined) role.skills = roleSkills(role.skills);
    if (config.tools?.codex && toolId(config.tools, role.tool) === 'codex') role.tool = 'codex';
  }
  for (const name of retiredRoles) delete roles[name];
  return roles;
}

export function toolId(tools, name) {
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (Object.hasOwn(tools, name)) return name;
  const id = name.trim().toLowerCase();
  return Object.keys(tools).find(key => key.toLowerCase() === id || tools[key]?.aliases?.some(alias => alias.toLowerCase() === id));
}

function officialCodex(tool) {
  const { aliases, preferredExecutables, fallbackExecutables, ...adapter } = tool;
  for (const mode of ['interactive', 'headless']) {
    const argv = adapter[mode];
    if (Array.isArray(argv) && argv.length) adapter[mode] = ['codex', ...argv.slice(1)];
  }
  if (adapter.options) {
    adapter.options = Object.fromEntries(Object.entries(adapter.options).map(([mode, options]) =>
      [mode, options && officialCodex(options)]));
  }
  return adapter;
}

export function configuredTools(tools) {
  return tools?.codex ? { ...tools, codex: officialCodex(tools.codex) } : tools;
}

// 按执行方式判断，某些 CLI 只有无头模式支持指定模型变体。
export function modeOptions(tool, mode) {
  return { ...tool, ...tool?.options?.[mode] };
}

export function commandProblems(tool, mode, role) {
  tool = modeOptions(tool, mode);
  const argv = tool?.[mode];
  if (!Array.isArray(argv) || !argv.length || !argv.every(v => typeof v === 'string')) return [`缺少 ${mode} 命令`];
  const patch = argv.includes('{patch}') && (tool.patch?.template || tool.patch?.adapter === 'dst');
  const usesValue = flags => Array.isArray(flags) && flags.some(flag => typeof flag === 'string' && flag.includes('{value}'));
  const env = Object.values(tool.env ?? {});
  const settings = tool.settings?.env || argv.includes('{settings}') ? JSON.stringify(tool.settings?.values ?? {}) : '';
  const accepts = field => env.some(value => typeof value === 'string' && value.includes(`{${field}}`)) || settings.includes(`{${field}}`);
  const model = (argv.includes('{model}') && usesValue(tool.model)) || accepts('model');
  const effort = (argv.includes('{effort}') && usesValue(tool.effort)) || accepts('effort');
  const variant = model && isSet(role.model) && (tool.modelWithEffort?.[mode] || tool.modelVariants?.[role.model]?.[role.effort]);
  const profile = argv.includes('{profile}') && tool.effortProfiles?.[role.effort];
  const errors = [];
  if (isSet(role.model) && !model && !patch) errors.push('缺少此模式的模型参数');
  if (isSet(role.effort) && !effort && !patch && !variant && !profile) {
    errors.push(tool.modelVariants ? `请在 modelVariants 中填写 ${role.model}/${role.effort} 对应的实际变体 ID` : `请为 ${role.effort} 配置此模式的等级参数或 profile`);
  }
  const routePatch = patch && (tool.patch.adapter === 'dst' || tool.patch.template?.includes('{provider}'));
  if (routePatch && isSet(role.model) && !/^[^/\s]+\/\S+$/.test(role.model)) errors.push('模型需写成 provider/model');
  if ((tool.effortNeedsModel || routePatch && tool.patch.adapter !== 'dst') && isSet(role.effort) && !isSet(role.model)) {
    errors.push('指定思考等级时需同时填写完整型号');
  }
  if (mode === 'headless' && !argv.includes('{prompt}') && tool.promptInput !== 'stdin') errors.push('无头命令需要 {prompt} 或 promptInput=stdin');
  return errors;
}
