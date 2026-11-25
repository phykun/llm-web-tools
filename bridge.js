/*
 * ChatGPT 问题导航栏 - 页面桥接脚本（运行在页面主环境 MAIN world）
 *
 * 新版 ChatGPT（2026-11 实测）：
 *   1. 对话列表是虚拟列表，只渲染视口附近的几个回合；
 *   2. 打开对话时只加载最近一批回合，滚动到顶部时页面自己再加载更早的回合。
 *
 * 本脚本只在内容脚本请求时，从页面内存中已有的数据里读取：
 *   - 已加载回合的 ID、用户问题文字（截断到 400 字）、在列表中的位置；
 *   - 是否可能还有更早的回合尚未加载（用于显示"加载更早"标记）。
 *
 * - 只读，不修改页面数据，不调用页面函数；
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

  function collect() {
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

  document.addEventListener('cgnav:req', () => {
    let out;
    try { out = collect(); } catch (e) { out = { ok: false, reason: String(e && e.message ? e.message : e) }; }
    // 跨 world 只传字符串
    document.dispatchEvent(new CustomEvent('cgnav:rows', { detail: JSON.stringify(out) }));
  });
})();
