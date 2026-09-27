/**
 * background-stream.js
 * 
 * Living Terminal Background for Pi-chan Studio.
 * 
 * Replaces abstract particle rain with a real-time terminal stream
 * directly powered by the Pi Coding Agent's live RPC event stream:
 *   - text_delta: Actual streaming assistant tokens scrolling upwards
 *   - thinking_delta: Cognitive reasoning stream (dimmer, italic slate)
 *   - tool_execution_start / tool_call_start: Real tool names and command summaries (ice cyan)
 *   - tool_execution_end / tool_call_end: Tool completion duration & status (emerald)
 *   - tool stdout: Live output snippets in right terminal column
 *   - idle state: Recent content smoothly settles and stays visible with gentle breathing dimming
 * 
 * Zero placeholder / fake text: Every character rendered originates from real events.
 * 
 * Palette Discipline:
 *   Base: Deep Obsidian Slate (#07090e, #0b0f19)
 *   Cognitive Thinking: Dimmed Slate Blue-Grey (rgba(100, 116, 139, 0.65), italic)
 *   Tool Badges: Phosphor Ice Cyan (rgba(56, 189, 248, 0.85))
 *   Tool Args / Cmd: Sky Slate (rgba(186, 230, 253, 0.75))
 *   Tool Done: Emerald Teal (rgba(52, 211, 153, 0.85))
 *   Agent Output: Crisp Silver / Slate Porcelain (rgba(226, 232, 240, 0.82))
 *   Cursor: Blinking Ice Cyan Block (rgba(56, 189, 248, 0.90))
 */

export class BackgroundStream {
  constructor(canvasId) {
    this.canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;
    if (!this.canvas) {
      throw new Error(`BackgroundStream: Canvas element '${canvasId}' not found.`);
    }
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    // Dimension & DPI
    this.width = 0;
    this.height = 0;
    this.dpr = 1;

    // Operational Phase: 'idle' | 'thinking' | 'streaming' | 'tool_executing'
    this.phase = 'idle';

    // Telemetry & Stats
    this.tokenHistory = [];
    this.tokensPerSec = 0;
    this.totalTokens = 0;
    this.tokenVelocity = 0;
    this.activeToolName = '';
    this.toolStartTimes = new Map();

    // Stream Buffer: Main Left Column (Cognitive, Tools, Agent Output)
    // Line: { id, type: 'thinking'|'output'|'tool_start'|'tool_end'|'user'|'system', prefix, text, timestamp, freshTime }
    this.lines = [];
    this.maxLines = 280;
    this.lineCounter = 0;

    // Right Column: Live Tool Execution Output (e.g. bash stdout, read content)
    // Item: { text, isHeader, timestamp, freshTime }
    this.toolLogLines = [];
    this.maxToolLogLines = 160;

    // Scrolling Mechanics
    this.scrollY = 0;
    this.targetScrollY = 0;
    this.lineHeight = 19.5;

    this.toolScrollY = 0;
    this.toolTargetScrollY = 0;
    this.toolLineHeight = 17.5;

    // Layout Columns
    this.leftColX = 44;
    this.leftColWidth = 520;
    this.rightColX = 0;
    this.rightColWidth = 0;
    this.topMargin = 76;
    this.dialogueTop = 410;
    this.viewHeight = 334;

    // Idle dynamics & soft dimming
    this.idleTimer = 0;
    this.globalAlpha = 1.0;
    this.flowOffset = 0;

    // Animation handle
    this.rafId = null;
    this.lastFrameTime = performance.now();

    // Bindings
    this.onResize = this.onResize.bind(this);
    this.render = this.render.bind(this);
  }

  init() {
    // The DOM transcript and status stream replace this canvas, not overlay it.
    // Keep the event-buffer API for callers but do not paint a duplicate text layer.
    if (this.canvas.dataset.renderer === 'dom') {
      this.canvas.hidden = true;
      return this;
    }
    this.onResize();
    window.addEventListener('resize', this.onResize);

    this.colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    this.colorScheme.addEventListener('change', this.onResize);

    // Initial system marker tag
    this.addSystemMarker('PI CODING AGENT // STANDBY RUNTIME');

    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(this.render);
    return this;
  }

