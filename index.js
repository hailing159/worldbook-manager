(function () {
  'use strict';
  const EXT = 'worldbook-manager';

  // ---------- 1. 工具函数 ----------
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeName = v => String(v || '世界书').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100) || '世界书';

  // ---------- 2. 状态 ----------
  const logs = [];
  const bookCache = new Map();
  const loadingBooks = new Map();   // 修复：原来是 Set，却用了 get/set
  let root = null, books = [], expanded = new Set(), selected = new Set();
  let manage = false, busy = false, statusTimer = null, deleteArmed = false;
  let fileMap = new Map();          // 显示名 -> 服务器上的真实文件名
  let wiModule = undefined;         // undefined=未尝试；null=不可用；object=可用

  function log(s) {
    logs.push(new Date().toLocaleTimeString() + ' ' + s);
    while (logs.length > 60) logs.shift();
    const el = root && root.querySelector('#wbm-log');
    if (el) el.textContent = logs.join('\n');
  }
  function status(s, bad) {
    const el = root && root.querySelector('#wbm-status');
    if (el) { el.textContent = s; el.classList.toggle('bad', !!bad); }
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { const e = root && root.querySelector('#wbm-status'); if (e) e.textContent = ''; }, 8000);
    log((bad ? '错误：' : '') + s);
  }

  // ---------- 3. 酒馆接口 ----------
  function ctx() { try { return window.SillyTavern?.getContext?.() || null; } catch (e) { return null; } }
  function headers() {
    try { const h = ctx()?.getRequestHeaders?.(); if (h) return h; } catch (e) { /* ignore */ }
    return { 'Content-Type': 'application/json' };
  }
  async function request(url, opts = {}) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const h = Object.assign({}, headers(), opts.headers || {});
      const r = await fetch(url, Object.assign({ credentials: 'same-origin', signal: ctrl.signal }, opts, { headers: h }));
      const t = await r.text();
      let d = {};
      try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { raw: t }; }
      if (!r.ok) throw new Error((d && (d.error || d.message)) || ('HTTP ' + r.status));
      if (d && d.error) throw new Error(typeof d.error === 'string' ? d.error : JSON.stringify(d.error));
      return d;
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '请求超时' : (e.message || '请求失败'));
    } finally { clearTimeout(timer); }
  }
  const post = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  // 酒馆自己的世界书函数（读写都走它，才能同步酒馆页面里的缓存）
  async function wi() {
    if (wiModule !== undefined) return wiModule;
    const c = ctx();
    if (c && typeof c.loadWorldInfo === 'function' && typeof c.saveWorldInfo === 'function') {
      wiModule = { load: c.loadWorldInfo, save: c.saveWorldInfo, reload: c.reloadWorldInfoEditor, updateList: c.updateWorldInfoList, from: 'context' };
      log('使用酒馆上下文的世界书接口');
      return wiModule;
    }
    try {
      const m = await import('/scripts/world-info.js');
      if (typeof m.loadWorldInfo === 'function' && typeof m.saveWorldInfo === 'function') {
        wiModule = { load: m.loadWorldInfo, save: m.saveWorldInfo, reload: m.reloadEditor, updateList: m.updateWorldInfoList, from: 'module' };
        log('使用 /scripts/world-info.js 的世界书接口');
        return wiModule;
      }
    } catch (e) { log('无法导入 world-info.js：' + e.message); }
    wiModule = null;
    log('酒馆世界书函数不可用，退回服务器接口（条目开关需刷新页面才生效）');
    return wiModule;
  }

  function nativeSelect() { return document.querySelector('#world_info'); }
  function globalNames() {
    const el = nativeSelect();
    if (!el) return null;
    // 注意：酒馆这个下拉框的 option.value 是序号，名字在 textContent
    return Array.from(el.selectedOptions || []).map(o => (o.textContent || '').trim()).filter(Boolean);
  }
  function isGlobal(name) { const a = globalNames(); return a ? a.includes(name) : false; }
  function setGlobal(name, on) {
    const el = nativeSelect();
    if (!el) throw new Error('找不到酒馆原生全局世界书选择框（#world_info）。');
    const norm = s => String(s || '').trim();
    const opt = Array.from(el.options).find(o => norm(o.textContent) === norm(name));
    if (!opt) throw new Error('原生全局世界书列表中找不到：' + name + '。请先刷新酒馆的世界书列表。');
    opt.selected = !!on;
    const $ = window.jQuery || window.$;
    if ($) $(el).trigger('change'); else el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function loadFileMap() {
    try {
      const d = await post('/api/worldinfo/list', {});
      const arr = Array.isArray(d) ? d : (d.world_names || d.worlds || d.data || []);
      const m = new Map(), names = [];
      arr.forEach(x => {
        if (typeof x === 'string') { m.set(x, x); names.push(x); }
        else if (x && typeof x === 'object') {
          const id = x.file_id || x.name, nm = x.name || x.file_id;
          if (id) { m.set(nm, id); m.set(id, id); names.push(nm); }
        }
      });
      fileMap = m;
      const bad = Array.from(m).filter(([k, v]) => k !== v);
      if (bad.length) log('名称与文件名不一致：' + bad.map(([k, v]) => k + ' → ' + v).join('；'));
      return names;
    } catch (e) { log('文件列表接口失败：' + e.message); return []; }
  }
  const sid = name => fileMap.get(name) || name;   // 发给服务器时用真实文件名

  async function getList() {
    const names = [];
    const add = n => { if (typeof n === 'string' && n && !names.includes(n)) names.push(n); };
    const c = ctx();
    const fromCtx = [c?.world_names, c?.worldNames, window.world_names].find(a => Array.isArray(a) && a.length);
    if (fromCtx) fromCtx.forEach(x => add(typeof x === 'string' ? x : (x.name || x.file_id)));
    const sel = nativeSelect();
    if (!names.length && sel) Array.from(sel.options).forEach(o => add(o.textContent));   // 不做 trim，名字末尾的空格也是名字的一部分
    const apiNames = await loadFileMap();
    apiNames.forEach(add);
    if (!names.length) throw new Error('酒馆世界书列表接口不可用（没有读到任何世界书）。');
    return names;
  }

  function pickBook(d) {   // 找出真正含有 entries 的那一层
    if (!d || typeof d !== 'object') return null;
    for (const c of [d, d.worldinfo, d.data, d.originalData]) {
      if (c && typeof c === 'object' && c.entries && typeof c.entries === 'object') return c;
    }
    return null;
  }
  const countEntries = d => (d && d.entries && typeof d.entries === 'object') ? Object.keys(d.entries).length : 0;

  async function getBook(name, force) {
    if (!force && bookCache.has(name)) return bookCache.get(name);
    if (loadingBooks.has(name)) return loadingBooks.get(name);
    const p = (async () => {
      let data = null;
      const api = await wi();
      const id = sid(name);
      if (api && id === name) {
        try {
          const r = await api.load(name);
          data = pickBook(r);
          log('酒馆读取「' + name + '」：' + (r && typeof r === 'object' ? '字段[' + Object.keys(r).join(',') + ']' : String(r)) + '，条目 ' + countEntries(data));
        } catch (e) { log('酒馆读取失败：' + e.message); }
      }
      if (!data || !countEntries(data)) {   // 酒馆那边没读到条目，再从服务器读一次，取条目多的
        try {
          const d = await post('/api/worldinfo/get', { name: id });
          const sv = pickBook(d);
          log('服务器读取「' + name + '」：字段[' + (d && typeof d === 'object' ? Object.keys(d).join(',') : '') + ']，条目 ' + countEntries(sv));
          if (sv && (!data || countEntries(sv) > countEntries(data))) data = sv;
        } catch (e) { log('服务器读取失败：' + e.message); if (!data) throw e; }
      }
      if (!data) data = { entries: {} };
      bookCache.set(name, data);
      return data;
    })();
    loadingBooks.set(name, p);
    try { return await p; } finally { loadingBooks.delete(name); }
  }

  // 保存：优先走酒馆自己的 saveWorldInfo（同时更新酒馆页面内缓存），然后刷新酒馆的条目编辑器
  async function saveBook(name, data) {
    const api = await wi();
    if (api && sid(name) === name) {
      await api.save(name, data, true);
      try { if (typeof api.reload === 'function') api.reload(name); } catch (e) { log('刷新酒馆编辑器失败（可忽略）：' + e.message); }
    } else {
      await post('/api/worldinfo/edit', { name: sid(name), data });
    }
    bookCache.set(name, data);
  }
  async function deleteBook(name) { return post('/api/worldinfo/delete', { name: sid(name) }); }
  async function updateNativeList() {
    const api = await wi();
    try { if (api && typeof api.updateList === 'function') await api.updateList(); } catch (e) { log('刷新酒馆世界书列表失败：' + e.message); }
  }

  // ---------- 4. 条目字段 ----------
  const entryEnabled = v => v?.disable !== true;
  const entryContent = v => String(v?.content ?? '').replace(/\s+/g, ' ').trim();
  function entryKeywords(v) {
    const a = Array.isArray(v?.key) ? v.key : (typeof v?.key === 'string' ? [v.key] : []);
    return a.map(x => String(x).trim()).filter(Boolean).join('、');
  }
  function entryCount(data) {
    const arr = Object.values(data?.entries || {});
    return { total: arr.length, on: arr.filter(entryEnabled).length };
  }

  // ---------- 5. 渲染 ----------
  function renderEntries(name, data) {
    const arr = Object.entries(data?.entries || {});
    if (!arr.length) return '<div class="wbm-muted">这本世界书没有条目。</div>';
    return arr.map(([uid, v]) => {
      const comment = v.comment || ('条目 ' + uid), content = entryContent(v), keys = entryKeywords(v), on = entryEnabled(v);
      return `<div class="wbm-entry"><div class="wbm-entry-head"><input class="wbm-check wbm-entry-toggle" type="checkbox" data-book="${esc(name)}" data-uid="${esc(uid)}" ${on ? 'checked' : ''} aria-label="启用条目 ${esc(comment)}"><b>${esc(comment)}</b></div><div class="wbm-entry-preview" title="${esc(content || '暂无内容')}">${esc(content || '（暂无内容）')}</div>${keys ? `<div class="wbm-entry-key">关键词：${esc(keys)}</div>` : ''}</div>`;
    }).join('');
  }

  function render() {
    if (!root) return;
    const savedScroll = [];
    for (let el = root; el; el = el.parentElement) savedScroll.push([el, el.scrollTop]);
    const oldList = root.querySelector('.wbm-list');
    const listTop = oldList ? oldList.scrollTop : 0;
    const winY = window.scrollY;
    const list = books.map(name => {
      const open = expanded.has(name), active = isGlobal(name), chosen = selected.has(name);
      const cnt = bookCache.has(name) ? entryCount(bookCache.get(name)) : null;
      return `<section class="wbm-book" data-book="${esc(name)}"><div class="wbm-row">` +
        `<input class="wbm-check wbm-global" type="checkbox" data-name="${esc(name)}" ${active ? 'checked' : ''} aria-label="全局启用 ${esc(name)}">` +
        `<div class="wbm-name" role="button" tabindex="0" data-a="expand" data-name="${esc(name)}"><span class="wbm-arrow">${open ? '▼' : '▶'}</span><span class="wbm-name-text">${esc(name)}</span></div>` +
        `<span class="wbm-book-state">${cnt ? `${cnt.on}/${cnt.total}` : ''}</span>` +
        (manage ? `<input class="wbm-check wbm-pick" type="checkbox" data-name="${esc(name)}" ${chosen ? 'checked' : ''} aria-label="选择 ${esc(name)}">` : '') +
        `</div>` +
        (open ? `<div class="wbm-detail"><div class="wbm-entries" data-entry-for="${esc(name)}">${bookCache.has(name) ? renderEntries(name, bookCache.get(name)) : '<div class="wbm-loading">读取中…</div>'}</div></div>` : '') +
        `</section>`;
    }).join('');
    root.innerHTML =
      `<div class="wbm-wrap"><div class="wbm-toolbar"><button type="button" class="wbm-btn wbm-primary" data-a="refresh">刷新列表</button><button type="button" class="wbm-btn" data-a="manage">${manage ? '退出批量管理' : '批量管理'}</button><button type="button" class="wbm-btn" data-a="upload">批量上传</button></div>` +
      (manage ? `<div class="wbm-toolbar"><button type="button" class="wbm-btn" data-a="select-all">全选</button><button type="button" class="wbm-btn" data-a="select-none">全不选</button><button type="button" class="wbm-btn" data-a="download-selected">下载所选（${selected.size}）</button><button type="button" class="wbm-btn wbm-danger" data-a="delete-selected">${deleteArmed ? '再次点击确认删除！' : `删除所选（${selected.size}）`}</button></div>` : '') +
      `<div class="wbm-tip">☑ 世界书名前的复选框＝全局启用/关闭；展开后每个条目前的复选框＝该条目开启/关闭（右侧数字＝已开启条目数/总数）。</div>` +
      `<div class="wbm-list">${list || '<div class="wbm-empty">未找到世界书，或列表接口暂不可用。</div>'}</div>` +
      `<div id="wbm-status"></div>` +
      `<details class="wbm-logs"><summary>运行日志（出问题时展开并截图）</summary><pre id="wbm-log">${esc(logs.join('\n'))}</pre></details></div>`;
    const nl = root.querySelector('.wbm-list');
    if (nl) nl.scrollTop = listTop;
    savedScroll.forEach(([el, t]) => { el.scrollTop = t; });
    if (window.scrollY !== winY) window.scrollTo(0, winY);
    for (const name of expanded) if (!bookCache.has(name)) loadEntries(name);
  }

  function bookSection(name) {
    return root ? Array.from(root.querySelectorAll('.wbm-book')).find(x => x.dataset.book === name) : null;
  }
  // 展开/收起只改这一本，不重画整个列表（否则页面会跳回顶部）
  function toggleExpand(name) {
    const sec = bookSection(name);
    if (!sec) { expanded.has(name) ? expanded.delete(name) : expanded.add(name); render(); return; }
    const arrow = sec.querySelector('.wbm-arrow');
    const det = sec.querySelector('.wbm-detail');
    if (expanded.has(name)) { expanded.delete(name); if (det) det.remove(); if (arrow) arrow.textContent = '▶'; return; }
    expanded.add(name);
    if (arrow) arrow.textContent = '▼';
    const div = document.createElement('div');
    div.className = 'wbm-detail';
    div.innerHTML = `<div class="wbm-entries" data-entry-for="${esc(name)}">${bookCache.has(name) ? renderEntries(name, bookCache.get(name)) : '<div class="wbm-loading">读取中…</div>'}</div>`;
    sec.appendChild(div);
    if (!bookCache.has(name)) loadEntries(name);
  }

  function entryBox(name) {
    return root ? Array.from(root.querySelectorAll('[data-entry-for]')).find(e => e.dataset.entryFor === name) : null;
  }
  async function loadEntries(name) {
    if (bookCache.has(name) || loadingBooks.has(name)) return;
    try {
      const data = await getBook(name);
      const box = entryBox(name);
      if (box) box.innerHTML = renderEntries(name, data);
      const bs = bookSection(name)?.querySelector('.wbm-book-state');
      if (bs) { const c = entryCount(data); bs.textContent = c.on + '/' + c.total; }
    } catch (e) {
      const box = entryBox(name);
      if (box) box.textContent = '读取失败：' + e.message;
      log('读取世界书失败 ' + name + '：' + e.message);
    }
  }

  async function toggleEntry(name, uid, on, checkbox) {
    if (busy) { checkbox.checked = !on; return; }
    checkbox.disabled = true;
    try {
      const data = await getBook(name);
      if (!data.entries || !data.entries[uid]) throw new Error('找不到对应条目：' + uid);
      data.entries[uid].disable = !on;   // 酒馆：disable=true 表示关闭
      await saveBook(name, data);
      const actual = entryEnabled(data.entries[uid]);
      checkbox.checked = actual;
      const bs = checkbox.closest('.wbm-book')?.querySelector('.wbm-book-state');
      if (bs) { const c = entryCount(data); bs.textContent = c.on + '/' + c.total; }
      const api = (await wi()) && sid(name) === name;
      status('已' + (actual ? '开启' : '关闭') + '条目：' + (data.entries[uid].comment || uid) + (api ? '' : '（仅写入文件，请刷新酒馆页面后生效）'), !api);
      log('条目已保存 ' + name + ' / ' + uid + ' disable=' + data.entries[uid].disable);
    } catch (e) {
      checkbox.checked = !on;
      bookCache.delete(name);
      status('条目开关保存失败：' + e.message, true);
    } finally { checkbox.disabled = false; }
  }

  // ---------- 6. 下载 / 上传 ----------
  // 把简版格式（条目只有 content/comment/key）补成酒馆完整条目；没写 constant 的一律设为蓝灯（常驻）
  function normalizeBook(src) {
    const ents = src && src.entries;
    if (!ents || typeof ents !== 'object') throw new Error('不是世界书格式（缺少 entries）');
    const list = Array.isArray(ents) ? ents.map((v, i) => [String(i), v]) : Object.entries(ents);
    const used = new Set(), out = {};
    let blue = 0;
    list.forEach(([, v]) => { if (v && Number.isFinite(Number(v.uid))) used.add(Number(v.uid)); });
    let next = 0;
    for (const [, v] of list) {
      if (!v || typeof v !== 'object') continue;
      let uid;
      if (Number.isFinite(Number(v.uid))) uid = Number(v.uid);
      else { while (used.has(next)) next++; uid = next; used.add(uid); }
      const key = Array.isArray(v.key) ? v.key : (typeof v.key === 'string' ? v.key.split(/[,，]/).map(x => x.trim()).filter(Boolean) : (Array.isArray(v.keys) ? v.keys : []));
      if (v.constant === undefined) blue++;
      out[String(uid)] = Object.assign({
        uid, key, keysecondary: [], comment: '', content: '', constant: true, vectorized: false, selective: true, selectiveLogic: 0,
        addMemo: true, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
        probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100, scanDepth: null,
        caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: null, sticky: null, cooldown: null, delay: null, displayIndex: uid
      }, v, { uid, key });
    }
    return { data: Object.assign({}, src, { entries: out }), count: Object.keys(out).length, blue };
  }

  function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = safeName(name) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function fileInput() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json'; input.multiple = true; input.style.display = 'none';
    root.appendChild(input);
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return;
      busy = true;
      try {
        let ok = 0; const fail = [];
        for (const f of files) {
          try {
            const raw = JSON.parse(await f.text());
            const name = safeName(f.name.replace(/\.json$/i, ''));
            if (books.includes(name)) { fail.push(f.name + '：同名世界书已存在，已跳过'); continue; }
            const data = raw.entries ? raw : (raw.data || raw.worldinfo || raw);
            const norm = normalizeBook(data);
            await post('/api/worldinfo/edit', { name, data: norm.data });   // edit 会直接创建文件
            log('已上传「' + name + '」：' + norm.count + ' 个条目，其中 ' + norm.blue + ' 个自动设为蓝灯');
            ok++;
          } catch (e) { fail.push(f.name + '：' + e.message); }
        }
        bookCache.clear();
        await updateNativeList();
        await refresh();
        status(`上传完成：成功 ${ok} 个，失败 ${fail.length} 个。` + (fail.length ? ' ' + fail.join('；') : ''), fail.length > 0);
      } catch (e) { status('上传失败：' + e.message, true); } finally { busy = false; }
    };
    input.click();
  }

  // ---------- 7. 动作 ----------
  async function action(a, name) {
    if (busy) return;
    try {
      if (a === 'expand') { toggleExpand(name); return; }
      if (a === 'refresh') { bookCache.clear(); await refresh(); return; }
      if (a === 'manage') { manage = !manage; deleteArmed = false; if (!manage) selected.clear(); render(); return; }
      if (a === 'select-all') { books.forEach(n => selected.add(n)); render(); return; }
      if (a === 'select-none') { selected.clear(); render(); return; }
      if (a === 'upload') { fileInput(); return; }
      if (a === 'download-selected') {
        if (!selected.size) { status('请先勾选要下载的世界书', true); return; }
        busy = true; let ok = 0; const fail = [];
        for (const n of selected) { try { download(n, await getBook(n, true)); ok++; } catch (e) { fail.push(n + ': ' + e.message); } }
        status(`批量下载完成：${ok} 本，失败 ${fail.length} 本。` + (fail.length ? ' ' + fail.join('；') : ''), fail.length > 0);
        return;
      }
      if (a === 'delete-selected') {
        if (!selected.size) { status('请先勾选要删除的世界书', true); return; }
        if (!deleteArmed) {
          deleteArmed = true; render();
          status('⚠️ 再点一次“删除所选”确认删除 ' + selected.size + ' 本：' + Array.from(selected).join('、') + '。此操作不可撤销。', true);
          return;
        }
        deleteArmed = false; busy = true; let ok = 0; const fail = [];
        for (const n of Array.from(selected)) { try { await deleteBook(n); bookCache.delete(n); ok++; } catch (e) { fail.push(n + ': ' + e.message); } }
        selected.clear();
        await updateNativeList();
        await refresh();
        status(`批量删除完成：${ok} 本，失败 ${fail.length} 本。` + (fail.length ? ' ' + fail.join('；') : ''), fail.length > 0);
      }
    } catch (e) { status(e.message || '操作失败', true); } finally { busy = false; }
  }

  async function refresh() {
    try {
      status('正在读取世界书列表…');
      books = await getList();
      selected = new Set(Array.from(selected).filter(n => books.includes(n)));
      expanded = new Set(Array.from(expanded).filter(n => books.includes(n)));
      render();
      status('已读取 ' + books.length + ' 本世界书。条目只在展开时读取。');
    } catch (e) { books = []; render(); status('读取世界书列表失败：' + e.message, true); }
  }

  // ---------- 8. 挂载 ----------
  function bindEvents() {
    root.addEventListener('click', e => {
      const t = e.target.closest && e.target.closest('[data-a]');
      if (t && root.contains(t)) action(t.dataset.a, t.dataset.name, t);
    });
    root.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-a="expand"]')) { e.preventDefault(); action('expand', e.target.dataset.name); }
    });
    root.addEventListener('change', e => {
      const c = e.target;
      if (!c || !c.classList) return;
      if (c.classList.contains('wbm-global')) {
        try { setGlobal(c.dataset.name, c.checked); status((c.checked ? '已全局启用：' : '已取消全局启用：') + c.dataset.name); }
        catch (err) { c.checked = !c.checked; status(err.message, true); }
      } else if (c.classList.contains('wbm-entry-toggle')) {
        toggleEntry(c.dataset.book, c.dataset.uid, c.checked, c);
      } else if (c.classList.contains('wbm-pick')) {
        c.checked ? selected.add(c.dataset.name) : selected.delete(c.dataset.name);
        const s = root.querySelector('[data-a="download-selected"]'); if (s) s.textContent = '下载所选（' + selected.size + '）';
        const d = root.querySelector('[data-a="delete-selected"]'); if (d && !deleteArmed) d.textContent = '删除所选（' + selected.size + '）';
      }
    });
  }

  function createPanel() {
    const p = document.createElement('div');
    p.id = 'worldbook-manager-inline';
    p.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>世界书管理器</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div id="wbm-manager-root"></div></div></div>';
    root = p.querySelector('#wbm-manager-root');
    bindEvents();
    return p;
  }

  function mount() {
    if (document.getElementById('worldbook-manager-inline')) return true;
    const page = document.querySelector('#WorldInfo, #world_info_block, #world-info, .world_info_block, [data-tab-content="worldinfo"]');
    if (page) {
      page.appendChild(createPanel());
      log('面板已挂载到世界书页面底部');
      render(); refresh();
      return true;
    }
    const select = nativeSelect();
    if (select) {
      const anchor = select.closest('.world_info_block, .world-info-block, .inline-drawer, .flex-container') || select.parentElement?.parentElement || select.parentElement;
      if (anchor && anchor.parentElement) {
        anchor.insertAdjacentElement('afterend', createPanel());
        log('面板已挂载到原生世界书选择区域下方');
        render(); refresh();
        return true;
      }
    }
    return false;
  }

  function init() {
    if (mount()) return;
    let tries = 0;
    const t = setInterval(() => { if (mount() || ++tries >= 120) clearInterval(t); }, 1000);
  }

  window.worldbookManager = { refresh, normalizeBook, getBooks: () => books.slice(), getGlobalBooks: () => globalNames() || [] };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
