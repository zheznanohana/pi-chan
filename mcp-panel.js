/**
 * mcp-panel.js - Model Context Protocol (MCP) Connector & Manager
 * Apple HIG Liquid Glass & Cyber Orange Visual Aesthetic
 * ZERO EMOJIS: All iconography uses SVG / CSS.
 */

export class McpPanel {
  constructor() {
    this.isOpen = false;
    this.currentTab = 'servers';
    this.statusData = null;
    this.servers = [];
    this.tools = [];
    this.resources = [];
    this.searchKeyword = '';
    this.filterServer = '';
    this.isLoading = false;

    this.widgetEl = null;
    this.overlayEl = null;
    this.modalEl = null;
  }

  init() {
    this.renderModal();
    this.setupSocialPage();
    this.bindEvents();
    this.loadPresets();
    this.refreshAll().catch(() => {});

    // Listen for SSE broadcast if event source exists
    this.hookServerEvents();
    console.log('[MCP] 前端连接器与管理面板初始化就绪');
  }

  // ---------------------------------------------------------------------------
  // Runtime Panel Widget Integration
  // ---------------------------------------------------------------------------
  renderWidget() {
    const runtimePanel = document.querySelector('.runtime-panel');
    if (!runtimePanel) return;

    if (document.getElementById('mcpRuntimeWidget')) {
      this.widgetEl = document.getElementById('mcpRuntimeWidget');
      return;
    }

    const widget = document.createElement('div');
    widget.id = 'mcpRuntimeWidget';
    widget.className = 'mcp-runtime-widget';
    widget.innerHTML = `
      <div class="mcp-widget-header">
        <div class="mcp-widget-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
          </svg>
          <span>MCP 连接器</span>
        </div>
        <span class="mcp-status-pill" id="mcpWidgetPill">
          <span class="mcp-dot"></span>
          <span class="mcp-pill-text">检测中</span>
        </span>
      </div>
      <div class="mcp-widget-stats" id="mcpWidgetStats">
        <div class="mcp-stat-item"><b id="mcpStatServers">0</b> 服务</div>
        <div class="mcp-stat-item"><b id="mcpStatTools">0</b> 工具</div>
        <div class="mcp-stat-item"><b id="mcpStatResources">0</b> 资源</div>
      </div>
      <div class="mcp-server-tags" id="mcpWidgetTags"></div>
      <div class="mcp-widget-actions">
        <button type="button" class="mcp-btn-action" id="mcpOpenPanelBtn" title="打开 MCP 管理面板">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          <span>管理连接器</span>
        </button>
        <button type="button" class="mcp-btn-action" id="mcpWidgetReloadBtn" title="重新读取配置并热重载">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
          <span>热重载</span>
        </button>
      </div>
    `;

    // Insert after workbench status or at bottom of runtime panel
    const wbStatus = runtimePanel.querySelector('.workbench-status');
    if (wbStatus) {
      wbStatus.after(widget);
    } else {
      runtimePanel.appendChild(widget);
    }

    this.widgetEl = widget;

    document.getElementById('mcpOpenPanelBtn')?.addEventListener('click', () => this.open());
    document.getElementById('mcpWidgetReloadBtn')?.addEventListener('click', () => this.triggerReload());
  }

