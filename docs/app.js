'use strict';
// 时间记录：手机端
// 数据先存在手机里（IndexedDB）。填了云端密钥后会自动同步，AI 就能从云端读到。

// ---------- 默认值 ----------

const DEFAULT_CATEGORIES = [
  { area: '工作', items: ['日常工作', 'AI协作'] },
  { area: '生活', items: ['吃饭', '练功', '家务', '运动', '社交', '休息', '自我照顾', '学习'] },
];
const COLORS = ['#6ec6e0', '#2c3550', '#5bbfb0', '#5a7bb0', '#e9a77e', '#9aa3a8', '#dcbf5e', '#e07f86', '#dd9aa4', '#8e63b0'];
const DEFAULT_TASKS = [
  ['日常工作', '工作', '日常工作', 'up', 0, 6],
  ['AI协作', '工作', 'AI协作', 'down', 50, 4],
  ['站桩', '生活', '练功', 'down', 25, 0],
  ['八段锦', '生活', '练功', 'down', 15, 7],
  ['吃饭', '生活', '吃饭', 'up', 0, 8],
  ['家务', '生活', '家务', 'up', 0, 5],
  ['运动', '生活', '运动', 'up', 0, 2],
  ['社交', '生活', '社交', 'up', 0, 9],
  ['休息', '生活', '休息', 'up', 0, 3],
  ['自我照顾', '生活', '自我照顾', 'down', 25, 1],
  ['学习', '生活', '学习', 'down', 25, 0],
].map(([name, area, category, mode, minutes, c], i) => ({ id: 'default-' + i, name, area, category, mode, minutes, color: COLORS[c], order: i }));
const DEFAULT_SETTINGS = {
  breakMin: 5,          // 倒计时结束后休息几分钟，0 表示不休息
  forgotStopHours: 3,   // 正计时超过这么久提醒
  dayStartHour: 7,      // 补记空白时段时，只看这个时间之后
  gapMinMinutes: 15,    // 多长的空白才提示补记
};
const SYNC_KEYS = ['settings', 'categories', 'tasks', 'timer', 'abandons'];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const PIE_COLORS = ['#f28b9b', '#8fd0d0', '#b8e8ee', '#86b0b8', '#fcd8a8', '#b79ad6', '#9ec5f0', '#f6c26b', '#a8d8a0', '#d9b8c4'];

