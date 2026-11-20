const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = h => h ? h.slice(0, 12) : '—';
const api = async (path, body) => {
  const r = await fetch('/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const toast = msg => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 2600); };

let protocols = [], current = null, draft = null, config = {};

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(id) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('main section').forEach(s => (s.hidden = s.id !== id));
  if (id === 'assign') renderAssign();
  if (id === 'run') renderRunPicker();
}

// ---------- engine badge ----------
async function loadConfig() {
  config = await api('/config');
  const el = $('#engine');
  el.className = 'engine ' + (config.akamai ? 'on' : 'off');
  el.textContent = config.akamai ? `Akamai Inference Cloud · ${config.model}` : 'Akamai Inference not configured — offline fallback';
}

// ---------- builder ----------
const TYPES = { text: 'Instruction', timer: 'Timer', question: 'Question', input: 'Required field' };
async function loadProtocols(selectId) {
  protocols = await api('/protocols');
  const id = selectId || current?.id || protocols[0]?.id;
  selectProtocol(protocols.find(p => p.id === id) || null);
}
function selectProtocol(p) {
  current = p;
  const latest = p?.versions[p.versions.length - 1];
  draft = p ? { title: latest.title, steps: structuredClone(latest.steps) } : { title: 'Untitled protocol', steps: [] };
  renderProtoList(); renderSteps(); renderHistory(); $('#saveMsg').textContent = '';
}
function renderProtoList() {
  $('#protoList').innerHTML = protocols.map(p => `<button data-id="${p.id}" class="${current?.id === p.id ? 'active' : ''}">${esc(p.title)}<br><small>v${p.versions.length} · ${short(p.versions.at(-1).hash)}</small></button>`).join('') || '<p class="muted">No protocols yet.</p>';
  $('#protoList').querySelectorAll('button').forEach(b => b.onclick = () => selectProtocol(protocols.find(p => p.id === b.dataset.id)));
}
function renderSteps() {
  $('#pTitle').value = draft.title;
  $('#steps').innerHTML = draft.steps.map((s, i) => `
    <div class="step" data-i="${i}">
      <div class="step-head">
        <strong>${i + 1}.</strong><span class="tag t-${s.type}">${TYPES[s.type]}</span>
        <label class="row muted" style="margin-left:auto;font-size:13px"><input type="checkbox" data-k="required" ${s.required ? 'checked' : ''}> required</label>
        <button class="icon" data-act="up" title="Move up">↑</button><button class="icon" data-act="down" title="Move down">↓</button><button class="icon" data-act="del" title="Delete">✕</button>
      </div>
      <input type="text" data-k="label" value="${esc(s.label)}" placeholder="${s.type === 'question' ? 'Question' : s.type === 'input' ? 'Field label' : 'Instruction'}">
      ${s.type === 'timer' ? `<div class="row" style="margin-top:8px"><span class="muted">Duration (seconds)</span><input type="number" min="1" data-k="seconds" value="${s.seconds || 60}" style="width:120px"></div>` : ''}
      ${s.type === 'question' ? `<div style="margin-top:8px"><input type="text" data-k="options" value="${esc((s.options || []).join(', '))}" placeholder="Options, comma-separated"></div>` : ''}
      ${s.type === 'input' ? `<div class="row" style="margin-top:8px"><span class="muted">Type</span><select data-k="inputType" style="width:140px"><option ${s.inputType === 'text' ? 'selected' : ''}>text</option><option ${s.inputType === 'number' ? 'selected' : ''}>number</option></select></div>` : ''}
    </div>`).join('') || '<p class="muted">Add components below.</p>';
}
$('#pTitle').oninput = e => (draft.title = e.target.value);
$('#steps').addEventListener('input', e => {
  const k = e.target.dataset.k; if (!k) return;
  const s = draft.steps[e.target.closest('.step').dataset.i];
  if (k === 'required') s.required = e.target.checked;
  else if (k === 'seconds') s.seconds = Number(e.target.value);
  else if (k === 'options') s.options = e.target.value.split(',').map(x => x.trim()).filter(Boolean);
  else s[k] = e.target.value;
});
$('#steps').addEventListener('click', e => {
  const act = e.target.dataset.act; if (!act) return;
  const i = Number(e.target.closest('.step').dataset.i), st = draft.steps;
  if (act === 'del') st.splice(i, 1);
  if (act === 'up' && i > 0) [st[i - 1], st[i]] = [st[i], st[i - 1]];
  if (act === 'down' && i < st.length - 1) [st[i + 1], st[i]] = [st[i], st[i + 1]];
  renderSteps();
});
document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
  const t = b.dataset.add;
  draft.steps.push({ type: t, label: '', required: t !== 'text', ...(t === 'timer' && { seconds: 60 }), ...(t === 'question' && { options: ['Yes', 'No'] }), ...(t === 'input' && { inputType: 'text' }) });
  renderSteps();
  $('#steps').lastElementChild.querySelector('input[data-k=label]').focus();
});
$('#newProto').onclick = () => { current = null; draft = { title: 'Untitled protocol', steps: [] }; renderProtoList(); renderSteps(); renderHistory(); $('#pTitle').select(); };
$('#saveVersion').onclick = async () => {
  try {
    const r = await api('/protocols', { id: current?.id, title: draft.title, steps: draft.steps, author: 'Scientist' });
    if (r.unchanged) return toast('No changes — content hash is identical to the latest version.');
    await loadProtocols(r.protocol.id);
    $('#saveMsg').innerHTML = `Saved v${r.protocol.versions.length} · <span class="hash">${short(r.version.hash)}</span>`;
  } catch (e) { toast(e.message); }
};
function renderHistory() {
  if (!current) return ($('#history').innerHTML = '<p class="muted">Not saved yet.</p>');
  $('#history').innerHTML = `<table><tr><th>Ver</th><th>Content hash (SHA-256)</th><th>Parent</th><th>Author</th><th>Created</th></tr>${
    current.versions.map((v, i) => `<tr><td>v${i + 1}</td><td><span class="hash" title="${v.hash}">${short(v.hash)}…</span></td><td><span class="hash">${short(v.parentHash)}</span></td><td>${esc(v.author)}</td><td>${new Date(v.createdAt).toLocaleString()}</td></tr>`).reverse().join('')}</table>`;
}

