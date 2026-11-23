// yt-automation web UI. Plain JavaScript, no build step.
'use strict';

const $app = document.getElementById('app');
let cleanup = () => {};

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

async function api(method, path, body) {
  const opts = {method, headers: {}};
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.detail) || `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), error ? 7000 : 3000);
}

const ago = (ts) => {
  if (!ts) return '';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
};
const dur = (a, b) => {
  if (!a) return '';
  const s = Math.round((b || Date.now() / 1000) - a);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const badge = (status) => `<span class="badge ${esc(status)}">${esc(status)}</span>`;
// Pretty JSON with short arrays (countries, coordinates) kept on one line.
const pretty = (obj) => JSON.stringify(obj, null, 2).replace(/\[\s*([^\[\]{}]*?)\s*\]/g, (m, inner) => `[${inner.replace(/\s*\n\s*/g, ' ')}]`);
const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function every(ms, fn) {
  fn();
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

// ---------- router ----------

const routes = {
  '': dashboard,
  episodes: episodesView,
  episode: editorView,
  videos: videosView,
  voices: voicesView,
  music: musicView,
  settings: settingsView,
  job: jobView,
};

function route() {
  cleanup();
  cleanup = () => {};
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').map(decodeURIComponent);
  const name = parts[0] === 'episodes' && parts[1] ? 'episode' : parts[0] === 'jobs' && parts[1] ? 'job' : parts[0];
  const view = routes[name] || dashboard;
  document.querySelectorAll('#nav a').forEach((a) => {
    const r = a.dataset.route;
    a.classList.toggle('active', r === (name === 'episode' ? 'episodes' : name === 'job' ? 'dashboard' : name || 'dashboard'));
  });
  window.scrollTo(0, 0);
  Promise.resolve(view(parts[1])).catch((e) => {
    $app.innerHTML = `<div class="panel"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`;
  });
}
window.addEventListener('hashchange', route);

// Queue indicator in the top bar.
setInterval(updatePill, 3000);
async function updatePill() {
  try {
    const s = await api('GET', '/api/status');
    const pill = document.getElementById('queue-pill');
    pill.textContent = s.queue ? `${s.queue} rendering` : '';
    pill.classList.toggle('hidden', !s.queue);
  } catch { /* offline */ }
}

// ---------- dashboard ----------

async function dashboard() {
  $app.innerHTML = `
    <div class="spread"><h1>Dashboard</h1>
      <div class="row"><a class="btn" href="#/episodes">Episodes</a><a class="btn primary" href="#/episodes?new=1">+ New episode</a></div>
    </div>
    <div class="stats" id="stats"></div>
    <div id="current"></div>
    <div class="panel"><div class="spread"><h2>Render jobs</h2></div><div id="jobs"></div></div>`;

  const [status, episodes, videos] = await Promise.all([
    api('GET', '/api/status'), api('GET', '/api/episodes'), api('GET', '/api/videos'),
  ]);
  document.getElementById('stats').innerHTML = `
    <div class="stat"><b>${episodes.length}</b><span>episodes</span></div>
    <div class="stat"><b>${videos.length}</b><span>rendered episodes</span></div>
    <div class="stat"><b>${status.diskFreeGb} GB</b><span>free of ${status.diskTotalGb} GB</span></div>
    <div class="stat"><b>${status.claude ? 'On' : 'Off'}</b><span>Claude drafting</span></div>`;

  const logState = {id: null, from: 0};
  cleanup = every(2000, async () => {
    const jobs = await api('GET', '/api/jobs');
    const running = jobs.find((j) => j.status === 'running');
    renderJobsTable(jobs);
    const cur = document.getElementById('current');
    if (!cur) return;
    if (!running) {
      cur.innerHTML = '';
      logState.id = null;
      return;
    }
    if (logState.id !== running.id) {
      logState.id = running.id;
      logState.from = 0;
      cur.innerHTML = `
        <div class="panel">
          <div class="spread"><h2>Rendering: ${esc(running.slug)}</h2>
            <div class="row"><a class="btn small" href="#/jobs/${running.id}">Details</a>
            <button class="danger small" id="cancel-cur">Cancel</button></div></div>
          <div class="progress"><div id="cur-bar" style="width:0%"></div></div>
          <p class="small muted" id="cur-info" style="margin-top:8px"></p>
          <div class="log" id="cur-log"></div>
        </div>`;
      document.getElementById('cancel-cur').onclick = () => cancelJob(running.id);
    }
    const detail = await api('GET', `/api/jobs/${running.id}?logFrom=${logState.from}`);
    document.getElementById('cur-bar').style.width = `${Math.round(detail.progress * 100)}%`;
    document.getElementById('cur-info').textContent =
      `${Math.round(detail.progress * 100)}% · ${detail.stage} · ${detail.options.formats.join(' + ')} · ${detail.options.tts} · running ${dur(detail.started)}`;
    appendLog(document.getElementById('cur-log'), detail.log);
    logState.from = detail.logTotal;
  });
}

function appendLog(el, lines) {
  if (!el || !lines.length) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent += (el.textContent ? '\n' : '') + lines.join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function renderJobsTable(jobs) {
  const el = document.getElementById('jobs');
  if (!el) return;
  if (!jobs.length) {
    el.innerHTML = `<div class="empty">No renders yet. Open an episode and press <b>Render</b>.</div>`;
    return;
  }
  el.innerHTML = `<table><thead><tr><th>#</th><th>Episode</th><th>Status</th><th class="hide-mobile">Output</th><th class="hide-mobile">Time</th><th></th></tr></thead><tbody>
    ${jobs.map((j) => `
      <tr class="clickable" data-id="${j.id}">
        <td class="muted">${j.id}</td>
        <td>${esc(j.slug)}<div class="small muted">${esc(j.options.formats.join(' + '))} · ${esc(j.options.tts)}</div></td>
        <td>${badge(j.status)}${j.status === 'running' ? ` <span class="small muted">${Math.round(j.progress * 100)}%</span>` : ''}</td>
        <td class="hide-mobile small">${j.outputs.map(esc).join('<br>') || (j.error ? `<span class="muted">${esc(j.error.split('\n')[0].slice(0, 80))}</span>` : '')}</td>
        <td class="hide-mobile small muted">${ago(j.created)}${j.started ? ` · ${dur(j.started, j.finished)}` : ''}</td>
        <td>${['queued', 'running'].includes(j.status) ? `<button class="small danger" data-cancel="${j.id}">Cancel</button>` : ''}</td>
      </tr>`).join('')}
  </tbody></table>`;
  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.dataset.cancel) return cancelJob(+e.target.dataset.cancel);
      location.hash = `#/jobs/${tr.dataset.id}`;
    };
  });
}