// ---------- 小工具 ----------

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function ymd(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hm(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function startOfDay(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function addDays(ts, n) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(m / 60);
  return h ? `${h}小时${m % 60 ? (m % 60) + '分' : ''}` : `${m}分钟`;
}
// 大数字 + 小单位，像番茄Todo那样：55小时13分钟
function bigDur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(m / 60);
  return h ? `${h}<small>小时</small>${m % 60}<small>分钟</small>` : `${m}<small>分钟</small>`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
function dayLabel(ts) {
  const today = startOfDay(Date.now());
  const d = startOfDay(ts);
  const dt = new Date(d);
  const base = `${dt.getMonth() + 1}月${dt.getDate()}日 周${WEEKDAYS[dt.getDay()]}`;
  if (d === today) return `今天 · ${base}`;
  if (d === addDays(today, -1)) return `昨天 · ${base}`;
  if (dt.getFullYear() !== new Date().getFullYear()) return `${dt.getFullYear()}年${base}`;
  return base;
}
function toInput(ts) { const d = new Date(ts); return `${ymd(ts)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fromInput(s) { const t = new Date(s).getTime(); return Number.isNaN(t) ? null : t; }
// 一条记录落在 [from, to) 里的时长（跨午夜的记录会分到两天）
function overlap(e, from, to) { return Math.max(0, Math.min(e.endTime, to) - Math.max(e.startTime, from)); }
// 记录的描述是「待办名」或「待办名：备注」
function taskNameOf(e) { return (e.description || '').split('：')[0] || '未命名'; }

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- 本地数据库 ----------

const idb = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no-idb'));
      const req = indexedDB.open('time-tracker', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('entries', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  all(store) { return this.run(store, 'readonly', (s) => s.getAll()); },
  put(store, v) { return this.run(store, 'readwrite', (s) => s.put(v)); },
  putMany(store, list) { return this.run(store, 'readwrite', (s) => { list.forEach((v) => s.put(v)); }); },
};

// ---------- 状态 ----------

const S = {
  entries: new Map(),
  settings: { value: DEFAULT_SETTINGS, updatedAt: 0 },
  categories: { value: DEFAULT_CATEGORIES, updatedAt: 0 },
  tasks: { value: DEFAULT_TASKS, updatedAt: 0 },
  timer: { value: null, updatedAt: 0 },
  abandons: { value: {}, updatedAt: 0 },  // { '2026-10-10': 次数, 'task:<id>': 次数 }
  brk: null,                                // 休息倒计时，只在本机
  conn: { server: '', token: '' },
  lastSync: 0,
  dirty: new Set(),
  kvDirty: new Set(),
  syncState: '',
  tab: 'todo',
  form: {},
  open: {},                                 // 待办集里展开了哪些组
  recordsDays: 14,
  recordsFilter: '',                        // 只看某个待办的记录
  stats: { mode: 'day', anchor: Date.now(), by: 'task', custom: null, month: Date.now(), year: Date.now(), filter: null },
  forgotDismissed: 0,
  notice: '',
  minimized: false,
};

const setting = (k) => (S.settings.value && S.settings.value[k] !== undefined ? S.settings.value[k] : DEFAULT_SETTINGS[k]);
const live = () => [...S.entries.values()].filter((e) => !e.deleted);
const timer = () => S.timer.value;
const tasks = () => (S.tasks.value || []).filter((t) => !t.deleted).sort((a, b) => a.order - b.order);
const cats = () => S.categories.value || DEFAULT_CATEGORIES;

function saveMeta(key, value) { return idb.put('meta', { key, value }); }

async function persistState() {
  await saveMeta('dirty', [...S.dirty]);
  await saveMeta('kvDirty', [...S.kvDirty]);
  await saveMeta('lastSync', S.lastSync);
}

async function setKv(key, value) {
  S[key] = { value, updatedAt: Math.max(Date.now(), S[key].updatedAt + 1) };
  S.kvDirty.add(key);
  await saveMeta(key, S[key]);
  await persistState();
  scheduleSync();
}

async function saveEntry(e) {
  const now = Date.now();
  const prev = S.entries.get(e.id);
  const entry = {
    id: e.id || uid(),
    startTime: e.startTime, endTime: e.endTime, durationMs: e.endTime - e.startTime,
    description: (e.description || '').trim(), area: e.category ? (e.area || '') : '', category: e.category || '',
    project: (e.project || '').trim(), source: e.source || (prev && prev.source) || 'manual',
    session: e.session || (prev && prev.session) || '', estimateMs: e.estimateMs ?? (prev && prev.estimateMs) ?? 0,
    createdAt: (prev && prev.createdAt) || now, updatedAt: Math.max(now, prev ? prev.updatedAt + 1 : 0),
    deleted: !!e.deleted,
  };
  S.entries.set(entry.id, entry);
  S.dirty.add(entry.id);
  await idb.put('entries', entry);
  await persistState();
  scheduleSync();
  return entry;
}

// ---------- 同步（没填密钥时不做） ----------

let syncing = false, syncTimer = null;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 800); }
function apiBase() { return (S.conn.server || location.origin).replace(/\/+$/, ''); }

async function sync() {
  if (!S.conn.token || syncing) return;
  if (!navigator.onLine) return setSyncState('离线中，联网后自动同步');
  syncing = true;
  try {
    const body = { since: S.lastSync, entries: [...S.dirty].map((id) => S.entries.get(id)).filter(Boolean) };
    for (const k of S.kvDirty) body[k] = S[k];
    const res = await fetch(apiBase() + '/api/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + S.conn.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error('密钥不对');
    if (!res.ok) throw new Error('云端出错（' + res.status + '）');
    const data = await res.json();

    for (const e of body.entries) {
      const cur = S.entries.get(e.id);
      if (cur && cur.updatedAt === e.updatedAt) S.dirty.delete(e.id);
    }
    for (const k of SYNC_KEYS) if (body[k] && S[k].updatedAt === body[k].updatedAt) S.kvDirty.delete(k);

    const changed = [];
    for (const e of data.entries) {
      const cur = S.entries.get(e.id);
      if (!cur || e.updatedAt > cur.updatedAt) { S.entries.set(e.id, e); changed.push(e); }
    }
    if (changed.length) await idb.putMany('entries', changed);
    let kvChanged = false;
    for (const k of SYNC_KEYS) {
      const r = data[k];
      if (r && r.updatedAt > S[k].updatedAt && !S.kvDirty.has(k)) { S[k] = r; await saveMeta(k, r); kvChanged = true; }
    }
    // 往前多退 5 分钟，防止手机和云端时钟不一致漏掉数据
    S.lastSync = Math.max(0, data.serverTime - 5 * MIN);
    await persistState();
    setSyncState(`已同步 ${hm(Date.now())}`);
    if (changed.length || kvChanged) render();
  } catch (err) {
    setSyncState(err.name === 'TypeError' ? '连不上云端，记录先存在手机里' : err.message);
  } finally {
    syncing = false;
  }
}

function setSyncState(s) {
  S.syncState = s;
  const el = $('#sync-state');
  if (el) el.textContent = s;
}

// ---------- 图标 ----------

const ICON = {
  clock: '<svg viewBox="0 0 24 24"><path d="M12 3a8 8 0 0 0-8 8c0 4.4 8 10 8 10s8-5.6 8-10a8 8 0 0 0-8-8z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v4l3 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>',
  pie: '<svg viewBox="0 0 24 24"><path d="M11 4a8 8 0 1 0 8 9h-8z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M14 3v7h7a7 7 0 0 0-7-7z" fill="currentColor"/></svg>',
  hist: '<svg viewBox="0 0 24 24"><path d="M5 5v14M9 7h10M9 12h10M9 17h7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.5" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.5" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M5 19h4l10-10-4-4L5 15z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

// ---------- 渲染 ----------

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab || (S.tab === 'records' && b.dataset.tab === 'stats')));
  document.body.dataset.tab = S.tab;
  const views = { todo: viewTodo, sets: viewSets, stats: viewStats, records: viewRecords, me: viewMe };
  $('#view').innerHTML = (views[S.tab] || viewTodo)();
  renderFocus();
  renderBanner();
}

function topBar() {
  return `<div class="topbar">
    <button class="round" data-act="add" aria-label="补记">${ICON.clock}</button>
    <button class="round" data-act="new-task" aria-label="新建待办">${ICON.plus}</button></div>`;
}

function taskEntries(task) { return live().filter((e) => taskNameOf(e) === task.name); }

function weekStart(ts = Date.now()) { const d = new Date(ts); return addDays(startOfDay(ts), -((d.getDay() + 6) % 7)); }

// 每周目标（习惯）：本周做了几次 / 几小时。暂停分成的几段算同一次
function goalProgress(t) {
  if (!t.goal || !(t.goal.value > 0)) return null;
  const from = weekStart(), to = addDays(from, 7);
  const list = taskEntries(t).filter((e) => overlap(e, from, to) > 0);
  const times = t.goal.type === 'times';
  const done = times ? new Set(list.map((e) => e.session || e.id)).size : sumIn(list, from, to) / HOUR;
  const shown = times ? done : Math.round(done * 10) / 10;
  return { done, shown, value: t.goal.value, unit: times ? '次' : '小时', frac: Math.min(1, done / t.goal.value) };
}

function goalLine(t) {
  const g = goalProgress(t);
  if (!g) return '';
  return `<div class="goal"><div class="goal-bar"><i style="width:${g.frac * 100}%"></i></div>
    <span>本周 ${g.shown}/${g.value} ${g.unit}${g.frac >= 1 ? ' ✓' : ''}</span></div>`;
}

function taskCard(t, withMore) {
  const from = startOfDay(Date.now());
  const n = taskEntries(t).filter((e) => e.startTime >= from).length;
  return `<div class="task" style="--c:${esc(t.color)}" data-act="start" data-id="${esc(t.id)}">
    <div class="task-main"><div class="task-name">${esc(t.name)}</div><div class="task-sub">${t.mode === 'down' ? `${t.minutes} 分钟` : '正计时'}</div>${goalLine(t)}</div>
    <div class="task-go"><span>开始</span>${n ? `<small>今日已专注 ${n} 次</small>` : ''}</div>
    ${withMore ? `<button class="task-more" data-act="task-menu" data-id="${esc(t.id)}" aria-label="更多">${ICON.more}</button>` : ''}
  </div>`;
}

function viewTodo() {
  const list = tasks();
  return `${topBar()}
    <div class="cards">${list.map((t) => taskCard(t, false)).join('') || '<p class="muted center">还没有待办，点右上角 ＋ 新建一个。</p>'}</div>
    <p class="muted center hint">点卡片开始计时，长按卡片看它的统计和设置。</p>
    ${syncLine()}`;
}

function viewSets() {
  const list = tasks();
  const groups = [];
  for (const c of cats()) for (const it of c.items) groups.push({ key: `${c.area}/${it}`, area: c.area, category: it });
  const known = new Set(groups.map((g) => g.key));
  if (list.some((t) => !known.has(`${t.area}/${t.category}`))) groups.push({ key: '其他', area: '', category: '' });
  return `${topBar()}
    <div class="sets">${groups.map((g) => {
      const inGroup = list.filter((t) => (g.key === '其他' ? !known.has(`${t.area}/${t.category}`) : t.area === g.area && t.category === g.category));
      const open = S.open[g.key];
      return `<div class="set" style="--bar:${areaColor(g.area)}">
        <div class="set-row">
          <button class="set-name" data-act="toggle-set" data-k="${esc(g.key)}">${esc(g.category || '其他')}<span class="muted"> ${inGroup.length || ''}</span></button>
          <button class="ic" data-act="toggle-set" data-k="${esc(g.key)}" aria-label="展开">${open ? ICON.down : ICON.chev}</button>
          <button class="ic" data-act="set-stats" data-area="${esc(g.area)}" data-cat="${esc(g.category)}" aria-label="统计">${ICON.pie}</button>
          <button class="ic" data-act="new-task" data-area="${esc(g.area)}" data-cat="${esc(g.category)}" aria-label="新建">${ICON.plus}</button>
        </div>
        ${open ? `<div class="cards inset">${inGroup.map((t) => taskCard(t, true)).join('') || '<p class="muted">这组还没有待办，点右边 ＋ 新建</p>'}</div>` : ''}
      </div>`;
    }).join('')}</div>
    <p class="muted center hint">待办集的名字在「我的」里改。</p>`;
}

function syncLine() {
  if (!S.conn.token) return '<div class="sync">试用版：记录只存在这台手机里。</div>';
  return `<div class="sync" id="sync-state">${esc(S.syncState || '准备同步…')}</div>`;
}

// ---------- 计时全屏 ----------

function remainingMs(t) {
  if (t.mode !== 'down') return 0;
  return t.paused ? t.remaining : Math.max(0, t.endsAt - Date.now());
}
function timerText(t) { return t.mode === 'down' ? fmtClock(remainingMs(t)) : fmtClock(Date.now() - t.startTime); }
function focusSub(t) {
  if (t.mode === 'down') return `${t.paused ? '已暂停' : '专注中'} · ${hm(t.startTime)} 开始`;
  if (!t.estimateMin) return `正计时 · ${hm(t.startTime)} 开始`;
  const left = t.startTime + t.estimateMin * MIN - Date.now();
  return `预估 ${fmtDur(t.estimateMin * MIN)} · ${left >= 0 ? `还剩 ${fmtDur(left)}` : `已超出 ${fmtDur(-left)}`}`;
}

function renderFocus() {
  const f = $('#focus');
  const t = timer();
  const b = S.brk;
  if (!t && !b) { f.hidden = true; f.innerHTML = ''; return; }
  if (!t) {
    f.style.setProperty('--c', '#5bbfb0');
    f.innerHTML = `<div class="focus-in">
      <div class="focus-center">
        <div class="focus-name">休息一下</div>
        <div class="focus-clock" id="focus-clock">${fmtClock(Math.max(0, b.endsAt - Date.now()))}</div>
        <div class="focus-sub">站起来走走，喝口水</div>
      </div>
      <div class="focus-bar"><button class="fbtn" data-act="skip-break">${ICON.stop}<span>跳过休息</span></button></div></div>`;
    f.hidden = false;
    return;
  }
  const isDown = t.mode === 'down';
  f.style.setProperty('--c', t.color || '#8e63b0');
  f.innerHTML = `<div class="focus-in">
    <div class="focus-top"><button class="ftop" data-act="minimize" aria-label="收起">${ICON.down}</button></div>
    <div class="focus-center">
      <div class="focus-name">${esc(t.name)}</div>
      <div class="focus-clock" id="focus-clock">${timerText(t)}</div>
      <div class="focus-sub" id="focus-sub">${focusSub(t)}</div>
      ${!isDown && !t.estimateMin ? `<div class="est-pick"><span>预估要多久？</span>${[15, 30, 45, 60, 90, 120].map((m) => `<button class="est-chip" data-act="set-estimate" data-v="${m}">${m < 60 ? m + '分' : m / 60 + '小时'}</button>`).join('')}</div>` : ''}
    </div>
    <div class="focus-extra" id="focus-extra" ${S.showExtra ? '' : 'hidden'}>
      <input data-bind="focus.note" placeholder="备注（可不填）" value="${esc(t.note || '')}">
      <input data-bind="focus.project" placeholder="项目标签（可不填）" list="projects-focus" value="${esc(t.project || '')}">
      <datalist id="projects-focus">${projectOptions()}</datalist>
    </div>
    <div class="focus-bar">
      <button class="fbtn" data-act="toggle-extra">${ICON.note}<span>备注</span></button>
      ${isDown ? `<button class="fbtn" data-act="pause">${t.paused ? ICON.play : ICON.pause}<span>${t.paused ? '继续' : '暂停'}</span></button>` : ''}
      <button class="fbtn" data-act="finish">${ICON.stop}<span>${isDown ? '提前完成' : '完成'}</span></button>
      <button class="fbtn" data-act="abandon">${ICON.x}<span>放弃</span></button>
    </div></div>`;
  f.hidden = S.minimized;
}

function projectOptions() {
  return [...new Set(live().map((e) => e.project).filter(Boolean))].slice(0, 30).map((p) => `<option value="${esc(p)}">`).join('');
}

function renderBanner() {
  const b = $('#banner');
  const t = timer();
  const notes = [];
  if (/MicroMessenger/i.test(navigator.userAgent)) notes.push('<span>请点右上角「…」，选「在浏览器打开」，用 Safari 打开才能正常使用。</span>');
  if (S.notice) notes.push(`<span>${esc(S.notice)}</span><button class="btn small" data-act="dismiss-notice">知道了</button>`);
  if (t && S.minimized) notes.push(`<span>正在：${esc(t.name)} <b id="mini-clock">${timerText(t)}</b></span><button class="btn small" data-act="maximize">打开</button>`);
  if (t && t.mode !== 'down' && Date.now() - t.startTime > setting('forgotStopHours') * HOUR && S.forgotDismissed !== t.startTime) {
    notes.push(`<span>「${esc(t.name)}」已经计时 ${fmtDur(Date.now() - t.startTime)}，是不是忘了停？</span>
      <button class="btn small" data-act="forgot-keep">还在做</button><button class="btn small" data-act="forgot-fix">改结束时间</button>`);
  }
  b.innerHTML = notes.join('');
  b.hidden = !notes.length;
}

// ---------- 记录列表 ----------

function areaColor(area) {
  if (area === '工作') return 'var(--work)';
  if (area === '生活') return 'var(--life)';
  return 'var(--other)';
}

function entryRow(e) {
  return `<button class="entry" data-act="edit" data-id="${esc(e.id)}">
    <span class="dot" style="background:${areaColor(e.area)}"></span>
    <span class="main">
      <span class="desc">${esc(e.description || '（没写描述）')}</span>${e.project ? `<span class="tag">#${esc(e.project)}</span>` : ''}
      <span class="meta">${hm(e.startTime)}–${hm(e.endTime)}${startOfDay(e.endTime - 1) > startOfDay(e.startTime) ? '（次日）' : ''} · ${esc([e.area, e.category].filter(Boolean).join(' / ') || '未分类')}</span>
    </span>
    <span class="dur">${fmtDur(e.durationMs)}</span>
  </button>`;
}

// 一天里没有记录的时段
function gapsForDay(dayTs, entries) {
  const from = dayTs + setting('dayStartHour') * HOUR;
  let end = Math.min(addDays(dayTs, 1), Date.now());
  const t = timer();
  if (t && !t.paused && (t.segStart || t.startTime) < end) end = Math.max(from, Math.min(end, t.segStart || t.startTime));
  const minGap = setting('gapMinMinutes') * MIN;
  const sorted = entries.slice().sort((a, b) => a.startTime - b.startTime);
  const gaps = [];
  let cursor = from;
  for (const e of sorted) {
    if (e.startTime - cursor >= minGap && cursor < end) gaps.push({ start: cursor, end: Math.min(e.startTime, end), before: e.id });
    cursor = Math.max(cursor, e.endTime);
  }
  if (end - cursor >= minGap) gaps.push({ start: cursor, end, before: null });
  return gaps;
}

function gapRow(g) {
  return `<button class="gap" data-act="fill-gap" data-s="${g.start}" data-e="${g.end}">
    <span>未记录 ${hm(g.start)}–${hm(g.end)}（${fmtDur(g.end - g.start)}）</span><span>补记 ›</span></button>`;
}

function taskColorOf(e) {
  const t = tasks().find((x) => x.name === taskNameOf(e));
  return t ? t.color : (e.area === '工作' ? '#9b7fd0' : e.area === '生活' ? '#f3a6b8' : '#b9b3bf');
}

// 一天的时间线：像日历一样，看出哪段做了什么、哪里空着
function timelineView(day) {
  const dayEnd = addDays(day, 1);
  const list = live().filter((e) => overlap(e, day, dayEnd) > 0).sort((a, b) => a.startTime - b.startTime);
  const t = timer();
  const firstHour = Math.min(setting('dayStartHour'), ...list.map((e) => (e.startTime < day ? 0 : new Date(e.startTime).getHours())));
  const PX = 64; // 每小时的高度
  const top0 = day + firstHour * HOUR;
  const y = (ts) => ((Math.max(ts, top0) - top0) / HOUR) * PX;
  const hours = [];
  for (let h = firstHour; h <= 24; h++) hours.push(`<div class="tl-hour" style="top:${(h - firstHour) * PX}px"><span>${pad(h)}:00</span></div>`);
  const blocks = list.map((e) => {
    const s = Math.max(e.startTime, top0), en = Math.min(e.endTime, dayEnd);
    if (en <= s) return '';
    const h = Math.max(22, y(en) - y(s));
    return `<button class="tl-block" data-act="edit" data-id="${esc(e.id)}" style="top:${y(s)}px;height:${h}px;--c:${esc(taskColorOf(e))}">
      <b>${esc(e.description)}</b>${h >= 38 ? `<small>${hm(e.startTime)}–${hm(e.endTime)} · ${fmtDur(e.durationMs)}</small>` : ''}</button>`;
  }).join('');
  const gaps = gapsForDay(day, list).map((g) => `<button class="tl-gap" data-act="fill-gap" data-s="${g.start}" data-e="${g.end}" style="top:${y(g.start)}px;height:${Math.max(22, y(g.end) - y(g.start))}px">
      <span>未记录 ${hm(g.start)}–${hm(g.end)} · 补记</span></button>`).join('');
  const now = Date.now();
  const running = t && !t.paused && (t.segStart || t.startTime) < dayEnd && now >= day
    ? `<div class="tl-block running" style="top:${y(t.segStart || t.startTime)}px;height:${Math.max(22, y(now) - y(t.segStart || t.startTime))}px;--c:${esc(t.color || '#9466b4')}"><b>${esc(t.name)}（进行中）</b></div>` : '';
  const nowLine = now >= day && now < dayEnd ? `<div class="tl-now" style="top:${y(now)}px"></div>` : '';
  const total = list.reduce((s, e) => s + overlap(e, day, dayEnd), 0);
  const isToday = day === startOfDay(now);
  return `
    <div class="period-nav"><button class="ic" data-act="tl-prev" aria-label="前一天">${ICON.left}</button>
      <span><b>${dayLabel(day)}</b><span class="muted"> · ${fmtDur(total)}</span></span>
      <button class="ic" data-act="tl-next" aria-label="后一天" ${isToday ? 'disabled' : ''}>${ICON.chev}</button></div>
    <div class="timeline" style="height:${(24 - firstHour) * PX + 12}px">${hours.join('')}${gaps}${blocks}${running}${nowLine}</div>`;
}

function viewRecords() {
  const filter = S.recordsFilter;
  if (!filter && S.recordsMode !== 'list') {
    const day = S.tlDay || startOfDay(Date.now());
    return `
      <div class="topbar left"><button class="round" data-act="go" data-v="stats" aria-label="返回">${ICON.left}</button>
        <span class="topbar-title">专注记录</span>
        <button class="round" data-act="add" aria-label="补记">${ICON.plus}</button></div>
      <div class="panel">
        <div class="seg">${[['timeline', '时间线'], ['list', '列表']].map(([k, l]) => `<button class="${(S.recordsMode || 'timeline') === k ? 'on' : ''}" data-act="records-mode" data-v="${k}">${l}</button>`).join('')}</div>
        ${timelineView(day)}
      </div>
      ${syncLine()}`;
  }
  const all = live().filter((e) => !filter || taskNameOf(e) === filter);
  const today = startOfDay(Date.now());
  const oldest = addDays(today, -(S.recordsDays - 1));
  const byDay = new Map(filter ? [] : [[today, []]]);
  for (const e of all) {
    for (let d = startOfDay(e.startTime); d < e.endTime; d = addDays(d, 1)) {
      if (d < oldest || d > today) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(e);
    }
  }
  const days = [...byDay.keys()].sort((a, b) => b - a);
  const html = days.map((d) => {
    const list = byDay.get(d).sort((a, b) => a.startTime - b.startTime);
    const total = list.reduce((s, e) => s + overlap(e, d, addDays(d, 1)), 0);
    const gaps = filter ? [] : gapsForDay(d, list);
    const rows = [];
    for (const e of list) {
      for (const g of gaps.filter((x) => x.before === e.id)) rows.push(gapRow(g));
      rows.push(entryRow(e));
    }
    for (const g of gaps.filter((x) => x.before === null)) rows.push(gapRow(g));
    return `<div class="day-head"><span>${dayLabel(d)}</span><span class="muted">${fmtDur(total)}</span></div>${rows.join('') || '<p class="muted">还没有记录</p>'}`;
  }).join('') || '<p class="muted center" style="padding:40px 0">还没有记录</p>';
  const hasOlder = all.some((e) => e.startTime < oldest);
  return `
    <div class="topbar left"><button class="round" data-act="go" data-v="${filter ? 'todo' : 'stats'}" aria-label="返回">${ICON.left}</button>
      <span class="topbar-title">${filter ? esc(filter) + ' · ' : ''}专注记录</span>
      <button class="round" data-act="add" aria-label="补记">${ICON.plus}</button></div>
    <div class="panel">${filter ? '' : `<div class="seg">${[['timeline', '时间线'], ['list', '列表']].map(([k, l]) => `<button class="${S.recordsMode === k ? 'on' : ''}" data-act="records-mode" data-v="${k}">${l}</button>`).join('')}</div>`}${html}
    ${hasOlder ? '<button class="btn block" data-act="more" style="margin-top:12px">再看更早的</button>' : ''}</div>
    ${syncLine()}`;
}

// ---------- 统计 ----------

function periodOf(mode, anchor, custom) {
  const d = new Date(anchor);
  if (mode === 'custom' && custom) return { from: custom.from, to: custom.to, title: `${ymd(custom.from)} 至 ${ymd(custom.to - 1)}` };
  if (mode === 'week') {
    const s = addDays(startOfDay(anchor), -((d.getDay() + 6) % 7));
    return { from: s, to: addDays(s, 7), title: `${ymd(s)} 起一周` };
  }
  if (mode === 'month') return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(), title: `${d.getFullYear()}-${pad(d.getMonth() + 1)}` };
  if (mode === 'year') return { from: new Date(d.getFullYear(), 0, 1).getTime(), to: new Date(d.getFullYear() + 1, 0, 1).getTime(), title: `${d.getFullYear()}` };
  const s = startOfDay(anchor);
  return { from: s, to: addDays(s, 1), title: ymd(s) };
}

function shiftAnchor(mode, anchor, dir) {
  const d = new Date(anchor);
  if (mode === 'week') return addDays(anchor, 7 * dir);
  if (mode === 'month') return new Date(d.getFullYear(), d.getMonth() + dir, 1).getTime();
  if (mode === 'year') return new Date(d.getFullYear() + dir, 0, 1).getTime();
  return addDays(anchor, dir);
}

function sumIn(entries, from, to) { return entries.reduce((s, e) => s + overlap(e, from, to), 0); }

function groupSum(entries, from, to, keyFn) {
  const m = new Map();
  for (const e of entries) {
    const ms = overlap(e, from, to);
    if (!ms) continue;
    const k = keyFn(e);
    m.set(k, (m.get(k) || 0) + ms);
  }
  return [...m.entries()].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
}

function pie(groups, total) {
  if (!total) return '<p class="muted center" style="padding:40px 0">这段时间还没有记录</p>';
  const R = 82, cx = 110, cy = 96;
  let a = -Math.PI / 2;
  const slices = groups.map((g, i) => {
    const frac = g.ms / total;
    const a2 = a + frac * Math.PI * 2;
    const large = a2 - a > Math.PI ? 1 : 0;
    const color = PIE_COLORS[i % PIE_COLORS.length];
    const path = frac >= 0.9999
      ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color}"/>`
      : `<path d="M${cx},${cy} L${cx + R * Math.cos(a)},${cy + R * Math.sin(a)} A${R},${R} 0 ${large} 1 ${cx + R * Math.cos(a2)},${cy + R * Math.sin(a2)} Z" fill="${color}"/>`;
    a = a2;
    return path;
  }).join('');
  return `<svg class="chart pie" viewBox="0 0 220 192" role="img" aria-label="时长分布">${slices}</svg>`;
}

