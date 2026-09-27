/**
 * markdown-renderer.js
 * High-performance streaming Markdown renderer for π-chan Studio Dialogue.
 * Powered by marked.js + DOMPurify with requestAnimationFrame batching,
 * unclosed code-block resilience, and strict XSS sanitization.
 */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class MarkdownStreamRenderer {
  constructor(options = {}) {
    this.targetEl = options.targetEl || null;
    this.pendingText = '';
    this.renderedText = '';
    this.rafId = null;
    this.initialized = false;

    if (this.targetEl) {
      this.bindContainer(this.targetEl);
    }
  }

  bindContainer(el) {
    this.targetEl = el;
    this._initLibs();
    this._bindEvents();
  }

  _initLibs() {
    if (this.initialized) return;
    if (typeof window === 'undefined' || !window.marked) {
      console.warn('[MarkdownStreamRenderer] marked.js not yet loaded on window');
      return;
    }

    if (!window.__markedConfigured) {
      const renderer = new window.marked.Renderer();
      const defaultTable = renderer.table;

      // 1. External Link Security: Force target="_blank" and rel="noopener noreferrer"
      renderer.link = function(tokenOrHref, title, text) {
        let href = '';
        let titleStr = '';
        let linkText = '';
        if (typeof tokenOrHref === 'object' && tokenOrHref !== null) {
          href = escapeAttr(tokenOrHref.href || '');
          titleStr = tokenOrHref.title ? ` title="${escapeAttr(tokenOrHref.title)}"` : '';
          linkText = (this.parser && tokenOrHref.tokens)
            ? this.parser.parseInline(tokenOrHref.tokens)
            : escapeHtml(tokenOrHref.text || '');
        } else {
          href = escapeAttr(tokenOrHref || '');
          titleStr = title ? ` title="${escapeAttr(title)}"` : '';
          linkText = escapeHtml(text || '');
        }
        return `<a href="${href}"${titleStr} target="_blank" rel="noopener noreferrer">${linkText}</a>`;
      };

      // 2. Fenced Code Block: Header bar with language badge and horizontal-scroll container
      renderer.code = function(tokenOrCode, maybeLang) {
        let text = '';
        let lang = '';
        if (typeof tokenOrCode === 'object' && tokenOrCode !== null) {
          text = tokenOrCode.text || '';
          lang = tokenOrCode.lang || '';
        } else {
          text = tokenOrCode || '';
          lang = maybeLang || '';
        }
        const rawLang = (lang || '').trim().split(/\s+/)[0];
        const cleanLang = rawLang || 'code';
        const escapedCode = escapeHtml(text || '');
        return `<div class="code-block-wrapper">` +
          `<div class="code-header"><span class="code-lang">${escapeHtml(cleanLang)}</span></div>` +
          `<pre><code class="language-${escapeHtml(rawLang || 'plaintext')}">${escapedCode}</code></pre>` +
          `</div>`;
      };

      // 3. Table Wrapper for responsive scrolling
      renderer.table = function(...args) {
        const html = defaultTable.apply(this, args);
        return `<div class="table-wrapper">${html}</div>`;
      };

      window.marked.use({
        renderer,
        gfm: true,
        breaks: true,
        pedantic: false
      });

      // 4. DOMPurify security configuration & attribute enforcement
      if (window.DOMPurify) {
        window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
          if (node.tagName === 'A' && node.hasAttribute('href')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
        });
      }

      window.__markedConfigured = true;
    }

    this.initialized = true;
  }

  _bindEvents() {
    if (!this.targetEl) return;
    // Intercept clicks on links so navigation never happens inside this view
    this.targetEl.addEventListener('click', (e) => {
      const anchor = e.target.closest('a');
      if (anchor && anchor.href) {
        e.preventDefault();
        e.stopPropagation();
        window.open(anchor.href, '_blank', 'noopener,noreferrer');
      }
    });
  }

  /**
   * Render markdown string to target element.
   * If immediate is false, coalesces multiple text_delta updates to next requestAnimationFrame.
   */
  render(target, text, immediate = false) {
    if (target && target !== this.targetEl) {
      this.bindContainer(target);
    }
    this._initLibs();

    this.pendingText = (typeof text === 'string') ? text : '';

    if (immediate) {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this._applyRender();
    } else if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this._applyRender();
      });
    }
  }

  _applyRender() {
    if (!this.targetEl) return;
    const textToRender = this.pendingText;

    if (textToRender === this.renderedText && this.targetEl.innerHTML !== '') {
      return;
    }

    if (!textToRender) {
      this.targetEl.innerHTML = '';
      this.renderedText = '';
      return;
    }

    try {
      // Parse markdown to HTML
      let rawHtml = window.marked.parse(textToRender);

      // DOMPurify sanitization
      let cleanHtml = window.DOMPurify
        ? window.DOMPurify.sanitize(rawHtml, {
            ADD_ATTR: ['target', 'rel'],
            ADD_TAGS: ['div', 'span']
          })
        : rawHtml;

      // Preserve scroll anchor if user was scrolled near the bottom
      const el = this.targetEl;
      const previousScroll = el.scrollTop;
      const wasAtBottom = el.dataset?.followOutput !== 'false' && (el.scrollHeight - el.scrollTop - el.clientHeight) <= 40;

      el.innerHTML = cleanHtml;
      this.renderedText = textToRender;

      if (wasAtBottom) {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTop = previousScroll;
      }
    } catch (err) {
      console.error('[MarkdownStreamRenderer] Rendering error:', err);
      // Graceful fallback to textContent on any edge-case parser exception
      const previousScroll = this.targetEl.scrollTop;
      this.targetEl.textContent = textToRender;
      this.targetEl.scrollTop = this.targetEl.dataset?.followOutput === 'false' ? previousScroll : this.targetEl.scrollHeight;
    }
  }

  /**
   * Immediately flush any queued render frame.
   */
  flush() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this._applyRender();
  }

  /**
   * Reset accumulated text and clear element.
   */
  reset() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingText = '';
    this.renderedText = '';
    if (this.targetEl) {
      this.targetEl.innerHTML = '';
    }
  }
}

export function renderMarkdownToHtml(markdownText) {
  if (!markdownText) return '';
  if (typeof window !== 'undefined' && window.marked) {
    if (!window.__markedConfigured) {
      new MarkdownStreamRenderer();
    }
    const rawHtml = window.marked.parse(markdownText);
    return window.DOMPurify
      ? window.DOMPurify.sanitize(rawHtml, {
          ADD_ATTR: ['target', 'rel'],
          ADD_TAGS: ['div', 'span']
        })
      : rawHtml;
  }
  return escapeHtml(markdownText);
}

if (typeof window !== 'undefined') {
  window.MarkdownStreamRenderer = MarkdownStreamRenderer;
  window.renderMarkdownToHtml = renderMarkdownToHtml;
}