async function cancelJob(id) {
  if (!confirm('Cancel this render?')) return;
  await api('POST', `/api/jobs/${id}/cancel`);
  toast('Cancelling…');
}

async function jobView(id) {
  $app.innerHTML = `<div id="job"></div>`;
  let from = 0;
  let shell = false;
  cleanup = every(2000, async () => {
    const j = await api('GET', `/api/jobs/${id}?logFrom=${from}`);
    const el = document.getElementById('job');
    if (!el) return;
    if (!shell) {
      shell = true;
      el.innerHTML = `
        <div class="spread"><h1>Job ${j.id}: ${esc(j.slug)}</h1>
          <div class="row"><a class="btn" href="#/episodes/${encodeURIComponent(j.slug)}">Open episode</a>
          <button class="danger" id="jcancel">Cancel</button><button id="jdelete">Remove</button></div></div>
        <div class="panel">
          <p id="jinfo"></p>
          <div class="progress"><div id="jbar"></div></div>
          <div id="jout" style="margin-top:12px"></div>
        </div>
        <div class="panel"><h3>Log</h3><div class="log" id="jlog" style="max-height:60vh"></div></div>`;
      document.getElementById('jcancel').onclick = () => cancelJob(j.id);
      document.getElementById('jdelete').onclick = async () => {
        await api('DELETE', `/api/jobs/${j.id}`);
        location.hash = '#/';
      };
    }
    document.getElementById('jinfo').innerHTML =
      `${badge(j.status)} · ${esc(j.options.formats.join(' + '))} · voice: ${esc(j.options.tts)}${j.options.voice ? ` (${esc(j.options.voice)})` : ''} · ${ago(j.created)}${j.started ? ` · took ${dur(j.started, j.finished)}` : ''}`;
    document.getElementById('jbar').style.width = `${Math.round(j.progress * 100)}%`;
    const active = ['queued', 'running'].includes(j.status);
    document.getElementById('jcancel').classList.toggle('hidden', !active);
    document.getElementById('jdelete').classList.toggle('hidden', active);
    document.getElementById('jout').innerHTML =
      (j.error ? `<ul class="issues"><li class="problem">${esc(j.error)}</li></ul>` : '') +
      (j.outputs.length ? `<div class="row">${j.outputs.map((o) => `<a class="btn small" href="/media/out/${encodeURIComponent(o)}" target="_blank">${esc(o)}</a>`).join('')}<a class="btn small primary" href="#/videos">Open videos</a></div>` : '');
    appendLog(document.getElementById('jlog'), j.log);
    from = j.logTotal;
  });
}