function legend(groups, total) {
  return `<div class="legend2">${groups.map((g, i) => `<div><i style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></i>
    <span class="ln">${esc(g.name)}</span><span class="lp">${(Math.round((g.ms / total) * 1000) / 10).toFixed(1)}%</span>
    <span class="ld">${fmtDur(g.ms)}</span></div>`).join('')}</div>`;
}

// 圆头柱状图（时段分布）
function roundBars(items) {
  if (!items.length) return '<p class="muted center" style="padding:24px 0">没有数据</p>';
  const W = 340, H = 170, top = 18, bottom = 22, left = 4;
  const max = Math.max(...items.map((i) => i.v), 1);
  const bw = (W - left) / items.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${items.map((it, i) => {
    const h = Math.max(it.v ? 4 : 0, (it.v / max) * (H - top - bottom));
    const w = Math.min(34, bw * 0.62);
    const x = left + i * bw + (bw - w) / 2, y = H - bottom - h;
    const r = Math.min(w / 2, h);
    const shade = 0.45 + 0.55 * (it.v / max);
    const showLabel = items.length <= 12 || i % 2 === 0;
    return `${it.v ? `<path d="M${x},${H - bottom} V${y + r} A${r},${r} 0 0 1 ${x + w},${y + r} V${H - bottom} Z" style="fill:var(--accent);opacity:${shade}"/>
      <text x="${x + w / 2}" y="${y - 4}" text-anchor="middle">${Math.round(it.v / MIN)}</text>` : ''}
      ${showLabel ? `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${it.label}</text>` : ''}`;
  }).join('')}</svg><div class="muted center small">单位：分钟</div>`;
}

function niceStep(x) { const steps = [5, 10, 15, 30, 60, 120, 180, 240, 300, 600, 1200, 2400]; return steps.find((s) => s >= x) || 4800; }

// 平滑曲线（月度、年度）
function curve(items, id) {
  const W = 340, H = 180, top = 22, bottom = 22, left = 46, right = 12;
  const max = Math.max(...items.map((i) => i.v), 30 * MIN);
  const stepMin = niceStep(max / MIN / 4);
  const yMax = Math.ceil(max / MIN / stepMin) * stepMin;
  const X = (i) => left + (i / Math.max(1, items.length - 1)) * (W - left - right);
  const Y = (v) => H - bottom - (v / MIN / yMax) * (H - top - bottom);
  const pts = items.map((it, i) => [X(i), Y(it.v)]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  let grid = '';
  for (let v = 0; v <= yMax; v += stepMin) grid += `<text x="${left - 6}" y="${Y(v * MIN) + 3}" text-anchor="end">${v >= 60 && v % 60 === 0 ? v / 60 + '小时' : v + '分钟'}</text>`;
  const peak = items.reduce((b, it, i) => (it.v > items[b].v ? i : b), 0);
  const labelEvery = Math.ceil(items.length / 7);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="g-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.45"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs>
    ${grid}
    <path d="${d} L${pts[pts.length - 1][0]},${H - bottom} L${pts[0][0]},${H - bottom} Z" fill="url(#g-${id})"/>
    <path d="${d}" fill="none" style="stroke:var(--accent)" stroke-width="2"/>
    ${items[peak].v ? `<text x="${Math.min(W - 30, Math.max(left + 20, pts[peak][0]))}" y="${pts[peak][1] - 8}" text-anchor="middle" style="fill:var(--text)">${fmtDur(items[peak].v)}</text>` : ''}
    ${items.map((it, i) => (i % labelEvery === 0 || i === items.length - 1 ? `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${it.label}</text>` : '')).join('')}
  </svg>`;
}

