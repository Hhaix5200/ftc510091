import { DurableObject } from "cloudflare:workers";

// ==========================================
// Durable Object：专门负责后台长任务
// ==========================================
export class TaskDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.isRunning = false; 
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/run-backfill") {
      if (this.isRunning) {
        return new Response(JSON.stringify({ ok: false, msg: "⚠️ 已有补抓任务在后台执行中，请稍后" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = await request.json();
      const { config, chatId, targetUser, targetGroup, maxPerSource } = body;
      
      this.isRunning = true;
      this.ctx.waitUntil(
        this.runBackfillTask(config, chatId, targetUser, targetGroup, maxPerSource)
          .finally(() => { this.isRunning = false; })
      );
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  async runBackfillTask(config, chatId, targetUser, targetGroup, maxPerSource) {
    const db = this.env.DB;
    const token = this.env.TG_BOT_TOKEN;
    
    const backfillKb = {
      inline_keyboard: [
        [{ text: "🔁 再次补抓", callback_data: "action:repeat_backfill" }],
        [{ text: "🏠 返回主菜单", callback_data: "menu:main" }],
      ],
    };

    let lastProgressTs = 0;
    const onProgress = async (p) => {
      const now = Date.now();
      if (now - lastProgressTs < 4000) return;
      lastProgressTs = now;
      try {
        await sendTgMessage(token, chatId, `⏳ @${p.user} 补抓中 ${p.done}/${p.total}｜成功${p.ok} 跳过${p.skip} 失败${p.fail}`);
      } catch (e) {}
    };

    try {
      const res = await backfillForSources(this.env, config, db, [targetUser], targetGroup, maxPerSource, onProgress);
      let msg = `✅ 补历史完成\n成功 ${res.okCount} | 跳过 ${res.skipCount} | 失败 ${res.failCount}`;
      if (res.timedOut) msg += `\n\n⏰ 达到单次上限，点「🔁 再次补抓」继续。`;
      if (res.details.length > 0) msg += `\n\n${res.details.join("\n")}`;
      
      await sendTgMessage(token, chatId, msg, backfillKb);
    } catch (e) {
      await sendTgMessage(token, chatId, `❌ 补抓异常：${e.message}`, backfillKb);
    }
  }
}

// ==========================================
// Worker 入口
// ==========================================
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(forwardTask(env).catch(e => console.error("scheduled error", e)));
  },
  async fetch(request, env, ctx) {
    return await handleWebhook(request, env, ctx);
  },
  TaskDurableObject,
};

// ==========================================
// 全局常量与默认配置
// ==========================================
const BOT_VERSION = "V4.6.5.5-DO";

const DEFAULT_CONFIG = {
  rssSources: [], sourceNames: {}, whitelist: [], blacklist: [],
  prefix: "", suffix: "", filterRt: true, onlyPhoto: false,
  maxItems: 3, manualMaxItems: 10, targetGroups: [], targetGroupNames: {},
  manualOnlyGroups: [], manualOnlyGroupNames: {}, groupRoutes: {},
  linkOnlyMode: false, disableVideoDowngrade: false, skipEmptyText: false,
  wholeWordFilter: false, showSourceLabel: true, autoCreateTopic: false,
  topicCache: {}, cronSummary: true
};

const MAX_ITEMS_LIMIT = 50;
const GROUP_NAME_MAX_LEN = 8;
const TASK_LOCK_TTL = 600;
const SESSION_TTL_SEC = 86400 * 7;
const BACKFILL_TIMEOUT_MS = 26000;
const BACKFILL_FETCH_TIMEOUT_MS = 6000;
const BACKFILL_FLUSH_EVERY = 10;
const MANUAL_SCAN_TIMEOUT_MS = 15000;
const CRON_FETCH_TIMEOUT_MS = 15000;
const MANUAL_FETCH_TIMEOUT_MS = 10000;
const FETCH_RETRY_LIGHT = 1;
const BACKFILL_MAX_PER_SOURCE = 70;
const BACKFILL_PAGE_COUNT = 12;
const BACKFILL_CONSECUTIVE_FAIL_LIMIT = 3;

const VALID_TOGGLES = ["filterRt", "onlyPhoto", "linkOnlyMode", "disableVideoDowngrade", "skipEmptyText", "wholeWordFilter", "showSourceLabel", "autoCreateTopic", "cronSummary"];
const VALID_CLEARS = ["prefix", "suffix", "whitelist", "blacklist"];
const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,15}$/;
const MAX_VIDEO_MB_DEFAULT = 30;
const DEFAULT_GROUP_NAME = "默认组";
const RESERVED_PATHS = ["rss", "status", "tw", "user", "twitter", "i", "home", "explore", "search", "settings", "notifications", "messages", "login", "tos", "privacy", "intent", "share", "hashtag", "following", "followers", "lists", "bookmarks", "jobs", "premium", "verified", "account", "about", "compose", "signup", "logout", "web"];

// ==========================================
// 通用工具
// ==========================================
function cmpTweetId(a, b) {
  a = String(a || "0"); b = String(b || "0");
  if (!/^\d+$/.test(a)) a = "0"; if (!/^\d+$/.test(b)) b = "0";
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : (a > b ? 1 : 0);
}

function truncateByCodePoints(s, maxLen) {
  if (typeof s !== "string" || !s) return "";
  if (s.length <= maxLen) return s;
  const points = Array.from(s);
  if (points.length <= maxLen) return s;
  return points.slice(0, maxLen).join("");
}

function getTargetGroupsForUser(config, username, fallbackGroups) {
  let localGroups = fallbackGroups;
  if (!username) return localGroups;
  const source = config.rssSources.find(s => s.username.toLowerCase() === username.toLowerCase());
  if (source) {
    const groupName = source.group || DEFAULT_GROUP_NAME;
    const routed = config.groupRoutes?.[groupName];
    if (Array.isArray(routed) && routed.length > 0) {
      const lowerAuto = config.targetGroups.map(x => String(x).toLowerCase());
      const matchedTargets = [...new Set(routed.map(x => String(x)).filter(id => lowerAuto.includes(id.toLowerCase())))];
      if (matchedTargets.length > 0) localGroups = matchedTargets;
    }
  }
  return localGroups;
}

function pickSingleTargetGroup(config, username, fallbackGroups) {
  const groups = getTargetGroupsForUser(config, username, fallbackGroups);
  const list = Array.isArray(groups) ? groups.filter(Boolean).map(String) : [];
  if (list.length === 0) return null;
  return list[0];
}

// ==========================================
// 配置读写
// ==========================================
async function getConfig(db, env) {
  try {
    const [main, sources, groups, routes, whitelist, blacklist, topics] = await db.batch([
      db.prepare("SELECT * FROM bot_config WHERE id = 1"),
      db.prepare("SELECT username, group_name, nickname FROM rss_sources ORDER BY username"),
      db.prepare("SELECT chat_id, group_name, type FROM target_groups ORDER BY type, chat_id"),
      db.prepare("SELECT group_name, target_chat_id FROM group_routes ORDER BY group_name, target_chat_id"),
      db.prepare("SELECT keyword FROM keywords WHERE type = 'whitelist' ORDER BY keyword"),
      db.prepare("SELECT keyword FROM keywords WHERE type = 'blacklist' ORDER BY keyword"),
      db.prepare("SELECT chat_id, username, thread_id FROM user_topic_map")
    ]);
    const m = main.results[0] || {};
    const config = {
      ...DEFAULT_CONFIG,
      prefix: m.prefix || "", suffix: m.suffix || "",
      filterRt: m.filter_rt !== 0, onlyPhoto: m.only_photo === 1,
      maxItems: m.max_items || 3, manualMaxItems: m.manual_max_items || 10,
      linkOnlyMode: m.link_only_mode === 1, disableVideoDowngrade: m.disable_video_downgrade === 1,
      skipEmptyText: m.skip_empty_text === 1, wholeWordFilter: m.whole_word_filter === 1,
      showSourceLabel: m.show_source_label !== 0, autoCreateTopic: m.auto_create_topic === 1,
      cronSummary: m.cron_summary !== 0,
      rssSources: sources.results.map(r => ({ username: r.username, group: (r.group_name && String(r.group_name).trim()) || DEFAULT_GROUP_NAME })),
      sourceNames: (() => { const nameMap = {}; for (const r of sources.results) { if (r.nickname) nameMap[r.username.toLowerCase()] = r.nickname; } return nameMap; })(),
      targetGroups: groups.results.filter(g => g.type === "auto").map(g => String(g.chat_id)),
      manualOnlyGroups: groups.results.filter(g => g.type === "manual").map(g => String(g.chat_id)),
      targetGroupNames: {}, manualOnlyGroupNames: {}, groupRoutes: {},
      whitelist: whitelist.results.map(r => r.keyword), blacklist: blacklist.results.map(r => r.keyword),
      topicCache: {}
    };
    for (const t of topics.results) config.topicCache[`${t.chat_id}_${String(t.username).toLowerCase()}`] = t.thread_id;
    for (const g of groups.results) { if (g.group_name) { if (g.type === "auto") config.targetGroupNames[String(g.chat_id)] = g.group_name; else config.manualOnlyGroupNames[String(g.chat_id)] = g.group_name; } }
    for (const r of routes.results) {
      const gName = (r.group_name && String(r.group_name).trim()) || DEFAULT_GROUP_NAME;
      if (!config.groupRoutes[gName]) config.groupRoutes[gName] = [];
      const tid = String(r.target_chat_id);
      if (!config.groupRoutes[gName].includes(tid)) config.groupRoutes[gName].push(tid);
    }
    if (config.targetGroups.length === 0 && env.TG_GROUP_ID) config.targetGroups = [String(env.TG_GROUP_ID)];
    return config;
  } catch (e) {
    console.warn("getConfig D1读取异常", e);
    const fallback = { ...DEFAULT_CONFIG, targetGroups: env.TG_GROUP_ID ? [String(env.TG_GROUP_ID)] : [] };
    fallback.__loadFailed = true; return fallback;
  }
}

async function saveConfig(db, config) {
  if (config.__loadFailed) throw new Error("配置读取失败，已阻止保存。");
  const [sourcesRes, groupsRes, routesRes, kwRes] = await db.batch([
    db.prepare("SELECT username, group_name, nickname FROM rss_sources"),
    db.prepare("SELECT chat_id, group_name, type FROM target_groups"),
    db.prepare("SELECT group_name, target_chat_id FROM group_routes"),
    db.prepare("SELECT keyword, type FROM keywords")
  ]);
  const SEP = "\u0000"; const stmts = [];
  let hasCronSummary = false;
  try {
    const cols = await db.prepare("PRAGMA table_info(bot_config)").all();
    hasCronSummary = (cols.results || []).some(c => String(c.name).toLowerCase() === "cron_summary");
  } catch (e) {}
  
  const baseCols = "id, prefix, suffix, filter_rt, only_photo, max_items, manual_max_items, link_only_mode, disable_video_downgrade, skip_empty_text, whole_word_filter, show_source_label, auto_create_topic";
  const baseVals = "1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
  const baseUpdates = "prefix = excluded.prefix, suffix = excluded.suffix, filter_rt = excluded.filter_rt, only_photo = excluded.only_photo, max_items = excluded.max_items, manual_max_items = excluded.manual_max_items, link_only_mode = excluded.link_only_mode, disable_video_downgrade = excluded.disable_video_downgrade, skip_empty_text = excluded.skip_empty_text, whole_word_filter = excluded.whole_word_filter, show_source_label = excluded.show_source_label, auto_create_topic = excluded.auto_create_topic";
  const cols = hasCronSummary ? baseCols + ", cron_summary" : baseCols;
  const vals = hasCronSummary ? baseVals + ", ?" : baseVals;
  const updates = hasCronSummary ? baseUpdates + ", cron_summary = excluded.cron_summary" : baseUpdates;
  const bindArgs = [
    config.prefix || "", config.suffix || "", config.filterRt ? 1 : 0, config.onlyPhoto ? 1 : 0,
    config.maxItems || 3, config.manualMaxItems || 10, config.linkOnlyMode ? 1 : 0, config.disableVideoDowngrade ? 1 : 0,
    config.skipEmptyText ? 1 : 0, config.wholeWordFilter ? 1 : 0, config.showSourceLabel ? 1 : 0, config.autoCreateTopic ? 1 : 0
  ];
  if (hasCronSummary) bindArgs.push(config.cronSummary !== false ? 1 : 0);
  
  stmts.push(db.prepare(`INSERT INTO bot_config (${cols}) VALUES (${vals}) ON CONFLICT(id) DO UPDATE SET ${updates}`).bind(...bindArgs));
  
  const curSources = new Map(); for (const r of sourcesRes.results) curSources.set(String(r.username).toLowerCase(), r);
  const newSources = new Map(); for (const s of config.rssSources) { const nick = config.sourceNames?.[s.username.toLowerCase()] || ""; newSources.set(s.username.toLowerCase(), { username: s.username, group: s.group || DEFAULT_GROUP_NAME, nick }); }
  for (const [low, row] of curSources) { if (!newSources.has(low)) stmts.push(db.prepare("DELETE FROM rss_sources WHERE username = ?").bind(row.username)); }
  for (const [low, s] of newSources) {
    const cur = curSources.get(low);
    if (!cur) stmts.push(db.prepare("INSERT OR IGNORE INTO rss_sources (username, group_name, nickname) VALUES (?, ?, ?)").bind(s.username, s.group, s.nick));
    else { const curGroup = (cur.group_name && String(cur.group_name).trim()) || DEFAULT_GROUP_NAME; const curNick = cur.nickname || ""; if (curGroup !== s.group || curNick !== s.nick) stmts.push(db.prepare("UPDATE rss_sources SET group_name = ?, nickname = ? WHERE username = ?").bind(s.group, s.nick, cur.username)); }
  }
  
  const curGroups = new Map(); for (const r of groupsRes.results) curGroups.set(`${r.type}${SEP}${String(r.chat_id)}`, r);
  const newGroups = new Map(); for (const g of config.targetGroups) { const id = String(g); newGroups.set(`auto${SEP}${id}`, { chat_id: id, group_name: config.targetGroupNames?.[id] || null, type: "auto" }); } for (const g of config.manualOnlyGroups) { const id = String(g); newGroups.set(`manual${SEP}${id}`, { chat_id: id, group_name: config.manualOnlyGroupNames?.[id] || null, type: "manual" }); }
  for (const [key, row] of curGroups) { if (!newGroups.has(key)) stmts.push(db.prepare("DELETE FROM target_groups WHERE chat_id = ? AND type = ?").bind(String(row.chat_id), row.type)); }
  for (const [key, g] of newGroups) { const cur = curGroups.get(key); if (!cur) stmts.push(db.prepare("INSERT OR IGNORE INTO target_groups (chat_id, group_name, type) VALUES (?, ?, ?)").bind(g.chat_id, g.group_name, g.type)); else { const curName = cur.group_name || null; const newName = g.group_name || null; if (curName !== newName) stmts.push(db.prepare("UPDATE target_groups SET group_name = ? WHERE chat_id = ? AND type = ?").bind(g.group_name, g.chat_id, g.type)); } }
  
  const curRoutes = new Map(); for (const r of routesRes.results) curRoutes.set(`${r.group_name}${SEP}${String(r.target_chat_id)}`, r);
  const newRoutes = new Map(); const lowerTargets = config.targetGroups.map(t => String(t).toLowerCase()); for (const [groupName, targets] of Object.entries(config.groupRoutes || {})) { for (const target of targets) { if (!lowerTargets.includes(String(target).toLowerCase())) continue; newRoutes.set(`${groupName}${SEP}${String(target)}`, { group_name: groupName, target_chat_id: String(target) }); } }
  for (const [key, row] of curRoutes) { if (!newRoutes.has(key)) stmts.push(db.prepare("DELETE FROM group_routes WHERE group_name = ? AND target_chat_id = ?").bind(row.group_name, String(row.target_chat_id))); }
  for (const [key, r] of newRoutes) { if (!curRoutes.has(key)) stmts.push(db.prepare("INSERT OR IGNORE INTO group_routes (group_name, target_chat_id) VALUES (?, ?)").bind(r.group_name, r.target_chat_id)); }
  
  const curKw = new Map(); for (const r of kwRes.results) curKw.set(`${r.type}${SEP}${r.keyword}`, r);
  const newKw = new Map(); for (const kw of config.whitelist) { if (kw) newKw.set(`whitelist${SEP}${kw}`, { keyword: kw, type: "whitelist" }); } for (const kw of config.blacklist) { if (kw) newKw.set(`blacklist${SEP}${kw}`, { keyword: kw, type: "blacklist" }); }
  for (const [key, row] of curKw) { if (!newKw.has(key)) stmts.push(db.prepare("DELETE FROM keywords WHERE keyword = ? AND type = ?").bind(row.keyword, row.type)); }
  for (const [key, kw] of newKw) { if (!curKw.has(key)) stmts.push(db.prepare("INSERT OR IGNORE INTO keywords (keyword, type) VALUES (?, ?)").bind(kw.keyword, kw.type)); }
  
  if (stmts.length === 0) return;
  if (stmts.length <= 100) await db.batch(stmts);
  else { for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50)); }
}

async function updateNicknameDirect(db, username, nickname) {
  try { await db.prepare("UPDATE rss_sources SET nickname = ? WHERE LOWER(username) = LOWER(?)").bind(nickname, username).run(); } catch (e) {}
}
// ==========================================
// 会话与解析
// ==========================================
async function getAdminSession(db, uid) {
  try {
    const row = await db.prepare("SELECT op_mode, updated_at FROM admin_sessions WHERE uid = ?").bind(String(uid)).first();
    if (!row || !row.op_mode) return { op_mode: "idle" };
    if (row.updated_at && Date.now() - row.updated_at > SESSION_TTL_SEC * 1000) return { op_mode: "idle" };
    let parsed; try { parsed = JSON.parse(row.op_mode); } catch (e) { parsed = { op_mode: row.op_mode }; }
    if (!parsed.op_mode) parsed.op_mode = "idle";
    return parsed;
  } catch (e) { return { op_mode: "idle" }; }
}

async function setAdminSession(db, uid, obj) {
  try {
    const cur = await getAdminSession(db, uid);
    const merged = { ...cur, ...obj };
    await db.prepare(`INSERT INTO admin_sessions (uid, op_mode, updated_at) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET op_mode = excluded.op_mode, updated_at = excluded.updated_at`).bind(String(uid), JSON.stringify(merged), Date.now()).run();
  } catch (e) {}
}

