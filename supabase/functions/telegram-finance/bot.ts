// Telegram chat side of the bot: users write "50 000 taksi" or forward a bank/CardXabar
// notification, and the transaction is added to their account without opening the app.

export type ParsedTx = { type: "in" | "out"; amt: number; usd: number; cat: string; note: string; method: string; date: string; bank: boolean };

const IN_CATS: [RegExp, string][] = [
  [/oylik|maosh|ish ?haqi|avans|zarplat|зарплат|аванс/i, "Ish haqi"],
  [/sotdim|sotuv|savdo|продаж/i, "Savdo"],
  [/mijoz|klient|клиент/i, "Mijozdan tushum"],
  [/xizmat|услуг/i, "Xizmat"],
  [/qarz.*qaytar|qaytardi|qaytdi/i, "Qarz qaytishi"],
];

const OUT_CATS: [RegExp, string][] = [
  [/taks|taxi|yandex ?go|mytaxi|такси/i, "🚕 Taksi"],
  [/benzin|metan|propan|zapravka|moyka|avto|mashina|azs|азс|бензин/i, "🚗 Mashina"],
  [/ovqat|tushlik|nonushta|kechki|non\b|kafe|cafe|restoran|evos|oqtepa|max ?way|kofe|coffee|choy|lavash|somsa|osh\b|кафе|ресторан/i, "🍔 Ovqat"],
  [/korzinka|makro|havas|bozor|magazin|supermarket|market|do'kon|dokon|tovar|xarid|магазин|супермаркет/i, "🛒 Tovar"],
  [/telefon|internet|ucell|beeline|uzmobile|mobiuz|humans|uztelecom|связь/i, "📱 Telefon/internet"],
  [/svet|elektr|gaz\b|suv\b|kommunal|hududgaz|коммунал/i, "🧾 Kommunal"],
  [/ijara|kvartira|\buy\b|аренд/i, "🏠 Uy"],
  [/kredit|nasiya|кредит/i, "💳 Kredit"],
  [/paket/i, "📦 Paket"],
  [/oila|bola|sovg'?a|ona|ota/i, "👨‍👩‍👦 Oila"],
  [/biznes/i, "💼 Biznes"],
];

const IN_WORDS = /(^|\s)(kirim|tushdi|tushum|keldi|kirdi|qabul|popolnen|zachislen|postuplen|пополнен|зачислен|поступлен|kredit ?tushdi|o'tkazma keldi|perevod na kartu)/i;
const OUT_WORDS = /(oplata|pokupka|spisan|оплата|покупка|списан|снятие|snyatie|to'lov|tolov|xarid|chiqim|perevod s karty|o'tkazma yubor|списание)/i;
const BANK_HINT = /(uzs|сум|\*\d{4}|\d{4}\*{2,}\d{4}|humo|uzcard|cardxabar|karta|карта|balans|баланс|ostatok|остаток)/i;
const BALANCE_WORDS = /(balans|баланс|ostatok|остаток|qoldiq|dostupno|доступно|mavjud)\s*:?\s*$/i;

export function parseAmount(raw: string): number {
  let s = raw.replace(/[\s\u00a0\u202f']/g, "");
  if (!s) return NaN;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot > -1 && lastComma > -1) {
    const dec = lastDot > lastComma ? "." : ",";
    s = s.split(dec === "." ? "," : ".").join("").replace(",", ".");
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
    s = s.replace(/[.,]/g, "");
  } else {
    s = s.replace(",", ".");
  }
  return Number(s);
}

function pick<T>(text: string, list: [RegExp, T][], fallback: T) {
  for (const [re, value] of list) if (re.test(text)) return value;
  return fallback;
}

function tashkentDay(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date(Date.now() + offsetDays * 86400000));
}

export function parseMessage(input: string, rate: number): ParsedTx | null {
  const text = String(input || "").trim();
  if (!text || text.length > 2000) return null;
  const bank = /uzs|сум|so'm|сўм/i.test(text) && BANK_HINT.test(text) && text.length > 25;
  let amt = NaN, usd = 0, rest = text;

  if (bank) {
    // Bank notifications: the first "<number> UZS" that is not the remaining balance.
    const re = /(\d[\d\s.,\u00a0]*\d|\d)\s*(uzs|сум|sum\b|so'm|сўм)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (BALANCE_WORDS.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
      amt = parseAmount(m[1]);
      if (amt > 0) break;
    }
  } else {
    const m = text.match(/([+-]?)\s*(\$\s*)?(\d[\d\s.,]*\d|\d)\s*(k\b|ming\b|тыс|mln\b|million\b|mlrd\b|млн|\$|usd\b|dollar\b|долл)?/i);
    if (m) {
      amt = parseAmount(m[3]);
      const unit = (m[4] || "").toLowerCase();
      if (unit === "k" || unit === "ming" || unit === "тыс") amt *= 1000;
      else if (unit === "mln" || unit === "million" || unit === "млн") amt *= 1_000_000;
      else if (unit === "mlrd") amt *= 1_000_000_000;
      if (m[2] || unit === "$" || unit === "usd" || unit === "dollar" || unit === "долл") { usd = amt; amt = Math.round(amt * (rate || 12500)); }
      if (m[1] === "+") rest = "+ " + text.replace(m[0], " ");
      else if (m[1] === "-") rest = "- " + text.replace(m[0], " ");
      else rest = text.replace(m[0], " ");
    }
  }
  if (!(amt > 0) || amt > 1e13) return null;

  const signIn = /^\s*\+/.test(rest), signOut = /^\s*-/.test(rest);
  const type: "in" | "out" = signIn ? "in" : signOut ? "out" : bank ? (IN_WORDS.test(text) && !OUT_WORDS.test(text) ? "in" : "out") : IN_WORDS.test(text) || pick(text, IN_CATS, "") ? "in" : "out";
  const cat = type === "in" ? pick(text, IN_CATS, "Boshqa") : pick(text, OUT_CATS, "🔧 Boshqa");
  let note = bank ? (text.split(/\n/).map((l) => l.replace(/[^\p{L}\p{N}\s'".,&-]/gu, "").trim()).find((l) => /\p{L}{3}/u.test(l) && !/uzs|сум|so'm|balans|баланс|остат|ostatok|\*\d{4}|\d{2}[.:]\d{2}|uzcard|humo|karta|карт|kirim|chiqim|пополн|oplata|оплата|pokupka|покупка/i.test(l)) || "Bank xabari") : rest.replace(/^[\s+-]+/, "").replace(/\b(kecha|bugun|kirim|chiqim|xarajat|karta|kartadan|naqd)\b/gi, " ").replace(/\s+/g, " ").trim();
  note = note.slice(0, 80);
  const date = /\bkecha\b|вчера/i.test(text) && !bank ? tashkentDay(-1) : tashkentDay();
  const method = bank || /karta|kartadan|карта|click|payme/i.test(text) ? "Karta" : usd ? "Dollar" : "Naqd";
  return { type, amt: Math.round(amt * 100) / 100, usd, cat, note, method, date, bank };
}

export async function hashText(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim()));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function monthSummary(state: any) {
  const month = tashkentDay().slice(0, 7);
  const tx = Array.isArray(state?.tx) ? state.tx : [];
  const sum = (list: any[]) => list.reduce((s, x) => s + (Number(x.amt) || 0), 0);
  const inM = tx.filter((x: any) => String(x.date || "").startsWith(month));
  const income = sum(inM.filter((x: any) => x.type === "in")), expense = sum(inM.filter((x: any) => x.type === "out"));
  const debts = Array.isArray(state?.debts) ? state.debts : [];
  const remaining = (d: any) => Math.max(0, Number(d.amt) - (Array.isArray(d.pays) ? d.pays.reduce((s: number, p: any) => s + Number(p?.a || 0), 0) : 0));
  const given = debts.filter((d: any) => d.kind === "g"), taken = debts.filter((d: any) => d.kind === "t");
  const balance = (Number(state?.init) || 0) + sum(tx.filter((x: any) => x.type === "in")) - sum(tx.filter((x: any) => x.type === "out"))
    - given.reduce((s: number, d: any) => s + remaining(d), 0) + taken.reduce((s: number, d: any) => s + remaining(d), 0);
  const top: Record<string, number> = {};
  for (const x of inM) if (x.type === "out") top[x.cat || "Boshqa"] = (top[x.cat || "Boshqa"] || 0) + (Number(x.amt) || 0);
  return { month, income, expense, balance, top: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 3) };
}
