import { hashText, monthSummary, parseMessage } from "./bot.ts";

const SITE_ORIGIN = "https://khrmnvccc.github.io";
const TABLE = "finance_accounts";
const REMINDERS = "debt_reminder_deliveries";
const REFERRAL_CODES = "finance_referral_codes";
const REFERRALS = "finance_referrals";
const REFERRAL_ADMINS = "finance_referral_payout_admins";
// Bump APP_VERSION on each site release: a new URL makes Telegram load the fresh page instead of its cached copy.
const APP_VERSION = "20261125c";
const APP_URL = `${Deno.env.get("APP_URL") || "https://khrmnvccc.github.io/asliddin/"}?v=${APP_VERSION}`;
const LOGIN_DOMAIN = "khrmnvccc.github.io";
const REFERRAL_REWARD = 10000;
const DEFAULT_STATE = { tx: [], debts: [], cats: [], rate: 12500, init: 0, name: "", theme: "" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": SITE_ORIGIN,
      "Access-Control-Allow-Headers": "apikey, content-type, authorization, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    },
  });
}

function validState(state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const value = state as Record<string, unknown>;
  return Array.isArray(value.tx) && value.tx.length <= 10000 &&
    Array.isArray(value.debts) && value.debts.length <= 10000 &&
    Array.isArray(value.cats) && value.cats.length <= 100 &&
    JSON.stringify(value).length <= 750_000;
}

async function hmacHex(keyBytes: Uint8Array, message: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
}

async function signReferralTicket(payload: Record<string, unknown>, serviceKey: string) {
  const body = b64url(JSON.stringify(payload));
  const signature = await hmacHex(enc.encode(serviceKey), body);
  return `${body}.${signature}`;
}

async function readReferralTicket(ticket: unknown, serviceKey: string) {
  if (typeof ticket !== "string" || ticket.length > 2048) return null;
  const [body, signature, extra] = ticket.split(".");
  if (!body || !signature || extra) return null;
  const expected = await hmacHex(enc.encode(serviceKey), body);
  if (signature.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff) return null;
  try {
    const value = JSON.parse(unb64url(body));
    const issuedAt = Number(value.issuedAt);
    if (!/^[A-Z2-9]{8}$/.test(value.code) || !Number.isFinite(issuedAt) || Date.now() - issuedAt > 30 * 86400000 || issuedAt > Date.now() + 60000) return null;
    return { code: value.code as string, issuedAt };
  } catch { return null; }
}

async function restJson(url: string, headers: Record<string, string>, init?: RequestInit) {
  const r = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  if (!r.ok) throw new Error("Database request failed");
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function captureReferral(ticketValue: unknown, serviceKey: string, dbUrl: string, dbHeaders: Record<string, string>, userId: string, username: string, createdAt: string, expiresAt: string | null, subscriptionPaidAt: string | null) {
  const ticket = await readReferralTicket(ticketValue, serviceKey);
  if (!ticket) return;
  const codes = await restJson(`${dbUrl.replace(/\/finance_accounts$/, "")}/${REFERRAL_CODES}?code=eq.${encodeURIComponent(ticket.code)}&select=user_id`, dbHeaders);
  const referrerId = codes?.[0]?.user_id;
  if (!referrerId || referrerId === userId) return;
  const paid = !!subscriptionPaidAt && ticket.issuedAt <= Date.parse(subscriptionPaidAt) && !!expiresAt && Date.parse(expiresAt) > Date.now();
  if (!paid && ticket.issuedAt >= Date.parse(createdAt)) return;
  const inserted = await restJson(`${dbUrl.replace(/\/finance_accounts$/, "")}/${REFERRALS}`, dbHeaders, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ referrer_user_id: referrerId, referred_user_id: userId, invitee_username: username, clicked_at: new Date(ticket.issuedAt).toISOString(), ...(paid ? { subscription_paid_at: subscriptionPaidAt } : {}) }),
  });
  return paid && inserted?.length ? referrerId as string : null;
}

async function telegramUser(initData: string, botToken: string) {
  if (!initData || initData.length > 8192) throw new Error("Telegramni bot ichida oching va qayta urinib ko'ring.");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  const fields = [...params.entries()].filter(([key]) => key !== "hash").sort(([a], [b]) => a.localeCompare(b));
  const check = fields.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(botToken)));
  const expectedHash = await hmacHex(secret, check);
  if (!receivedHash || expectedHash.length !== receivedHash.length) throw new Error("Telegram tasdig'i noto'g'ri.");
  let difference = 0;
  for (let i = 0; i < expectedHash.length; i++) difference |= expectedHash.charCodeAt(i) ^ receivedHash.toLowerCase().charCodeAt(i);
  const authDate = Number(params.get("auth_date"));
  if (difference !== 0 || !Number.isFinite(authDate) || Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) throw new Error("Telegram tasdig'i eskirgan yoki noto'g'ri. Bot ichidan qayta oching.");
  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new Error("Telegram akkaunti aniqlanmadi.");
  return String(user.id);
}

function tashkentParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function som(value: number) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " so'm";
}

function dmy(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

async function sendTelegram(botToken: string, chatId: string | null | undefined, text: string, withAppButton = true) {
  if (!chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...(withAppButton ? { reply_markup: { inline_keyboard: [[{ text: "📒 Ilovani ochish", web_app: { url: APP_URL } }]] } } : {}),
      }),
    });
    return r.ok;
  } catch { return false; }
}

function html(value: unknown) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

// Overdue debts are reminded 1, 3 and 7 days after the due date, then every 7 days.
// Returns the latest step reached, so each step is sent once even if a day was missed.
function lastOverdueStep(daysLate: number) {
  if (daysLate >= 7) return Math.min(9999, Math.floor(daysLate / 7) * 7);
  return daysLate >= 3 ? 3 : 1;
}

