'use strict';
const path=require('node:path');
function getMcpPresets(cwd){
 const root=path.resolve(cwd);
 const bot=(platform,env)=>({command:process.execPath,args:[path.join(root,'tools/mcp-bot-server.cjs')],env:{BOT_PLATFORM:platform,BOT_MEDIA_DIR:path.join(root,'audio-debug'),...env}});
 return [
  {id:'qq-official',name:'QQ 官方机器人',description:'AppID + AppSecret 接入官方 API；支持私聊、群 @ 消息及语音回复。与 NapCat 独立，无需登录个人 QQ。',requires:'在 QQ 开放平台创建机器人，开通私聊/群聊权限。目标填写事件中的 OpenID，不是 QQ 号。',source:'https://bot.q.qq.com/wiki/develop/api-v2/',config:{mcpServers:{'qq-official':bot('qq-official',{QQ_APP_ID:'YOUR_QQ_APP_ID',QQ_APP_SECRET:'YOUR_QQ_APP_SECRET'})}}},
  {id:'postiz',name:'多平台发布 · Postiz',description:'统一管理已授权的 X、Instagram、YouTube、TikTok 等发布渠道。主要是发帖与排期，不是私信或评论收件箱。',requires:'Postiz 实例/账号、API Key，各平台分别授权；云服务可能收费',source:'https://github.com/gitroomhq/postiz-app',config:{mcpServers:{postiz:{type:'http',url:'https://mcp.postiz.com/mcp',headers:{Authorization:'Bearer YOUR_POSTIZ_API_KEY'}}}}},
  {id:'xiaohongshu',name:'小红书',description:'复用 xpzouying/xiaohongshu-mcp，登录、搜索、查看内容及发布；属于社区连接器。',requires:'先安装并启动本地小红书 MCP，完成扫码登录；服务端口 18060',source:'https://github.com/xpzouying/xiaohongshu-mcp',config:{mcpServers:{xiaohongshu:{type:'http',url:'http://127.0.0.1:18060/mcp'}}}},
  {id:'x-social',name:'X · 官方只读接入',description:'使用官方 MCP 查询帖子与用户；App-only Bearer 不代表个人账号，不支持用户身份的写入。',requires:'X Developer 应用 Bearer Token，接口权限/费用以账号方案为准',source:'https://github.com/xdevplatform/xmcp',config:{mcpServers:{'x-social':{type:'http',url:'https://api.x.com/mcp',headers:{Authorization:'Bearer YOUR_X_APP_BEARER_TOKEN'}}}}},
  {id:'feishu',name:'飞书 · 官方连接',description:'复用飞书官方 MCP。消息、文档和日历能力由应用权限决定；个人身份另需官方登录。',requires:'Node.js / npx；飞书 App ID、App Secret 和对应权限',source:'https://github.com/larksuite/lark-openapi-mcp',config:{mcpServers:{feishu:{command:'npx',args:['-y','@larksuiteoapi/lark-mcp','mcp','-a','YOUR_FEISHU_APP_ID','-s','YOUR_FEISHU_APP_SECRET']}}}},
  {id:'telegram-bot',name:'Telegram Bot · 文字/语音',description:'调用官方 Bot API：核对身份、读取 Bot 更新、发文字和已有语音文件。不是个人账号，不能读任意聊天；已有 webhook 时不接管。',requires:'BotFather Token、目标 Chat ID；对方先启动 Bot 或将 Bot 加入群。媒体目录默认 audio-debug。',source:'https://core.telegram.org/bots/api',config:{mcpServers:{'telegram-bot':bot('telegram',{TELEGRAM_BOT_TOKEN:'YOUR_TELEGRAM_BOT_TOKEN'})}}},
  {id:'qq-bot',name:'QQ · NapCat / OneBot',description:'复用 NapCat OneBot v11：查询登录账号、读取指定群历史、发文字/语音。社区方案，不是腾讯官方 Bot；账号风控风险需自行评估。',requires:'自行安装 NapCat 并登录 QQ，启用 HTTP API 和 Access Token；按实际配置填写端口，语音编码依赖 NapCat。',source:'https://github.com/NapNeko/NapCatQQ',config:{mcpServers:{'qq-bot':bot('qq-onebot',{ONEBOT_HTTP_URL:'http://127.0.0.1:3000',ONEBOT_WS_URL:'ws://127.0.0.1:3001',ONEBOT_ACCESS_TOKEN:'YOUR_ONEBOT_ACCESS_TOKEN'})}}},
  {id:'bluesky',name:'Bluesky · 公开内容',description:'社区托管只读 MCP，搜索公开帖子与讨论；查询会发送给该第三方服务，不发送账号凭据。',requires:'网络连接；第三方公共服务的可用性和限额由维护者决定',source:'https://github.com/cyanheads/bluesky-mcp-server',config:{mcpServers:{bluesky:{type:'http',url:'https://bluesky.caseyjhand.com/mcp'}}}},
  {id:'project-files',name:'项目文件',description:'列目录、搜索、读取和编辑项目文件。可写入，仅开放下方项目目录；启用前可修改目录范围。',requires:'Node.js / npx；首次连接下载固定版本',source:'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',config:{mcpServers:{'project-files':{command:'npx',args:['-y','@modelcontextprotocol/server-filesystem@2026.8.31',root]}}}},
  {id:'web-fetch',name:'网页阅读',description:'读取给定网址并提取正文，适合查资料。不等于搜索引擎，不带付费搜索 Key。',requires:'Python + uvx；首次连接下载 mcp-server-fetch',source:'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',config:{mcpServers:{'web-fetch':{command:'uvx',args:['mcp-server-fetch']}}}},
  {id:'browser',name:'浏览器操作',description:'Microsoft Playwright：页面浏览、表单、截图与网页交互。使用隔离会话，不复用个人浏览器登录；网页操作可能产生外部变更。',requires:'Node.js / npx、Chrome；首次连接下载固定版本',source:'https://github.com/microsoft/playwright-mcp',config:{mcpServers:{'browser':{command:'npx',args:['-y','@playwright/mcp@0.0.82','--isolated','--headless']}}}}
 ];
}
module.exports={getMcpPresets};
