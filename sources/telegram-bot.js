/**
 * SAOW Telegram Bot Worker
 * Version: 1.2.0-tg
 * فروش + اطلاع‌رسانی + پروکسی ساب تست
 * Bindings: BOT_TOKEN, MOTHER_URL, MOTHER_SECRET, ADMIN_CHAT_ID (optional)
 */
const VERSION = "1.2.3-tg";

async function tg(token, method, body, isForm) {
  const opts = { method: "POST" };
  if (isForm) {
    opts.body = body;
  } else {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, opts);
  return res.json().catch(() => ({ ok: false }));
}

async function send(token, chatId, text, keyboard) {
  const body = {
    chat_id: chatId,
    text: String(text || "").slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return tg(token, "sendMessage", body);
}

async function sendPhoto(token, chatId, fileId, caption, keyboard) {
  const body = {
    chat_id: chatId,
    photo: fileId,
    caption: String(caption || "").slice(0, 1000),
    parse_mode: "HTML",
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return tg(token, "sendPhoto", body);
}

async function edit(token, chatId, msgId, text, keyboard) {
  const body = {
    chat_id: chatId,
    message_id: msgId,
    text: String(text || "").slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  const r = await tg(token, "editMessageText", body);
  if (!r.ok && !(r.description || "").includes("not modified")) {
    return send(token, chatId, text, keyboard);
  }
  return r;
}

async function answer(token, id, text, alert) {
  return tg(token, "answerCallbackQuery", {
    callback_query_id: id,
    text: text || "",
    show_alert: !!alert,
  });
}

async function motherApi(env, path, opts = {}) {
  const base = String(env.MOTHER_URL || "").replace(/\/$/, "");
  if (!base) return {};
  const secret = env.MOTHER_SECRET || "";
  try {
    const res = await fetch(base + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    return await res.json().catch(() => ({}));
  } catch {
    return {};
  }
}

async function getSettings(env) {
  const st = await motherApi(env, "/api/shop/settings");
  return st.settings || {};
}

async function getMsg(settings, key, fallback) {
  const v = settings[key];
  return (v && String(v).trim()) || fallback;
}

async function getAdminChatId(env, settings) {
  if (env.ADMIN_CHAT_ID) return String(env.ADMIN_CHAT_ID);
  if (settings && settings.tg_admin_chat_id) return String(settings.tg_admin_chat_id);
  try {
    if (env.ADMIN_KV) {
      const v = await env.ADMIN_KV.get("admin_chat_id");
      if (v) return String(v);
    }
  } catch {}
  return null;
}

async function setAdminChatId(env, id) {
  try {
    if (env.ADMIN_KV) await env.ADMIN_KV.put("admin_chat_id", String(id));
  } catch {}
  try {
    await motherApi(env, "/api/telegram/config", {
      method: "POST",
      body: JSON.stringify({ chat_id: String(id) }),
    });
  } catch {}
}

function fa(n) {
  return String(n ?? "").replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
}
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function isAdmin(adminId, chatId) {
  return adminId && String(chatId) === String(adminId);
}

/** pending plan selection waiting for receipt photo: Map not available across isolates — use mother shop_settings ustate */
async function setUserState(env, userId, state) {
  await motherApi(env, "/api/shop/settings", {
    method: "POST",
    body: JSON.stringify({ [`ustate:${userId}`]: state ? JSON.stringify(state) : "" }),
  });
}
async function getUserState(env, userId) {
  const st = await getSettings(env);
  const raw = st[`ustate:${userId}`];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function checkChannel(env, token, userId, settings) {
  const ch = String(settings.shop_sponsor_channel || "").trim();
  if (!ch) return true;
  const channel = ch.startsWith("@") ? ch : (ch.startsWith("-") ? ch : "@" + ch.replace(/^https?:\/\/t\.me\//, ""));
  try {
    const r = await tg(token, "getChatMember", { chat_id: channel, user_id: Number(userId) });
    const status = r?.result?.status || "";
    return ["creator", "administrator", "member", "restricted"].includes(status);
  } catch {
    return true;
  }
}

function joinKeyboard(settings) {
  const ch = String(settings.shop_sponsor_channel || "").trim();
  const link = ch.startsWith("http") ? ch : `https://t.me/${ch.replace(/^@/, "")}`;
  return [
    [{ text: "✅ عضو شدم — ادامه", callback_data: "check_join" }],
    [{ text: "📢 عضویت در کانال", url: link }],
  ];
}

/* ───── Menus ───── */
async function showUserHome(token, chatId, env, settings, msgId) {
  const welcome = await getMsg(
    settings,
    "tg_msg_welcome",
    "👋 <b>به فروشگاه SAOW خوش آمدید</b>\n\nاز منوی زیر پلن بخرید یا سرویس‌های خود را ببینید."
  );
  const kb = [
    [{ text: "🛒 خرید کانفیگ", callback_data: "user_shop" }],
    [{ text: "🎁 اکانت تست", callback_data: "user_test" }],
    [{ text: "📂 سرویس‌های من", callback_data: "user_services" }],
    [{ text: "💬 پشتیبانی", callback_data: "user_support" }],
  ];
  if (msgId) return edit(token, chatId, msgId, welcome, kb);
  return send(token, chatId, welcome, kb);
}

async function showAdminHome(token, chatId, env, msgId) {
  const text =
    `🛠 <b>پنل ادمین</b>\n` +
    `نسخه ربات: <code>${VERSION}</code>\n\n` +
    `سفارش‌ها، فروشگاه و وضعیت را مدیریت کنید.`;
  const kb = [
    [{ text: "🧾 سفارش‌های در انتظار", callback_data: "adm_orders" }],
    [{ text: "📦 پلن‌ها", callback_data: "adm_shop" }],
    [{ text: "📊 وضعیت مادر", callback_data: "adm_status" }],
    [{ text: "📤 بکاپ الان", callback_data: "adm_backup_now" }],
    [{ text: "🛒 نمای کاربر", callback_data: "user_home" }],
  ];
  if (msgId) return edit(token, chatId, msgId, text, kb);
  return send(token, chatId, text, kb);
}

async function showShop(token, chatId, env, settings, msgId) {
  if (String(settings.shop_sales_enabled || "1") === "0") {
    const t = await getMsg(settings, "tg_msg_sales_off", "⏸ فروش فعلاً غیرفعال است. بعداً سر بزنید.");
    const kb = [[{ text: "🔙 منو", callback_data: "user_home" }]];
    return msgId ? edit(token, chatId, msgId, t, kb) : send(token, chatId, t, kb);
  }
  // هم enabled=1 و هم بدون فیلتر — بعضی پنل‌ها enabled را درست ست نمی‌کنند
  let data = await motherApi(env, "/api/shop/plans?enabled=1");
  let plans = (data.plans || []).filter((p) => p && p.enabled !== 0 && p.enabled !== false);
  if (!plans.length) {
    data = await motherApi(env, "/api/shop/plans");
    plans = (data.plans || []).filter((p) => p && p.enabled !== 0 && p.enabled !== false);
  }
  if (!plans.length) {
    const t = "فعلاً پلنی فعال نیست. از پنل وب در بخش فروشگاه پلن بسازید.";
    const kb = [[{ text: "🔙 منو", callback_data: "user_home" }]];
    return msgId ? edit(token, chatId, msgId, t, kb) : send(token, chatId, t, kb);
  }
  const cats = {};
  for (const p of plans) {
    const c = (p.category || "عمومی").trim() || "عمومی";
    if (!cats[c]) cats[c] = [];
    cats[c].push(p);
  }
  const catNames = Object.keys(cats);
  if (catNames.length === 1) {
    return showShopCategory(token, chatId, env, settings, msgId, catNames[0], cats[catNames[0]]);
  }
  let text = "🛒 <b>فروشگاه</b>\n\nیک <b>دسته‌بندی</b> انتخاب کنید:";
  // callback کوتاه با ایندکس — encodeURIComponent نام فارسی را می‌شکست (حد ۶۴ بایت تلگرام)
  const kb = catNames.map((c, idx) => [
    { text: `📁 ${c} (${fa(cats[c].length)})`, callback_data: `cat:${idx}` },
  ]);
  kb.push([{ text: "🔙 منو", callback_data: "user_home" }]);
  return msgId ? edit(token, chatId, msgId, text, kb) : send(token, chatId, text, kb);
}

async function loadPlansGrouped(env) {
  let data = await motherApi(env, "/api/shop/plans?enabled=1");
  let plans = (data.plans || []).filter((p) => p && p.enabled !== 0 && p.enabled !== false);
  if (!plans.length) {
    data = await motherApi(env, "/api/shop/plans");
    plans = (data.plans || []).filter((p) => p && p.enabled !== 0 && p.enabled !== false);
  }
  const cats = {};
  for (const p of plans) {
    const c = (p.category || "عمومی").trim() || "عمومی";
    if (!cats[c]) cats[c] = [];
    cats[c].push(p);
  }
  return { plans, cats, catNames: Object.keys(cats) };
}

async function showShopCategory(token, chatId, env, settings, msgId, catName, list) {
  if (!list) {
    const { cats } = await loadPlansGrouped(env);
    list = cats[catName] || [];
    // fallback: اگر نام جور نشد همه پلن‌ها
    if (!list.length) {
      const all = Object.values(cats).flat();
      list = all;
      catName = catName || "همه";
    }
  }
  if (!list.length) {
    const t = "در این دسته پلنی نیست.";
    const kb = [[{ text: "🔙 فروشگاه", callback_data: "user_shop" }]];
    return msgId ? edit(token, chatId, msgId, t, kb) : send(token, chatId, t, kb);
  }
  let text = `📁 <b>${esc(catName)}</b>\nیک پلن انتخاب کنید:`;
  const kb = [];
  for (const p of list) {
    const price = fa(String(Math.round(Number(p.price) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    const pid = String(p.id || "");
    kb.push([
      {
        text: `${p.name} · ${price} تومان · ${fa(p.days || 30)}روز`.slice(0, 64),
        callback_data: `buy:${pid}`.slice(0, 64),
      },
    ]);
  }
  kb.push([{ text: "🔙 دسته‌ها", callback_data: "user_shop" }]);
  return msgId ? edit(token, chatId, msgId, text, kb) : send(token, chatId, text, kb);
}

async function showBuyInfo(token, chatId, env, planId, settings, msgId, userId) {
  const data = await motherApi(env, "/api/shop/plans");
  const plan = (data.plans || []).find((p) => String(p.id) === String(planId));
  if (!plan) {
    return send(token, chatId, "پلن یافت نشد.", [[{ text: "🔙", callback_data: "user_shop" }]]);
  }
  const card = settings.shop_card_number || "—";
  const holder = settings.shop_card_holder || "—";
  const price = fa(String(Math.round(Number(plan.price) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")) + " تومان";
  let text =
    `💳 <b>پرداخت پلن ${esc(plan.name)}</b>\n\n` +
    `📅 ${fa(plan.days || 30)} روز · 📦 ${fa(plan.quota_gb || 0)} GB\n` +
    `📱 محدودیت IP: ${fa(plan.ip_limit || 1)}\n` +
    `💰 مبلغ: <b>${price}</b>\n\n` +
    `به کارت زیر واریز کنید:\n` +
    `🏦 <code>${esc(card)}</code>\n` +
    `👤 ${esc(holder)}\n\n` +
    `پس از واریز، روی «پرداخت کردم» بزنید و <b>اسکرین‌شات رسید</b> را ارسال کنید.`;
  const kb = [
    [{ text: "✅ پرداخت کردم — ارسال رسید", callback_data: `wait_receipt:${plan.id}` }],
    [{ text: "🔙 فروشگاه", callback_data: "user_shop" }],
  ];
  if (msgId) return edit(token, chatId, msgId, text, kb);
  return send(token, chatId, text, kb);
}

async function showSupport(token, chatId, settings, msgId) {
  const text = await getMsg(
    settings,
    "tg_msg_support",
    "💬 پشتیبانی\nدر صورت مشکل با ادمین در ارتباط باشید."
  );
  const kb = [[{ text: "🔙 منو", callback_data: "user_home" }]];
  return msgId ? edit(token, chatId, msgId, text, kb) : send(token, chatId, text, kb);
}

async function showServices(token, chatId, env, userId, botOrigin, msgId) {
  const data = await motherApi(env, "/api/shop/orders?user_id=" + encodeURIComponent(userId));
  const orders = (data.orders || []).filter((o) => o.status === "approved");
  if (!orders.length) {
    const t = "هنوز سرویس تأییدشده‌ای ندارید.";
    const kb = [
      [{ text: "🛒 خرید", callback_data: "user_shop" }],
      [{ text: "🔙 منو", callback_data: "user_home" }],
    ];
    return msgId ? edit(token, chatId, msgId, t, kb) : send(token, chatId, t, kb);
  }
  let text = `📂 <b>سرویس‌های شما</b>\n\n`;
  const kb = [];
  for (const o of orders.slice(0, 15)) {
    text += `• ${esc(o.plan_name || "پلن")} · <code>${o.panel_user_id || "—"}</code>\n`;
    if (o.panel_user_id) {
      const label = Number(o.is_test) ? "🔑 ساب تست (پروکسی)" : "🔑 لینک ساب";
      kb.push([{ text: `${label} · ${o.plan_name || o.panel_user_id}`, callback_data: `svc:${o.panel_user_id}:${o.is_test || 0}` }]);
    }
  }
  kb.push([{ text: "🔙 منو", callback_data: "user_home" }]);
  return msgId ? edit(token, chatId, msgId, text, kb) : send(token, chatId, text, kb);
}

async function sendServiceLink(token, chatId, env, panelUserId, isTest, botOrigin) {
  // get user uuid
  const u = await motherApi(env, "/api/users/" + encodeURIComponent(panelUserId));
  const uuid = u?.user?.uuid || u?.uuid;
  if (!uuid) {
    return send(token, chatId, "کاربر یافت نشد.", [[{ text: "🔙", callback_data: "user_services" }]]);
  }
  const mother = String(env.MOTHER_URL || "").replace(/\/$/, "");
  let link;
  if (Number(isTest) && botOrigin) {
    link = `${botOrigin}/sub-proxy?token=${encodeURIComponent(uuid)}`;
  } else {
    link = `${mother}/pull?token=${encodeURIComponent(uuid)}`;
  }
  return send(
    token,
    chatId,
    `🔗 <b>لینک اشتراک</b>\n\n<code>${esc(link)}</code>\n\n${Number(isTest) ? "⚠️ این لینک تست از طریق ربات پروکسی می‌شود." : ""}`,
    [[{ text: "🔙 سرویس‌ها", callback_data: "user_services" }]]
  );
}

async function createTestAccount(token, chatId, env, userId, username, botOrigin) {
  const settings = await getSettings(env);
  const key = "tg_test_user_" + String(userId);
  let existingId = settings[key] || "";
  let uuid = "";
  let panelId = existingId;

  // اگر قبلاً برای این Chat ID ساخته شده، همان را برگردان
  if (existingId) {
    const u = await motherApi(env, "/api/users/" + encodeURIComponent(existingId));
    const user = u?.user || u;
    if (user && (user.uuid || user.id)) {
      uuid = user.uuid || "";
      panelId = user.id || existingId;
      // اگر منقضی شده، تمدید کوتاه
      const exp = user.expiry ? Date.parse(user.expiry) : 0;
      if (!exp || exp < Date.now()) {
        await motherApi(env, "/api/users/" + encodeURIComponent(panelId), {
          method: "PATCH",
          body: JSON.stringify({
            expiry: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
            enabled: true,
            quotaBytes: 512 * 1024 * 1024,
          }),
        }).catch(() => {});
      }
      const link = botOrigin
        ? `${botOrigin}/sub-proxy?token=${encodeURIComponent(uuid)}`
        : `${String(env.MOTHER_URL || "").replace(/\/$/, "")}/pull?token=${encodeURIComponent(uuid)}`;
      return send(
        token,
        chatId,
        `🎁 <b>اکانت تست شما</b>\n\nقبلاً برای شما ساخته شده (هر چت فقط یک تست).\n\n🔗 لینک ساب:\n<code>${esc(link)}</code>`,
        [[{ text: "🔙 منو", callback_data: "user_home" }]]
      );
    }
  }

  const r = await motherApi(env, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: `test-${userId}`,
      quotaBytes: 512 * 1024 * 1024,
      dailyQuotaBytes: 0,
      ipLimit: 1,
      expiry: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
      enabled: true,
      notes: "telegram-test:" + userId,
    }),
  });
  if (!r.ok && !r.user && !r.id) {
    return send(token, chatId, "ساخت اکانت تست ممکن نشد: " + (r.err || "خطا"), [
      [{ text: "🔙", callback_data: "user_home" }],
    ]);
  }
  panelId = r.user?.id || r.id || r.user_id;
  uuid = r.user?.uuid || r.uuid;
  await motherApi(env, "/api/shop/settings", {
    method: "POST",
    body: JSON.stringify({ [key]: String(panelId || "") }),
  }).catch(() => {});

  const link = botOrigin
    ? `${botOrigin}/sub-proxy?token=${encodeURIComponent(uuid || "")}`
    : `${String(env.MOTHER_URL || "").replace(/\/$/, "")}/pull?token=${encodeURIComponent(uuid || "")}`;
  return send(
    token,
    chatId,
    `🎁 <b>اکانت تست آماده است</b>\n\n⏱ اعتبار حدود ۳ ساعت · حجم ۵۱۲MB\nهر چت فقط <b>یک</b> اکانت تست.\n\n🔗 لینک ساب (پروکسی‌شده):\n<code>${esc(link)}</code>`,
    [[{ text: "🔙 منو", callback_data: "user_home" }]]
  );
}

async function showPendingOrders(token, chatId, env, msgId) {
  const data = await motherApi(env, "/api/shop/orders?status=pending");
  const orders = data.orders || [];
  if (!orders.length) {
    const t = "سفارش در انتظاری نیست.";
    const kb = [[{ text: "🔙", callback_data: "adm_home" }]];
    return msgId ? edit(token, chatId, msgId, t, kb) : send(token, chatId, t, kb);
  }
  let text = `🧾 <b>سفارش‌های در انتظار</b> (${fa(orders.length)})\n\n`;
  const kb = [];
  for (const o of orders.slice(0, 12)) {
    text +=
      `• <code>${o.id}</code>\n` +
      `  ${esc(o.plan_name)} · ${fa(o.price)} ت · @${esc(o.username || o.user_id)}\n`;
    kb.push([
      { text: `✅ ${String(o.id).slice(-6)}`, callback_data: `approve:${o.id}` },
      { text: `❌`, callback_data: `reject:${o.id}` },
    ]);
  }
  kb.push([{ text: "🔙", callback_data: "adm_home" }]);
  return msgId ? edit(token, chatId, msgId, text, kb) : send(token, chatId, text, kb);
}

async function handleCallback(env, cq) {
  const token = env.BOT_TOKEN;
  const data = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;
  const fromId = cq.from?.id;
  const username = cq.from?.username || "";
  const settings = await getSettings(env);
  const adminId = await getAdminChatId(env, settings);

  await answer(token, cq.id);

  // channel gate
  if (data !== "check_join" && !isAdmin(adminId, fromId)) {
    const ok = await checkChannel(env, token, fromId, settings);
    if (!ok) {
      const t = await getMsg(
        settings,
        "tg_msg_join",
        "برای استفاده از ربات ابتدا در کانال اسپانسر عضو شوید."
      );
      return send(token, chatId, t, joinKeyboard(settings));
    }
  }

  if (data === "check_join") {
    const ok = await checkChannel(env, token, fromId, settings);
    if (!ok) {
      return answer(token, cq.id, "هنوز عضو نیستید", true);
    }
    return showUserHome(token, chatId, env, settings, msgId);
  }

  if (data === "user_home") return showUserHome(token, chatId, env, settings, msgId);
  if (data === "adm_home") return showAdminHome(token, chatId, env, msgId);
  if (data === "user_shop" || data === "adm_shop") return showShop(token, chatId, env, settings, msgId);
  if (data === "user_support") return showSupport(token, chatId, settings, msgId);
  if (data === "user_services") {
    const origin = `https://${cq.message?.entities ? "" : ""}`; // filled below
    return showServices(token, chatId, env, fromId, null, msgId);
  }
  if (data === "user_test") {
    // need bot origin - from webhook URL not available; use worker name pattern via MOTHER or settings
    const botUrl = settings.tg_bot_worker_url || "";
    return createTestAccount(token, chatId, env, fromId, username, botUrl.replace(/\/$/, ""));
  }
  if (data === "adm_orders") return showPendingOrders(token, chatId, env, msgId);
  if (data === "adm_status") {
    const st = await motherApi(env, "/api/status");
    const t =
      `📊 <b>وضعیت</b>\n` +
      `کاربران: ${fa(st.users || 0)}\n` +
      `نودها: ${fa(st.nodes || 0)}\n` +
      `آنلاین: ${fa(st.onlineUsers || 0)}`;
    return edit(token, chatId, msgId, t, [[{ text: "🔙", callback_data: "adm_home" }]]);
  }
  if (data === "adm_backup_now") {
    await motherApi(env, "/api/backup");
    return edit(token, chatId, msgId, "درخواست بکاپ ثبت شد (از پنل وب هم می‌توانید ارسال کنید).", [
      [{ text: "🔙", callback_data: "adm_home" }],
    ]);
  }

  if (data.startsWith("cat:")) {
    const idx = Number(data.slice(4));
    const { cats, catNames } = await loadPlansGrouped(env);
    const catName = catNames[idx] || catNames[0] || "عمومی";
    return showShopCategory(token, chatId, env, settings, msgId, catName, cats[catName] || null);
  }
  if (data.startsWith("buy:")) {
    return showBuyInfo(token, chatId, env, data.slice(4), settings, msgId, fromId);
  }

  if (data.startsWith("wait_receipt:")) {
    const planId = data.slice("wait_receipt:".length);
    await setUserState(env, fromId, { action: "await_receipt", planId });
    return edit(
      token,
      chatId,
      msgId,
      "📸 لطفاً <b>اسکرین‌شات رسید پرداخت</b> را همین‌جا ارسال کنید.\n\nبرای انصراف /start بزنید.",
      [[{ text: "❌ انصراف", callback_data: "user_shop" }]]
    );
  }

  if (data.startsWith("approve:") || data.startsWith("reject:")) {
    if (!isAdmin(adminId, fromId)) {
      return answer(token, cq.id, "فقط ادمین", true);
    }
    const ok = data.startsWith("approve:");
    const oid = data.split(":")[1];
    const path = `/api/shop/orders/${encodeURIComponent(oid)}/${ok ? "approve" : "reject"}`;
    const r = await motherApi(env, path, { method: "POST", body: "{}" });
    const buyer = r.tg_user_id || r.user_id;
    if (ok && r.ok) {
      const mother = String(env.MOTHER_URL || "").replace(/\/$/, "");
      let sub = "";
      if (r.user_id || r.panel_user_id) {
        const uid = r.user_id || r.panel_user_id;
        const u = await motherApi(env, "/api/users/" + encodeURIComponent(uid));
        const uuid = u?.user?.uuid || u?.uuid;
        if (uuid) sub = `${mother}/pull?token=${encodeURIComponent(uuid)}`;
      }
      if (buyer) {
        await send(
          token,
          buyer,
          `✅ سفارش شما تأیید شد.\n` + (sub ? `\n🔗 لینک ساب:\n<code>${esc(sub)}</code>` : "")
        );
      }
      return edit(token, chatId, msgId, `✅ سفارش <code>${esc(oid)}</code> تأیید شد.`, [
        [{ text: "📋 سفارش‌ها", callback_data: "adm_orders" }],
      ]);
    }
    if (!ok) {
      if (buyer) await send(token, buyer, "❌ سفارش شما رد شد. در صورت نیاز با پشتیبانی صحبت کنید.");
      return edit(token, chatId, msgId, `❌ سفارش <code>${esc(oid)}</code> رد شد.`, [
        [{ text: "📋 سفارش‌ها", callback_data: "adm_orders" }],
      ]);
    }
    return edit(token, chatId, msgId, "خطا: " + (r.err || "نامشخص"), [
      [{ text: "🔙", callback_data: "adm_orders" }],
    ]);
  }

  if (data.startsWith("svc:")) {
    const parts = data.split(":");
    const panelUserId = parts[1];
    const isTest = parts[2] || "0";
    const botUrl = (settings.tg_bot_worker_url || "").replace(/\/$/, "");
    return sendServiceLink(token, chatId, env, panelUserId, isTest, botUrl);
  }
}

async function handleMessage(env, msg) {
  const token = env.BOT_TOKEN;
  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  const username = msg.from?.username || "";
  const text = (msg.text || "").trim();
  const settings = await getSettings(env);
  let adminId = await getAdminChatId(env, settings);

  // first /start becomes admin if none
  if (text.startsWith("/start") && !adminId) {
    await setAdminChatId(env, fromId);
    adminId = String(fromId);
    await send(token, chatId, "شما به‌عنوان ادمین ثبت شدید.");
  }

  if (!isAdmin(adminId, fromId)) {
    const ok = await checkChannel(env, token, fromId, settings);
    if (!ok) {
      const t = await getMsg(
        settings,
        "tg_msg_join",
        "برای استفاده از ربات ابتدا در کانال اسپانسر عضو شوید."
      );
      return send(token, chatId, t, joinKeyboard(settings));
    }
  }

  // photo = receipt?
  if (msg.photo && msg.photo.length) {
    const state = await getUserState(env, fromId);
    if (state && state.action === "await_receipt" && state.planId) {
      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;
      const order = await motherApi(env, "/api/shop/orders", {
        method: "POST",
        body: JSON.stringify({
          plan_id: state.planId,
          user_id: fromId,
          username,
          receipt_file_id: fileId,
        }),
      });
      await setUserState(env, fromId, null);
      if (!order.ok) {
        return send(token, chatId, "ثبت سفارش ناموفق: " + (order.err || ""), [
          [{ text: "🛒 فروشگاه", callback_data: "user_shop" }],
        ]);
      }
      await send(
        token,
        chatId,
        `✅ رسید دریافت شد.\nشماره سفارش: <code>${esc(order.id)}</code>\nپس از تأیید ادمین لینک ساب برایتان ارسال می‌شود.`,
        [[{ text: "📂 سرویس‌های من", callback_data: "user_services" }]]
      );
      // notify admin with photo
      if (adminId) {
        await sendPhoto(
          token,
          adminId,
          fileId,
          `🧾 <b>رسید جدید</b>\n` +
            `سفارش: <code>${esc(order.id)}</code>\n` +
            `پلن: ${esc(order.plan_name || state.planId)}\n` +
            `مبلغ: ${fa(order.price || 0)} تومان\n` +
            `کاربر: @${esc(username || fromId)}`,
          [
            [
              { text: "✅ تأیید", callback_data: `approve:${order.id}` },
              { text: "❌ رد", callback_data: `reject:${order.id}` },
            ],
          ]
        );
      }
      return;
    }
  }

  if (text.startsWith("/start") || text === "منو") {
    if (isAdmin(adminId, fromId)) return showAdminHome(token, chatId, env);
    return showUserHome(token, chatId, env, settings);
  }

  // default
  if (isAdmin(adminId, fromId)) return showAdminHome(token, chatId, env);
  return showUserHome(token, chatId, env, settings);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health" || path === "/") {
      return new Response(JSON.stringify({ ok: true, v: VERSION }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Proxy test-account subscription — hides mother URL
    if (path === "/sub-proxy") {
      const token = url.searchParams.get("token") || "";
      if (!token) return new Response("token required", { status: 400 });
      const mother = String(env.MOTHER_URL || "").replace(/\/$/, "");
      const target = `${mother}/pull?token=${encodeURIComponent(token)}${url.search.replace(/[?&]token=[^&]*/g, "").replace(/^&/, "?")}`;
      try {
        const res = await fetch(target, {
          headers: {
            "User-Agent": request.headers.get("User-Agent") || "SAOW-TG-Proxy",
            Accept: request.headers.get("Accept") || "*/*",
          },
        });
        const body = await res.arrayBuffer();
        return new Response(body, {
          status: res.status,
          headers: {
            "content-type": res.headers.get("content-type") || "text/plain;charset=utf-8",
            "access-control-allow-origin": "*",
          },
        });
      } catch (e) {
        return new Response("proxy error", { status: 502 });
      }
    }

    if (path === "/setup" && request.method === "GET") {
      const secret = url.searchParams.get("secret") || "";
      if (env.MOTHER_SECRET && secret !== env.MOTHER_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const hook = url.origin + "/webhook";
      const r = await tg(env.BOT_TOKEN, "setWebhook", {
        url: hook,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
      return new Response(JSON.stringify(r), {
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/webhook" && request.method === "POST") {
      let update = {};
      try {
        update = await request.json();
      } catch {
        return new Response("bad", { status: 400 });
      }
      try {
        if (update.callback_query) await handleCallback(env, update.callback_query);
        else if (update.message || update.edited_message)
          await handleMessage(env, update.message || update.edited_message);
      } catch (e) {
        console.error("tg handle", e?.message || e);
      }
      return new Response("OK");
    }

    if (path === "/notify" && request.method === "POST") {
      const secret = request.headers.get("authorization") || "";
      if (env.MOTHER_SECRET && !secret.includes(env.MOTHER_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const settings = await getSettings(env);
      const chat = body.chat_id || (await getAdminChatId(env, settings));
      if (!chat) return new Response(JSON.stringify({ ok: false, err: "no chat" }), { status: 400 });
      await send(env.BOT_TOKEN, chat, body.text || "—");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
