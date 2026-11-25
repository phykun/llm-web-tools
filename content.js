/*
 * ChatGPT 问题导航栏 - content script
 * 纯本地运行：只读取当前页面 DOM 中的用户问题文本用于显示，
 * 不发起任何网络请求、不读取 Cookie / 令牌 / 存储中的会话数据、不持久化聊天内容。
 */
(() => {
  'use strict';
  if (window.__cgnavLoaded) return;
  window.__cgnavLoaded = true;

  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return '?'; } })();
  const TAG = '[问题导航栏]';

  // ---------------------------------------------------------------- 站点配置
  const IS_CLAUDE = /(^|\.)claude\.ai$/.test(location.hostname);
  const SITE = IS_CLAUDE
    ? { name: 'Claude', convRe: /\/chat\/([\w-]+)/, turnAttr: 'data-turn-key' }
    : { name: 'ChatGPT', convRe: /\/c\/([\w-]+)/, turnAttr: 'data-content-search-turn-key' };
  const convIdOf = (path) => { const m = SITE.convRe.exec(path); return m ? m[1] : null; };
  const MIN_ITEMS_TO_SHOW = 2;     // 至少多少个问题才显示导航栏
  const MIN_CONTAINER_WIDTH = 700; // 量不到正文栏时的退路：聊天区域窄于此宽度时隐藏
  const RAIL_WIDTH = 34;           // 导航栏宽度（含内边距）
  const RAIL_RIGHT_GAP = 14;       // 导航栏与聊天区右边缘的距离
  let debug = false;

  const log = (...a) => { if (debug) console.log(TAG, ...a); };
  const warn = (...a) => console.warn(TAG, ...a);

  // ---------------------------------------------------------------- 状态
  const state = {
    enabled: true,
    convKey: null,
    convChangedAt: Date.now(),
    items: [],          // [{id, text, el, turn}] 按对话顺序
    byId: new Map(),
    container: null,    // 聊天滚动容器
    activeId: null,
    lockActiveUntil: 0,
    strategy: null,
    domCount: 0,
    scanCount: 0,
    lastScanAt: 0,
    hiddenReason: '',
    errors: [],
    busy: false,        // 正在执行查找/预加载
    loadedRows: 0,
    olderExhausted: false, // 本对话已确认没有更早的消息
  };

  function recordError(where, e) {
    const msg = `${where}: ${e && e.message ? e.message : String(e)}`;
    state.errors.push({ t: new Date().toISOString(), msg });
    if (state.errors.length > 10) state.errors.shift();
    warn(msg);
  }

  // ---------------------------------------------------------------- DOM 识别
  // 多级兜底：ChatGPT 改版时某一级失效，后面的还能接住。
  const STRATEGIES = [
    {
      // claude.ai（2026-11-25 实测）
      name: 'Claude 界面 data-testid=user-message',
      find: (root) => (IS_CLAUDE ? Array.from(root.querySelectorAll('[data-testid="user-message"]'))
        .map((u) => u.closest('[data-turn-key]') || u) : []),
    },
    {
      // 2026 年 11 月起的新版界面（已在真实页面确认）
      name: '新版界面 data-user-message-bubble',
      find: (root) => Array.from(root.querySelectorAll('[data-user-message-bubble="true"]'))
        .map((b) => b.closest('[data-chatgpt-search-unit-key], [data-content-search-unit-key]') || b),
    },
    {
      name: 'data-message-author-role',
      find: (root) => Array.from(root.querySelectorAll('[data-message-author-role="user"]')),
    },
    {
      name: 'data-turn=user',
      find: (root) => Array.from(root.querySelectorAll('[data-turn="user"]')),
    },
    {
      name: 'conversation-turn + 标题',
      find: (root) => Array.from(root.querySelectorAll('[data-testid^="conversation-turn-"]')).filter((a) => {
        const h = a.querySelector('h5, h6, .sr-only');
        return h && /^(you said|你说|您说|あなた)/i.test((h.textContent || '').trim());
      }),
    },
  ];

  // 当前对话的滚动区域。ChatGPT 切换对话后会把上一个对话隐藏保留在页面中，
  // 所以要选"可见且与网址中的对话 ID 一致"的那一个，所有识别都限定在它内部。
  function activeThreadScroll() {
    if (IS_CLAUDE) {
      const lists = Array.from(document.querySelectorAll('[data-testid="transcript-list"]'));
      const list = lists.find((l) => l.getBoundingClientRect().width > 0);
      if (!list) return null;
      for (let e = list.parentElement; e && e !== document.documentElement; e = e.parentElement) {
        if (/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) return e;
      }
      return null;
    }
    const all = Array.from(document.querySelectorAll('.thread-scroll-container'));
    if (!all.length) return null;
    const vis = all.filter((e) => e.getBoundingClientRect().width > 0);
    const m = SITE.convRe.exec(location.pathname);
    if (m) {
      const hit = vis.find((e) => e.querySelector(`[data-chatgpt-conversation-selection-target="${CSS.escape(m[1])}"]`));
      if (hit) return hit;
    }
    return vis[0] || null;
  }

  function getRoot() {
    return activeThreadScroll() || document.querySelector('main') || document.body;
  }

  // 去掉嵌套重复（外层和内层都匹配时只保留内层）
  function dedupeNested(list) {
    const set = new Set(list);
    return list.filter((el) => {
      for (const other of set) if (other !== el && el.contains(other)) return false;
      return true;
    });
  }

  function findUserMessages() {
    const root = getRoot();
    for (const s of STRATEGIES) {
      let found;
      try { found = s.find(root); } catch (e) { recordError('strategy ' + s.name, e); continue; }
      found = found.filter((el) => !el.closest('#cgnav-host'));
      if (found.length) {
        state.strategy = s.name;
        return found.length > 400 ? found : dedupeNested(found);
      }
    }
    state.strategy = null;
    return [];
  }

  function getTurn(el) {
    const t = el.closest('[data-testid^="conversation-turn-"]') || el.querySelector('[data-testid^="conversation-turn-"]');
    if (!t) return null;
    const m = /conversation-turn-(\d+)/.exec(t.getAttribute('data-testid') || '');
    return m ? parseInt(m[1], 10) : null;
  }

  function getMessageId(el) {
    const turnKeyEl = el.closest(`[${SITE.turnAttr}]`);
    if (turnKeyEl) return 'k:' + turnKeyEl.getAttribute(SITE.turnAttr);
    const own = el.getAttribute('data-message-id');
    if (own) return 'm:' + own;
    const inner = el.querySelector('[data-message-id]');
    if (inner) return 'm:' + inner.getAttribute('data-message-id');
    const outer = el.closest('[data-message-id]');
    if (outer) return 'm:' + outer.getAttribute('data-message-id');
    const turnId = (el.closest('[data-turn-id]') || {}).getAttribute?.('data-turn-id');
    if (turnId) return 't:' + turnId;
    return null;
  }

  function getText(el) {
    const node = el.querySelector('[data-user-message-bubble="true"], [data-testid="user-message"]') || el.querySelector('.whitespace-pre-wrap') || el;
    let text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    text = text.replace(/^(you said|你说|您说)\s*[:：]\s*/i, '');
    if (!text) {
      if (el.querySelector('img')) text = '[图片]';
      else if (el.querySelector('a, [data-testid*="file"], [class*="file"]')) text = '[附件]';
      else text = '[空消息]';
    }
    return text.length > 400 ? text.slice(0, 400) + '…' : text;
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  function collectVisible() {
    const els = findUserMessages();
    state.domCount = els.length;
    const seen = new Map();
    return els.map((el) => {
      const text = getText(el);
      const turn = getTurn(el);
      let id = getMessageId(el);
      if (!id) {
        const base = 'h:' + (turn != null ? 'turn' + turn : hash(text));
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        id = n > 1 ? base + '#' + n : base;
      }
      return { id, text, el, turn };
    });
  }

  // 把当前 DOM 中可见的问题合并进缓存，保证分段加载 / 虚拟列表下已滚出 DOM 的问题仍然保留
  function merge(visible) {
    const items = state.items;
    const visibleIds = new Set(visible.map((v) => v.id));
    let lastPos = -1;
    let pending = []; // 在找到第一个已知锚点前遇到的新问题

    const insertAt = (pos, arr) => {
      items.splice(pos, 0, ...arr);
      arr.forEach((v) => state.byId.set(v.id, v));
      return pos + arr.length - 1;
    };

    for (const v of visible) {
      const ex = state.byId.get(v.id);
      if (ex) {
        ex.el = v.el; ex.text = v.text; if (v.turn != null) ex.turn = v.turn;
        let pos = items.indexOf(ex);
        if (pending.length) { insertAt(pos, pending); pending = []; pos = items.indexOf(ex); }
        lastPos = pos;
      } else if (lastPos >= 0) {
        lastPos = insertAt(lastPos + 1, [v]);
      } else {
        pending.push(v);
      }
    }
    if (pending.length) {
      // 没有任何已知锚点：缓存为空则直接放入；否则按 turn 编号或追加到末尾
      if (!items.length) insertAt(0, pending);
      else if (pending[0].turn != null) {
        let pos = items.findIndex((it) => it.turn != null && it.turn > pending[0].turn);
        if (pos < 0) pos = items.length;
        insertAt(pos, pending);
      } else insertAt(items.length, pending);
    }

    // 清理：位于当前可见范围内、却已不在 DOM 中的旧问题（编辑消息/切换分支导致），视为已删除
    let lo = -1, hi = -1;
    items.forEach((it, i) => { if (visibleIds.has(it.id)) { if (lo < 0) lo = i; hi = i; } });
    if (lo >= 0) {
      for (let i = hi; i >= lo; i--) {
        const it = items[i];
        if (!visibleIds.has(it.id)) { items.splice(i, 1); state.byId.delete(it.id); }
      }
    }
  }

  // ---------------------------------------------------------------- 滚动容器
  function isScrollable(el) {
    if (!el || el === document.body) return false;
    const cs = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
  }

  function findScrollContainer(fromEl) {
    let el = fromEl ? fromEl.parentElement : null;
    while (el && el !== document.documentElement) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getContainer() {
    const known = activeThreadScroll();
    if (known) {
      if (state.container !== known) { state.container = known; observeContainer(known); }
      return known;
    }
    const c = state.container;
    const anyEl = state.items.find((it) => it.el && it.el.isConnected);
    if (c && c.isConnected && (!anyEl || c.contains(anyEl.el)) &&
        (c === document.scrollingElement || isScrollable(c))) return c;
    state.container = anyEl ? findScrollContainer(anyEl.el) : null;
    if (state.container) observeContainer(state.container);
    return state.container;
  }

  function containerRect(c) {
    if (!c || c === document.scrollingElement || c === document.documentElement) {
      return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth, width: window.innerWidth, height: window.innerHeight };
    }
    return c.getBoundingClientRect();
  }

  // 顶部栏遮挡高度：只考虑滚动区域之外、覆盖在其顶部的 header（新版 ChatGPT 的标题栏悬浮在内容上方）
  function headerOffset() {
    const c = state.container;
    const ct = containerRect(c).top;
    let cover = 0;
    for (const h of document.querySelectorAll('#page-header, header, [data-testid="chat-header"]')) {
      // 滚动区域内部的 header 多是正文里的标题（新版界面），只认旧版界面的 #page-header
      if (c && c !== document.scrollingElement && c.contains(h) && h.id !== 'page-header') continue;
      if (h.closest('#cgnav-host, nav, aside')) continue;
      const r = h.getBoundingClientRect();
      if (r.height <= 0 || r.height > 200) continue;
      if (r.top <= ct + 4 && r.bottom > ct) cover = Math.max(cover, r.bottom - ct);
    }
    return cover + 16;
  }

  // ---------------------------------------------------------------- UI
  let host, shadow, rail, track, tip, toastEl, warnEl, moreBtn;

  const CSS_TEXT = `
    :host { all: initial; }
    .rail {
      position: fixed; top: 50%; transform: translateY(-50%);
      z-index: 30; display: none;
      padding: 8px 4px; border-radius: 10px;
      max-height: calc(100vh - 220px);
      overflow-y: auto; overflow-x: hidden; scrollbar-width: none;
      font-family: ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      transition: background-color .15s;
    }
    .rail::-webkit-scrollbar { display: none; }
    .rail.show { display: block; }
    .rail:hover { background: var(--rail-hover-bg); }
    .track { display: flex; flex-direction: column; align-items: flex-end; }
    .tick {
      all: unset; box-sizing: border-box; cursor: pointer;
      display: flex; align-items: center; justify-content: flex-end;
      width: 26px; height: var(--tick-h, 12px); padding-right: 2px;
    }
    .tick i {
      display: block; height: 2px; width: 10px; border-radius: 2px;
      background: var(--tick); transition: width .12s, background-color .12s;
    }
    .tick:hover i { width: 18px; background: var(--tick-hover); }
    .tick.active i { width: 18px; background: var(--tick-active); height: 2.5px; }
    .more {
      all: unset; box-sizing: border-box; cursor: pointer; display: none;
      width: 26px; height: 16px; padding-right: 2px; margin-bottom: 4px;
      align-items: center; justify-content: flex-end; gap: 2px;
    }
    .more.show { display: flex; }
    .more b { display: block; width: 3px; height: 3px; border-radius: 50%; background: var(--tick); }
    .more:hover b { background: var(--tick-hover); }
    .tick:focus-visible i { outline: 2px solid var(--tick-active); outline-offset: 2px; }
    .tip {
      position: fixed; z-index: 31; display: none; pointer-events: none;
      max-width: 320px; min-width: 120px; padding: 8px 10px; border-radius: 10px;
      font: 13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: var(--tip-fg); background: var(--tip-bg);
      box-shadow: 0 4px 16px rgba(0,0,0,.18); border: 1px solid var(--tip-border);
    }
    .tip.show { display: block; }
    .tip .n { font-size: 11px; opacity: .6; margin-bottom: 2px; }
    .tip .t { display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; white-space: normal; }
    .toast {
      position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%);
      z-index: 32; display: none; padding: 7px 14px; border-radius: 999px;
      font: 13px/1.4 ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: var(--tip-fg); background: var(--tip-bg); border: 1px solid var(--tip-border);
      box-shadow: 0 4px 16px rgba(0,0,0,.18);
    }
    .toast.show { display: block; }
    .warn {
      position: fixed; top: 50%; z-index: 30; display: none; cursor: help;
      width: 8px; height: 8px; border-radius: 50%; background: #e8a33d; opacity: .7;
    }
    .warn.show { display: block; }
    :host([data-theme="light"]) {
      --tick: rgba(0,0,0,.22); --tick-hover: rgba(0,0,0,.55); --tick-active: rgba(0,0,0,.85);
      --tip-bg: #ffffff; --tip-fg: #0d0d0d; --tip-border: rgba(0,0,0,.1);
      --rail-hover-bg: rgba(0,0,0,.04);
    }
    :host([data-theme="dark"]) {
      --tick: rgba(255,255,255,.25); --tick-hover: rgba(255,255,255,.6); --tick-active: rgba(255,255,255,.92);
      --tip-bg: #2f2f2f; --tip-fg: #ececec; --tip-border: rgba(255,255,255,.12);
      --rail-hover-bg: rgba(255,255,255,.05);
    }
  `;

  function ensureUI() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'cgnav-host';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    rail = document.createElement('nav');
    rail.className = 'rail';
    rail.setAttribute('aria-label', '对话问题导航');
    moreBtn = document.createElement('button');
    moreBtn.className = 'more';
    moreBtn.setAttribute('aria-label', '加载更早的问题');
    moreBtn.innerHTML = '<b></b><b></b><b></b>';
    rail.appendChild(moreBtn);
    track = document.createElement('div');
    track.className = 'track';
    rail.appendChild(track);
    moreBtn.addEventListener('mouseenter', () => showTipText(moreBtn, '更早的消息', '这个对话可能还有更早的消息没有加载。点击加载，并跳到最早的问题'));
    moreBtn.addEventListener('mouseleave', hideTip);
    moreBtn.addEventListener('click', (e) => { e.preventDefault(); loadOlderAndJump(); });
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.innerHTML = '<div class="n"></div><div class="t"></div>';
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    warnEl = document.createElement('div');
    warnEl.className = 'warn';
    warnEl.title = '问题导航栏：未识别到对话消息。点击浏览器工具栏中的扩展图标查看诊断信息。';
    shadow.append(style, rail, tip, toastEl, warnEl);
    (document.body || document.documentElement).appendChild(host);
    applyTheme();
    lastSignature = '';

    track.addEventListener('mouseover', (e) => {
      const b = e.target.closest('.tick');
      if (b) showTip(b);
    });
    track.addEventListener('mouseleave', hideTip);
    track.addEventListener('focusin', (e) => { const b = e.target.closest('.tick'); if (b) showTip(b); });
    track.addEventListener('focusout', hideTip);
    track.addEventListener('click', (e) => {
      const b = e.target.closest('.tick');
      if (!b) return;
      e.preventDefault();
      const item = state.byId.get(b.dataset.id);
      if (item) jumpTo(item);
    });
  }

  function applyTheme() {
    if (!host) return;
    const cl = document.documentElement.classList;
    const dt = document.documentElement.getAttribute('data-theme');
    const dm = document.documentElement.getAttribute('data-mode'); // claude.ai
    let dark;
    if (dm === 'dark' || dm === 'light') dark = dm === 'dark';
    else if (dt === 'dark' || dt === 'light') dark = dt === 'dark';
    else if (cl.contains('dark')) dark = true;
    else if (cl.contains('light')) dark = false;
    else dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    host.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  function showTip(btn) {
    const item = state.byId.get(btn.dataset.id);
    if (!item) return;
    const idx = state.items.indexOf(item);
    const more = moreVisible() ? '（已加载部分）' : '';
    showTipText(btn, `第 ${idx + 1} / ${state.items.length} 个问题${more}`, item.text);
  }

  function showTipText(btn, head, body) {
    tip.querySelector('.n').textContent = head;
    tip.querySelector('.t').textContent = body;
    const r = btn.getBoundingClientRect();
    const railR = rail.getBoundingClientRect();
    // 以导航栏左边缘为基准，从右往左展开：提示框右边缘固定在导航栏左侧 8px，永远不会盖住导航栏。
    // （旧做法先量宽度再设 left，量的时候宽度会受上一次位置影响，导致提示框伸到导航栏上。）
    tip.style.left = 'auto';
    tip.style.right = Math.max(0, window.innerWidth - railR.left + 8) + 'px';
    tip.style.maxWidth = Math.max(120, Math.min(320, railR.left - 16)) + 'px';
    tip.classList.add('show');
    const th = tip.offsetHeight;
    let top = r.top + r.height / 2 - th / 2;
    top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
    tip.style.top = top + 'px';
  }
  function hideTip() { if (tip) tip.classList.remove('show'); }

  let toastTimer = 0;
  function toast(msg, ms = 2200) {
    ensureUI();
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
  function hideToast() { if (toastEl) toastEl.classList.remove('show'); }

  let lastSignature = '';
  function render() {
    ensureUI();
    const items = state.items;
    const sig = items.map((it) => it.id).join('|');
    if (sig !== lastSignature) {
      lastSignature = sig;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < items.length; i++) {
        const b = document.createElement('button');
        b.className = 'tick';
        b.dataset.id = items[i].id;
        b.setAttribute('aria-label', `跳转到第 ${i + 1} 个问题`);
        b.appendChild(document.createElement('i'));
        frag.appendChild(b);
      }
      track.replaceChildren(frag);
      hideTip();
      state.activeId = null;
    }
    updateLayout();
    updateActive(false);
  }

  // 正文栏的右边缘（屏幕坐标），量不到时返回 null
  function contentColumnRight() {
    const root = getRoot();
    let col = null;
    if (IS_CLAUDE) col = root.querySelector('[data-testid="transcript-list"]');
    else col = root.querySelector('[data-thread-user-message-navigation-content]');
    if (col) {
      const r = col.getBoundingClientRect();
      // 扣除内边距，得到文字实际的右边缘（ChatGPT 的正文栏有 20px 右内边距，2026-11-25 实测）
      if (r.width > 0) return r.right - (parseFloat(getComputedStyle(col).paddingRight) || 0);
    }
    // 退路：用已渲染消息的右边缘；占满整个聊天区宽度的块元素量不出正文宽度，忽略
    const cw = containerRect(state.container).width;
    let max = null;
    for (const it of state.items) {
      if (it.el && it.el.isConnected) {
        const r = it.el.getBoundingClientRect();
        if (r.width > 0 && r.width < cw * 0.9) max = Math.max(max == null ? -Infinity : max, r.right);
      }
    }
    return max;
  }

  function updateLayout() {
    if (!rail) return;
    const c = getContainer();
    const rect = containerRect(c);
    const n = state.items.length;
    let reason = '';
    if (!state.enabled) reason = '已在扩展弹窗中关闭';
    else if (n < MIN_ITEMS_TO_SHOW) reason = n ? `问题少于 ${MIN_ITEMS_TO_SHOW} 个` : '未识别到问题';
    else {
      // 正文栏右边缘与导航栏之间要留出空隙，否则隐藏，避免遮挡正文
      const contentRight = contentColumnRight();
      const railLeft = rect.right - RAIL_RIGHT_GAP - RAIL_WIDTH;
      if (contentRight != null) {
        if (contentRight + 4 > railLeft) reason = `正文右侧空间不足（${Math.max(0, Math.round(railLeft - contentRight))}px）`;
      } else if (rect.width < MIN_CONTAINER_WIDTH) reason = `聊天区域过窄（${Math.round(rect.width)}px）`;
    }
    state.hiddenReason = reason;

    // 诊断提示点：在对话页面停留一段时间仍未识别到任何问题
    const isConv = !!convIdOf(location.pathname);
    const showWarn = state.enabled && isConv && state.domCount === 0 && state.items.length === 0 &&
                     Date.now() - state.convChangedAt > 6000;
    warnEl.classList.toggle('show', showWarn);
    warnEl.style.right = Math.max(6, window.innerWidth - rect.right + 16) + 'px';

    if (reason) { rail.classList.remove('show'); hideTip(); return; }
    moreBtn.classList.toggle('show', moreVisible());
    const avail = Math.max(120, window.innerHeight - 220 - 16 - (moreVisible() ? 20 : 0));
    const tickH = Math.max(4, Math.min(14, Math.floor(avail / n)));
    rail.style.setProperty('--tick-h', tickH + 'px');
    rail.style.right = Math.max(4, window.innerWidth - rect.right + RAIL_RIGHT_GAP) + 'px';
    rail.classList.add('show');
  }

  // 当前阅读位置：阅读线（容器顶部 + 头部高度 + 一定比例）之上最后一个问题
  function computeActive() {
    const c = getContainer();
    if (!c) return null;
    const rect = containerRect(c);
    const anchor = rect.top + headerOffset() + Math.min(160, rect.height * 0.25);
    const connected = state.items.filter((it) => it.el && it.el.isConnected);
    if (!connected.length) return null;
    const sc = c === document.documentElement ? document.scrollingElement : c;
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) {
      // 已到底部：如果最后一个问题已进入视口，则它为当前
      const last = connected[connected.length - 1];
      if (last.el.getBoundingClientRect().top < rect.bottom) return last.id;
    }
    let active = null;
    for (const it of connected) {
      const top = it.el.getBoundingClientRect().top;
      if (top <= anchor) active = it;
      else break;
    }
    return (active || connected[0]).id;
  }

  function updateActive(force) {
    if (!track || !rail.classList.contains('show')) return;
    if (Date.now() < state.lockActiveUntil && !force) return;
    if (!state.activeId) force = true;
    let id;
    try { id = computeActive(); } catch (e) { recordError('computeActive', e); return; }
    if (!id || (id === state.activeId && !force)) return;
    setActive(id);
  }

  function setActive(id) {
    state.activeId = id;
    const prev = track.querySelector('.tick.active');
    if (prev && prev.dataset.id !== id) prev.classList.remove('active');
    const btn = track.querySelector(`.tick[data-id="${CSS.escape(id)}"]`);
    if (btn) {
      btn.classList.add('active');
      // 导航栏本身可滚动时，保持高亮项可见
      const br = btn.getBoundingClientRect(), rr = rail.getBoundingClientRect();
      if (br.top < rr.top + 8 || br.bottom > rr.bottom - 8) {
        rail.scrollTop += (br.top - rr.top) - rr.height / 2;
      }
    }
  }

  // ---------------------------------------------------------------- 跳转
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 程序滚动前先发送一个滚轮事件：新版 ChatGPT 处于"贴底跟随"状态时，
  // 只有检测到用户滚动意图才会解除，否则会在内容高度变化时把页面拉回底部。
  // 合成的滚轮事件本身不会产生滚动，只用于告知页面"这是用户主动滚动"。
  function setScroll(sc, top) {
    const target = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, top));
    const dy = target < sc.scrollTop ? -100 : 100;
    try { sc.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true })); } catch { /* ignore */ }
    sc.scrollTop = target;
  }

  function userUnitOfTurn(turnEl) {
    if (IS_CLAUDE) return turnEl;
    const b = turnEl.querySelector('[data-user-message-bubble="true"]');
    return b ? (b.closest('[data-chatgpt-search-unit-key], [data-content-search-unit-key]') || b) : turnEl;
  }

  function resolveEl(item) {
    if (item.el && item.el.isConnected) return item.el;
    if (item.id.startsWith('k:')) {
      const t = getRoot().querySelector(`[${SITE.turnAttr}="${CSS.escape(item.id.slice(2))}"]`);
      item.el = t ? userUnitOfTurn(t) : null;
      return item.el;
    }
    if (item.id.startsWith('m:')) {
      const raw = item.id.slice(2);
      const n = document.querySelector(`[data-message-id="${CSS.escape(raw)}"]`);
      if (n) {
        const el = n.closest('[data-message-author-role="user"]') || n;
        item.el = el;
        return el;
      }
    }
    return null;
  }

  function scrollToEl(el, smooth = true) {
    const c = findScrollContainer(el);
    const rect = containerRect(c);
    const delta = el.getBoundingClientRect().top - rect.top - headerOffset();
    const sc = (c === document.documentElement || c === document.body) ? document.scrollingElement : c;
    try { sc.dispatchEvent(new WheelEvent('wheel', { deltaY: delta < 0 ? -100 : 100, bubbles: true, cancelable: true })); } catch { /* ignore */ }
    sc.scrollTo({ top: sc.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
  }

  function flash(el) {
    try {
      el.animate(
        [{ boxShadow: '0 0 0 2px rgba(16,163,127,.75)', borderRadius: '12px' },
         { boxShadow: '0 0 0 2px rgba(16,163,127,0)', borderRadius: '12px' }],
        { duration: 1400, easing: 'ease-out' });
    } catch { /* ignore */ }
  }

  function moreVisible() {
    return bridgeInfo.ok && bridgeInfo.hasOlder === true && !state.olderExhausted;
  }

  // 让页面自己加载更早的一批回合：把聊天区滚到顶部，等待已加载回合数增加（扩展自身不发任何请求）。
  // 返回新增的回合数；等待超时仍无新增则判定已到对话开头。
  async function loadOlderOnce() {
    const c = getContainer();
    if (!c) return 0;
    const sc = c === document.documentElement ? document.scrollingElement : c;
    scanNow();
    const before = state.loadedRows;
    for (let attempt = 0; attempt < 2; attempt++) {
      setScroll(sc, 0);
      for (let w = 0; w < 30; w++) { // 每次最多等 3 秒
        await sleep(100);
        scanNow();
        if (state.loadedRows > before) return state.loadedRows - before;
      }
    }
    state.olderExhausted = true;
    return 0;
  }

  async function loadOlderAndJump() {
    if (state.busy) return;
    state.busy = true;
    toast('正在加载更早的消息…', 0);
    let added = 0;
    try { added = await loadOlderOnce(); } catch (e) { recordError('loadOlder', e); } finally { state.busy = false; hideToast(); }
    render();
    if (added > 0) {
      toast(`已加载 ${added} 个更早的回合`);
      const first = state.items[0];
      if (first) jumpTo(first);
    } else {
      toast('已经是这个对话最早的消息');
    }
  }

  // 把目标回合滚动到阅读位置（已在真实页面验证）。
  // 新版 ChatGPT 的虚拟列表在渲染新回合后会重新测量高度，但不会补偿滚动位置，内容会"漂移"；
  // 刚打开对话的几秒内还会恢复上次的位置。因此采用：跳转 → 等待 → 按实际位置校正，
  // 直到目标连续两次对齐且页面高度不再变化。用户在此期间自己滚动则立即停止。
  async function settleTo(item) {
    const c = getContainer();
    if (!c) return null;
    const sc = c === document.documentElement ? document.scrollingElement : c;
    let userInterrupted = false;
    const stop = (e) => { if (e.isTrusted) userInterrupted = true; };
    const evs = ['wheel', 'touchstart', 'keydown'];
    evs.forEach((t) => window.addEventListener(t, stop, { capture: true, passive: true }));
    try {
      let stable = 0, lastH = -1;
      for (let iter = 0; iter < 20 && !userInterrupted; iter++) {
        refreshEls();
        const el = resolveEl(item);
        const maxTop = sc.scrollHeight - sc.clientHeight;
        if (el) {
          const off = el.getBoundingClientRect().top - containerRect(c).top - headerOffset();
          const ok = Math.abs(off) < 8 || (off > 0 && sc.scrollTop >= maxTop - 2) || (off < 0 && sc.scrollTop <= 0);
          if (ok && sc.scrollHeight === lastH) { if (++stable >= 2) return el; } else stable = 0;
          if (!ok) setScroll(sc, sc.scrollTop + off);
        } else if (typeof item.top === 'number') {
          stable = 0;
          const idx = state.items.indexOf(item);
          let anchor = null, best = Infinity;
          state.items.forEach((it, i) => {
            if (typeof it.top === 'number' && it.el && it.el.isConnected && Math.abs(i - idx) < best) { best = Math.abs(i - idx); anchor = it; }
          });
          if (!anchor) return null;
          const wrap = anchor.el.closest('[data-virtualized-turn]') || anchor.el;
          const anchorAbs = sc.scrollTop + wrap.getBoundingClientRect().top - containerRect(c).top;
          setScroll(sc, anchorAbs + (item.top - anchor.top) - headerOffset());
        } else {
          return null;
        }
        lastH = sc.scrollHeight;
        await sleep(200);
        scanNow(); // 同步最新的位置数据
      }
      return resolveEl(item);
    } finally {
      evs.forEach((t) => window.removeEventListener(t, stop, { capture: true }));
    }
  }

  let cmdReply = null;
  document.addEventListener('cgnav:cmdres', (e) => { if (typeof e.detail === 'string') cmdReply = e.detail; });
  function bridgeCmd(cmd) {
    cmdReply = null;
    document.dispatchEvent(new CustomEvent('cgnav:cmd', { detail: JSON.stringify(cmd) }));
    if (!cmdReply) return { ok: false, reason: '桥接脚本未响应' };
    try { return JSON.parse(cmdReply); } catch { return { ok: false, reason: '桥接数据无法解析' }; }
  }

  // Claude：页面自带的 scrollToIndex 会把目标行对齐到顶部栏下方（实测稳定），这里只做确认和最多两次重试
  async function claudeJump(item) {
    const c = getContainer();
    for (let attempt = 0; attempt < 3; attempt++) {
      scanNow(); // 同步最新的行号
      const r = bridgeCmd({ op: 'scrollToIndex', index: item.index, id: item.id.slice(2) });
      if (!r.ok) { recordError('claudeJump', new Error(r.reason || '跳转失败')); return null; }
      await sleep(attempt ? 600 : 400);
      refreshEls();
      const el = resolveEl(item);
      if (el && c) {
        const top = el.getBoundingClientRect().top - containerRect(c).top;
        if (top > -20 && top < 260) return el;
      }
    }
    return resolveEl(item);
  }

  async function jumpTo(item) {
    if (state.busy) return;
    state.lockActiveUntil = Date.now() + 4000;
    setActive(item.id);
    let el = null;
    if (IS_CLAUDE && Number.isInteger(item.index)) {
      // Claude：调用页面自带的"滚动到第 N 行"，再确认位置
      state.busy = true;
      try { el = await claudeJump(item); } catch (e) { recordError('claudeJump', e); } finally { state.busy = false; }
      if (!el) el = await searchFor(item);
    } else if (typeof item.top === 'number') {
      // 新版虚拟列表：用页面自己的位置数据定位，并循环校正
      state.busy = true;
      try { el = await settleTo(item); } catch (e) { recordError('settleTo', e); } finally { state.busy = false; }
    } else {
      el = resolveEl(item);
      if (el) scrollToEl(el, true);
      else el = await searchFor(item);
    }
    if (!el) { state.lockActiveUntil = 0; toast('未能定位该问题：可能尚未加载。可在扩展弹窗中点击“加载完整历史”后重试。', 3500); return; }
    state.lockActiveUntil = Date.now() + 700;
    setActive(item.id);
    setTimeout(() => {
      const e2 = resolveEl(item);
      if (!e2) return;
      if (typeof item.top !== 'number') {
        const off = e2.getBoundingClientRect().top - containerRect(findScrollContainer(e2)).top - headerOffset();
        if (Math.abs(off) > 24) scrollToEl(e2, false);
      }
      flash(e2);
    }, typeof item.top === 'number' ? 50 : 650);
    setTimeout(() => updateActive(true), 900);
  }

  // 目标问题不在 DOM 中（虚拟列表/分段加载）时：
  // 先按"已渲染问题的位置 + 平均回合高度"估算目标位置直接跳过去，再逐步校正；最后退回逐屏滚动查找。
  async function searchFor(item) {
    const c = getContainer();
    if (!c) return null;
    const sc = c === document.documentElement ? document.scrollingElement : c;
    state.busy = true;
    toast('正在定位该问题…', 0);
    try {
      let lastTarget = -1, same = 0;
      for (let iter = 0; iter < 16; iter++) {
        refreshEls();
        const el = resolveEl(item);
        if (el) return el;
        const idx = state.items.indexOf(item);
        const n = state.items.length;
        if (idx < 0) return null;
        const cTop = containerRect(c).top;
        const conn = [];
        state.items.forEach((it, i) => {
          if (it.el && it.el.isConnected) conn.push({ i, top: sc.scrollTop + it.el.getBoundingClientRect().top - cTop });
        });
        let avgH = sc.scrollHeight / Math.max(1, n);
        if (conn.length >= 2) {
          const a = conn[0], b = conn[conn.length - 1];
          if (b.i > a.i) avgH = Math.max(80, (b.top - a.top) / (b.i - a.i));
        }
        let target;
        if (!conn.length) target = idx * avgH;
        else {
          let near = conn[0];
          for (const x of conn) if (Math.abs(x.i - idx) < Math.abs(near.i - idx)) near = x;
          target = near.top + (idx - near.i) * avgH;
        }
        target = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, target - headerOffset()));
        if (Math.abs(target - lastTarget) < 4) same++; else same = 0;
        lastTarget = target;
        if (same >= 2) {
          // 估算停滞：朝目标方向逐屏推进
          const dir = conn.length && idx < conn[0].i ? -1 : 1;
          setScroll(sc, sc.scrollTop + (dir * sc.clientHeight * 0.8));
        } else {
          setScroll(sc, target);
        }
        await sleep(160);
        scanNow();
      }
      // 兜底：逐屏滚动
      const conn0 = state.items.findIndex((it) => it.el && it.el.isConnected);
      const dir = state.items.indexOf(item) < conn0 ? -1 : 1;
      let stuck = 0;
      for (let step = 0; step < 120 && stuck < 6; step++) {
        const before = sc.scrollTop, beforeH = sc.scrollHeight;
        setScroll(sc, before + dir * sc.clientHeight * 0.9);
        await sleep(200);
        scanNow();
        const el = resolveEl(item);
        if (el) return el;
        stuck = (sc.scrollTop === before && sc.scrollHeight === beforeH) ? stuck + 1 : 0;
      }
      return null;
    } finally {
      state.busy = false;
      hideToast();
    }
  }

  // 预加载：滚动到顶部直到不再出现新消息，把整段对话的问题都收进导航栏，然后回到原位置
  async function preloadAll() {
    const c = getContainer();
    if (!c) return { ok: false, msg: '未找到聊天滚动区域' };
    if (state.busy) return { ok: false, msg: '正在执行其他操作' };
    if (syncFromBridge()) {
      render();
      if (!moreVisible()) {
        toast(`已是完整列表：共 ${state.items.length} 个问题`);
        return { ok: true, total: state.items.length, added: 0 };
      }
      const anchorId = state.activeId;
      const start = state.items.length;
      state.busy = true;
      toast('正在加载更早的消息…', 0);
      try {
        for (let i = 0; i < 200; i++) { if ((await loadOlderOnce()) === 0) break; }
      } catch (e) { recordError('preload', e); } finally { state.busy = false; hideToast(); }
      render();
      const anchor = anchorId && state.byId.get(anchorId);
      if (anchor) await settleTo(anchor);
      const added = state.items.length - start;
      toast(`已加载完成：共 ${state.items.length} 个问题${added > 0 ? `（新增 ${added}）` : ''}`);
      return { ok: true, total: state.items.length, added };
    }
    const sc = c === document.documentElement ? document.scrollingElement : c;
    const anchorId = state.activeId;
    const startCount = state.items.length;
    state.busy = true;
    toast('正在加载完整历史…', 0);
    try {
      let stable = 0;
      for (let i = 0; i < 200 && stable < 4; i++) {
        const h = sc.scrollHeight, n = state.items.length;
        setScroll(sc, 0);
        await sleep(500);
        scanNow();
        stable = (sc.scrollTop === 0 && sc.scrollHeight === h && state.items.length === n) ? stable + 1 : 0;
      }
      // 自顶向下扫一遍，覆盖虚拟列表只渲染视口附近消息的情况
      let guard = 0;
      while (guard++ < 2000) {
        const before = sc.scrollTop;
        setScroll(sc, before + sc.clientHeight * 0.85);
        await sleep(120);
        scanNow();
        if (sc.scrollTop === before) break;
      }
    } finally {
      state.busy = false;
      hideToast();
    }
    const anchor = anchorId && state.byId.get(anchorId);
    const el = anchor && resolveEl(anchor);
    if (el) scrollToEl(el, false);
    const added = state.items.length - startCount;
    toast(`已加载完成：共 ${state.items.length} 个问题${added > 0 ? `（新增 ${added}）` : ''}`);
    return { ok: true, total: state.items.length, added };
  }

  // ---------------------------------------------------------------- 页面桥接（完整问题列表）
  let bridgeReply = null;
  const bridgeInfo = { ok: false, reason: '尚未请求', totalRows: 0, hasOlder: null, hasGeometry: false };
  document.addEventListener('cgnav:rows', (e) => { if (typeof e.detail === 'string') bridgeReply = e.detail; });

  function queryBridge() {
    bridgeReply = null;
    document.dispatchEvent(new CustomEvent('cgnav:req'));
    if (!bridgeReply) return { ok: false, reason: '桥接脚本未响应' };
    try { return JSON.parse(bridgeReply); } catch { return { ok: false, reason: '桥接数据无法解析' }; }
  }

  // 把页面上已渲染的回合元素对应到列表项
  function refreshEls() {
    if (!state.items.some((it) => it.id.startsWith('k:'))) return;
    const map = new Map();
    for (const t of getRoot().querySelectorAll(`[${SITE.turnAttr}]`)) {
      const k = 'k:' + t.getAttribute(SITE.turnAttr);
      if (!map.has(k)) map.set(k, t);
    }
    for (const it of state.items) {
      const t = map.get(it.id);
      if (!t) { if (it.el && !it.el.isConnected) it.el = null; continue; }
      if (!(it.el && it.el.isConnected && t.contains(it.el))) it.el = userUnitOfTurn(t);
    }
  }

  function syncFromBridge() {
    const r = queryBridge();
    bridgeInfo.ok = !!(r && r.ok);
    bridgeInfo.reason = r && r.reason ? r.reason : '';
    bridgeInfo.totalRows = r && r.totalRows ? r.totalRows : 0;
    bridgeInfo.hasOlder = r && typeof r.hasOlder === 'boolean' ? r.hasOlder : null;
    bridgeInfo.hasGeometry = !!(r && r.hasGeometry);
    if (!r || !r.ok || !Array.isArray(r.rows) || !r.rows.length) return false;
    // 防止对话切换瞬间读到上一个对话的数据
    const cid = convIdOf(location.pathname);
    if (cid && r.conv && r.conv !== cid) { bridgeInfo.reason = '列表数据与当前对话不一致，等待刷新'; return false; }
    const next = r.rows.map((row) => {
      const id = 'k:' + row.id;
      const old = state.byId.get(id);
      if (old) { old.text = row.text; old.top = row.top; old.index = row.index; return old; }
      return { id, text: row.text, el: null, turn: null, top: row.top, index: row.index };
    });
    // 记录已加载的回合数，用于判断"加载更早"是否还有新内容
    state.loadedRows = r.totalRows || next.length;
    state.items = next;
    state.byId = new Map(next.map((it) => [it.id, it]));
    refreshEls();
    state.strategy = '页面列表数据（完整列表）';
    state.domCount = getRoot().querySelectorAll('[data-user-message-bubble="true"], [data-testid="user-message"]').length;
    return true;
  }

  // ---------------------------------------------------------------- 扫描调度
  function scanNow() {
    try {
      checkConversation();
      if (!state.enabled) { if (rail) updateLayout(); return; }
      if (!syncFromBridge()) {
        const visible = collectVisible();
        merge(visible);
      }
      state.scanCount++;
      state.lastScanAt = Date.now();
      render();
    } catch (e) {
      recordError('scan', e);
    }
  }

  let scanTimer = 0, firstPending = 0;
  function scheduleScan() {
    const now = Date.now();
    if (!firstPending) firstPending = now;
    clearTimeout(scanTimer);
    const wait = now - firstPending > 1000 ? 0 : 250; // 防抖，但流式输出期间最多每秒扫一次
    scanTimer = setTimeout(() => { firstPending = 0; scanNow(); }, wait);
  }

  function conversationKey() {
    return location.pathname.replace(/\/+$/, '') || '/';
  }

  function checkConversation() {
    const key = conversationKey();
    if (key === state.convKey) return false;
    log('对话切换', state.convKey, '→', key);
    const wasNewChat = state.convKey != null && !convIdOf(state.convKey) && !!convIdOf(key);
    state.convKey = key;
    state.convChangedAt = Date.now();
    state.olderExhausted = false;
    state.activeId = null;
    state.container = null;
    if (!wasNewChat) { state.items = []; state.byId = new Map(); }
    // 新对话发出第一个问题后 URL 从 / 变为 /c/xxx，此时保留已识别的问题即可
    setTimeout(scheduleScan, 600);
    setTimeout(scheduleScan, 2000);
    return true;
  }

  // ---------------------------------------------------------------- 事件
  let scrollRaf = 0, lastScrollScan = 0, scrollScanTimer = 0;
  function onScroll(e) {
    if (host && e && e.target === host) return; // 导航栏自身的滚动
    hideTip();
    // 滚动时节流扫描：虚拟列表/分段加载会在滚动过程中替换消息节点，及时收录
    const now = Date.now();
    if (now - lastScrollScan > 100) { lastScrollScan = now; scanNow(); }
    else { clearTimeout(scrollScanTimer); scrollScanTimer = setTimeout(() => { lastScrollScan = Date.now(); scanNow(); }, 110); }
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateActive(false); });
  }

  let ro = null, observedContainer = null;
  function observeContainer(c) {
    if (!('ResizeObserver' in window) || c === observedContainer) return;
    if (!ro) ro = new ResizeObserver(() => updateLayout());
    if (observedContainer) ro.unobserve(observedContainer);
    observedContainer = c;
    if (c !== document.documentElement && c !== document.scrollingElement) ro.observe(c);
  }

  function start() {
    ensureUI();
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target === host || (host && host.contains(m.target))) continue;
        scheduleScan();
        // body 子节点被整体替换时重新挂载 UI
        if (host && !host.isConnected) ensureUI();
        return;
      }
    }).observe(document.body, { childList: true, subtree: true });

    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode'] });
    try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme); } catch { /* ignore */ }

    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', () => { updateLayout(); hideTip(); }, { passive: true });
    window.addEventListener('popstate', () => setTimeout(scanNow, 50));
    setInterval(() => {
      if (conversationKey() !== state.convKey) scanNow();
      else if (rail) updateLayout();
    }, 500);

    scanNow();
    console.info(TAG, `v${VERSION} 已启动（本地运行，无网络请求）`);
  }

  // ---------------------------------------------------------------- 设置与诊断
  function diagnostics() {
    const c = state.container;
    let containerDesc = '未找到';
    if (c) {
      containerDesc = c === document.scrollingElement || c === document.documentElement
        ? 'document（页面整体滚动）'
        : `${c.tagName.toLowerCase()}${c.id ? '#' + c.id : ''}.${String(c.className || '').split(/\s+/).slice(0, 4).join('.')}`;
    }
    return {
      version: VERSION,
      enabled: state.enabled,
      site: SITE.name,
      pageType: convIdOf(location.pathname) ? '对话页' : (location.pathname === '/' || location.pathname === '/new' ? '新对话/首页' : '其他页面'),
      host: location.host,
      strategy: state.strategy || '无（所有识别规则都未命中）',
      domQuestions: state.domCount,
      cachedQuestions: state.items.length,
      connectedQuestions: state.items.filter((it) => it.el && it.el.isConnected).length,
      container: containerDesc,
      railVisible: !!(rail && rail.classList.contains('show')),
      hiddenReason: state.hiddenReason || '',
      theme: host ? host.getAttribute('data-theme') : '?',
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      scanCount: state.scanCount,
      lastScanAgoMs: state.lastScanAt ? Date.now() - state.lastScanAt : null,
      uiMounted: !!(host && host.isConnected),
      errors: state.errors.slice(-5),
      // 用于判断 DOM 结构变化，不包含任何聊天文字
      bridge: { ok: bridgeInfo.ok, reason: bridgeInfo.reason, totalRows: bridgeInfo.totalRows, hasOlder: bridgeInfo.hasOlder, hasGeometry: bridgeInfo.hasGeometry },
      mayHaveOlder: moreVisible(),
      headerOffset: Math.round(headerOffset()),
      domProbe: {
        main: !!document.querySelector('main'),
        userBubbles: getRoot().querySelectorAll('[data-user-message-bubble="true"]').length,
        threadScrollContainers: document.querySelectorAll('.thread-scroll-container').length,
        turnKeys: document.querySelectorAll(`[${SITE.turnAttr}]`).length,
        claudeTranscriptLists: document.querySelectorAll('[data-testid="transcript-list"]').length,
        claudeUserMessages: document.querySelectorAll('[data-testid="user-message"]').length,
        htmlMode: document.documentElement.getAttribute('data-mode'),
        virtualizedTurns: document.querySelectorAll('[data-virtualized-turn]').length,
        threadScroll: !!document.querySelector('.thread-scroll-container'),
        htmlTheme: document.documentElement.getAttribute('data-theme'),
        authorRoleUser: document.querySelectorAll('[data-message-author-role="user"]').length,
        authorRoleAssistant: document.querySelectorAll('[data-message-author-role="assistant"]').length,
        dataTurnUser: document.querySelectorAll('[data-turn="user"]').length,
        conversationTurn: document.querySelectorAll('[data-testid^="conversation-turn-"]').length,
        articles: document.querySelectorAll('main article').length,
        messageIds: document.querySelectorAll('[data-message-id]').length,
      },
    };
  }

  try {
    chrome.storage.local.get({ enabled: true, debug: false }, (cfg) => {
      state.enabled = cfg.enabled !== false;
      debug = !!cfg.debug;
      scanNow();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.enabled) { state.enabled = ch.enabled.newValue !== false; scanNow(); }
      if (ch.debug) debug = !!ch.debug.newValue;
    });
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('cgnav:')) return;
      if (msg.type === 'cgnav:status') { scanNow(); reply(diagnostics()); return; }
      if (msg.type === 'cgnav:rescan') {
        state.items = []; state.byId = new Map(); state.container = null; lastSignature = '';
        scanNow(); reply(diagnostics()); return;
      }
      if (msg.type === 'cgnav:preload') {
        preloadAll().then((r) => reply({ ...r, diag: diagnostics() }))
          .catch((e) => { recordError('preload', e); reply({ ok: false, msg: String(e) }); });
        return true; // 异步回复
      }
    });
  } catch (e) {
    recordError('chrome api', e);
  }

  // 供测试页面/控制台调试使用（只读）
  window.__cgnavDiag = diagnostics;

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
