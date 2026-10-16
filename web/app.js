/* Local page logic. Talks only to the local server that started it (same origin). */
(() => {
  const $ = (id) => document.getElementById(id);
  let lang = 'zh';
  try { lang = localStorage.getItem('lc-lang') || 'zh'; } catch { /* storage off */ }
  let state = null;
  let groups = null;
  const picked = new Set();
  let pollTimer = null;
  let lastJobId = null;

  const t = (key, vars = {}) => String((I18N[lang] || I18N.zh)[key] ?? I18N.zh[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtDate = (iso) => {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', { timeZone: 'Europe/London', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)); } catch { return iso; }
  };

  function applyText() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    $('lang').textContent = lang === 'zh' ? 'English' : '中文';
    updateStart();
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrf || '' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.error === 'signed-out') { showBanner(t('signedOut'), 'warn'); await refresh(); throw new Error(data.message); }
    if (!res.ok) throw new Error(data.message || data.error || res.statusText);
    return data;
  }

  function showBanner(text, kind = 'info') {
    const b = $('banner');
    b.textContent = text; b.className = `banner ${kind}`; b.hidden = !text;
  }

  async function refresh() {
    state = await api('GET', '/api/state');
    $('version').textContent = `v${state.version}`;
    $('who').textContent = state.user ? state.user.name : '';
    const signedIn = !!state.user;
    $('signin').hidden = signedIn;
    $('home').hidden = !signedIn;
    renderLogin();
    if (!signedIn) return;
    renderFolder();
    renderClients();
    if (!groups) loadCourses();
    if (state.job) watchJob(state.job);
  }

  function renderLogin() {
    const l = state.login || {};
    $('login').disabled = l.state === 'waiting';
    $('loginState').textContent = l.state === 'waiting' ? t('loginWaiting') : l.state === 'failed' ? t('loginFailed') + (l.error || '') : '';
    if (l.state === 'waiting') setTimeout(refresh, 1500);
  }

  function renderFolder() {
    $('folderPath').textContent = state.root || state.defaultRoot;
    $('folderHint').textContent = state.root ? '' : t('folderNotSet');
    $('changeFolder').textContent = state.root ? t('changeFolder') : t('folderConfirm');
    $('openRoot').hidden = !state.root;
    $('sync').disabled = !state.root || !state.selection.length;
  }

  async function loadCourses() {
    try {
      const r = await api('GET', '/api/courses');
      groups = r.groups;
      for (const id of state.selection) picked.add(String(id));
      renderCourses();
      loadOverview();
      loadHistory();
    } catch (e) { $('courses').innerHTML = `<p class="warn">${esc(e.message)}</p>`; }
  }

  function renderCourses() {
    const html = groups.map((g) => {
      const label = g.kind === 'other' ? t('groupOther') : g.label || t('groupNoTerm');
      const cards = g.courses.map((c) => {
        const last = c.last ? `<div class="small">${esc(t('lastResult', c.last.counts))}${c.last.incomplete || !c.last.complete ? ` · <span class="warn">${t('scanIncomplete')}</span>` : ''}</div>` : '';
        return `<label class="course${picked.has(c.id) ? ' on' : ''}">
          <input type="checkbox" value="${esc(c.id)}" ${picked.has(c.id) ? 'checked' : ''}>
          <span class="course-body">
            <span class="code">${esc(c.code || c.name)}</span>
            <span class="name">${esc(c.name)}</span>
            <span class="meta muted small">${c.saved ? esc(t('savedFiles', { n: c.saved })) : t('neverDownloaded')}</span>
            ${last}
          </span>
        </label>`;
      }).join('');
      return `<div class="group"><h3>${esc(label)}${g.kind === 'current' ? ` <span class="tag">${t('groupCurrent')}</span>` : ''}</h3><div class="grid">${cards}</div></div>`;
    }).join('');
    $('courses').innerHTML = html || '<p class="muted">—</p>';
    for (const box of $('courses').querySelectorAll('input[type=checkbox]')) {
      box.addEventListener('change', () => {
        if (box.checked) picked.add(box.value); else picked.delete(box.value);
        box.closest('.course').classList.toggle('on', box.checked);
        updateStart();
      });
    }
    updateStart();
  }

  function updateStart() {
    if (!$('start')) return;
    $('start').textContent = picked.size ? t('startButton', { n: picked.size }) : t('startButtonNone');
    const running = state?.job?.state === 'running';
    $('start').disabled = running;
    $('preview').disabled = running;
  }

  async function loadOverview() {
    try {
      const o = await api('GET', '/api/overview');
      $('upcoming').innerHTML = o.upcoming.length ? o.upcoming.map((u) => {
        const status = u.submission ? t('unknownSubmission') : u.missing ? t('missing') : u.submitted === true ? t('submitted') : u.submitted === false ? t('notSubmitted') : '';
        const cls = u.missing ? 'warn' : u.submitted ? 'ok' : 'muted';
        return `<li><div><strong>${esc(u.title)}</strong> <span class="muted small">${esc(u.course || '')} · ${esc(u.type)}</span></div>
          <div class="small">${u.due ? `${t('due')} ${esc(fmtDate(u.due))}` : t('noDue')}${status ? ` · <span class="${cls}">${esc(status)}</span>` : ''}</div></li>`;
      }).join('') : `<li class="muted">${t('nothingUpcoming')}</li>`;
      $('announcements').innerHTML = o.announcements.length ? o.announcements.map((a) => `<li><div><strong>${esc(a.title)}</strong> <span class="muted small">${esc(a.course || '')} · ${esc(fmtDate(a.posted))}</span></div><div class="small muted clamp">${esc(a.text)}</div></li>`).join('') : `<li class="muted">${t('noAnnouncements')}</li>`;
    } catch (e) {
      $('upcoming').innerHTML = `<li class="warn">${esc(e.message)}</li>`;
      $('announcements').innerHTML = '';
    }
  }

  async function loadHistory() {
    const { history } = await api('GET', '/api/history').catch(() => ({ history: [] }));
    $('history').innerHTML = history.length ? history.map((h) => `<li><div class="small"><strong>${esc(fmtDate(h.at))}</strong> ${h.cancelled ? `· ${t('cancelled')}` : !h.complete ? `· <span class="warn">${t('scanIncomplete')}</span>` : ''}</div>
      <div class="small muted">${h.courses.map((c) => `${esc(c.code || c.id)}: ${esc(t('countsLine', c.counts))}`).join('<br>')}</div></li>`).join('') : `<li class="muted">${t('noHistory')}</li>`;
  }

  function renderClients() {
    $('clients').innerHTML = state.clients.map((c) => `<div class="client"><div><strong>${esc(c.name)}</strong>${c.detected ? '' : ` <span class="muted small">${t('notDetected')}</span>`}</div>
      <button class="btn ${c.detected ? 'primary' : 'ghost'}" type="button" data-client="${esc(c.id)}" ${c.detected ? '' : 'disabled'}>${t('connectButton')}</button></div>`).join('')
      + `<p class="muted small">${t('connectOther')}</p>`;
    for (const b of $('clients').querySelectorAll('button[data-client]')) {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const r = await api('POST', '/api/connect', { clientId: b.dataset.client });
          const out = $('connectResult');
          out.hidden = false;
          out.textContent = t('connected', { name: r.name, restart: r.restart[lang] || r.restart.en }) + (r.backup ? `  (backup: ${r.backup})` : '');
        } catch (e) { showBanner(e.message, 'warn'); } finally { b.disabled = false; }
      });
    }
  }

  // ---------- jobs ----------
  async function startJob(kind) {
    if (kind !== 'sync' && !picked.size) return showBanner(t('chooseCourse'), 'warn');
    if (!state.root) { openFolderForm(); return; }
    if (kind === 'sync' && !state.selection.length) return showBanner(t('noSelection'), 'warn');
    showBanner('');
    try {
      const body = { courseIds: [...picked], includeImages: $('images').checked };
      const r = await api('POST', kind === 'preview' ? '/api/preview' : kind === 'sync' ? '/api/sync' : '/api/download', body);
      if (kind !== 'preview') { state.selection = kind === 'sync' ? state.selection : [...picked]; renderFolder(); }
      watchJob(r.job);
    } catch (e) { showBanner(e.message, 'warn'); }
  }

  function watchJob(job) {
    renderJob(job);
    clearTimeout(pollTimer);
    if (job.state === 'running') {
      pollTimer = setTimeout(async () => {
        const r = await api('GET', '/api/job').catch(() => null);
        if (r?.job) watchJob(r.job);
      }, 900);
    } else if (lastJobId !== job.id) {
      lastJobId = job.id;
      if (job.preview && job.result) showPreview(job.result);
      if (!job.preview) { groups = null; loadCourses(); }
    }
  }

  function renderJob(job) {
    state.job = job;
    updateStart();
    if (job.preview && job.state !== 'running') { $('progress').hidden = true; return; }
    $('progress').hidden = false;
    const running = job.state === 'running';
    const complete = job.result?.complete;
    $('progressTitle').textContent = running ? (job.preview ? t('progressPreview') : t('progressRunning'))
      : job.state === 'cancelled' ? t('progressCancelled') : job.state === 'failed' ? `${t('failed')}: ${job.error?.message || ''}` : complete ? t('progressDone') : t('progressDoneIncomplete');
    $('bar').hidden = !running;
    $('cancel').hidden = !running;
    $('doneActions').hidden = running || job.preview;
    $('current').textContent = running && job.current ? `${t('downloading')}: ${job.current.name}` : '';
    const results = job.result?.courses || [];
    $('perCourse').innerHTML = job.courses.map((c) => {
      const r = results.find((x) => String(x.id) === String(c.id));
      const counts = r?.counts || c.counts;
      const label = esc(r?.code || c.code || findCourse(c.id)?.code || c.id);
      const st = c.state === 'scanning' ? `${t('scanning')} ${c.phase ? `(${t('phase_' + c.phase)})` : ''}` : c.state === 'downloading' ? t('downloading') : c.state === 'done' ? t('done') : '…';
      const lines = [];
      if (counts) lines.push(t('countsLine', counts));
      if (r?.counts.remoteUpdated) lines.push(t('remoteUpdated', { n: r.counts.remoteUpdated }));
      if (r?.counts.skipped) lines.push(t('skippedLine', { n: r.counts.skipped }));
      if (r?.counts.images) lines.push(t('imagesLine', { n: r.counts.images }));
      const issues = [...(r?.failed || []).map((f) => `✗ ${esc(f.name)}: ${esc(f.error)}`), ...(r?.incomplete || []).map((x) => `⚠ ${t('scanIncomplete')}: ${esc(x.source)} — ${esc(x.reason)}`)];
      return `<div class="pc"><div><strong>${label}</strong> <span class="muted small">${esc(st)}</span></div>
        <div class="small">${lines.map(esc).join(' · ')}</div>${issues.length ? `<div class="small warn">${issues.slice(0, 8).join('<br>')}</div>` : ''}</div>`;
    }).join('');
  }

  const findCourse = (id) => groups?.flatMap((g) => g.courses).find((c) => c.id === String(id));

  function showPreview(result) {
    const body = result.courses.map((c) => {
      const files = (c.files || []).filter((f) => f.action !== 'already saved');
      return `<div class="pv"><strong>${esc(t('previewCourse', { code: c.code || c.id, ...c.counts }))}</strong>
        ${c.incomplete.length ? `<div class="warn small">${c.incomplete.map((x) => `⚠ ${esc(x.source)}: ${esc(x.reason)}`).join('<br>')}</div>` : ''}
        <ul class="small">${files.slice(0, 300).map((f) => `<li>${esc(f.folder)}/<strong>${esc(f.name)}</strong></li>`).join('')}</ul></div>`;
    }).join('');
    $('previewBody').innerHTML = body || `<p>${t('previewNothing')}</p>`;
    $('previewDialog').showModal();
  }

  // ---------- folder ----------
  function openFolderForm() {
    $('folderForm').hidden = false;
    $('folderInput').value = state.root || state.defaultRoot;
    $('folderWarn').hidden = !state.root;
    $('folderInput').focus();
  }

  // ---------- events ----------
  $('lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem('lc-lang', lang); } catch { /* ignore */ }
    applyText();
    if (state?.user) { renderFolder(); renderClients(); if (groups) renderCourses(); loadOverview(); loadHistory(); if (state.job) renderJob(state.job); }
  });
  $('login').addEventListener('click', async () => { try { const r = await api('POST', '/api/login'); state.login = r.login; renderLogin(); } catch (e) { showBanner(e.message, 'warn'); } });
  $('changeFolder').addEventListener('click', openFolderForm);
  $('folderCancel').addEventListener('click', () => { $('folderForm').hidden = true; });
  $('folderForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', '/api/folder', { path: $('folderInput').value });
      $('folderForm').hidden = true;
      if (r.changed) picked.clear();
      groups = null;
      await refresh();
    } catch (e) { showBanner(e.message, 'warn'); }
  });
  $('openRoot').addEventListener('click', () => api('POST', '/api/open', {}).catch((e) => showBanner(e.message, 'warn')));
  $('openAfter').addEventListener('click', () => {
    const ids = state.job?.courses?.map((c) => c.id) || [];
    api('POST', '/api/open', ids.length === 1 ? { courseId: ids[0] } : {}).catch((e) => showBanner(e.message, 'warn'));
  });
  $('start').addEventListener('click', () => startJob('download'));
  $('preview').addEventListener('click', () => startJob('preview'));
  $('sync').addEventListener('click', () => startJob('sync'));
  $('retry').addEventListener('click', () => {
    const ids = state.job?.courses?.map((c) => c.id) || [];
    for (const id of ids) picked.add(id);
    startJob('download');
  });
  $('cancel').addEventListener('click', () => api('POST', '/api/cancel').catch(() => {}));
  $('closeProgress').addEventListener('click', () => { $('progress').hidden = true; });
  $('previewDialog').addEventListener('close', () => { if ($('previewDialog').returnValue === 'start') startJob('download'); });
  $('logout').addEventListener('click', async () => {
    if (!confirm(t('logoutConfirm'))) return;
    await api('POST', '/api/logout').catch((e) => showBanner(e.message, 'warn'));
    groups = null; picked.clear();
    await refresh();
  });
  $('quit').addEventListener('click', async () => {
    await api('POST', '/api/shutdown').catch(() => {});
    document.body.innerHTML = `<main><div class="card hero"><p>${esc(t('shutDown'))}</p></div></main>`;
  });

  applyText();
  refresh().catch((e) => showBanner(e.message, 'warn'));
})();
