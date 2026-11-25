'use strict';
const $ = (id) => document.getElementById(id);
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;

let lastDiag = null;
let tabId = null;

function setBadge(text, cls) {
  const b = $('badge');
  b.textContent = text;
  b.className = 'badge ' + (cls || '');
}

function renderInfo(d) {
  const rows = [
    ['网站', d.site || '—'],
    ['页面', d.pageType],
    ['识别规则', d.strategy],
    ['完整列表读取', d.bridge ? (d.bridge.ok ? `可用（已加载 ${d.bridge.totalRows} 个回合）` : `不可用：${d.bridge.reason || '未知'}（已退回页面识别）`) : '—'],
    ['导航中的问题', `${d.cachedQuestions}（页面已渲染 ${d.domQuestions}）${d.mayHaveOlder ? '，可能还有更早的消息未加载' : ''}`],
    ['滚动区域', d.container],
    ['导航栏', d.railVisible ? '显示中' : `未显示${d.hiddenReason ? '：' + d.hiddenReason : ''}`],
    ['主题', d.theme === 'dark' ? '深色' : '浅色'],
  ];
  if (d.errors && d.errors.length) rows.push(['最近错误', d.errors[d.errors.length - 1].msg]);
  const dl = $('info');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  }
}

function judge(d) {
  if (!d.enabled) return setBadge('已关闭', 'warn');
  if (d.errors && d.errors.length) return setBadge('运行中，但出现过错误', 'warn');
  if (d.railVisible) return setBadge('正常运行', 'ok');
  if (d.pageType === '对话页' && d.domQuestions === 0) return setBadge('未识别到消息（网站页面结构可能已变化）', 'bad');
  return setBadge('运行中（当前无需显示）', 'ok');
}

function send(type) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve({ error: 'no-tab' });
    chrome.tabs.sendMessage(tabId, { type }, (resp) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

function show(resp) {
  if (!resp || resp.error) {
    setBadge('当前标签页不是 ChatGPT / Claude，或页面需要刷新', 'bad');
    $('info').replaceChildren();
    ['rescan', 'preload'].forEach((id) => ($(id).disabled = true));
    lastDiag = { error: resp ? resp.error : 'no response', version: chrome.runtime.getManifest().version };
    return;
  }
  lastDiag = resp;
  renderInfo(resp);
  judge(resp);
}

async function refresh() { show(await send('cgnav:status')); }

chrome.storage.local.get({ enabled: true, debug: false }, (cfg) => {
  $('enabled').checked = cfg.enabled !== false;
  $('debug').checked = !!cfg.debug;
});
$('enabled').addEventListener('change', (e) => {
  chrome.storage.local.set({ enabled: e.target.checked }, () => setTimeout(refresh, 150));
});
$('debug').addEventListener('change', (e) => chrome.storage.local.set({ debug: e.target.checked }));

$('rescan').addEventListener('click', async () => show(await send('cgnav:rescan')));
$('preload').addEventListener('click', async () => {
  const btn = $('preload');
  btn.disabled = true; btn.textContent = '加载中…';
  const r = await send('cgnav:preload');
  btn.disabled = false; btn.textContent = '加载完整历史';
  if (r && r.diag) show(r.diag); else show(r);
  if (r && r.ok === false && r.msg) setBadge(r.msg, 'warn');
});
$('copy').addEventListener('click', async () => {
  const text = JSON.stringify({ ...lastDiag, browser: navigator.userAgent, time: new Date().toISOString() }, null, 2);
  try { await navigator.clipboard.writeText(text); $('copy').textContent = '已复制'; }
  catch { $('copy').textContent = '复制失败'; }
  setTimeout(() => ($('copy').textContent = '复制诊断信息'), 1500);
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  tabId = tabs && tabs[0] ? tabs[0].id : null;
  refresh();
});