function parseTweetUrl(text) {
  const iweb = text.match(/(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com)\/i\/web\/status\/(\d+)(?:\/|$|[\s?#])/i);
  if (iweb) return { username: null, tweetId: iweb[1], rawUrl: iweb[0] };
  const reg = /(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com)\/([^\/\s]+)\/status\/(\d+)(?:\/|$|[\s?#])/i;
  const match = text.match(reg);
  if (match) return { username: match[1], tweetId: match[2], rawUrl: match[0] };
  const idMatch = text.trim().match(/^(\d{5,})$/);
  if (idMatch) return { username: null, tweetId: idMatch[1], rawUrl: null };
  return null;
}

function extractUsername(source) {
  const s = String(source).trim();
  const isUrl = /^https?:\/\//i.test(s) || /^(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)\//i.test(s);
  if (isUrl) {
    const urlStr = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    try {
      const parts = new URL(urlStr).pathname.split("/").filter(Boolean);
      if (parts.length === 0) return null;
      const name = parts[0].replace(/^@+/, "");
      if (!name || RESERVED_PATHS.includes(name.toLowerCase()) || /^\d+$/.test(name) || !USERNAME_REGEX.test(name)) return null;
      return name;
    } catch (e) { return null; }
  }
  const name = s.replace(/^@+/, "");
  if (!name || RESERVED_PATHS.includes(name.toLowerCase()) || !USERNAME_REGEX.test(name)) return null;
  return name;
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return NaN;
  const raw = headerValue.trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
  const dt = Date.parse(raw);
  if (!Number.isNaN(dt)) { const delta = dt - Date.now(); return delta > 0 ? delta : NaN; }
  return NaN;
}

// ==========================================
// FxTwitter API
// ==========================================
async function fetchFxApi(url, retry = 3, timeoutMs = 30000) {
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    let res;
    try {
      const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/json" };
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { lastErr = e; if (attempt < retry) await new Promise(r => setTimeout(r, 1200)); continue; }
    if (res.status === 404) throw new Error("FxTwitter HTTP 404");
    if (res.status === 429) {
      let waitMs = Math.min(2000 * Math.pow(2, attempt), 5000);
      const raMs = parseRetryAfter(res.headers.get("Retry-After"));
      if (!Number.isNaN(raMs) && raMs > 0) waitMs = Math.min(raMs, 5000);
      lastErr = new Error("FxTwitter 限流");
      if (attempt < retry) await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`FxTwitter HTTP ${res.status}`);
      if (res.status >= 500 && attempt < retry) { await new Promise(r => setTimeout(r, 1200)); continue; }
      break;
    }
    try { return await res.json(); } catch (e) { lastErr = e; if (attempt < retry) await new Promise(r => setTimeout(r, 1200)); }
  }
  throw lastErr;
}

async function fetchFxTweet(tweetId, retry = 3) {
  const data = await fetchFxApi(`https://api.fxtwitter.com/2/status/${tweetId}`, retry);
  if (data.code !== 200 || !data.tweet) throw new Error("推文获取失败");
  return data.tweet;
}

async function fetchFxUserTimeline(screenName, retry = 3, timeoutMs = 30000) {
  const data = await fetchFxApi(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(screenName)}/statuses?count=100`, retry, timeoutMs);
  if (data.code !== 200) throw new Error("时间线获取失败");
  return Array.isArray(data.results) ? data.results : [];
}

async function fetchFxUserTimelinePaged(screenName, { maxId = null, retry = 1, timeoutMs = 8000 } = {}) {
  let url = `https://api.fxtwitter.com/2/profile/${encodeURIComponent(screenName)}/statuses?count=100`;
  if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
  const data = await fetchFxApi(url, retry, timeoutMs);
  if (data.code !== 200) throw new Error("时间线获取失败");
  const results = Array.isArray(data.results) ? data.results : [];
  const nextCursor = data.cursor?.bottom || data.next_cursor || null;
  return { results, nextCursor };
}

async function fetchFxUserTimelineByCursor(screenName, cursor = null, retry = 2, timeoutMs = 8000) {
  let url = `https://api.fxtwitter.com/2/profile/${encodeURIComponent(screenName)}/statuses?count=100`;
  if (cursor) { url += `&cursor=${encodeURIComponent(cursor)}`; }
  const data = await fetchFxApi(url, retry, timeoutMs);
  if (data.code !== 200) throw new Error("时间线获取失败");
  const results = Array.isArray(data.results) ? data.results : [];
  const nextCursor = data.cursor?.bottom || data.next_cursor || null;
  return { results, nextCursor };
}

async function fetchFxProfileName(screenName) {
  try { const targetScreen = screenName.toLowerCase(); const results = await fetchFxUserTimeline(screenName, 0, 4000); const match = results.find(t => t.author?.screen_name?.toLowerCase() === targetScreen); if (match?.author?.name) return match.author.name; } catch (e) {}
  return null;
}

async function fetchTgChatName(token, chatIdOrUsername) {
  try { const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatIdOrUsername }), signal: AbortSignal.timeout(10000) }); const data = await res.json(); if (data.ok && data.result) return data.result.title || data.result.username || null; } catch (e) {}
  return null;
}

// ==========================================
// 话题与 UI 辅助
// ==========================================
async function getOrCreateTopic(env, db, config, chatId, authorName, authorDisplay, writeQueue) {
  if (!chatId || !authorName) return null;
  const key = String(chatId); const uname = String(authorName).toLowerCase(); const cacheKey = `${key}_${uname}`;
  if (config.topicCache && config.topicCache[cacheKey]) return config.topicCache[cacheKey];
  const topicName = (authorDisplay ? `${authorDisplay} @${authorName}` : `@${authorName}`).slice(0, 128);
  let threadId = null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/createForumTopic`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: key, name: topicName }), signal: AbortSignal.timeout(30000) });
    const data = await res.json();
    if (!data.ok || !data.result?.message_thread_id) return null;
    threadId = data.result.message_thread_id;
  } catch (e) { return null; }
  if (!config.topicCache) config.topicCache = {};
  config.topicCache[cacheKey] = threadId;
  if (writeQueue && writeQueue.topics) writeQueue.topics.push({ key, uname, threadId });
  else { try { await db.prepare("INSERT OR REPLACE INTO user_topic_map (chat_id, username, thread_id, updated_at) VALUES (?, ?, ?, ?)").bind(key, uname, threadId, Date.now()).run(); } catch (e) {} }
  return threadId;
}

async function deleteTopicMapping(db, config, chatId, authorName) {
  const key = String(chatId); const uname = String(authorName).toLowerCase();
  try { await db.prepare("DELETE FROM user_topic_map WHERE chat_id = ? AND username = ?").bind(key, uname).run(); } catch (e) {}
  if (config && config.topicCache) delete config.topicCache[`${key}_${uname}`];
}

function isThreadInvalidError(message) {
  if (!message) return false; const m = String(message).toLowerCase();
  return m.includes("thread not found") || m.includes("topic_id_invalid") || m.includes("message thread not found") || m.includes("topic not found") || m.includes("topic_deleted");
}

function getGroupDisplayName(config, groupId) {
  const idStr = String(groupId); const maps = [config.targetGroupNames, config.manualOnlyGroupNames];
  for (const map of maps) { if (!map) continue; if (map[idStr]) return map[idStr]; const low = idStr.toLowerCase(); for (const k of Object.keys(map)) if (k.toLowerCase() === low) return map[k]; }
  return null;
}

function truncateBtnText(s, maxLen = 16) { if (!s) return ""; if (s.length <= maxLen) return s; return s.slice(0, maxLen - 1) + "..."; }
function getGroups(config) { return [...new Set(config.rssSources.map(s => s.group).filter(g => typeof g === "string" && g.trim()))].sort(); }
function getExportGroups(config) { return getGroups(config); }

function buildExportText(config, onlyGroupName = null) {
  const grouped = {}; for (const s of config.rssSources) { const g = s.group || DEFAULT_GROUP_NAME; if (onlyGroupName && g !== onlyGroupName) continue; if (!grouped[g]) grouped[g] = []; grouped[g].push(s.username); }
  const groupNames = Object.keys(grouped).sort(); if (groupNames.length === 0) return "";
  const now = new Date(); const pad = n => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
  let content = `# X转发机器人 ${BOT_VERSION} 监控源导出\n# 导出时间: ${ts}\n\n`;
  for (const g of groupNames) { content += `[${g}]\n`; for (const u of grouped[g]) content += `@${u}\n`; content += `\n`; }
  return content.trimEnd() + "\n";
}

function buildPickGroupKeyboard(config) {
  const groups = getGroups(config); const kb = []; kb.push([{ text: `📁 ${DEFAULT_GROUP_NAME}`, callback_data: "apick:d" }]);
  const nonDefault = groups.map((g, i) => ({ g, i })).filter(x => x.g !== DEFAULT_GROUP_NAME);
  for (let k = 0; k < nonDefault.length; k += 2) { const row = []; row.push({ text: `📁 ${nonDefault[k].g}`, callback_data: `apick:i:${nonDefault[k].i}` }); if (k + 1 < nonDefault.length) row.push({ text: `📁 ${nonDefault[k + 1].g}`, callback_data: `apick:i:${nonDefault[k + 1].i}` }); kb.push(row); }
  kb.push([{ text: "➕ 新建分组", callback_data: "apick:new" }], [{ text: "✖️ 取消", callback_data: "action:cancel" }]);
  return { inline_keyboard: kb };
}

function getMainKeyboard(config) {
  const mark = v => v ? "✅" : "❌";
  return {
    inline_keyboard: [
      [{ text: "⚙️ 转发规则", callback_data: "menu:rules" }, { text: "🔑 关键词过滤", callback_data: "menu:keyword" }],
      [{ text: "📝 前缀后缀", callback_data: "menu:affix" }, { text: "📡 监控源管理", callback_data: "menu:rss" }],
      [{ text: "🎯 群组管理", callback_data: "menu:group" }],
      [{ text: `${mark(config.disableVideoDowngrade)} 禁用大视频自动降级`, callback_data: "toggle:disableVideoDowngrade" }],
      [{ text: `${mark(config.skipEmptyText)} 无文字推文跳过空标题`, callback_data: "toggle:skipEmptyText" }],
      [{ text: `${mark(config.cronSummary)} Cron执行摘要通知`, callback_data: "toggle:cronSummary" }],
      [{ text: "▶️ 手动触发转发", callback_data: "action:run" }],
      [{ text: "📊 当前配置快照", callback_data: "action:status" }],
      [{ text: "🩺 系统诊断测试", callback_data: "action:debug_menu" }],
      [{ text: "🔓 强制解除任务锁", callback_data: "action:unlock_confirm" }],
      [{ text: "🗑️ 清空已转发记录", callback_data: "action:clear_kv" }],
      [{ text: "🧹 手动清理过期记录", callback_data: "action:clean_expired" }]
    ]
  };
}

function getPersistentReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "📁 监控源分组" }, { text: "👤 单人触发" }, { text: "⏪ 补历史" }],
      [{ text: "⚙️ 打开完整菜单" }, { text: "🔓 强制解除任务锁" }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "请点击上方按钮或发送命令"
  };
}

function getRulesKeyboard(config) {
  const mark = v => v ? "✅" : "❌";
  return {
    inline_keyboard: [
      [{ text: `${mark(config.filterRt)} 过滤RT/回复/非监控源`, callback_data: "toggle:filterRt" }],
      [{ text: `${mark(config.onlyPhoto)} 仅转发带图推文`, callback_data: "toggle:onlyPhoto" }],
      [{ text: `${mark(config.linkOnlyMode)} 纯链接转发模式`, callback_data: "toggle:linkOnlyMode" }],
      [{ text: `${mark(config.wholeWordFilter)} 关键词全词匹配`, callback_data: "toggle:wholeWordFilter" }],
      [{ text: `${mark(config.showSourceLabel)} 媒体标注博主来源`, callback_data: "toggle:showSourceLabel" }],
      [{ text: `🤖 自动单次：${config.maxItems} 条`, callback_data: "edit:maxItems" }],
      [{ text: `🖐 手动单次：${config.manualMaxItems} 条`, callback_data: "edit:manualMaxItems" }],
      [{ text: "↩️ 返回主菜单", callback_data: "menu:main" }]
    ]
  };
}

function getKeywordKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📖 查看白名单", callback_data: "list:whitelist" }, { text: "📖 查看黑名单", callback_data: "list:blacklist" }],
      [{ text: "➕ 添加白名单", callback_data: "add:whitelist" }, { text: "➕ 添加黑名单", callback_data: "add:blacklist" }],
      [{ text: "✂️ 删除白名单", callback_data: "del:whitelist" }, { text: "✂️ 删除黑名单", callback_data: "del:blacklist" }],
      [{ text: "♻️ 清空白名单", callback_data: "clear:whitelist" }, { text: "♻️ 清空黑名单", callback_data: "clear:blacklist" }],
      [{ text: "↩️ 返回主菜单", callback_data: "menu:main" }]
    ]
  };
}

function getAffixKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✏️ 设置前缀", callback_data: "edit:prefix" }, { text: "✏️ 设置后缀", callback_data: "edit:suffix" }],
      [{ text: "🗑️ 清空前缀", callback_data: "clear:prefix" }, { text: "🗑️ 清空后缀", callback_data: "clear:suffix" }],
      [{ text: "↩️ 返回主菜单", callback_data: "menu:main" }]
    ]
  };
}

function getRssKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📖 查看监控用户列表", callback_data: "list:rssSources" }],
      [{ text: "📁 分组管理", callback_data: "menu:group_manage" }],
      [{ text: "➕ 添加/移动监控用户", callback_data: "add:rssSources" }, { text: "✂️ 删除监控用户", callback_data: "del:rssSources" }],
      [{ text: "🔄 刷新所有用户昵称", callback_data: "action:refresh_names" }],
      [{ text: "📤 导出监控源", callback_data: "export:menu" }],
      [{ text: "♻️ 清空用户补抓断点", callback_data: "reset:menu" }],
      [{ text: "♻️ 清空监控源", callback_data: "clear:rssSources" }],
      [{ text: "↩️ 返回主菜单", callback_data: "menu:main" }]
    ]
  };
}

function getExportKeyboard(config) {
  const groups = getExportGroups(config); const total = config.rssSources.length; const kb = [];
  kb.push([{ text: `📦 全部导出 (${total}人)`, callback_data: "export:all" }]);
  for (let i = 0; i < groups.length; i += 2) {
    const row = []; const g0 = groups[i]; const c0 = config.rssSources.filter(s => (s.group || DEFAULT_GROUP_NAME) === g0).length;
    row.push({ text: `📁 ${truncateBtnText(g0, 10)} (${c0})`, callback_data: `export:group:${i}` });
    if (i + 1 < groups.length) { const g1 = groups[i + 1]; const c1 = config.rssSources.filter(s => (s.group || DEFAULT_GROUP_NAME) === g1).length; row.push({ text: `📁 ${truncateBtnText(g1, 10)} (${c1})`, callback_data: `export:group:${i + 1}` }); }
    kb.push(row);
  }
  kb.push([{ text: "↩️ 返回监控源", callback_data: "menu:rss" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]);
  return { inline_keyboard: kb };
}

function getGroupManageKeyboard(config) {
  const groups = getGroups(config); const kb = [];
  for (let i = 0; i < groups.length; i += 2) { const row = []; row.push({ text: `📁 ${groups[i]}`, callback_data: `gv:${i}` }); if (i + 1 < groups.length) row.push({ text: `📁 ${groups[i + 1]}`, callback_data: `gv:${i + 1}` }); kb.push(row); }
  kb.push([{ text: "↩️ 返回监控源", callback_data: "menu:rss" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]);
  return { inline_keyboard: kb };
}

function getGroupViewKeyboard(groupIdx) {
  return {
    inline_keyboard: [
      [{ text: "▶️ 触发本组 (发指定群)", callback_data: `rg:${groupIdx}` }],
      [{ text: "🎯 指定目标群触发本组", callback_data: `rgsg:${groupIdx}` }],
      [{ text: "🎯 设置自动转发目标群", callback_data: `grg:${groupIdx}` }],
      [{ text: "➕ 添加成员到本组", callback_data: `ag:${groupIdx}` }],
      [{ text: "✏️ 移动本组成员", callback_data: `gm:${groupIdx}:0` }],
      [{ text: "✏️ 重命名本组", callback_data: `gr:${groupIdx}` }],
      [{ text: "↩️ 返回分组列表", callback_data: "menu:group_manage" }],
      [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]
    ]
  };
}

function getGroupRouteKeyboard(config, groupName, groupIdx) {
  const routes = config.groupRoutes?.[groupName] || []; const kb = [];
  for (let i = 0; i < config.targetGroups.length; i++) {
    const g = String(config.targetGroups[i]); const name = getGroupDisplayName(config, g);
    const bound = routes.map(x => String(x).toLowerCase()).includes(g.toLowerCase());
    kb.push([{ text: `${bound ? "✅" : "❌"} ${truncateBtnText(name || g, 20)}`, callback_data: `grgt:${groupIdx}:${encodeURIComponent(g)}` }]);
  }
  kb.push([{ text: "♻️ 清空路由（走默认）", callback_data: `grgc:${groupIdx}` }], [{ text: "↩️ 返回分组", callback_data: `gv:${groupIdx}` }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]);
  return { inline_keyboard: kb };
}

function getGroupKeyboard(config) {
  const mark = v => v ? "✅" : "❌";
  return {
    inline_keyboard: [
      [{ text: `📤 自动转发群组 (${config.targetGroups?.length || 0})`, callback_data: "menu:group_auto" }],
      [{ text: `🖐 仅手动触发群组 (${config.manualOnlyGroups?.length || 0})`, callback_data: "menu:group_manual" }],
      [{ text: `${mark(config.autoCreateTopic)} 按用户自动创建话题`, callback_data: "toggle:autoCreateTopic" }],
      [{ text: "🔄 刷新所有群组名称", callback_data: "action:refresh_group_names" }],
      [{ text: "↩️ 返回主菜单", callback_data: "menu:main" }]
    ]
  };
}

function getAutoGroupKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📖 查看群组", callback_data: "list:targetGroups" }], [{ text: "➕ 添加群组", callback_data: "add:targetGroups" }],
      [{ text: "✂️ 删除群组", callback_data: "del:targetGroups" }], [{ text: "↩️ 返回群组管理", callback_data: "menu:group" }],
      [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]
    ]
  };
}

function getManualGroupKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📖 查看群组", callback_data: "list:manualGroups" }], [{ text: "➕ 添加群组", callback_data: "add:manualGroups" }],
      [{ text: "✂️ 删除群组", callback_data: "del:manualGroups" }], [{ text: "↩️ 返回群组管理", callback_data: "menu:group" }],
      [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]
    ]
  };
}