// 预估 vs 实际：只算开始时填了预估的那些次
function estimateCard(entries, p) {
  const sessions = new Map();
  for (const e of entries) {
    if (!e.estimateMs || overlap(e, p.from, p.to) <= 0) continue;
    const k = e.session || e.id;
    const s = sessions.get(k) || { name: taskNameOf(e), est: e.estimateMs, actual: 0, start: e.startTime };
    s.actual += e.durationMs;
    s.start = Math.min(s.start, e.startTime);
    sessions.set(k, s);
  }
  const list = [...sessions.values()].sort((a, b) => b.start - a.start);
  if (!list.length) return `<p class="muted">正计时开始后，在计时页点一下「预估要多久」，这里就会对比你估的和实际用的。</p>`;
  const est = list.reduce((s, x) => s + x.est, 0), act = list.reduce((s, x) => s + x.actual, 0);
  const diff = Math.round((act / est - 1) * 100);
  const byTask = new Map();
  for (const x of list) { const g = byTask.get(x.name) || { est: 0, act: 0, n: 0 }; g.est += x.est; g.act += x.actual; g.n++; byTask.set(x.name, g); }
  const pct = (a, b) => { const d = Math.round((a / b - 1) * 100); return d === 0 ? '刚好' : d > 0 ? `多用 ${d}%` : `少用 ${-d}%`; };
  return `
    <div class="three"><div><div class="k">次数</div><div class="v">${list.length}</div></div>
      <div><div class="k">预估</div><div class="v">${bigDur(est)}</div></div>
      <div><div class="k">实际</div><div class="v">${bigDur(act)}</div></div></div>
    <p class="center strong">${diff === 0 ? '和预估刚好一样' : diff > 0 ? `实际比预估多用了 ${diff}%` : `实际比预估少用了 ${-diff}%`}</p>
    ${[...byTask.entries()].sort((a, b) => b[1].n - a[1].n).map(([name, g]) => `<div class="est-row"><span>${esc(name)}<small> ${g.n} 次</small></span><span>预估 ${fmtDur(g.est)} → 实际 ${fmtDur(g.act)}</span><b class="${g.act > g.est ? 'over' : 'under'}">${pct(g.act, g.est)}</b></div>`).join('')}`;
}

function matchFilter(e, f) {
  if (!f) return true;
  if (f.task) return taskNameOf(e) === f.task;
  return e.area === f.area && (!f.category || e.category === f.category);
}

