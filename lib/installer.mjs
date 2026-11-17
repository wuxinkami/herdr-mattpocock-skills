import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = 'herdr-mattpocock-skills';
const PACKAGE = 'herdr-mattpocock-skills';
const RECEIPT = '.herdr-mattpocock-skills-install.json';
const DEFAULTS = 'templates/agent-defaults.json';
const PAYLOAD = ['SKILL.md', 'LICENSE', 'agents', 'references', 'templates', 'assets'];
const AGENTS = ['codex', 'claude-code', 'cursor', 'dsh', 'universal'];
const ROLES = ['secretary', 'pm', 'frontend', 'backend', 'searcher', 'reviewer', 'checker'];
const ADDED_ROLES = ['griller', 'merger'];
const CARRIERS = ['current', 'herdr', 'background', 'native'];
const COMMANDS = ['install', 'update', 'uninstall', 'config', 'doctor'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const has = file => fs.existsSync(file);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const pretty = value => JSON.stringify(value, null, 2) + '\n';
const unique = values => [...new Set(values)];
const fail = message => { throw new Error(message); };
const MATT_DEPENDENCY = 'Resolve required Matt skills and resources from the executing agent environment before use; missing or unreadable dependencies block that step. This package does not bundle or install Matt skills.';

export const HELP = `herdr-mattpocock-skills — Herdr and Matt Pocock workflow skill installer

Usage:
  herdr-mattpocock-skills install [--agent codex,claude-code,cursor,dsh,universal] [--project PATH | --global] [--defaults FILE]
  herdr-mattpocock-skills update --agent TARGETS [--project PATH | --global]
  herdr-mattpocock-skills uninstall --agent TARGETS [--project PATH | --global]
  herdr-mattpocock-skills config --agent TARGET [--path] [--project PATH | --global]
  herdr-mattpocock-skills config --template
  herdr-mattpocock-skills doctor [--agent TARGETS | --config FILE] [--project PATH | --global]

Options:
  -a, --agent TARGETS  Target names, comma-separated or repeated; install prompts on a terminal
  -g, --global        Install in the user's skill directories
  --project PATH      Project root; defaults to the current directory
  --dir PATH          Custom parent skill directory (the child is herdr-mattpocock-skills)
  --no-activate       Install skill files without adding the always-loaded routing entry
  --force             Back up conflicting managed files before install/update/uninstall
  --dry-run           Report the entire plan without writing any files
  --json              Machine-readable output
  --config FILE       Read a specific configuration (config/doctor only)
  --path              Print configuration paths only (config only)
  --template          Print the complete packaged JSON template (config only; no target or scope)
  --defaults FILE     Seed new routing.json files from an edited JSON template (install only)
  -h, --help          Show help
  -v, --version       Show this package's version

update applies the version of this package you are running; it never fetches or publishes a package.
For an unpublished local package: npx --package ./herdr-mattpocock-skills-VERSION.tgz herdr-mattpocock-skills install
Customize before installing:
  herdr-mattpocock-skills config --template > my-agent-defaults.json
  herdr-mattpocock-skills install --agent codex,claude-code --defaults my-agent-defaults.json
Edit the template for the tools, models and reasoning effort available on your machine.
Existing routing.json files must be edited directly; install and update preserve them.
When upgrading an older configuration, add griller/merger explicitly before using them;
use config --template for examples. Missing roles never inherit packaged defaults.
${MATT_DEPENDENCY}
`;

export function parseArgs(argv) {
  const options = { command: null, agents: [], global: false, activate: true, force: false, dryRun: false, json: false };
  let agentSpecified = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('-')) fail(`Missing value for ${arg}`);
      return next;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--agent' || arg === '-a') { agentSpecified = true; options.agents.push(...value().split(',').filter(Boolean)); }
    else if (arg.startsWith('--agent=')) { agentSpecified = true; options.agents.push(...arg.slice(8).split(',').filter(Boolean)); }
    else if (arg === '--global' || arg === '-g') options.global = true;
    else if (arg === '--project') options.project = value();
    else if (arg === '--dir') options.dir = value();
    else if (arg === '--config') options.config = value();
    else if (arg === '--path') options.pathOnly = true;
    else if (arg === '--template') options.template = true;
    else if (arg === '--defaults') options.defaults = value();
    else if (arg === '--no-activate') options.activate = false;
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (!options.command && COMMANDS.includes(arg)) options.command = arg;
    else fail(`Unknown argument: ${arg}. Use --help.`);
  }
  options.agents = unique(options.agents);
  for (const agent of options.agents) if (!AGENTS.includes(agent)) fail(`Unknown agent: ${agent}. Supported: ${AGENTS.join(', ')}`);
  if (options.global && options.project) fail('--global and --project cannot be combined.');
  if (options.config && !['config', 'doctor'].includes(options.command)) fail('--config is only valid with config or doctor.');
  if (options.pathOnly && options.command !== 'config') fail('--path is only valid with config.');
  if (options.template && options.command !== 'config') fail('--template is only valid with config.');
  if (options.defaults && options.command !== 'install') fail('--defaults is only valid with install.');
  if (options.template && (agentSpecified || options.config || options.dir || options.pathOnly || options.global || options.project)) fail('--template cannot be combined with --agent, --config, --dir, --path, --project or --global.');
  if (options.config && (options.agents.length || options.dir)) fail('--config cannot be combined with --agent or --dir.');
  if (options.global && options.dir) fail('--global and --dir cannot be combined; --dir is an explicit project/custom destination.');
  if (!options.command && !options.help && !options.version) options.help = true;
  return options;
}

