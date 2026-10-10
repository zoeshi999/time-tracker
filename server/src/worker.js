// 时间记录：云端部分
// - /api/*      手机端同步接口（需要 API_TOKEN）
// - /mcp        给 Claude / Codex / WorkBuddy 用的 MCP 接口（需要 API_TOKEN）
// - /view       纯文本数据页，给只能打开网页的 AI（需要 READ_TOKEN）
// - 其他路径    手机端网页（public/ 目录）

const DEFAULT_CATEGORIES = [
  { area: '工作', items: ['日常工作', 'AI协作'] },
  { area: '生活', items: ['吃饭', '练功', '家务', '运动', '社交', '休息', '自我照顾', '学习'] },
];

const DEFAULT_SETTINGS = {
  pomodoroEnabled: true,
  workMin: 25,
  breakMin: 5,
  pomodoroRecords: true,     // 专注开始即计时
  forgotStopHours: 3,        // 计时超过这么久提醒
  dayStartHour: 7,           // 补记空白时段时，只看这个时间之后
  gapMinMinutes: 15,         // 多长的空白才提示补记
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (path.startsWith('/api/')) return cors(await handleApi(request, env, url));
      if (path === '/mcp' || path.startsWith('/mcp/')) return cors(await handleMcp(request, env, url));
      if (path === '/view' || path.startsWith('/view/')) return await handleView(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return cors(json({ error: err.message }, err.status));
      console.error(err);
      return cors(json({ error: '服务器出错了' }, 500));
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- 鉴权 ----------

function tokenFrom(request, url, prefix) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  // 有些 AI 客户端不能设置请求头，允许把密钥放在路径里：/mcp/<密钥>、/view/<密钥>
  const rest = url.pathname.slice(prefix.length).replace(/^\//, '');
  if (rest) return decodeURIComponent(rest);
  return url.searchParams.get('key') || '';
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireToken(request, env, url, prefix, allowRead = false) {
  if (!env.API_TOKEN) throw new HttpError(500, '还没有设置 API_TOKEN');
  const t = tokenFrom(request, url, prefix);
  if (safeEqual(t, env.API_TOKEN)) return 'write';
  if (allowRead && env.READ_TOKEN && safeEqual(t, env.READ_TOKEN)) return 'read';
  throw new HttpError(401, '密钥不对');
}

// ---------- 数据层 ----------

const COLS = 'id, start_time, end_time, duration_ms, description, area, category, project, source, created_at, updated_at, deleted';

function rowToEntry(r) {
  return {
    id: r.id, startTime: r.start_time, endTime: r.end_time, durationMs: r.duration_ms,
    description: r.description, area: r.area || '', category: r.category || '', project: r.project || '',
    source: r.source || '', createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted,
  };
}

function cleanEntry(e) {
  const start = Number(e.startTime), end = Number(e.endTime);
  if (!e.id || typeof e.id !== 'string') throw new HttpError(400, '缺少 id');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new HttpError(400, '开始和结束时间不对');
  const now = Date.now();
  return {
    id: e.id.slice(0, 64), startTime: start, endTime: end, durationMs: end - start,
    description: String(e.description || '').slice(0, 500),
    area: String(e.area || '').slice(0, 50), category: String(e.category || '').slice(0, 50),
    project: String(e.project || '').slice(0, 100), source: String(e.source || 'manual').slice(0, 20),
    createdAt: Number(e.createdAt) || now, updatedAt: Number(e.updatedAt) || now, deleted: !!e.deleted,
  };
}

// 后写的赢：只有更新时间更新的版本才会覆盖
async function upsertEntries(env, entries) {
  if (!entries.length) return;
  const stmts = entries.map((e) => env.DB.prepare(
    `INSERT INTO entries (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time,
       duration_ms=excluded.duration_ms, description=excluded.description, area=excluded.area,
       category=excluded.category, project=excluded.project, source=excluded.source,
       updated_at=excluded.updated_at, deleted=excluded.deleted
     WHERE excluded.updated_at > entries.updated_at`
  ).bind(e.id, e.startTime, e.endTime, e.durationMs, e.description, e.area, e.category, e.project,
    e.source, e.createdAt, e.updatedAt, e.deleted ? 1 : 0));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

async function getKv(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value, updated_at FROM kv WHERE key=?').bind(key).first();
  if (!row) return { value: fallback, updatedAt: 0 };
  return { value: JSON.parse(row.value), updatedAt: row.updated_at };
}

async function setKv(env, key, value, updatedAt = Date.now()) {
  await env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
     WHERE excluded.updated_at > kv.updated_at`
  ).bind(key, JSON.stringify(value), updatedAt).run();
}

async function queryEntries(env, { from, to, category, area, project, limit = 1000 }) {
  const where = ['deleted = 0', 'start_time >= ?', 'start_time < ?'];
  const args = [from, to];
  if (area) { where.push('area = ?'); args.push(area); }
  if (category) { where.push('category = ?'); args.push(category); }
  if (project) { where.push('project = ?'); args.push(project); }
  args.push(Math.min(Number(limit) || 1000, 5000));
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM entries WHERE ${where.join(' AND ')} ORDER BY start_time ASC LIMIT ?`
  ).bind(...args).all();
  return results.map(rowToEntry);
}

// ---------- 时间工具（按北京时间） ----------

function tzOffsetMs(env) { return Number(env.TZ_OFFSET_MIN ?? 480) * 60000; }

// "2026-10-10" -> 当天 0 点的时间戳
function dayStart(env, ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) throw new HttpError(400, `日期格式要像 2026-10-10，收到的是 ${ymd}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - tzOffsetMs(env);
}

// 接受时间戳、ISO 字符串、"2026-10-10 14:00"（按北京时间）
function parseTime(env, v) {
  if (typeof v === 'number') return v;
  const s = String(v || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - tzOffsetMs(env);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new HttpError(400, `看不懂这个时间：${s}`);
  return t;
}

function fmtDate(env, ts) {
  const d = new Date(ts + tzOffsetMs(env));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function fmtTime(env, ts) {
  const d = new Date(ts + tzOffsetMs(env));
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}小时${m % 60 ? (m % 60) + '分钟' : ''}` : `${m}分钟`;
}

function todayYmd(env) { return fmtDate(env, Date.now()); }
function addDays(ymd, n) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// ---------- 手机端同步接口 ----------

async function handleApi(request, env, url) {
  requireToken(request, env, url, '/api');
  const path = url.pathname;

  // 同步：手机端推上来自己改过的，拿回 since 之后云端改过的
  if (path === '/api/sync' && request.method === 'POST') {
    const body = await request.json();
    const since = Number(body.since) || 0;
    const incoming = (body.entries || []).map(cleanEntry);
    await upsertEntries(env, incoming);
    for (const key of ['settings', 'categories', 'timer']) {
      if (body[key] && body[key].updatedAt) await setKv(env, key, body[key].value, body[key].updatedAt);
    }
    const serverTime = Date.now();
    const { results } = await env.DB.prepare(
      `SELECT ${COLS} FROM entries WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 5000`
    ).bind(since).all();
    return json({
      serverTime,
      entries: results.map(rowToEntry),
      settings: await getKv(env, 'settings', DEFAULT_SETTINGS),
      categories: await getKv(env, 'categories', DEFAULT_CATEGORIES),
      timer: await getKv(env, 'timer', null),
    });
  }

  if (path === '/api/ping') return json({ ok: true, serverTime: Date.now() });
  throw new HttpError(404, '没有这个接口');
}

// ---------- 统计 ----------

function summarize(env, entries, groupBy) {
  const groups = new Map();
  let total = 0;
  for (const e of entries) {
    total += e.durationMs;
    let key;
    if (groupBy === 'area') key = e.area || '未分类';
    else if (groupBy === 'project') key = e.project || '无项目';
    else if (groupBy === 'day') key = fmtDate(env, e.startTime);
    else if (groupBy === 'description') key = e.description;
    else key = e.area && e.category ? `${e.area}/${e.category}` : (e.category || e.area || '未分类');
    const g = groups.get(key) || { name: key, durationMs: 0, count: 0 };
    g.durationMs += e.durationMs; g.count += 1;
    groups.set(key, g);
  }
  const list = [...groups.values()];
  if (groupBy === 'day') list.sort((a, b) => a.name.localeCompare(b.name));
  else list.sort((a, b) => b.durationMs - a.durationMs);
  return {
    totalMs: total, total: fmtDur(total), count: entries.length,
    groups: list.map((g) => ({ ...g, duration: fmtDur(g.durationMs), share: total ? Math.round((g.durationMs / total) * 1000) / 10 : 0 })),
  };
}

function entryLine(env, e) {
  const cat = [e.area, e.category].filter(Boolean).join('/') || '未分类';
  const proj = e.project ? ` #${e.project}` : '';
  return `${fmtTime(env, e.startTime)}-${fmtTime(env, e.endTime)} ${fmtDur(e.durationMs)} [${cat}]${proj} ${e.description}`;
}

function entriesAsText(env, entries) {
  const byDay = new Map();
  for (const e of entries) {
    const d = fmtDate(env, e.startTime);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  const out = [];
  for (const [d, list] of byDay) {
    const total = list.reduce((s, e) => s + e.durationMs, 0);
    out.push(`## ${d}（共 ${fmtDur(total)}，${list.length} 条）`);
    for (const e of list) out.push(`- ${entryLine(env, e)}`);
    out.push('');
  }
  return out.join('\n') || '这段时间没有记录。';
}

// ---------- MCP 接口 ----------

const MCP_TOOLS = [
  {
    name: 'get_entries',
    description: '查时间记录。日期按北京时间，格式 YYYY-MM-DD，to 包含当天。不给日期默认最近 7 天。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '开始日期，如 2026-10-01' },
        to: { type: 'string', description: '结束日期（含），如 2026-10-07' },
        area: { type: 'string', description: '大类，如 工作、生活' },
        category: { type: 'string', description: '小类，如 日常工作' },
        project: { type: 'string', description: '项目标签' },
      },
    },
  },
  {
    name: 'get_summary',
    description: '按大类、小类、项目、日期或描述汇总一段时间的时长。日期按北京时间，to 包含当天。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        group_by: { type: 'string', enum: ['area', 'category', 'project', 'day', 'description'], description: '默认 category' },
        area: { type: 'string' },
        project: { type: 'string' },
      },
    },
  },
  {
    name: 'get_categories',
    description: '列出现有的分类（大类和小类）和用过的项目标签。记录前先看一下，尽量用已有的分类。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_running_timer',
    description: '看现在有没有正在进行的计时。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_entry',
    description: '新增一条时间记录。时间可写 "2026-10-10 14:00"（按北京时间）或 ISO 格式。',
    inputSchema: {
      type: 'object',
      required: ['start', 'end', 'description'],
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
        description: { type: 'string', description: '做了什么' },
        area: { type: 'string', description: '大类，如 工作、生活' },
        category: { type: 'string', description: '小类，如 日常工作' },
        project: { type: 'string', description: '项目标签，可空' },
      },
    },
  },
  {
    name: 'update_entry',
    description: '修改一条记录，只改给出的字段。id 从 get_entries 拿。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
        description: { type: 'string' }, area: { type: 'string' }, category: { type: 'string' }, project: { type: 'string' },
      },
    },
  },
  {
    name: 'delete_entry',
    description: '删除一条记录。删除前先跟用户确认。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
];