function getCancelKeyboard() {
  return { inline_keyboard: [[{ text: "✖️ 取消操作", callback_data: "action:cancel" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]] };
}

// ==========================================
// Bot 命令注册
// ==========================================
async function registerBotCommands(env) {
  const commands = [
    { command: "start", description: "重新召唤底部常驻面板" },
    { command: "backfill", description: "补历史推文 (DO后台执行)" },
    { command: "reset", description: "清空用户补抓断点" },
    { command: "unlock", description: "解除卡死锁" },
    { command: "status", description: "查看状态" },
    { command: "help", description: "使用帮助" }
  ];
  try { await sendTgApi(env.TG_BOT_TOKEN, "setMyCommands", { commands }); return true; } catch (e) { return false; }
}

// ==========================================
// Cron 定时主任务
// ==========================================
async function forwardTask(env) {
  const db = env.DB; if (!db) return "DB not configured";
  const now = Date.now(); const token = `${now}_${Math.random().toString(36).slice(2)}`; const expiresAt = now + TASK_LOCK_TTL * 1000;
  
  const lockResult = await db.prepare(`INSERT INTO cron_lock (id, token, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at WHERE cron_lock.expires_at < ?`).bind(token, expiresAt, now).run();
  
  if (lockResult.meta.changes === 0) {
    if (env.ADMIN_TG_ID) { try { await sendTgMessage(env.TG_BOT_TOKEN, env.ADMIN_TG_ID, "⚠️ 上一轮 cron 任务仍在执行。"); } catch (err) {} }
    return "⏳上一轮任务正在执行";
  }
  
  try {
    const config = await getConfig(db, env);
    if (config.__loadFailed) return "配置读取失败，跳过本次cron";
    if (!config.targetGroups?.length) return "未配置自动转发群组";
    if (!config.rssSources?.length) return "未配置监控用户";
    
    const keepDays = env.FORWARD_RECORDS_KEEP_DAYS ? parseInt(env.FORWARD_RECORDS_KEEP_DAYS, 10) : 0;
    await cleanExpiredForwardRecords(db, keepDays);
    
    const MAX_SOURCES_PER_RUN = env.MAX_SOURCES_PER_RUN ? parseInt(env.MAX_SOURCES_PER_RUN, 10) : 25;
    const MAX_TWEETS_PER_RUN = env.MAX_TWEETS_PER_RUN ? parseInt(env.MAX_TWEETS_PER_RUN, 10) : 5;
    const cursorRes = await db.prepare("SELECT username, last_tweet_id FROM source_cursors").all();
    const lastIds = {}; for (const row of cursorRes.results || []) lastIds[String(row.username).toLowerCase()] = String(row.last_tweet_id || "0");
    
    const sortedSources = [...config.rssSources].sort((a, b) => cmpTweetId(lastIds[a.username.toLowerCase()] || "0", lastIds[b.username.toLowerCase()] || "0"));
    
    let processedTweets = 0, processedSources = 0; const byGroup = {};
    for (let i = 0; i < sortedSources.length; i++) {
      if (processedSources >= MAX_SOURCES_PER_RUN) break;
      const s = sortedSources[i]; const g = s.group || DEFAULT_GROUP_NAME;
      if (!byGroup[g]) byGroup[g] = []; byGroup[g].push(s.username);
      processedSources++;
    }
    
    const lines = [];
    for (const [groupName, usernames] of Object.entries(byGroup)) {
      if (processedTweets >= MAX_TWEETS_PER_RUN) { lines.push(`[${groupName}] ⏳ 达到单次发推上限`); continue; }
      const routed = config.groupRoutes?.[groupName]; let target = null;
      if (Array.isArray(routed) && routed.length > 0) {
        const lowerAuto = config.targetGroups.map(x => String(x).toLowerCase());
        target = routed.map(String).find(id => lowerAuto.includes(id.toLowerCase())) || null;
      } else target = config.targetGroups[0] ? String(config.targetGroups[0]) : null;
      if (!target) continue;
      
      try {
        const res = await runTaskForSources(env, config, db, usernames, target, false, false, MAX_TWEETS_PER_RUN - processedTweets);
        processedTweets += res.okCount;
        lines.push(`[${groupName}] → 成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`);
      } catch (e) { lines.push(`[${groupName}] ❌ 异常：${e.message}`); }
    }
    
    const summary = lines.join("\n");
    if (env.ADMIN_TG_ID && summary && config.cronSummary) {
      try { await sendTgMessage(env.TG_BOT_TOKEN, env.ADMIN_TG_ID, `🤖 Cron 摘要\n${summary}`); } catch (e) {}
    }
    return summary;
  } finally { try { await db.prepare("DELETE FROM cron_lock WHERE id = 1 AND token = ?").bind(token).run(); } catch (e) {} }
}

// ==========================================
// 实时抓取源任务（Cron和手动触发使用）
// ==========================================
async function runTaskForSources(env, config, db, usernames, targetGroup, isManual = false, ignoreRoutes = false, totalLimit = null) {
  const results = { okCount: 0, skipCount: 0, failCount: 0, details: [] };
  if (!Array.isArray(usernames) || usernames.length === 0) return results;
  
  let lockToken = null;
  if (isManual) {
    const now = Date.now(); lockToken = `manual_${now}_${Math.random().toString(36).slice(2)}`; const expiresAt = now + TASK_LOCK_TTL * 1000;
    let lockAcquired = false;
    try { 
      const lockRes = await db.prepare(`INSERT INTO cron_lock (id, token, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at WHERE cron_lock.expires_at < ?`).bind(lockToken, expiresAt, now).run();
      lockAcquired = lockRes.meta.changes > 0; 
    } catch (e) {}
    if (!lockAcquired) { results.failCount = usernames.length; throw new Error("⚠️ 当前有其他任务正在执行，请稍后再试"); }
  }
  
  try {
    const perSourceDefault = isManual ? (Number(config.manualMaxItems) || 10) : (Number(config.maxItems) || 3);
    const cursorMap = {};
    try { 
      const placeholders = usernames.map(() => "?").join(",");
      const rows = await db.prepare(`SELECT username, last_tweet_id FROM source_cursors WHERE username IN (${placeholders})`).bind(...usernames.map(u => String(u).toLowerCase())).all(); 
      for (const r of rows.results || []) cursorMap[String(r.username).toLowerCase()] = String(r.last_tweet_id || "0"); 
    } catch (e) {}
    
    const writeQueue = { records: [], cursors: [], topics: [] };
    
    for (const rawUser of usernames) {
      if (totalLimit != null && results.okCount >= totalLimit) break;
      const username = String(rawUser); const low = username.toLowerCase();
      const currentTargetGroup = ignoreRoutes ? (targetGroup ? String(targetGroup) : null) : pickSingleTargetGroup(config, username, targetGroup ? [targetGroup] : []);
      if (!currentTargetGroup) { results.skipCount++; continue; }
      
      const fetchTimeout = isManual ? MANUAL_FETCH_TIMEOUT_MS : CRON_FETCH_TIMEOUT_MS;
      let timeline;
      try { timeline = await fetchFxUserTimeline(username, FETCH_RETRY_LIGHT, fetchTimeout); } catch (e) { results.failCount++; continue; }
      
      const authored = timeline.filter(t => { 
        const sn = t.author?.screen_name?.toLowerCase(); 
        if (sn === low) return true; 
        const rb = (t.reposted_by?.screen_name || t.retweeted_by?.screen_name || "").toLowerCase(); 
        return rb === low; 
      });
      if (authored.length === 0) continue;
      
      const sorted = authored.slice().sort((a, b) => cmpTweetId(a.id, b.id));
      
      if (isManual) {
        const newestFirst = sorted.slice(-200).reverse(); const manualStart = Date.now(); let successCount = 0;
        for (const tweet of newestFirst) {
          if (successCount >= perSourceDefault || (totalLimit != null && results.okCount >= totalLimit) || (Date.now() - manualStart > MANUAL_SCAN_TIMEOUT_MS)) break;
          try { 
            const res = await dispatchTweet(env, config, db, tweet, true, currentTargetGroup, null); 
            if (res.includes("成功")) { results.okCount++; successCount++; } 
            else if (res.includes("跳过") || res.includes("ℹ️")) results.skipCount++; 
            else results.failCount++; 
          } catch (e) { results.failCount++; }
        }
      } else {
        const lastId = cursorMap[low] || "0"; const candidates = sorted.filter(t => cmpTweetId(t.id, lastId) > 0);
        if (candidates.length === 0) continue;
        const remainingGlobal = totalLimit != null ? Math.max(0, totalLimit - results.okCount) : Infinity;
        const limitForSource = Math.min(perSourceDefault, remainingGlobal); if (limitForSource <= 0) break;
        const toProcess = candidates.slice(0, limitForSource); let lastProcessedId = lastId;
        for (const tweet of toProcess) {
          if (totalLimit != null && results.okCount >= totalLimit) break;
          let handled = false;
          try {
            const res = await dispatchTweet(env, config, db, tweet, false, currentTargetGroup, writeQueue);
            if (res.includes("成功")) { results.okCount++; handled = true; } 
            else if (res.includes("跳过") || res.includes("ℹ️")) { results.skipCount++; handled = true; } 
            else { results.failCount++; }
          } catch (e) { results.failCount++; }
          if (handled) lastProcessedId = String(tweet.id || lastProcessedId);
          else break;
        }
        if (cmpTweetId(lastProcessedId, lastId) > 0) { writeQueue.cursors.push({ username: low, last_tweet_id: lastProcessedId }); cursorMap[low] = lastProcessedId; }
      }
    }
    
    const stmts = [];
    for (const r of writeQueue.records) stmts.push(db.prepare("INSERT OR IGNORE INTO forward_records (tweet_id, chat_id, created_at) VALUES (?, ?, ?)").bind(String(r.id), String(r.groupId), Date.now()));
    for (const t of writeQueue.topics) stmts.push(db.prepare("INSERT OR REPLACE INTO user_topic_map (chat_id, username, thread_id, updated_at) VALUES (?, ?, ?, ?)").bind(t.key, t.uname, t.threadId, Date.now()));
    for (const c of writeQueue.cursors) stmts.push(db.prepare(`INSERT INTO source_cursors (username, last_tweet_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET last_tweet_id = excluded.last_tweet_id, updated_at = excluded.updated_at`).bind(c.username, c.last_tweet_id, Date.now()));
    
    for (let i = 0; i < stmts.length; i += 50) { try { await db.batch(stmts.slice(i, i + 50)); } catch (e) {} }
    return results;
  } finally { 
    if (lockToken) { try { await db.prepare("DELETE FROM cron_lock WHERE id = 1 AND token = ?").bind(lockToken).run(); } catch (e) {} } 
  }
}

// ==========================================
// 补历史任务（智能防卡死、自动跳过已发）
// ==========================================
async function backfillForSources(env, config, db, usernames, targetGroup, maxPerSource = BACKFILL_MAX_PER_SOURCE, onProgress = null) {
  const results = { okCount: 0, skipCount: 0, failCount: 0, details: [], timedOut: false, resumeFrom: null };
  if (!Array.isArray(usernames) || usernames.length === 0) return results;
  
  const startTime = Date.now();
  const writeQueue = { records: [], topics: [], cursors: [] };
  const flush = async (retry = 2) => {
    if (!writeQueue.records.length && !writeQueue.topics.length && !writeQueue.cursors.length) return true;
    const stmts = [];
    for (const r of writeQueue.records) stmts.push(db.prepare("INSERT OR IGNORE INTO forward_records (tweet_id, chat_id, created_at) VALUES (?, ?, ?)").bind(String(r.id), String(r.groupId), Date.now()));
    for (const t of writeQueue.topics) stmts.push(db.prepare("INSERT OR REPLACE INTO user_topic_map (chat_id, username, thread_id, updated_at) VALUES (?, ?, ?, ?)").bind(t.key, t.uname, t.threadId, Date.now()));
    for (const p of writeQueue.cursors) stmts.push(db.prepare(`INSERT INTO backfill_progress (username, oldest_sent_id, target_group, max_per_source, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET oldest_sent_id = excluded.oldest_sent_id, target_group = excluded.target_group, max_per_source = excluded.max_per_source, updated_at = excluded.updated_at`).bind(p.username, p.oldestId, p.targetGroup, p.max, Date.now()));
    for (let attempt = 0; attempt <= retry; attempt++) {
      try { 
        for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50)); 
        writeQueue.records = []; writeQueue.topics = []; writeQueue.cursors = []; return true; 
      } catch (e) { 
        if (attempt === retry) throw e; 
        await new Promise(r => setTimeout(r, 500 * (attempt + 1))); 
      }
    }
  };

  try {
    for (const rawUser of usernames) {
      if (Date.now() - startTime > 15000) { results.timedOut = true; results.details.push(`@${rawUser} ⏰时间耗尽中断`); break; }
      const username = String(rawUser);
      const low = username.toLowerCase();
      const currentTargetGroup = pickSingleTargetGroup(config, username, targetGroup ? [targetGroup] : []);
      if (!currentTargetGroup) { results.skipCount++; continue; }
      
      let resumeOldestId = "0";
      try {
        const row = await db.prepare("SELECT oldest_sent_id FROM backfill_progress WHERE username = ?").bind(low).first();
        if (row?.oldest_sent_id) resumeOldestId = String(row.oldest_sent_id);
      } catch (e) {}
      
      let allAuthored = [];
      let nextCursor = null;
      let pages = 0;
      let lastFetchErr = null;
      
      while (pages < BACKFILL_PAGE_COUNT) {
        if (Date.now() - startTime > 15000) { results.timedOut = true; break; }
        let pageData;
        try {
          pageData = await fetchFxUserTimelineByCursor(username, nextCursor, 2, BACKFILL_FETCH_TIMEOUT_MS);
        } catch (e) {
          lastFetchErr = e;
          if (/429|限流/.test(e.message)) {
            await new Promise(r => setTimeout(r, 3000));
            try { pageData = await fetchFxUserTimelineByCursor(username, nextCursor,1, BACKFILL_FETCH_TIMEOUT_MS); } 
            catch (e2) { lastFetchErr = e2; break; }
          } else { break; }
        }
        const raw = pageData.results || [];
        const authored = raw.filter(t => {
          const sn = t.author?.screen_name?.toLowerCase();
          if (sn === low) return true;
          const rb = (t.reposted_by?.screen_name || t.retweeted_by?.screen_name || "").toLowerCase();
          return rb === low;
        });
        if (authored.length === 0) break;
        
        const pageIds = new Set(authored.map(x => String(x.id)));
        const existingIds = new Set(allAuthored.map(x => String(x.id)));
        let allDup = true;
        for (const pid of pageIds) { if (!existingIds.has(pid)) { allDup = false; break; } }
        if (allDup) break;
        
        allAuthored = allAuthored.concat(authored);
        const oldestInPage = authored.reduce((m, t) => (cmpTweetId(t.id, m) < 0 ? String(t.id) : m), String(authored[0].id));
        if (resumeOldestId !== "0" && cmpTweetId(oldestInPage, resumeOldestId) <= 0) break;
        
        nextCursor = pageData.nextCursor;
        if (!nextCursor) break;
        pages++;
      }

      if (allAuthored.length === 0) { results.failCount++; continue; }
      
      const seen = new Set();
      let sortedDesc = allAuthored.filter(t => {
        const k = String(t.id);
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a, b) => cmpTweetId(b.id, a.id));
      
      if (resumeOldestId !== "0") {
        sortedDesc = sortedDesc.filter(t => cmpTweetId(t.id, resumeOldestId) < 0);
        if (sortedDesc.length === 0) continue;
      }
      sortedDesc = sortedDesc.slice(0, maxPerSource);
      
      let ok = 0, skip = 0, fail = 0, oldestProcessedId = resumeOldestId, flushCounter = 0, consecutiveFail = 0, progressCounter = 0;
      let consecutiveSkip = 0; 
      
      for (const tweet of sortedDesc) {
        if (Date.now() - startTime > 15000) {
          results.timedOut = true; results.details.push(`@${username} ⏰达到上限提前结束`); break;
        }
        
        // ★ 智能极速本地查重
        try {
          const already = await getAlreadySentChats(db, String(tweet.id), [currentTargetGroup]);
          if (already.has('*') || already.has(currentTargetGroup)) {
            skip++; results.skipCount++;
            if (cmpTweetId(tweet.id, oldestProcessedId) < 0) oldestProcessedId = String(tweet.id);
            consecutiveSkip++;
            if (consecutiveSkip >= 10) {
              results.details.push(`@${username} ⏩ 连续10条已发送，自动停止`);
              break; 
            }
            continue;
          }
        } catch (e) {}

        let res;
        try { res = await dispatchTweet(env, config, db, tweet, true, currentTargetGroup, writeQueue, { backfillFallback: true }); } 
        catch (e) { res = `❌ ${e.message}`; }

        if (res.includes("成功")) {
          ok++; results.okCount++;
          if (cmpTweetId(tweet.id, oldestProcessedId) < 0) oldestProcessedId = String(tweet.id);
          consecutiveFail = 0; consecutiveSkip = 0;
        } else if (res.includes("跳过") || res.includes("ℹ️")) {
          skip++; results.skipCount++;
          if (cmpTweetId(tweet.id, oldestProcessedId) < 0) oldestProcessedId = String(tweet.id);
          consecutiveFail = 0; consecutiveSkip++;
          if (consecutiveSkip >= 10) {
            results.details.push(`@${username} ⏩ 连续10条无有效内容，自动停止`);
            break;
          }
        } else {
          fail++; results.failCount++; consecutiveFail++;
          if (consecutiveFail >= 3) break;
        }

        progressCounter++; flushCounter++;
        if (flushCounter >= BACKFILL_FLUSH_EVERY || progressCounter >= 5) {
          flushCounter = 0; progressCounter = 0;
          try { await flush(); } catch (e) {}
          if (onProgress && !results.timedOut) {
            try { await onProgress({ user: username, done: ok + skip + fail, total: sortedDesc.length, ok, skip, fail }); } catch (e) {}
          }
        }
      }

      try { await flush(); } catch (e) {}
      if (cmpTweetId(oldestProcessedId, resumeOldestId) < 0) {
        writeQueue.cursors.push({ username: low, oldestId: oldestProcessedId, targetGroup: String(currentTargetGroup), max: maxPerSource });
        try { await flush(); } catch (e) {}
      }
      results.details.push(`@${username} ✅成功${ok} 跳过${skip} 失败${fail}`);
      if (results.timedOut) break;
    }
  } finally { try { await flush(); } catch (e) {} }
  return results;
}

// ==========================================
// Webhook 入口
// ==========================================
async function handleWebhook(request, env, ctx) {
  if (request.method !== "POST") {
    const url = new URL(request.url);
    if (url.pathname === "/init-commands") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 403 });
      const ok = await registerBotCommands(env);
      return new Response(ok ? "OK: commands registered" : "FAIL", { status: ok ? 200 : 500 });
    }
    return new Response(`X Forward Bot ${BOT_VERSION} Running`, { status: 200 });
  }
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 403 });
  const db = env.DB; if (!db) return new Response("DB not configured", { status: 500 });
  let update; try { update = await request.json(); } catch (e) { return new Response("Bad Request", { status: 200 }); }
  if (!update || typeof update !== "object") return new Response("OK", { status: 200 });
  
  if (update.callback_query) {
    ctx.waitUntil(handleCallback(update.callback_query, env, db).catch(e => console.error(e))); 
    return new Response("OK", { status: 200 }); 
  }
  
  const msg = update.message;
  if (!msg || !msg.text || msg.chat.type !== "private") return new Response("OK", { status: 200 });
  
  const userId = msg.from.id.toString();
  if (!env.ADMIN_TG_ID || userId !== env.ADMIN_TG_ID.toString()) { 
    await sendTgMessage(env.TG_BOT_TOKEN, msg.chat.id, "无权限使用此机器人");
    return new Response("OK", { status: 200 }); 
  }
  ctx.waitUntil(handlePrivateMessage(msg, env, db).catch(e => console.error(e)));
  return new Response("OK", { status: 200 });
}

