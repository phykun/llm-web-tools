/*
 * 问题导航栏 - 页面桥接脚本（运行在页面主环境 MAIN world），支持 ChatGPT 与 Claude
 *
 * 新版 ChatGPT（2026-11 实测）：
 *   1. 对话列表是虚拟列表，只渲染视口附近的几个回合；
 *   2. 打开对话时只加载最近一批回合，滚动到顶部时页面自己再加载更早的回合。
 *
 * 本脚本只在内容脚本请求时，从页面内存中已有的数据里读取：
 *   - 已加载回合的 ID、用户问题文字（截断到 400 字）、在列表中的位置；
 *   - 是否可能还有更早的回合尚未加载（用于显示"加载更早"标记）。
 *
 * - 只读，不修改页面数据；唯一例外：在 Claude 上点击跳转时，调用页面自带的
 *   scrollToIndex 把对话滚动到指定行（Claude 自己的"对话内查找"也用这个函数）；
 * - 不发起任何网络请求，不读取 Cookie、令牌、localStorage；
 * - 读不到（ChatGPT 改版）时返回 ok:false，内容脚本自动退回纯 DOM 识别。
 */
(() => {
  'use strict';
  if (window.__cgnavBridgeLoaded) return;
  window.__cgnavBridgeLoaded = true;

  const MAX_TEXT = 400;

  function fiberOf(el) {
    const k = el && Object.keys(el).find((x) => x.startsWith('__reactFiber'));
    return k ? el[k] : null;
  }

  function* hooksOf(fiber) {
    let h = fiber && fiber.memoizedState;
    for (let j = 0; h && typeof h === 'object' && 'next' in h && j < 120; j++, h = h.next) yield h.memoizedState;
  }

  function collectChatGPT() {
    // ChatGPT 切换对话后会把上一个对话隐藏保留在页面中，必须选当前网址对应、且可见的那个列表
    const m = /\/c\/([\w-]+)/.exec(location.pathname);
    const urlConv = m ? m[1] : null;
    const vts = Array.from(document.querySelectorAll('[data-virtualized-turn]'));
    let vt = null;
    if (urlConv) {
      vt = vts.find((v) => {
        const t = v.closest('[data-chatgpt-conversation-selection-target]');
        return t && t.getAttribute('data-chatgpt-conversation-selection-target') === urlConv;
      }) || null;
    }
    if (!vt) vt = vts.find((v) => v.getBoundingClientRect().width > 0) || null;
    if (!vt) return { ok: false, reason: vts.length ? '当前对话的列表尚未出现' : '页面中没有虚拟列表' };
    const start = vt.parentElement || vt;
    let f = fiberOf(start);
    if (!f) return { ok: false, reason: '未找到 React 节点' };

    let props = null, listFiber = null;
    for (let d = 0; f && d < 80; d++, f = f.return) {
      const p = f.memoizedProps;
      if (p && Array.isArray(p.rows) && p.rows.length && p.rows[0] && typeof p.rows[0] === 'object' && 'turn' in p.rows[0]) {
        props = p; listFiber = f; break;
      }
    }
    if (!props) return { ok: false, reason: '未找到列表组件数据' };
    const rowsAll = props.rows;

    // 每行在列表中的位置（虚拟列表自己的测量结果）
    let tops = null;
    for (let g = listFiber, d = 0; g && d < 6 && !tops; d++, g = g.return) {
      for (const s of hooksOf(g)) {
        const c = s && typeof s === 'object' ? (s.current && typeof s.current === 'object' ? s.current : s) : null;
        if (c && Array.isArray(c.topOffsetsPx) && c.topOffsetsPx.length === rowsAll.length) { tops = c.topOffsetsPx; break; }
      }
    }

    // 是否可能还有更早的回合未加载：页面分页元数据中 cursor 非空表示打开对话时还有更早的一批。
    // 注意 numTurns 只是每批的数量，不是总数；加载更早一批后这里也不会更新，
    // 所以内容脚本会在"加载后没有新回合出现"时判定已到开头。
    const conv = typeof rowsAll[0].conversationId === 'string' ? rowsAll[0].conversationId : null;
    let hasOlder = null;
    for (let g = listFiber, d = 0; g && d < 160 && hasOlder == null; d++, g = g.return) {
      for (const s of hooksOf(g)) {
        const data = s && typeof s === 'object' ? s.data : null;
        if (data && data.pagination && typeof data.pagination === 'object' &&
            (!conv || data.conversation_id === conv)) { hasOlder = !!data.pagination.cursor; break; }
      }
    }

    const rows = [];
    rowsAll.forEach((r, i) => {
      if (!r || typeof r.id !== 'string') return;
      const text = userTextOfRow(r);
      if (text == null) return;
      rows.push({ id: r.id, text, top: tops && typeof tops[i] === 'number' ? tops[i] : null });
    });
    return { ok: true, conv, totalRows: rowsAll.length, hasOlder, hasGeometry: !!tops, rows };
  }

  function userTextOfRow(row) {
    const items = row && row.turn && Array.isArray(row.turn.items) ? row.turn.items : null;
    if (!items) return null;
    const u = items.find((it) => it && it.type === 'user-message');
    if (!u) return null;
    let text = typeof u.message === 'string' ? u.message
      : (typeof u.initialEditMessage === 'string' ? u.initialEditMessage : '');
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) {
      if (Array.isArray(u.images) && u.images.length) text = '[图片]';
      else if (Array.isArray(u.attachments) && u.attachments.length) text = '[附件]';
      else text = '[空消息]';
    }
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
  }


  // ---------------------------------------------------------------- Claude（claude.ai，2026-11-25 实测）
  // 对话列表组件的 props.rows 中有：messageUuids（已加载消息，按顺序）、messageChainData（每行数据，
  // lastMessage.sender 为 human / assistant，content[].text 为文字）、hasEarlier（是否还有更早的消息）。
  function claudeListFiber() {
    const lists = Array.from(document.querySelectorAll('[data-testid="transcript-list"]'));
    const list = lists.find((l) => l.getBoundingClientRect().width > 0) || lists[0];
    if (!list) return null;
    let f = fiberOf(list);
    for (let d = 0; f && d < 30; d++, f = f.return) {
      const p = f.memoizedProps;
      if (p && p.rows && Array.isArray(p.rows.messageUuids) && Array.isArray(p.rows.messageChainData)) return f;
    }
    return null;
  }

  function claudeText(m) {
    let text = Array.isArray(m.content)
      ? m.content.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join(' ')
      : (typeof m.text === 'string' ? m.text : '');
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) {
      const files = (Array.isArray(m.files_v2) && m.files_v2.length) || (Array.isArray(m.attachments) && m.attachments.length) || (Array.isArray(m.files) && m.files.length);
      text = files ? '[附件]' : '[空消息]';
    }
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
  }

  function collectClaude() {
    const lf = claudeListFiber();
    if (!lf) return { ok: false, reason: document.querySelector('[data-testid="transcript-list"]') ? '未找到对话列表数据' : '页面中没有对话列表' };
    const props = lf.memoizedProps;
    const r = props.rows;
    const rows = [];
    r.messageChainData.forEach((c, i) => {
      if (!c) return;
      const m = c.displayMessage || c.lastMessage || (c.chain && Array.isArray(c.chain.messages) ? c.chain.messages[0] : null);
      if (!m || m.sender !== 'human') return;
      const id = (c.chain && typeof c.chain.rowKey === 'string') ? c.chain.rowKey : m.uuid;
      if (typeof id !== 'string') return;
      rows.push({ id, index: i, text: claudeText(m), top: null });
    });
    return {
      ok: true, site: 'claude',
      conv: typeof props.conversationUuid === 'string' ? props.conversationUuid : null,
      totalRows: r.messageUuids.length, hasOlder: !!r.hasEarlier, hasGeometry: false, rows,
    };
  }

  // 页面自带的"滚动到第 N 行"函数（Claude 的对话内查找功能也用它）
  function claudeJumpApi() {
    const lf = claudeListFiber();
    if (!lf) return null;
    let api = null, n = 0;
    (function walk(f) {
      if (!f || api || n++ > 30000) return;
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.scrollToIndex === 'function' && Array.isArray(p.items)) { api = p; return; }
      walk(f.child); walk(f.sibling);
    })(lf.child);
    return api;
  }

  const IS_CLAUDE = /(^|\.)claude\.ai$/.test(location.hostname);
  function collect() { return IS_CLAUDE ? collectClaude() : collectChatGPT(); }

  // 唯一的"写"操作：在 Claude 上调用页面自带的 scrollToIndex 滚动到指定行（只滚动，不改数据）
  document.addEventListener('cgnav:cmd', (e) => {
    let out = { ok: false, reason: '不支持' };
    try {
      const cmd = typeof e.detail === 'string' ? JSON.parse(e.detail) : null;
      if (IS_CLAUDE && cmd && cmd.op === 'scrollToIndex' && Number.isInteger(cmd.index)) {
        const api = claudeJumpApi();
        const item = api && api.items[cmd.index];
        const key = item && item.chain && item.chain.rowKey;
        if (!api) out = { ok: false, reason: '未找到页面的跳转函数' };
        else if (cmd.id && key !== cmd.id) out = { ok: false, reason: '行号与消息不一致' };
        else { api.scrollToIndex(cmd.index, { align: 'start' }); out = { ok: true }; }
      }
    } catch (err) { out = { ok: false, reason: String(err && err.message ? err.message : err) }; }
    document.dispatchEvent(new CustomEvent('cgnav:cmdres', { detail: JSON.stringify(out) }));
  });

  document.addEventListener('cgnav:req', () => {
    let out;
    try { out = collect(); } catch (e) { out = { ok: false, reason: String(e && e.message ? e.message : e) }; }
    // 跨 world 只传字符串
    document.dispatchEvent(new CustomEvent('cgnav:rows', { detail: JSON.stringify(out) }));
  });
})();