// ---------- episodes ----------

async function episodesView() {
  const status = await api('GET', '/api/status');
  const list = await api('GET', '/api/episodes');
  $app.innerHTML = `
    <div class="spread"><h1>Episodes</h1>
      <div class="row">
        <button id="new-blank">+ Blank</button>
        <button class="primary" id="new-draft" ${status.claude ? '' : 'title="Set ANTHROPIC_API_KEY to enable"'}>✨ Draft with Claude</button>
      </div>
    </div>
    <div class="panel">${list.length ? `
      <table><thead><tr><th>Episode</th><th>Scenes</th><th class="hide-mobile">Words</th><th>Length</th><th class="hide-mobile">Edited</th><th></th></tr></thead><tbody>
      ${list.map((e) => `
        <tr class="clickable" data-slug="${esc(e.slug)}">
          <td><b>${esc(e.title)}</b><div class="small muted">${esc(e.slug)}</div></td>
          <td>${e.scenes}</td><td class="hide-mobile">${e.words}</td>
          <td>~${fmtSecs(e.estimatedSeconds)}</td>
          <td class="hide-mobile small muted">${ago(e.modified)}</td>
          <td><button class="small" data-dup="${esc(e.slug)}">Duplicate</button></td>
        </tr>`).join('')}
      </tbody></table>` : `<div class="empty">No episodes yet.</div>`}
    </div>
    <dialog id="draft-dlg">
      <h2>Draft an episode with Claude</h2>
      <p class="muted small">Claude writes the narration and map directions. You review and edit before rendering.</p>
      <label class="field"><span>Idea</span><input id="d-idea" placeholder="What if the Spanish Armada had won?"></label>
      <label class="field"><span>Length</span><select id="d-len"><option value="short">Short (65–80s, vertical)</option><option value="long">Long-form (8–10 min)</option></select></label>
      <label class="field"><span>Notes (optional)</span><textarea id="d-notes" rows="3" placeholder="Angle, facts to include, tone…"></textarea></label>
      <div class="row" style="justify-content:flex-end"><button id="d-cancel">Cancel</button><button class="primary" id="d-go">Draft</button></div>
    </dialog>`;

  $app.querySelectorAll('tr[data-slug]').forEach((tr) => {
    tr.onclick = async (e) => {
      if (e.target.dataset.dup) {
        const r = await api('POST', '/api/episodes', {title: `${tr.querySelector('b').textContent} (copy)`, duplicateOf: e.target.dataset.dup});
        location.hash = `#/episodes/${r.slug}`;
        return;
      }
      location.hash = `#/episodes/${encodeURIComponent(tr.dataset.slug)}`;
    };
  });
  document.getElementById('new-blank').onclick = async () => {
    const title = prompt('Episode title', 'What if …?');
    if (!title) return;
    const r = await api('POST', '/api/episodes', {title});
    location.hash = `#/episodes/${r.slug}`;
  };
  const dlg = document.getElementById('draft-dlg');
  document.getElementById('new-draft').onclick = () => {
    if (!status.claude) return toast('Set ANTHROPIC_API_KEY (see Settings) to draft with Claude', true);
    dlg.showModal();
  };
  document.getElementById('d-cancel').onclick = () => dlg.close();
  document.getElementById('d-go').onclick = async () => {
    const idea = document.getElementById('d-idea').value.trim();
    if (!idea) return;
    const btn = document.getElementById('d-go');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Drafting (up to a minute)…';
    try {
      const r = await api('POST', '/api/draft', {
        idea, length: document.getElementById('d-len').value, notes: document.getElementById('d-notes').value,
      });
      const saved = await api('POST', '/api/episodes', {title: r.episode.title || idea, episode: r.episode});
      dlg.close();
      toast(r.problems.length ? 'Drafted. Check the problems listed in the editor' : 'Drafted');
      location.hash = `#/episodes/${saved.slug}`;
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = 'Draft';
    }
  };
  if (location.hash.includes('new=1')) {
    history.replaceState(null, '', '#/episodes');
    document.getElementById(status.claude ? 'new-draft' : 'new-blank').click();
  }
}