// Bot messages the admin can edit in the app. Text uses *bold* and {{name}} placeholders.
const TEMPLATE_TABLE = "bot_templates";
const DEBT_VARS = [{ k: "kun", l: "Kun" }, { k: "holat", l: "Kim kimga" }, { k: "kim", l: "Ism" }, { k: "summa", l: "Qolgan summa" }, { k: "muddat", l: "Muddat" }];
const DEBT_SAMPLE = { kun: "3", holat: "Ali sizga qarzni qaytarishi kerak.", kim: "Ali", summa: "400 000 so'm", muddat: "28.11.2026" };
const TEMPLATES: Record<string, { group: string; title: string; icon: string; hint: string; required?: boolean; vars: { k: string; l: string }[]; sample: Record<string, string>; text: string }> = {
  welcome: { group: "Ro'yxatdan o'tish", title: "Botga xush kelibsiz", icon: "hand", required: true, hint: "Hisobi yo'q odam botga /start yozganda. Ostida \"Raqamni yuborish\" tugmasi chiqadi.", vars: [{ k: "ism", l: "Ism" }], sample: { ism: "Aziz" },
    text: "👋 Assalomu alaykum, {{ism}}!\n\n*Pulim* — kirim, xarajat va qarzlaringizni yuritish uchun bepul yordamchi.\n\nHisob ochish uchun pastdagi *📱 Raqamni yuborish* tugmasini bosing." },
  account_created: { group: "Ro'yxatdan o'tish", title: "Hisob ochildi", icon: "user-check", required: true, hint: "Raqam yuborilgach. {{login}} va {{parol}} albatta qolsin. Ostiga bot qo'llanmasi qo'shiladi.", vars: [{ k: "ism", l: "Ism" }, { k: "login", l: "Login" }, { k: "parol", l: "Parol" }], sample: { ism: "Aziz", login: "998901234567", parol: "k7m2xq9pza" },
    text: "🎉 *Hisobingiz ochildi!*\n\nIlova bot ichida avtomatik kiradi — pastdagi tugmani bosing.\n\nBrauzerdan kirish uchun:\nLogin: {{login}}\nParol: {{parol}}\n\nParolni unutsangiz, /parol deb yozing." },
  debt_before: { group: "Qarz eslatmalari", title: "Muddatga oz qoldi", icon: "calendar-clock", hint: "Muddatdan 3 va 1 kun oldin.", vars: DEBT_VARS, sample: DEBT_SAMPLE,
    text: "⏰ *Qarz muddatiga {{kun}} kun qoldi*\n\n{{holat}}\nQolgan summa: *{{summa}}*\nMuddat: {{muddat}}" },
  debt_due: { group: "Qarz eslatmalari", title: "Bugun to'lov kuni", icon: "bell", hint: "Muddat kelgan kuni.", vars: DEBT_VARS, sample: { ...DEBT_SAMPLE, kun: "0" },
    text: "📅 *Bugun qarz muddati*\n\n{{holat}}\nQolgan summa: *{{summa}}*\nMuddat: {{muddat}}" },
  debt_overdue: { group: "Qarz eslatmalari", title: "Muddati o'tdi", icon: "alarm-clock", hint: "Muddatdan 1, 3, 7 kun o'tib, keyin har hafta.", vars: DEBT_VARS, sample: { ...DEBT_SAMPLE, kun: "3" },
    text: "⚠️ *Qarz muddati {{kun}} kun o'tib ketdi*\n\n{{holat}}\nQolgan summa: *{{summa}}*\nMuddat: {{muddat}}\n\nTo'lov bo'lgan bo'lsa, ilovada belgilab qo'ying." },
  test_reminder: { group: "Boshqa", title: "Sinov eslatmasi", icon: "bell-ring", required: true, hint: "Foydalanuvchi ilovada \"Sinov xabarini yuborish\" ni bosganda.", vars: [], sample: {},
    text: "🔔 *Sinov eslatmasi*\n\nHammasi joyida — qarz muddatlari yaqinlashganda shu yerga xabar keladi." },
};

type TemplateRows = Record<string, { enabled: boolean; text: string }>;
async function loadTemplates(db: string, headers: Record<string, string>): Promise<TemplateRows> {
  try {
    const rows = await restJson(`${db}/${TEMPLATE_TABLE}?select=key,enabled,text`, headers);
    return Object.fromEntries((rows || []).map((r: any) => [r.key, { enabled: r.enabled !== false, text: String(r.text || "") }]));
  } catch { return {}; }
}
function tplOn(rows: TemplateRows, key: string) { return !!TEMPLATES[key]?.required || rows[key]?.enabled !== false; }
function renderTpl(text: string, vars: Record<string, string>) {
  return html(text).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? html(vars[k]) : m));
}
function tpl(rows: TemplateRows, key: string, vars: Record<string, string>) {
  return renderTpl(rows[key]?.text?.trim() || TEMPLATES[key].text, vars);
}

function debtReminderText(rows: TemplateRows, debt: any, remaining: number, daysLeft: number) {
  const key = daysLeft > 0 ? "debt_before" : daysLeft === 0 ? "debt_due" : "debt_overdue";
  if (!tplOn(rows, key)) return null;
  const who = String(debt.name || "").slice(0, 80);
  const holat = debt.kind === "t" ? `Siz ${who}ga qarzdorsiz.` : `${who} sizga qarzni qaytarishi kerak.`;
  return tpl(rows, key, { kun: String(Math.abs(daysLeft)), holat, kim: who, summa: som(remaining), muddat: dmy(debt.due) });
}

async function sendDebtReminders(supabaseUrl: string, serviceKey: string, botToken: string) {
  const db = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const accounts = await restJson(`${db}/${TABLE}?telegram_chat_id=not.is.null&select=user_id,state,telegram_chat_id,expires_at`, headers);
  const templates = await loadTemplates(db, headers);
  const now = tashkentParts();
  const todayUtc = Date.parse(`${now.day}T00:00:00Z`);
  let sent = 0;
  const list: any[] = accounts || [];
  // A few accounts at a time so one hourly run finishes quickly even with many users.
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map((account) => remindAccount(account).catch(() => {})));
  }
  return sent;

  async function remindAccount(account: any) {
    const prefs = account.state?.reminderPrefs || {};
    const deliveries = new Set<string>();
    const loadDeliveries = async () => {
      const since = new Date(todayUtc - 400 * 86400000).toISOString().slice(0, 10);
      const rows = await restJson(`${db}/${REMINDERS}?user_id=eq.${encodeURIComponent(account.user_id)}&due_date=gte.${since}&select=debt_id,due_date,reminder_type`, headers);
      for (const row of rows || []) deliveries.add(`${row.debt_id}|${row.due_date}|${row.reminder_type}`);
    };
    let loaded = false;
    const deliver = async (debtId: string, dueDate: string, type: string, text: string | null) => {
      if (!text) return;
      if (!loaded) { await loadDeliveries(); loaded = true; }
      if (deliveries.has(`${debtId}|${dueDate}|${type}`)) return;
      // Claim the slot first so a slow or repeated cron run cannot send the same reminder twice.
      const claim = await fetch(`${db}/${REMINDERS}?on_conflict=user_id,debt_id,due_date,reminder_type`, { method: "POST", headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ user_id: account.user_id, debt_id: debtId, due_date: dueDate, reminder_type: type }) });
      if (!claim.ok || !(await claim.json()).length) return;
      deliveries.add(`${debtId}|${dueDate}|${type}`);
      if (await sendTelegram(botToken, account.telegram_chat_id, text)) sent++;
      else await fetch(`${db}/${REMINDERS}?user_id=eq.${encodeURIComponent(account.user_id)}&debt_id=eq.${encodeURIComponent(debtId)}&due_date=eq.${dueDate}&reminder_type=eq.${type}`, { method: "DELETE", headers });
    };

    // Blocked accounts get nothing.
    if (account.expires_at && Date.parse(account.expires_at) <= Date.now()) return;

    // Reminders are on unless the user turned them off.
    if (prefs.enabled === false) return;
    // Send at the chosen hour, or later the same day if that hourly run was missed.
    if (now.hour < Number(String(prefs.time || "09:00").slice(0, 2))) return;
    for (const debt of account.state?.debts || []) {
      if (!debt?.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(debt.due || "")) || !Array.isArray(debt.pays)) continue;
      const remaining = Number(debt.amt) - debt.pays.reduce((total: number, payment: any) => total + Number(payment?.a || 0), 0);
      if (!(remaining > 0.009)) continue;
      const daysLeft = Math.round((Date.parse(`${debt.due}T00:00:00Z`) - todayUtc) / 86400000);
      // Windows instead of exact days, so a missed hourly run (or a debt added late) still gets its reminder once.
      let type = "";
      if (daysLeft >= 2 && daysLeft <= 3 && prefs.before !== false) type = "before_3_days";
      else if (daysLeft === 1 && prefs.before !== false) type = "before_1_day";
      else if (daysLeft === 0 && prefs.due !== false) type = "due_today";
      else if (daysLeft < 0 && prefs.overdue !== false) type = `overdue_${lastOverdueStep(-daysLeft)}`;
      if (!type) continue;
      await deliver(String(debt.id), debt.due, type, debtReminderText(templates, debt, remaining, daysLeft));
    }
  }
}