function context(env = {}) {
  const cwd = path.resolve(env.cwd ?? process.cwd());
  const home = path.resolve(env.home ?? os.homedir());
  return {
    cwd, home, packageRoot: env.packageRoot ?? PACKAGE_ROOT,
    env: env.env ?? process.env,
    stdin: env.stdin ?? process.stdin, stdout: env.stdout ?? process.stdout,
    stderr: env.stderr ?? process.stderr,
    interactive: env.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    which: env.which,
  };
}

function assertPlainPath(file) {
  const absolute = path.resolve(file);
  if (/[\0\r\n]/.test(absolute)) fail('Paths must not contain control characters.');
  let cursor = path.parse(absolute).root;
  for (const component of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) fail(`Refusing a symbolic-link path: ${cursor}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return absolute;
}

function relativeFile(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)
      || name.split('/').some(part => !part || part === '.' || part === '..')) fail(`Invalid managed path: ${name}`);
  return name;
}

function walk(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`Refusing symbolic link in installation: ${path.join(dir, entry.name)}`);
    if (entry.isDirectory()) found.push(...walk(path.join(dir, entry.name), name));
    else if (entry.isFile()) found.push(name);
    else fail(`Unsupported filesystem entry: ${path.join(dir, entry.name)}`);
  }
  return found;
}

function readPayload(root) {
  const files = new Map();
  for (const name of PAYLOAD) {
    const source = path.join(root, name);
    if (!has(source)) continue;
    assertPlainPath(source);
    if (fs.statSync(source).isDirectory()) {
      for (const child of walk(source)) files.set(`${name}/${child}`, fs.readFileSync(path.join(source, child)));
    } else files.set(name, fs.readFileSync(source));
  }
  if (!files.has('SKILL.md') || !files.has(DEFAULTS)) fail(`Package is incomplete: SKILL.md and ${DEFAULTS} are required.`);
  validateConfig(JSON.parse(files.get(DEFAULTS).toString()));
  return files;
}

export function validateConfig(config) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = value => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0');
  if (!object(config) || config.schemaVersion !== 1) fail('routing.json must have schemaVersion: 1.');
  if (!['simple', 'complex'].includes(config.defaultMode)) fail('defaultMode must be simple or complex.');
  if (!string(config.docsDir) || path.isAbsolute(config.docsDir) || path.win32.isAbsolute(config.docsDir) || config.docsDir.split(/[\\/]/).includes('..')) fail('docsDir must be a relative project path without .. segments.');
  if (!object(config.tools)) fail('tools must be an object.');
  for (const [name, tool] of Object.entries(config.tools)) {
    if (!string(name) || !object(tool) || !Array.isArray(tool.command) || tool.command.length === 0 || !tool.command.every(string)) fail(`tools.${name}.command must be a nonempty array of strings.`);
  }
  if (!object(config.roles)) fail('roles must be an object.');
  const checkBinding = (binding, label, carrier = true) => {
    if (!object(binding)) fail(`${label} must be an object.`);
    if (binding.inheritRole !== undefined) fail(`${label}.inheritRole is only supported for roles.merger.`);
    if (!string(binding.tool) || (binding.tool !== 'current' && !Object.hasOwn(config.tools, binding.tool))) fail(`${label}.tool does not name a configured tool.`);
    if (!string(binding.model) || !string(binding.effort)) fail(`${label} must specify nonempty model and effort strings.`);
    if (binding.provider !== undefined && !string(binding.provider)) fail(`${label}.provider must be a nonempty string when supplied.`);
    if (carrier && !CARRIERS.includes(binding.carrier)) fail(`${label}.carrier must be current, herdr, background or native.`);
  };
  for (const name of ROLES) checkBinding(config.roles[name], `roles.${name}`);
  // Added roles are optional for an existing schemaVersion: 1 file. They are
  // never materialized from package defaults; report missing roles to the user.
  if (Object.hasOwn(config.roles, 'griller')) {
    checkBinding(config.roles.griller, 'roles.griller');
    if (config.roles.griller.carrier !== 'herdr') fail('roles.griller.carrier must be herdr.');
  }
  if (Object.hasOwn(config.roles, 'merger')) {
    const merger = config.roles.merger;
    if (object(merger) && merger.inheritRole !== undefined) {
      if (merger.inheritRole !== 'pm') fail('roles.merger.inheritRole must be pm.');
      if (['tool', 'model', 'effort', 'provider'].some(key => Object.hasOwn(merger, key))) fail('roles.merger must use either inheritRole: pm or an explicit tool/model/effort binding, not both.');
    } else checkBinding(merger, 'roles.merger');
    if (!['native', 'background'].includes(merger.carrier)) fail('roles.merger.carrier must be native or background.');
  }
  for (const name of ['reviewer', 'checker']) if (config.roles[name].carrier !== 'background') fail(`roles.${name}.carrier must remain background.`);
  for (const [name, binding] of Object.entries(config.roles)) {
    if (binding?.carrier === 'native' && !['searcher', 'merger'].includes(name)) fail(`roles.${name}.carrier cannot be native; only searcher and merger support it.`);
  }
  checkBinding(config.simple?.main, 'simple.main', false);
  if (!Array.isArray(config.simple.main.roles) || !['secretary', 'pm', 'backend'].every(role => config.simple.main.roles.includes(role))) fail('simple.main.roles must include secretary, pm and backend.');
  if (config.simple.main.roles.some(role => !['secretary', 'pm', 'backend', 'searcher'].includes(role))) fail('simple.main.roles may only contain secretary, pm, backend and searcher.');
  if (config.simple.frontendRole !== 'frontend') fail('simple.frontendRole must be frontend.');
  return config;
}

function configurationWarnings(config) {
  const warnings = [];
  const missing = ADDED_ROLES.filter(role => !Object.hasOwn(config.roles, role));
  if (missing.length) warnings.push(`Missing role bindings: ${missing.join(', ')}. Add them explicitly to routing.json before using those roles; run herdr-mattpocock-skills config --template for examples. No packaged defaults were merged.`);
  if (config.docsDir === 'docs/mulit-agent') warnings.push('The previous docsDir value docs/mulit-agent was preserved. Set docsDir to .agents/herdr/session to use the new archive location; existing records are not moved.');
  return warnings;
}

function locations(agent, options, ctx) {
  const project = path.resolve(ctx.cwd, options.project ?? '.');
  const codexHome = path.resolve(ctx.cwd, ctx.env.CODEX_HOME || path.join(ctx.home, '.codex'));
  const dshHome = path.resolve(ctx.cwd, ctx.env.DSH_HOME || path.join(ctx.home, '.dsh'));
  const scope = options.global ? 'global' : 'project';
  const globalSkills = { codex: '.agents/skills', 'claude-code': '.claude/skills', cursor: '.cursor/skills', universal: '.agents/skills' };
  const localSkills = { codex: '.agents/skills', 'claude-code': '.claude/skills', cursor: '.cursor/skills', dsh: '.dsh/skills', universal: '.agents/skills' };
  const parent = options.dir ? path.resolve(ctx.cwd, options.dir)
    : options.global ? (agent === 'dsh' ? path.join(dshHome, 'skills') : path.join(ctx.home, globalSkills[agent]))
      : path.join(project, localSkills[agent]);
  let rule;
  if (options.global) {
    rule = agent === 'codex' ? path.join(codexHome, 'AGENTS.md')
      : agent === 'claude-code' ? path.join(ctx.home, '.claude/CLAUDE.md')
        : agent === 'cursor' ? path.join(ctx.home, '.cursor/rules/herdr-mattpocock-skills.mdc')
          : agent === 'dsh' ? path.join(dshHome, 'AGENTS.md') : null;
  } else rule = path.join(project, agent === 'claude-code' ? 'CLAUDE.md' : agent === 'cursor' ? '.cursor/rules/herdr-mattpocock-skills.mdc' : 'AGENTS.md');
  return { agent, directory: path.join(parent, SKILL), rule, scope, project, anchor: options.global ? ctx.home : project };
}

function targetsFor(options, ctx) {
  const targets = new Map();
  for (const agent of options.agents) {
    const entry = locations(agent, options, ctx);
    assertPlainPath(entry.directory);
    if (entry.rule) assertPlainPath(entry.rule);
    const fromSource = path.relative(path.resolve(ctx.packageRoot), entry.directory);
    const toSource = path.relative(entry.directory, path.resolve(ctx.packageRoot));
    if (!fromSource || (!fromSource.startsWith('..' + path.sep) && !path.isAbsolute(fromSource))
        || (!toSource.startsWith('..' + path.sep) && !path.isAbsolute(toSource))) fail('Cannot install into, above, or inside the package source directory.');
    if (!targets.has(entry.directory)) targets.set(entry.directory, { ...entry, agents: [], entries: [] });
    targets.get(entry.directory).agents.push(agent);
    targets.get(entry.directory).entries.push(entry);
  }
  return [...targets.values()];
}

function readReceipt(target, options, ctx) {
  const file = path.join(target.directory, RECEIPT);
  if (!has(file)) return null;
  assertPlainPath(file);
  let receipt;
  try { receipt = json(file); } catch { fail(`Invalid installation receipt: ${file}`); }
  if (receipt.schemaVersion !== 1 || receipt.package !== PACKAGE || receipt.skill !== SKILL || !receipt.files || typeof receipt.files !== 'object'
      || !Array.isArray(receipt.agents) || !receipt.agents.length || receipt.agents.some(agent => !AGENTS.includes(agent))
      || receipt.scope !== target.scope || path.resolve(receipt.anchor ?? '') !== target.anchor) fail(`Unrecognized installation receipt: ${file}`);
  for (const [name, digest] of Object.entries(receipt.files)) {
    relativeFile(name);
    if (!/^[a-f0-9]{64}$/.test(digest)) fail(`Invalid file hash in ${file}`);
  }
  if (!Array.isArray(receipt.activations)) fail(`Invalid activation records in ${file}`);
  for (const activation of receipt.activations) {
    if (!receipt.agents.includes(activation.agent) || typeof activation.insertion !== 'string') fail(`Invalid activation record in ${file}`);
    const { begin, end } = markers(activation.agent);
    if (activation.insertion.split(begin).length !== 2 || activation.insertion.split(end).length !== 2
        || activation.insertion.indexOf(begin) > activation.insertion.indexOf(end)) fail(`Invalid activation markers in ${file}`);
    const expected = locations(activation.agent, options, ctx).rule;
    if (!expected || path.resolve(activation.path) !== expected) fail(`Activation path in receipt does not match this scope: ${activation.path}`);
    assertPlainPath(activation.path);
  }
  return receipt;
}

function modifications(directory, receipt) {
  const changes = [];
  for (const [name, digest] of Object.entries(receipt.files)) {
    const file = assertPlainPath(path.join(directory, relativeFile(name)));
    if (!has(file) || !fs.statSync(file).isFile() || hash(fs.readFileSync(file)) !== digest) changes.push(name);
  }
  return changes;
}

function markers(agent) {
  return { begin: `<!-- herdr-mattpocock-skills:${agent}:begin -->`, end: `<!-- herdr-mattpocock-skills:${agent}:end -->` };
}

function ruleBlock(entry) {
  const { begin, end } = markers(entry.agent);
  const skillPath = path.relative(path.dirname(entry.rule), path.join(entry.directory, 'SKILL.md')).split(path.sep).join('/');
  const configPath = path.relative(path.dirname(entry.rule), path.join(entry.directory, 'routing.json')).split(path.sep).join('/');
  const host = entry.agent === 'universal' ? 'For a coding agent without a dedicated herdr-mattpocock-skills entry' : `When using ${entry.agent}`;
  return `${begin}\n${host}, for development work read ${JSON.stringify(skillPath)} and ${JSON.stringify(configPath)} before acting. Apply their responsibility routing alongside the active workflow. Use the skill/configuration's mode rules; implicit loading alone does not opt into complex mode. Discussing, editing or installing this package does not start a team.\n${end}`;
}

function ruleState(states, file) {
  if (!states.has(file)) {
    const before = has(file) ? fs.readFileSync(file, 'utf8') : null;
    states.set(file, { path: file, before, content: before ?? '', backup: false, preserveEmptyFile: false });
  }
  return states.get(file);
}

function replaceOwnedBlock(state, activation, replacement, force) {
  state.preserveEmptyFile ||= activation.createdFile === false;
  const count = state.content.split(activation.insertion).length - 1;
  if (activation.insertion && count === 1) {
    state.content = state.content.replace(activation.insertion, () => replacement);
    return replacement;
  }
  if (!force) fail(`Routing entry was changed or removed: ${state.path}. Preserve your edit or use --force to back it up.`);
  const { begin, end } = markers(activation.agent);
  const starts = state.content.split(begin).length - 1;
  const ends = state.content.split(end).length - 1;
  if (starts === 0 && ends === 0) {
    if (replacement) {
      replacement = `${state.content && !state.content.endsWith('\n') ? '\n' : ''}${replacement}`;
      state.content += replacement;
    }
  } else {
    if (starts !== 1 || ends !== 1 || state.content.indexOf(end) < state.content.indexOf(begin)) fail(`Cannot safely identify the edited routing entry: ${state.path}`);
    let from = state.content.indexOf(begin);
    let to = state.content.indexOf(end) + end.length;
    const prefix = activation.insertion.slice(0, activation.insertion.indexOf(begin));
    const suffix = activation.insertion.slice(activation.insertion.indexOf(end) + end.length);
    // Include only unchanged, previously owned separators/frontmatter. Preserve edits outside the markers.
    if (prefix && state.content.slice(Math.max(0, from - prefix.length), from) === prefix) from -= prefix.length;
    else if (prefix && replacement.startsWith(prefix)) replacement = replacement.slice(prefix.length);
    if (suffix && state.content.slice(to, to + suffix.length) === suffix) to += suffix.length;
    else if (suffix && replacement.endsWith(suffix)) replacement = replacement.slice(0, -suffix.length);
    state.content = state.content.slice(0, from) + replacement + state.content.slice(to);
  }
  state.backup = true;
  return replacement;
}

function cursorAlwaysApplies(content) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines.shift() ?? '')) return false;
  const end = lines.findIndex(line => /^---[ \t]*$/.test(line));
  if (end < 0) return false;
  const keys = new Set();
  let alwaysApply = false;
  for (const line of lines.slice(0, end)) {
    if (!line.trim() || /^[ \t#]/.test(line)) continue;
    // Only root mapping keys count. Quoted keys are decoded so aliases of the
    // same spelling cannot hide a duplicate. Unsupported YAML is rejected.
    const field = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*)|$)/.exec(line);
    if (!field) return false;
    let key = field[1];
    try {
      if (key.startsWith('"')) key = JSON.parse(key);
      else if (key.startsWith("'")) key = key.slice(1, -1).replaceAll("''", "'");
    } catch { return false; }
    if (keys.has(key)) return false;
    keys.add(key);
    const value = (field[2] ?? '').trim();
    if (key === 'alwaysApply') {
      alwaysApply = /^(?:true|True|TRUE)(?:[ \t]+#.*)?[ \t]*$/.test(value);
    } else {
      // A multiline quoted/flow value could make a later apparent key part of
      // a string. Require these values to close on this line before scanning on.
      if (value.startsWith('"') && !/^"(?:[^"\\]|\\.)*"(?:[ \t]+#.*)?[ \t]*$/.test(value)) return false;
      if (value.startsWith("'") && !/^'(?:[^']|'')*'(?:[ \t]+#.*)?[ \t]*$/.test(value)) return false;
      if (/^[\[{&*!]/.test(value)) return false;
    }
  }
  return alwaysApply;
}