const WRITE_TOOLS = new Set(['add_entry', 'update_entry', 'delete_entry']);

function rangeFrom(env, args) {
  const to = args.to || todayYmd(env);
  const from = args.from || addDays(to, -6);
  return { from: dayStart(env, from), to: dayStart(env, addDays(to, 1)), label: `${from} 到 ${to}` };
}

async function callTool(env, name, args, access) {
  if (WRITE_TOOLS.has(name) && access !== 'write') throw new HttpError(403, '只读密钥不能修改记录');
  switch (name) {
    case 'get_entries': {
      const r = rangeFrom(env, args);
      const entries = await queryEntries(env, { ...r, area: args.area, category: args.category, project: args.project });
      const s = summarize(env, entries, 'category');
      return `${r.label}，共 ${s.count} 条，${s.total}。\n\n${entriesAsText(env, entries)}\n\n（每条的 id，修改时用）\n` +
        entries.map((e) => `${e.id} = ${fmtDate(env, e.startTime)} ${entryLine(env, e)}`).join('\n');
    }
    case 'get_summary': {
      const r = rangeFrom(env, args);
      const entries = await queryEntries(env, { ...r, area: args.area, project: args.project, limit: 5000 });
      const s = summarize(env, entries, args.group_by || 'category');
      return `${r.label}，共 ${s.count} 条，${s.total}。\n` +
        s.groups.map((g) => `- ${g.name}：${g.duration}（${g.share}%，${g.count} 条）`).join('\n');
    }
    case 'get_categories': {
      const cats = (await getKv(env, 'categories', DEFAULT_CATEGORIES)).value;
      const { results } = await env.DB.prepare(
        "SELECT project, COUNT(*) n FROM entries WHERE deleted=0 AND project<>'' GROUP BY project ORDER BY n DESC LIMIT 50"
      ).all();
      return cats.map((c) => `${c.area}：${c.items.join('、')}`).join('\n') +
        `\n\n项目标签：${results.map((r) => r.project).join('、') || '还没有'}`;
    }
    case 'get_running_timer': {
      const t = (await getKv(env, 'timer', null)).value;
      if (!t || !t.startTime) return '现在没有在计时。';
      return `正在计时：从 ${fmtDate(env, t.startTime)} ${fmtTime(env, t.startTime)} 开始，已经 ${fmtDur(Date.now() - t.startTime)}。` +
        (t.description ? `描述：${t.description}` : '');
    }
    case 'add_entry': {
      const now = Date.now();
      const e = cleanEntry({
        id: crypto.randomUUID(), startTime: parseTime(env, args.start), endTime: parseTime(env, args.end),
        description: args.description, area: args.area, category: args.category, project: args.project,
        source: 'ai', createdAt: now, updatedAt: now,
      });
      if (!e.description) throw new HttpError(400, '描述不能为空');
      await upsertEntries(env, [e]);
      return `已记录：${fmtDate(env, e.startTime)} ${entryLine(env, e)}（id ${e.id}）`;
    }
    case 'update_entry': {
      const row = await env.DB.prepare(`SELECT ${COLS} FROM entries WHERE id=? AND deleted=0`).bind(args.id).first();
      if (!row) throw new HttpError(404, '找不到这条记录');
      const old = rowToEntry(row);
      const e = cleanEntry({
        ...old,
        startTime: args.start ? parseTime(env, args.start) : old.startTime,
        endTime: args.end ? parseTime(env, args.end) : old.endTime,
        description: args.description ?? old.description, area: args.area ?? old.area,
        category: args.category ?? old.category, project: args.project ?? old.project,
        updatedAt: Math.max(Date.now(), old.updatedAt + 1),
      });
      await upsertEntries(env, [e]);
      return `已修改：${fmtDate(env, e.startTime)} ${entryLine(env, e)}`;
    }
    case 'delete_entry': {
      const row = await env.DB.prepare(`SELECT ${COLS} FROM entries WHERE id=? AND deleted=0`).bind(args.id).first();
      if (!row) throw new HttpError(404, '找不到这条记录');
      const old = rowToEntry(row);
      await upsertEntries(env, [{ ...old, deleted: true, updatedAt: Math.max(Date.now(), old.updatedAt + 1) }]);
      return `已删除：${fmtDate(env, old.startTime)} ${entryLine(env, old)}`;
    }
    default:
      throw new HttpError(400, `没有这个工具：${name}`);
  }
}