async function webhookSecret(botToken: string) {
  return (await hmacHex(enc.encode(botToken), "pulim-webhook")).slice(0, 48);
}

async function tgCall(botToken: string, method: string, payload: Record<string, unknown>) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return await r.json();
  } catch { return null; }
}

let cachedBotUsername = "";
async function botUsername(botToken: string) {
  if (!cachedBotUsername) cachedBotUsername = (await tgCall(botToken, "getMe", {}))?.result?.username || "";
  return cachedBotUsername;
}

// A friend who opened the bot through a referral link gets credited once they have an
// account linked to the same Telegram chat (same rules as the browser referral ticket).
async function attachClickReferral(db: string, headers: Record<string, string>, userId: string, chatId: string, createdAt: string, botToken: string | undefined) {
  const click = (await restJson(`${db}/finance_referral_clicks?telegram_id=eq.${encodeURIComponent(chatId)}&select=code,clicked_at`, headers))?.[0];
  if (!click) return;
  const referrerId = (await restJson(`${db}/${REFERRAL_CODES}?code=eq.${encodeURIComponent(click.code)}&select=user_id`, headers))?.[0]?.user_id;
  if (!referrerId || referrerId === userId) return;
  const account = (await restJson(`${db}/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=expires_at,subscription_paid_at`, headers))?.[0] || {};
  const clickedAt = Date.parse(click.clicked_at);
  const paid = !!account.subscription_paid_at && clickedAt <= Date.parse(account.subscription_paid_at) && !!account.expires_at && Date.parse(account.expires_at) > Date.now();
  if (!paid && clickedAt >= Date.parse(createdAt)) return;
  const login = (await restJson(`${db.replace(/\/rest\/v1$/, "")}/auth/v1/admin/users/${userId}`, headers).catch(() => null))?.email?.split("@")[0] || "";
  const inserted = await restJson(`${db}/${REFERRALS}`, headers, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ referrer_user_id: referrerId, referred_user_id: userId, invitee_username: login, clicked_at: click.clicked_at, ...(paid ? { subscription_paid_at: account.subscription_paid_at } : {}) }) });
  if (paid && inserted?.length && botToken) {
    const chat = (await restJson(`${db}/${TABLE}?user_id=eq.${encodeURIComponent(referrerId)}&select=telegram_chat_id`, headers))?.[0]?.telegram_chat_id;
    await sendTelegram(botToken, chat, `🎉 <b>Taklifingiz ishladi!</b>\n\n${html(login || "Do'stingiz")} obuna bo'ldi. Sizga ${som(REFERRAL_REWARD)} mukofot hisoblandi — tez orada kartangizga o'tkaziladi.`);
  }
}

const APP_BUTTON = [{ text: "📒 Ilovani ochish", web_app: { url: APP_URL } }];
const CONTACT_KEYBOARD = { keyboard: [[{ text: "📱 Raqamni yuborish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };

function newPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (n) => alphabet[n % alphabet.length]).join("");
}

function authAdmin(supabaseUrl: string, serviceKey: string) {
  return { url: `${supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users`, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" } };
}

// Signs a user in without a password (the Mini App proves who they are with Telegram initData).
async function sessionFor(supabaseUrl: string, serviceKey: string, publishableKey: string, email: string) {
  const base = supabaseUrl.replace(/\/$/, "");
  const admin = authAdmin(supabaseUrl, serviceKey);
  const link = await restJson(`${base}/auth/v1/admin/generate_link`, admin.headers, { method: "POST", body: JSON.stringify({ type: "magiclink", email }) });
  const tokenHash = link?.hashed_token || link?.properties?.hashed_token;
  if (!tokenHash) throw new Error("No token");
  const r = await fetch(`${base}/auth/v1/verify`, { method: "POST", headers: { apikey: publishableKey || serviceKey, "Content-Type": "application/json" }, body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }) });
  const session = await r.json().catch(() => null);
  if (!r.ok || !session?.access_token) throw new Error("Verify failed");
  return session;
}

// The bot opens an account for anyone who shares their own phone number. The login is the number.
async function registerByContact(db: string, headers: Record<string, string>, supabaseUrl: string, serviceKey: string, botToken: string, from: any, contact: any, reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown>) {
  const chatId = String(from.id);
  if (String(contact?.user_id || "") !== chatId) return reply("Iltimos, pastdagi tugma orqali <b>o'zingizning</b> raqamingizni yuboring.", { reply_markup: CONTACT_KEYBOARD });
  const login = String(contact.phone_number || "").replace(/\D/g, "").slice(0, 20);
  if (login.length < 7) return reply("Raqamni o'qib bo'lmadi. Qayta urinib ko'ring.", { reply_markup: CONTACT_KEYBOARD });
  const linked = await restJson(`${db}/${TABLE}?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=user_id&limit=1`, headers);
  if (linked?.length) {
    await reply("✅ Hisobingiz allaqachon ochilgan.", { reply_markup: { remove_keyboard: true } });
    return reply("Ilovani pastdagi tugma orqali oching. Brauzerdan kirish uchun parol kerak bo'lsa, /parol deb yozing.", { reply_markup: { inline_keyboard: [APP_BUTTON] } });
  }
  const admin = authAdmin(supabaseUrl, serviceKey);
  const password = newPassword();
  const created = await fetch(admin.url, { method: "POST", headers: admin.headers, body: JSON.stringify({ email: `${login}@${LOGIN_DOMAIN}`, password, email_confirm: true, user_metadata: { telegram_id: chatId, phone: login } }) });
  const createdBody = await created.json().catch(() => ({}));
  const userId = createdBody.id || createdBody.user?.id;
  if (!created.ok || !userId) return reply("Bu raqam bilan hisob avval ochilgan yoki xatolik bo'ldi. Muammo davom etsa, @khrmnvccc ga yozing.", { reply_markup: { remove_keyboard: true } });
  const name = String(from.first_name || "").slice(0, 40);
  await restJson(`${db}/${TABLE}?on_conflict=user_id`, headers, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: userId, state: { ...DEFAULT_STATE, name }, telegram_chat_id: chatId, updated_at: new Date().toISOString() }) });
  await attachClickReferral(db, headers, userId, chatId, String(createdBody.created_at || new Date().toISOString()), botToken).catch(() => {});
  await reply("✅ Raqamingiz qabul qilindi.", { reply_markup: { remove_keyboard: true } });
  const created_text = tpl(await loadTemplates(db, headers), "account_created", { ism: name, login, parol: password });
  // The login and password must reach the user even if the edited text dropped them.
  const creds = created_text.includes(password) ? "" : `\n\nLogin: <code>${login}</code>\nParol: <code>${password}</code>`;
  return reply(`${created_text}${creds}\n\n${HELP_TEXT}`, { reply_markup: { inline_keyboard: [APP_BUTTON] } });
}
const HELP_TEXT = [
  "✍️ <b>Kirim va xarajatni shu yerga yozing</b> — ilovani ochish shart emas.",
  "",
  "<code>50000 taksi</code> — xarajat",
  "<code>35k ovqat</code> — 35 000 so'm",
  "<code>+4.5mln oylik</code> — kirim",
  "<code>$20 kafe</code> — dollarda",
  "<code>kecha 120000 benzin</code> — kechagi sana bilan",
  "",
  "💳 Bank yoki CardXabar xabarini shu yerga <b>forward</b> qilsangiz, summasi va turi o'zi aniqlanadi.",
  "",
  "/balans — shu oy hisoboti · /bugun — bugungi yozuvlar",
].join("\n");

