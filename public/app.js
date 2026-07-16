// hush — client. One thing on screen at a time; everything resolves from fog.

const stage = document.getElementById('stage');
const footer = document.getElementById('footer');
const enoughBtn = document.getElementById('enough');
const runhead = document.getElementById('runhead');
const wordmark = document.getElementById('wordmark');

const MIN_BREATH = 1600; // ms — a response never lands faster than one visible breath

const state = {
  session: null,
  busy: false,
  view: null,
  project: null, // { path, name }
  dirty: false,
  gist: null, // the running head — what chapter we're in
};

function setRunhead(text) {
  if (text) {
    runhead.textContent = text;
    runhead.classList.add('visible');
  } else {
    runhead.classList.remove('visible');
  }
}

function gistOf(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 64 ? t.slice(0, 63).trimEnd() + '…' : t;
}

// ---------------------------------------------------------------------------
// the cairn — open next-steps stack up like trail stones, quietly

const cairn = (() => {
  const el = document.createElement('button');
  el.id = 'cairn';
  el.type = 'button';
  document.body.appendChild(el);
  return el;
})();

function cairnSVG(n) {
  const count = Math.min(n, 7);
  const widths = [58, 50, 43, 36, 30, 24, 19].slice(0, count);
  const H = 15;
  const svgH = count * (H - 4) + 14;
  let cy = svgH - 9;
  const parts = widths.map((w, i) => {
    const dx = ((i * 37) % 7) - 3; // settled, not perfectly straight
    const o = (0.3 + ((i * 13) % 3) * 0.07).toFixed(2);
    const e = `<ellipse cx="${40 + dx}" cy="${cy}" rx="${w / 2}" ry="${H / 2}" style="opacity:${o}"/>`;
    cy -= H - 4;
    return e;
  });
  return `<svg width="80" height="${svgH}" viewBox="0 0 80 ${svgH}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${parts.join('')}</svg>`;
}

async function updateCairn() {
  if (state.pose) return; // pose mode stages its own cairn
  try {
    const d = await (await fetch('/api/stones')).json();
    const stones = d.stones || [];
    if (!stones.length || state.view !== 'home') {
      cairn.classList.remove('visible');
      return;
    }
    cairn.innerHTML = cairnSVG(stones.length);
    cairn.setAttribute(
      'aria-label',
      stones.length === 1 ? 'the cairn — one stone waiting' : `the cairn — ${stones.length} stones waiting`
    );
    cairn.title = cairn.getAttribute('aria-label');
    cairn.classList.add('visible');
  } catch {
    cairn.classList.remove('visible');
  }
}

cairn.addEventListener('click', () => cairnView());

// ---------------------------------------------------------------------------
// tiny helpers

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let current = null;
function show(node, { scroll = false } = {}) {
  cairn.classList.remove('visible'); // the cairn greets you only at home
  node.classList.add('scene', 'scene-in');
  if (scroll) node.classList.add('scroll');
  const old = current;
  current = node;
  if (old) {
    old.classList.add('scene-out');
    setTimeout(() => old.remove(), 600);
  }
  stage.appendChild(node);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => node.classList.remove('scene-in'))
  );
}

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || 'request failed');
  return d;
}

let pollTimer = null;
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// every request breathes: show the circle, never resolve faster than one breath.
// activity=true adds a single crossfading line of what the builder is doing.
async function breathe(promise, { activity = false } = {}) {
  state.view = 'breath';
  footer.classList.remove('visible');
  const scene = h(`
    <div>
      <div class="breath"></div>
      ${activity ? '<p class="activity"></p>' : ''}
    </div>`);
  show(scene);

  if (activity) {
    const line = scene.querySelector('.activity');
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch(`/api/progress?session=${state.session}`);
        const d = await r.json();
        if (d.progress && line.dataset.cur !== d.progress) {
          line.dataset.cur = d.progress;
          line.classList.remove('visible');
          setTimeout(() => {
            line.textContent = d.progress;
            line.classList.add('visible');
          }, 700);
        }
      } catch {}
    }, 2500);
  }

  const started = Date.now();
  try {
    const result = await promise;
    await sleep(Math.max(0, MIN_BREATH - (Date.now() - started)));
    return result;
  } finally {
    stopPolling();
  }
}