async function handleMcp(request, env, url) {
  if (request.method !== 'POST') return new Response('MCP 接口只接受 POST', { status: 405, headers: { Allow: 'POST' } });
  const access = requireToken(request, env, url, '/mcp', true);
  const body = await request.json();
  const msgs = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of msgs) {
    const r = await mcpMessage(env, msg, access);
    if (r) replies.push(r);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? replies : replies[0]);
}

async function mcpMessage(env, msg, access) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (isNotification) return null;
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'time-tracker', title: 'Zoe 的时间记录', version: '0.1.0' },
        instructions: '这是 Zoe 的个人时间记录。时间都按北京时间。回答时用中文，时长用"X小时Y分钟"。新增记录前先用 get_categories 看已有分类。删除前先确认。',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: access === 'write' ? MCP_TOOLS : MCP_TOOLS.filter((t) => !WRITE_TOOLS.has(t.name)) });
    case 'tools/call':
      try {
        const text = await callTool(env, params.name, params.arguments || {}, access);
        return ok({ content: [{ type: 'text', text }] });
      } catch (err) {
        if (err instanceof HttpError) return ok({ content: [{ type: 'text', text: err.message }], isError: true });
        throw err;
      }
    default:
      return fail(-32601, `不支持 ${method}`);
  }
}