// ==========================================
// 私聊消息与命令处理
// ==========================================
async function handlePrivateMessage(msg, env, db) {
  const chatId = msg.chat.id;
  let text = msg.text.trim();
  const session = await getAdminSession(db, msg.from.id);
  const config = await getConfig(db, env);

  if (text === "/start") {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    const welcomeText = `🤖 <b>X转发机器人 · DO版</b>\n\n👇 <b>常用操作已常驻在底部</b>\n1. 点击「▶️ 手动触发转发」\n2. 点击「👤 单人触发」\n3. 点击「⏪ 补历史」\n4. 点击「⚙️ 打开完整菜单」\n\n💡 每个源只发往绑定的目标群。`;
    await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", { chat_id: chatId, text: welcomeText, parse_mode: "HTML", reply_markup: getPersistentReplyKeyboard() });
    return;
  }

  if (text === "📁 监控源分组") {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    const groups = getGroups(config);
    if (groups.length === 0) {
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 你还没有添加任何监控源，暂无分组。", getMainKeyboard(config));
      return;
    }
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, "📁 请选择要查看的分组：", getGroupManageKeyboard(config));
    return;
  }

  if (text === "🔓 强制解除任务锁") {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    try {
      await db.prepare("DELETE FROM cron_lock").run();
      const idleJson = JSON.stringify({ op_mode: "idle" });
      await db.prepare("UPDATE admin_sessions SET op_mode = ?, updated_at = ?").bind(idleJson, Date.now()).run();
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, "✅ 任务锁及会话状态已强制重置！\n你现在可以重新点击触发或补抓了。", getMainKeyboard(config));
    } catch (e) {
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, `❌ 解除失败：${e.message}`, getMainKeyboard(config));
    }
    return;
  }

  if (text === "👤 单人触发") {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    if (config.rssSources.length === 0) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 你还没有监控用户。", getMainKeyboard(config)); return; }
    const limit = 10, list = config.rssSources, maxPage = Math.max(1, Math.ceil(list.length / limit)); const page = 0; const kb = [];
    for (let i = page * limit; i < Math.min((page + 1) * limit, list.length); i++) kb.push([{ text: `@${list[i].username} (${list[i].group})`, callback_data: `rsrc:${list[i].username}` }]);
    if (maxPage > 1) kb.push([{ text: "下一页 ➡️", callback_data: `rmsp:${page + 1}` }]);
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, "请选择要单人触发的监控源：", { inline_keyboard: kb });
    return;
  }

  if (text === "⏪ 补历史") {
    await setAdminSession(db, msg.from.id, { op_mode: "backfill_wait_user", pending_users: null });
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⏪ 请发送要补历史的 @用户名\n\n💡 发送格式：`@elonmusk`\n💡 默认扫描最近 30 条，支持断点续传。", getCancelKeyboard());
    return;
  }

  if (text === "⚙️ 打开完整菜单") {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, "🤖 请管理配置 👇", getMainKeyboard(config));
    return;
  }

  if (session.op_mode === "backfill_wait_user") {
    let targetUser = null;
    const tweetInfo = parseTweetUrl(text);
    if (tweetInfo && tweetInfo.username) targetUser = tweetInfo.username;
    else targetUser = text.replace(/^@+/, "").trim();
    if (!targetUser || !USERNAME_REGEX.test(targetUser)) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 用户名格式不正确。", getCancelKeyboard()); return; }
    await setAdminSession(db, msg.from.id, { op_mode: "idle" });
    text = `/backfill ${targetUser}`;
  }

  if (session.op_mode === "reset_wait_user") {
    let targetUser = text.replace(/^@+/, "").trim();
    if (!targetUser || !USERNAME_REGEX.test(targetUser)) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 用户名格式不正确。", getCancelKeyboard()); return; }
    await setAdminSession(db, msg.from.id, { op_mode: "idle" });
    text = `/reset ${targetUser}`;
  }

  if (session.op_mode === "debug_wait_user") {
    let targetUser = text.replace(/^@+/, "").trim();
    if (!targetUser || !USERNAME_REGEX.test(targetUser)) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 用户名格式不正确。", getCancelKeyboard()); return; }
    await setAdminSession(db, msg.from.id, { op_mode: "idle" });
    text = `/debug ${targetUser}`;
  }

  if (/^\/debug(?:\s+|$)/i.test(text)) {
    const parts = text.trim().split(/\s+/); const targetUser = parts[1] ? parts[1].replace(/^@+/, "") : null;
    if (!targetUser) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "用法：点击「🩺 系统诊断测试」"); return; }
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, `🔍 开始诊断 @${targetUser}...`);
    let log = [];
    try {
      log.push("1. 测试时间线接口...");
      const startFetch = Date.now(); const timeline = await fetchFxUserTimelinePaged(targetUser, { retry: 0, timeoutMs: 8000 });
      log.push(`✅ 接口请求成功，耗时 ${Date.now() - startFetch}ms`);
      log.push(`获取到原始推文：${timeline.results.length} 条`);
      log.push(`NextCursor: ${timeline.nextCursor || "无"}`);
      if (timeline.results.length > 0) {
        const first = timeline.results[0];
        log.push(`第一条推文 ID: ${first.id}`); log.push(`作者: @${first.author?.screen_name}`);
        log.push(`图片数量: ${(first.media?.photos || []).length}`);
      } else log.push("⚠️ 接口返回了 0 条推文");
      log.push("\n2. 测试目标群组解析...");
      const tg = pickSingleTargetGroup(config, targetUser, config.targetGroups);
      log.push(`解析到的目标群: ${tg || "❌ 未找到"}`);
    } catch (e) { log.push(`❌ 发生异常: ${e.message}`); }
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, `🩺 诊断结果：\n\n${log.join("\n")}`);
    return;
  }

  if (/^\/unlock(?:\s+|$)/i.test(text)) {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    try { await db.prepare("DELETE FROM cron_lock").run(); await db.prepare("UPDATE admin_sessions SET op_mode = ?, updated_at = ?").bind(JSON.stringify({ op_mode: "idle" }), Date.now()).run();
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, "✅ 任务锁已强制重置！", getMainKeyboard(config)); 
    } catch (e) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, `❌ 解除失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (/^\/status(?:\s+|$)/i.test(text)) {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    const keepDays = env.FORWARD_RECORDS_KEEP_DAYS ? parseInt(env.FORWARD_RECORDS_KEEP_DAYS, 10) : 0;
    const namedCount = Object.keys(config.targetGroupNames || {}).length;
    const status = `📊 配置快照 ${BOT_VERSION}\n📡 监控用户：${config.rssSources.length} 个\n📤 自动转发群组：${config.targetGroups.length} 个（${namedCount} 个有名称）\n🖐 仅手动触发群组：${config.manualOnlyGroups.length} 个\n🎯 分组路由：${Object.keys(config.groupRoutes || {}).length} 个分组已配置\n📌 自动创建话题：${config.autoCreateTopic ? "开启" : "关闭"}\n🔔 Cron摘要：${config.cronSummary ? "开启" : "关闭"}\n🔑 白名单：${config.whitelist.length} 个\n🔑 黑名单：${config.blacklist.length} 个\n⚙️ 仅带图：${config.onlyPhoto ? "开启" : "关闭"}\n⚙️ 纯链接：${config.linkOnlyMode ? "开启" : "关闭"}\n⚙️ 过滤RT：${config.filterRt ? "开启" : "关闭"}\n📦 自动单次：${config.maxItems} 条\n🖐 手动单次：${config.manualMaxItems} 条\n⏪ 补历史命令：/backfill 用户名 [reset]\n♻️ 清断点命令：/reset 用户名\n🧹 记录清理：${keepDays > 0 ? `保留 ${keepDays} 天` : "关闭"}`;
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, status, getMainKeyboard(config));
    return;
  }

  if (/^\/help(?:\s+|$)/i.test(text)) {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, "📖 使用说明\n\n/start 召唤面板\n/backfill 用户名 [reset] 补历史 (DO异步执行)\n/reset 用户名 清空补抓断点\n/unlock 解卡死\n\n💡 直接发推文链接可单条转发\n💡 发 @用户名 抓最新", getMainKeyboard(config));
    return;
  }

  if (/^\/reset(?:\s+|$)/i.test(text)) {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    const parts = text.trim().split(/\s+/);
    const targetUser = parts[1] ? parts[1].replace(/^@+/, "") : null;

    if (!targetUser) {
      await setAdminSession(db, msg.from.id, { op_mode: "reset_wait_user", pending_users: null });
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, "♻️ 请发送要清空补抓断点的 @用户名\n\n💡 发送格式：`@elonmusk`\n💡 将删除该用户的补抓进度记录，下次补抓从最新推文重新开始", getCancelKeyboard());
      return;
    }
    if (!USERNAME_REGEX.test(targetUser)) {
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 用户名格式不正确", getMainKeyboard(config));
      return;
    }
    try {
      const res = await db.prepare("DELETE FROM backfill_progress WHERE LOWER(username) = LOWER(?)").bind(targetUser).run();
      const deleted = (res.meta && res.meta.changes) || 0;
      await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null, lastBackfill: { username: targetUser, max: BACKFILL_MAX_PER_SOURCE } });
      const backfillKb = { inline_keyboard: [[{ text: "🔁 立即补抓", callback_data: "action:repeat_backfill" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]] };
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, `✅ 已清空 @${targetUser} 的补抓断点记录（${deleted} 条）\n💡 下次补抓将从最新推文重新开始。`, backfillKb);
    } catch (e) {
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, `❌ 清空失败：${e.message}`, getMainKeyboard(config));
    }
    return;
  }

  if (/^\/backfill(?:\s+|$)/i.test(text)) {
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
    const parts = text.trim().split(/\s+/);
    const targetUser = parts[1] ? parts[1].replace(/^@+/, "") : null;
    if (!targetUser) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "用法：/backfill 用户名 [条数] [reset]", getMainKeyboard(config)); return; }
    if (!USERNAME_REGEX.test(targetUser)) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 用户名格式不正确", getMainKeyboard(config)); return; }
    if (!config.targetGroups || config.targetGroups.length === 0) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 未配置自动转发群组，无法补历史", getMainKeyboard(config)); return; }
    
    let maxPerSource = BACKFILL_MAX_PER_SOURCE, resetProgress = false;
    if (parts[2]) {
      if (parts[2].toLowerCase() === "reset") resetProgress = true;
      else {
        const n = parseInt(parts[2], 10);
        if (!isNaN(n) && n >= 1 && n <= 100) maxPerSource = n;
        else { await sendTgMessage(env.TG_BOT_TOKEN, chatId, `⚠️ 扫描条数需为 1--100 之间的整数，或 reset`, getMainKeyboard(config)); return; }
      }
    }
    if (parts[3]?.toLowerCase() === "reset") resetProgress = true;
    if (resetProgress) { try { await db.prepare("DELETE FROM backfill_progress WHERE LOWER(username) = LOWER(?)").bind(targetUser).run(); } catch (e) {} }
    
    const targetGroup = pickSingleTargetGroup(config, targetUser, config.targetGroups);
    if (!targetGroup) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, `⚠️ @${targetUser} 未解析到可用目标群。`, getMainKeyboard(config)); return; }
    
    await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null, lastBackfill: { username: targetUser, max: maxPerSource } });
    
    try {
      const doId = env.TASK_DO.idFromName("global_task");
      const doStub = env.TASK_DO.get(doId);
      const doRes = await doStub.fetch("https://do/run-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, chatId, targetUser, targetGroup, maxPerSource }),
      });
      const doJson = await doRes.json();
      if (!doJson.ok) {
        await sendTgMessage(env.TG_BOT_TOKEN, chatId, `${doJson.msg}`, getMainKeyboard(config));
        return;
      }
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, `⏪ 任务已提交后台执行，请稍候...\n目标：@${targetUser} 最近 ${maxPerSource} 条\n💡 你可以关闭对话，抓取完成后机器人会自动通知。`);
    } catch (e) {
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, `❌ 任务提交失败：${e.message}`, getMainKeyboard(config));
    }
    return;
  }

  if (session.op_mode && session.op_mode !== "idle") { await handleSessionInput(msg, env, db, config, session); return; }

  const tweetInfo = parseTweetUrl(text);
  if (tweetInfo) {
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, "🔍 正在解析推文并下载媒体...");
    try {
      const tweet = await fetchFxTweet(tweetInfo.tweetId);
      const targetGroup = pickSingleTargetGroup(config, tweet.author?.screen_name || "", config.targetGroups);
      if (!targetGroup) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 未解析到可用目标群。", getMainKeyboard(config)); return; }
      const result = await dispatchTweet(env, config, db, tweet, true, targetGroup, null, { ignoreOnlyPhoto: true });
      await sendTgMessage(env.TG_BOT_TOKEN, chatId, result, getMainKeyboard(config));
    } catch (e) {
      if (tweetInfo.username || tweetInfo.tweetId) {
        const fxHost = env.FXEMBED_DOMAIN || "fxtwitter.com"; const fxUrl = tweetInfo.username ? `https://${fxHost}/${tweetInfo.username}/status/${tweetInfo.tweetId}` : `https://x.com/i/web/status/${tweetInfo.tweetId}`; let success = 0;
        const targetGroup = tweetInfo.username ? pickSingleTargetGroup(config, tweetInfo.username, config.targetGroups) : (config.targetGroups[0] ? String(config.targetGroups[0]) : null);
        if (targetGroup) {
          try { 
            const already = await getAlreadySentChats(db, tweetInfo.tweetId, [targetGroup]); 
            if (!already.has(targetGroup) && !already.has("*")) { 
              await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", { chat_id: targetGroup, text: `${config.prefix}${fxUrl}${config.suffix}`, disable_web_page_preview: false }); 
              await recordForwarded(db, tweetInfo.tweetId, targetGroup); success = 1; 
            } else success = 1; 
          } catch (err) {}
        }
        if (success > 0) await sendTgMessage(env.TG_BOT_TOKEN, chatId, `✅ 原推受成人内容限制，已自动降级为纯链接发送到 ${targetGroup}`, getMainKeyboard(config));
        else await sendTgMessage(env.TG_BOT_TOKEN, chatId, `❌ 解析失败，且纯链接发送也失败。`, getMainKeyboard(config));
      } else await sendTgMessage(env.TG_BOT_TOKEN, chatId, `❌ ${e.message}`, getMainKeyboard(config));
    }
    return;
  }

  if (/\/(?:status|photo|video|media)\//i.test(text)) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 无法解析该推文链接。", getMainKeyboard(config)); return; }

  const profileMatch = text.match(/^(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)(?:\/[^?#]*)?(?:[?#].*)?$/i);
  if (profileMatch) {
    const username = profileMatch[1];
    if (RESERVED_PATHS.includes(username.toLowerCase()) || /^\d+$/.test(username) || !USERNAME_REGEX.test(username)) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 无法将系统页面添加为监控源", getMainKeyboard(config)); return; }
    const isExist = config.rssSources.some(s => s.username.toLowerCase() === username.toLowerCase());
    if (isExist) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, `ℹ️ @${username} 已经在监控列表中了`, getMainKeyboard(config)); return; }
    config.rssSources.push({ username, group: DEFAULT_GROUP_NAME });
    try { await saveConfig(db, config); } catch (e) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, `⚠️ 保存失败：${e.message}`, getMainKeyboard(config)); return; }
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, `✅ 已添加 @${username} 到 [${DEFAULT_GROUP_NAME}]\n💡 请去监控源管理点「🔄 刷新所有用户昵称」`, getMainKeyboard(config));
    return;
  }

  const isAtInput = text.startsWith("@"); const isGetInput = /^\/get(?:\s+|$)/i.test(text);
  let tempUser = "";
  if (isAtInput) tempUser = (text.slice(1).trim().split(/\s+/)[0] || "");
  else if (isGetInput) tempUser = (text.replace(/^\/get\s*/i, "").trim().split(/\s+/)[0] || "").replace(/^@+/, "");
  
  if (isAtInput || isGetInput) {
    if (!tempUser) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 请发送 @用户名 或 /get 用户名", getMainKeyboard(config)); return; }
    if (!USERNAME_REGEX.test(tempUser)) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 用户名格式不正确", getMainKeyboard(config)); return; }
    const sourceCheck = config.rssSources.find(s => s.username.toLowerCase() === tempUser.toLowerCase());
    if (!sourceCheck) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, `⚠️ @${tempUser} 不在监控源列表中。请先添加。`, getMainKeyboard(config)); return; }
    const targetGroup = pickSingleTargetGroup(config, tempUser, config.targetGroups);
    if (!targetGroup) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, `⚠️ @${tempUser} 未解析到目标群。`, getMainKeyboard(config)); return; }
    await sendTgMessage(env.TG_BOT_TOKEN, chatId, `🔍 正在获取 @${tempUser} 的最新推文（已发过的跳过）...`);
    try {
      const results = await fetchFxUserTimeline(tempUser, FETCH_RETRY_LIGHT, MANUAL_FETCH_TIMEOUT_MS);
      const validResults = results.filter(t => t.author?.screen_name?.toLowerCase() === tempUser.toLowerCase());
      if (validResults.length > 0) {
        const limit = Number(config.manualMaxItems) > 0 ? Number(config.manualMaxItems) : 10;
        const sorted = validResults.slice().sort((a, b) => cmpTweetId(a.id, b.id));
        const tweets = sorted.slice(-limit); let count = 0;
        for (const tweet of tweets) { try { const res = await dispatchTweet(env, config, db, tweet, true, targetGroup, null, { ignoreOnlyPhoto: true }); if (res.includes("成功")) count++; } catch (err) {} }
        await sendTgMessage(env.TG_BOT_TOKEN, chatId, `✅ 抓取完成：成功转发 ${count} 条`, getMainKeyboard(config));
      } else await sendTgMessage(env.TG_BOT_TOKEN, chatId, `⚠️ 未找到推文`, getMainKeyboard(config));
    } catch (e) { await sendTgMessage(env.TG_BOT_TOKEN, chatId, `❌ 抓取失败: ${e.message}`, getMainKeyboard(config)); }
    return;
  }

  await sendTgMessage(env.TG_BOT_TOKEN, chatId, "请使用按钮操作，发送 /start 打开主菜单", getMainKeyboard(config));
}
async function handleCallback(cbq, env, db) {
  const data = cbq.data || ""; const userId = cbq.from.id.toString();
  const answer = async (text = "", showAlert = false) => { try { await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: cbq.id, text, show_alert: showAlert }), signal: AbortSignal.timeout(15000) }); } catch (e) {} };

  if (!env.ADMIN_TG_ID || userId !== env.ADMIN_TG_ID.toString()) { await answer("无权限"); return; }
  if (!cbq.message) { await answer("请从私聊菜单操作"); return; }
  const chatId = cbq.message.chat.id; const messageId = cbq.message.message_id;
  await setAdminSession(db, userId, { op_mode: "idle" });
  let config = await getConfig(db, env);

  const editMsg = async (text, kb) => {
    try {
      let safeText = text; if (typeof safeText === "string" && safeText.length > 3900) safeText = safeText.slice(0, 3900) + "\n...（已截断）";
      const body = { chat_id: chatId, message_id: messageId, text: safeText };
      if (kb === null) body.reply_markup = { inline_keyboard: [] }; else if (kb !== undefined) body.reply_markup = kb;
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    } catch (e) {}
  };

  const save = async () => { try { await saveConfig(db, config); return true; } catch (e) { await editMsg(`⚠️ 保存失败：${e.message}`, getMainKeyboard(config)); await answer("保存失败", true); return false; } };

  const needsTargetGroups = /^(action:run_all|rg:|rgsg:|rda:|rdg:|rsrc:|rsg:)/.test(data);
  if (needsTargetGroups && (!config.targetGroups || config.targetGroups.length === 0)) { await answer("未配置目标群组"); await editMsg("⚠️ 请先在「📤 自动转发群组」中添加至少一个群", getMainKeyboard(config)); return; }

  if (data === "action:clean_expired") {
    await answer("正在清理..."); const keepDays = env.FORWARD_RECORDS_KEEP_DAYS ? parseInt(env.FORWARD_RECORDS_KEEP_DAYS, 10) : 0;
    if (keepDays <= 0) { await editMsg("⚠️ 未配置保留天数。", getMainKeyboard(config)); return; }
    const ret = await cleanExpiredForwardRecords(db, keepDays);
    await editMsg(`✅ 清理完成\n本次删除过期记录：${ret.deleted} 条`, getMainKeyboard(config));
    return;
  }

  if (data === "reset:menu" || data.startsWith("reset:do:")) {
    const renderResetMenu = async () => {
      let list = [];
      try {
        const rows = await db.prepare("SELECT username, oldest_sent_id, updated_at FROM backfill_progress ORDER BY updated_at DESC").all();
        list = rows.results || [];
      } catch (e) {}
      if (list.length === 0) { await editMsg("📭 当前没有任何用户的补抓断点记录。", getRssKeyboard()); return; }
      const kb = [];
      for (let i = 0; i < list.length; i += 2) {
        const row = [{ text: `♻️ @${list[i].username}`, callback_data: `reset:do:${list[i].username}` }];
        if (i + 1 < list.length) row.push({ text: `♻️ @${list[i + 1].username}`, callback_data: `reset:do:${list[i + 1].username}` });
        kb.push(row);
      }
      kb.push([{ text: "↩️ 返回监控源", callback_data: "menu:rss" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]);
      await editMsg(`♻️ 补抓断点管理\n共 ${list.length} 个用户有断点记录\n点击用户名即可清空其断点：`, { inline_keyboard: kb });
    };

    if (data === "reset:menu") { await answer(); await renderResetMenu(); return; }

    if (data.startsWith("reset:do:")) {
      const username = data.slice("reset:do:".length);
      try {
        const res = await db.prepare("DELETE FROM backfill_progress WHERE LOWER(username) = LOWER(?)").bind(username).run();
        const deleted = (res.meta && res.meta.changes) || 0;
        await answer(`✅ 已清空 @${username} 的 ${deleted} 条断点`);
        await setAdminSession(db, userId, { op_mode: "idle", pending_users: null, lastBackfill: { username: username, max: BACKFILL_MAX_PER_SOURCE } });
        const backfillKb = { inline_keyboard: [[{ text: "🔁 立即补抓", callback_data: "action:repeat_backfill" }], [{ text: "↩️ 返回列表", callback_data: "reset:menu" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]] };
        await editMsg(`✅ 已清空 @${username} 的补抓断点（${deleted} 条）`, backfillKb);
      } catch (e) { await answer(`❌ 清空失败: ${e.message}`, true); await renderResetMenu(); }
      return;
    }
  }

  if (data === "action:repeat_backfill") {
    const sess = await getAdminSession(db, userId); const bf = sess.lastBackfill;
    if (!bf || !bf.username || !USERNAME_REGEX.test(bf.username)) {
      await answer("暂无有效记录，请手动补抓"); await editMsg("⚠️ 暂无有效上次补抓记录", getMainKeyboard(config)); return;
    }
    if (!config.targetGroups || config.targetGroups.length === 0) {
      await answer("未配置目标群组"); await editMsg("⚠️ 未配置自动转发群组", getMainKeyboard(config)); return;
    }
    const targetGroup = pickSingleTargetGroup(config, bf.username, config.targetGroups);
    if (!targetGroup) { await answer("未解析到目标群"); await editMsg("⚠️ 未解析到可用目标群", getMainKeyboard(config)); return; }

    await answer("⏳ 复用上次参数开始补抓");
    try {
      const doId = env.TASK_DO.idFromName("global_task");
      const doStub = env.TASK_DO.get(doId);
      const doRes = await doStub.fetch("https://do/run-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, chatId, targetUser: bf.username, targetGroup, maxPerSource: bf.max }),
      });
      const doJson = await doRes.json();
      if (!doJson.ok) { await editMsg(`${doJson.msg}`, getMainKeyboard(config)); return; }
      await editMsg(`⏪ 复用上次参数，扫描 @${bf.username} 最近 ${bf.max} 条（目标群：${targetGroup}）...\n💡 后台执行中，完成后自动通知。`, null);
    } catch (e) { await editMsg(`❌ 提交失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data === "export:menu") {
    await answer(); if (config.rssSources.length === 0) { await editMsg("⚠️ 暂无监控源可导出", getRssKeyboard()); return; }
    await editMsg(`📤 导出监控源\n共 ${config.rssSources.length} 个，请选择导出范围：`, getExportKeyboard(config));
    return;
  }

  if (data === "export:all") {
    await answer("正在生成..."); if (config.rssSources.length === 0) { await editMsg("⚠️ 暂无监控源", getRssKeyboard()); return; }
    const content = buildExportText(config, null);
    if (content.length <= 3500) await editMsg(content, getExportKeyboard(config));
    else {
      await editMsg("⏳ 正在生成导出文件...", null);
      try { 
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" }); 
        await tgUploadForm(env.TG_BOT_TOKEN, "sendDocument", () => { 
          const fd = new FormData(); fd.append("chat_id", String(chatId)); fd.append("document", blob, `sources_all_${Date.now()}.txt`); fd.append("caption", `✅ 全部监控源导出`); return fd; 
        }); 
        await editMsg("✅ 已导出全部监控源", getExportKeyboard(config)); 
      } catch (e) { await editMsg(`⚠️ 导出失败：${e.message}`, getExportKeyboard(config)); }
    }
    return;
  }

  if (data.startsWith("export:group:")) {
    const idx = parseInt(data.slice("export:group:".length), 10); const groups = getExportGroups(config);
    if (isNaN(idx) || idx < 0 || idx >= groups.length) { await answer("分组不存在或已变化"); return; }
    const groupName = groups[idx]; const count = config.rssSources.filter(s => (s.group || DEFAULT_GROUP_NAME) === groupName).length;
    if (count === 0) { await answer("该分组没有成员"); return; }
    await answer("正在生成..."); const content = buildExportText(config, groupName);
    if (content.length <= 3500) await editMsg(content, getExportKeyboard(config));
    else {
      await editMsg("⏳ 正在生成导出文件...", null);
      try { 
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" }); 
        await tgUploadForm(env.TG_BOT_TOKEN, "sendDocument", () => { 
          const fd = new FormData(); fd.append("chat_id", String(chatId)); fd.append("document", blob, `sources_group_${Date.now()}.txt`); fd.append("caption", `✅ 分组导出`); return fd; 
        }); 
        await editMsg(`✅ 已导出分组 [${groupName}]`, getExportKeyboard(config)); 
      } catch (e) { await editMsg(`⚠️ 导出失败：${e.message}`, getExportKeyboard(config)); }
    }
    return;
  }

  if (data === "action:refresh_names") {
    await answer("正在刷新..."); await editMsg("⏳ 正在更新...", null);
    const list = config.rssSources; if (list.length === 0) { await editMsg("⚠️ 暂无监控用户", getRssKeyboard()); return; }
    const missing = list.filter(u => !config.sourceNames[u.username.toLowerCase()]);
    if (missing.length === 0) { await editMsg("✅ 所有监控源都已有昵称！", getRssKeyboard()); return; }
    const toProcess = missing.slice(0, 30); let updated = 0, processed = 0;
    for (let i = 0; i < toProcess.length; i += 6) {
      const batch = toProcess.slice(i, i + 6);
      const results = await Promise.all(batch.map(async (u) => ({ username: u.username, nick: await fetchFxProfileName(u.username) })));
      for (const r of results) { if (r.nick) { config.sourceNames[r.username.toLowerCase()] = r.nick; await updateNicknameDirect(db, r.username, r.nick); updated++; } processed++; }
      try { await editMsg(`⏳ 正在更新... ${processed}/${toProcess.length}（已更新 ${updated}）`, null); } catch (e) {}
    }
    const nextRemaining = config.rssSources.filter(u => !config.sourceNames[u.username.toLowerCase()]).length;
    let msg = `✅ 本轮完成：成功更新 ${updated} 个`;
    if (nextRemaining > 0) msg += `\n- 还有 ${nextRemaining} 个无昵称，请再点一次。`; else msg += `\n- 全部监控源都已成功获取昵称！`;
    await editMsg(msg, getRssKeyboard());
    return;
  }

  if (data === "action:refresh_group_names") {
    await answer("正在刷新..."); await editMsg("⏳ 正在更新群组名称...", null);
    if (!config.targetGroupNames) config.targetGroupNames = {}; if (!config.manualOnlyGroupNames) config.manualOnlyGroupNames = {};
    const all = [...config.targetGroups.map(g => ({ g: String(g), type: "auto" })), ...config.manualOnlyGroups.map(g => ({ g: String(g), type: "manual" }))];
    if (all.length === 0) { await editMsg("⚠️ 暂无群组", getGroupKeyboard(config)); return; }
    let updated = 0, processed = 0;
    for (let i = 0; i < all.length; i += 5) {
      const batch = all.slice(i, i + 5);
      const results = await Promise.all(batch.map(async ({ g, type }) => ({ g, type, name: await fetchTgChatName(env.TG_BOT_TOKEN, g) })));
      for (const r of results) { if (r.name) { if (r.type === "auto") config.targetGroupNames[r.g] = r.name; else config.manualOnlyGroupNames[r.g] = r.name; try { await db.prepare("UPDATE target_groups SET group_name = ? WHERE chat_id = ? AND type = ?").bind(r.name, r.g, r.type).run(); updated++; } catch (e) {} } processed++; }
      try { await editMsg(`⏳ 正在更新... ${processed}/${all.length}（已更新 ${updated}）`, null); } catch (e) {}
    }
    await editMsg(`✅ 完成：更新了 ${updated} 个群组名称`, getGroupKeyboard(config));
    return;
  }

  if (data.startsWith("apick:")) {
    const parts = data.split(":"); const sub = parts[1];
    const sess = await getAdminSession(db, userId); const pendingUsers = sess.pending_users || [];
    if (pendingUsers.length === 0) { await answer("没有待处理的用户"); await editMsg("⚠️ 请重新发起添加操作", getMainKeyboard(config)); return; }
    if (sub === "new") { await setAdminSession(db, userId, { op_mode: "add:rssSources:newgroup", pending_users: pendingUsers }); await answer(); await editMsg(`请发送新组名（最长 ${GROUP_NAME_MAX_LEN} 字符）：`, getCancelKeyboard()); return; }
    let targetGroupName;
    if (sub === "d") targetGroupName = DEFAULT_GROUP_NAME;
    else if (sub === "i") { const idx = parseInt(parts[2], 10); const groups = getGroups(config); if (isNaN(idx) || idx < 0 || idx >= groups.length) { await answer("分组不存在或已变化"); return; }
      targetGroupName = groups[idx]; } else { await answer("未知选择"); return; }
    let added = 0, moved = 0;
    for (const u of pendingUsers) {
      const existing = config.rssSources.find(s => s.username.toLowerCase() === u.username.toLowerCase());
      if (existing) { if (existing.group !== targetGroupName) { existing.group = targetGroupName; moved++; } continue; }
      config.rssSources.push({ username: u.username, group: targetGroupName }); added++;
    }
    if (!(await save())) return;
    await setAdminSession(db, userId, { op_mode: "idle", pending_users: null }); await answer(`✅ 已处理到 [${targetGroupName}]`);
    let replyMsg = `✅ 已处理到 [${targetGroupName}]：\n`; if (added > 0) replyMsg += `- 新增 ${added} 个\n`; if (moved > 0) replyMsg += `- 移动 ${moved} 个\n`; replyMsg += `当前共 ${config.rssSources.length} 个监控源`;
    if (added > 0) replyMsg += `\n💡 暂未拉取昵称，请点「🔄 刷新所有用户昵称」`;
    await editMsg(replyMsg, getMainKeyboard(config));
    return;
  }

  if (data === "menu:group_manage") {
    const groups = getGroups(config); if (groups.length === 0) { await answer("暂无分组"); await editMsg("⚠️ 暂无分组。", getRssKeyboard()); return; }
    await answer(); await editMsg("📁 请选择要查看的分组：", getGroupManageKeyboard(config)); return;
  }

  if (data.startsWith("gv:")) {
    const groupIdx = parseInt(data.slice(3), 10); const groups = getGroups(config); if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    const groupName = groups[groupIdx]; const members = config.rssSources.filter(s => s.group === groupName);
    let content = `📁 【${groupName}】成员 (${members.length}人)：\n`;
    members.forEach((m) => { const idx = config.rssSources.findIndex(x => x.username.toLowerCase() === m.username.toLowerCase()) + 1; const nick = config.sourceNames?.[m.username.toLowerCase()] ? ` (${config.sourceNames[m.username.toLowerCase()]})` : ""; content += `${idx}. @${m.username}${nick}\n`; });
    const routes = config.groupRoutes?.[groupName];
    if (Array.isArray(routes) && routes.length > 0) content += `\n🎯 自动转发：${routes.map(g => { const n = getGroupDisplayName(config, g); return n ? `${n}(${g})` : g; }).join("、")}`; else content += `\n🎯 自动转发：默认`;
    await answer(); await editMsg(content + "\n", getGroupViewKeyboard(groupIdx)); return;
  }

  if (data.startsWith("grg:")) {
    const groupIdx = parseInt(data.slice(4), 10); const groups = getGroups(config); if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    if (config.targetGroups.length === 0) { await answer("未配置自动转发群组"); await editMsg("⚠️ 请先添加自动转发群组", getMainKeyboard(config)); return; }
    const groupName = groups[groupIdx]; const routes = config.groupRoutes?.[groupName] || [];
    const routeDesc = routes.length > 0 ? routes.map(g => { const n = getGroupDisplayName(config, g); return n ? `${n}(${g})` : g; }).join("\n") : "未绑定，走默认（自动群组第一个）";
    await answer(); await editMsg(`📁 [${groupName}] 自动转发目标\n\n当前：\n${routeDesc}\n\n点击下方按钮切换绑定：`, getGroupRouteKeyboard(config, groupName, groupIdx)); return;
  }

  if (data.startsWith("grgt:")) {
    const parts = data.split(":"); const groupIdx = parseInt(parts[1], 10); const targetId = decodeURIComponent(parts[2] || ""); const groups = getGroups(config);
    if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    const match = config.targetGroups.find(g => String(g).toLowerCase() === targetId.toLowerCase()); if (!match) { await answer("目标群不存在"); return; }
    const groupName = groups[groupIdx]; if (!config.groupRoutes) config.groupRoutes = {};
    const routes = config.groupRoutes[groupName] ? [...config.groupRoutes[groupName]].map(x => String(x)) : [];
    const idx = routes.findIndex(x => x.toLowerCase() === match.toLowerCase());
    if (idx >= 0) routes.splice(idx, 1); else routes.push(String(match));
    if (routes.length === 0) delete config.groupRoutes[groupName]; else config.groupRoutes[groupName] = routes;
    if (!(await save())) return; await answer(idx >= 0 ? "已解绑" : "已绑定");
    const routesNow = config.groupRoutes[groupName] || []; const routeDesc = routesNow.length > 0 ? routesNow.map(g => { const n = getGroupDisplayName(config, g); return n ? `${n}(${g})` : g; }).join("\n") : "未绑定，走默认";
    await editMsg(`📁 [${groupName}] 自动转发目标\n\n当前：\n${routeDesc}\n\n点击下方按钮切换绑定：`, getGroupRouteKeyboard(config, groupName, groupIdx)); return;
  }

  if (data.startsWith("grgc:")) {
    const groupIdx = parseInt(data.slice(5), 10); const groups = getGroups(config); if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    const groupName = groups[groupIdx]; if (config.groupRoutes && config.groupRoutes[groupName]) { delete config.groupRoutes[groupName]; if (!(await save())) return; }
    await answer("已清空路由"); await editMsg(`📁 [${groupName}] 自动转发目标\n\n当前：\n未绑定，走默认\n\n点击下方按钮切换绑定：`, getGroupRouteKeyboard(config, groupName, groupIdx)); return;
  }

  if (data.startsWith("ag:")) {
    const groupIdx = parseInt(data.slice(3), 10); const groups = getGroups(config); if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    await setAdminSession(db, userId, { op_mode: `ag:${groupIdx}` });
    await answer(); await editMsg(`请发送要添加到 [${groups[groupIdx]}] 的 X 用户名或链接。`, getCancelKeyboard()); return;
  }

  if (data.startsWith("gr:")) {
    const groupIdx = parseInt(data.slice(3), 10); const groups = getGroups(config); if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    await setAdminSession(db, userId, { op_mode: `gr:${groupIdx}` });
    await answer(); await editMsg(`请发送 [${groups[groupIdx]}] 的新组名。`, getCancelKeyboard()); return;
  }

  if (data.startsWith("gm:")) {
    const parts = data.split(":"); const groupIdx = parseInt(parts[1], 10), page = Math.max(0, parseInt(parts[2], 10) || 0); const groups = getGroups(config);
    if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    const groupName = groups[groupIdx], members = config.rssSources.filter(s => s.group === groupName);
    const limit = 10, maxPage = Math.max(1, Math.ceil(members.length / limit)), safePage = Math.min(page, maxPage - 1); const kb = [];
    for (let i = safePage * limit; i < Math.min((safePage + 1) * limit, members.length); i++) { const m = members[i]; const nick = config.sourceNames?.[m.username.toLowerCase()] ? ` (${config.sourceNames[m.username.toLowerCase()]})` : "";
      kb.push([{ text: `@${m.username}${nick}`, callback_data: `gmp:${m.username}` }]); }
    const nav = []; if (safePage > 0) nav.push({ text: "⬅️ 上一页", callback_data: `gm:${groupIdx}:${safePage - 1}` }); if (safePage < maxPage - 1) nav.push({ text: "下一页 ➡️", callback_data: `gm:${groupIdx}:${safePage + 1}` }); if (nav.length) kb.push(nav);
    kb.push([{ text: "↩️ 返回", callback_data: `gv:${groupIdx}` }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]);
    await answer(); await editMsg(`选择要移动的成员（来自 [${groupName}]）：`, { inline_keyboard: kb }); return;
  }
  if (data.startsWith("gmp:")) {
    const username = data.slice(4); const source = config.rssSources.find(s => s.username.toLowerCase() === username.toLowerCase()); if (!source) { await answer("源不存在"); return; }
    const groups = getGroups(config), currentGroup = source.group || DEFAULT_GROUP_NAME, kb = [];
    if (currentGroup !== DEFAULT_GROUP_NAME) kb.push([{ text: `📁 ${DEFAULT_GROUP_NAME}`, callback_data: `gmt:${source.username}:default` }]);
    for (let i = 0; i < groups.length; i++) if (groups[i] !== currentGroup) kb.push([{ text: `📁 ${groups[i]}`, callback_data: `gmt:${source.username}:${i}` }]);
    if (kb.length === 0) { await answer("没有其他分组可移动"); return; }
    kb.push([{ text: "↩️ 返回分组列表", callback_data: "menu:group_manage" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]);
    await answer(); await editMsg(`当前 @${source.username} 在 [${currentGroup}]\n请选择目标分组：`, { inline_keyboard: kb }); return;
  }

  if (data.startsWith("gmt:")) {
    const parts = data.split(":"); const username = parts[1]; const target = parts[2]; const source = config.rssSources.find(s => s.username.toLowerCase() === username.toLowerCase());
    if (!source) { await answer("源不存在"); return; }
    let targetGroupName; if (target === "default") targetGroupName = DEFAULT_GROUP_NAME;
    else { const gi = parseInt(target, 10), groups = getGroups(config); if (isNaN(gi) || gi < 0 || gi >= groups.length) { await answer("目标分组不存在"); return; }
      targetGroupName = groups[gi]; }
    if (source.group === targetGroupName) { await answer("已在该分组"); return; }
    const oldGroup = source.group; source.group = targetGroupName; if (!(await save())) return;
    await answer(`✅ 已移动到 [${targetGroupName}]`);
    const srcGroupIdx = getGroups(config).indexOf(oldGroup), kb = [];
    if (srcGroupIdx >= 0) kb.push([{ text: "🔁 继续移动本组", callback_data: `gm:${srcGroupIdx}:0` }]);
    kb.push([{ text: "↩️ 返回分组列表", callback_data: "menu:group_manage" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]);
    await editMsg(`✅ 已将 @${source.username} 从 [${oldGroup}] 移动到 [${targetGroupName}]`, { inline_keyboard: kb }); return;
  }

  if (data.startsWith("rgsg:")) {
    const groupIdx = parseInt(data.slice(5), 10), groups = getGroups(config); if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    const groupName = groups[groupIdx], kb = [];
    for (let i = 0; i < config.targetGroups.length; i += 2) {
      const row = [], g0 = String(config.targetGroups[i]), n0 = getGroupDisplayName(config, g0);
      row.push({ text: `🎯 ${truncateBtnText(n0 || g0, 16)}`, callback_data: `rdg:${encodeURIComponent(g0)}:${groupIdx}` });
      if (i + 1 < config.targetGroups.length) { const g1 = String(config.targetGroups[i + 1]), n1 = getGroupDisplayName(config, g1); row.push({ text: `🎯 ${truncateBtnText(n1 || g1, 16)}`, callback_data: `rdg:${encodeURIComponent(g1)}:${groupIdx}` }); }
      kb.push(row);
    }
    kb.push([{ text: "↩️ 返回", callback_data: `gv:${groupIdx}` }]);
    await answer(); await editMsg(`即将触发分组 [${groupName}]\n请选择发送到哪个目标群？`, { inline_keyboard: kb }); return;
  }

  if (data === "action:run") {
    if (config.rssSources.length === 0) { await answer("暂无监控用户"); await editMsg("⚠️ 你还没有监控用户。", getMainKeyboard(config)); return; }
    await answer(); const kb = [];
    if (config.targetGroups.length > 1) kb.push([{ text: "🎯 指定自动群组并触发", callback_data: "rmsg" }]);
    if (config.manualOnlyGroups.length > 0) kb.push([{ text: "🖐 指定手动群组并触发", callback_data: "rmsmg" }]);
    kb.push([{ text: "🔄 全部触发(发送到自动群组第一个)", callback_data: "action:run_all" }], [{ text: "👤 选择单人触发", callback_data: "rmsp:0" }], [{ text: "🔓 强制解除任务锁", callback_data: "action:unlock_confirm" }], [{ text: "↩️ 返回主菜单", callback_data: "menu:main" }]);
    await editMsg("请选择如何触发转发？", { inline_keyboard: kb });
    return;
  }

  if (data === "rmsg") {
    const kb = [];
    for (let i = 0; i < config.targetGroups.length; i += 2) {
      const row = [], g0 = String(config.targetGroups[i]), n0 = getGroupDisplayName(config, g0);
      row.push({ text: `🎯 ${truncateBtnText(n0 || g0, 16)}`, callback_data: `rgi:${encodeURIComponent(g0)}` });
      if (i + 1 < config.targetGroups.length) { const g1 = String(config.targetGroups[i + 1]), n1 = getGroupDisplayName(config, g1); row.push({ text: `🎯 ${truncateBtnText(n1 || g1, 16)}`, callback_data: `rgi:${encodeURIComponent(g1)}` }); }
      kb.push(row);
    }
    kb.push([{ text: "↩️ 返回", callback_data: "action:run" }]); await answer(); await editMsg("请选择要把本次推文发送到哪个自动群组？", { inline_keyboard: kb }); return;
  }

  if (data === "rmsmg") {
    const kb = [];
    for (let i = 0; i < config.manualOnlyGroups.length; i += 2) {
      const row = [], g0 = String(config.manualOnlyGroups[i]), n0 = getGroupDisplayName(config, g0);
      row.push({ text: `🖐 ${truncateBtnText(n0 || g0, 16)}`, callback_data: `rmg:${encodeURIComponent(g0)}` });
      if (i + 1 < config.manualOnlyGroups.length) { const g1 = String(config.manualOnlyGroups[i + 1]), n1 = getGroupDisplayName(config, g1); row.push({ text: `🖐 ${truncateBtnText(n1 || g1, 16)}`, callback_data: `rmg:${encodeURIComponent(g1)}` }); }
      kb.push(row);
    }
    kb.push([{ text: "↩️ 返回", callback_data: "action:run" }]); await answer(); await editMsg("请选择要把本次推文发送到哪个手动群组？", { inline_keyboard: kb }); return;
  }

  if (data.startsWith("rmg:")) {
    const targetGroup = decodeURIComponent(data.slice("rmg:".length));
    const match = config.manualOnlyGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase());
    if (!match) { await answer("目标群不存在"); return; }
    const display = getGroupDisplayName(config, match); const enc = encodeURIComponent(String(match));
    const kb = [[{ text: "🔄 抓取所有源发送到该群", callback_data: `rma:${enc}` }], [{ text: "👤 选择单个源发送到该群", callback_data: `rmp:${enc}:0` }], [{ text: "↩️ 返回", callback_data: "rmsmg" }]];
    await answer(); await editMsg(`即将发送到: 🖐 ${display || match}\n请选择要抓取哪些源：`, { inline_keyboard: kb }); return;
  }

  if (data.startsWith("rmp:")) {
    const rest = data.slice("rmp:".length); const sepIdx = rest.lastIndexOf(":"); const enc = rest.slice(0, sepIdx); const pageNum = parseInt(rest.slice(sepIdx + 1), 10) || 0;
    const targetGroup = decodeURIComponent(enc); const match = config.manualOnlyGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase());
    if (!match) { await answer("目标群不存在"); return; }
    const limit = 10, list = config.rssSources, maxPage = Math.max(1, Math.ceil(list.length / limit)); const page = Math.min(Math.max(0, pageNum), maxPage - 1); const kb = [];
    for (let i = page * limit; i < Math.min((page + 1) * limit, list.length); i++) kb.push([{ text: `@${list[i].username} (${list[i].group})`, callback_data: `rms:${enc}:${list[i].username}` }]);
    const nav = []; if (page > 0) nav.push({ text: "⬅️ 上一页", callback_data: `rmp:${enc}:${page - 1}` }); if (page < maxPage - 1) nav.push({ text: "下一页 ➡️", callback_data: `rmp:${enc}:${page + 1}` }); if (nav.length) kb.push(nav);
    kb.push([{ text: "↩️ 返回", callback_data: `rmg:${enc}` }]); await answer();
    const display = getGroupDisplayName(config, match); await editMsg(`选择要发送到 🖐 ${display || match} 的监控源：`, { inline_keyboard: kb }); return;
  }

  if (data.startsWith("rms:")) {
    const rest = data.slice("rms:".length); const sepIdx = rest.lastIndexOf(":"); const enc = rest.slice(0, sepIdx); const username = rest.slice(sepIdx + 1);
    const targetGroup = decodeURIComponent(enc); const match = config.manualOnlyGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase()); const source = config.rssSources.find(s => s.username.toLowerCase() === username.toLowerCase());
    if (!match || !source) { await answer("数据已变化"); return; }
    await answer("⏳ 正在执行抓取（已发过的自动跳过）...", true); await editMsg(`⏳ 正在抓取 @${source.username} 并发送到 ${match}...`, null);
    try { const res = await runTaskForSources(env, config, db, [source.username], match, true, true); await editMsg(`✅ 完成：\n成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`, getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 触发失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data.startsWith("rma:")) {
    const targetGroup = decodeURIComponent(data.slice("rma:".length));
    const match = config.manualOnlyGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase());
    if (!match) { await answer("目标群不存在"); return; }
    await answer("⏳ 正在执行抓取（已发过的自动跳过）...", true); await editMsg(`⏳ 正在抓取全部源并发送到 ${match}...`, null);
    const sources = config.rssSources.map(s => s.username);
    try { const res = await runTaskForSources(env, config, db, sources, match, true, true); await editMsg(`✅ 全量触发完成：\n成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`, getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 触发失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data.startsWith("rgi:")) {
    const targetGroup = decodeURIComponent(data.slice("rgi:".length));
    const match = config.targetGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase());
    if (!match) { await answer("目标群不存在"); return; }
    const display = getGroupDisplayName(config, match); const enc = encodeURIComponent(String(match));
    const kb = [[{ text: "🔄 抓取所有源发送到该群", callback_data: `rda:${enc}` }], [{ text: "👤 选择单个源发送到该群", callback_data: `rps:${enc}:0` }], [{ text: "↩️ 返回", callback_data: "rmsg" }]];
    await answer(); await editMsg(`即将发送到: ${display || match}\n请选择要抓取哪些源：`, { inline_keyboard: kb }); return;
  }

  if (data.startsWith("rps:")) {
    const rest = data.slice("rps:".length); const sepIdx = rest.lastIndexOf(":"); const enc = rest.slice(0, sepIdx); const pageNum = parseInt(rest.slice(sepIdx + 1), 10) || 0;
    const targetGroup = decodeURIComponent(enc); const match = config.targetGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase());
    if (!match) { await answer("目标群不存在"); return; }
    const limit = 10, list = config.rssSources, maxPage = Math.max(1, Math.ceil(list.length / limit)); const page = Math.min(Math.max(0, pageNum), maxPage - 1); const kb = [];
    for (let i = page * limit; i < Math.min((page + 1) * limit, list.length); i++) kb.push([{ text: `@${list[i].username} (${list[i].group})`, callback_data: `rsg:${enc}:${list[i].username}` }]);
    const nav = []; if (page > 0) nav.push({ text: "⬅️ 上一页", callback_data: `rps:${enc}:${page - 1}` }); if (page < maxPage - 1) nav.push({ text: "下一页 ➡️", callback_data: `rps:${enc}:${page + 1}` }); if (nav.length) kb.push(nav);
    kb.push([{ text: "↩️ 返回", callback_data: `rgi:${enc}` }]); await answer();
    const display = getGroupDisplayName(config, match); await editMsg(`选择要发送到 ${display || match} 的监控源：`, { inline_keyboard: kb }); return;
  }

  if (data.startsWith("rsg:")) {
    const rest = data.slice("rsg:".length); const sepIdx = rest.lastIndexOf(":"); const enc = rest.slice(0, sepIdx); const username = rest.slice(sepIdx + 1);
    const targetGroup = decodeURIComponent(enc); const match = config.targetGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase()); const source = config.rssSources.find(s => s.username.toLowerCase() === username.toLowerCase());
    if (!match || !source) { await answer("数据已变化"); return; }
    await answer("⏳ 正在执行抓取（已发过的自动跳过）...", true); await editMsg(`⏳ 正在抓取 @${source.username} 并发送到 ${match}...`, null);
    try { const res = await runTaskForSources(env, config, db, [source.username], match, true, true); await editMsg(`✅ 完成：\n成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`, getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 触发失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data.startsWith("rdg:")) {
    const rest = data.slice("rdg:".length); const sepIdx = rest.lastIndexOf(":"); const enc = rest.slice(0, sepIdx); const grpIdx = parseInt(rest.slice(sepIdx + 1), 10);
    const targetGroup = decodeURIComponent(enc); const groups = getGroups(config); const match = config.targetGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase());
    if (isNaN(grpIdx) || grpIdx < 0 || grpIdx >= groups.length || !match) { await answer("数据已变化"); return; }
    const groupName = groups[grpIdx], members = config.rssSources.filter(s => s.group === groupName);
    await answer("⏳ 正在执行抓取（已发过的自动跳过）...", true); await editMsg(`⏳ 正在抓取 [${groupName}] 并发送到 ${match}...`, null);
    try { const res = await runTaskForSources(env, config, db, members.map(s => s.username), match, true, true); await editMsg(`✅ [${groupName}] 触发完成：\n成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`, getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 触发失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data.startsWith("rda:")) {
    const targetGroup = decodeURIComponent(data.slice("rda:".length));
    const match = config.targetGroups.find(g => String(g).toLowerCase() === targetGroup.toLowerCase());
    if (!match) { await answer("目标群不存在"); return; }
    await answer("⏳ 正在执行抓取（已发过的自动跳过）...", true); await editMsg(`⏳ 正在抓取全部源并发送到 ${match}...`, null);
    try { const res = await runTaskForSources(env, config, db, config.rssSources.map(s => s.username), match, true, true); await editMsg(`✅ 全量触发完成：\n成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`, getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 触发失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data.startsWith("rg:")) {
    const grpIdx = parseInt(data.slice(3), 10), groups = getGroups(config); if (isNaN(grpIdx) || grpIdx < 0 || grpIdx >= groups.length) { await answer("分组不存在或已变化"); return; }
    const groupName = groups[grpIdx], members = config.rssSources.filter(s => s.group === groupName); const fallbackGroup = config.targetGroups[0] ? String(config.targetGroups[0]) : null;
    if (!fallbackGroup) { await answer("未配置目标群组"); return; }
    await answer("⏳ 正在执行抓取（已发过的自动跳过）...", true); await editMsg(`⏳ 正在抓取 [${groupName}] 并发送到各自绑定群...`, null);
    try { const res = await runTaskForSources(env, config, db, members.map(s => s.username), fallbackGroup, true, false); await editMsg(`✅ [${groupName}] 触发完成：\n成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`, getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 触发失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data.startsWith("rmsp:")) {
    const limit = 10, list = config.rssSources, maxPage = Math.max(1, Math.ceil(list.length / limit)); const page = Math.min(Math.max(0, parseInt(data.split(":")[1], 10) || 0), maxPage - 1); const kb = [];
    for (let i = page * limit; i < Math.min((page + 1) * limit, list.length); i++) kb.push([{ text: `@${list[i].username} (${list[i].group})`, callback_data: `rsrc:${list[i].username}` }]);
    const nav = []; if (page > 0) nav.push({ text: "⬅️ 上一页", callback_data: `rmsp:${page - 1}` }); if (page < maxPage - 1) nav.push({ text: "下一页 ➡️", callback_data: `rmsp:${page + 1}` }); if (nav.length > 0) kb.push(nav);
    kb.push([{ text: "↩️ 返回", callback_data: "action:run" }]); await answer(); await editMsg("请选择要单人触发的监控源：", { inline_keyboard: kb }); return;
  }

  if (data.startsWith("rsrc:")) {
    const username = data.slice("rsrc:".length); const source = config.rssSources.find(s => s.username.toLowerCase() === username.toLowerCase());
    if (!source) { await answer("源不存在"); return; }
    const targetGroup = pickSingleTargetGroup(config, source.username, config.targetGroups); if (!targetGroup) { await answer("未解析到目标群"); return; }
    await answer("⏳ 正在执行抓取（已发过的自动跳过）...", true); await editMsg(`⏳ 正在抓取 @${source.username} 并发送到 ${targetGroup}...`, null);
    try { const res = await runTaskForSources(env, config, db, [source.username], targetGroup, true, false); await editMsg(`✅ @${source.username} 触发完成：\n成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`, getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 触发失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data === "action:run_all") {
    if (!config.targetGroups.length) { await answer("未配置目标群组"); return; }
    await answer("⏳ 正在执行抓取（已发过的自动跳过）...", true);
    try { const res = await runTaskForSources(env, config, db, config.rssSources.map(s => s.username), config.targetGroups[0], true, false); await editMsg(`✅ 全部触发结果：\n\n成功${res.okCount} |跳过${res.skipCount} |失败${res.failCount}`, getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 触发失败：${e.message}`, getMainKeyboard(config)); }
    return;
  }

  if (data.startsWith("menu:")) {
    const menu = data.split(":")[1]; await answer();
    if (menu === "main") await editMsg("🤖 请管理配置 👇", getMainKeyboard(config));
    else if (menu === "rules") await editMsg("⚙️ 转发规则", getRulesKeyboard(config));
    else if (menu === "keyword") await editMsg("🔑 关键词过滤", getKeywordKeyboard());
    else if (menu === "affix") await editMsg("📝 前缀后缀", getAffixKeyboard());
    else if (menu === "rss") await editMsg("📡 监控源管理", getRssKeyboard());
    else if (menu === "group") await editMsg(`🎯 群组管理\n📤 自动转发群组：${config.targetGroups.length} 个\n🖐 仅手动触发群组：${config.manualOnlyGroups.length} 个`, getGroupKeyboard(config));
    else if (menu === "group_auto") await editMsg(`📤 自动转发群组 (${config.targetGroups.length}个)`, getAutoGroupKeyboard());
    else if (menu === "group_manual") await editMsg(`🖐 仅手动触发群组 (${config.manualOnlyGroups.length}个)`, getManualGroupKeyboard());
    else await editMsg("⚠️ 菜单已过期，请发送 /start 刷新", getMainKeyboard(config));
    return;
  }

  if (data.startsWith("toggle:")) {
    const key = data.split(":")[1]; if (!VALID_TOGGLES.includes(key)) { await answer("未知开关"); return; }
    config[key] = !config[key]; if (!(await save())) return; await answer(config[key] ? "已开启" : "已关闭");
    if (key === "disableVideoDowngrade" || key === "skipEmptyText" || key === "cronSummary") await editMsg("🤖 主菜单", getMainKeyboard(config));
    else if (key === "autoCreateTopic") await editMsg("🎯 群组管理", getGroupKeyboard(config));
    else await editMsg("⚙️ 转发规则", getRulesKeyboard(config));
    return;
  }

  if (data.startsWith("add:") || data.startsWith("edit:") || data.startsWith("del:")) {
    const mode = data, key = mode.split(":")[1]; await setAdminSession(db, userId, { op_mode: mode, pending_users: null });
    await answer(); let msg = "";
    if (mode === "add:rssSources") msg = `请发送 X 用户名或链接（支持批量）。\n💡 例如：\n\`elonmusk [科技组]\``;
    else if (mode === "del:rssSources") msg = "请发送要删除的序号或用户名（支持批量）。";
    else if (mode === "add:targetGroups") msg = "请发送自动转发群组 ID（数字）、@频道用户名、或 t.me 链接。";
    else if (mode === "del:targetGroups") msg = "请发送要删除的自动转发群组序号。";
    else if (mode === "add:manualGroups") msg = "请发送仅手动触发群组 ID（数字）、@频道用户名、或 t.me 链接。";
    else if (mode === "del:manualGroups") msg = "请发送要删除的仅手动触发群组序号。";
    else if (mode === "edit:maxItems") msg = `请输入【自动转发】单次处理条数（1--${MAX_ITEMS_LIMIT}）。`;
    else if (mode === "edit:manualMaxItems") msg = `请输入【手动触发】单次处理条数（1--${MAX_ITEMS_LIMIT}）。`;
    else if (mode.startsWith("del:")) msg = `请发送要删除的序号。`; else if (mode.startsWith("add:")) msg = `请发送关键词。`;
    else if (mode === "edit:prefix") msg = "请发送要设置的前缀内容。"; else if (mode === "edit:suffix") msg = "请发送要设置的后缀内容。";
    await editMsg(msg, getCancelKeyboard()); return;
  }

  if (data === "clear:rssSources") {
    await answer(); await editMsg("⚠️ 确认清空所有监控源？此操作不可恢复。", { inline_keyboard: [[{ text: "✅ 确认清空", callback_data: "clear_do:rssSources" }], [{ text: "✖️ 取消", callback_data: "menu:rss" }], [{ text: "🏠 返回主菜单", callback_data: "menu:main" }]] }); return;
  }

  if (data === "clear_do:rssSources") {
    config.rssSources = []; config.sourceNames = {}; config.groupRoutes = {}; if (!(await save())) return;
    try { await db.prepare("DELETE FROM source_cursors").run(); } catch (e) {} try { await db.prepare("DELETE FROM user_topic_map").run(); } catch (e) {} try { await db.prepare("DELETE FROM backfill_progress").run(); } catch (e) {}
    await answer("已清空"); await editMsg("📡 监控源管理", getRssKeyboard()); return;
  }

  if (data.startsWith("clear:")) {
    const key = data.split(":")[1]; if (!VALID_CLEARS.includes(key)) { await answer("未知清空项"); return; }
    if (key === "prefix" || key === "suffix") config[key] = ""; else config[key] = [];
    if (!(await save())) return; await answer("已清空");
    if (key === "whitelist" || key === "blacklist") await editMsg("🔑 关键词过滤", getKeywordKeyboard()); else await editMsg("📝 前缀后缀", getAffixKeyboard());
    return;
  }

  if (data.startsWith("list:")) {
    const key = data.split(":")[1]; await answer(); let content = "";
    if (key === "rssSources") {
      if (config.rssSources.length === 0) content = "暂无监控用户";
      else {
        const grouped = {}; config.rssSources.forEach(s => { const g = s.group || DEFAULT_GROUP_NAME; if (!grouped[g]) grouped[g] = [];
          grouped[g].push(s); });
        for (const [g, list] of Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))) {
          content += `📁 【${g}】\n`; const routes = config.groupRoutes?.[g];
          if (Array.isArray(routes) && routes.length > 0) content += `🎯 自动转发：${routes.map(gid => { const n = getGroupDisplayName(config, gid); return n ? `${n}(${gid})` : gid; }).join("、")}\n`; else content += `🎯 自动转发：默认\n`;
          for (const s of list) { const idx = config.rssSources.findIndex(x => x.username.toLowerCase() === s.username.toLowerCase()) + 1; const nick = config.sourceNames?.[s.username.toLowerCase()] ? ` (${config.sourceNames[s.username.toLowerCase()]})` : ""; content += `${idx}. @${s.username}${nick}\n`; }
        }
      }
    } else if (key === "targetGroups" || key === "manualGroups") {
      const listKey = key === "targetGroups" ? "targetGroups" : "manualOnlyGroups", arr = config[listKey];
      if (arr.length === 0) content = key === "targetGroups" ? "暂无自动转发群组" : "暂无仅手动触发群组";
      else content = arr.map((g, i) => { const name = getGroupDisplayName(config, g); return name ? `${i + 1}. ${g}\n ${name}` : `${i + 1}. ${g}`; }).join("\n");
    } else if (key === "whitelist" || key === "blacklist") {
      const name = key === "whitelist" ? "白名单" : "黑名单"; content = config[key].length === 0 ? `${name}为空` : `${name}（共 ${config[key].length} 个）：\n${config[key].map((k, i) => `${i + 1}. ${k}`).join("\n")}`;
    }
    if (!content) content = "暂无数据"; await editMsg(content, getCancelKeyboard()); return;
  }

  if (data.startsWith("action:")) {
    const action = data.split(":")[1];
    if (action === "cancel") { await setAdminSession(db, userId, { op_mode: "idle", pending_users: null }); await answer("已取消");
      await editMsg("🤖 主菜单", getMainKeyboard(config)); }
    else if (action === "unlock_confirm") { await answer(); await editMsg("⚠️ 强制解除任务锁可能导致并发，请确认没任务时使用。\n\n确定解除吗？", { inline_keyboard: [[{ text: "🔓 确定解除", callback_data: "action:unlock_do" }], [{ text: "✖️ 取消", callback_data: "action:run" }]] }); }
    else if (action === "unlock_do") {
      await answer("正在解除...");
      try { await db.prepare("DELETE FROM cron_lock").run(); await db.prepare("UPDATE admin_sessions SET op_mode = ?, updated_at = ?").bind(JSON.stringify({ op_mode: "idle" }), Date.now()).run();
        await editMsg("✅ 任务锁已重置！", getMainKeyboard(config)); } catch (e) { await editMsg(`❌ 解除失败：${e.message}`, getMainKeyboard(config)); }
    }
    else if (action === "clear_kv") { await answer(); await editMsg("⚠️ 确认清空所有已转发记录？", { inline_keyboard: [[{ text: "✅ 确认清空", callback_data: "action:clear_kv_do" }], [{ text: "✖️ 取消", callback_data: "menu:main" }]] }); }
    else if (action === "clear_kv_do") { await answer("正在清空..."); const count = await clearForwardRecords(db); await editMsg(`✅ 已清空 ${count} 条历史记录。`, getMainKeyboard(config)); }
    else if (action === "status") {
      await answer(); const keepDays = env.FORWARD_RECORDS_KEEP_DAYS ? parseInt(env.FORWARD_RECORDS_KEEP_DAYS, 10) : 0; const namedCount = Object.keys(config.targetGroupNames || {}).length;
      const status = `📊 配置快照 ${BOT_VERSION}\n📡 监控用户：${config.rssSources.length} 个\n📤 自动转发群组：${config.targetGroups.length} 个（${namedCount} 个有名称）\n🖐 仅手动触发群组：${config.manualOnlyGroups.length} 个\n🎯 分组路由：${Object.keys(config.groupRoutes || {}).length} 个分组已配置\n📌 自动创建话题：${config.autoCreateTopic ? "开启" : "关闭"}\n🔔 Cron摘要：${config.cronSummary ? "开启" : "关闭"}\n🔑 白名单：${config.whitelist.length} 个\n🔑 黑名单：${config.blacklist.length} 个\n⚙️ 仅带图：${config.onlyPhoto ? "开启" : "关闭"}\n⚙️ 纯链接模式：${config.linkOnlyMode ? "开启" : "关闭"}\n⚙️ 过滤RT：${config.filterRt ? "开启" : "关闭"}\n📦 自动单次：${config.maxItems} 条\n🖐 手动单次：${config.manualMaxItems} 条\n⏪ 补历史命令：/backfill 用户名 [reset]\n♻️ 清断点命令：/reset 用户名\n🧹 转发记录清理：${keepDays > 0 ? `自动清理，保留 ${keepDays} 天` : "关闭"}`;
      await editMsg(status, getMainKeyboard(config));
    } else if (action === "debug_menu") { await answer(); await setAdminSession(db, userId, { op_mode: "debug_wait_user", pending_users: null }); await editMsg("🩺 系统诊断测试\n\n请直接发送要诊断的 @用户名（或推文链接）。\nBot 将测试接口连通性、耗时、推文数量和媒体信息。", getCancelKeyboard()); }
    else await answer("未知操作"); return;
  }
  await answer("未知操作");
}