function autogrow(ta) {
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit); // element isn't attached yet when views build
}

function onEnter(ta, fn) {
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = ta.value.trim();
      if (v) fn(v);
    }
  });
}

function attachMic(row, ta) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const btn = h('<button class="mic" type="button" title="dictate" aria-label="dictate"></button>');
  let rec = null;
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          ta.value = (ta.value + ' ' + e.results[i][0].transcript).trim();
          ta.dispatchEvent(new Event('input'));
        }
      }
    };
    rec.onend = () => { rec = null; btn.classList.remove('rec'); ta.focus(); };
    rec.onerror = () => { rec = null; btn.classList.remove('rec'); };
    btn.classList.add('rec');
    rec.start();
  });
  row.appendChild(btn);
}

// ---------------------------------------------------------------------------
// minimal markdown (paragraphs, bold, italic, code, lists, small headers)

function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
}

function md(src) {
  const fences = [];
  src = String(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    fences.push(code);
    return `\ue000${fences.length - 1}\ue000`;
  });
  return src
    .split(/\n{2,}/)
    .map((b) => {
      b = b.trim();
      if (!b) return '';
      const fence = b.match(/^\ue000(\d+)\ue000$/);
      if (fence) return `<pre><code>${esc(fences[+fence[1]])}</code></pre>`;
      const head = b.match(/^(#{1,4})\s+(.*)$/);
      if (head) {
        const lvl = Math.min(head[1].length + 2, 5);
        return `<h${lvl}>${mdInline(head[2])}</h${lvl}>`;
      }
      if (/^>\s?/.test(b)) {
        return `<blockquote>${mdInline(b.replace(/^>\s?/gm, ''))}</blockquote>`;
      }
      // a block may mix a lead sentence with list items — segment it
      const segs = [];
      for (const l of b.split('\n')) {
        const item = /^\s*([-*]|\d+\.)\s+/.test(l);
        const last = segs[segs.length - 1];
        if (last && last.item === item) last.lines.push(l);
        else segs.push({ item, lines: [l] });
      }
      return segs
        .map((seg) => {
          if (!seg.item) return `<p>${mdInline(seg.lines.join('\n')).replace(/\n/g, '<br>')}</p>`;
          const ordered = /^\s*\d+\./.test(seg.lines[0]);
          const items = seg.lines
            .map((l) => `<li>${mdInline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`)
            .join('');
          return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
        })
        .join('');
    })
    .join('');
}

// ---------------------------------------------------------------------------
// views

function projectView(recents) {
  state.view = 'project';
  setRunhead(null);
  footer.classList.remove('visible');
  const scene = h(`
    <div>
      <p class="q">where are we building?</p>
      <div class="projects"></div>
      <div class="row">
        <textarea class="entry path-entry" rows="1" placeholder="/path/to/project"></textarea>
      </div>
      <button class="quiet" id="browse">or browse for a folder</button>
      <p class="hint">pick a recent project, type a path and press ⏎, or browse</p>
    </div>`);
  scene.querySelector('#browse').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const d = await api('/api/pickfolder', {});
      if (d.path) return setProject(d.path);
    } catch {}
    e.target.disabled = false;
  });
  const list = scene.querySelector('.projects');
  for (const r of recents || []) {
    const b = h(`
      <button class="project-btn">
        <span class="project-name">${esc(r.name)}</span>
        <span class="project-path">${esc(r.path)}</span>
      </button>`);
    b.addEventListener('click', () => setProject(r.path, r.name));
    list.appendChild(b);
  }
  const ta = scene.querySelector('textarea');
  autogrow(ta);
  onEnter(ta, (v) => setProject(v.replace(/^~(?=\/|$)/, ''), null, v));
  show(scene);
  setTimeout(() => ta.focus(), 1100);
}