async function editorView(slug) {
  const [data, voices, music, status] = await Promise.all([
    api('GET', `/api/episodes/${encodeURIComponent(slug)}`), api('GET', '/api/voices'),
    api('GET', '/api/music'), api('GET', '/api/status'),
  ]);
  let dirty = false;
  const saved = localStorage.getItem('renderPrefs');
  const prefs = Object.assign({formats: ['short'], tts: 'kokoro', voice: '', thumbnail: true}, saved ? JSON.parse(saved) : {});

  $app.innerHTML = `
    <div class="spread">
      <div><h1 id="ep-title">${esc(data.episode.title)}</h1><div class="small muted">${esc(slug)}.json</div></div>
      <div class="row">
        <button id="save">Save</button>
        <button id="meta">${status.claude ? '✨ ' : ''}Upload text</button>
        <button class="danger" id="del">Delete</button>
      </div>
    </div>
    <div class="panel">
      <div class="row">
        <label class="check"><input type="checkbox" id="f-short" ${prefs.formats.includes('short') ? 'checked' : ''}> Short (9:16)</label>
        <label class="check"><input type="checkbox" id="f-long" ${prefs.formats.includes('long') ? 'checked' : ''}> Long (16:9)</label>
        <label class="check"><input type="checkbox" id="f-thumb" ${prefs.thumbnail ? 'checked' : ''}> Thumbnail</label>
        <select id="tts">${voices.map((v) => `<option value="${v.provider}" ${v.available ? '' : 'disabled'} ${prefs.tts === v.provider ? 'selected' : ''}>${v.provider}${v.available ? '' : ' (' + esc(v.reason) + ')'}</option>`).join('')}<option value="none" ${prefs.tts === 'none' ? 'selected' : ''}>no voice (layout test)</option></select>
        <select id="voice"></select>
        <select id="music"><option value="">No music</option>${music.map((m) => `<option value="${esc(m.path)}" ${data.episode.music === m.path ? 'selected' : ''}>♪ ${esc(m.name)}</option>`).join('')}</select>
        <button class="primary" id="render">▶ Render</button>
      </div>
    </div>
    <div class="editor">
      <div class="panel">
        <div class="spread" style="margin-bottom:8px"><h3 style="margin:0">Script (JSON)</h3><span class="small muted">Ctrl+S saves · <a href="#/settings">countries list</a></span></div>
        <textarea id="json" spellcheck="false"></textarea>
        <ul class="issues" id="issues"></ul>
      </div>
      <div class="panel sticky">
        <div class="spread" style="margin-bottom:8px"><h3 style="margin:0">Scenes</h3>
          <label class="small check"><input type="checkbox" id="pv-long"> preview 16:9</label></div>
        <div id="scenes"></div>
      </div>
    </div>
    <dialog id="meta-dlg"><h2>Upload text</h2><div id="meta-body"></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button id="meta-close">Close</button></div></dialog>`;

  const ta = document.getElementById('json');
  ta.value = pretty(data.episode);

  // Voice dropdown follows the provider.
  const fillVoices = () => {
    const p = document.getElementById('tts').value;
    const v = voices.find((x) => x.provider === p);
    const sel = document.getElementById('voice');
    sel.innerHTML = v ? v.voices.map((n) => `<option ${n === (prefs.voice || v.default) ? 'selected' : ''}>${esc(n)}</option>`).join('') : '';
    sel.classList.toggle('hidden', !v);
  };
  document.getElementById('tts').onchange = () => { prefs.voice = ''; fillVoices(); };
  fillVoices();

  const parse = () => {
    try { return JSON.parse(ta.value); } catch (e) { return {error: e.message}; }
  };

  let previews = {};
  const renderScenes = (ep, timeline) => {
    const box = document.getElementById('scenes');
    const t = Object.fromEntries((timeline || []).map((x) => [x.id, x]));
    const total = (timeline || []).reduce((a, x) => a + x.seconds, 0);
    box.innerHTML = `<p class="small muted">${(ep.scenes || []).length} scenes · ~${fmtSecs(total)} (estimated from word count)</p>` +
      (ep.scenes || []).map((s, i) => `
        <div class="scene">
          <header><b>${i + 1}. ${esc(s.id)}</b>
            <span class="small muted">${t[s.id] ? `${fmtSecs(t[s.id].start)} · ${t[s.id].seconds}s` : ''}</span>
            <button class="small" data-preview="${esc(s.id)}">Preview</button></header>
          ${s.year ? `<span class="badge">${esc(s.year)}</span> ` : ''}${s.title ? `<span class="badge queued">${esc(s.title)}</span>` : ''}
          <div class="narr">${esc(s.narration)}</div>
          <div class="small muted">${(s.narration || '').split(/\s+/).filter(Boolean).length} words · zoom ${esc(s.camera?.zoom)} @ ${esc((s.camera?.center || []).join(', '))}
            ${(s.regions || []).length ? ` · ${(s.regions || []).length} region(s)` : ''}${(s.arrows || []).length ? ` · ${s.arrows.length} arrow(s)` : ''}</div>
          ${previews[s.id] ? `<img src="${previews[s.id]}" class="${document.getElementById('pv-long').checked ? '' : 'vertical'}">` : ''}
        </div>`).join('');
    box.querySelectorAll('[data-preview]').forEach((b) => {
      b.onclick = () => preview(b.dataset.preview, b);
    });
  };

  const preview = async (sceneId, btn) => {
    const ep = parse();
    if (ep.error) return toast('Fix the JSON first', true);
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await api('POST', '/api/preview', {episode: ep, sceneId, format: document.getElementById('pv-long').checked ? 'long' : 'short'});
      previews[sceneId] = r.url;
      validate();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = 'Preview';
    }
  };
  document.getElementById('pv-long').onchange = () => { previews = {}; validate(); };

  const validate = async () => {
    const ep = parse();
    const issues = document.getElementById('issues');
    if (ep.error) {
      issues.innerHTML = `<li class="problem">JSON: ${esc(ep.error)}</li>`;
      return null;
    }
    const r = await api('POST', '/api/validate', {episode: ep});
    issues.innerHTML =
      r.problems.map((p) => `<li class="problem">${esc(p)}</li>`).join('') +
      r.warnings.map((w) => `<li class="warning">${esc(w)}</li>`).join('') +
      (!r.problems.length && !r.warnings.length ? '<li class="ok">Script looks good</li>' : '');
    document.getElementById('ep-title').textContent = ep.title || slug;
    renderScenes(ep, r.timeline);
    return r;
  };

  let timer;
  ta.addEventListener('input', () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(validate, 600);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const {selectionStart: a, selectionEnd: b} = ta;
      ta.setRangeText('  ', a, b, 'end');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });

  const save = async () => {
    const ep = parse();
    if (ep.error) { toast('Can\'t save: the JSON is invalid', true); return false; }
    const music = document.getElementById('music').value;
    if (music) ep.music = music; else delete ep.music;
    ta.value = pretty(ep);
    await api('PUT', `/api/episodes/${encodeURIComponent(slug)}`, {episode: ep});
    dirty = false;
    toast('Saved');
    return true;
  };
  document.getElementById('save').onclick = save;
  document.getElementById('music').onchange = save;

  document.getElementById('render').onclick = async () => {
    const formats = [document.getElementById('f-short').checked && 'short', document.getElementById('f-long').checked && 'long'].filter(Boolean);
    if (!formats.length) return toast('Pick at least one format', true);
    if (!(await save())) return;
    const opts = {
      formats, tts: document.getElementById('tts').value,
      voice: document.getElementById('voice').value || null,
      thumbnail: document.getElementById('f-thumb').checked,
    };
    localStorage.setItem('renderPrefs', JSON.stringify(opts));
    try {
      const r = await api('POST', '/api/jobs', {slug, ...opts});
      toast(`Queued job ${r.id}`);
      location.hash = `#/jobs/${r.id}`;
    } catch (e) { toast(e.message, true); }
  };

  document.getElementById('del').onclick = async () => {
    if (!confirm(`Delete ${slug}? Rendered videos are kept.`)) return;
    await api('DELETE', `/api/episodes/${encodeURIComponent(slug)}`);
    location.hash = '#/episodes';
  };

  const metaDlg = document.getElementById('meta-dlg');
  document.getElementById('meta-close').onclick = () => metaDlg.close();
  document.getElementById('meta').onclick = async () => {
    if (dirty && !(await save())) return;
    const body = document.getElementById('meta-body');
    body.innerHTML = '<p><span class="spinner"></span> Writing titles, description and tags…</p>';
    metaDlg.showModal();
    try {
      body.innerHTML = metadataHtml(await api('POST', `/api/episodes/${encodeURIComponent(slug)}/metadata`));
      wireCopy(body);
    } catch (e) { body.innerHTML = `<ul class="issues"><li class="problem">${esc(e.message)}</li></ul>`; }
  };

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  cleanup = () => window.removeEventListener('beforeunload', beforeUnload);

  validate();
}