// ==========================================
// 会话输入 & 记录工具
// ==========================================
async function handleSessionInput(msg, env, db, config, session) {
  const chatId = msg.chat.id; const text = msg.text.trim(); const mode = session.op_mode; let reply = "";
  if (mode.startsWith("add:")) {
    const key = mode.split(":")[1]; const sub = mode.split(":")[2] || "";
    if (key === "rssSources" && sub === "newgroup") {
      const newGroupName = text.replace(/[:\n\r|\[\]]/g, "").trim();
      if (!newGroupName) { await setAdminSession(db, msg.from.id, { op_mode: "add:rssSources:newgroup" }); await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 组名不能为空。", getCancelKeyboard()); return; }
      const finalGroupName = newGroupName.slice(0, GROUP_NAME_MAX_LEN); const sess2 = await getAdminSession(db, msg.from.id); const pendingUsers = sess2.pending_users || [];
      if (pendingUsers.length === 0) { await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null }); await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 无待处理用户。", getMainKeyboard(config)); return; }
      let added = 0, moved = 0;
      for (const u of pendingUsers) { const existing = config.rssSources.find(s => s.username.toLowerCase() === u.username.toLowerCase()); if (existing) { if (existing.group !== finalGroupName) { existing.group = finalGroupName; moved++; } continue; } config.rssSources.push({ username: u.username, group: finalGroupName }); added++; }
      try { await saveConfig(db, config); } catch (e) { await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null }); await sendTgMessage(env.TG_BOT_TOKEN, chatId, `⚠️ 保存失败：${e.message}`, getMainKeyboard(config)); return; }
      await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
      let replyMsg = `✅ 已处理到 [${finalGroupName}]：\n`; if (added > 0) replyMsg += `- 新增 ${added} 个\n`; if (moved > 0) replyMsg += `- 移动 ${moved} 个\n`;
      replyMsg += `当前共 ${config.rssSources.length} 个监控源`; await sendTgMessage(env.TG_BOT_TOKEN, chatId, replyMsg, getMainKeyboard(config)); return;
    }
    if (key === "rssSources" && sub === "pickgroup") { await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 请点击按钮选择分组。", buildPickGroupKeyboard(config)); return; }
    if (key === "rssSources" && !sub) {
      let groupName = null; let rawText = text; let emptyGroupFlag = false, truncatedFlag = false; const groupMatches = [...text.matchAll(/\[(.*?)\]/g)];
      if (groupMatches.length > 1) { await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null }); await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 只能指定一个组名。", getMainKeyboard(config)); return; }
      if (groupMatches.length === 1) {
        const rawGroup = groupMatches[0][1].trim(); const cleaned = rawGroup.replace(/[:\n\r|\[\]]/g, "").trim();
        if (!cleaned) { emptyGroupFlag = true; groupName = DEFAULT_GROUP_NAME; }
        else { if (cleaned.length > GROUP_NAME_MAX_LEN) truncatedFlag = true;
          groupName = cleaned.slice(0, GROUP_NAME_MAX_LEN); }
        rawText = text.replace(groupMatches[0][0], "");
      }
      const inputs = rawText.split(/[\s,，、;\n]+/).filter(Boolean); const parsedUsers = []; const seen = new Set();
      for (const item of inputs) { const username = extractUsername(item); if (!username) continue; const low = username.toLowerCase(); if (seen.has(low)) continue; seen.add(low); parsedUsers.push({ username }); }
      if (parsedUsers.length === 0) reply = "⚠️ 未识别到有效用户名";
      else if (groupName) {
        let added = 0, moved = 0;
        for (const u of parsedUsers) { const existing = config.rssSources.find(s => s.username.toLowerCase() === u.username.toLowerCase()); if (existing) { if (existing.group !== groupName) { existing.group = groupName; moved++; } continue; } config.rssSources.push({ username: u.username, group: groupName }); added++; }
        reply = `✅ 处理完成：\n`; if (emptyGroupFlag) reply += `- ⚠️ 组名为空，归入「${DEFAULT_GROUP_NAME}」\n`; if (truncatedFlag) reply += `- ⚠️ 组名超长，已截断\n`;
        if (added > 0) reply += `- 新增 ${added} 个\n`; if (moved > 0) reply += `- 移动 ${moved} 个\n`; reply += `当前共 ${config.rssSources.length} 个监控源`;
      } else { await setAdminSession(db, msg.from.id, { op_mode: "add:rssSources:pickgroup", pending_users: parsedUsers }); await sendTgMessage(env.TG_BOT_TOKEN, chatId, `已解析 ${parsedUsers.length} 个用户名，请选择分组：`, buildPickGroupKeyboard(config)); return; }
    }
    else if (key === "targetGroups" || key === "manualGroups") {
      const listKey = key === "targetGroups" ? "targetGroups" : "manualOnlyGroups"; const otherKey = key === "targetGroups" ? "manualOnlyGroups" : "targetGroups";
      const rawGroups = text.split(/[\s,，、;\n]+/).filter(Boolean); let added = 0, dup = 0, crossDup = 0;
      for (let g of rawGroups) {
        const tgLink = g.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]+)\/?$/i);
        if (tgLink) g = `@${tgLink[1]}`; if (/^@[a-zA-Z0-9_]+$/.test(g)) g = g.toLowerCase();
        if (!/^-?\d+$/.test(g) && !/^@[a-zA-Z0-9_]+$/.test(g)) continue;
        if (config[listKey].some(t => String(t).toLowerCase() === g.toLowerCase())) { dup++; continue; }
        if (config[otherKey].some(t => String(t).toLowerCase() === g.toLowerCase())) { crossDup++; continue; }
        config[listKey].push(g); added++;
      }
      reply = `✅ 成功添加 ${added} 个到「${key === "targetGroups" ? "自动" : "手动"}」`;
      if (dup > 0) reply += `（${dup} 个已存在）`; if (crossDup > 0) reply += `（${crossDup} 个已在另一类中）`; reply += `\n当前共 ${config[listKey].length} 个`;
    }
    else if (key === "whitelist" || key === "blacklist") {
      const keys = text.split(/[\s,，、;\n]+/).map(k => k.trim()).filter(Boolean); const before = config[key].length;
      config[key] = [...new Set([...config[key], ...keys])]; reply = `✅ 新增 ${config[key].length - before} 个关键词\n当前共 ${config[key].length} 个`;
    }
  }
  else if (mode.startsWith("del:")) {
    const key = mode.split(":")[1];
    if (key === "rssSources") {
      const inputs = text.split(/[\s,，、;\n]+/).filter(Boolean); const found = [], notFound = [], seen = new Set();
      for (const item of inputs) {
        if (/^\d+$/.test(item)) { const idx = parseInt(item, 10) - 1; if (idx >= 0 && idx < config.rssSources.length) { const s = config.rssSources[idx]; const low = s.username.toLowerCase(); if (!seen.has(low)) { seen.add(low); found.push({ idx, obj: s }); } } else notFound.push(`序号 ${item}`); }
        else {
          const username = extractUsername(item); if (!username) { notFound.push(`"${item}"`); continue; }
          const low = username.toLowerCase(); if (seen.has(low)) continue; seen.add(low);
          const idx = config.rssSources.findIndex(s => s.username.toLowerCase() === low); if (idx < 0) { notFound.push(`@${username}`); continue; } found.push({ idx, obj: config.rssSources[idx] });
        }
      }
      found.sort((a, b) => b.idx - a.idx); let deleted = 0; const removedUsernames = [];
      for (const f of found) { const s = config.rssSources[f.idx]; if (s) { delete config.sourceNames[s.username.toLowerCase()];
        removedUsernames.push(s.username); config.rssSources.splice(f.idx, 1); deleted++; } }
      for (const u of removedUsernames) { try { await db.prepare("DELETE FROM source_cursors WHERE LOWER(username) = LOWER(?)").bind(u).run(); } catch (e) {} try { await db.prepare("DELETE FROM user_topic_map WHERE LOWER(username) = LOWER(?)").bind(u).run(); } catch (e) {} try { await db.prepare("DELETE FROM backfill_progress WHERE LOWER(username) = LOWER(?)").bind(u).run(); } catch (e) {} }
      reply = `✅ 已删除 ${deleted} 个监控源\n当前剩 ${config.rssSources.length} 个`; if (notFound.length > 0) reply += `\n⚠️ 未找到 ${notFound.length} 个。`;
    }
    else if (key === "targetGroups" || key === "manualGroups" || key === "whitelist" || key === "blacklist") {
      const listKey = key === "manualGroups" ? "manualOnlyGroups" : key;
      const nums = [...new Set(text.split(/[\s,，、;\n]+/).map(n => n.trim()).filter(n => /^\d+$/.test(n)).map(n => parseInt(n, 10)))];
      nums.sort((a, b) => b - a); let deleted = 0; const list = config[listKey], removed = [];
      for (const idx of nums) { if (idx >= 1 && idx <= list.length) { removed.push(...list.splice(idx - 1, 1)); deleted++; } }
      if (key === "targetGroups") { for (const item of removed) { const id = String(item).toLowerCase(); if (config.groupRoutes) { for (const gName of Object.keys(config.groupRoutes)) { const arr = config.groupRoutes[gName].filter(x => String(x).toLowerCase() !== id); if (arr.length === 0) delete config.groupRoutes[gName]; else config.groupRoutes[gName] = arr; } } } }
      const nameMap = { targetGroups: "自动转发群组", manualGroups: "仅手动触发群组", whitelist: "白名单关键词", blacklist: "黑名单关键词" }; reply = `✅ 已删除 ${deleted} 个${nameMap[key]}\n当前剩 ${list.length} 个`;
    }
  }
  else if (mode.startsWith("edit:")) {
    const key = mode.split(":")[1];
    if (key === "maxItems") { const t = text.trim(); if (!/^\d+$/.test(t)) reply = "⚠️ 请输入正整数"; else { const num = parseInt(t, 10); if (num < 1 || num > MAX_ITEMS_LIMIT) reply = `⚠️ 请输入 1--${MAX_ITEMS_LIMIT} 之间的整数`; else { config.maxItems = num; reply = `✅ 自动单次处理条数已设为 ${num}`; } } }
    else if (key === "manualMaxItems") { const t = text.trim(); if (!/^\d+$/.test(t)) reply = "⚠️ 请输入正整数"; else { const num = parseInt(t, 10); if (num < 1 || num > MAX_ITEMS_LIMIT) reply = `⚠️ 请输入 1--${MAX_ITEMS_LIMIT} 之间的整数`; else { config.manualMaxItems = num; reply = `✅ 手动单次处理条数已设为 ${num}`; } } }
    else if (key === "prefix" || key === "suffix") { config[key] = text; reply = `✅ 已设置${key === "prefix" ? "前缀" : "后缀"}`; }
  }
  else if (mode.startsWith("ag:")) {
    const groupIdx = parseInt(mode.slice(3), 10); const groups = getGroups(config); if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await setAdminSession(db, msg.from.id, { op_mode: "idle" }); await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 分组不存在或已变化", getMainKeyboard(config)); return; }
    const groupName = groups[groupIdx]; const inputs = text.split(/[\s,，、;\n]+/).filter(Boolean); let added = 0, moved = 0, recognized = 0;
    for (const item of inputs) { const username = extractUsername(item); if (!username) continue; recognized++; const existing = config.rssSources.find(s => s.username.toLowerCase() === username.toLowerCase()); if (existing) { if (existing.group !== groupName) { existing.group = groupName; moved++; } continue; } config.rssSources.push({ username, group: groupName }); added++; }
    reply = `✅ 已处理到 [${groupName}]：\n`; if (added > 0) reply += `- 新增 ${added} 个\n`; if (moved > 0) reply += `- 移动 ${moved} 个\n`; if (recognized < inputs.length) reply += `- ⚠️ ${inputs.length - recognized} 个未被识别\n`; if (added === 0 && moved === 0 && recognized > 0) reply += `- 均已在目标分组中\n`; if (recognized === 0) reply += `- 未识别到有效用户名\n`; reply += `当前共 ${config.rssSources.length} 个监控源`;
  }
  else if (mode.startsWith("gr:")) {
    const groupIdx = parseInt(mode.slice(3), 10); const groups = getGroups(config); if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) { await setAdminSession(db, msg.from.id, { op_mode: "idle" }); await sendTgMessage(env.TG_BOT_TOKEN, chatId, "⚠️ 分组不存在或已变化", getMainKeyboard(config)); return; }
    const oldName = groups[groupIdx]; let newName = text.replace(/[:\n\r|\[\]]/g, "").trim();
    if (!newName) reply = "⚠️ 组名不能为空，操作已取消";
    else {
      let truncated = false; if (newName.length > GROUP_NAME_MAX_LEN) { newName = newName.slice(0, GROUP_NAME_MAX_LEN); truncated = true; }
      if (newName === oldName) reply = "⚠️ 新组名与旧组名相同，无需修改";
      else {
        let moved = 0; for (const s of config.rssSources) if (s.group === oldName) { s.group = newName; moved++; }
        if (config.groupRoutes && config.groupRoutes[oldName]) { const existing = config.groupRoutes[newName] || []; config.groupRoutes[newName] = [...new Set([...existing, ...config.groupRoutes[oldName]])]; delete config.groupRoutes[oldName]; }
        const mergedNote = groups.includes(newName) ? `\n⚠️ 目标组「${newName}」已存在，已合并` : ""; reply = `✅ 已重命名 [${oldName}] → [${newName}]，影响 ${moved} 个监控源${mergedNote}`; if (truncated) reply += `\n⚠️ 原组名超长，已截断`;
      }
    }
  }
  if (!reply) reply = "⚠️ 未识别的操作，请重新打开菜单";
  try { await saveConfig(db, config); } catch (e) { reply = `⚠️ 保存失败：${e.message}`; }
  await setAdminSession(db, msg.from.id, { op_mode: "idle", pending_users: null });
  await sendTgMessage(env.TG_BOT_TOKEN, chatId, reply, getMainKeyboard(config));
}