function setProject(path, name, raw) {
  const p = raw && raw.startsWith('~') ? raw : path; // server can't expand ~; keep raw for message
  state.project = { path: raw || path, name: name || (path.split('/').filter(Boolean).pop() || path) };
  localStorage.setItem('hush-project', JSON.stringify(state.project));
  homeView();
}

function homeView() {
  state.view = 'home';
  state.session = null;
  state.gist = null;
  setRunhead(null);
  footer.classList.remove('visible');
  const scene = h(`
    <div>
      <textarea class="entry" rows="1" placeholder="what are we building?"></textarea>
      <p class="hint">press ⏎ to begin &nbsp;·&nbsp; shift ⏎ for a new line</p>
      <p class="hint project-line">in <span class="project-name">${esc(state.project?.name || '?')}</span>
        &nbsp;·&nbsp; <button class="quiet inline" id="switch">change</button></p>
    </div>`);
  const ta = scene.querySelector('textarea');
  autogrow(ta);
  onEnter(ta, start);
  const row = h('<div class="row"></div>');
  attachMic(row, ta);
  if (row.children.length) scene.insertBefore(row, scene.querySelector('.hint'));
  scene.querySelector('#switch').addEventListener('click', boot);
  show(scene);
  setTimeout(() => ta.focus(), 1100);

  updateCairn();

  // the shelf link appears only once there is something to reread
  fetch('/api/stories')
    .then((r) => r.json())
    .then((d) => {
      if (!d.stories?.length || state.view !== 'home') return;
      const line = scene.querySelector('.project-line');
      const link = h('<button class="quiet inline" id="shelf">shelf</button>');
      link.addEventListener('click', shelfView);
      line.append('  ·  ', link);
    })
    .catch(() => {});
}

function handleStep(step) {
  if (step.kind === 'ask_yesno') return yesNoView(step);
  if (step.kind === 'ready') return readyView(step);
  return openView(step);
}

function yesNoView(step) {
  state.view = 'yesno';
  const scene = h(`
    <div>
      <p class="q">${esc(step.question)}</p>
      <div class="row">
        <button class="btn" data-v="no">no <span class="key">n</span></button>
        <button class="btn" data-v="yes">yes <span class="key">y</span></button>
      </div>
      <button class="quiet" data-v="say">neither — let me explain</button>
    </div>`);
  scene.querySelectorAll('.btn').forEach((b) =>
    b.addEventListener('click', () => reply(b.dataset.v))
  );
  scene.querySelector('[data-v="say"]').addEventListener('click', () =>
    openView({ question: step.question, hint: 'in your own words' })
  );
  show(scene);
  footer.classList.add('visible');
}

function openView(step) {
  state.view = 'open';
  const scene = h(`
    <div>
      <p class="q">${esc(step.question)}</p>
      ${step.hint ? `<p class="hint">${esc(step.hint)}</p>` : ''}
      <div class="row">
        <textarea class="entry" rows="1" placeholder="speak or type"></textarea>
      </div>
      <p class="hint">⏎ when done</p>
    </div>`);
  const ta = scene.querySelector('textarea');
  autogrow(ta);
  onEnter(ta, reply);
  attachMic(scene.querySelector('.row'), ta);
  show(scene);
  footer.classList.add('visible');
  setTimeout(() => ta.focus(), 1100);
}

function readyView(step) {
  state.view = 'ready';
  footer.classList.remove('visible');
  const scene = h(`
    <div>
      <p class="label">here’s what I understood</p>
      <p class="summary">${esc(step.summary || '')}</p>
      ${step.coach ? `<p class="coach">${esc(step.coach)}</p>` : ''}
      ${step.refined_prompt ? `
        <details class="prompt-details">
          <summary>see the exact brief</summary>
          <pre>${esc(step.refined_prompt)}</pre>
        </details>` : ''}
      ${state.dirty ? '<p class="hint">your working tree has uncommitted changes — consider committing first</p>' : ''}
      <div class="row">
        <button class="btn" data-v="adjust">adjust</button>
        <button class="btn primary" data-v="go">build</button>
      </div>
    </div>`);
  scene.querySelector('[data-v="go"]').addEventListener('click', run);
  scene.querySelector('[data-v="adjust"]').addEventListener('click', adjustView);
  show(scene);
}