function txCard(tx: any, title: string) {
  const sign = tx.type === "in" ? "💰" : "💸";
  return [
    `${title}`,
    "",
    `${sign} <b>${som(tx.amt)}</b>${tx.usd ? ` ($${tx.usd})` : ""} · ${html(tx.cat)}`,
    tx.note ? `📝 ${html(tx.note)}` : "",
    `📅 ${dmy(tx.date)} · ${html(tx.method)}`,
  ].filter(Boolean).join("\n");
}

function txButtons(tx: any) {
  return { inline_keyboard: [[{ text: "↩️ Bekor qilish", callback_data: `del:${tx.id}` }, { text: tx.type === "in" ? "🔄 Xarajat qilish" : "🔄 Kirim qilish", callback_data: `flip:${tx.id}` }], APP_BUTTON] };
}

// Applies a change to the account's state, retrying if the app saved in between.
async function updateState(db: string, headers: Record<string, string>, userId: string, change: (state: any) => any) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = (await restJson(`${db}/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=state,updated_at`, headers))?.[0];
    if (!row) return null;
    const state = { ...DEFAULT_STATE, ...(row.state || {}) };
    const result = change(state);
    if (result === undefined) return { state, result };
    const r = await fetch(`${db}/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`, { method: "PATCH", headers: { ...headers, Prefer: "return=representation" }, body: JSON.stringify({ state, updated_at: new Date().toISOString() }) });
    if (r.ok && (await r.json()).length) return { state, result };
  }
  throw new Error("State update conflict");
}

async function handleTelegramUpdate(update: any, supabaseUrl: string, serviceKey: string, botToken: string) {
  const db = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const callback = update.callback_query;
  const message = update.message;
  const from = callback?.from || message?.from;
  if (!from?.id || from.is_bot) return;
  if (message && message.chat?.type !== "private") return;
  const chatId = String(from.id);
  const reply = (text: string, extra: Record<string, unknown> = {}) => tgCall(botToken, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

  const text = String(message?.text || message?.caption || "").trim();
  if (message?.contact) return registerByContact(db, headers, supabaseUrl, serviceKey, botToken, from, message.contact, reply);
  if (message && /^\/(start|help|yordam)\b/i.test(text)) {
    const code = (text.match(/^\/start\s+ref_?([A-Z2-9]{8})\b/i)?.[1] || "").toUpperCase();
    let invited = false;
    if (code) {
      try {
        const owner = (await restJson(`${db}/${REFERRAL_CODES}?code=eq.${code}&select=user_id`, headers))?.[0]?.user_id;
        const linked = await restJson(`${db}/${TABLE}?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=user_id&limit=1`, headers);
        if (owner && !linked?.length) {
          const inserted = await restJson(`${db}/finance_referral_clicks`, headers, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ telegram_id: chatId, code, first_name: String(from.first_name || "").slice(0, 60), username: String(from.username || "").slice(0, 40) }) });
          invited = true;
          const ownerChat = (await restJson(`${db}/${TABLE}?user_id=eq.${encodeURIComponent(owner)}&select=telegram_chat_id`, headers))?.[0]?.telegram_chat_id;
          if (inserted?.length && ownerChat && ownerChat !== chatId) await sendTelegram(botToken, ownerChat, `👋 <b>${html(from.first_name || "Yangi odam")}</b> sizning havolangiz orqali botga kirdi.\n\nU obuna olsa, sizga ${som(REFERRAL_REWARD)} mukofot hisoblanadi.`);
        }
      } catch { /* Referral tracking must not block the welcome. */ }
    }
    const intro = invited ? "Siz do'stingiz taklifi bilan keldingiz 🎁\n\n" : "";
    const hasAccount = !!(await restJson(`${db}/${TABLE}?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=user_id&limit=1`, headers).catch(() => []))?.length;
    if (!hasAccount) return reply(`${intro}${tpl(await loadTemplates(db, headers), "welcome", { ism: String(from.first_name || "").slice(0, 40) || "do'stim" })}`, { reply_markup: CONTACT_KEYBOARD });
    return reply(`👋 Assalomu alaykum!\n\n${intro}${HELP_TEXT}`, { reply_markup: { inline_keyboard: [APP_BUTTON] } });
  }

  const account = (await restJson(`${db}/${TABLE}?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=user_id,state,expires_at&order=updated_at.desc&limit=1`, headers))?.[0];
  if (!account) {
    if (callback) return tgCall(botToken, "answerCallbackQuery", { callback_query_id: callback.id, text: "Hisob ulanmagan", show_alert: true });
    return reply("🔐 Sizda hali hisob yo'q.\n\nHisob ochish uchun pastdagi <b>📱 Raqamni yuborish</b> tugmasini bosing.", { reply_markup: CONTACT_KEYBOARD });
  }
  if (account.expires_at && Date.parse(account.expires_at) <= Date.now()) {
    if (callback) return tgCall(botToken, "answerCallbackQuery", { callback_query_id: callback.id, text: "Hisobingiz bloklangan", show_alert: true });
    return reply("⛔️ Hisobingiz bloklangan. Savol bo'lsa, yozing: @khrmnvccc");
  }

  if (message && /^\/(parol|password)\b/i.test(text)) {
    const admin = authAdmin(supabaseUrl, serviceKey);
    const user = await restJson(`${admin.url}/${account.user_id}`, admin.headers).catch(() => null);
    const login = String(user?.email || "").split("@")[0];
    const password = newPassword();
    const r = await fetch(`${admin.url}/${account.user_id}`, { method: "PUT", headers: admin.headers, body: JSON.stringify({ password }) });
    if (!r.ok || !login) return reply("Parolni yangilab bo'lmadi. Keyinroq urinib ko'ring.");
    return reply(`🔑 <b>Yangi parol</b>\n\nLogin: <code>${login}</code>\nParol: <code>${password}</code>\n\nEski parol endi ishlamaydi.`);
  }

  if (callback) {
    const [action, txId] = String(callback.data || "").split(":");
    const done = await updateState(db, headers, account.user_id, (state) => {
      const list = Array.isArray(state.tx) ? state.tx : [];
      const i = list.findIndex((t: any) => t.id === txId);
      if (i < 0) return undefined;
      if (action === "del") { const [removed] = list.splice(i, 1); state.tx = list; return { removed }; }
      if (action === "flip") {
        const t = list[i];
        t.type = t.type === "in" ? "out" : "in";
        if (t.src === "bot") t.cat = t.type === "in" ? "Boshqa" : "🔧 Boshqa";
        state.tx = list;
        return { flipped: t };
      }
      return undefined;
    });
    const msg = callback.message;
    if (!done?.result) return tgCall(botToken, "answerCallbackQuery", { callback_query_id: callback.id, text: "Bu yozuv topilmadi yoki allaqachon o'chirilgan." });
    if (done.result.removed) {
      if (msg) await tgCall(botToken, "editMessageText", { chat_id: chatId, message_id: msg.message_id, text: txCard(done.result.removed, "🗑 <b>Bekor qilindi</b>"), parse_mode: "HTML" });
      return tgCall(botToken, "answerCallbackQuery", { callback_query_id: callback.id, text: "O'chirildi" });
    }
    const t = done.result.flipped;
    if (msg) await tgCall(botToken, "editMessageText", { chat_id: chatId, message_id: msg.message_id, text: txCard(t, t.type === "in" ? "✅ <b>Kirim qo'shildi</b>" : "✅ <b>Xarajat qo'shildi</b>"), parse_mode: "HTML", reply_markup: txButtons(t) });
    return tgCall(botToken, "answerCallbackQuery", { callback_query_id: callback.id, text: t.type === "in" ? "Kirimga o'zgartirildi" : "Xarajatga o'zgartirildi" });
  }

  if (!text) return reply(HELP_TEXT);
  if (/^\/(balans|hisobot|oy)\b/i.test(text)) {
    const s = monthSummary(account.state);
    const [y, m] = s.month.split("-");
    const top = s.top.map(([c, v]) => `• ${html(c)} — ${som(v)}`).join("\n");
    return reply(`📊 <b>${m}.${y} hisoboti</b>\n\n💰 Kirim: <b>${som(s.income)}</b>\n💸 Xarajat: <b>${som(s.expense)}</b>\n📈 Farq: <b>${som(s.income - s.expense)}</b>\n\n👛 Umumiy balans: <b>${som(s.balance)}</b>${top ? `\n\nEng ko'p xarajat:\n${top}` : ""}`, { reply_markup: { inline_keyboard: [APP_BUTTON] } });
  }
  if (/^\/bugun\b/i.test(text)) {
    const day = tashkentParts().day;
    const list = (account.state?.tx || []).filter((t: any) => t.date === day);
    if (!list.length) return reply("Bugun hali yozuv yo'q. Masalan: <code>50000 taksi</code>");
    const lines = list.slice(-20).map((t: any) => `${t.type === "in" ? "💰 +" : "💸 −"}${som(t.amt)} · ${html(t.cat)}${t.note ? ` · ${html(String(t.note).slice(0, 30))}` : ""}`);
    return reply(`📅 <b>Bugun</b>\n\n${lines.join("\n")}`);
  }
  if (text.startsWith("/")) return reply(HELP_TEXT);

  const parsed = parseMessage(text, Number(account.state?.rate) || 12500);
  if (!parsed) return reply(`🤔 Summani topa olmadim.\n\n${HELP_TEXT}`);
  const hash = await hashText(text);
  const tx = {
    id: "t" + Date.now() + Math.floor(Math.random() * 1000),
    type: parsed.type, amt: parsed.amt, usd: parsed.usd, rate: parsed.usd ? Number(account.state?.rate) || 12500 : 1,
    date: parsed.date, cat: parsed.cat, note: parsed.note, method: parsed.method,
    src: "bot", ts: Date.now(), ...(parsed.bank ? { tgHash: hash } : {}),
  };
  const done = await updateState(db, headers, account.user_id, (state) => {
    const list = Array.isArray(state.tx) ? state.tx : [];
    if (parsed.bank && list.some((t: any) => t.tgHash === hash)) return undefined;
    list.push(tx);
    state.tx = list;
    return true;
  });
  if (!done?.result) return reply("ℹ️ Bu bank xabari avval qo'shilgan.");
  return reply(txCard(tx, tx.type === "in" ? "✅ <b>Kirim qo'shildi</b>" : "✅ <b>Xarajat qo'shildi</b>"), { reply_markup: txButtons(tx) });
}