async function clearForwardRecords(db) { try { return (await db.prepare("DELETE FROM forward_records").run()).meta.changes; } catch (e) { return 0; } }

async function cleanExpiredForwardRecords(db, keepDays) {
  if (!Number.isInteger(keepDays) || keepDays <= 0) return { deleted: 0 };
  const expireTs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  try { const res = await db.prepare("DELETE FROM forward_records WHERE created_at < ?").bind(expireTs).run(); return { deleted: (res.meta && res.meta.changes) || 0 }; } catch (e) { return { deleted: 0 }; }
}

function isMatchKeyword(text, keywords, wholeWord) {
  if (!Array.isArray(keywords) || keywords.length === 0) return false;
  const lowerText = text.toLowerCase();
  for (const kw of keywords) {
    if (!kw || typeof kw !== "string" || !kw.trim()) continue; const kwLow = kw.toLowerCase();
    if (!wholeWord) { if (lowerText.includes(kwLow)) return true; continue; }
    if (/[^\x00-\x7F]/.test(kwLow)) { if (lowerText.includes(kwLow)) return true; }
    else { const escaped = kwLow.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); if (new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`).test(lowerText)) return true; }
  }
  return false;
}

async function getAlreadySentChats(db, tweetId, targetGroups) {
  if (!targetGroups || targetGroups.length === 0) return new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const placeholders = targetGroups.map(() => "?").join(",");
      const rows = await db.prepare(`SELECT chat_id FROM forward_records WHERE tweet_id = ? AND (chat_id IN (${placeholders}) OR chat_id = '*')`).bind(String(tweetId), ...targetGroups.map(String)).all();
      return new Set((rows.results || []).map(r => String(r.chat_id))); }
    catch (e) { lastErr = e; if (attempt === 0) await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error("查重失败，已中止发送以防止重复");
}

async function recordForwarded(db, tweetId, chatId) {
  try { await db.prepare("INSERT OR IGNORE INTO forward_records (tweet_id, chat_id, created_at) VALUES (?, ?, ?)").bind(String(tweetId), String(chatId), Date.now()).run(); } catch (e) {}
}

// ==========================================
// 推文分发 & 媒体
// ==========================================
async function dispatchTweet(env, config, db, tweet, isManual = false, targetGroup = null, writeQueue = null, opts = {}) {
  const id = String(tweet.id || tweet.tweet_id || "").trim();
  if (!id) return "❌ 无效推文（缺少 ID）";
  const text = tweet.text || ""; const photos = tweet.media?.photos || []; const videos = tweet.media?.videos || [];
  const maxVideoMB = Number(env.MAX_VIDEO_MB || MAX_VIDEO_MB_DEFAULT);
  const maxVideoBytes = maxVideoMB * 1024 * 1024;
  const fxHost = env.FXEMBED_DOMAIN || "fxtwitter.com"; const authorName = tweet.author?.screen_name || "";
  const authorDisplay = tweet.author?.name || config.sourceNames?.[authorName.toLowerCase()] || "";
  if (authorName && tweet.author?.name) { const lowName = authorName.toLowerCase(); if (config.sourceNames[lowName] !== tweet.author.name) { config.sourceNames[lowName] = tweet.author.name; await updateNicknameDirect(db, authorName, tweet.author.name); } }
  const fxUrl = `https://${fxHost}/${authorName || "i"}/status/${id}`; const disableVideoDowngrade = config.disableVideoDowngrade;
  const groupId = targetGroup ? String(targetGroup) : null; if (!groupId) return "⚠️ 未指定目标群组";
  const already = await getAlreadySentChats(db, id, [groupId]);
  if (already.has('*') || already.has(groupId)) return "ℹ️ 已转发过，跳过";
  const isRetweet = !!tweet.reposted_by || !!tweet.retweeted_by || text.startsWith("RT @"); const isReply = !!tweet.replying_to;
  if (!isManual) {
    if (config.filterRt && (isRetweet || isReply)) return "ℹ️ RT/回复，跳过";
    const isMonitored = config.rssSources.some(s => s.username.toLowerCase() === authorName.toLowerCase());
    if (config.filterRt && !isMonitored) return `ℹ️ 拦截非监控源(@${authorName})，跳过`;
    if (config.whitelist.length > 0 && !isMatchKeyword(text, config.whitelist, config.wholeWordFilter)) return "ℹ️ 未命中白名单，跳过";
    if (config.blacklist.length > 0 && isMatchKeyword(text, config.blacklist, config.wholeWordFilter)) return "ℹ️ 命中黑名单，跳过";
  }
  if (config.onlyPhoto && !opts.ignoreOnlyPhoto && photos.length === 0 && videos.length === 0) return "ℹ️ 无图片/视频，跳过";
  let cleanText = text.replace(/#[^\s#]+/g, "").replace(/[ \t]+/g, " ").trim(); let messageText = `${config.prefix}${cleanText}${config.suffix}`;
  if (messageText.length > 3800) messageText = messageText.slice(0, 3800) + "...";
  const hasMedia = photos.length > 0 || videos.length > 0;
  if (config.skipEmptyText && !hasMedia && !cleanText && !config.prefix && !config.suffix) return "ℹ️ 空文本且无媒体，跳过";
  let hasOversizeVideo = false;
  for (const v of videos) { const formatList = v.formats || v.variants || []; const mp4List = formatList.filter(x => x.container === "mp4" || x.content_type === "video/mp4" || /\.mp4(\?|$)/i.test(x.url || "")); if (mp4List.length > 0) { const hasUsable = mp4List.some(x => !x.size || x.size <= maxVideoBytes); if (!hasUsable) { hasOversizeVideo = true; break; } } }
  let success = 0; let threadIdForFallback = null; const targetsToSend = [groupId];
  if (config.linkOnlyMode || (!disableVideoDowngrade && hasOversizeVideo)) {
    const suffixNote = (!disableVideoDowngrade && hasOversizeVideo && !config.linkOnlyMode) ? "\n\n⚠️视频超出大小限制，已使用预览卡片" : "";
    const rawText = `${config.prefix}${fxUrl}${config.suffix}${suffixNote}`; const msgText = rawText.length > 4000 ? rawText.slice(0, 4000) + "\n...(已截断)" : rawText;
    for (const gid of targetsToSend) {
      let threadId = null; if (config.autoCreateTopic) threadId = await getOrCreateTopic(env, db, config, gid, authorName, authorDisplay, writeQueue);
      try { const payload = { chat_id: gid, text: msgText, disable_web_page_preview: false }; if (threadId) payload.message_thread_id = threadId; await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", payload); success++; if (writeQueue) writeQueue.records.push({ id, groupId: gid }); else await recordForwarded(db, id, gid); }
      catch (e) { if (threadId && isThreadInvalidError(e.message)) { await deleteTopicMapping(db, config, gid, authorName); try { const payload2 = { chat_id: gid, text: msgText, disable_web_page_preview: false }; await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", payload2); success++; if (writeQueue) writeQueue.records.push({ id, groupId: gid }); else await recordForwarded(db, id, gid); } catch (e2) {} } }
    }
    const modeLabel = config.linkOnlyMode ? "纯链接" : "降级卡片";
    return success > 0 ? `✅ 转发成功(${modeLabel}，${groupId})` : `❌ 转发失败`;
  }
  let senderLabel = "";
  if (config.showSourceLabel && authorName) { if (authorDisplay) senderLabel = `📤 来自 ${authorDisplay} @${authorName}`; else senderLabel = `📤 来自 @${authorName}`; }
  for (const gid of targetsToSend) {
    let threadId = null; if (config.autoCreateTopic) threadId = await getOrCreateTopic(env, db, config, gid, authorName, authorDisplay, writeQueue); threadIdForFallback = threadId;
    try {
      const status = await sendTweetToTg(env, gid, messageText, photos, videos, senderLabel, threadId, fxUrl);
      if (status === "OVERSIZE_VIDEO") {
        if (!disableVideoDowngrade) {
          const hasCaption = messageText && messageText.trim(); const downgradeText = hasCaption ? `${messageText}\n\n${fxUrl}\n\n⚠️视频超出大小限制，已使用预览卡片` : `${config.prefix}${fxUrl}${config.suffix}\n\n⚠️视频超出大小限制，已使用预览卡片`;
          const finalText = downgradeText.length > 4000 ? downgradeText.slice(0, 4000) + "\n...(已截断)" : downgradeText; const payload = { chat_id: gid, text: finalText, disable_web_page_preview: false };
          if (threadId) payload.message_thread_id = threadId; await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", payload); success++; if (writeQueue) writeQueue.records.push({ id, groupId: gid }); else await recordForwarded(db, id, gid);
        } else if (messageText && messageText.trim()) {
          const payload = { chat_id: gid, text: messageText, disable_web_page_preview: true }; if (threadId) payload.message_thread_id = threadId; await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", payload); success++; if (writeQueue) writeQueue.records.push({ id, groupId: gid }); else await recordForwarded(db, id, gid);
        }
      } else if (status === "SENT") { success++; if (writeQueue) writeQueue.records.push({ id, groupId: gid }); else await recordForwarded(db, id, gid); }
    } catch (e) {
      if (threadId && isThreadInvalidError(e.message)) {
        await deleteTopicMapping(db, config, gid, authorName);
        try { const status2 = await sendTweetToTg(env, gid, messageText, photos, videos, senderLabel, null, fxUrl); if (status2 === "SENT") { success++; if (writeQueue) writeQueue.records.push({ id, groupId: gid }); else await recordForwarded(db, id, gid); } } catch (e2) {}
      }
    }
  }
  if (success > 0) return `✅ 转发成功（${groupId}）`;
  if (opts.backfillFallback) {
    try {
      const fallbackText = `${config.prefix}${cleanText ? cleanText + "\n\n" : ""}${fxUrl}${config.suffix}`;
      const payload = { chat_id: groupId, text: fallbackText.slice(0, 4000), disable_web_page_preview: false };
      if (threadIdForFallback) payload.message_thread_id = threadIdForFallback;
      await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", payload);
      if (writeQueue) writeQueue.records.push({ id, groupId }); else await recordForwarded(db, id, groupId);
      return `✅ 转发成功（补历史降级：媒体失败，纯文本+链接）`;
    } catch (e) { return `❌ 转发失败（降级也失败: ${e.message}）`; }
  }
  return `❌ 转发失败`;
}

async function sendTgApi(token, method, payload, retry = 2) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  while (retry >= 0) {
    let resJson, netErr;
    try { const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) }); resJson = await res.json(); }
    catch (err) { netErr = err; }
    if (netErr) { retry--; if (retry < 0) throw netErr; await new Promise(r => setTimeout(r, 1000)); continue; }
    if (resJson.ok) return resJson;
    const code = resJson.error_code ?? 0;
    if (code !== 429 && code < 500) throw new Error(`TG API Error ${code}: ${resJson.description}`);
    retry--;
    if (retry < 0) throw new Error(`TG API Error: ${JSON.stringify(resJson)}`);
    const waitMs = code === 429 && resJson.parameters?.retry_after ? resJson.parameters.retry_after * 1000 : 1000; await new Promise(r => setTimeout(r, waitMs));
  }
}

async function sendTgMessage(token, chatId, text, keyboard) {
  try {
    let safeText = text; if (typeof safeText === "string" && safeText.length > 4000) safeText = safeText.slice(0, 4000) + "\n...(已截断)";
    const body = { chat_id: chatId, text: safeText, disable_web_page_preview: true };
    if (keyboard) { if (keyboard.keyboard) body.reply_markup = keyboard; else body.reply_markup = keyboard; }
    return await sendTgApi(token, "sendMessage", body);
  } catch (e) {}
}

async function tgUploadForm(token, method, formBuilder, retry = 2) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  while (retry >= 0) {
    let resJson, netErr;
    try { const form = formBuilder(); const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(120000) }); resJson = await res.json(); }
    catch (err) { netErr = err; }
    if (netErr) { retry--; if (retry < 0) throw netErr; await new Promise(r => setTimeout(r, 2000)); continue; }
    if (resJson.ok) return resJson;
    const code = resJson.error_code ?? 0;
    if (code !== 429 && code < 500) throw new Error(`${method} 失败 ${code}: ${resJson.description}`);
    retry--;
    if (retry < 0) throw new Error(`${method} 失败: ${JSON.stringify(resJson)}`);
    const waitMs = code === 429 && resJson.parameters?.retry_after ? resJson.parameters.retry_after * 1000 : 2000; await new Promise(r => setTimeout(r, waitMs));
  }
}