function adjustView() {
  state.view = 'open';
  const scene = h(`
    <div>
      <p class="q">what should change?</p>
      <div class="row">
        <textarea class="entry" rows="1" placeholder="speak or type"></textarea>
      </div>
      <p class="hint">⏎ when done</p>
    </div>`);
  const ta = scene.querySelector('textarea');
  autogrow(ta);
  onEnter(ta, reply);
  attachMic(scene.querySelector('.row'), ta);
  show(scene);
  setTimeout(() => ta.focus(), 1100);
}

function changesBlock(changes) {
  if (!changes || !changes.length) return '';
  const rows = changes
    .map((c) => {
      const sig = c.added
        ? '<span class="added">new</span>'
        : `<span class="added">+${c.add}</span> <span class="removed">−${c.del}</span>`;
      return `<div class="file-row"><code>${esc(c.file)}</code>${sig}</div>`;
    })
    .join('');
  return `
    <div class="changes">
      <span class="label-mini">what changed</span>
      <div class="filelist">${rows}</div>
    </div>`;
}

function answerView({ answer, changes, diff }) {
  state.view = 'answer';
  footer.classList.remove('visible');
  const scene = h(`
    <div>
      <article class="answer">${md(answer.text)}</article>
      ${changesBlock(changes)}
      ${diffBlock(diff)}
      ${answer.next ? `
        <div class="next">
          <span>next</span>
          <p>${esc(answer.next)}</p>
        </div>` : ''}
      <div class="row">
        <button class="quiet" data-v="follow">one more thing</button>
        <button class="quiet" data-v="done">done</button>
      </div>
    </div>`);
  scene.querySelector('[data-v="follow"]').addEventListener('click', followView);
  scene.querySelector('[data-v="done"]').addEventListener('click', done);
  show(scene, { scroll: true });
}

function followView() {
  state.view = 'open';
  const scene = h(`
    <div>
      <p class="q">what else?</p>
      <div class="row">
        <textarea class="entry" rows="1" placeholder="speak or type"></textarea>
      </div>
      <p class="hint">⏎ when done</p>
    </div>`);
  const ta = scene.querySelector('textarea');
  autogrow(ta);
  onEnter(ta, followUp);
  attachMic(scene.querySelector('.row'), ta);
  show(scene);
  setTimeout(() => ta.focus(), 1100);
}

function shelfView() {
  state.view = 'shelf';
  setRunhead(null);
  footer.classList.remove('visible');
  fetch('/api/stories')
    .then((r) => r.json())
    .then((d) => {
      const scene = h(`
        <div>
          <p class="label">the shelf</p>
          <div class="shelf"></div>
          <button class="quiet" data-v="back">back</button>
        </div>`);
      const list = scene.querySelector('.shelf');
      for (const s of d.stories || []) {
        const when = s.at
          ? new Date(s.at).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
          : '';
        const item = h(`
          <button class="shelf-item">
            <span class="shelf-title">${esc(s.title)}</span>
            <span class="shelf-meta">${esc(s.project || '')}${when ? ' · ' + esc(when) : ''}</span>
          </button>`);
        item.addEventListener('click', () => storyView(s.id));
        list.appendChild(item);
      }
      scene.querySelector('[data-v="back"]').addEventListener('click', homeView);
      show(scene, { scroll: (d.stories || []).length > 6 });
    })
    .catch(() => errorView('the shelf is unreachable'));
}