// ---------- assign ----------
async function renderAssign() {
  protocols = await api('/protocols');
  $('#aProto').innerHTML = protocols.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('');
  const fillVersions = () => {
    const p = protocols.find(x => x.id === $('#aProto').value);
    $('#aVersion').innerHTML = (p?.versions || []).map((v, i) => `<option value="${v.hash}">v${i + 1} · ${short(v.hash)}</option>`).reverse().join('');
  };
  $('#aProto').onchange = fillVersions; fillVersions();
  const list = await api('/assignments');
  $('#assignList').innerHTML = list.length ? `<table><tr><th>Assignee</th><th>Protocol</th><th>Pinned hash</th></tr>${list.map(a => `<tr><td>${esc(a.assignee)}</td><td>${esc(a.title)} <span class="muted">v${a.version}</span></td><td><span class="hash">${short(a.hash)}</span></td></tr>`).reverse().join('')}</table>` : '<p class="muted">No assignments yet.</p>';
}
$('#doAssign').onclick = async () => {
  try {
    const a = await api('/assignments', { protocolId: $('#aProto').value, hash: $('#aVersion').value, assignee: $('#aWho').value.trim() });
    toast(`Assigned to ${a.assignee}`); $('#aWho').value = ''; renderAssign();
  } catch (e) { toast(e.message); }
};