function viewStats() {
  const st = S.stats;
  const filt = live().filter((e) => matchFilter(e, st.filter));
  // 累计
  const first = filt.reduce((m, e) => Math.min(m, e.startTime), Infinity);
  const total = filt.reduce((s, e) => s + e.durationMs, 0);
  const days = first === Infinity ? 1 : Math.max(1, Math.round((startOfDay(Date.now()) - startOfDay(first)) / DAY) + 1);
  // 今日
  const t0 = startOfDay(Date.now()), t1 = addDays(t0, 1);
  const todayList = filt.filter((e) => overlap(e, t0, t1) > 0);
  // 分布
  const p = periodOf(st.mode, st.anchor, st.custom);
  const inP = filt.filter((e) => overlap(e, p.from, p.to) > 0);
  const pTotal = sumIn(inP, p.from, p.to);
  const keyFn = st.by === 'task' ? taskNameOf : st.by === 'area' ? (e) => e.area || '未分类' : (e) => e.category || '未分类';
  let groups = groupSum(inP, p.from, p.to, keyFn);
  if (groups.length > 9) { const rest = groups.slice(8).reduce((s, g) => s + g.ms, 0); groups = [...groups.slice(0, 8), { name: '其他', ms: rest }]; }
  // 时段分布：选中范围内，每个钟点一共做了多久
  const hours = new Array(24).fill(0);
  for (const e of inP) {
    const s = Math.max(e.startTime, p.from), en = Math.min(e.endTime, p.to);
    for (let h = s - (s % HOUR); h < en; h += HOUR) {
      const ms = overlap(e, Math.max(h, s), Math.min(h + HOUR, en));
      if (ms) hours[new Date(h).getHours()] += ms;
    }
  }
  const used = hours.map((v, h) => ({ v, label: `${h}点` }));
  const firstH = used.findIndex((x) => x.v);
  const lastH = 23 - [...used].reverse().findIndex((x) => x.v);
  const hourItems = firstH < 0 ? [] : used.slice(firstH, lastH + 1);
  // 月度
  const m = new Date(st.month);
  const mFrom = new Date(m.getFullYear(), m.getMonth(), 1).getTime(), mTo = new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime();
  const monthItems = [];
  for (let d = mFrom; d < mTo; d = addDays(d, 1)) monthItems.push({ v: sumIn(filt, d, addDays(d, 1)), label: `${new Date(d).getDate()}号` });
  // 年度
  const y = new Date(st.year).getFullYear();
  const yearItems = [];
  for (let i = 0; i < 12; i++) yearItems.push({ v: sumIn(filt, new Date(y, i, 1).getTime(), new Date(y, i + 1, 1).getTime()), label: `${i + 1}月` });
  const isCurrent = st.mode !== 'custom' && p.from <= Date.now() && Date.now() < p.to;
  const ab = S.abandons.value || {};
  const abandonsToday = st.filter && st.filter.taskId ? 0 : ab[ymd(Date.now())] || 0;
  const filterName = st.filter ? (st.filter.task || st.filter.category || st.filter.area) : '';

  return `
    ${st.filter ? `<div class="topbar left"><button class="round" data-act="clear-filter" aria-label="看全部">${ICON.left}</button><span class="topbar-title">${esc(filterName)}</span></div>` : '<div class="topbar"></div>'}
    <div class="scard">
      <div class="shead">累计专注 <span class="muted">${first === Infinity ? '' : `自 ${ymd(first)} 起`}</span></div>
      <div class="three"><div><div class="k">次数</div><div class="v">${filt.length}</div></div>
        <div><div class="k">时长</div><div class="v">${bigDur(total)}</div></div>
        <div><div class="k">日均时长</div><div class="v">${bigDur(total / days)}</div></div></div>
    </div>
    <div class="scard">
      <div class="shead">今日专注</div>
      <div class="three"><div><div class="k">次数</div><div class="v">${todayList.length}</div></div>
        <div><div class="k">时长</div><div class="v">${bigDur(sumIn(todayList, t0, t1))}</div></div>
        <div><div class="k">${st.filter ? '未记录' : '放弃次数'}</div><div class="v">${st.filter ? '—' : abandonsToday}</div></div></div>
    </div>
    <div class="scard">
      <div class="shead row-sb"><span>时长分布 ${esc(p.title)}</span>
        ${st.mode === 'custom' ? '' : `<span class="arrows"><button class="ic" data-act="stats-prev" aria-label="上一段">${ICON.left}</button><button class="ic" data-act="stats-next" aria-label="下一段" ${isCurrent ? 'disabled' : ''}>${ICON.chev}</button></span>`}</div>
      <div class="seg">${[['day', '日'], ['week', '周'], ['month', '月'], ['year', '年'], ['custom', '自定']].map(([k, l]) => `<button class="${k === st.mode ? 'on' : ''}" data-act="stats-mode" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="seg mini">${[['task', '按事项'], ['category', '按待办集'], ['area', '工作/生活']].map(([k, l]) => `<button class="${k === st.by ? 'on' : ''}" data-act="stats-by" data-v="${k}">${l}</button>`).join('')}</div>
      ${pie(groups, pTotal)}
      ${pTotal ? `<div class="center strong">总计：${fmtDur(pTotal)}</div>` : ''}
      <div class="center"><button class="pill soft" data-act="records-all">查看专注记录</button></div>
      ${pTotal ? legend(groups, pTotal) : ''}
    </div>
    <div class="scard">
      <div class="shead">专注时段分布 <span class="muted">${esc(p.title)}</span></div>
      ${roundBars(hourItems)}
    </div>
    <div class="scard">
      <div class="shead">预估 vs 实际 <span class="muted">${esc(p.title)}</span></div>
      ${estimateCard(inP, p)}
    </div>
    <div class="scard">
      <div class="shead row-sb"><span>月度数据 ${m.getFullYear()}-${pad(m.getMonth() + 1)}</span>
        <span class="arrows"><button class="ic" data-act="month-prev" aria-label="上个月">${ICON.left}</button><button class="ic" data-act="month-next" aria-label="下个月">${ICON.chev}</button></span></div>
      ${curve(monthItems, 'm')}
    </div>
    <div class="scard">
      <div class="shead row-sb"><span>年度数据 ${y}</span>
        <span class="arrows"><button class="ic" data-act="year-prev" aria-label="上一年">${ICON.left}</button><button class="ic" data-act="year-next" aria-label="下一年">${ICON.chev}</button></span></div>
      ${curve(yearItems, 'y')}
    </div>
    ${syncLine()}`;
}

// ---------- 我的 ----------

function viewMe() {
  const s = { ...DEFAULT_SETTINGS, ...S.settings.value };
  const catText = cats().map((c) => `${c.area}：${c.items.join('、')}`).join('\n');
  const base = apiBase();
  const isIOS = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return `
    <div class="topbar"></div>
    ${isIOS && !standalone ? '<div class="card">在 Safari 里点底部的「分享」按钮，选「添加到主屏幕」，以后从桌面图标打开，就像一个 App。</div>' : ''}
    <h2>计时</h2>
    <div class="card">
      <label>倒计时结束后休息几分钟（0 为不休息）</label>
      <input type="number" min="0" max="60" inputmode="numeric" data-setting="breakMin" value="${s.breakMin}">
      <label>正计时超过几小时，提醒我是不是忘了停</label>
      <input type="number" min="1" max="24" inputmode="numeric" data-setting="forgotStopHours" value="${s.forgotStopHours}">
      <div class="row">
        <div><label>每天从几点开始算空白</label><input type="number" min="0" max="23" inputmode="numeric" data-setting="dayStartHour" value="${s.dayStartHour}"></div>
        <div><label>空白超过几分钟提示</label><input type="number" min="5" max="240" inputmode="numeric" data-setting="gapMinMinutes" value="${s.gapMinMinutes}"></div>
      </div>
    </div>
    <h2>待办集</h2>
    <div class="card">
      <p class="muted" style="margin-top:0">一行一个大类，冒号后面是待办集，用顿号隔开。改名不会改动已有记录。</p>
      <textarea id="cats">${esc(catText)}</textarea>
      <button class="btn block" style="margin-top:8px" data-act="save-cats">保存</button>
    </div>
    <h2>云端同步</h2>
    <div class="card">
      <p class="muted" style="margin-top:0">试用期间不用填。以后开通了云端，填上密钥，手机里的记录会自动传上去，AI 就能读到。</p>
      <label>密钥</label>
      <input id="conn-token" type="password" autocomplete="off" value="${esc(S.conn.token)}">
      <label>云端地址</label>
      <input id="conn-server" placeholder="https://…" value="${esc(S.conn.server)}">
      <button class="btn primary block" style="margin-top:12px" data-act="save-conn">保存并同步</button>
      ${S.conn.token ? syncLine() : ''}
    </div>
    ${S.conn.token ? `
    <h2>给 AI 用的地址</h2>
    <div class="card">
      <p class="muted" style="margin-top:0">Claude、Codex、WorkBuddy 里添加 MCP 服务器，填这个地址（里面带着密钥，别发给别人）：</p>
      <div class="code">${esc(base)}/mcp/${esc(S.conn.token)}</div>
      <button class="btn small" style="margin-top:8px" data-act="copy" data-v="${esc(base)}/mcp/${esc(S.conn.token)}">复制</button>
      <p class="muted">豆包这类只能打开网页的 AI：发给它这个链接，最后换成你的只读密钥：</p>
      <div class="code">${esc(base)}/view/只读密钥?days=30</div>
    </div>` : ''}
    <h2>数据</h2>
    <div class="card">
      <p class="muted" style="margin-top:0">一共 ${live().length} 条记录。试用期间建议每周导出一次备份。</p>
      <div class="row">
        <button class="btn" data-act="export">导出 JSON</button>
        <label class="btn" style="margin:0;color:var(--text)">导入 JSON<input type="file" accept="application/json,.json" id="import" hidden></label>
      </div>
      <button class="btn block" style="margin-top:8px" data-act="records-all">查看全部记录</button>
    </div>`;
}

// ---------- 弹层 ----------

function openSheet(html, cls = '') { const s = $('#sheet'); s.className = 'sheet ' + cls; s.innerHTML = html; $('#sheet-wrap').hidden = false; }
function closeSheet() { $('#sheet-wrap').hidden = true; $('#sheet').innerHTML = ''; }

// 分类选择：先选大类，再选待办集
function catPicker(ctx) {
  const f = S.form[ctx] || (S.form[ctx] = {});
  const list = cats();
  const area = f.area || (list[0] && list[0].area);
  const group = list.find((c) => c.area === area) || { items: [] };
  return `
    <div class="chips">${list.map((c) => `<button class="chip ${c.area === area ? 'area-on' : ''}" data-act="pick-area" data-ctx="${ctx}" data-v="${esc(c.area)}">${esc(c.area)}</button>`).join('')}</div>
    <div class="chips" style="margin-top:8px">${group.items.map((it) => `<button class="chip ${f.category === it && f.area === area ? 'on' : ''}" data-act="pick-cat" data-ctx="${ctx}" data-area="${esc(area)}" data-v="${esc(it)}">${esc(it)}</button>`).join('')}</div>`;
}

// 长按卡片弹出的菜单，照番茄Todo：编辑、删除、记录、统计、周热力图、累计
function openTaskMenu(t) {
  const list = taskEntries(t);
  const total = list.reduce((s, e) => s + e.durationMs, 0);
  const today = startOfDay(Date.now());
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    week.push({ d, ms: sumIn(list, d, addDays(d, 1)) });
  }
  const maxDay = Math.max(...week.map((w) => w.ms), 1);
  const abandons = (S.abandons.value || {})['task:' + t.id] || 0;
  openSheet(`
    <div class="menu-head" style="--c:${esc(t.color)}"><div class="menu-title">${esc(t.name)}</div>
      <div class="muted-light">${t.mode === 'down' ? `${t.minutes} 分钟倒计时` : '正计时'} · ${esc([t.area, t.category].filter(Boolean).join(' / ') || '未分组')}</div></div>
    <div class="menu-body">
      <div class="menu-row"><button class="mbtn" data-act="edit-task" data-id="${esc(t.id)}">编辑</button><button class="mbtn danger" data-act="delete-task" data-id="${esc(t.id)}">删除</button></div>
      <div class="menu-row"><button class="mbtn" data-act="task-records" data-id="${esc(t.id)}">${ICON.hist}专注历史记录</button><button class="mbtn" data-act="task-stats" data-id="${esc(t.id)}">${ICON.pie}数据统计</button></div>
      ${goalProgress(t) ? `<div class="mbox">本周目标${goalLine(t)}</div>` : ''}
      <div class="mbox row-sb"><span>周热力图</span><span class="heat">${week.map((w) => `<i title="${ymd(w.d)} ${fmtDur(w.ms)}" style="opacity:${w.ms ? 0.3 + 0.7 * (w.ms / maxDay) : 1};background:${w.ms ? 'var(--accent)' : 'var(--line)'}"></i>`).join('')}</span></div>
      <div class="mbox"><div class="shead">累计数据</div>
        <div class="three"><div><div class="k">专注次数</div><div class="v">${list.length}</div></div>
        <div><div class="k">时长</div><div class="v">${bigDur(total)}</div></div>
        <div><div class="k">放弃次数</div><div class="v">${abandons}</div></div></div></div>
    </div>`, 'menu');
}

// 记录：edit（改已有）/ add（补记）/ stop（改结束时间）
function openEditor(mode, data) {
  S.form.edit = { ...data, mode };
  const f = S.form.edit;
  const title = { edit: '编辑记录', add: '补记', stop: '结束计时' }[mode];
  const quick = mode === 'add' ? `<label>选一个待办，或者自己写</label><div class="chips">${tasks().slice(0, 14).map((t) => `<button class="chip" data-act="quick-fill" data-id="${esc(t.id)}">${esc(t.name)}</button>`).join('')}</div>` : '';
  openSheet(`
    <h3>${title}</h3>
    ${quick}
    <div class="row">
      <div><label>开始</label><input type="datetime-local" data-bind="edit.startInput" value="${toInput(f.startTime)}"></div>
      <div><label>结束</label><input type="datetime-local" data-bind="edit.endInput" value="${toInput(f.endTime)}"></div>
    </div>
    <label>做了什么（必填）</label>
    <input data-bind="edit.description" id="edit-desc" value="${esc(f.description || '')}" placeholder="比如：站桩">
    <label>待办集</label>
    <div id="edit-picker">${catPicker('edit')}</div>
    <label>项目</label>
    <input data-bind="edit.project" list="projects-edit" placeholder="项目标签（可不填）" value="${esc(f.project || '')}">
    <datalist id="projects-edit">${projectOptions()}</datalist>
    <div class="actions">
      ${mode === 'edit' ? '<button class="btn danger" data-act="delete">删除</button>' : ''}
      <button class="btn" data-act="close">取消</button>
      <button class="btn primary" data-act="save-edit">保存</button>
    </div>`);
}

async function saveEditor() {
  const f = S.form.edit;
  const start = f.startInput ? fromInput(f.startInput) : f.startTime;
  const end = f.endInput ? fromInput(f.endInput) : f.endTime;
  if (!start || !end || end <= start) return toast('结束时间要晚于开始时间');
  if (!(f.description || '').trim()) { toast('写一下做了什么吧'); $('#edit-desc').focus(); return; }
  await saveEntry({ id: f.id, startTime: start, endTime: end, description: f.description, area: f.area, category: f.category, project: f.project, source: f.source });
  if (f.mode === 'stop') await setKv('timer', null);
  closeSheet();
  toast(f.mode === 'stop' ? `已记录 ${fmtDur(end - start)}` : '已保存');
  render();
}

function openTaskEditor(t) {
  S.form.task = { ...t };
  const f = S.form.task;
  openSheet(`
    <h3>${t.id ? '编辑待办' : '新建待办'}</h3>
    <label>名称</label>
    <input data-bind="task.name" id="task-name" value="${esc(f.name || '')}" placeholder="比如：站桩">
    <label>计时方式</label>
    <div class="chips" id="task-mode">${taskModeChips()}</div>
    <label>放进哪个待办集</label>
    <div id="task-picker">${catPicker('task')}</div>
    <label>每周目标（可不设）</label>
    <div class="chips" id="task-goal">${goalChips()}</div>
    <label>颜色</label>
    <div class="swatches" id="task-colors">${colorSwatches()}</div>
    <div class="actions">
      <button class="btn" data-act="close">取消</button>
      <button class="btn primary" data-act="save-task">保存</button>
    </div>`);
}
function taskModeChips() {
  const f = S.form.task;
  const opts = [['up', 0, '正计时'], ['down', 10, '10 分钟'], ['down', 15, '15 分钟'], ['down', 25, '25 分钟'], ['down', 45, '45 分钟'], ['down', 50, '50 分钟'], ['down', 60, '60 分钟']];
  const custom = f.mode === 'down' && !opts.some(([m, n]) => m === 'down' && n === f.minutes);
  return opts.map(([m, n, l]) => `<button class="chip ${!custom && f.mode === m && (m === 'up' || f.minutes === n) ? 'on' : ''}" data-act="task-mode" data-m="${m}" data-n="${n}">${l}</button>`).join('') +
    `<input class="chip-input ${custom ? 'on' : ''}" type="number" min="1" max="600" inputmode="numeric" placeholder="自定分钟" data-bind="task.customMin" value="${custom ? f.minutes : ''}">`;
}
function goalChips() {
  const g = S.form.task.goal || {};
  const type = g.type || '';
  return `<button class="chip ${!type ? 'on' : ''}" data-act="goal-type" data-v="">不设</button>
    <button class="chip ${type === 'times' ? 'on' : ''}" data-act="goal-type" data-v="times">按次数</button>
    <button class="chip ${type === 'hours' ? 'on' : ''}" data-act="goal-type" data-v="hours">按小时</button>
    ${type ? `<span class="goal-input">每周 <input type="number" min="0.5" max="200" step="0.5" inputmode="decimal" data-bind="task.goalValue" value="${g.value || ''}"> ${type === 'times' ? '次' : '小时'}</span>` : ''}`;
}
function colorSwatches() {
  return COLORS.map((c) => `<button class="sw ${S.form.task.color === c ? 'on' : ''}" style="background:${c}" data-act="task-color" data-v="${c}" aria-label="颜色"></button>`).join('');
}

async function saveTask() {
  const f = S.form.task;
  if (!(f.name || '').trim()) { toast('起个名字吧'); return; }
  if (f.customMin) { f.mode = 'down'; f.minutes = Math.round(Number(f.customMin)); }
  if (f.mode === 'down' && !(f.minutes > 0)) return toast('倒计时分钟数不对');
  const list = (S.tasks.value || []).slice();
  const task = {
    id: f.id || uid(), name: f.name.trim(), area: f.category ? f.area : '', category: f.category || '',
    mode: f.mode || 'up', minutes: f.mode === 'down' ? f.minutes : 0, color: f.color || COLORS[list.length % COLORS.length],
    order: f.order ?? (list.reduce((m, t) => Math.max(m, t.order), 0) + 1),
    goal: null,
  };
  const g = f.goal || {};
  const gv = Number(f.goalValue ?? g.value);
  if (g.type) {
    if (!(gv > 0)) return toast('每周目标的数字不对');
    task.goal = { type: g.type, value: gv };
  }
  const i = list.findIndex((t) => t.id === task.id);
  if (i >= 0) list[i] = task; else list.push(task);
  await setKv('tasks', list);
  closeSheet();
  toast('已保存');
  render();
}

// ---------- 计时 ----------

async function startTask(task) {
  if (timer()) { S.minimized = false; render(); return toast('先结束正在进行的计时'); }
  S.brk = null;
  S.showExtra = false;
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (_) {}
  // 第一次用倒计时时请求通知权限，不等用户回答，计时照常开始
  if (task.mode === 'down' && 'Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission().catch(() => {}); } catch (_) {}
  }
  const now = Date.now();
  await setKv('timer', {
    taskId: task.id, name: task.name, area: task.area, category: task.category, color: task.color,
    mode: task.mode, minutes: task.minutes, startTime: now, segStart: now,
    endsAt: task.mode === 'down' ? now + task.minutes * MIN : null, paused: false, remaining: 0, note: '', project: '',
    session: uid(), estimateMin: 0,
    source: task.mode === 'down' ? 'pomodoro' : 'timer',
  });
  S.minimized = false;
  render();
}

// 把计时的一段存成记录（暂停时也会存一段，这样暂停的时间不算进去）
async function saveSegment(t, end) {
  const start = t.segStart || t.startTime;
  if (end - start < MIN) return null;
  return saveEntry({
    startTime: start, endTime: end, description: t.note ? `${t.name}：${t.note}` : t.name,
    area: t.area, category: t.category, project: t.project, source: t.source,
    session: t.session, estimateMs: t.estimateMin ? t.estimateMin * MIN : 0,
  });
}

async function finishTimer(end = Date.now(), auto = false) {
  const t = timer();
  if (!t) return;
  const saved = t.paused ? true : await saveSegment(t, end);
  await setKv('timer', null);
  if (t.mode === 'down' && setting('breakMin') > 0 && auto) S.brk = { endsAt: end + setting('breakMin') * MIN };
  if (S.brk && S.brk.endsAt <= Date.now()) S.brk = null;
  if (auto) { S.notice = `「${t.name}」${t.minutes} 分钟完成了${S.brk ? '，休息一下' : ''}。`; notify('专注完成', `「${t.name}」${t.minutes} 分钟完成了`); }
  else if (saved && t.estimateMin) toast(`预估 ${fmtDur(t.estimateMin * MIN)}，实际 ${fmtDur(end - t.startTime)}`, 4000);
  else toast(saved ? `已记录「${t.name}」` : '不到 1 分钟，没有记录');
  render();
}

async function abandonTimer() {
  const t = timer();
  if (!t) return;
  const done = t.paused ? 0 : Date.now() - (t.segStart || t.startTime);
  const keep = done >= MIN && confirm(`已经做了 ${fmtDur(done)}，要把这段记下来吗？\n点「取消」就不记。`);
  if (keep) await saveSegment(t, Date.now());
  const ab = { ...(S.abandons.value || {}) };
  const day = ymd(Date.now());
  ab[day] = (ab[day] || 0) + 1;
  ab['task:' + t.taskId] = (ab['task:' + t.taskId] || 0) + 1;
  await setKv('abandons', ab);
  await setKv('timer', null);
  render();
}

async function pauseTimer() {
  const t = timer();
  if (!t || t.mode !== 'down') return;
  const now = Date.now();
  if (t.paused) await setKv('timer', { ...t, paused: false, segStart: now, endsAt: now + t.remaining });
  else { await saveSegment(t, now); await setKv('timer', { ...t, paused: true, remaining: Math.max(0, t.endsAt - now) }); }
  render();
}

let audioCtx = null;
function beep() {
  try {
    if (!audioCtx) return;
    [0, 0.45, 0.9].forEach((delay) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + delay;
      g.gain.setValueAtTime(0.25, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      o.start(t0); o.stop(t0 + 0.35);
    });
  } catch (_) { /* 没声音也不影响 */ }
  if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
}

async function notify(title, body) {
  beep();
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) reg.showNotification(title, { body, icon: 'icon-192.png', tag: 'timer' });
    }
  } catch (_) { /* 通知失败就只用页面提示 */ }
}

async function tick() {
  const t = timer();
  if (t && t.mode === 'down' && !t.paused && Date.now() >= t.endsAt) { await finishTimer(t.endsAt, true); return; }
  if (!t && S.brk && Date.now() >= S.brk.endsAt) {
    S.brk = null; S.notice = '休息结束了。';
    notify('休息结束', '可以开始下一个了');
    render();
    return;
  }
  const c = $('#focus-clock');
  if (c) c.textContent = t ? timerText(t) : fmtClock(Math.max(0, S.brk.endsAt - Date.now()));
  const fs = $('#focus-sub');
  if (fs && t) fs.textContent = focusSub(t);
  const mc = $('#mini-clock');
  if (mc && t) mc.textContent = timerText(t);
  if (t && t.mode !== 'down' && !$('#banner').innerHTML.includes('忘了停') && Date.now() - t.startTime > setting('forgotStopHours') * HOUR) renderBanner();
}

// 计时中写的备注、项目也存进计时里
let focusSaveT = null;
function saveFocusField(key, value) {
  clearTimeout(focusSaveT);
  focusSaveT = setTimeout(() => { const t = timer(); if (t) setKv('timer', { ...t, [key]: value }); }, 500);
}

// ---------- 导入导出 ----------

function exportJson() {
  const data = { exportedAt: new Date().toISOString(), entries: live().sort((a, b) => a.startTime - b.startTime), tasks: tasks(), categories: cats(), settings: S.settings.value };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `时间记录-${ymd(Date.now())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.entries || [];
    const changed = [];
    for (const e of list) {
      if (!e.id || !e.startTime || !e.endTime) continue;
      const cur = S.entries.get(e.id);
      if (cur && cur.updatedAt >= (e.updatedAt || 0)) continue;
      const entry = { ...e, durationMs: e.endTime - e.startTime, updatedAt: e.updatedAt || Date.now(), createdAt: e.createdAt || Date.now(), deleted: !!e.deleted };
      S.entries.set(entry.id, entry); S.dirty.add(entry.id); changed.push(entry);
    }
    await idb.putMany('entries', changed);
    if (Array.isArray(data.tasks) && data.tasks.length) await setKv('tasks', data.tasks);
    await persistState();
    scheduleSync();
    toast(`导入了 ${changed.length} 条`);
    render();
  } catch (_) {
    toast('这个文件读不了');
  }
}