function storyView(id) {
  state.view = 'story';
  footer.classList.remove('visible');
  fetch(`/api/story?id=${encodeURIComponent(id)}`)
    .then((r) => r.json())
    .then((d) => {
      const s = d.story;
      if (!s) throw new Error('not found');
      setRunhead(gistOf(s.request));
      const when = s.startedAt
        ? new Date(s.startedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
        : '';
      const beats = (s.beats || [])
        .map((b) =>
          b.q
            ? `<p class="story-q">— ${esc(b.q)}</p><p class="story-a">${esc(b.a)}</p>`
            : `<p class="story-a aside">${esc(b.aside || b.a || '')}</p>`
        )
        .join('');
      const reports = (s.reports || [])
        .map(
          (r) => `
          <div class="story-report">
            ${r.prompt ? `<p class="story-a aside">${esc(r.prompt)}</p>` : ''}
            ${md(r.text || '')}
            ${changesBlock(r.changes)}
            ${diffBlock(r.diff)}
            ${r.next ? `<div class="next"><span>next</span><p>${esc(r.next)}</p></div>` : ''}
          </div>`
        )
        .join('');
      const scene = h(`
        <div>
          <article class="story">
            <p class="folio">${esc(s.projectName || '')}${when ? ' · ' + esc(when) : ''}</p>
            <h2 class="story-title">${esc(s.request || '')}</h2>
            ${beats}
            ${s.summary ? `<p class="story-sum">${esc(s.summary)}</p>` : ''}
            ${reports}
          </article>
          <div class="row">
            <button class="quiet" data-v="shelf">back to the shelf</button>
            <button class="quiet" data-v="home">home</button>
          </div>
        </div>`);
      scene.querySelector('[data-v="shelf"]').addEventListener('click', shelfView);
      scene.querySelector('[data-v="home"]').addEventListener('click', homeView);
      show(scene, { scroll: true });
    })
    .catch(() => errorView('that story could not be opened'));
}

function cairnView() {
  state.view = 'cairn';
  setRunhead(null);
  footer.classList.remove('visible');
  fetch('/api/stones')
    .then((r) => r.json())
    .then((d) => {
      const stones = d.stones || [];
      const scene = h(`
        <div>
          <p class="label">the cairn</p>
          <p class="hint">each stone is a next step, waiting quietly</p>
          <div class="stones"></div>
          <button class="quiet" data-v="back">back</button>
        </div>`);
      const list = scene.querySelector('.stones');
      if (!stones.length) {
        list.appendChild(h('<p class="summary">the trail is clear.</p>'));
      }
      for (const s of stones.slice().reverse()) {
        const row = h(`
          <div class="stone-row">
            <span class="stone-dot" aria-hidden="true"></span>
            <div class="stone-body">
              <span class="stone-title">${esc(s.title)}</span>
              <span class="stone-next">${esc(s.next)}</span>
            </div>
            <div class="stone-actions">
              <button class="quiet" data-v="open">open</button>
              <button class="quiet" data-v="done">set it down</button>
            </div>
          </div>`);
        row.querySelector('[data-v="open"]').addEventListener('click', () => storyView(s.id));
        row.querySelector('[data-v="done"]').addEventListener('click', async () => {
          try {
            await api('/api/stone', { id: s.id });
            row.classList.add('stone-set');
            setTimeout(() => {
              row.remove();
              if (!list.children.length) {
                list.appendChild(h('<p class="summary">the trail is clear.</p>'));
              }
            }, 900);
          } catch {}
        });
        list.appendChild(row);
      }
      scene.querySelector('[data-v="back"]').addEventListener('click', homeView);
      show(scene, { scroll: stones.length > 5 });
    })
    .catch(() => errorView('the cairn is unreachable'));
}

function diffBlock(diff) {
  if (!diff) return '';
  return `
    <details class="prompt-details diff-details">
      <summary>see the full diff</summary>
      <pre>${esc(diff)}</pre>
    </details>`;
}

function errorView(message, retry) {
  state.view = 'error';
  footer.classList.remove('visible');
  const scene = h(`
    <div>
      <p class="q">something went quiet in the wrong way</p>
      <p class="hint">${esc(message)}</p>
      <div class="row">
        ${retry ? '<button class="btn" data-v="retry">try again</button>' : ''}
        <button class="quiet" data-v="home">start over</button>
      </div>
    </div>`);
  if (retry) scene.querySelector('[data-v="retry"]').addEventListener('click', retry);
  scene.querySelector('[data-v="home"]').addEventListener('click', homeView);
  show(scene);
}

// ---------------------------------------------------------------------------
// actions

async function guarded(fn, retry) {
  if (state.busy) return;
  state.busy = true;
  try {
    await fn();
  } catch (e) {
    errorView(e.message, retry);
  } finally {
    state.busy = false;
  }
}

function start(prompt) {
  guarded(async () => {
    state.gist = gistOf(prompt);
    setRunhead(state.gist); // the running head stays with you for the whole chapter
    const d = await breathe(
      api('/api/start', { prompt, project: state.project?.path })
    );
    state.session = d.session;
    state.dirty = !!d.project?.dirty;
    if (d.project?.name) {
      state.project = { ...state.project, name: d.project.name };
      localStorage.setItem('hush-project', JSON.stringify(state.project));
    }
    handleStep(d.step);
  }, () => start(prompt));
}

function reply(text) {
  guarded(async () => {
    const d = await breathe(api('/api/reply', { session: state.session, text }));
    handleStep(d.step);
  }, () => reply(text));
}

function enough() {
  guarded(async () => {
    const d = await breathe(api('/api/reply', { session: state.session, enough: true }));
    handleStep(d.step);
  }, enough);
}

function run() {
  guarded(async () => {
    const d = await breathe(api('/api/run', { session: state.session }), { activity: true });
    answerView(d);
  }, run);
}

function followUp(text) {
  guarded(async () => {
    const d = await breathe(api('/api/followup', { session: state.session, text }), { activity: true });
    answerView(d);
  }, () => followUp(text));
}

function done() {
  setRunhead(null);
  const scene = h('<div></div>');
  show(scene);
  setTimeout(homeView, 1800);
}

async function boot() {
  let recents = [];
  try {
    const r = await fetch('/api/projects');
    recents = (await r.json()).recents || [];
  } catch {}
  const stored = localStorage.getItem('hush-project');
  if (state.view === null && stored) {
    // first load with a remembered project — go straight home
    try {
      state.project = JSON.parse(stored);
      return homeView();
    } catch {}
  }
  projectView(recents);
}

// ---------------------------------------------------------------------------
// wiring

function goHome() {
  if (state.busy || state.view === 'home' || state.view === 'project' || state.view === null) return;
  homeView();
}

enoughBtn.addEventListener('click', enough);
wordmark.addEventListener('click', goHome);

// ---------------------------------------------------------------------------
// pose mode — deterministic staged views for screenshots and previews
// (?pose=home|question|ready|story, optionally &theme=dark|light)

function pose(which) {
  state.pose = true;
  document.documentElement.classList.add('posed'); // still life: no fades, no breathing
  state.project = { path: '/Users/joe/Code/fried', name: 'fried' };
  const gist = 'add a csv importer that files bank exports into the ledger';
  if (which === 'question') {
    state.gist = gistOf(gist);
    setRunhead(state.gist);
    yesNoView({ question: 'Should the importer skip rows it cannot parse, rather than stopping?' });
  } else if (which === 'ready') {
    state.gist = gistOf(gist);
    setRunhead(state.gist);
    readyView({
      summary:
        'A new importer will read the bank’s CSV exports, match each row against the ledger’s account names, and file the entries into the right monthly sheet. Rows it cannot parse are collected and reported at the end rather than stopping the run.',
      coach:
        'Saying what should happen to the rows that fail — collect and report, not halt — is what turned this from a script into a tool.',
      refined_prompt: 'Build a CSV importer at src/import.js that reads exports/*.csv …',
    });
  } else if (which === 'story') {
    storyView('pose-story');
  } else {
    homeView();
    setTimeout(() => {
      cairn.innerHTML = cairnSVG(4);
      cairn.classList.add('visible');
      document.activeElement?.blur();
    }, 1300);
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    goHome();
    return;
  }
  if (state.view !== 'yesno' || state.busy) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return;
  if (e.key === 'y' || e.key === 'Y') reply('yes');
  if (e.key === 'n' || e.key === 'N') reply('no');
});

const params = new URLSearchParams(location.search);
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme');
if (params.get('pose')) pose(params.get('pose'));
else boot();