// ---------- run ----------
let runCtx = null, timers = [];
async function renderRunPicker() {
  const list = await api('/assignments');
  $('#rAssign').innerHTML = list.length ? list.map(a => `<option value="${a.id}">${esc(a.assignee)} — ${esc(a.title)} (v${a.version})</option>`).reverse().join('') : '<option value="">No assignments — create one in Assign</option>';
  loadRun();
}
$('#rAssign').onchange = loadRun;
$('#tamper').onchange = loadRun;
async function loadRun() {
  timers.forEach(t => clearInterval(t.h)); timers = [];
  $('#runResult').innerHTML = '';
  const id = $('#rAssign').value;
  if (!id) return ($('#runSteps').innerHTML = '');
  const { assignment, version } = await api('/assignment?id=' + id);
  const steps = structuredClone(version.steps);
  if ($('#tamper').checked) {
    // What a drifted local copy looks like: shorter spin, looser balance tolerance.
    const t = steps.find(s => s.type === 'timer'); if (t) t.seconds = Math.round(t.seconds / 2);
    const q = steps.find(s => /0\.1 g/.test(s.label)); if (q) q.label = q.label.replace('0.1 g', '0.5 g');
  }
  runCtx = { assignment, title: version.title, steps, answers: {}, stamps: {} };
  $('#runSteps').innerHTML = `<p class="muted">Pinned version <span class="hash">${short(assignment.hash)}</span>${$('#tamper').checked ? ' · <span class="bad-txt">running a modified local copy</span>' : ''}</p>` +
    steps.map((s, i) => `<div class="step" data-i="${i}"><div class="step-head"><strong>${i + 1}.</strong><span class="tag t-${s.type}">${TYPES[s.type]}</span>${s.required ? '<span class="muted" style="font-size:12px">required</span>' : ''}</div>
      <div style="margin-bottom:8px">${esc(s.label)}</div>${runInput(s, i)}</div>`).join('');
  steps.forEach((s, i) => s.type === 'timer' && timers.push({ i, left: s.seconds, h: null }));
}
function runInput(s, i) {
  if (s.type === 'text') return `<label class="row"><input type="checkbox" data-ans="${i}"> Done</label>`;
  if (s.type === 'input') return `<input type="${s.inputType === 'number' ? 'number' : 'text'}" data-ans="${i}">`;
  if (s.type === 'question') return `<div class="row">${(s.options || []).map(o => `<label class="row"><input type="radio" name="q${i}" value="${esc(o)}" data-ans="${i}"> ${esc(o)}</label>`).join('')}</div>`;
  if (s.type === 'timer') return `<div class="row"><span class="timer" id="tm${i}">${fmt(s.seconds)}</span><button class="btn" data-timer="${i}">Start</button><button class="btn" data-skip="${i}" title="Demo shortcut">Mark complete</button></div>`;
}
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const now = () => new Date().toTimeString().slice(0, 5);
$('#runSteps').addEventListener('input', e => {
  const i = e.target.dataset.ans; if (i == null) return;
  runCtx.answers[i] = e.target.type === 'checkbox' ? (e.target.checked ? 'done' : '') : e.target.value;
  runCtx.stamps[i] = now();
});
$('#runSteps').addEventListener('click', e => {
  const ti = e.target.dataset.timer, si = e.target.dataset.skip;
  if (ti != null) {
    const t = timers.find(x => x.i == ti);
    if (t.h) { clearInterval(t.h); t.h = null; e.target.textContent = 'Resume'; return; }
    e.target.textContent = 'Pause'; runCtx.stamps[ti + '_start'] = now();
    t.h = setInterval(() => { t.left--; $('#tm' + ti).textContent = fmt(t.left); if (t.left <= 0) { clearInterval(t.h); finishTimer(ti); } }, 1000);
  }
  if (si != null) { const t = timers.find(x => x.i == si); clearInterval(t.h); t.left = 0; $('#tm' + si).textContent = fmt(0); finishTimer(si); }
});
function finishTimer(i) { runCtx.answers[i] = 'completed'; runCtx.stamps[i] = now(); $(`[data-timer="${i}"]`).disabled = true; }

