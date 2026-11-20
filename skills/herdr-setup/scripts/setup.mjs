#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { commandProblems, configuredRoles, configuredTools, isRolePlaceholder, projectRoot, projectConfigPath, readRouting, toolId } from '../../herdr-mattpocock-skills/scripts/routing.mjs';

const template = JSON.parse(fs.readFileSync(new URL('../templates/routing.json', import.meta.url), 'utf8'));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const cell = v => String(v ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

function adapter(catalog, id) {
  const { source, ...command } = catalog[id];
  return command;
}

function form(config = {}) {
  const previous = configuredRoles(config, { includePlaceholders: true });
  const names = new Set([...Object.keys(template.roles), ...Object.keys(previous)]);
  const rows = ['| 身份 | 项目 CLI | 模型 | 默认思考等级 |', '| --- | --- | --- | --- |'];
  for (const name of names) {
    if (name === 'secretary' && !Object.hasOwn(previous, name)) continue;
    const role = previous[name] ?? {};
    const label = role.enabled === false ? `${name}（停用）` : name;
    const inherited = role.inherit ? `同 ${role.inherit}` : '';
    const effort = isRolePlaceholder(role) ? '' : role.effort || inherited;
    rows.push(`| ${cell(label)} | ${cell(role.tool || inherited)} | ${cell(role.model || inherited)} | ${cell(effort)} |`);
  }
  return rows.join('\n');
}

function mergeOptions(base, update) {
  const result = { ...base };
  for (const [key, value] of Object.entries(update ?? {})) {
    result[key] = key !== 'patch' && object(value) && object(result[key]) ? mergeOptions(result[key], value) : value;
  }
  return result;
}

// 升级已发布的启动命令，只替换与旧模板完全相同的字段，保留项目自定义参数。
const oldCommands = {
  kimi: { headless: 'kimi {model} --print --output-format text -p {prompt}' },
  hermes: { interactive: 'hermes chat {model}', headless: 'hermes chat {model} --quiet --query {prompt}' },
  cline: { headless: 'cline --json {model} {effort} {prompt}' },
  droid: { interactive: 'droid {model} {effort}' },
  'mistral-vibe': { interactive: 'vibe {model}', headless: 'vibe {model} --output json --prompt {prompt}' },
  amp: { interactive: 'amp', headless: 'amp -x {prompt}' },
  gemini: { interactive: 'gemini {model}', headless: 'gemini {model} -p {prompt}', model: '-m {value}' },
  dsh: { interactive: 'dsh --profile tui {patch}', headless: 'dsh --profile headless {patch} {prompt}' },
};

function projectCatalog(saved, overrides) {
  const selected = structuredClone(saved.tools ?? {});
  if ((saved.schemaVersion ?? 0) < template.schemaVersion) {
    for (const [id, fields] of Object.entries(oldCommands)) {
      for (const [key, old] of Object.entries(fields)) {
        if (JSON.stringify(selected[id]?.[key]) === JSON.stringify(old.split(' '))) delete selected[id][key];
      }
    }
    const oldPatch = '- id: agent-default-model\n  config:\n    provider: {provider}\n    model: {modelId}\n    reasoningEffort: {effortValue}\n';
    if (selected.dsh?.patch?.template === oldPatch && selected.dsh.patch.flag === '--patch') delete selected.dsh.patch;
  }
  const catalog = mergeOptions(template.tools, selected);
  for (const [id, tool] of Object.entries(selected)) {
    if (template.tools[id]?.aliases) catalog[id].aliases = [...new Set([...template.tools[id].aliases, ...(tool.aliases ?? [])])];
  }
  return configuredTools(mergeOptions(catalog, overrides));
}

function activate(saved = { schemaVersion: template.schemaVersion }, answers) {
  if (!object(answers) || !object(answers.roles)) throw new Error('请提供 roles 对象，各行填写 tool、model 和可选的 effort');
  if (answers.tools !== undefined && !object(answers.tools)) throw new Error('tools 需要 CLI 适配对象');
  const catalog = projectCatalog(saved, answers.tools);
  const oldRoles = configuredRoles(saved);
  const roles = { ...saved.roles };
  roles.secretary ??= { ...template.roles.secretary, model: 'inherit' };
  for (const [name, choice] of Object.entries(answers.roles)) {
    if (name === 'secretary') throw new Error('秘书沿用当前会话，只填写需要委派的身份');
    if (!/^[a-z][\w-]*$/.test(name) || ['griller', 'checker', 'worker', 'tester', 'constructor'].includes(name)) throw new Error(`无效身份 ${name}`);
    if (choice === null) {
      delete roles[name];
      if (name === 'wayfinder') delete roles.griller;
      continue;
    }
    if (!object(choice)) throw new Error(`${name} 需要 tool、model 和可选的 effort`);
    const old = oldRoles[name] ?? roles[name] ?? {};
    const requested = String(choice.tool ?? old.tool ?? '').trim();
    const tool = toolId(catalog, requested);
    if (!tool) throw new Error(`${name} 的 CLI「${requested}」没有适配。运行 tools 查看名称，或在输入的 tools 中提供适配。`);
    const sameTool = tool === toolId(catalog, old.tool);
    const model = String(choice.model ?? (sameTool ? old.model : '') ?? '').trim();
    if (!model || ['inherit', 'current'].includes(model)) throw new Error(`请填写 ${name} 使用的模型，或明确选 default`);
    const effort = String(choice.effort ?? (sameTool ? old.effort : undefined) ?? '').trim() || 'high';
    if (['inherit', 'current'].includes(effort)) throw new Error(`请填写 ${name} 的思考等级，或选 default`);
    const role = { carrier: 'auto', ...template.roles[name], ...old, tool, model, effort };
    delete role.inherit;
    delete role.enabled;
    roles[name] = role;
  }
  const tools = mergeOptions(saved.tools, answers.tools);
  const bindings = configuredRoles({ tools, roles });
  for (const id of new Set([...Object.keys(answers.tools ?? {}), ...Object.values(bindings).map(role => toolId(catalog, role.tool))])) {
    if (id && !Object.hasOwn(saved.tools ?? {}, id)) tools[id] = adapter(catalog, id);
  }

  const config = { ...saved, active: true, tools, roles };
  // 旧适配在读取时兼容，补填身份时保留项目保存的命令。
  const commands = (config.schemaVersion ?? 0) < template.schemaVersion ? projectCatalog(config) : configuredTools(tools);
  const enabled = Object.entries(bindings).filter(([name, r]) => name !== 'secretary' && r.enabled !== false);
  if (!enabled.length) throw new Error('请至少填写一行项目使用的 CLI 和模型');
  for (const [name, role] of enabled) {
    if (role.inherit) {
      if (!Object.hasOwn(bindings, role.inherit)) throw new Error(`${name} 缺少继承的身份 ${role.inherit}`);
      continue;
    }
    const tool = toolId(commands, role.tool);
    if (!tool) throw new Error(`${name} 缺少 CLI 适配 ${role.tool}`);
    if (typeof role.model !== 'string' || !role.model.trim()) throw new Error(`请填写 ${name} 使用的模型，或明确选 default`);
    if (role.carrier === 'native' || role.carrier === 'current') continue;
    const problems = commandProblems(commands[tool], role.carrier === 'herdr' ? 'interactive' : 'headless', role);
    if (problems.length) throw new Error(`${name} (${tool})：${problems.join('，')}`);
  }
  return config;
}

function apply(file, answers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const draft = file + '.lock';
  let fd;
  try { fd = fs.openSync(draft, 'wx', 0o600); }
  catch (err) {
    if (err.code === 'EEXIST') throw new Error(`配置正在写入；若上次 setup 已中断，请移除 ${draft} 后重试`);
    throw err;
  }
  try {
    const previous = readRouting(file);
    const config = activate(previous.config, answers);
    const changed = !isDeepStrictEqual(config, previous.config);
    if (changed) fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n');
    fs.closeSync(fd);
    fd = undefined;
    if (changed) fs.renameSync(draft, file);
    else fs.rmSync(draft, { force: true });
    return changed;
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(draft, { force: true });
    throw err;
  }
}

try {
  const { values, positionals } = parseArgs({ options: { project: { type: 'string' } }, allowPositionals: true });
  switch (positionals[0] ?? 'form') {
    case 'current': {
      const saved = readRouting(projectConfigPath(projectRoot(values)));
      if (!saved.active) throw new Error('请先激活项目配置');
      const catalog = projectCatalog(saved.config);
      const tools = Object.fromEntries(Object.keys(saved.config.tools).map(id => [id, adapter(catalog, id)]));
      console.log(JSON.stringify({ ...saved.config, tools, roles: configuredRoles(saved.config) }));
      break;
    }
    case 'form': console.log(form(readRouting(projectConfigPath(projectRoot(values))).config)); break;
    case 'tools': console.log(Object.entries(template.tools).map(([id, t]) => [id, ...(t.aliases ?? [])].join(' / ')).join('\n')); break;
    case 'adapter': {
      const id = toolId(template.tools, positionals[1]);
      if (!id) throw new Error(`模板没有 CLI「${positionals[1] ?? ''}」，请在项目配置中提供适配`);
      console.log(JSON.stringify({ [id]: adapter(template.tools, id) }));
      break;
    }
    case 'apply': {
      const file = projectConfigPath(projectRoot(values));
      const changed = apply(file, JSON.parse(fs.readFileSync(0, 'utf8')));
      console.log(`${changed ? '已保存' : '已是所选配置'} ${file}`);
      break;
    }
    default: throw new Error('用法：setup.mjs form|tools|adapter CLI|apply [--project DIR]');
  }
} catch (err) {
  process.stderr.write(`herdr-setup: ${err.message}\n`);
  process.exitCode = 1;
}
