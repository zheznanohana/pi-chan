// Identity comes from Pi's live ExtensionContext, never a stored preference.
export default function runtimeModel(pi) {
 if(process.env.PICHAN_HARNESS_KIND!=='chat')return;
 pi.on('before_agent_start', async (event, ctx) => {
  const model = ctx.model;
  const identity = model ? JSON.stringify({provider:model.provider,id:model.id,name:model.name}) : '暂未取得';
  return {systemPrompt:event.systemPrompt + '\n\n当前执行链路：陪伴界面 → Pi RPC Agent → 模型。你就是该 Pi Agent 的陪伴会话，不是独立问答壳。当前这一轮实际使用的模型（运行时事实）是：' + identity + '。被问型号时准确引用 provider 和 id；身份小派不等于模型型号。不要依据旧对话猜型号。/model 已由客户端处理，用于查看当前模型及打开选择器。开发工作台有独立模型；实时音频模式也独立，不要混淆。'};
 });
}