  onResize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Visible window: strictly between floating dynamic island and bottom dialogue box
    // Top nav ends at ~68px; dialogue box starts at ~height - 370px
    this.palette = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? {base:'#171916', text:'#b4b9ad', accent:'#9bb8ff', muted:'#a0a798', success:'#8bd5a8', error:'#ff9684'}
      : {base:'#f4f2eb', text:'#555c56', accent:'#224eaf', muted:'#62645e', success:'#26714a', error:'#b92b20'};
    this.topMargin = 108;
    this.dialogueTop = Math.max(240, this.height - 370);
    this.viewHeight = Math.max(120, this.dialogueTop - this.topMargin);

    // Dynamic column layout
    // Left column: comfortable reading width on left flank (never blocked by center character)
    this.leftColX = Math.max(36, Math.round(this.width * 0.035));
    if (this.width >= 1200) {
      this.leftColWidth = Math.min(540, Math.round(this.width * 0.42));
      this.rightColX = Math.round(this.width * 0.62);
      this.rightColWidth = Math.max(260, this.width - this.rightColX - this.leftColX);
    } else if (this.width >= 860) {
      this.leftColWidth = Math.min(480, Math.round(this.width * 0.45));
      this.rightColX = Math.round(this.width * 0.65);
      this.rightColWidth = Math.max(200, this.width - this.rightColX - 24);
    } else {
      this.leftColWidth = Math.min(460, this.width - this.leftColX * 2);
      this.rightColX = 0;
      this.rightColWidth = 0;
    }
    // Keep text out from under the opaque history/status sidebars.
    const sidebar=document.querySelector('.history-sidebar');
    const status=document.querySelector('.runtime-panel');
    if(sidebar && this.width>760){
      this.leftColX=Math.ceil(sidebar.getBoundingClientRect().right)+24;
      const end=status ? status.getBoundingClientRect().left-24 : this.width-24;
      const available=Math.max(180,end-this.leftColX);
      this.leftColWidth=Math.max(180,Math.floor(available*.36));
      this.rightColX=Math.round(this.leftColX+available*.65);
      this.rightColWidth=Math.max(0,end-this.rightColX);
    }
  }

  // ---------------------------------------------------------------------------
  // State & Phase Control
  // ---------------------------------------------------------------------------
  setPhase(phase) {
    this.phase = phase;
    if (phase !== 'idle') {
      this.idleTimer = 0;
    }
  }

  onThinkingStart() {
    this.setPhase('thinking');
  }

  onThinkingEnd() {
    if (this.phase === 'thinking') {
      this.setPhase('idle');
    }
  }

  onTurnEnd() {
    this.setPhase('idle');
    this.activeToolName = '';
  }

  // ---------------------------------------------------------------------------
  // Stream Ingestion (Strictly Real Agent Events)
  // ---------------------------------------------------------------------------

  /**
   * User message received
   */
  onUserMessage(text) {
    if (!text || !text.trim()) return;
    const clean = text.trim();
    const lastLine = this.lines[this.lines.length - 1];
    if (lastLine && lastLine.type === 'user' && lastLine.text.includes(clean)) {
      return; // prevent duplicate user message insertion
    }
    this.setPhase('active');
    this.addWrappedLines('user', '❯ user: ', `「${clean}」`);
  }

  /**
   * Real thinking tokens from assistantMessageEvent.thinking_delta
   */
  onThinkingDelta(delta) {
    if (!delta) return;
    this.setPhase('thinking');
    this.recordTokenArrival(delta);
    this.appendStreamChunk('thinking', '[think] ', delta);
  }

  /**
   * Real final answer tokens from assistantMessageEvent.text_delta
   */
  onTextDelta(delta) {
    if (!delta) return;
    this.setPhase('streaming');
    this.recordTokenArrival(delta);
    this.appendStreamChunk('output', '● ', delta);
  }

  /**
   * Backward-compatibility token delta handler
   */
  onTokenDelta(delta) {
    this.onTextDelta(delta);
  }

  /**
   * Real tool invocation start
   */
  onToolCallStart(toolName, id) {
    this.setPhase('tool_executing');
    this.activeToolName = toolName || 'tool';
    if (id) {
      this.toolStartTimes.set(id, performance.now());
    }
  }

  /**
   * Real tool execution start with arguments
   */
  onToolExecutionStart(toolName, args, id) {
    this.setPhase('tool_executing');
    this.activeToolName = toolName || 'tool';
    const toolId = id || toolName;
    this.toolStartTimes.set(toolId, performance.now());

    let cmdSnippet = '';
    if (typeof args === 'string') {
      cmdSnippet = args;
    } else if (args && typeof args === 'object') {
      cmdSnippet = args.command || args.path || args.query || args.message || '';
      if (!cmdSnippet) {
        cmdSnippet = JSON.stringify(args);
      }
    }

    if (cmdSnippet.length > 95) {
      cmdSnippet = cmdSnippet.slice(0, 92) + '...';
    }

    this.addWrappedLines('tool_start', `› [tool: ${this.activeToolName}] `, cmdSnippet || 'invoked');

    // Right column header for stdout
    if (this.rightColWidth > 0) {
      this.addToolLog(`[EXEC // ${this.activeToolName.toUpperCase()} ${cmdSnippet}]`, true);
    }
  }

  /**
   * Real tool output stream update (stdout lines)
   */
  onToolExecutionUpdate(toolName, partialResult, args, id) {
    if (!partialResult) return;
    let text = '';
    if (typeof partialResult === 'string') {
      text = partialResult;
    } else if (partialResult.content && Array.isArray(partialResult.content)) {
      text = partialResult.content.map(c => c.text || '').join('\n');
    }

    if (text && this.rightColWidth > 0) {
      const lines = text.trim().split('\n');
      // Append only newest lines (last 3-4) to avoid flooding
      const tail = lines.slice(-4);
      for (const line of tail) {
        if (line.trim()) {
          this.addToolLog(`  ${line.trim()}`);
        }
      }
    }
  }

  /**
   * Real tool execution end
   */
  onToolExecutionEnd(toolName, result, isError, id) {
    const tName = toolName || this.activeToolName || 'tool';
    const toolId = id || tName;
    const startTime = this.toolStartTimes.get(toolId) || performance.now();
    const duration = Math.max(1, Math.round(performance.now() - startTime));
    this.toolStartTimes.delete(toolId);

    let summary = isError ? 'failed' : 'ok';
    let outputSnippet = '';

    if (result) {
      if (typeof result === 'string') {
        outputSnippet = result;
      } else if (result.content && Array.isArray(result.content)) {
        outputSnippet = result.content.map(c => c.text || '').join('\n');
      }
    }

    if (outputSnippet) {
      const lineCount = outputSnippet.trim().split('\n').length;
      if (lineCount > 1) {
        summary += ` (${lineCount} items)`;
      }
      // Stream final stdout lines to right column
      if (this.rightColWidth > 0) {
        const outLines = outputSnippet.trim().split('\n').slice(0, 10);
        for (const ol of outLines) {
          if (ol.trim()) {
            this.addToolLog(`  ${ol.trim()}`);
          }
        }
        this.addToolLog(`✔ [${tName.toUpperCase()} COMPLETED // ${duration}ms]`, true);
      }
    }

    const prefix = isError ? `✖ [${tName}] ` : `✔ [${tName}] `;
    this.addWrappedLines('tool_end', prefix, `${summary} (${duration}ms)`);
  }

  onToolCallEnd(toolName, id) {
    this.onToolExecutionEnd(toolName, null, false, id);
  }

  // ---------------------------------------------------------------------------
  // Central Event Router (SSE Bridge)
  // ---------------------------------------------------------------------------
  handlePiEvent(ev) {
    if (!ev || !ev.type) return;

    // 1. Session start / Turn start
    if (ev.type === 'agent_start' || ev.type === 'turn_start') {
      this.onThinkingStart();
      return;
    }

    // 2. Message updates (streaming deltas)
    if (ev.type === 'message_update') {
      const ame = ev.assistantMessageEvent;
      if (!ame) return;

      if (ame.type === 'thinking_delta') {
        this.onThinkingDelta(ame.delta);
        return;
      }
      if (ame.type === 'text_delta') {
        this.onTextDelta(ame.delta);
        return;
      }
      if (ame.type === 'toolcall_start') {
        this.onToolCallStart(ame.toolName, ame.id);
        return;
      }
      if (ame.type === 'toolcall_end') {
        this.onToolCallEnd(ame.toolCall?.toolName || ame.toolName, ame.toolCall?.id || ame.id);
        return;
      }
      return;
    }

    // 3. Tool execution lifecycle
    if (ev.type === 'tool_execution_start') {
      this.onToolExecutionStart(ev.toolName, ev.args, ev.toolCallId);
      return;
    }
    if (ev.type === 'tool_execution_update') {
      this.onToolExecutionUpdate(ev.toolName, ev.partialResult, ev.args, ev.toolCallId);
      return;
    }
    if (ev.type === 'tool_execution_end') {
      this.onToolExecutionEnd(ev.toolName, ev.result, ev.isError, ev.toolCallId);
      return;
    }

    // 4. Legacy tool events fallback
    if (ev.type === 'tool_call_start') {
      this.onToolExecutionStart(ev.toolName || ev.name, ev.args || ev.input, ev.toolCallId || ev.id);
      return;
    }
    if (ev.type === 'tool_call_end') {
      this.onToolExecutionEnd(ev.toolName || ev.name, ev.result, ev.isError, ev.toolCallId || ev.id);
      return;
    }

    // 5. User prompt inspection from message_start if available
    if (ev.type === 'message_start' && ev.message?.role === 'user') {
      let content = '';
      if (typeof ev.message.content === 'string') {
        content = ev.message.content;
      } else if (Array.isArray(ev.message.content)) {
        content = ev.message.content.map(c => c.text || '').join('');
      }
      if (content && content.trim()) {
        this.onUserMessage(content);
      }
      return;
    }

    // 6. Turn end / Settled
    if (ev.type === 'turn_end' || ev.type === 'agent_end' || ev.type === 'agent_settled') {
      this.onTurnEnd();
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Buffer Management & Text Wrapping
  // ---------------------------------------------------------------------------
  recordTokenArrival(delta) {
    const now = performance.now();
    this.totalTokens++;
    this.tokenHistory.push(now);

    const deltaLen = typeof delta === 'string' ? delta.length : 1;
    const impulse = Math.min(deltaLen * 0.4, 3.2);
    this.tokenVelocity = Math.min(this.tokenVelocity + impulse, 12.0);
  }

  addSystemMarker(text) {
    this.lines.push({
      id: ++this.lineCounter,
      type: 'system',
      prefix: '--- ',
      text: `${text} ---`,
      timestamp: performance.now(),
      freshTime: performance.now()
    });
    this.adjustScrollTarget();
  }

  appendStreamChunk(type, initialPrefix, chunk) {
    if (!chunk) return;
    const now = performance.now();

    // Check if chunk has explicit newlines
    const segments = chunk.split('\n');

    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];

      if (s > 0) {
        // Create new line after newline
        this.startNewLine(type, type === 'thinking' ? '       ' : '  ', '', now);
      }

      if (seg.length === 0) continue;

      // Find or create active line
      let lastLine = this.lines[this.lines.length - 1];
      if (!lastLine || lastLine.type !== type) {
        lastLine = this.startNewLine(type, initialPrefix, '', now);
      }

      // Append segment with incremental word/character wrapping
      this.appendSegmentWithWrap(lastLine, seg, now);
    }

    this.adjustScrollTarget();
  }

  startNewLine(type, prefix, text, now) {
    const line = {
      id: ++this.lineCounter,
      type,
      prefix: prefix || '',
      text: text || '',
      timestamp: now,
      freshTime: now
    };
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
    return line;
  }

  appendSegmentWithWrap(targetLine, seg, now) {
    const ctx = this.ctx;
    ctx.font = targetLine.type === 'thinking'
      ? 'italic 12px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
      : '12.5px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

    const maxW = Math.max(180, this.leftColWidth - 16);
    let remaining = seg;

    while (remaining.length > 0) {
      const fullText = targetLine.prefix + targetLine.text + remaining;
      const fullWidth = ctx.measureText(fullText).width;

      if (fullWidth <= maxW) {
        targetLine.text += remaining;
        targetLine.freshTime = now;
        break;
      }

      // Find split index
      let low = 0;
      let high = remaining.length;
      let fitLen = 0;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const testText = targetLine.prefix + targetLine.text + remaining.slice(0, mid);
        if (ctx.measureText(testText).width <= maxW) {
          fitLen = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      // Prefer breaking at space if within reasonable distance
      if (fitLen > 4 && fitLen < remaining.length) {
        const lastSpace = remaining.lastIndexOf(' ', fitLen);
        if (lastSpace > fitLen * 0.6) {
          fitLen = lastSpace + 1;
        }
      }

      if (fitLen <= 0) {
        // If even 1 char doesn't fit on this line, push to new line
        targetLine = this.startNewLine(
          targetLine.type,
          targetLine.type === 'thinking' ? '       ' : '  ',
          '',
          now
        );
        fitLen = 1;
      }

      targetLine.text += remaining.slice(0, fitLen);
      targetLine.freshTime = now;
      remaining = remaining.slice(fitLen);

      if (remaining.length > 0) {
        targetLine = this.startNewLine(
          targetLine.type,
          targetLine.type === 'thinking' ? '       ' : '  ',
          '',
          now
        );
      }
    }
  }

  addWrappedLines(type, prefix, content) {
    if (!content) return;
    const now = performance.now();
    const ctx = this.ctx;
    ctx.font = '12.5px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

    const maxW = Math.max(180, this.leftColWidth - 16);
    const paragraphs = content.split('\n');

    for (let p = 0; p < paragraphs.length; p++) {
      const para = paragraphs[p];
      const curPrefix = p === 0 ? prefix : '  ';

      if (para.length === 0) {
        this.startNewLine(type, curPrefix, '', now);
        continue;
      }

      let currentLine = this.startNewLine(type, curPrefix, '', now);
      this.appendSegmentWithWrap(currentLine, para, now);
    }

    this.adjustScrollTarget();
  }

  addToolLog(text, isHeader = false) {
    if (!text) return;
    const maxW = Math.max(120, this.rightColWidth - 16);
    let trimmed = text;
    if (trimmed.length > 80) {
      trimmed = trimmed.slice(0, 78) + '...';
    }

    this.toolLogLines.push({
      text: trimmed,
      isHeader,
      timestamp: performance.now(),
      freshTime: performance.now()
    });

    if (this.toolLogLines.length > this.maxToolLogLines) {
      this.toolLogLines.shift();
    }

    this.adjustToolScrollTarget();
  }

  adjustScrollTarget() {
    const totalH = this.lines.length * this.lineHeight;
    if (totalH > this.viewHeight) {
      this.targetScrollY = totalH - this.viewHeight;
    } else {
      this.targetScrollY = 0;
    }
  }

  adjustToolScrollTarget() {
    const totalH = this.toolLogLines.length * this.toolLineHeight;
    if (totalH > this.viewHeight) {
      this.toolTargetScrollY = totalH - this.viewHeight;
    } else {
      this.toolTargetScrollY = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Main Render Loop
  // ---------------------------------------------------------------------------
  render(time) {
    const dt = Math.min((time - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = time;

    this.update(dt, time);
    this.draw(time);

    this.rafId = requestAnimationFrame(this.render);
  }

  update(dt, time) {
    // 1. Calculate rolling TPS
    const now = performance.now();
    this.tokenHistory = this.tokenHistory.filter(t => now - t <= 1000);
    this.tokensPerSec = this.tokenHistory.length;

    // 2. Token velocity & smooth kinetic drift
    if (this.phase === 'idle') {
      this.idleTimer += dt;
      this.tokenVelocity *= Math.pow(0.88, dt * 60);
      // Soft settling alpha decay: stays at comfortable 0.55 forever, never zero
      const targetAlpha = Math.max(0.55, 1.0 - this.idleTimer * 0.02);
      this.globalAlpha += (targetAlpha - this.globalAlpha) * 0.05;
    } else {
      this.idleTimer = 0;
      this.globalAlpha += (1.0 - this.globalAlpha) * 0.15;
      this.tokenVelocity *= Math.pow(0.95, dt * 60);
    }

    // Grid drift
    const driftSpeed = 0.2 + this.tokenVelocity * 0.6;
    this.flowOffset = (this.flowOffset + driftSpeed * 60 * dt) % 48;

    // 3. Smooth Lerp Scroll Tracking
    const scrollLerp = Math.min(1, dt * (8 + this.tokenVelocity * 0.8));
    this.scrollY += (this.targetScrollY - this.scrollY) * scrollLerp;

    const toolScrollLerp = Math.min(1, dt * 10);
    this.toolScrollY += (this.toolTargetScrollY - this.toolScrollY) * toolScrollLerp;
  }

  draw(time) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w * 0.5;
    const cy = h * 0.40;

    // 1. Deep Slate Base Layer
    ctx.fillStyle = this.palette.base;
    ctx.fillRect(0, 0, w, h);

    // 2. Cool Ambient Atmospheric Core (Behind Character)
    // No radial glow: keep the character silhouette clean.

    // 3. Faint Tactical Coordinate Micro-Grid
    // The live text itself is the background; no decorative grid.

    // 4. Primary Living Stream (Left Column: Cognitive / Tools / Output)
    this.drawLeftStream(ctx, h, time);

    // 5. Secondary Tool Execution Stream (Right Column: Raw Stdout)
    if (this.rightColWidth > 0 && this.toolLogLines.length > 0) {
      this.drawRightToolStream(ctx, h);
    }

    // 6. Top & Bottom Edge Gradient Masks
    // Clip the text region instead of dark gradient masks.

    // 7. Telemetry HUD Bar
    this.drawTelemetryHUD(ctx, w, h);
  }

  drawAtmosphere(ctx, w, h, cx, cy) {
    // Soft, cool slate-indigo radial aura behind π-chan (replaces harsh orange)
    let baseAlpha = 0.09;
    let radius = Math.min(w, h) * 0.55;

    if (this.phase === 'thinking') {
      baseAlpha = 0.13 + 0.03 * Math.sin(performance.now() * 0.003);
    } else if (this.phase === 'streaming') {
      baseAlpha = 0.16 + Math.min(0.06, this.tokenVelocity * 0.01);
    } else if (this.phase === 'tool_executing') {
      baseAlpha = 0.18;
    }

    const grad = ctx.createRadialGradient(cx, cy, 20, cx, cy, radius);
    grad.addColorStop(0, `rgba(30, 58, 138, ${baseAlpha.toFixed(3)})`);
    grad.addColorStop(0.35, `rgba(14, 116, 144, ${(baseAlpha * 0.5).toFixed(3)})`);
    grad.addColorStop(0.70, `rgba(15, 23, 42, ${(baseAlpha * 0.25).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(7, 9, 14, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  drawGrid(ctx, w, h) {
    const gridSize = 48;
    const offsetY = Math.round(this.flowOffset);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.022)';
    ctx.lineWidth = 1;

    // Horizontal moving grid lines
    ctx.beginPath();
    for (let y = offsetY - gridSize; y <= h + gridSize; y += gridSize) {
      const snapY = Math.round(y) + 0.5;
      ctx.moveTo(0, snapY);
      ctx.lineTo(w, snapY);
    }
    ctx.stroke();

    // Vertical static grid lines
    ctx.beginPath();
    for (let x = 0; x <= w; x += gridSize) {
      const snapX = Math.round(x) + 0.5;
      ctx.moveTo(snapX, 0);
      ctx.lineTo(snapX, h);
    }
    ctx.stroke();

    // Subtle coordinate tick marks
    ctx.fillStyle = 'rgba(56, 189, 248, 0.04)';
    for (let x = gridSize * 2; x < w; x += gridSize * 4) {
      for (let y = offsetY + gridSize; y < h; y += gridSize * 4) {
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
  }

  drawLeftStream(ctx, h, time) {
    if (this.lines.length === 0) return;

    const startX = this.leftColX;
    const startY = this.topMargin;
    const viewBottom = this.dialogueTop + 10;
    const now = performance.now();

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const count = this.lines.length;
    for (let i = 0; i < count; i++) {
      const line = this.lines[i];
      const y = Math.round(startY + i * this.lineHeight - this.scrollY);

      // Culling: only draw visible lines
      if (y < startY - this.lineHeight || y > viewBottom + this.lineHeight) {
        continue;
      }

      // Fresh token luminance boost
      const freshAge = Math.max(0, now - line.freshTime);
      const isFresh = freshAge < 500;
      const freshBoost = isFresh ? (1 - freshAge / 500) * 0.35 : 0;

      // Font & Color per line type
      let font = '12.5px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
      let prefixColor = 'rgba(56, 189, 248, 0.75)';
      let textColor = 'rgba(203, 213, 225, 0.75)';

      if (line.type === 'system') {
        font = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
        prefixColor = 'rgba(56, 189, 248, 0.35)';
        textColor = 'rgba(56, 189, 248, 0.35)';
      } else if (line.type === 'user') {
        font = '12.5px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
        prefixColor = 'rgba(125, 211, 252, 0.90)';
        textColor = 'rgba(186, 230, 253, 0.85)';
      } else if (line.type === 'thinking') {
        font = 'italic 12px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
        prefixColor = 'rgba(71, 85, 105, 0.65)';
        textColor = isFresh
          ? `rgba(148, 163, 184, ${(0.65 + freshBoost).toFixed(2)})`
          : 'rgba(100, 116, 139, 0.60)';
      } else if (line.type === 'tool_start') {
        font = '12px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
        prefixColor = 'rgba(56, 189, 248, 0.88)';
        textColor = 'rgba(186, 230, 253, 0.78)';
      } else if (line.type === 'tool_end') {
        font = '12px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
        const isError = line.prefix.includes('✖');
        prefixColor = isError ? 'rgba(244, 63, 94, 0.85)' : 'rgba(52, 211, 153, 0.85)';
        textColor = isError ? 'rgba(253, 164, 175, 0.75)' : 'rgba(167, 243, 208, 0.75)';
      } else if (line.type === 'output') {
        font = '12.5px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
        prefixColor = 'rgba(56, 189, 248, 0.85)';
        textColor = isFresh
          ? `rgba(248, 250, 252, ${Math.min(1.0, 0.82 + freshBoost).toFixed(2)})`
          : `rgba(226, 232, 240, ${(0.80 * this.globalAlpha).toFixed(2)})`;
      }

      textColor = line.type === 'thinking' || line.type === 'system' ? this.palette.muted : this.palette.text;
      prefixColor = line.type === 'tool_end' ? (line.prefix.includes('✖') ? this.palette.error : this.palette.success) : this.palette.accent;
      ctx.font = font;

      // Draw Prefix
      let drawX = startX;
      if (line.prefix) {
        ctx.fillStyle = prefixColor;
        ctx.fillText(line.prefix, drawX, y);
        drawX += ctx.measureText(line.prefix).width;
      }

      // Draw Text
      ctx.fillStyle = textColor;
      ctx.fillText(line.text, drawX, y);

      // Blinking terminal block cursor on the active tail line
      if (i === count - 1 && (this.phase === 'streaming' || this.phase === 'thinking')) {
        const textWidth = ctx.measureText(line.text).width;
        const cursorAlpha = 0.3 + 0.6 * Math.abs(Math.sin(time * 0.005));
        ctx.fillStyle = `rgba(56, 189, 248, ${cursorAlpha.toFixed(2)})`;
        ctx.fillRect(drawX + textWidth + 3, y - 6, 6, 13);
      }
    }

    ctx.restore();
  }

  drawRightToolStream(ctx, h) {
    const startX = this.rightColX;
    const startY = this.topMargin;
    const viewBottom = this.dialogueTop + 10;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

    // Subtle header tag
    ctx.fillStyle = this.palette.accent;
    ctx.fillText('// TOOL_EXECUTION_STDOUT', startX, startY - 6);

    const count = this.toolLogLines.length;
    for (let i = 0; i < count; i++) {
      const line = this.toolLogLines[i];
      const y = Math.round(startY + 12 + i * this.toolLineHeight - this.toolScrollY);

      if (y < startY - this.toolLineHeight || y > viewBottom + this.toolLineHeight) {
        continue;
      }

      if (line.isHeader) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.60)';
      } else {
        ctx.fillStyle = `rgba(148, 163, 184, ${(0.55 * this.globalAlpha).toFixed(2)})`;
      }

      ctx.fillStyle = line.isHeader ? this.palette.accent : this.palette.muted;
      ctx.fillText(line.text, startX, y);
    }

    ctx.restore();
  }

  drawEdgeFades(ctx, w, h) {
    // Top gradient fade (cleans area under floating dynamic island)
    const topGrad = ctx.createLinearGradient(0, 0, 0, this.topMargin + 6);
    topGrad.addColorStop(0, '#07090e');
    topGrad.addColorStop(0.7, 'rgba(7, 9, 14, 0.85)');
    topGrad.addColorStop(1, 'rgba(7, 9, 14, 0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, w, this.topMargin + 6);

    // Bottom gradient fade (cleans area behind dialogue box)
    const bottomGrad = ctx.createLinearGradient(0, this.dialogueTop - 12, 0, this.dialogueTop + 36);
    bottomGrad.addColorStop(0, 'rgba(7, 9, 14, 0)');
    bottomGrad.addColorStop(0.45, 'rgba(7, 9, 14, 0.70)');
    bottomGrad.addColorStop(1, '#07090e');
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(0, this.dialogueTop - 12, w, h - (this.dialogueTop - 12));
  }

  drawTelemetryHUD(ctx, w, h) {
    ctx.font = '9.5px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = this.palette.muted;

    const phaseLabels = {
      idle: 'STANDBY // LOW_DRIFT',
      thinking: 'COGNITIVE_REASONING // PARSING',
      streaming: 'OUTPUT_STREAM // TOKEN_KINETICS',
      tool_executing: 'TOOL_EXECUTION // ACTIVE'
    };

    const phaseTag = phaseLabels[this.phase] || this.phase.toUpperCase();
    ctx.fillText(`PI_STREAM // ${phaseTag}`, this.leftColX, 68);
    ctx.fillText(
      `TPS: ${this.tokensPerSec} | TOKENS: ${this.totalTokens} | LINES: ${this.lines.length}`,
      this.leftColX + 220,
      68
    );

    if (this.activeToolName && this.phase === 'tool_executing') {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.70)';
      ctx.fillText(`ACTIVE_TOOL: [${this.activeToolName}]`, this.leftColX + 440, 68);
    }
  }

  destroy() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    window.removeEventListener('resize', this.onResize);
    this.colorScheme?.removeEventListener('change', this.onResize);
  }
}