// ---------- 事件 ----------

const findTask = (id) => tasks().find((x) => x.id === id);

const actions = {
  start: (el) => { const t = findTask(el.dataset.id); if (t) startTask(t); },
  finish: () => finishTimer(),
  abandon: () => abandonTimer(),
  pause: () => pauseTimer(),
  minimize: () => { S.minimized = true; render(); },
  maximize: () => { S.minimized = false; render(); },
  'toggle-extra': () => { S.showExtra = !S.showExtra; $('#focus-extra').hidden = !S.showExtra; },
  'skip-break': () => { S.brk = null; render(); },
  'pick-area': (el) => {
    const f = S.form[el.dataset.ctx] || (S.form[el.dataset.ctx] = {});
    if (f.area !== el.dataset.v) { f.area = el.dataset.v; f.category = ''; }
    rerenderPicker(el.dataset.ctx);
  },
  'pick-cat': (el) => {
    const f = S.form[el.dataset.ctx] || (S.form[el.dataset.ctx] = {});
    const same = f.category === el.dataset.v && f.area === el.dataset.area;
    f.area = el.dataset.area; f.category = same ? '' : el.dataset.v;
    rerenderPicker(el.dataset.ctx);
  },
  edit: (el) => { const e = S.entries.get(el.dataset.id); if (e) openEditor('edit', { ...e }); },
  add: () => { const end = Date.now(); openEditor('add', { startTime: end - HOUR, endTime: end, source: 'manual' }); },
  'fill-gap': (el) => openEditor('add', { startTime: +el.dataset.s, endTime: +el.dataset.e, source: 'manual' }),
  'quick-fill': (el) => {
    const t = findTask(el.dataset.id);
    if (!t) return;
    Object.assign(S.form.edit, { description: t.name, area: t.area, category: t.category });
    $('#edit-desc').value = t.name;
    $('#edit-picker').innerHTML = catPicker('edit');
  },
  'save-edit': () => saveEditor(),
  close: () => closeSheet(),
  delete: async () => {
    if (!confirm('删除这条记录？')) return;
    const e = S.entries.get(S.form.edit.id);
    if (e) await saveEntry({ ...e, deleted: true });
    closeSheet(); toast('已删除'); render();
  },
  'task-menu': (el, ev) => { ev.stopPropagation(); const t = findTask(el.dataset.id); if (t) openTaskMenu(t); },
  'new-task': (el) => openTaskEditor({ mode: 'down', minutes: 25, area: el.dataset.area || '', category: el.dataset.cat || '', color: COLORS[tasks().length % COLORS.length] }),
  'edit-task': (el) => { const t = findTask(el.dataset.id); if (t) openTaskEditor(t); },
  'task-records': (el) => { const t = findTask(el.dataset.id); if (!t) return; closeSheet(); S.recordsFilter = t.name; S.tab = 'records'; render(); window.scrollTo(0, 0); },
  'task-stats': (el) => { const t = findTask(el.dataset.id); if (!t) return; closeSheet(); S.stats.filter = { task: t.name }; S.tab = 'stats'; render(); window.scrollTo(0, 0); },
  'records-all': () => { S.recordsFilter = ''; S.tab = 'records'; render(); window.scrollTo(0, 0); },
  'task-mode': (el) => {
    Object.assign(S.form.task, { mode: el.dataset.m, minutes: Number(el.dataset.n), customMin: '' });
    $('#task-mode').innerHTML = taskModeChips();
  },
  'goal-type': (el) => {
    const f = S.form.task;
    f.goal = el.dataset.v ? { type: el.dataset.v, value: (f.goal && f.goal.value) || (el.dataset.v === 'times' ? 5 : 3) } : null;
    f.goalValue = f.goal ? f.goal.value : undefined;
    $('#task-goal').innerHTML = goalChips();
  },
  'records-mode': (el) => { S.recordsMode = el.dataset.v; render(); },
  'tl-prev': () => { S.tlDay = addDays(S.tlDay || startOfDay(Date.now()), -1); render(); },
  'tl-next': () => { S.tlDay = Math.min(startOfDay(Date.now()), addDays(S.tlDay || startOfDay(Date.now()), 1)); render(); },
  'set-estimate': async (el) => { const t = timer(); if (t) { await setKv('timer', { ...t, estimateMin: Number(el.dataset.v) }); render(); } },
  'task-color': (el) => { S.form.task.color = el.dataset.v; $('#task-colors').innerHTML = colorSwatches(); },
  'save-task': () => saveTask(),
  'delete-task': async (el) => {
    const id = el.dataset.id;
    if (!confirm('删除这个待办？已有的记录不受影响。')) return;
    await setKv('tasks', (S.tasks.value || []).map((t) => (t.id === id ? { ...t, deleted: true } : t)));
    closeSheet(); render();
  },
  'toggle-set': (el) => { S.open[el.dataset.k] = !S.open[el.dataset.k]; render(); },
  'set-stats': (el) => { S.stats.filter = { area: el.dataset.area, category: el.dataset.cat }; S.tab = 'stats'; render(); window.scrollTo(0, 0); },
  'clear-filter': () => { S.stats.filter = null; render(); },
  go: (el) => { S.tab = el.dataset.v; render(); window.scrollTo(0, 0); },
  more: () => { S.recordsDays += 30; render(); },
  'stats-mode': (el) => {
    if (el.dataset.v === 'custom') return openCustomRange();
    S.stats.mode = el.dataset.v; S.stats.anchor = Date.now(); render();
  },
  'stats-by': (el) => { S.stats.by = el.dataset.v; render(); },
  'stats-prev': () => { S.stats.anchor = shiftAnchor(S.stats.mode, S.stats.anchor, -1); render(); },
  'stats-next': () => { S.stats.anchor = shiftAnchor(S.stats.mode, S.stats.anchor, 1); render(); },
  'month-prev': () => { S.stats.month = shiftAnchor('month', S.stats.month, -1); render(); },
  'month-next': () => { S.stats.month = shiftAnchor('month', S.stats.month, 1); render(); },
  'year-prev': () => { S.stats.year = shiftAnchor('year', S.stats.year, -1); render(); },
  'year-next': () => { S.stats.year = shiftAnchor('year', S.stats.year, 1); render(); },
  'save-range': () => {
    const from = $('#range-from').value, to = $('#range-to').value;
    if (!from || !to || to < from) return toast('结束日期要不早于开始日期');
    S.stats.mode = 'custom'; S.stats.custom = { from: parseYmd(from), to: addDays(parseYmd(to), 1) };
    closeSheet(); render();
  },
  'dismiss-notice': () => { S.notice = ''; renderBanner(); },
  'forgot-keep': () => { S.forgotDismissed = timer() && timer().startTime; renderBanner(); },
  'forgot-fix': () => {
    const t = timer();
    if (t) openEditor('stop', { startTime: t.startTime, endTime: Date.now(), description: t.note ? `${t.name}：${t.note}` : t.name, area: t.area, category: t.category, project: t.project, source: t.source });
  },
  'save-conn': async () => {
    S.conn = { token: $('#conn-token').value.trim(), server: $('#conn-server').value.trim() };
    await saveMeta('conn', S.conn);
    // 换了密钥或地址：从头拉一遍，并把手机里的全部推上去
    S.lastSync = 0;
    for (const e of S.entries.values()) S.dirty.add(e.id);
    for (const k of SYNC_KEYS) if (S[k].updatedAt) S.kvDirty.add(k);
    await persistState();
    setSyncState('正在同步…');
    render();
    await sync();
  },
  'save-cats': async () => {
    const list = $('#cats').value.split('\n').map((line) => {
      const [area, rest = ''] = line.split(/[:：]/);
      return { area: (area || '').trim(), items: rest.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean) };
    }).filter((c) => c.area);
    if (!list.length) return toast('至少要有一个大类');
    await setKv('categories', list);
    toast('已保存');
    render();
  },
  copy: async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.v); toast('已复制'); } catch (_) { toast('复制失败，请长按选中复制'); }
  },
  export: () => exportJson(),
};