  updateWidgetView() {
    if (!this.widgetEl) return;
    const pill = document.getElementById('mcpWidgetPill');
    const pillText = pill?.querySelector('.mcp-pill-text');
    const statServers = document.getElementById('mcpStatServers');
    const statTools = document.getElementById('mcpStatTools');
    const statResources = document.getElementById('mcpStatResources');
    const tagsContainer = document.getElementById('mcpWidgetTags');

    const totalServers = this.servers.length;
    const readyServers = this.servers.filter(s => s.status === 'ready').length;
    const totalTools = this.tools.length;
    const totalResources = this.resources.length;

    if (statServers) statServers.textContent = String(totalServers);
    if (statTools) statTools.textContent = String(totalTools);
    if (statResources) statResources.textContent = String(totalResources);

    const topBadgeText = document.getElementById('mcpTopBadgeText');
    if (topBadgeText) {
      if (readyServers > 0) {
        topBadgeText.textContent = `MCP: ${totalTools} 工具`;
      } else if (totalServers > 0) {
        topBadgeText.textContent = `MCP: 连接异常`;
      } else {
        topBadgeText.textContent = `MCP: 未配置`;
      }
    }

    if (pill && pillText) {
      pill.className = 'mcp-status-pill';
      if (readyServers > 0 && readyServers === totalServers) {
        pill.classList.add('ready');
        pillText.textContent = '运行正常';
      } else if (readyServers > 0) {
        pill.classList.add('degraded');
        pillText.textContent = `${readyServers}/${totalServers} 就绪`;
      } else if (totalServers > 0) {
        pill.classList.add('error');
        pillText.textContent = '连接异常';
      } else {
        pillText.textContent = '未配置';
      }
    }

    if (tagsContainer) {
      tagsContainer.innerHTML = '';
      this.servers.slice(0, 4).forEach(s => {
        const tag = document.createElement('span');
        tag.className = 'mcp-server-tag';
        tag.innerHTML = `<span>${this.escapeHtml(s.name)}</span><span class="tag-type">[${s.type}]</span>`;
        tagsContainer.appendChild(tag);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Modal Dialog Rendering
  // ---------------------------------------------------------------------------
  renderModal() {
    if (document.getElementById('mcpModalOverlay')) {
      this.overlayEl = document.getElementById('mcpModalOverlay');
      this.modalEl = document.getElementById('mcpModal');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'mcpModalOverlay';
    overlay.className = 'mcp-modal-overlay';
    overlay.inert=true;
    overlay.innerHTML = `
      <div class="mcp-modal" id="mcpModal" role="dialog" aria-modal="true" aria-labelledby="mcpModalTitle">
        <!-- Header -->
        <div class="mcp-modal-header">
          <div class="mcp-header-left">
            <div class="mcp-header-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
              </svg>
            </div>
            <div>
              <div class="mcp-modal-title">
                <span>外部连接</span>
                <span class="mcp-spec-badge">MCP</span>
              </div>
              <div class="mcp-modal-subtitle">工具服务、社交账号与自动陪伴，统一管理</div>
            </div>
          </div>
          <div class="mcp-header-actions">
            <button type="button" class="mcp-btn" id="mcpModalRefreshBtn" title="重新检测服务器状态">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
              <span>刷新</span>
            </button>
            <button type="button" class="mcp-btn mcp-btn-primary" id="mcpModalReloadBtn" title="热重载配置并生效">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
              <span>热重载配置</span>
            </button>
            <button type="button" class="mcp-close-btn" id="mcpModalCloseBtn" title="关闭 (Esc)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <div class="mcp-tabs-bar">
          <button type="button" class="mcp-tab-btn active" data-tab="servers">
            <span>连接总览</span>
            <span class="mcp-tab-count" id="mcpTabCountServers">0</span>
          </button>
          <button type="button" class="mcp-tab-btn" data-tab="social"><span>社交与 Bot</span></button>
          <button type="button" class="mcp-tab-btn" data-tab="tools">
            <span>工具浏览器</span>
            <span class="mcp-tab-count" id="mcpTabCountTools">0</span>
          </button>
          <button type="button" class="mcp-tab-btn" data-tab="resources">
            <span>资源探索</span>
            <span class="mcp-tab-count" id="mcpTabCountResources">0</span>
          </button>
          <button type="button" class="mcp-tab-btn" data-tab="config">
            <span>高级配置</span>
          </button>
        </div>

        <!-- Body -->
        <div class="mcp-modal-body">
          <div class="mcp-modal-banner" id="mcpModalBanner"></div>

          <!-- Tab 1: Servers -->
          <div class="mcp-tab-content active" id="mcpTabServers">
            <section aria-label="常用工具套组"><h3>常用工具套组</h3><p class="mcp-doc-text">选一个预设查看配置，再确认连接。已有服务保留。</p><div id="mcpPresetList" class="mcp-preset-list"></div></section><div class="mcp-server-grid" id="mcpServersGrid"></div>
          </div>

          <!-- Tab 2: Tools -->
          <div class="mcp-tab-content" id="mcpTabTools">
            <div class="mcp-filter-bar">
              <input type="text" class="mcp-search-input" id="mcpToolsSearch" placeholder="搜索工具名称或说明..." />
              <select class="mcp-filter-select" id="mcpToolsFilterServer">
                <option value="">全部服务器</option>
              </select>
            </div>
            <div class="mcp-tools-list" id="mcpToolsList"></div>
          </div>

          <!-- Tab 3: Resources -->
          <div class="mcp-tab-content" id="mcpTabResources">
            <div class="mcp-resources-grid" id="mcpResourcesGrid"></div>
          </div>

          <div class="mcp-tab-content" id="mcpTabSocial"><h3>社交与 Bot</h3><p class="mcp-doc-text">先连接账号，再选择自动回复的会话。连接成功不等于已启用自动回复。</p><div id="mcpSocialPresets" class="mcp-preset-list"></div><section id="mcpBotForm" class="mcp-config-box" hidden></section><section id="mcpBotAutoSection" class="mcp-config-box"></section></div>
          <!-- Tab 4: Config & Specs -->
          <div class="mcp-tab-content" id="mcpTabConfig">
            <div class="mcp-config-box">
              <details><summary>Bot 自动陪伴 · 文字与语音</summary>
                <p class="mcp-doc-text">独立会话，不占桌面聊天。启用后，只响应下方指定的聊天；启动时跳过历史积压。语音经过 ASR → 陪伴 → TTS 回发，TTS 失败时回文字。QQ 私聊/群聊自动接收需在连接中设置 ONEBOT_WS_URL（NapCat 正向 WebSocket）；仅有 HTTP 时支持群历史轮询。</p>
                <label><input type="checkbox" id="botAutoEnabled">启用自动回复（会发送消息并产生模型调用费用）</label>
                <label for="botAutoChannels">响应会话：每行 服务名,聊天ID / OpenID,private 或 group；官方QQ私聊可填 *</label>
                <textarea id="botAutoChannels" rows="3" placeholder="qq-official,*,private&#10;telegram-bot,123456,private&#10;qq-bot,123456789,group"></textarea>
                <label>语音识别 <select id="botAutoAsr"><option value="local">本地 ASR</option><option value="token-plan">Token Plan ASR</option></select></label>
                <label>语音合成 <select id="botAutoVoice"><option value="qwen-cloud">已配置的千问云端音色</option><option value="local">本地音色</option></select></label>
                <label>陪伴模型（留空用 Pi 默认模型）<input id="botAutoModel" type="text"></label>
                <button type="button" id="botAutoLoad" class="mcp-btn">读取配置与状态</button>
                <button type="button" id="botAutoSave" class="mcp-btn">保存自动回复设置</button>
                <p id="botAutoStatus" role="status"></p>
              </details>

              <label for="mcpConfigImport">导入 MCP 配置（与常见客户端的 mcpServers 格式兼容）</label>
              <textarea id="mcpConfigImport" rows="8" spellcheck="false" placeholder='{"mcpServers":{"remote":{"type":"http","url":"https://example.com/mcp"}}}'></textarea>
              <p class="mcp-doc-text">默认远程连接使用 Streamable HTTP；旧服务填写 type: sse。本地服务使用 command、args、env；远程凭据填写 headers。导入会保留其他连接，同名连接更新。请仅导入可信服务。</p>
              <button type="button" class="mcp-btn" id="mcpImportBtn">保存并连接</button>
              <div class="mcp-config-path">
                <span>配置文件路径: </span>
                <code id="mcpConfigPath">data/mcp-servers.json</code>
              </div>
              <p class="mcp-doc-text">
                连接层使用官方 MCP SDK。你可以通过在 <code>data/mcp-servers.json</code> 中定义外部 Stdio、Streamable HTTP 或 SSE 服务，连接各种外部系统工具（系统监控、外部数据库、代码执行器、云服务等），无需重启主服务，点击上方「热重载」即可自动建立连接并注册工具。
              </p>
              <div class="mcp-section-label">配置样例说明</div>
              <pre class="mcp-code-block">{
  "mcpServers": {
    "system-info": {
      "command": "node",
      "args": ["tools/mcp-system-server.cjs"],
      "env": {}
    },
    "remote-service": {
      "type": "sse",
      "url": "http://127.0.0.1:8080/sse"
    }
  }
}</pre>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.overlayEl = overlay;
    this.modalEl = overlay.querySelector('.mcp-modal');
  }

  setupSocialPage(){
    const details=document.getElementById('botAutoEnabled').closest('details');
    const title=document.createElement('h3');title.textContent='自动陪伴 · 文字与语音';
    details.querySelector('summary').replaceWith(title);
    const target=document.getElementById('mcpBotAutoSection');
    target.append(...details.childNodes);details.remove();
  }

  openBotForm(preset){
    this.switchTab('social');
    const form=document.getElementById('mcpBotForm');form.replaceChildren();form.hidden=false;
    const title=document.createElement('h3');title.textContent='连接 '+preset.name;form.append(title);
    document.getElementById('mcpSocialPresets').hidden=true;
    const back=document.createElement('button');back.type='button';back.className='mcp-btn';back.textContent='返回所有平台';back.onclick=()=>{form.hidden=true;document.getElementById('mcpSocialPresets').hidden=false;};form.prepend(back);
    const config=structuredClone(preset.config),server=Object.values(config.mcpServers)[0];
    const fields=preset.id==='qq-official'?[['QQ_APP_ID','AppID'],['QQ_APP_SECRET','AppSecret']]:preset.id==='qq-bot'?[['ONEBOT_HTTP_URL','HTTP 地址'],['ONEBOT_WS_URL','正向 WebSocket 地址'],['ONEBOT_ACCESS_TOKEN','Access Token']]:[['TELEGRAM_BOT_TOKEN','BotFather Token']];
    for(const [key,name] of fields){const label=document.createElement('label'),input=document.createElement('input');label.textContent=name;input.type=(/TOKEN|SECRET/.test(key))?'password':'text';input.autocomplete='off';input.value=String(server.env[key]||'').startsWith('YOUR_')?'':server.env[key]||'';input.oninput=()=>server.env[key]=input.value.trim();label.append(input);form.append(label);}
    const note=document.createElement('p');note.className='mcp-doc-text';note.textContent=preset.id==='qq-official'?'请在 QQ 开放平台创建机器人并开通对应权限。连接后在下方填写用户或群 OpenID（不是 QQ 号），再启用自动陪伴。':preset.id==='qq-bot'?'请先启动 NapCat、登录 QQ，并开启 HTTP 与正向 WebSocket。这里连接现有服务，不会替你安装或登录 QQ。':'请先在 BotFather 创建 Bot，再让目标用户启动该 Bot。';form.append(note);
    const save=document.createElement('button');save.type='button';save.className='mcp-btn';save.textContent='保存并连接';
    const status=document.createElement('p');status.setAttribute('role','status');form.append(save,status);
    save.onclick=async()=>{save.disabled=true;try{
      if(fields.some(([key])=>!server.env[key]||server.env[key].startsWith('YOUR_')))throw Error('请填写完整连接信息');
      if(!confirm('保存该 Bot 连接？同名连接将更新，其他连接保留；自动回复需在下方单独启用。'))return;
      const response=await fetch('/api/mcp/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config,confirmed:true})});
      const data=await response.json();if(!response.ok)throw Error(data.error||'保存失败');
      await this.refreshAll();const connected=this.servers.find(s=>s.name===preset.id);
      status.textContent=connected?.status==='ready'?'连接已就绪。请在下方选择响应会话。':'配置已保存；服务尚未就绪，请在连接总览查看状态。';
      form.querySelectorAll('input[type=password]').forEach(input=>input.value='');
      for(const [key] of fields)if((/TOKEN|SECRET/.test(key)))server.env[key]='';
    }catch(error){status.textContent=error.message}finally{save.disabled=false}};
    form.scrollIntoView({block:'nearest'});form.querySelector('input')?.focus();
  }

  async loadPresets(){
    const host=document.getElementById('mcpPresetList');if(!host)return;
    try{
      const response=await fetch('/api/mcp/presets');if(!response.ok)throw Error('预设服务尚未加载，请重启后台');
      const {presets=[]}=await response.json();this.presets=presets;host.replaceChildren();const social=document.getElementById("mcpSocialPresets");social.replaceChildren();
      for(const preset of [...presets].sort((a,b)=>{const rank=id=>id==='qq-official'?0:id==='qq-bot'?1:id==='telegram-bot'?2:3;return rank(a.id)-rank(b.id)})){
        const card=document.createElement('article'),name=document.createElement('strong'),desc=document.createElement('p'),deps=document.createElement('small'),add=document.createElement('button');
        card.className='mcp-preset';name.textContent=preset.name;desc.textContent=preset.description;deps.textContent=preset.requires;
        add.type='button';add.className='mcp-btn';add.textContent=['qq-official','qq-bot','telegram-bot'].includes(preset.id)?'连接 Bot':'配置连接';
        add.onclick=()=>{if(['qq-official','qq-bot','telegram-bot'].includes(preset.id)){this.openBotForm(preset);return;}const field=document.getElementById('mcpConfigImport');if(field.value.trim()&&!window.confirm('替换尚未保存的配置草稿？'))return;field.value=JSON.stringify(preset.config,null,2);this.switchTab('config');field.focus();};
        const source=document.createElement('a');source.textContent='项目与接入说明';source.href=preset.source;source.target='_blank';source.rel='noopener noreferrer';
        const more=document.createElement('details'),summary=document.createElement('summary');summary.textContent='接入要求与说明';more.append(summary,deps,source);card.append(name,desc,more,add);(['qq-official','qq-bot','telegram-bot','postiz','xiaohongshu','x-social','feishu','bluesky'].includes(preset.id)?social:host).append(card);
      }
    }catch(error){host.textContent=error.message;}
  }

  bindEvents() {
    const botStatus=document.getElementById('botAutoStatus');
    document.getElementById('botAutoLoad')?.addEventListener('click',async()=>{try{
      const response=await fetch('/api/bot-auto');const data=await response.json();if(!response.ok)throw Error(data.error);
      document.getElementById('botAutoEnabled').checked=data.settings.enabled;
      document.getElementById('botAutoChannels').value=data.settings.channels.map(c=>[c.server,c.target,c.chatType].join(',')).join('\n');
      document.getElementById('botAutoAsr').value=data.settings.asr;
      document.getElementById('botAutoVoice').value=data.settings.voice==='vits-aishell3'?'local':'qwen-cloud';document.getElementById('botAutoModel').value=data.settings.model||'';
      botStatus.textContent=(data.settings.enabled?'已启用':'未启用')+' · '+(data.events[0]?.phase||'待机')+(data.discovered?.length?' · 最近收到的会话：'+data.discovered.map(c=>[c.server,c.target,c.chatType].join(',')).join('；'):'');
    }catch(error){botStatus.textContent=error.message}});
    document.getElementById('botAutoSave')?.addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{
      const enabled=document.getElementById('botAutoEnabled').checked;
      if(enabled&&!window.confirm('允许小派自动回复这些聊天中的消息（包括发送语音），并使用已配置的模型服务？'))return;
      const channels=document.getElementById('botAutoChannels').value.split('\n').filter(x=>x.trim()).map(line=>{const [server,target,chatType]=line.split(',').map(x=>x.trim());return{server,target,chatType}});
      const response=await fetch('/api/bot-auto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,channels,asr:document.getElementById('botAutoAsr').value,voice:document.getElementById('botAutoVoice').value,model:document.getElementById('botAutoModel').value})});
      const data=await response.json();if(!response.ok)throw Error(data.error);botStatus.textContent=enabled?'已启用，等待新的消息':'已停止自动回复';
    }catch(error){botStatus.textContent=error.message}finally{button.disabled=false}});

    document.getElementById('mcpImportBtn')?.addEventListener('click',async event=>{
      const button=event.currentTarget;button.disabled=true;
      try{
        const config=JSON.parse(document.getElementById('mcpConfigImport').value);
        if(!window.confirm('连接这些服务？本地 command 将以你的用户权限运行，远程服务将接收你调用工具时提供的数据。'))return;
        const response=await fetch('/api/mcp/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config,confirmed:true})});
        const data=await response.json();if(!response.ok)throw Error(data.error||'保存失败');
        document.getElementById('mcpConfigImport').value='';await this.refreshAll();this.switchTab('servers');
      }catch(error){this.showBanner('error',error.message)}finally{button.disabled=false;}
    });
    // Modal controls
    document.getElementById('mcpModalCloseBtn')?.addEventListener('click', () => this.close());
    this.overlayEl?.addEventListener('click', (e) => {
      if (e.target === this.overlayEl) this.close();
    });

    // Refresh & Reload
    document.getElementById('mcpModalRefreshBtn')?.addEventListener('click', () => this.refreshAll(true));
    document.getElementById('mcpModalReloadBtn')?.addEventListener('click', () => this.triggerReload());

    // Tab switching
    const tabBtns = this.overlayEl?.querySelectorAll('.mcp-tab-btn') || [];
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        this.switchTab(tab);
      });
    });

    // Tools filtering
    document.getElementById('mcpToolsSearch')?.addEventListener('input', (e) => {
      this.searchKeyword = e.target.value.toLowerCase().trim();
      this.renderToolsView();
    });

    document.getElementById('mcpToolsFilterServer')?.addEventListener('change', (e) => {
      this.filterServer = e.target.value;
      this.renderToolsView();
    });

    // Keyboard navigation
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Data Fetching & Sync
  // ---------------------------------------------------------------------------
  async refreshAll(showNotice = false) {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      const [statusRes, serversRes, toolsRes, resourcesRes] = await Promise.all([
        fetch('/api/mcp/status').then(r => r.json()),
        fetch('/api/mcp/servers').then(r => r.json()),
        fetch('/api/mcp/tools').then(r => r.json()),
        fetch('/api/mcp/resources').then(r => r.json())
      ]);

      this.statusData = statusRes;
      this.servers = serversRes?.servers || [];
      this.tools = toolsRes?.tools || [];
      this.resources = resourcesRes?.resources || [];

      // Update counts
      document.getElementById('mcpTabCountServers').textContent = String(this.servers.length);
      document.getElementById('mcpTabCountTools').textContent = String(this.tools.length);
      document.getElementById('mcpTabCountResources').textContent = String(this.resources.length);
      if (statusRes.configPath) {
        document.getElementById('mcpConfigPath').textContent = statusRes.configPath;
      }

      this.updateWidgetView();
      this.renderServersView();
      this.populateToolsFilterSelect();
      this.renderToolsView();
      this.renderResourcesView();

      if (showNotice) {
        this.showBanner('success', 'MCP 状态与服务列表已刷新');
      }
    } catch (err) {
      console.warn('[MCP] 数据拉取异常:', err.message);
      if (showNotice) {
        this.showBanner('error', `获取 MCP 数据失败: ${err.message}`);
      }
    } finally {
      this.isLoading = false;
    }
  }

  async triggerReload() {
    const btn = document.getElementById('mcpModalReloadBtn');
    const widgetBtn = document.getElementById('mcpWidgetReloadBtn');
    if (btn) btn.disabled = true;
    if (widgetBtn) widgetBtn.disabled = true;

    try {
      const res = await fetch('/api/mcp/reload', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.code !== 0) {
        throw new Error(data.error || '热重载请求失败');
      }

      const summary = data.summary || {};
      const msg = `配置热重载成功: 保留 ${summary.kept?.length || 0} 个, 新启动 ${summary.started?.length || 0} 个, 停止 ${summary.stopped?.length || 0} 个${summary.failed?.length ? `, 失败 ${summary.failed.length} 个` : ''}`;
      this.showBanner('success', msg);
      await this.refreshAll();
    } catch (err) {
      this.showBanner('error', `热重载失败: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
      if (widgetBtn) widgetBtn.disabled = false;
    }
  }

  async triggerRestartServer(serverName, buttonEl) {
    if (buttonEl) buttonEl.disabled = true;
    try {
      const res = await fetch('/api/mcp/servers/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: serverName })
      });
      const data = await res.json();
      if (!res.ok || data.code !== 0) throw new Error(data.error || '重启失败');
      this.showBanner('success', `服务器 "${serverName}" 已重新连接`);
      await this.refreshAll();
    } catch (err) {
      this.showBanner('error', `重启 "${serverName}" 失败: ${err.message}`);
    } finally {
      if (buttonEl) buttonEl.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Views Rendering
  // ---------------------------------------------------------------------------
  renderServersView() {
    const container = document.getElementById('mcpServersGrid');
    if (!container) return;
    container.innerHTML = '';

    if (this.servers.length === 0) {
      container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #64748b; padding: 40px 0;">未配置任何 MCP 服务器，请在 data/mcp-servers.json 中添加。</div>';
      return;
    }

    this.servers.forEach(s => {
      const card = document.createElement('div');
      card.className = 'mcp-server-card';
      const isReady = s.status === 'ready';
      const statusPillClass = isReady ? 'ready' : (s.status === 'connecting' ? 'degraded' : 'error');

      card.innerHTML = `
        <div class="mcp-card-header">
          <div class="mcp-server-title-row">
            <span class="mcp-server-name">${this.escapeHtml(s.name)}</span>
            <span class="mcp-server-type-badge">${this.escapeHtml(s.type)}</span>
          </div>
          <span class="mcp-status-pill ${statusPillClass}">
            <span class="mcp-dot"></span>
            <span>${this.escapeHtml(s.status)}</span>
          </span>
        </div>

        <div class="mcp-server-meta">
          <div class="mcp-meta-row"><span>提供工具</span><b>${s.toolsCount || 0} 项</b></div>
          <div class="mcp-meta-row"><span>挂载资源</span><b>${s.resourcesCount || 0} 项</b></div>
          <div class="mcp-meta-row"><span>服务端名称</span><b>${this.escapeHtml(s.serverInfo?.name || '未知')}</b></div>
          <div class="mcp-meta-row"><span>协议版本</span><b>${this.escapeHtml(s.serverInfo?.version || '1.0.0')}</b></div>
        </div>

        ${s.lastError ? `<div class="mcp-server-error">${this.escapeHtml(s.lastError)}</div>` : ''}

        <div class="mcp-server-card-actions">
          <button type="button" class="mcp-btn" data-restart="${this.escapeHtml(s.name)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <span>重启服务</span>
          </button>
        </div>
      `;

      card.querySelector('[data-restart]')?.addEventListener('click', (e) => {
        this.triggerRestartServer(s.name, e.currentTarget);
      });

      container.appendChild(card);
    });
  }

  populateToolsFilterSelect() {
    const select = document.getElementById('mcpToolsFilterServer');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">全部服务器</option>';
    this.servers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = `${s.name} (${s.type})`;
      select.appendChild(opt);
    });
    select.value = currentVal || '';
  }

  renderToolsView() {
    const container = document.getElementById('mcpToolsList');
    if (!container) return;
    container.innerHTML = '';

    let filtered = this.tools;
    if (this.filterServer) {
      filtered = filtered.filter(t => t.server === this.filterServer);
    }
    if (this.searchKeyword) {
      filtered = filtered.filter(t => 
        t.name.toLowerCase().includes(this.searchKeyword) ||
        (t.description && t.description.toLowerCase().includes(this.searchKeyword)) ||
        t.fullName.toLowerCase().includes(this.searchKeyword)
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 40px 0;">未找到符合条件的 MCP 工具。</div>';
      return;
    }

    filtered.forEach(tool => {
      const card = document.createElement('div');
      card.className = 'mcp-tool-card';

      // Sample parameters from schema
      const sampleArgs = {};
      const schemaProps = tool.inputSchema?.properties || {};
      for (const [propName, propDef] of Object.entries(schemaProps)) {
        if (propDef.type === 'string') sampleArgs[propName] = 'sample';
        else if (propDef.type === 'number') sampleArgs[propName] = 1;
        else if (propDef.type === 'boolean') sampleArgs[propName] = true;
        else sampleArgs[propName] = null;
      }
      const initialArgsStr = JSON.stringify(sampleArgs, null, 2);

      card.innerHTML = `
        <div class="mcp-tool-header">
          <div>
            <div class="mcp-tool-name-col">
              <span class="mcp-tool-name">${this.escapeHtml(tool.name)}</span>
              <span class="mcp-tool-server-badge">${this.escapeHtml(tool.server)}</span>
            </div>
            <div class="mcp-tool-desc">${this.escapeHtml(tool.description || '暂无工具描述')}</div>
          </div>
          <svg class="mcp-tool-expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>

        <div class="mcp-tool-body">
          <div class="mcp-schema-section">
            <div class="mcp-section-label">参数规范 (Input Schema)</div>
            <pre class="mcp-schema-pre">${this.escapeHtml(JSON.stringify(tool.inputSchema || {}, null, 2))}</pre>
          </div>

          <div class="mcp-runner-box">
            <div class="mcp-runner-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              <span>工具调用测试 (${this.escapeHtml(tool.fullName)})</span>
            </div>
            <textarea class="mcp-runner-input" spellcheck="false" placeholder="输入 JSON 格式调用参数...">${initialArgsStr}</textarea>
            <div class="mcp-runner-actions">
              <span style="font-size: 11px; color: #8896a8;">支持输入 JSON 对象参数</span>
              <button type="button" class="mcp-btn mcp-btn-primary mcp-run-btn">执行调用</button>
            </div>
            <div class="mcp-runner-result" style="display: none;"></div>
          </div>
        </div>
      `;

      // Header click toggles expand
      card.querySelector('.mcp-tool-header').addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      // Run button click
      const runBtn = card.querySelector('.mcp-run-btn');
      const inputEl = card.querySelector('.mcp-runner-input');
      const resultEl = card.querySelector('.mcp-runner-result');

      runBtn?.addEventListener('click', async () => {
        let parsedArgs = {};
        try {
          if (inputEl.value.trim()) {
            parsedArgs = JSON.parse(inputEl.value.trim());
          }
        } catch (e) {
          resultEl.style.display = 'block';
          resultEl.className = 'mcp-runner-result error';
          resultEl.textContent = `参数 JSON 格式错误: ${e.message}`;
          return;
        }

        runBtn.disabled = true;
        resultEl.style.display = 'block';
        resultEl.className = 'mcp-runner-result';
        resultEl.textContent = '正在通过 MCP 协议执行工具调用...';

        try {
          const res = await fetch('/api/mcp/tools/call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              server: tool.server,
              name: tool.name,
              arguments: parsedArgs
            })
          });

          const data = await res.json();
          if (!res.ok || data.isError || data.code !== 0) {
            resultEl.className = 'mcp-runner-result error';
            resultEl.textContent = `执行失败 (耗时 ${data.durationMs || 0}ms):\n${data.error || JSON.stringify(data, null, 2)}`;
          } else {
            resultEl.className = 'mcp-runner-result success';
            resultEl.textContent = `执行成功 (耗时 ${data.durationMs || 0}ms):\n${JSON.stringify(data.result, null, 2)}`;
          }
        } catch (err) {
          resultEl.className = 'mcp-runner-result error';
          resultEl.textContent = `请求异常: ${err.message}`;
        } finally {
          runBtn.disabled = false;
        }
      });

      container.appendChild(card);
    });
  }

  renderResourcesView() {
    const container = document.getElementById('mcpResourcesGrid');
    if (!container) return;
    container.innerHTML = '';

    if (this.resources.length === 0) {
      container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #64748b; padding: 40px 0;">当前连接的 MCP 服务未挂载任何资源。</div>';
      return;
    }

    this.resources.forEach(res => {
      const card = document.createElement('div');
      card.className = 'mcp-resource-card';
      card.innerHTML = `
        <div class="mcp-resource-uri">${this.escapeHtml(res.fullUri)}</div>
        <div class="mcp-resource-name">${this.escapeHtml(res.name)}</div>
        <div class="mcp-resource-desc">${this.escapeHtml(res.description || '无附加描述')}</div>
        <span class="mcp-resource-mime">${this.escapeHtml(res.mimeType || 'text/plain')}</span>
        <div style="margin-top: 6px;">
          <button type="button" class="mcp-btn mcp-read-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            <span>读取资源内容</span>
          </button>
        </div>
        <pre class="mcp-resource-viewer" style="display: none;"></pre>
      `;

      const readBtn = card.querySelector('.mcp-read-btn');
      const viewer = card.querySelector('.mcp-resource-viewer');

      readBtn?.addEventListener('click', async () => {
        readBtn.disabled = true;
        viewer.style.display = 'block';
        viewer.textContent = '正在读取上下文资源...';

        try {
          const resp = await fetch(`/api/mcp/resources/read?server=${encodeURIComponent(res.server)}&uri=${encodeURIComponent(res.uri)}`);
          const data = await resp.json();
          if (!resp.ok || data.code !== 0) {
            viewer.textContent = `读取失败: ${data.error || '未知错误'}`;
          } else {
            const contents = data.result?.contents || [];
            if (contents.length === 0) {
              viewer.textContent = '(资源内容为空)';
            } else {
              viewer.textContent = contents[0].text || '(二进制或 Base64 内容)';
            }
          }
        } catch (err) {
          viewer.textContent = `读取异常: ${err.message}`;
        } finally {
          readBtn.disabled = false;
        }
      });

      container.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------------
  // Modal State & Utilities
  // ---------------------------------------------------------------------------
  open(tab = 'servers') {
    if (this.isOpen) {this.switchTab(tab);return;}
    this.isOpen = true;
    this.returnFocus=document.activeElement;this.overlayEl.inert=false;
    this.overlayEl?.classList.add('visible');
    this.switchTab(tab);
    this.refreshAll();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlayEl.inert=true;this.returnFocus?.focus();
    this.overlayEl?.classList.remove('visible');
  }

  switchTab(tabName) {
    this.currentTab = tabName;
    const tabBtns = this.overlayEl?.querySelectorAll('.mcp-tab-btn') || [];
    tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    const tabContents = this.overlayEl?.querySelectorAll('.mcp-tab-content') || [];
    tabContents.forEach(content => {
      content.classList.remove('active');
    });

    const target = document.getElementById(`mcpTab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (target) target.classList.add('active');
  }

  showBanner(type, message) {
    const banner = document.getElementById('mcpModalBanner');
    if (!banner) return;
    banner.className = `mcp-modal-banner ${type}`;
    banner.style.display='block';
    banner.textContent = message;
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => {
      banner.style.display = 'none';
    }, 6000);
  }

  hookServerEvents() {
    // Listen for custom mcp events if application has SSE event dispatcher
    window.addEventListener('pichan_mcp_event', (e) => {
      const { type, payload } = e.detail || {};
      if (type === 'mcp_status' || type === 'mcp_reloaded') {
        this.refreshAll();
      }
    });
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Global instance helper
window.mcpPanel = new McpPanel();
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => window.mcpPanel.init());
} else {
  window.mcpPanel.init();
}
