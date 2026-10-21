(function () {
  'use strict';
  const EXT = 'worldbook-manager';

  // ---------- 1. 工具函数（最先声明，避免 TDZ） ----------
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  function safeFileName(name) {
    return String(name || 'worldbook').replace(/[\\/:*?"<>|]/g, '_').replace(/\.json$/i, '').trim() || 'worldbook';
  }

  function fetchT(url, opt, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 20000);
    return fetch(url, Object.assign({}, opt, { signal: ctrl.signal }))
      .catch(e => { throw new Error(e && e.name === 'AbortError' ? '请求超时' : (e && e.message) || '网络错误'); })
      .finally(() => clearTimeout(t));
  }

  async function getHeaders() {
    try {
      const c = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
      if (c && typeof c.getRequestHeaders === 'function') return c.getRequestHeaders();
    } catch (e) { /* ignore */ }
    try {
      const mod = await import('/script.js');
      if (mod && typeof mod.getRequestHeaders === 'function') return mod.getRequestHeaders();
    } catch (e) { /* ignore */ }
    return { 'Content-Type': 'application/json' };
  }

  // ---------- 2. 状态变量 ----------
  const logs = [];
  let root = null;
  let statusTimer = null;
  let dlgAnchor = null;

  let worldNames = [];           // 所有世界书名称: string[]
  let globalActive = new Set();  // 当前在全局开启的世界书名称
  let bookCache = {};            // { [name]: { entries: {...}, raw: {...} } }
  let bookCounts = {};           // { [name]: number }
  let expandedBooks = new Set(); // 当前展开目录的世界书
  let loadingBooks = new Set();  // 正在加载条目的世界书

  let batchMode = false;         // 是否处于批量管理模式
  let batchSelected = new Set(); // 批量模式下勾选的世界书
  let searchQuery = '';          // 搜索过滤词
  let wiModule = null;           // 缓存 /scripts/world-info.js 模块

  function log(msg) {
    const line = new Date().toLocaleTimeString() + ' ' + msg;
    logs.push(line);
    while (logs.length > 60) logs.shift();
    const el = root && root.querySelector('#wm-log');
    if (el) el.textContent = logs.join('\n');
  }

  function status(text, bad) {
    const dm = document.querySelector('#wm-modal .wm-dialog-msg');
    if (dm) { dm.textContent = text; dm.classList.toggle('bad', !!bad); }
    const el = root && root.querySelector('#wm-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { el.textContent = ''; }, 4500);
  }

  // ---------- 3. 酒馆世界书接口层 ----------
  async function ensureWiModule() {
    if (wiModule) return wiModule;
    try {
      wiModule = await import('/scripts/world-info.js');
    } catch (e) {
      log('提示：未能直接 import world-info.js (' + e.message + ')，将使用 DOM 与后端 API');
    }
    return wiModule;
  }

  // 读取全局已开启的世界书
  function readGlobalActiveFromDOMOrMod() {
    const set = new Set();
    if (wiModule && Array.isArray(wiModule.selected_world_info)) {
      wiModule.selected_world_info.forEach(n => set.add(String(n)));
      return set;
    }
    const sel = document.querySelector('#world_info');
    if (sel && sel.options) {
      Array.from(sel.options).forEach(opt => {
        if (opt.selected) {
          const txt = (opt.textContent || opt.innerText || opt.value || '').trim();
          if (txt) set.add(txt);
        }
      });
    }
    return set;
  }

  // 将全局世界书开关同步回酒馆
  async function applyGlobalActive(newSet) {
    globalActive = new Set(newSet);
    await ensureWiModule();
    let synced = false;

    // 1. 尝试同步 DOM #world_info 选择器并触发 change
    const sel = document.querySelector('#world_info');
    if (sel && sel.options) {
      Array.from(sel.options).forEach(opt => {
        const txt = (opt.textContent || opt.innerText || '').trim();
        const val = String(opt.value || '').trim();
        const shouldSelect = globalActive.has(txt) || globalActive.has(val);
        opt.selected = shouldSelect;
      });
      const $= window.jQuery \vert{}\vert{} window.$;
      if ($ && $(sel).trigger) {$(sel).trigger('change');
      } else {
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      synced = true;
    }

    // 2. 尝试同步 world-info.js 导出的 selected_world_info 数组
    if (wiModule && Array.isArray(wiModule.selected_world_info)) {
      wiModule.selected_world_info.length = 0;
      globalActive.forEach(n => wiModule.selected_world_info.push(n));
      synced = true;
    }

    // 3. 触发保存设置
    try {
      const c = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
      if (c && typeof c.saveSettingsDebounced === 'function') {
        c.saveSettingsDebounced();
        synced = true;
      } else {
        const sMod = await import('/script.js');
        if (sMod && typeof sMod.saveSettingsDebounced === 'function') {
          sMod.saveSettingsDebounced();
          synced = true;
        }
      }
    } catch (e) { /* ignore */ }

    log('全局世界书已更新（当前开启 ' + globalActive.size + ' 本）' + (synced ? '' : ' [警告:未找到同步目标]'));
  }

  // 获取所有世界书名称列表
  async function fetchWorldList() {
    await ensureWiModule();
    let names = [];

    // 方式 A: world-info.js 里的 world_names
    if (wiModule && Array.isArray(wiModule.world_names)) {
      names = wiModule.world_names.slice();
    }

    // 方式 B: 页面上的下拉列表 #world_info 或 #world_editor_select
    if (!names.length) {
      const sel = document.querySelector('#world_info') || document.querySelector('#world_editor_select');
      if (sel && sel.options) {
        names = Array.from(sel.options)
          .map(o => (o.textContent || o.innerText || '').trim())
          .filter(Boolean)
          .filter(t => !/^[-—\s]*select/i.test(t) && !/请选择|无/.test(t));
      }
    }

    // 方式 C: 请求 /api/settings/get
    if (!names.length) {
      try {
        const headers = await getHeaders();
        const res = await fetchT('/api/settings/get', {
          method: 'POST',
          headers,
          body: JSON.stringify({})
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.world_names)) names = data.world_names.slice();
        }
      } catch (e) {
        log('通过 API 获取世界书列表失败：' + e.message);
      }
    }

    worldNames = Array.from(new Set(names.map(String).filter(Boolean)));
    globalActive = readGlobalActiveFromDOMOrMod();
    log('已加载世界书列表：共 ' + worldNames.length + ' 本，全局开启 ' + globalActive.size + ' 本');
  }

  // 读取单本世界书的数据
  async function fetchBookData(name, force) {
    if (!force && bookCache[name]) return bookCache[name];
    const headers = await getHeaders();
    const res = await fetchT('/api/worldinfo/get', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error('读取世界书失败 (HTTP ' + res.status + ')');
    const data = await res.json();
    if (!data || typeof data !== 'object') throw new Error('返回格式异常');
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};
    bookCache[name] = data;
    bookCounts[name] = Object.keys(data.entries).length;
    return data;
  }

  // 保存单本世界书的数据
  async function saveBookData(name, data) {
    const headers = await getHeaders();
    const res = await fetchT('/api/worldinfo/edit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, data })
    });
    if (!res.ok) throw new Error('保存失败 (HTTP ' + res.status + ')');
    bookCache[name] = data;
    bookCounts[name] = data && data.entries ? Object.keys(data.entries).length : 0;
  }

  // 删除单本世界书
  async function deleteBookApi(name) {
    const headers = await getHeaders();
    const res = await fetchT('/api/worldinfo/delete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error('删除失败 (HTTP ' + res.status + ')');
    delete bookCache[name];
    delete bookCounts[name];
    expandedBooks.delete(name);
    batchSelected.delete(name);
    if (globalActive.has(name)) {
      globalActive.delete(name);
      await applyGlobalActive(globalActive);
    }
    worldNames = worldNames.filter(n => n !== name);
  }

  // 刷新酒馆原生世界书 UI（如果存在）
  async function refreshTavernWorldUI() {
    await ensureWiModule();
    try {
      if (wiModule && typeof wiModule.updateWorldInfoList === 'function') {
        await wiModule.updateWorldInfoList();
      }
    } catch (e) {
      log('刷新酒馆原生世界书下拉列表失败：' + e.message);
    }
  }

  // ---------- 4. 内嵌对话框（绝不弹窗） ----------
  function showDialog(title, html, done, label) {
    if (!root) return;
    root.querySelectorAll('#wm-modal').forEach(n => n.remove());
    const m = document.createElement('div');
    m.id = 'wm-modal';
    m.className = 'wm-modal-bg';
    m.innerHTML =
      `<section class="wm-modal"><header>${esc(title)}<button type="button" class="wm-x">×</button></header>` +
      `<div class="wm-modal-content">${html}</div><div class="wm-dialog-msg"></div>` +
      `<footer><button type="button" class="wm-btn wm-light wm-cancel">取消</button>` +
      `<button type="button" class="wm-btn wm-primary wm-ok">${esc(label || '确定')}</button></footer></section>`;

    const anchorBox = dlgAnchor && dlgAnchor.closest ? dlgAnchor.closest('.wm-book, .wm-summary-bar, .wm-top') : null;
    const scrollBox = root.querySelector('.wm-scroll-box');
    dlgAnchor = null;
    if (anchorBox) anchorBox.insertAdjacentElement('afterend', m);
    else if (scrollBox) scrollBox.insertAdjacentElement('beforebegin', m);
    else root.appendChild(m);

    const close = () => m.remove();
    m.querySelector('.wm-x').onclick = close;
    m.querySelector('.wm-cancel').onclick = close;
    const ok = m.querySelector('.wm-ok');
    ok.onclick = () => {
      let r;
      try { r = done(m); } catch (e) { status('出错：' + e.message, true); return; }
      if (r && typeof r.then === 'function') {
        ok.disabled = true;
        r.then(v => { if (v !== false) close(); else ok.disabled = false; })
          .catch(e => { ok.disabled = false; status('出错：' + e.message, true); });
      } else if (r !== false) close();
    };
    try { m.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
  }

  // ---------- 5. 条目辅助计算 ----------
  function getEntriesList(bookData) {
    if (!bookData || !bookData.entries || typeof bookData.entries !== 'object') return [];
    return Object.entries(bookData.entries).map(([k, v]) => {
      const e = v && typeof v === 'object' ? v : {};
      const uid = e.uid !== undefined ? e.uid : k;
      const comment = (e.comment || '').trim();
      const keys = Array.isArray(e.key) ? e.key.join(', ') : String(e.key || '');
      const title = comment || keys || ('条目 #' + uid);
      const preview = String(e.content || keys || '').replace(/\s+/g, ' ').trim();
      const enabled = !e.disable;
      return { key: k, uid, title, preview, enabled, raw: e };
    });
  }

  // ---------- 6. 渲染 ----------
  function render() {
    if (!root) return;
    const q = searchQuery.trim().toLowerCase();
    const filteredNames = q
      ? worldNames.filter(n => n.toLowerCase().includes(q))
      : worldNames.slice();

    const activeCount = globalActive.size;
    const batchCount = batchSelected.size;

    const booksHtml = filteredNames.map(name => {
      const isOpen = expandedBooks.has(name);
      const isLoading = loadingBooks.has(name);
      const isChecked = batchMode ? batchSelected.has(name) : globalActive.has(name);
      const count = bookCounts[name];
      const countStr = typeof count === 'number' ? `(${count})` : '';

      let entriesHtml = '';
      if (isOpen) {
        if (isLoading) {
          entriesHtml = `<div class="wm-entries"><div class="wm-sub-empty">正在读取目录…</div></div>`;
        } else {
          const bData = bookCache[name];
          const entries = getEntriesList(bData);
          if (!entries.length) {
            entriesHtml = `<div class="wm-entries"><div class="wm-sub-empty">该世界书暂无条目</div></div>`;
          } else {
            const enabledNum = entries.filter(e => e.enabled).length;
            entriesHtml =
              `<div class="wm-entries">` +
              `<div class="wm-entry-bar"><span>已开启 ${enabledNum}/${entries.length} 条</span>` +
              `<div class="wm-entry-bar-btns">` +
              `<button type="button" class="wm-link-btn" data-a="entry-all-on" data-book="${esc(name)}">全开</button>` +
              `<button type="button" class="wm-link-btn" data-a="entry-all-off" data-book="${esc(name)}">全关</button>` +
              `</div></div>` +
              entries.map(item =>
                `<label class="wm-entry-row">` +
                `<input type="checkbox" class="wm-check" data-a="toggle-entry" data-book="${esc(name)}" data-ekey="${esc(item.key)}" ${item.enabled ? 'checked' : ''}>` +
                `<span class="wm-entry-name">${esc(item.title)}</span>` +
                `<span class="wm-entry-preview">${esc(item.preview)}</span>` +
                `</label>`
              ).join('') +
              `</div>`;
          }
        }
      }

      return (
        `<div class="wm-book ${isOpen ? 'open' : ''}">` +
        `<div class="wm-book-row" data-a="toggle-expand" data-book="${esc(name)}">` +
        `<input type="checkbox" class="wm-check" data-a="toggle-book" data-book="${esc(name)}" ${isChecked ? 'checked' : ''} title="${batchMode ? '勾选批量操作' : '是否在全局开启'}">` +
        `<span class="wm-book-title">${esc(name)}<span class="wm-book-count">${esc(countStr)}</span></span>` +
        `<span class="wm-arrow">${isOpen ? '▼' : '▶'}</span>` +
        `</div>` +
        entriesHtml +
        `</div>`
      );
    }).join('');

    root.innerHTML =
      `<div class="wm-wrap">` +
      `<div class="wm-top">` +
      `<b>世界书快捷管理</b>` +
      `<div class="wm-tools">` +
      `<button type="button" class="wm-btn ${batchMode ? 'wm-primary' : 'wm-light'}" data-a="batch-mode">${batchMode ? '退出批量' : '批量管理'}</button>` +
      `<button type="button" class="wm-btn wm-light" data-a="upload">批量上传</button>` +
      `<button type="button" class="wm-btn wm-light" data-a="refresh">刷新</button>` +
      `</div>` +
      `<input type="file" id="wm-file-input" accept=".json,application/json" multiple style="display:none">` +
      `</div>` +

      `<input type="text" class="wm-input" id="wm-search" placeholder="搜索世界书名称…" value="${esc(searchQuery)}">` +

      (batchMode
        ? `<div class="wm-summary-bar">` +
          `<span class="wm-summary-text">批量模式：已勾选 <b>${batchCount}</b> 本</span>` +
          `<div class="wm-tools">` +
          `<button type="button" class="wm-btn wm-light" data-a="batch-all">全选</button>` +
          `<button type="button" class="wm-btn wm-light" data-a="batch-none">全不选</button>` +
          `<button type="button" class="wm-btn wm-primary" data-a="batch-download" ${batchCount ? '' : 'disabled'}>下载(${batchCount})</button>` +
          `<button type="button" class="wm-btn wm-danger-btn" data-a="batch-delete" ${batchCount ? '' : 'disabled'}>删除(${batchCount})</button>` +
          `</div></div>`
        : `<div class="wm-summary-bar">` +
          `<span class="wm-summary-text">已全局启用 <b>${activeCount}</b> 本世界书（左侧勾选即全局开关）</span>` +
          `<div class="wm-tools">` +
          `<button type="button" class="wm-btn wm-light" data-a="global-clear" ${activeCount ? '' : 'disabled'}>清空启用</button>` +
          `</div></div>`
      ) +

      `<div class="wm-scroll-box">` +
      (booksHtml || `<div class="wm-empty">${worldNames.length ? '没有匹配的世界书' : '未读取到世界书，请点上方「刷新」'}</div>`) +
      `</div>` +

      `<div id="wm-status"></div>` +
      `<details class="wm-details"><summary>运行日志（出问题时把这里的内容发给我）</summary><pre id="wm-log">${esc(logs.join('\n'))}</pre></details>` +
      `</div>`;

    bindEvents();
  }

  function bindEvents() {
    if (!root) return;

    // 搜索框（保持输入焦点与光标位置）
    const sInput = root.querySelector('#wm-search');
    if (sInput) {
      sInput.oninput = () => {
        searchQuery = sInput.value;
        const pos = sInput.selectionStart;
        render();
        const nextInput = root.querySelector('#wm-search');
        if (nextInput) {
          nextInput.focus();
          try { nextInput.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
        }
      };
    }

    // 文件上传 input
    const fileInput = root.querySelector('#wm-file-input');
    if (fileInput) {
      fileInput.onchange = e => handleUploadFiles(e.target.files);
    }

    // 复选框事件：防止冒泡触发行展开
    root.querySelectorAll('input[data-a="toggle-book"]').forEach(chk => {
      chk.onclick = e => e.stopPropagation();
      chk.onchange = e => {
        e.stopPropagation();
        const book = chk.dataset.book;
        onToggleBookCheck(book, chk.checked);
      };
    });

    root.querySelectorAll('input[data-a="toggle-entry"]').forEach(chk => {
      chk.onclick = e => e.stopPropagation();
      chk.onchange = e => {
        e.stopPropagation();
        onToggleEntryCheck(chk.dataset.book, chk.dataset.ekey, chk.checked);
      };
    });

    // 其他按钮与行点击
    root.querySelectorAll('[data-a]').forEach(el => {
      const a = el.dataset.a;
      if (a === 'toggle-book' || a === 'toggle-entry') return;
      el.onclick = e => {
        e.stopPropagation();
        handleAction(a, el);
      };
    });
  }

  // ---------- 7. 交互动作实现 ----------
  async function onToggleBookCheck(book, checked) {
    if (batchMode) {
      if (checked) batchSelected.add(book);
      else batchSelected.delete(book);
      render();
      return;
    }
    try {
      const next = new Set(globalActive);
      if (checked) next.add(book);
      else next.delete(book);
      await applyGlobalActive(next);
      render();
      status((checked ? '已全局开启：' : '已全局关闭：') + book);
    } catch (e) {
      log('切换全局世界书失败：' + e.message);
      status('操作失败：' + e.message, true);
    }
  }

  async function onToggleEntryCheck(book, ekey, enabled) {
    const bData = bookCache[book];
    if (!bData || !bData.entries || !bData.entries[ekey]) return;
    const prevDisable = bData.entries[ekey].disable;
    bData.entries[ekey].disable = !enabled;
    try {
      await saveBookData(book, bData);
      render();
      const title = bData.entries[ekey].comment || bData.entries[ekey].key || ekey;
      status(`${book} → 「${title}」已${enabled ? '开启' : '关闭'}`);
      log(`条目开关已保存：${book} / ${title} -> ${enabled ? '开启' : '关闭'}`);
    } catch (e) {
      bData.entries[ekey].disable = prevDisable;
      render();
      log('保存条目状态失败：' + e.message);
      status('保存失败：' + e.message, true);
    }
  }

  async function onBulkSetEntries(book, enableAll) {
    const bData = bookCache[book];
    if (!bData || !bData.entries) return;
    Object.values(bData.entries).forEach(entry => {
      if (entry && typeof entry === 'object') entry.disable = !enableAll;
    });
    try {
      await saveBookData(book, bData);
      render();
      status(`已将「${book}」全部条目设为${enableAll ? '开启' : '关闭'}`);
      log(`批量设置条目：${book} -> 全部${enableAll ? '开启' : '关闭'}`);
    } catch (e) {
      log('批量保存条目失败：' + e.message);
      status('保存失败：' + e.message, true);
    }
  }

  async function handleAction(a, btn) {
    dlgAnchor = btn || null;

    if (a === 'toggle-expand') {
      const book = btn.dataset.book;
      if (expandedBooks.has(book)) {
        expandedBooks.delete(book);
        render();
        return;
      }
      expandedBooks.add(book);
      if (!bookCache[book]) {
        loadingBooks.add(book);
        render();
        try {
          await fetchBookData(book, false);
        } catch (e) {
          log(`读取「${book}」失败：` + e.message);
          status(`读取「${book}」失败：` + e.message, true);
        } finally {
          loadingBooks.delete(book);
        }
      }
      render();
      return;
    }

    if (a === 'entry-all-on') return onBulkSetEntries(btn.dataset.book, true);
    if (a === 'entry-all-off') return onBulkSetEntries(btn.dataset.book, false);

    if (a === 'refresh') {
      status('正在刷新世界书列表…');
      bookCache = {};
      await fetchWorldList();
      render();
      status('刷新完成');
      return;
    }

    if (a === 'batch-mode') {
      batchMode = !batchMode;
      batchSelected.clear();
      render();
      return;
    }

    if (a === 'batch-all') {
      const q = searchQuery.trim().toLowerCase();
      const target = q ? worldNames.filter(n => n.toLowerCase().includes(q)) : worldNames;
      target.forEach(n => batchSelected.add(n));
      render();
      return;
    }

    if (a === 'batch-none') {
      batchSelected.clear();
      render();
      return;
    }

    if (a === 'global-clear') {
      await applyGlobalActive(new Set());
      render();
      status('已清空全部全局启用的世界书');
      return;
    }

    if (a === 'upload') {
      const fi = root && root.querySelector('#wm-file-input');
      if (fi) { fi.value = ''; fi.click(); }
      return;
    }

    if (a === 'batch-download') {
      const list = Array.from(batchSelected);
      if (!list.length) return;
      status(`正在准备下载 ${list.length} 本世界书…`);
      let okNum = 0;
      for (const name of list) {
        try {
          const data = await fetchBookData(name, false);
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = safeFileName(name) + '.json';
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          okNum++;
          await new Promise(r => setTimeout(r, 180));
        } catch (e) {
          log(`导出「${name}」失败：` + e.message);
        }
      }
      status(`已触发下载 ${okNum}/${list.length} 本世界书`);
      log(`批量下载完成：成功 ${okNum}/${list.length} 本`);
      return;
    }

    if (a === 'batch-delete') {
      const list = Array.from(batchSelected);
      if (!list.length) return;
      showDialog(
        '确认批量删除',
        `<div>确定要永久删除以下 <b>${list.length}</b> 本世界书吗？此操作不可恢复：</div>` +
        `<div style="max-height:120px;overflow:auto;padding:6px;border-radius:6px;background:rgba(127,127,127,.1);font-size:11px">${list.map(esc).join('、')}</div>`,
        async () => {
          let delCount = 0;
          for (const name of list) {
            try {
              await deleteBookApi(name);
              delCount++;
            } catch (e) {
              log(`删除「${name}」失败：` + e.message);
            }
          }
          await refreshTavernWorldUI();
          render();
          status(`已删除 ${delCount}/${list.length} 本世界书`);
          log(`批量删除完成：成功 ${delCount}/${list.length} 本`);
        },
        '确认删除'
      );
    }
  }

  // 批量上传解析与保存
  function normalizeWorldData(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('JSON 不是有效对象');
    if (raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
      return raw;
    }
    if (Array.isArray(raw.entries)) {
      const entries = {};
      raw.entries.forEach((item, idx) => {
        const k = item && item.uid !== undefined ? String(item.uid) : String(idx);
        entries[k] = item;
      });
      return Object.assign({}, raw, { entries });
    }
    if (Array.isArray(raw)) {
      const entries = {};
      raw.forEach((item, idx) => {
        const k = item && item.uid !== undefined ? String(item.uid) : String(idx);
        entries[k] = item;
      });
      return { entries };
    }
    throw new Error('未识别到 entries 字段');
  }

  async function handleUploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    status(`正在上传 ${files.length} 个世界书文件…`);
    let okCount = 0;
    let failCount = 0;

    for (const file of files) {
      const bookName = safeFileName(file.name);
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const norm = normalizeWorldData(parsed);
        await saveBookData(bookName, norm);
        if (!worldNames.includes(bookName)) worldNames.push(bookName);
        okCount++;
        log(`上传成功：「${bookName}」（${Object.keys(norm.entries).length} 条目）`);
      } catch (e) {
        failCount++;
        log(`上传失败「${file.name}」：` + e.message);
      }
    }

    await refreshTavernWorldUI();
    render();
    if (failCount) {
      status(`上传完成：成功 ${okCount} 本，失败 ${failCount} 本（详见运行日志）`, true);
    } else {
      status(`成功上传 ${okCount} 本世界书`);
    }
  }

  // ---------- 8. 挂载与初始化 ----------
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'worldbook-manager-inline';
    panel.innerHTML =
      `<div class="inline-drawer">` +
      `<div class="inline-drawer-toggle inline-drawer-header">` +
      `<b>世界书快捷管理</b>` +
      `<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>` +
      `</div>` +
      `<div class="inline-drawer-content"><div id="wm-manager-root"></div></div>` +
      `</div>`;
    root = panel.querySelector('#wm-manager-root');
    render();
    return panel;
  }

  function mount() {
    if (document.getElementById('worldbook-manager-inline')) return true;
    // 优先挂在世界书页面，其次挂在扩展设置页面
    const selectors = [
      '#WorldInfo',
      '#world_info_block',
      '#extensions_settings2',
      '#extensions_settings'
    ];
    let target = null;
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) { target = el; break; }
    }
    if (!target) return false;

    const panel = createPanel();
    if (target.id === 'WorldInfo' || target.id === 'world_info_block') {
      target.insertBefore(panel, target.firstChild);
    } else {
      target.appendChild(panel);
    }
    log('面板已挂载到：#' + (target.id || target.className));
    fetchWorldList().then(() => render()).catch(e => log('初始拉取列表出错：' + e.message));
    return true;
  }

  function init() {
    if (mount()) return;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (mount() || tries > 120) clearInterval(t);
    }, 1000);
  }

  // 暴露测试与外部调用接口
  window.worldbookManager = {
    refresh: async () => { await fetchWorldList(); render(); },
    getWorldNames: () => worldNames.slice(),
    getGlobalActive: () => Array.from(globalActive),
    normalizeWorldData
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