$('#submitRun').onclick = async () => {
  if (!runCtx) return;
  const btn = $('#submitRun'); btn.disabled = true; btn.textContent = 'Hashing and checking…';
  try {
    const answers = runCtx.steps.map((_, i) => runCtx.answers[i] || '');
    const run = await api('/runs', { assignmentId: runCtx.assignment.id, title: runCtx.title, steps: runCtx.steps, answers });
    renderRunResult(run, answers);
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = 'Submit run';
};
function renderRunResult(run, answers) {
  const I = run.integrity;
  let html = I.match
    ? `<div class="banner ok">✓ Protocol integrity verified — the executed protocol is byte-identical to the assigned version.</div>`
    : `<div class="banner bad">✕ Protocol mismatch — the operator ran a modified copy, not the assigned version.</div>`;
  html += `<div class="card"><table><tr><th>Assigned version hash</th><td><span class="hash">${I.approvedHash}</span></td></tr><tr><th>Executed protocol hash</th><td><span class="hash">${I.submittedHash}</span></td></tr></table></div>`;
  if (!I.match) {
    html += `<div class="card"><h2>What changed</h2><table class="diff"><tr><th>Step</th><th>Assigned</th><th>Executed</th></tr>${I.diff.map(d => `<tr><td>${d.step || 'title'}</td><td>${esc(JSON.stringify(d.approved))}</td><td class="bad-txt">${esc(JSON.stringify(d.submitted))}</td></tr>`).join('')}</table></div>`;
    const A = I.analysis || {};
    if (A.engine === 'akamai') {
      html += `<div class="proof"><b>Impact analysis · Akamai Inference Cloud</b>${proofMeta(A.meta)}
        <table style="margin-top:10px">${(A.changes || []).map(c => `<tr><td>Step ${c.step}</td><td>${esc(c.what_changed)}</td><td><span class="chip ${c.impact === 'high' ? 's-missed' : c.impact === 'medium' ? 's-unverifiable' : 's-verified'}">${esc(c.impact)}</span></td></tr>`).join('')}</table>
        <p style="margin:8px 0 0"><b>Verdict:</b> ${esc(A.verdict)}</p></div>`;
    } else html += `<div class="banner warn">Impact analysis unavailable: ${esc(A.error)}</div>`;
  }
  if (run.missingRequired.length) html += `<div class="banner warn">Required steps left blank: ${run.missingRequired.join(', ')}</div>`;
  html += `<div class="row"><button class="btn" id="toVerify">Check this run's log in LabStrata Verify →</button></div>`;
  $('#runResult').innerHTML = html;
  $('#toVerify').onclick = () => {
    const lines = [`Run log | Operator: ${run.operator} | ${new Date().toISOString().slice(0, 10)} | Protocol hash: ${short(I.submittedHash)}`];
    runCtx.steps.forEach((s, i) => { if (answers[i]) lines.push(`${runCtx.stamps[i] || ''} ${s.label}: ${answers[i]}`.trim()); });
    $('#vLog').value = lines.join('\n'); showTab('verify');
  };
}
function proofMeta(m) {
  if (!m) return '';
  return `<dl><dt>Provider</dt><dd>${esc(m.provider)}</dd><dt>Endpoint</dt><dd>${esc(m.endpoint)}</dd><dt>Model</dt><dd>${esc(m.model)}</dd><dt>Request ID</dt><dd>${esc(m.requestId || '—')}</dd><dt>Latency</dt><dd>${m.latencyMs} ms</dd>${m.usage ? `<dt>Tokens</dt><dd>${m.usage.prompt_tokens ?? '?'} in / ${m.usage.completion_tokens ?? '?'} out</dd>` : ''}</dl>`;
}

// ---------- verify ----------
async function loadDemo() {
  const d = await api('/demo');
  $('#vSop').value = d.sop;
  const names = Object.keys(d.logs);
  $('#logPicks').innerHTML = names.map((n, i) => `<button class="btn" data-log="${i}" style="padding:4px 10px;font-size:13px">${esc(n)}</button>`).join('');
  $('#logPicks').querySelectorAll('button').forEach(b => b.onclick = () => { $('#vLog').value = d.logs[names[b.dataset.log]]; $('#vResult').innerHTML = ''; });
  $('#vLog').value = d.logs[names[1]];
}
$('#doVerify').onclick = async () => {
  const btn = $('#doVerify'); btn.disabled = true; $('#vMsg').textContent = config.akamai ? `Sending SOP + log to ${config.model}…` : 'Running offline fallback…';
  try { renderVerify(await api('/verify', { sop: $('#vSop').value, log: $('#vLog').value })); }
  catch (e) { toast(e.message); }
  btn.disabled = false; $('#vMsg').textContent = '';
};
function renderVerify(r) {
  const F = r.findings, count = s => F.filter(f => f.status === s).length;
  const sopLines = $('#vSop').value.replace(/\r/g, '').split('\n').filter(l => l.trim());
  const logLines = $('#vLog').value.replace(/\r/g, '').split('\n').filter(l => l.trim());
  const sopStatus = {}, logStatus = {};
  F.forEach(f => { sopStatus[f.sop_line] = f.status; if (f.log_line) logStatus[f.log_line] = f.status; });
  const rank = { missed: 0, deviation: 1, unverifiable: 2 };
  const bad = F.filter(f => f.status !== 'verified').sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.sop_line - b.sop_line);
  let html = r.engine === 'akamai'
    ? `<div class="proof"><b>Powered by Akamai Inference Cloud</b> — this comparison was produced by the model below; citations were then checked against the source text by LabStrata.${proofMeta(r.meta)}</div>`
    : `<div class="banner warn"><b>Offline fallback, not Akamai.</b> ${esc(r.error || '')}</div>`;
  html += `<div class="banner ${count('missed') || count('deviation') ? 'bad' : count('unverifiable') ? 'warn' : 'ok'}">${
    count('missed') ? `✕ ${count('missed')} missed step${count('missed') > 1 ? 's' : ''}` : count('deviation') ? '✕ Deviation found' : count('unverifiable') ? 'No missed steps, but some items cannot be verified' : '✓ Every SOP requirement is evidenced in the log'}</div>`;
  html += `<div class="counts">${['verified', 'missed', 'deviation', 'unverifiable'].map(s => `<span class="chip s-${s}">${count(s)} ${s}</span>`).join('')}</div>`;
  if (r.summary) html += `<p class="muted" style="margin:0">${esc(r.summary)}</p>`;
  html += `<div class="card"><table><tr><th>SOP line</th><th>Requirement (verbatim)</th><th>Status</th><th>Log evidence</th><th>Why</th></tr>${
    [...bad, ...F.filter(f => f.status === 'verified')].map(f => `<tr class="clickable" data-s="${f.sop_line}" data-l="${f.log_line || ''}">
      <td><b>L${f.sop_line}</b></td><td>${esc(f.sop_text || f.sop_quote)}</td><td><span class="chip s-${esc(f.status)}">${esc(f.status)}</span></td>
      <td>${f.log_line ? `<b>L${f.log_line}</b> ${esc(f.log_text || f.log_quote)}` : '<span class="muted">none</span>'}</td>
      <td>${esc(f.reason)}${f.citation_ok ? '' : ' <span class="chip s-unverifiable" title="Quoted text did not match the cited line">citation unconfirmed</span>'}</td></tr>`).join('')}</table></div>`;
  html += `<div class="two"><div><h2>SOP</h2><div class="doc" id="docSop">${sopLines.map((l, i) => `<div class="l-${sopStatus[i + 1] || ''}" data-n="${i + 1}"><span>${i + 1}</span><span>${esc(l)}</span></div>`).join('')}</div></div>
    <div><h2>Run log</h2><div class="doc" id="docLog">${logLines.map((l, i) => `<div class="l-${logStatus[i + 1] || ''}" data-n="${i + 1}"><span>${i + 1}</span><span>${esc(l)}</span></div>`).join('')}</div></div></div>`;
  $('#vResult').innerHTML = html;
  $('#vResult').querySelectorAll('tr.clickable').forEach(tr => tr.onclick = () => {
    document.querySelectorAll('.doc .focus').forEach(x => x.classList.remove('focus'));
    const s = $(`#docSop [data-n="${tr.dataset.s}"]`); s?.classList.add('focus'); s?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (tr.dataset.l) $(`#docLog [data-n="${tr.dataset.l}"]`)?.classList.add('focus');
  });
}

loadConfig(); loadProtocols(); loadDemo();