function openCustomRange() {
  const c = S.stats.custom || { from: addDays(startOfDay(Date.now()), -6), to: addDays(startOfDay(Date.now()), 1) };
  openSheet(`<h3 class="center">自定义查看时间范围</h3>
    <label>开始日期</label><input type="date" id="range-from" value="${ymd(c.from)}">
    <label>结束日期</label><input type="date" id="range-to" value="${ymd(c.to - 1)}">
    <div class="actions"><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="save-range">确定</button></div>`);
}

function rerenderPicker(ctx) {
  if (ctx === 'edit') $('#edit-picker').innerHTML = catPicker('edit');
  else if (ctx === 'task') $('#task-picker').innerHTML = catPicker('task');
}

// 长按卡片打开菜单
let pressT = null, pressed = false;
document.addEventListener('pointerdown', (ev) => {
  const card = ev.target.closest('.task');
  if (!card || ev.target.closest('.task-more')) return;
  pressed = false;
  pressT = setTimeout(() => {
    pressed = true;
    const t = findTask(card.dataset.id);
    if (t) { if (navigator.vibrate) navigator.vibrate(15); openTaskMenu(t); }
  }, 550);
});
['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((n) => document.addEventListener(n, () => clearTimeout(pressT), true));
document.addEventListener('pointermove', (ev) => { if (Math.abs(ev.movementX) + Math.abs(ev.movementY) > 6) clearTimeout(pressT); });
document.addEventListener('contextmenu', (ev) => { if (ev.target.closest('.task')) ev.preventDefault(); });

document.addEventListener('click', (ev) => {
  if (pressed) { pressed = false; ev.preventDefault(); return; }
  const tab = ev.target.closest('#tabs button');
  if (tab) { S.tab = tab.dataset.tab; if (S.tab === 'stats') S.stats.filter = null; render(); window.scrollTo(0, 0); return; }
  if (ev.target.id === 'sheet-wrap') { closeSheet(); return; }
  const el = ev.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) { ev.preventDefault(); actions[el.dataset.act](el, ev); }
});