async function sendTweetToTg(env, chatId, caption, photos, videos, senderLabel = "", threadId = null, fallbackUrl = "") {
  const maxVideoMB = Number(env.MAX_VIDEO_MB || MAX_VIDEO_MB_DEFAULT);
  const maxVideoBytes = maxVideoMB * 1024 * 1024;
  const MAX_MEDIA_COUNT = 6; const finalCaption = senderLabel ? `${senderLabel}\n${caption || ""}`.trim() : (caption || "");
  const validVideos = [];
  for (const v of videos) { const fmt = v.formats || v.variants || []; const mp4 = fmt.filter(x => x.container === "mp4" || x.content_type === "video/mp4" || /\.mp4(\?|$)/i.test(x.url || "")).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)); if (mp4.length === 0) continue; const usable = mp4.find(x => !x.size || x.size <= maxVideoBytes); if (usable) validVideos.push({ ...v, best: usable, oversize: false }); else validVideos.push({ ...v, best: mp4[0], oversize: true }); }
  if (validVideos.length > 0 && photos.length === 0) { const anyNonOversize = validVideos.some(v => !v.oversize); if (!anyNonOversize) return "OVERSIZE_VIDEO"; }
  let sentAny = false, lastErr = null, allVideoSkippedOversize = validVideos.length > 0 && validVideos.every(v => v.oversize);
  for (let i = 0; i < validVideos.length; i++) {
    const v = validVideos[i]; if (v.oversize) continue;
    try {
      const resp = await fetch(v.best.url, { signal: AbortSignal.timeout(120000) }); if (!resp.ok) { lastErr = new Error(`video download HTTP ${resp.status}`); allVideoSkippedOversize = false; continue; }
      const blob = await resp.blob(); if (blob.size > maxVideoBytes) continue;
      allVideoSkippedOversize = false; const isFirstMedia = !sentAny;
      await tgUploadForm(env.TG_BOT_TOKEN, "sendVideo", () => { const fd = new FormData(); fd.append("chat_id", String(chatId)); if (threadId) fd.append("message_thread_id", String(threadId)); fd.append("video", blob, `video${i}.mp4`); fd.append("supports_streaming", "true"); if (isFirstMedia && finalCaption) fd.append("caption", truncateByCodePoints(finalCaption, 1024)); return fd; });
      sentAny = true;
    } catch (e) { lastErr = e; allVideoSkippedOversize = false; }
  }
  const usePhotos = photos.slice(0, MAX_MEDIA_COUNT);
  if (usePhotos.length > 0) {
    const blobs = [];
    const downloadResults = await Promise.all(usePhotos.map(async (p, idx) => {
      try { const r = await fetch(p.url, { signal: AbortSignal.timeout(30000) }); if (!r.ok) return { idx, blob: null, err: new Error(`photo download HTTP ${r.status}`) }; return { idx, blob: await r.blob(), err: null }; }
      catch (e) { return { idx, blob: null, err: e }; }
    }));
    for (const r of downloadResults) { if (r.blob) blobs.push(r.blob); else if (r.err) lastErr = r.err; }
    const isFirstMedia = !sentAny;
    try {
      if (blobs.length === 1) {
        await tgUploadForm(env.TG_BOT_TOKEN, "sendPhoto", () => { const fd = new FormData(); fd.append("chat_id", String(chatId)); if (threadId) fd.append("message_thread_id", String(threadId)); fd.append("photo", blobs[0], "photo0.jpg"); if (isFirstMedia && finalCaption) fd.append("caption", truncateByCodePoints(finalCaption, 1024)); return fd; });
        sentAny = true;
      } else if (blobs.length > 1) {
        await tgUploadForm(env.TG_BOT_TOKEN, "sendMediaGroup", () => { const fd = new FormData(); fd.append("chat_id", String(chatId)); if (threadId) fd.append("message_thread_id", String(threadId)); const media = []; for (let i = 0; i < blobs.length; i++) { const key = `photo${i}`; fd.append(key, blobs[i], `${key}.jpg`); const item = { type: "photo", media: `attach://${key}` }; if (i === 0 && isFirstMedia && finalCaption) item.caption = truncateByCodePoints(finalCaption, 1024); media.push(item); } fd.append("media", JSON.stringify(media)); return fd; });
        sentAny = true;
      }
    } catch (e) { lastErr = e; }
  }
  if (!sentAny) {
    if (finalCaption && finalCaption.trim()) { const payload = { chat_id: chatId, text: finalCaption, disable_web_page_preview: true }; if (threadId) payload.message_thread_id = threadId; await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", payload); sentAny = true; }
    else if (fallbackUrl) { const payload = { chat_id: chatId, text: fallbackUrl, disable_web_page_preview: false }; if (threadId) payload.message_thread_id = threadId; await sendTgApi(env.TG_BOT_TOKEN, "sendMessage", payload); sentAny = true; }
  }
  if (sentAny) return "SENT";
  if (allVideoSkippedOversize) return "OVERSIZE_VIDEO";
  if (lastErr) throw lastErr;
  throw new Error("无内容可发送"); 
}