function planActivation(entry, previous, states, options) {
  const state = ruleState(states, entry.rule);
  const block = ruleBlock(entry);
  if (previous) {
    const { begin, end } = markers(entry.agent);
    const from = previous.insertion.indexOf(begin);
    const to = previous.insertion.indexOf(end) + end.length;
    if (from < 0 || to < end.length) fail(`Malformed owned routing entry: ${entry.rule}`);
    const wanted = previous.insertion.slice(0, from) + block + previous.insertion.slice(to);
    const insertion = replaceOwnedBlock(state, previous, wanted, options.force);
    if (entry.agent === 'cursor' && !cursorAlwaysApplies(state.content)) fail(`Cursor routing requires one top-level boolean alwaysApply: true in the first YAML frontmatter of ${entry.rule}; restore it before updating.`);
    return { agent: entry.agent, path: entry.rule, insertion, createdFile: previous.createdFile ?? false };
  }
  const { begin, end } = markers(entry.agent);
  if (state.content.includes(begin) || state.content.includes(end)) fail(`Unowned routing marker in ${entry.rule}; resolve it before installing.`);
  if (entry.agent === 'cursor' && state.before !== null && !cursorAlwaysApplies(state.content)) {
    fail(`Existing Cursor rule requires one top-level boolean alwaysApply: true in its first YAML frontmatter: ${entry.rule}. Use --no-activate or choose a clean rule destination.`);
  }
  const prefix = entry.agent === 'cursor' && state.before === null
    ? '---\ndescription: Multi-agent responsibility routing\nalwaysApply: true\n---\n\n'
    : state.content ? (state.content.endsWith('\n') ? '\n' : '\n\n') : '';
  const insertion = prefix + block + '\n';
  state.content += insertion;
  return { agent: entry.agent, path: entry.rule, insertion, createdFile: state.before === null };
}