document.addEventListener('input', (ev) => {
  const bind = ev.target.dataset.bind;
  if (!bind) return;
  const [ctx, key] = bind.split('.');
  if (ctx === 'focus') return saveFocusField(key, ev.target.value);
  (S.form[ctx] || (S.form[ctx] = {}))[key] = ev.target.value;
  if (ctx === 'task' && key === 'customMin' && ev.target.value) {
    document.querySelectorAll('#task-mode .chip').forEach((c) => c.classList.remove('on'));
  }
});

document.addEventListener('change', async (ev) => {
  const key = ev.target.dataset.setting;
  if (key) {
    const v = Number(ev.target.value);
    if (!Number.isFinite(v) || v < Number(ev.target.min || 0)) return toast('这个数字不太对');
    await setKv('settings', { ...DEFAULT_SETTINGS, ...S.settings.value, [key]: v });
    toast('已保存');
  }
  if (ev.target.id === 'import' && ev.target.files[0]) importJson(ev.target.files[0]);
});

setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); sync(); render(); } });
window.addEventListener('online', () => sync());
setInterval(() => { if (!document.hidden) sync(); }, 60000);

// ---------- 启动 ----------

(async function boot() {
  try {
    await idb.open();
  } catch (_) {
    document.body.innerHTML = '<main><h1>这个浏览器存不了数据</h1><p>请用 Safari 打开，并且不要用无痕模式。</p></main>';
    return;
  }
  for (const e of await idb.all('entries')) S.entries.set(e.id, e);
  const meta = Object.fromEntries((await idb.all('meta')).map((m) => [m.key, m.value]));
  for (const k of SYNC_KEYS) if (meta[k]) S[k] = meta[k];
  if (meta.conn) S.conn = meta.conn;
  S.lastSync = meta.lastSync || 0;
  S.dirty = new Set(meta.dirty || []);
  S.kvDirty = new Set(meta.kvDirty || []);
  // 链接里带 #key=密钥&server=地址 时自动填上
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('key') && !S.conn.token) {
    S.conn = { token: h.get('key'), server: h.get('server') || '' };
    await saveMeta('conn', S.conn);
    history.replaceState(null, '', location.pathname);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await tick();
  render();
  sync();
})();
