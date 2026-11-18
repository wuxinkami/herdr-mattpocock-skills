// 给只接受文件路径的 CLI 传本次启动配置。Linux 子进程可多次打开同一匿名文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function qwenSettings(env, overlay) {
  const locations = { linux: '/etc/qwen-code', darwin: '/Library/Application Support/QwenCode', win32: 'C:\\ProgramData\\qwen-code' };
  const source = path.resolve(env.QWEN_CODE_SYSTEM_SETTINGS_PATH || path.join(locations[process.platform] ?? locations.linux, 'settings.json'));
  env.QWEN_CODE_SYSTEM_DEFAULTS_PATH ||= path.join(path.dirname(source), 'system-defaults.json');
  let settings = { $version: 4 };
  try {
    const json = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '')
      .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (match, string) => string ?? ' ');
    settings = JSON.parse(json);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取 Qwen 原系统设置 ${source}：${error.message}`);
  }
  if (settings.model?.reasoningEffort && settings.model.reasoningEffort !== overlay.model.reasoningEffort) {
    throw new Error(`Qwen 系统设置 ${source} 已指定 ${settings.model.reasoningEffort}`);
  }
  return JSON.stringify({ ...settings, model: { ...settings.model, ...overlay.model } });
}

function run() {
  const [spec, ...argv] = process.argv.slice(2);
  const { base, variable, index, content } = JSON.parse(spec);
  const env = { ...process.env };
  const data = base === 'qwen-system' ? qwenSettings(env, JSON.parse(content)) : content;
  // 旧版 Qwen 配置初始化时可能原子迁移文件，给它独立的可重命名路径。
  const migrates = base === 'qwen-system' && JSON.parse(data).$version !== 4;
  const anonymous = !migrates && process.platform === 'linux' && fs.existsSync('/proc/self/fd');
  const directory = anonymous ? (fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir()) : fs.mkdtempSync(path.join(os.tmpdir(), 'hms-settings-'));
  const file = path.join(directory, 'hms-settings-' + randomUUID() + '.json');
  const fd = fs.openSync(file, 'wx+', 0o600);
  try {
    if (anonymous) fs.unlinkSync(file);
    fs.writeFileSync(fd, data);
    const target = anonymous ? `/proc/${process.pid}/fd/${fd}` : file;
    if (variable) env[variable] = target;
    else argv[index] = target;
    const res = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', env });
    if (res.error) throw res.error;
    return res.status ?? 1;
  } finally {
    fs.closeSync(fd);
    if (!anonymous) fs.rmSync(directory, { recursive: true, force: true });
  }
}

try { process.exitCode = run(); }
catch (error) { process.stderr.write(`hms: ${error.message}\n`); process.exitCode = 1; }