function metadataHtml(m) {
  const block = (label, text) => `<div class="field"><span>${esc(label)} <button class="small" data-copy>Copy</button></span><div class="meta-box">${esc(text)}</div></div>`;
  return [
    m.youtubeTitles ? block('YouTube title options', m.youtubeTitles.join('\n')) : block('YouTube title', m.youtubeTitle),
    block('YouTube description', m.youtubeDescription),
    block('Tags', (m.tags || []).join(', ')),
    block('TikTok caption', m.tiktokCaption),
    m.pinnedComment ? block('Pinned comment', m.pinnedComment) : '',
    `<p class="small muted">Generated by ${esc(m.generatedBy)}${m.generatedBy === 'template' ? ' (set ANTHROPIC_API_KEY for AI-written text)' : ''}</p>`,
  ].join('');
}

function wireCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      await navigator.clipboard.writeText(b.closest('.field').querySelector('.meta-box').textContent);
      toast('Copied');
    };
  });
}

// ---------- videos ----------

async function videosView() {
  const groups = await api('GET', '/api/videos');
  $app.innerHTML = `<div class="spread"><h1>Videos</h1><span class="muted small">Rendered files live in <code>out/</code> in your data folder</span></div>
    ${groups.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">${groups.map((g) => `
      <div class="card">
        <div class="spread" style="margin:0"><h3 style="margin:0">${esc(g.slug)}</h3><span class="small muted">${ago(g.modified)}</span></div>
        ${g.files.short ? `<video class="vertical" src="${g.files.short.url}" controls preload="metadata" playsinline></video>` : ''}
        ${g.files.long ? `<video src="${g.files.long.url}" controls preload="metadata" playsinline></video>` : ''}
        ${g.files.thumbnail ? `<img src="${g.files.thumbnail.url}" alt="thumbnail">` : ''}
        <div class="row">
          ${Object.entries(g.files).filter(([k]) => k !== 'metadata').map(([k, f]) => `<a class="btn small" href="${f.url}" download>⬇ ${esc(k)} <span class="muted">${f.sizeMb} MB</span></a>`).join('')}
        </div>
        <div class="row">
          <a class="btn small" href="#/episodes/${encodeURIComponent(g.slug)}">Edit episode</a>
          <button class="small" data-meta="${esc(g.slug)}">Upload text</button>
          <button class="small danger" data-del='${esc(JSON.stringify(Object.values(g.files).map((f) => f.name)))}'>Delete</button>
        </div>
        <div data-meta-box="${esc(g.slug)}"></div>
      </div>`).join('')}</div>` : `<div class="panel empty">Nothing rendered yet.</div>`}`;

  $app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete these files?')) return;
      for (const n of JSON.parse(b.dataset.del)) await api('DELETE', `/api/videos/${encodeURIComponent(n)}`);
      videosView();
    };
  });
  $app.querySelectorAll('[data-meta]').forEach((b) => {
    b.onclick = async () => {
      const box = $app.querySelector(`[data-meta-box="${CSS.escape(b.dataset.meta)}"]`);
      box.innerHTML = '<span class="spinner"></span>';
      try {
        let m;
        try { m = await api('GET', `/api/episodes/${encodeURIComponent(b.dataset.meta)}/metadata`); } catch { m = await api('POST', `/api/episodes/${encodeURIComponent(b.dataset.meta)}/metadata`); }
        box.innerHTML = metadataHtml(m);
        wireCopy(box);
      } catch (e) { box.innerHTML = `<span class="small muted">${esc(e.message)}</span>`; }
    };
  });
}

// ---------- voices ----------

async function voicesView() {
  const voices = await api('GET', '/api/voices');
  $app.innerHTML = `<h1>Voices</h1>
    <div class="panel">
      <p class="muted">Try voices before rendering. Kokoro is free, runs on this machine and is safe for monetised videos.</p>
      <div class="row" style="margin-bottom:10px">
        <select id="vp">${voices.map((v) => `<option value="${v.provider}" ${v.available ? '' : 'disabled'}>${v.provider}${v.available ? '' : ' (' + esc(v.reason) + ')'}</option>`).join('')}</select>
        <select id="vv"></select>
        <input id="vcustom" placeholder="or a custom voice id" style="flex:1;min-width:160px">
      </div>
      <label class="field"><span>Text</span><textarea id="vt" rows="3">In 476 AD, the last emperor of the Western Roman Empire was overthrown. But what if Rome had never fallen?</textarea></label>
      <div class="row"><button class="primary" id="vgo">▶ Generate</button><audio id="va" controls class="hidden"></audio></div>
    </div>
    <div class="panel small muted">
      <b>edge</b> is free but uses an unofficial Microsoft endpoint: check the terms before using it on a monetised channel.
      <b>elevenlabs</b> and <b>openai</b> are paid and need API keys (see Settings).
    </div>`;
  const fill = () => {
    const v = voices.find((x) => x.provider === document.getElementById('vp').value);
    document.getElementById('vv').innerHTML = v.voices.map((n) => `<option ${n === v.default ? 'selected' : ''}>${esc(n)}</option>`).join('');
  };
  document.getElementById('vp').onchange = fill;
  fill();
  document.getElementById('vgo').onclick = async () => {
    const btn = document.getElementById('vgo');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generating…';
    try {
      const r = await api('POST', '/api/voices/test', {
        provider: document.getElementById('vp').value,
        voice: document.getElementById('vcustom').value.trim() || document.getElementById('vv').value,
        text: document.getElementById('vt').value,
      });
      const a = document.getElementById('va');
      a.src = r.url;
      a.classList.remove('hidden');
      a.play().catch(() => {});
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    btn.textContent = '▶ Generate';
  };
}

// ---------- music ----------

async function musicView() {
  const tracks = await api('GET', '/api/music');
  $app.innerHTML = `<h1>Music</h1>
    <div class="panel">
      <p class="muted">Upload background tracks, then pick one in an episode's render bar. It plays quietly under the narration.
      Use music you have rights to, such as the YouTube Audio Library.</p>
      <div class="row"><input type="file" id="mf" accept=".mp3,.wav,.m4a,.ogg"><button class="primary" id="mup">Upload</button></div>
    </div>
    <div class="panel">${tracks.length ? `<table><tbody>${tracks.map((t) => `
      <tr><td>${esc(t.name)}<div class="small muted">${t.sizeMb} MB</div></td>
      <td><audio src="${t.url}" controls preload="none"></audio></td>
      <td><button class="small danger" data-del="${esc(t.name)}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No tracks yet.</div>'}
    </div>`;
  document.getElementById('mup').onclick = async () => {
    const f = document.getElementById('mf').files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try { await api('POST', '/api/music', fd); toast('Uploaded'); musicView(); } catch (e) { toast(e.message, true); }
  };
  $app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Delete ${b.dataset.del}?`)) return;
      await api('DELETE', `/api/music/${encodeURIComponent(b.dataset.del)}`);
      musicView();
    };
  });
}