// ---------- 纯文本数据页 ----------

async function handleView(request, env, url) {
  let access;
  try { access = requireToken(request, env, url, '/view', true); }
  catch (e) { return new Response(e.message, { status: e.status || 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  void access;
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 400);
  const to = url.searchParams.get('to') || todayYmd(env);
  const from = url.searchParams.get('from') || addDays(to, -(days - 1));
  const r = { from: dayStart(env, from), to: dayStart(env, addDays(to, 1)) };
  const entries = await queryEntries(env, { ...r, limit: 5000 });
  const byArea = summarize(env, entries, 'area');
  const byCat = summarize(env, entries, 'category');
  const byProj = summarize(env, entries.filter((e) => e.project), 'project');
  const text = [
    `# Zoe 的时间记录：${from} 到 ${to}（北京时间）`,
    '',
    `共 ${byCat.count} 条，${byCat.total}。`,
    '',
    '## 按大类',
    ...byArea.groups.map((g) => `- ${g.name}：${g.duration}（${g.share}%）`),
    '',
    '## 按小类',
    ...byCat.groups.map((g) => `- ${g.name}：${g.duration}（${g.share}%）`),
    '',
    '## 按项目',
    ...(byProj.groups.length ? byProj.groups.map((g) => `- ${g.name}：${g.duration}`) : ['- 没有带项目标签的记录']),
    '',
    '# 明细',
    '',
    entriesAsText(env, entries),
  ].join('\n');
  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

// ---------- 小工具 ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return new Response(res.body, { status: res.status, headers: h });
}