function planInstall(options, ctx, meta) {
  const payload = readPayload(ctx.packageRoot);
  const defaultsPath = options.defaults ? assertPlainPath(path.resolve(ctx.cwd, options.defaults)) : null;
  const defaults = defaultsPath ? fs.readFileSync(defaultsPath) : payload.get(DEFAULTS);
  if (defaultsPath) validateConfig(JSON.parse(defaults.toString()));
  const states = new Map();
  const plans = [];
  for (const target of targetsFor(options, ctx)) {
    const exists = has(target.directory);
    if (exists && !fs.statSync(target.directory).isDirectory()) fail(`Destination is not a directory: ${target.directory}`);
    if (exists) walk(target.directory);
    const routingPath = path.join(target.directory, 'routing.json');
    const preserveConfiguration = has(routingPath);
    if (options.defaults && preserveConfiguration) fail(`--defaults cannot be used because routing.json already exists: ${routingPath}. Edit the existing configuration directly; install and update preserve it.`);
    const previous = exists ? readReceipt(target, options, ctx) : null;
    if (options.command === 'update' && !previous) fail(`update requires a managed installation: ${target.directory}`);
    if (exists && !previous && !options.force) fail(`Destination is not managed by ${PACKAGE}: ${target.directory}. Use --force only if a backup-and-replace is intended.`);
    const changed = previous ? modifications(target.directory, previous) : [];
    if (changed.length && !options.force) fail(`Modified installed files in ${target.directory}: ${changed.join(', ')}. Use --force to back up before replacing them.`);
    const collisions = previous ? [...payload.keys()].filter(name => !Object.hasOwn(previous.files, name) && has(path.join(target.directory, name))) : [];
    if (collisions.length && !options.force) fail(`New package files conflict with unowned files in ${target.directory}: ${collisions.join(', ')}. Use --force to back them up before replacement.`);
    const routing = preserveConfiguration ? fs.readFileSync(routingPath) : defaults;
    const configuration = validateConfig(JSON.parse(routing.toString()));
    const receipt = {
      schemaVersion: 1, package: PACKAGE, version: meta.version, skill: SKILL,
      scope: target.scope, anchor: target.anchor,
      agents: unique([...(previous?.agents ?? []), ...target.agents]),
      files: Object.fromEntries([...payload].map(([name, bytes]) => [name, hash(bytes)])),
      initialRoutingHash: previous?.initialRoutingHash ?? hash(routing),
      activations: [...(previous?.activations ?? [])],
    };
    if (options.activate) for (const entry of target.entries) {
      if (!entry.rule) fail(`Global automatic activation is not defined for ${entry.agent}. Use --no-activate and load the skill through your agent's own persistent rules.`);
      const old = receipt.activations.find(a => a.agent === entry.agent);
      const activation = planActivation(entry, old, states, options);
      receipt.activations = receipt.activations.filter(a => a.agent !== entry.agent).concat(activation);
    }
    const configurationSource = preserveConfiguration ? routingPath : defaultsPath ?? path.join(ctx.packageRoot, DEFAULTS);
    plans.push({ target, previous, payload, routing, receipt, preserveConfiguration, configurationSource, warnings: configurationWarnings(configuration), backup: exists && (!previous || changed.length > 0 || collisions.length > 0), changed });
  }
  return { plans, states };
}