// ---------- settings ----------

async function settingsView() {
  const [s, countries] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/countries')]);
  $app.innerHTML = `<h1>Settings</h1>
    <div class="panel">
      <h2>This server</h2>
      <table><tbody>
        <tr><td>Version</td><td>${esc(s.version)}</td></tr>
        <tr><td>Data folder</td><td><code>${esc(s.dataDir)}</code></td></tr>
        <tr><td>Disk</td><td>${s.diskFreeGb} GB free of ${s.diskTotalGb} GB</td></tr>
        <tr><td>Claude</td><td>${s.claude ? `On (${esc(s.claudeModel)})` : 'Off: set <code>ANTHROPIC_API_KEY</code>'}</td></tr>
        <tr><td>Render concurrency</td><td>${s.renderConcurrency ?? 'auto'} <span class="muted small">(<code>RENDER_CONCURRENCY</code>)</span></td></tr>
        <tr><td>Password</td><td>${s.passwordProtected ? 'On' : 'Off: set <code>APP_PASSWORD</code> before exposing this beyond your network'}</td></tr>
      </tbody></table>
    </div>
    <div class="panel">
      <h2>Configuration</h2>
      <p class="muted small">Set these as environment variables (in <code>docker-compose.yml</code> or a <code>.env</code> file), then restart.</p>
      <table><tbody>
        <tr><td><code>ANTHROPIC_API_KEY</code></td><td>Draft scripts and write upload text with Claude</td></tr>
        <tr><td><code>ANTHROPIC_MODEL</code></td><td>Defaults to <code>claude-sonnet-5-5</code></td></tr>
        <tr><td><code>ELEVENLABS_API_KEY</code>, <code>OPENAI_API_KEY</code></td><td>Paid voice providers (optional)</td></tr>
        <tr><td><code>APP_PASSWORD</code></td><td>Require a password for the web UI</td></tr>
        <tr><td><code>RENDER_CONCURRENCY</code></td><td>Browser tabs per render; try 2 on a NAS</td></tr>
      </tbody></table>
    </div>
    <div class="panel">
      <div class="spread"><h2 style="margin:0">Country names</h2><input id="cq" placeholder="Search…"></div>
      <p class="muted small">Regions use modern borders. Copy names exactly.</p>
      <div id="clist" class="small" style="columns:3 180px"></div>
    </div>`;
  const show = (q) => {
    document.getElementById('clist').innerHTML = countries
      .filter((c) => c.toLowerCase().includes(q.toLowerCase()))
      .map((c) => `<div>${esc(c)}</div>`).join('');
  };
  document.getElementById('cq').oninput = (e) => show(e.target.value);
  show('');
}

route();
updatePill();