// The cron job sends the key stored in Vault. It may be a different (but valid) server key
// than the one this function receives, so the database compares it against Vault itself.
async function cronAllowed(authorization: string, supabaseUrl: string, serviceKey: string) {
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (token === serviceKey) return true;
  try {
    const ok = await restJson(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/verify_reminder_cron_token`, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ token }) });
    return ok === true;
  } catch { return false; }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return response({}, 200);
  if (req.method !== "POST") return response({ ok: false, error: "Method not allowed" }, 405);

  try {
    const raw = await req.text();
    if (raw.length > 1_000_000) return response({ ok: false, error: "Request too large" }, 413);
    const body = JSON.parse(raw);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const telegramSecret = req.headers.get("x-telegram-bot-api-secret-token");
    if (telegramSecret !== null) {
      if (!botToken || !supabaseUrl || !serviceKey || telegramSecret !== await webhookSecret(botToken)) return response({ ok: false }, 403);
      try { await handleTelegramUpdate(body, supabaseUrl, serviceKey, botToken); } catch { /* Always 200 so Telegram doesn't retry forever. */ }
      return response({ ok: true });
    }
    if (body.action === "setup_webhook") {
      if (origin || !serviceKey || !supabaseUrl || !botToken) return response({ ok: false, error: "Forbidden" }, 403);
      if (!(await cronAllowed(req.headers.get("authorization") || "", supabaseUrl, serviceKey))) return response({ ok: false, error: "Forbidden" }, 403);
      const url = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/telegram-finance`;
      if (body.menu) await tgCall(botToken, "setChatMenuButton", { menu_button: { type: "web_app", text: "Ilova", web_app: { url: APP_URL } } });
      const info = await tgCall(botToken, "getWebhookInfo", {});
      const current = info?.result?.url || "";
      if (body.mode !== "set" || (current && current !== url && !body.force)) return response({ ok: true, changed: false, current, pending: info?.result?.pending_update_count ?? null, lastError: info?.result?.last_error_message || null });
      const set = await tgCall(botToken, "setWebhook", { url, secret_token: await webhookSecret(botToken), allowed_updates: ["message", "callback_query"], max_connections: 20 });
      const commands = await tgCall(botToken, "setMyCommands", { commands: [{ command: "balans", description: "Shu oy hisoboti" }, { command: "bugun", description: "Bugungi yozuvlar" }, { command: "help", description: "Qanday yozish kerak" }] });
      return response({ ok: !!set?.ok, changed: true, set: set?.description || null, commands: !!commands?.ok });
    }
    const isCron = body.action === "send_reminders";
    if (isCron) {
      if (origin || !serviceKey || !supabaseUrl) return response({ ok: false, error: "Forbidden" }, 403);
      if (!(await cronAllowed(req.headers.get("authorization") || "", supabaseUrl, serviceKey))) return response({ ok: false, error: "Forbidden" }, 403);
      if (!botToken) return response({ ok: false, error: "Reminder secrets are not configured" }, 503);
      const job = sendDebtReminders(supabaseUrl, serviceKey, botToken);
      // deno-lint-ignore no-explicit-any
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) { runtime.waitUntil(job.catch(() => 0)); return response({ ok: true, started: true }); }
      return response({ ok: true, sent: await job });
    }
    if (origin !== SITE_ORIGIN) return response({ ok: false, error: "Forbidden" }, 403);
    if (body.action === "referral_click") {
      if (!supabaseUrl || !serviceKey) return response({ ok: false, error: "Server is not configured" }, 503);
      const code = String(body.code || "").toUpperCase();
      if (!/^[A-Z2-9]{8}$/.test(code)) return response({ ok: false, error: "Taklif havolasi noto‘g‘ri" }, 400);
      const root = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
      const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
      const codes = await restJson(`${root}/${REFERRAL_CODES}?code=eq.${encodeURIComponent(code)}&select=code`, headers);
      if (!codes?.length) return response({ ok: false, error: "Taklif havolasi topilmadi" }, 404);
      const ticket = await signReferralTicket({ code, issuedAt: Date.now() }, serviceKey);
      return response({ ok: true, ticket, botUsername: botToken ? await botUsername(botToken) : "" });
    }
    if (body.action === "tg_login") {
      // Opening the app inside Telegram signs the user in by their Telegram account.
      if (!supabaseUrl || !serviceKey || !botToken) return response({ ok: false, error: "Server is not configured" }, 503);
      let chatId = "";
      try { chatId = await telegramUser(String(body.initData || ""), botToken); } catch (e) { return response({ ok: false, error: e instanceof Error ? e.message : "Telegram tasdig'i noto'g'ri." }, 401); }
      const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
      const account = (await restJson(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${TABLE}?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=user_id&order=updated_at.desc&limit=1`, headers))?.[0];
      if (!account) return response({ ok: false, error: "Hisob topilmadi. Botga raqamingizni yuborib hisob oching.", needsSignup: true }, 404);
      const admin = authAdmin(supabaseUrl, serviceKey);
      const user = await restJson(`${admin.url}/${account.user_id}`, admin.headers);
      if (!user?.email) return response({ ok: false, error: "Hisob topilmadi." }, 404);
      try {
        const session = await sessionFor(supabaseUrl, serviceKey, req.headers.get("apikey") || "", user.email);
        return response({ ok: true, session, username: String(user.email).split("@")[0] });
      } catch { return response({ ok: false, error: "Kirib bo'lmadi. Qayta urinib ko'ring." }, 500); }
    }
    const publishableKey = req.headers.get("apikey") || "";
    const accessToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!supabaseUrl || !serviceKey) return response({ ok: false, error: "Server is not configured" }, 503);
    if (!publishableKey || !accessToken) return response({ ok: false, error: "Login required" }, 401);

    const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!authResponse.ok) return response({ ok: false, error: "Login expired. Please sign in again." }, 401);
    const authUser = await authResponse.json();
    const userId = typeof authUser?.id === "string" && UUID_RE.test(authUser.id) ? authUser.id : "";
    if (!userId) return response({ ok: false, error: "Invalid account" }, 401);

    const dbUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${TABLE}`;
    const dbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
    const root = dbUrl.replace(/\/finance_accounts$/, "");
    const isAdmin = async () => !!(await restJson(`${root}/${REFERRAL_ADMINS}?user_id=eq.${encodeURIComponent(userId)}&select=user_id`, dbHeaders))?.length;
    const chatIdOf = async (id: string) => (await restJson(`${dbUrl}?user_id=eq.${encodeURIComponent(id)}&select=telegram_chat_id`, dbHeaders))?.[0]?.telegram_chat_id || null;

    const accountResponse = await fetch(`${dbUrl}?user_id=eq.${encodeURIComponent(userId)}&select=expires_at,subscription_paid_at,telegram_chat_id,state`, { headers: dbHeaders });
    if (!accountResponse.ok) return response({ ok: false, error: "Could not check subscription" }, 500);
    const accountRows = await accountResponse.json();
    const expiresAt = accountRows[0]?.expires_at;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return response({ ok: false, error: "Hisobingiz bloklangan. Savol bo'lsa, Telegram orqali yozing: @khrmnvccc" }, 402);
    }

    if (body.action === "load") {
      // Opening the app inside Telegram links that chat to this account if nothing else uses it.
      if (botToken && body.initData && !accountRows[0]?.telegram_chat_id) {
        try {
          const chatId = await telegramUser(String(body.initData), botToken);
          const taken = await restJson(`${dbUrl}?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=user_id&limit=1`, dbHeaders);
          if (!taken?.length) {
            await restJson(`${dbUrl}?on_conflict=user_id`, dbHeaders, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: userId, state: accountRows[0]?.state ?? DEFAULT_STATE, telegram_chat_id: chatId }) });
            accountRows[0] = { ...(accountRows[0] || {}), telegram_chat_id: chatId };
            await attachClickReferral(root, dbHeaders, userId, chatId, String(authUser.created_at || new Date().toISOString()), botToken).catch(() => {});
          }
        } catch { /* Linking is optional. */ }
      }
      try {
        const credited = await captureReferral(body.referralTicket, serviceKey, dbUrl, dbHeaders, userId, String(authUser.email || "").split("@")[0], String(authUser.created_at || new Date().toISOString()), expiresAt || null, accountRows[0]?.subscription_paid_at || null);
        if (credited && botToken) await sendTelegram(botToken, await chatIdOf(credited), `🎉 <b>Taklifingiz ishladi!</b>\n\n${html(String(authUser.email || "").split("@")[0])} obuna bo'ldi. Sizga ${som(REFERRAL_REWARD)} mukofot hisoblandi — tez orada kartangizga o'tkaziladi.`);
      } catch { /* Referral attribution must not block account access. */ }
      const r = await fetch(`${dbUrl}?user_id=eq.${encodeURIComponent(userId)}&select=state`, { headers: dbHeaders });
      if (!r.ok) return response({ ok: false, error: "Could not load account" }, 500);
      const rows = await r.json();
      return response({ ok: true, state: rows[0]?.state ?? DEFAULT_STATE, telegramLinked: !!accountRows[0]?.telegram_chat_id, isAdmin: await isAdmin(), serverTime: Date.now() });
    }
    if (body.action === "referrals") {
      let own = await restJson(`${root}/${REFERRAL_CODES}?user_id=eq.${encodeURIComponent(userId)}&select=code`, dbHeaders);
      if (!own?.length) {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => alphabet[n % alphabet.length]).join("");
        try {
          await restJson(`${root}/${REFERRAL_CODES}`, dbHeaders, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ user_id: userId, code }) });
        } catch { /* Another session may have created the code first. */ }
        own = await restJson(`${root}/${REFERRAL_CODES}?user_id=eq.${encodeURIComponent(userId)}&select=code`, dbHeaders);
      }
      if (!own?.length) return response({ ok: false, error: "Taklif havolasini yaratib bo‘lmadi. SQL sozlamasini tekshiring." }, 500);
      const displayName = String(authUser.email || "").split("@")[0].slice(0, 40) || "Ishtirokchi";
      await restJson(`${root}/${REFERRAL_CODES}?user_id=eq.${encodeURIComponent(userId)}`, dbHeaders, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ display_name: displayName }) });
      const rows = await restJson(`${root}/${REFERRALS}?referrer_user_id=eq.${encodeURIComponent(userId)}&select=referred_user_id,invitee_username,clicked_at,subscription_paid_at,reward_paid_at&order=clicked_at.desc&limit=500`, dbHeaders);
      const leaderboard = await restJson(`${root}/rpc/get_referral_leaderboard`, dbHeaders, { method: "POST", body: "{}" });
      // People who opened the bot through the link but have no linked account yet.
      const clicks = await restJson(`${root}/finance_referral_clicks?code=eq.${own[0].code}&select=telegram_id,first_name,username,clicked_at&order=clicked_at.desc&limit=200`, dbHeaders).catch(() => []);
      const linkedIds = clicks?.length ? new Set(((await restJson(`${dbUrl}?telegram_chat_id=in.(${clicks.map((c: any) => c.telegram_id).join(",")})&select=telegram_chat_id`, dbHeaders)) || []).map((a: any) => a.telegram_chat_id)) : new Set();
      const pendingClicks = (clicks || []).filter((c: any) => !linkedIds.has(c.telegram_id)).map((c: any) => ({ name: c.first_name || (c.username ? "@" + c.username : "Telegram foydalanuvchi"), clicked_at: c.clicked_at }));
      return response({ ok: true, code: own[0].code, referrals: rows || [], pendingClicks, leaderboard: leaderboard || [], canManagePayouts: await isAdmin(), rewardPerPaidInvite: REFERRAL_REWARD });
    }
    if (body.action === "mark_referral_paid") {
      const referredUserId = String(body.referredUserId || "");
      if (!UUID_RE.test(referredUserId)) return response({ ok: false, error: "Foydalanuvchi aniqlanmadi." }, 400);
      if (!(await isAdmin())) return response({ ok: false, error: "Bu amal faqat boshqaruvchiga ruxsat etilgan." }, 403);
      const payout = await fetch(`${root}/${REFERRALS}?referred_user_id=eq.${encodeURIComponent(referredUserId)}&subscription_paid_at=not.is.null&reward_paid_at=is.null&select=referrer_user_id,invitee_username`, {
        method: "PATCH",
        headers: { ...dbHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ reward_paid_at: new Date().toISOString() }),
      });
      if (!payout.ok) return response({ ok: false, error: "To‘lov holatini saqlab bo‘lmadi." }, 500);
      const paidRows = await payout.json();
      if (!paidRows.length) return response({ ok: false, error: "Bu taklif topilmadi, obunasi tasdiqlanmagan yoki mukofot avval belgilangan." }, 409);
      if (botToken) {
        const chat = await chatIdOf(paidRows[0].referrer_user_id);
        await sendTelegram(botToken, chat, `💸 <b>Mukofot yuborildi!</b>\n\n${html(paidRows[0].invitee_username || "Do'stingiz")}ni taklif qilganingiz uchun ${som(REFERRAL_REWARD)} kartangizga o'tkazildi. Rahmat!`);
      }
      return response({ ok: true });
    }
    if (String(body.action || "").startsWith("admin_")) {
      if (!(await isAdmin())) return response({ ok: false, error: "Bu bo‘lim faqat admin uchun." }, 403);
      const admin = authAdmin(supabaseUrl, serviceKey);
      const loginOf = (email: unknown) => String(email || "").split("@")[0];
      const listUsers = async () => {
        const users: any[] = [];
        for (let page = 1; page <= 50; page++) {
          const d = await restJson(`${admin.url}?page=${page}&per_page=200`, admin.headers);
          users.push(...(d?.users || []));
          if (!d?.users || d.users.length < 200) break;
        }
        return users;
      };
      const target = String(body.targetUserId || "");
      const needTarget = () => { if (!UUID_RE.test(target)) throw new Error("Foydalanuvchi aniqlanmadi."); };
      const linkedChats = async () => ((await restJson(`${dbUrl}?telegram_chat_id=not.is.null&select=telegram_chat_id,expires_at`, dbHeaders)) || [])
        .filter((a: any) => !(a.expires_at && Date.parse(a.expires_at) <= Date.now())).map((a: any) => String(a.telegram_chat_id));
      const cleanText = (value: unknown) => { const t = String(value || "").trim(); if (!t) throw new Error("Matn yozing."); if (t.length > 3500) throw new Error("Matn juda uzun."); return t; };
      try {
        if (body.action === "admin_overview") {
          const [users, accounts, admins, reminders] = await Promise.all([
            listUsers(),
            restJson(`${dbUrl}?select=user_id,expires_at,telegram_chat_id,updated_at,state`, dbHeaders),
            restJson(`${root}/${REFERRAL_ADMINS}?select=user_id`, dbHeaders),
            restJson(`${root}/${REMINDERS}?sent_at=gte.${new Date(Date.now() - 7 * 864e5).toISOString()}&select=id&limit=100000`, dbHeaders).catch(() => []),
          ]);
          const byId = new Map<string, any>((accounts || []).map((a: any) => [a.user_id, a]));
          const adminIds = new Set((admins || []).map((a: any) => a.user_id));
          const now = Date.now();
          const remainingOf = (d: any) => Number(d?.amt) - (Array.isArray(d?.pays) ? d.pays.reduce((s: number, p: any) => s + Number(p?.a || 0), 0) : 0);
          const rows = users.map((u: any) => {
            const a = byId.get(u.id) || {};
            const lastActive = [a.updated_at, u.last_sign_in_at].filter(Boolean).sort().pop() || null;
            return {
              id: u.id,
              login: loginOf(u.email),
              name: String(a.state?.name || u.user_metadata?.name || "").slice(0, 40),
              createdAt: u.created_at,
              lastActive,
              telegram: !!a.telegram_chat_id,
              blocked: !!(a.expires_at && Date.parse(a.expires_at) <= now),
              admin: adminIds.has(u.id),
              tx: Array.isArray(a.state?.tx) ? a.state.tx.length : 0,
              debts: Array.isArray(a.state?.debts) ? a.state.debts.filter((d: any) => remainingOf(d) > 0.009).length : 0,
            };
          }).sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
          const within = (x: string | null, days: number) => !!x && now - Date.parse(x) < days * 864e5;
          return response({
            ok: true,
            users: rows,
            stats: {
              users: rows.length,
              activeToday: rows.filter((r: any) => within(r.lastActive, 1)).length,
              active7: rows.filter((r: any) => within(r.lastActive, 7)).length,
              new7: rows.filter((r: any) => within(r.createdAt, 7)).length,
              telegram: rows.filter((r: any) => r.telegram && !r.blocked).length,
              blocked: rows.filter((r: any) => r.blocked).length,
              tx: rows.reduce((s: number, r: any) => s + r.tx, 0),
              openDebts: rows.reduce((s: number, r: any) => s + r.debts, 0),
              reminders7: (reminders || []).length,
            },
          });
        }
        if (body.action === "admin_set_password") {
          needTarget();
          const password = body.generate ? newPassword() : String(body.password || "");
          if (password.length < 6 || password.length > 72) return response({ ok: false, error: "Parol kamida 6 belgi bo‘lsin." }, 400);
          const r = await fetch(`${admin.url}/${target}`, { method: "PUT", headers: admin.headers, body: JSON.stringify({ password }) });
          if (!r.ok) return response({ ok: false, error: "Parolni o‘zgartirib bo‘lmadi." }, 500);
          const user = await restJson(`${admin.url}/${target}`, admin.headers).catch(() => null);
          const sent = botToken ? await sendTelegram(botToken, await chatIdOf(target), `🔑 <b>Parolingiz yangilandi</b>\n\nLogin: <code>${html(loginOf(user?.email))}</code>\nParol: <code>${password}</code>`) : false;
          return response({ ok: true, sent, password: sent ? undefined : password });
        }
        if (body.action === "admin_block") {
          needTarget();
          if (target === userId) return response({ ok: false, error: "O‘zingizni bloklay olmaysiz." }, 400);
          await restJson(`${dbUrl}?user_id=eq.${encodeURIComponent(target)}`, dbHeaders, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ expires_at: body.block ? new Date().toISOString() : null }) });
          return response({ ok: true });
        }
        if (body.action === "admin_message") {
          needTarget();
          if (!botToken) return response({ ok: false, error: "Bot sozlanmagan." }, 503);
          const ok = await sendTelegram(botToken, await chatIdOf(target), renderTpl(cleanText(body.text), {}));
          return ok ? response({ ok: true }) : response({ ok: false, error: "Xabar yetib bormadi (foydalanuvchi botni to‘xtatgan bo‘lishi mumkin)." }, 400);
        }
        if (body.action === "admin_broadcast") {
          if (!botToken) return response({ ok: false, error: "Bot sozlanmagan." }, 503);
          const text = renderTpl(cleanText(body.text), {});
          if (body.test) {
            const ok = await sendTelegram(botToken, await chatIdOf(userId), text);
            return ok ? response({ ok: true, count: 1 }) : response({ ok: false, error: "Sizga yuborib bo‘lmadi. Botga /start yozing." }, 400);
          }
          const chats: string[] = [...new Set<string>(await linkedChats())];
          const job = (async () => {
            // Telegram allows about 30 messages a second; stay well below it.
            for (let i = 0; i < chats.length; i += 20) {
              await Promise.all(chats.slice(i, i + 20).map((c) => sendTelegram(botToken, c, text)));
              await new Promise((r) => setTimeout(r, 1100));
            }
          })();
          // deno-lint-ignore no-explicit-any
          const runtime = (globalThis as any).EdgeRuntime;
          if (runtime?.waitUntil) runtime.waitUntil(job.catch(() => {})); else await job;
          return response({ ok: true, count: chats.length });
        }
        if (body.action === "admin_templates") {
          const rows = await loadTemplates(root, dbHeaders);
          return response({
            ok: true,
            templates: Object.entries(TEMPLATES).map(([key, t]) => ({
              key, group: t.group, title: t.title, icon: t.icon, hint: t.hint, required: !!t.required, vars: t.vars, sample: t.sample,
              default: t.text, text: rows[key]?.text?.trim() || t.text, custom: !!rows[key]?.text?.trim(), enabled: tplOn(rows, key),
            })),
          });
        }
        if (body.action === "admin_template_save") {
          const key = String(body.key || "");
          if (!TEMPLATES[key]) return response({ ok: false, error: "Shablon topilmadi." }, 404);
          const text = String(body.text || "").trim();
          if (text.length > 3500) return response({ ok: false, error: "Matn juda uzun." }, 400);
          if (key === "account_created" && text && !text.includes("{{parol}}")) return response({ ok: false, error: "Matnda {{parol}} bo‘lishi shart." }, 400);
          await restJson(`${root}/${TEMPLATE_TABLE}?on_conflict=key`, dbHeaders, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, enabled: TEMPLATES[key].required ? true : body.enabled !== false, text, updated_at: new Date().toISOString() }) });
          return response({ ok: true });
        }
        if (body.action === "admin_template_test") {
          const key = String(body.key || "");
          const t = TEMPLATES[key];
          if (!t) return response({ ok: false, error: "Shablon topilmadi." }, 404);
          if (!botToken) return response({ ok: false, error: "Bot sozlanmagan." }, 503);
          const text = String(body.text || "").trim() || t.text;
          const ok = await sendTelegram(botToken, await chatIdOf(userId), renderTpl(text.slice(0, 3500), t.sample));
          return ok ? response({ ok: true }) : response({ ok: false, error: "Sizga yuborib bo‘lmadi. Botga /start yozing." }, 400);
        }
      } catch (e) {
        return response({ ok: false, error: e instanceof Error && /^[^A-Za-z]|Matn|Foydalanuvchi/.test(e.message) ? e.message : "Admin amalini bajarib bo‘lmadi." }, 400);
      }
      return response({ ok: false, error: "Invalid request" }, 400);
    }
    if (body.action === "test_reminder") {
      if (!botToken) return response({ ok: false, error: "Telegram bot serverda sozlanmagan." }, 503);
      const chat = accountRows[0]?.telegram_chat_id;
      if (!chat) return response({ ok: false, error: "Telegram ulanmagan. Ilovani bot ichida oching." }, 400);
      const ok = await sendTelegram(botToken, chat, tpl(await loadTemplates(root, dbHeaders), "test_reminder", {}));
      if (!ok) return response({ ok: false, error: "Bot xabar yubora olmadi. Botga /start yuboring va qayta urinib ko'ring." }, 400);
      return response({ ok: true });
    }
    if (body.action === "link_telegram") {
      if (!botToken) return response({ ok: false, error: "Telegram bot serverda sozlanmagan." }, 503);
      const chatId = await telegramUser(String(body.initData || ""), botToken);
      const permissionCheck = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: "✅ Qarz eslatmalari ulandi. Endi muddatdan 3 va 1 kun oldin, to'lash kuni va muddat o'tib ketsa xabar olasiz." }) });
      if (!permissionCheck.ok) return response({ ok: false, error: "Bot sizga xabar yubora olmadi. Telegram ruxsatini yoqing va botga /start yuboring." }, 400);
      await fetch(`${dbUrl}?telegram_chat_id=eq.${encodeURIComponent(chatId)}&user_id=neq.${encodeURIComponent(userId)}`, { method: "PATCH", headers: { ...dbHeaders, Prefer: "return=minimal" }, body: JSON.stringify({ telegram_chat_id: null }) });
      const state = accountRows[0]?.state ?? DEFAULT_STATE;
      const r = await fetch(`${dbUrl}?on_conflict=user_id`, { method: "POST", headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: userId, state, telegram_chat_id: chatId, updated_at: new Date().toISOString() }) });
      if (!r.ok) return response({ ok: false, error: "Telegram akkauntini saqlab bo'lmadi." }, 500);
      await attachClickReferral(root, dbHeaders, userId, chatId, String(authUser.created_at || new Date().toISOString()), botToken).catch(() => {});
      return response({ ok: true, linked: true });
    }
    if (body.action === "save" && validState(body.state)) {
      // Transactions the bot added after the app loaded aren't in the app's copy yet; keep them.
      const loadedAt = Number(body.loadedAt) || 0;
      const incoming = new Set(body.state.tx.map((t: any) => t?.id));
      const unseen = (accountRows[0]?.state?.tx || []).filter((t: any) => t?.src === "bot" && Number(t.ts) > loadedAt && !incoming.has(t.id));
      if (unseen.length) body.state.tx = [...body.state.tx, ...unseen];
      const r = await fetch(`${dbUrl}?on_conflict=user_id`, {
        method: "POST",
        headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: userId, state: body.state, reminders_enabled: !!body.state.reminderPrefs?.enabled, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return response({ ok: false, error: "Could not save account" }, 500);
      return response({ ok: true });
    }
    return response({ ok: false, error: "Invalid request" }, 400);
  } catch {
    return response({ ok: false, error: "Request failed" }, 400);
  }
});
