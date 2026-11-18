// dst 的 /model、/effort 会写全局偏好。一次派工的选择只挂在本进程的顶层 agent。
export const name = 'hms-dst-selection';
export const inject = ['agents'];

export function apply(ctx, selection) {
  const attached = new WeakSet();
  const bind = agent => {
    if (attached.has(agent) || !ctx.agents.roots().includes(agent)) return;
    attached.add(agent);
    const first = { prepend: true };
    if (selection.model) {
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const result = await next();
        return { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } };
      }, first);
    }
    agent.ctx.on('agent/request', async (_payload, next) => {
      const config = { ...await next() };
      if (selection.model && (selection.provider !== config.provider || selection.model !== config.model)) delete config.reasoningEffort;
      return { ...config, ...selection };
    }, first);
  };
  ctx.on('agent/created', ({ agent }) => { bind(agent); });
  for (const agent of ctx.agents.roots()) bind(agent);
}