function backupName(file) {
  return `${file}.backup-${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
}

function writeFile(file, bytes) {
  assertPlainPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const mode = has(file) ? fs.statSync(file).mode : undefined;
  try {
    fs.writeFileSync(temp, bytes, { mode });
    fs.renameSync(temp, file);
  } finally { if (has(temp)) fs.rmSync(temp); }
}

function removeManagedFile(directory, name) {
  const file = path.join(directory, relativeFile(name));
  if (has(file)) fs.unlinkSync(file);
  // 只回收已移除托管文件的空父目录，保留其他用户目录。
  for (let parent = path.dirname(file); parent !== directory && has(parent) && fs.readdirSync(parent).length === 0; parent = path.dirname(parent)) {
    fs.rmdirSync(parent);
  }
}

function ruleOperations(states) {
  const operations = [];
  for (const state of states.values()) {
    if (state.content === state.before || (state.before === null && state.content === '')) continue;
    operations.push({
      path: state.path, keepBackup: state.backup && state.before !== null,
      prepare(staging) {
        if (state.content === '' && !state.preserveEmptyFile) return;
        const mode = has(state.path) ? fs.statSync(state.path).mode : undefined;
        fs.writeFileSync(staging, state.content, { flag: 'wx', mode });
      },
    });
  }
  return operations;
}

function prepareParent(directory, created) {
  assertPlainPath(directory);
  const missing = [];
  for (let cursor = directory; !has(cursor); cursor = path.dirname(cursor)) missing.push(cursor);
  for (const entry of missing.reverse()) {
    fs.mkdirSync(entry);
    created.push(entry);
  }
}

function executeTransaction(operations, result) {
  const createdParents = [];
  const changes = [];
  const token = crypto.randomBytes(6).toString('hex');
  for (const operation of operations) operation.staging = `${operation.path}.tmp-${token}`;
  for (const operation of operations) for (const other of operations) {
    if (operation !== other && (operation.path === other.path || operation.path.startsWith(other.path + path.sep))) fail(`Overlapping installation destinations: ${operation.path} and ${other.path}`);
  }
  const cleanup = () => {
    const problems = [];
    for (const operation of operations) if (has(operation.staging)) {
      try { fs.rmSync(operation.staging, { recursive: true }); }
      catch (error) { problems.push(`${operation.staging}: ${error.message}`); }
    }
    for (const directory of [...createdParents].reverse()) {
      try { if (has(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory); }
      catch (error) { problems.push(`${directory}: ${error.message}`); }
    }
    return problems;
  };
  try {
    // Prepare every replacement before changing a live path. Both copies and
    // retained originals are siblings, so each swap/restore stays on one device.
    for (const operation of operations) {
      assertPlainPath(operation.path);
      prepareParent(path.dirname(operation.path), createdParents);
      operation.prepare(operation.staging);
      operation.hasReplacement = has(operation.staging);
    }
    for (const operation of operations) {
      assertPlainPath(operation.path);
      const change = { operation, original: null, installed: false };
      changes.push(change);
      if (has(operation.path)) {
        const original = operation.keepBackup ? backupName(operation.path) : `${operation.path}.old-${token}`;
        fs.renameSync(operation.path, original);
        change.original = original;
      }
      if (operation.hasReplacement) {
        fs.renameSync(operation.staging, operation.path);
        change.installed = true;
      }
    }
  } catch (error) {
    const recovery = [];
    for (const change of [...changes].reverse()) {
      try {
        if (change.installed) fs.renameSync(change.operation.path, change.operation.staging);
        if (change.original) fs.renameSync(change.original, change.operation.path);
      } catch (rollbackError) {
        recovery.push(`${change.original ?? change.operation.path}: ${rollbackError.message}`);
      }
    }
    const leftovers = cleanup();
    const detail = recovery.length
      ? ` Rollback could not finish; retained recovery paths: ${recovery.join('; ')}.`
      : ' Original installation and routing state restored.';
    const temporary = leftovers.length ? ` Temporary files need cleanup: ${leftovers.join('; ')}.` : '';
    throw Object.assign(new Error(`${error.message}${detail}${temporary}`, { cause: error }), { code: error.code });
  }
  // All live paths now agree. Cleanup failures retain old copies and are
  // reported; they must not trigger a rollback after other originals are gone.
  for (const change of changes) if (change.original) {
    if (change.operation.keepBackup) result.backups.push(change.original);
    else {
      try { fs.rmSync(change.original, { recursive: true }); }
      catch (error) {
        result.backups.push(change.original);
        (result.warnings ??= []).push(`Operation completed; retained recovery copy ${change.original}: ${error.message}`);
      }
    }
  }
  for (const problem of cleanup()) (result.warnings ??= []).push(`Temporary cleanup: ${problem}`);
}

function install(options, ctx, meta) {
  const { plans, states } = planInstall(options, ctx, meta);
  const result = {
    command: options.command, version: meta.version, dryRun: options.dryRun,
    note: MATT_DEPENDENCY,
    installations: plans.map(p => ({ directory: p.target.directory, agents: p.target.agents, configuration: path.join(p.target.directory, 'routing.json'), configurationSource: p.configurationSource, preserveConfiguration: p.preserveConfiguration, backupRequired: p.backup })),
    routingEntries: [...states.values()].map(s => ({ path: s.path, changed: s.before !== s.content, backupRequired: s.backup })), backups: [],
    warnings: plans.flatMap(p => p.warnings.map(warning => `${path.join(p.target.directory, 'routing.json')}: ${warning}`)),
  };
  if (options.dryRun) return result;
  const operations = plans.map(plan => ({
    path: plan.target.directory, keepBackup: plan.backup,
    prepare(staging) {
      if (plan.previous) fs.cpSync(plan.target.directory, staging, { recursive: true, errorOnExist: true, force: false });
      else fs.mkdirSync(staging);
      if (plan.previous) for (const name of Object.keys(plan.previous.files)) if (!plan.payload.has(name)) {
        removeManagedFile(staging, name);
      }
      for (const [name, bytes] of plan.payload) writeFile(path.join(staging, name), bytes);
      writeFile(path.join(staging, 'routing.json'), plan.routing);
      writeFile(path.join(staging, RECEIPT), pretty(plan.receipt));
    },
  }));
  executeTransaction(operations.concat(ruleOperations(states)), result);
  return result;
}

function uninstall(options, ctx) {
  const states = new Map();
  const plans = [];
  for (const target of targetsFor(options, ctx)) {
    if (!has(target.directory)) fail(`No installation: ${target.directory}`);
    walk(target.directory);
    const receipt = readReceipt(target, options, ctx);
    if (!receipt) fail(`Refusing to uninstall an unowned directory: ${target.directory}`);
    const selected = target.agents.filter(agent => receipt.agents.includes(agent));
    if (!selected.length) fail(`Selected agents do not own this installation: ${target.directory}`);
    const remaining = receipt.agents.filter(agent => !selected.includes(agent));
    const changed = modifications(target.directory, receipt);
    if (changed.length && !options.force) fail(`Modified installed files: ${changed.join(', ')}. Use --force to back them up before uninstalling.`);
    for (const activation of receipt.activations.filter(a => selected.includes(a.agent))) {
      replaceOwnedBlock(ruleState(states, activation.path), activation, '', options.force);
    }
    const routing = path.join(target.directory, 'routing.json');
    const preserveConfiguration = has(routing) && hash(fs.readFileSync(routing)) !== receipt.initialRoutingHash && !options.force;
    plans.push({ target, receipt, selected, remaining, changed, preserveConfiguration });
  }
  const result = {
    command: 'uninstall', dryRun: options.dryRun,
    installations: plans.map(p => ({ directory: p.target.directory, agents: p.selected, retainedForAgents: p.remaining, preservedConfiguration: !p.remaining.length && p.preserveConfiguration, backupRequired: options.force })),
    routingEntries: [...states.values()].map(s => ({ path: s.path, changed: s.before !== s.content, backupRequired: s.backup })), backups: [],
  };
  if (options.dryRun) return result;
  const operations = plans.map(plan => ({
    path: plan.target.directory, keepBackup: options.force,
    prepare(staging) {
      fs.cpSync(plan.target.directory, staging, { recursive: true, errorOnExist: true, force: false });
      if (plan.remaining.length) {
        const receipt = { ...plan.receipt, agents: plan.remaining, activations: plan.receipt.activations.filter(a => plan.remaining.includes(a.agent)) };
        writeFile(path.join(staging, RECEIPT), pretty(receipt));
        return;
      }
      for (const name of Object.keys(plan.receipt.files)) {
        const file = assertPlainPath(path.join(staging, relativeFile(name)));
        if (has(file)) fs.unlinkSync(file);
      }
      if (!plan.preserveConfiguration && has(path.join(staging, 'routing.json'))) fs.unlinkSync(path.join(staging, 'routing.json'));
      fs.unlinkSync(path.join(staging, RECEIPT));
      removeEmptyDirectories(staging);
    },
  }));
  executeTransaction(operations.concat(ruleOperations(states)), result);
  return result;
}

function removeEmptyDirectories(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function executable(command, ctx) {
  if (ctx.which) return ctx.which(command);
  const windows = process.platform === 'win32';
  const extensions = windows ? unique(['', ...(ctx.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]) : [''];
  const directories = command.includes('/') || command.includes('\\') ? [''] : (ctx.env.PATH ?? '').split(path.delimiter);
  for (const directory of directories) for (const extension of extensions) {
    const candidate = directory ? path.join(directory, command + extension) : path.resolve(ctx.cwd, command + extension);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch { /* Continue searching without executing the command. */ }
  }
  return null;
}

function configFiles(options, ctx) {
  if (options.config) return [path.resolve(ctx.cwd, options.config)];
  return targetsFor(options, ctx).map(t => path.join(t.directory, 'routing.json'));
}

function inspect(options, ctx) {
  const configurations = configFiles(options, ctx).map(file => {
    assertPlainPath(file);
    if (!has(file)) fail(`Configuration not found: ${file}`);
    const config = validateConfig(json(file));
    if (options.command === 'config') return { path: file, config };
    const usedTools = new Set([...Object.values(config.roles).map(role => role.tool), config.simple.main.tool]);
    const tools = Object.entries(config.tools).map(([name, tool]) => ({ name, command: tool.command, required: usedTools.has(name), executable: executable(tool.command[0], ctx) }));
    return {
      path: file, schemaValid: true, defaultMode: config.defaultMode, tools,
      missingRoleBindings: ADDED_ROLES.filter(role => !Object.hasOwn(config.roles, role)),
      effectiveDefaultsNeedConfirmation: Object.entries(config.roles).filter(([, r]) => r.model === 'default' || r.effort === 'default' || r.tool === 'current' || r.inheritRole).map(([role]) => role),
      nativeBindingsNeedVerification: Object.entries(config.roles).filter(([, r]) => r.carrier === 'native').map(([role]) => role),
      warnings: configurationWarnings(config),
    };
  });
  if (options.command === 'config') return { command: 'config', configurations };
  const herdr = executable('herdr', ctx);
  return { command: 'doctor', configurations, herdr, ok: Boolean(herdr) && configurations.every(c => c.tools.every(t => !t.required || t.executable)), note: 'This checks schema and executable availability only; unreferenced tools are informational. It does not launch agents, verify login or native-carrier compatibility, resolve actual model/effort settings, verify external Matt skills, or approve PM work. The secretary must obtain user confirmation before starting a new PM. ' + MATT_DEPENDENCY };
}

async function selectTargets(options, ctx) {
  if (options.agents.length || options.config) return;
  if (options.dir) { options.agents = ['universal']; return; }
  if (options.command === 'doctor' || options.command === 'config') {
    options.agents = AGENTS.filter(agent => has(path.join(locations(agent, options, ctx).directory, RECEIPT)));
    if (options.agents.length) return;
  }
  if (!ctx.interactive) fail('Specify --agent for a non-interactive invocation. Use --help for supported targets.');
  const input = createInterface({ input: ctx.stdin, output: ctx.stdout });
  try {
    const choice = await input.question(`Select agents (comma-separated names or numbers):\n${AGENTS.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}\n> `);
    options.agents = unique(choice.split(/[\s,]+/).filter(Boolean).map(value => /^\d+$/.test(value) ? AGENTS[Number(value) - 1] : value));
    if (!options.agents.length || options.agents.some(a => !AGENTS.includes(a))) fail('No valid target selection.');
    if (!options.project && !options.global) {
      const scope = (await input.question(`Scope: project (${ctx.cwd}) or global? [project] `)).trim().toLowerCase();
      if (scope === 'global' || scope === 'g') options.global = true;
      else if (scope && scope !== 'project' && scope !== 'p') fail('Scope must be project or global.');
    }
  } finally { input.close(); }
}

function render(result, options, ctx) {
  if (options.json) { ctx.stdout.write(pretty(result)); return; }
  if (result.command === 'config') {
    for (const entry of result.configurations) ctx.stdout.write(options.pathOnly ? `${entry.path}\n` : `${entry.path}\n${pretty(entry.config)}`);
    return;
  }
  if (result.command === 'doctor') {
    ctx.stdout.write(`Herdr: ${result.herdr ?? 'not found'}\n`);
    for (const entry of result.configurations) {
      ctx.stdout.write(`Configuration valid: ${entry.path}\n`);
      for (const tool of entry.tools) ctx.stdout.write(`  ${tool.name}: ${tool.executable ?? 'not found'}${tool.required ? '' : ' (not assigned to a role)'}\n`);
      for (const warning of entry.warnings) ctx.stdout.write(`  ${warning}\n`);
      if (entry.nativeBindingsNeedVerification.length) ctx.stdout.write(`  Verify matching native tool/model/effort before use: ${entry.nativeBindingsNeedVerification.join(', ')}\n`);
    }
    ctx.stdout.write(result.note + '\n');
    return;
  }
  ctx.stdout.write(`${result.dryRun ? 'Dry run — ' : ''}${result.command}${result.version ? ` ${result.version}` : ''}\n`);
  for (const entry of result.installations) {
    ctx.stdout.write(`  ${entry.agents.join(', ')}: ${entry.directory}\n`);
    if (entry.configuration) ctx.stdout.write(`  Editable configuration: ${entry.configuration}${entry.preserveConfiguration ? ' (preserved)' : ''}\n`);
    if (entry.preservedConfiguration) ctx.stdout.write('  User-edited routing.json was preserved.\n');
    if (result.dryRun && entry.backupRequired) ctx.stdout.write('  A complete backup is required before changing this installation.\n');
    if (entry.retainedForAgents?.length) ctx.stdout.write(`  Shared installation retained for: ${entry.retainedForAgents.join(', ')}\n`);
  }
  for (const entry of result.routingEntries) ctx.stdout.write(`  Routing entry: ${entry.path}${entry.changed ? '' : ' (unchanged)'}${result.dryRun && entry.backupRequired ? ' (backup required)' : ''}\n`);
  for (const backup of result.backups) ctx.stdout.write(`  Backup: ${backup}\n`);
  for (const warning of result.warnings ?? []) ctx.stdout.write(`  ${warning}\n`);
  if (result.note) ctx.stdout.write(result.note + '\n');
  if (result.command !== 'uninstall') {
    ctx.stdout.write('The packaged tool/model/effort combinations are examples. Edit routing.json to match the tools, models and reasoning effort available on this machine.\n');
    ctx.stdout.write('No agents were started. The secretary must present and archive the effective role/tool/model/effort/carrier table and obtain user confirmation before starting a new PM.\n');
  }
}

export async function run(argv, environment = {}) {
  const ctx = context(environment);
  const options = parseArgs(argv);
  const meta = json(path.join(ctx.packageRoot, 'package.json'));
  if (options.help) { ctx.stdout.write(HELP); return 0; }
  if (options.version) { ctx.stdout.write(meta.version + '\n'); return 0; }
  if (options.template) {
    const file = assertPlainPath(path.join(ctx.packageRoot, DEFAULTS));
    ctx.stdout.write(pretty(validateConfig(json(file))));
    return 0;
  }
  await selectTargets(options, ctx);
  const result = ['install', 'update'].includes(options.command) ? install(options, ctx, meta)
    : options.command === 'uninstall' ? uninstall(options, ctx) : inspect(options, ctx);
  render(result, options, ctx);
  return result.command === 'doctor' && !result.ok ? 1 : 0;
}
