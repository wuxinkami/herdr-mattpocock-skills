import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { findCodexPanel } from './hms.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
let output = {};
if (input.hook_event_name === 'SessionStart' && typeof input.session_id === 'string') {
  try {
    let panel = findCodexPanel(input.session_id);
    if (!panel) {
      await sleep(200);
      panel = findCodexPanel(input.session_id);
    }
    if (panel) {
      const { live, herdrSession, socket } = panel;
      output = { hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `当前 Herdr 坐标：会话 ${herdrSession}，工作区 ${live.workspace_id}，标签页 ${live.tab_id}，面板 ${live.pane_id}，终端 ${live.terminal_id}，socket ${socket}。使用 HMS 开面板前，运行技能里的 hms where 重新核对。`,
      } };
    }
  } catch { /* 无法核对时不注入坐标，按需由 hms where 显示故障。 */ }
}
console.log(JSON.stringify(output));
