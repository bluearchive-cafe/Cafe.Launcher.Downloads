/**
 * Self-contained administrator console served at `/v1/admin`. It is a static shell:
 * the page itself holds no credentials, and every data request carries the
 * operator-supplied ADMIN_TOKEN from sessionStorage.
 *
 * Kept as one string with inline CSS/JS so the Worker stays the only deploy
 * target: no build step, no cross-origin call, no separate static host.
 */
export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>Cafe Launcher 下载镜像 · 管理面板</title>
<style>
  :root {
    --bg: #0d1017;
    --panel: #151a23;
    --panel-2: #1b2130;
    --line: #252c3b;
    --text: #e7ebf3;
    --muted: #8b95a9;
    --accent: #4d8dff;
    --ok: #3fb950;
    --warn: #d29922;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: radial-gradient(1200px 500px at 50% -200px, #1b2740 0%, var(--bg) 60%);
    color: var(--text);
    font: 14px/1.6 "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  header {
    display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between;
    max-width: 1180px; margin: 0 auto; padding: 32px 24px 16px;
  }
  h1 { margin: 0; font-size: 22px; letter-spacing: .2px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .subtitle { margin: 4px 0 0; font-size: 13px; }
  .auth { display: flex; gap: 8px; align-items: center; }
  input[type=password] {
    width: 260px; max-width: 46vw; padding: 9px 12px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit;
  }
  input[type=password]:focus {
    outline: 2px solid rgba(77,141,255,.45); outline-offset: 1px; border-color: var(--accent);
  }
  button {
    padding: 9px 14px; border-radius: 8px; border: 1px solid transparent;
    background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.ghost { background: transparent; color: var(--text); border-color: var(--line); }
  main { max-width: 1180px; margin: 0 auto; padding: 8px 24px 48px; display: grid; gap: 20px; }
  .message {
    margin: 0; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--panel); font-size: 13px;
  }
  .message.ok { border-color: rgba(63,185,80,.4); color: #7ee787; }
  .message.warn { border-color: rgba(210,153,34,.4); color: #e3b341; }
  .message.err { border-color: rgba(248,81,73,.4); color: #ff7b72; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
  .section-head {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    justify-content: space-between; margin-bottom: 16px;
  }
  .actions { display: flex; gap: 8px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
  .grid { display: grid; gap: 12px; margin-bottom: 16px; }
  .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .metric { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
  .metric .label { color: var(--muted); font-size: 12px; }
  .metric .value { font-size: 20px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
  .lists { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .list-box { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .list-box h3 { margin: 0 0 8px; font-size: 12px; color: var(--muted); font-weight: 600; letter-spacing: .4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #232b3d; border: 1px solid var(--line); }
  .chip.ok { border-color: rgba(63,185,80,.35); color: #7ee787; }
  .chip.warn { border-color: rgba(210,153,34,.35); color: #e3b341; }
  .empty { color: var(--muted); font-size: 12px; }
  .err-line { margin: 0 0 6px; font-size: 12px; color: #ff7b72; overflow-wrap: anywhere; }
  .err-line:last-child { margin-bottom: 0; }
  .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 10px; }
  .table-wrap.limited { max-height: 420px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; white-space: nowrap; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  th { position: sticky; top: 0; background: var(--panel-2); color: var(--muted); font-weight: 600; z-index: 1; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: rgba(255,255,255,.02); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .status-ok { color: #7ee787; }
  .status-bad { color: #ff7b72; }
  footer { max-width: 1180px; margin: 0 auto; padding: 0 24px 32px; color: var(--muted); font-size: 12px; }
  @media (max-width: 820px) {
    .grid.three, .lists { grid-template-columns: 1fr; }
    header { align-items: stretch; }
    .auth { width: 100%; }
    input[type=password] { flex: 1; width: auto; max-width: none; }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>Cafe Launcher 下载镜像</h1>
    <p class="subtitle muted">同步状态与下载统计 · 管理面板</p>
  </div>
  <div class="auth">
    <input id="token" type="password" placeholder="输入 ADMIN_TOKEN" autocomplete="off" spellcheck="false" aria-label="管理员令牌">
    <button id="connect" type="button">连接</button>
    <button id="forget" class="ghost" type="button" hidden>断开</button>
  </div>
</header>
<main>
  <p id="message" class="message" hidden></p>

  <section class="card" aria-labelledby="sync-title">
    <div class="section-head">
      <h2 id="sync-title">同步状态</h2>
      <div class="actions">
        <button id="refresh" class="ghost" type="button">刷新</button>
        <button id="sync" type="button">立即同步</button>
      </div>
    </div>
    <div id="sync-meta" class="meta">尚未连接。</div>
    <div class="grid three" id="sync-cards"></div>
    <div class="lists" id="sync-lists"></div>
  </section>

  <section class="card" aria-labelledby="stats-title">
    <div class="section-head">
      <h2 id="stats-title">下载统计 · 近 30 个 UTC 日</h2>
    </div>
    <div class="grid three" id="stats-cards"></div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>日期</th><th>路由</th><th>版本</th><th>文件</th><th>方法</th><th>来源</th><th>状态</th>
            <th class="num">请求</th><th class="num">声明字节</th><th class="num">处理毫秒</th>
          </tr>
        </thead>
        <tbody id="stats-rows"></tbody>
      </table>
    </div>
    <p id="stats-note" class="small muted"></p>
  </section>

  <section class="card" aria-labelledby="files-title">
    <div class="section-head">
      <h2 id="files-title">文件下载量 · 近 30 个 UTC 日</h2>
    </div>
    <div class="table-wrap limited">
      <table>
        <thead>
          <tr><th>版本</th><th>文件</th><th class="num">完成下载</th><th class="num">声明字节</th></tr>
        </thead>
        <tbody id="file-rows"></tbody>
      </table>
    </div>
    <p id="files-note" class="small muted"></p>
  </section>

  <footer>令牌只保存在当前标签页的 sessionStorage，关闭标签页即失效。统计为声明字节，不代表实际完成下载。</footer>
</main>
<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'cafe-mirror-admin-token';
  var token = sessionStorage.getItem(TOKEN_KEY) || '';

  function byId(id) { return document.getElementById(id); }
  var input = byId('token');
  var connectButton = byId('connect');
  var forgetButton = byId('forget');
  var messageBox = byId('message');
  var syncMeta = byId('sync-meta');
  var syncCards = byId('sync-cards');
  var syncLists = byId('sync-lists');
  var statsCards = byId('stats-cards');
  var statsRows = byId('stats-rows');
  var statsNote = byId('stats-note');
  var fileRows = byId('file-rows');
  var filesNote = byId('files-note');

  function showMessage(text, kind) {
    messageBox.textContent = text || '';
    messageBox.className = 'message' + (kind ? ' ' + kind : '');
    messageBox.hidden = !text;
  }
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function formatBytes(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n.toFixed(1)) + ' ' + units[i];
  }
  function formatNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
  }
  function formatTime(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
  }
  function api(path, init) {
    var options = init ? Object.assign({}, init) : {};
    var headers = Object.assign({}, options.headers || {});
    headers.Authorization = 'Bearer ' + token;
    options.headers = headers;
    return fetch(path, options).then(function (response) {
      return response.text().then(function (body) {
        var data = null;
        try { data = body ? JSON.parse(body) : null; } catch (error) { data = null; }
        if (response.status === 401) {
          var denied = new Error('令牌无效，或 Worker 尚未配置 ADMIN_TOKEN。');
          denied.unauthorized = true;
          throw denied;
        }
        if (!response.ok) {
          var detail = data && data.message ? data.message : body.slice(0, 200);
          throw new Error('HTTP ' + response.status + (detail ? '：' + detail : ''));
        }
        return data;
      });
    });
  }
  function metric(label, value) {
    var box = element('div', 'metric');
    box.appendChild(element('div', 'label', label));
    box.appendChild(element('div', 'value', value));
    return box;
  }
  function chipList(title, items, kind) {
    var box = element('div', 'list-box');
    box.appendChild(element('h3', null, title + '（' + items.length + '）'));
    if (!items.length) { box.appendChild(element('p', 'empty', '无')); return box; }
    var chips = element('div', 'chips');
    items.forEach(function (item) { chips.appendChild(element('span', 'chip ' + kind, item)); });
    box.appendChild(chips);
    return box;
  }
  function errorList(errors) {
    var box = element('div', 'list-box');
    box.appendChild(element('h3', null, '错误（' + errors.length + '）'));
    if (!errors.length) { box.appendChild(element('p', 'empty', '无')); return box; }
    errors.forEach(function (item) {
      var text = item && typeof item === 'object' ? (item.message || JSON.stringify(item)) : String(item);
      box.appendChild(element('p', 'err-line', text));
    });
    return box;
  }
  function renderStatus(data) {
    var status = data && data.startedAt ? data : null;
    clear(syncCards);
    clear(syncLists);
    if (!status) {
      syncMeta.textContent = '尚未运行过同步。';
      syncCards.appendChild(metric('状态', '未开始'));
      return;
    }
    var errors = Array.isArray(status.errors) ? status.errors : [];
    var ready = Array.isArray(status.ready) ? status.ready : [];
    var pending = Array.isArray(status.pending) ? status.pending : [];
    syncMeta.textContent = '开始 ' + formatTime(status.startedAt) + ' · 结束 ' +
      (status.finishedAt ? formatTime(status.finishedAt) : '进行中') + ' · 已就绪 ' + ready.length + ' 个版本';
    syncCards.appendChild(metric('本轮上传', formatNumber(status.uploaded) + ' 个文件'));
    syncCards.appendChild(metric('上传体积', formatBytes(status.uploadedBytes)));
    syncCards.appendChild(metric('元数据来源', status.metadataSource || '—'));
    syncLists.appendChild(chipList('已就绪', ready, 'ok'));
    syncLists.appendChild(chipList('待上传', pending, 'warn'));
    syncLists.appendChild(errorList(errors));
  }
  function renderStats(data) {
    var summary = (data && data.summary) || {};
    var rows = data && Array.isArray(data.rows) ? data.rows : [];
    clear(statsCards);
    clear(statsRows);
    statsCards.appendChild(metric('请求总数', formatNumber(summary.requests)));
    statsCards.appendChild(metric('失败 / 拒绝请求', formatNumber(summary.rejectedOrFailedRequests)));
    statsCards.appendChild(metric('声明响应字节', formatBytes(summary.declaredResponseBytes)));
    if (!rows.length) {
      var emptyRow = element('tr');
      var emptyCell = element('td', 'empty', '统计窗口内没有记录。');
      emptyCell.colSpan = 10;
      emptyRow.appendChild(emptyCell);
      statsRows.appendChild(emptyRow);
    } else {
      rows.forEach(function (row) {
        var tr = element('tr');
        [row.day, row.route, row.tag || '—', row.file || '—', row.method, row.source || '—'].forEach(function (value) {
          tr.appendChild(element('td', null, value === null || value === undefined || value === '' ? '—' : value));
        });
        tr.appendChild(element('td', Number(row.status) >= 400 ? 'status-bad' : 'status-ok', row.status));
        tr.appendChild(element('td', 'num', formatNumber(row.requests)));
        tr.appendChild(element('td', 'num', formatBytes(row.declaredResponseBytes)));
        tr.appendChild(element('td', 'num', formatNumber(row.handlerMs)));
        statsRows.appendChild(tr);
      });
    }
    var note = data && data.byteMetric ? data.byteMetric : '声明响应字节，不代表实际完成下载。';
    statsNote.textContent = '显示 ' + rows.length + ' 条' +
      (data && data.rowLimit ? '（上限 ' + data.rowLimit + '）' : '') + '；' + note;

    var fileDownloads = data && data.fileDownloads ? data.fileDownloads : null;
    var files = fileDownloads && Array.isArray(fileDownloads.files) ? fileDownloads.files : [];
    clear(fileRows);
    if (!files.length) {
      var noFiles = element('tr');
      var noFilesCell = element('td', 'empty', '统计窗口内没有完成的文件下载。');
      noFilesCell.colSpan = 4;
      noFiles.appendChild(noFilesCell);
      fileRows.appendChild(noFiles);
    } else {
      files.forEach(function (item) {
        var tr = element('tr');
        tr.appendChild(element('td', null, item.tag || '—'));
        tr.appendChild(element('td', null, item.file || '—'));
        tr.appendChild(element('td', 'num', formatNumber(item.downloads)));
        tr.appendChild(element('td', 'num', formatBytes(item.declaredResponseBytes)));
        fileRows.appendChild(tr);
      });
    }
    var downloadNote = data && data.downloadMetric ? data.downloadMetric : '仅统计完整 GET 200。';
    filesNote.textContent = '显示 ' + files.length + ' 个文件' +
      (fileDownloads && fileDownloads.limit ? '（上限 ' + fileDownloads.limit + '）' : '') + '；' + downloadNote;
  }
  function handleError(error) {
    if (error && error.unauthorized) {
      token = '';
      sessionStorage.removeItem(TOKEN_KEY);
      setConnected(false);
      showMessage(error.message, 'err');
      return;
    }
    showMessage('请求失败：' + (error && error.message ? error.message : '未知错误'), 'err');
  }
  function loadStatus() { return api('/v1/admin/status').then(renderStatus); }
  function loadStats() { return api('/v1/admin/stats').then(renderStats); }
  function refreshAll() {
    if (!token) { showMessage('输入 ADMIN_TOKEN 后连接。', 'warn'); return Promise.resolve(); }
    return Promise.all([loadStatus(), loadStats()]).then(function () {
      showMessage('', '');
    }).catch(handleError);
  }
  function runSync() {
    if (!token) { showMessage('先连接管理接口。', 'warn'); return; }
    var button = byId('sync');
    button.disabled = true;
    showMessage('正在执行一轮同步，最多等待数分钟…', '');
    api('/v1/admin/sync', { method: 'POST' }).then(function (result) {
      var errors = result && Array.isArray(result.errors) ? result.errors.length : 0;
      var pending = result && Array.isArray(result.pending) ? result.pending.length : 0;
      showMessage('同步完成：上传 ' + formatNumber(result && result.uploaded) + ' 个文件，待处理 ' +
        pending + ' 个，错误 ' + errors + ' 个。', errors ? 'warn' : 'ok');
      return refreshAll();
    }).catch(handleError).finally(function () { button.disabled = false; });
  }
  function setConnected(connected) {
    forgetButton.hidden = !connected;
    connectButton.textContent = connected ? '重新连接' : '连接';
    if (!connected) {
      clear(syncCards); clear(syncLists); clear(statsCards); clear(statsRows);
      syncMeta.textContent = '尚未连接。';
      statsNote.textContent = '';
      clear(fileRows); filesNote.textContent = '';
    }
  }
  function connect() {
    var value = input.value.trim();
    if (!value) { showMessage('请填入 ADMIN_TOKEN。', 'warn'); return; }
    token = value;
    input.value = '';
    sessionStorage.setItem(TOKEN_KEY, token);
    setConnected(true);
    refreshAll();
  }
  connectButton.addEventListener('click', connect);
  input.addEventListener('keydown', function (event) { if (event.key === 'Enter') connect(); });
  forgetButton.addEventListener('click', function () {
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    setConnected(false);
    showMessage('已断开，令牌已从本标签页清除。', '');
  });
  byId('refresh').addEventListener('click', function () { refreshAll(); });
  byId('sync').addEventListener('click', runSync);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && token) refreshAll();
  });
  if (token) { setConnected(true); refreshAll(); }
  setInterval(function () { if (!document.hidden && token) refreshAll(); }, 60000);
})();
</script>
</body>
</html>`;
