/**
 * SAOW Telegram Bot Worker
 * Version: 1.1.0-tg
 *
 * فروش کانفیگ برای کاربران + مدیریت برای ادمین
 * Bindings: BOT_TOKEN, MOTHER_URL, MOTHER_SECRET, ADMIN_CHAT_ID (optional)
 */
const VERSION = "1.1.0-tg";

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
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

async function getAdminChatId(env) {
  if (env.ADMIN_CHAT_ID) return String(env.ADMIN_CHAT_ID);
  try {
    if (env.ADMIN_KV) {
      const v = await env.ADMIN_KV.get("admin_chat_id");
      if (v) return String(v);
    }
  } catch {}
  // fallback: ask mother
  try {
    const st = await motherApi(env, "/api/shop/settings");
    const id = st?.settings?.tg_admin_chat_id;
    if (id) return String(id);
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

function isAdmin(env, chatId, adminId) {
  return adminId && String(chatId) === String(adminId);
}

/* ───────── Admin menus ───────── */
async function showAdminHome(token, chatId, env, msgId) {
  const text =
    `🛠 <b>پنل ادمین SAOW</b>\n` +
    `نسخه ربات: <code>${VERSION}</code>\n\n` +
    `از دکمه‌های زیر مدیریت کنید:`;
  const kb = [
    [{ text: "📦 فروشگاه / پلن‌ها", callback_data: "adm_shop" }],
    [{ text: "🧾 سفارش‌های در انتظار", callback_data: "adm_orders" }],
    [{ text: "📤 بکاپ الان", callback_data: "adm_backup_now" }],
    [{ text: "📊 وضعیت مادر", callback_data: "adm_status" }],
    [{ text: "🛒 منوی فروش (نمای کاربر)", callback_data: "user_shop" }],
  ];
  if (msgId) return edit(token, chatId, msgId, text, kb);
  return send(token, chatId, text, kb);
}

async function showUserHome(token, chatId, env, msgId) {
  const text =
    `👋 <b>به فروشگاه SAOW خوش آمدید</b>\n\n` +
    `پلن بخرید، سرویس‌های خود را ببینید و لینک ساب را دریافت کنید.`;
  const kb = [
    [{ text: "🛒 خرید کانفیگ", callback_data: "user_shop" }],
    [{ text: "📂 سرویس‌های من", callback_data: "user_services" }],
    [{ text: "ℹ️ راهنما", callback_data: "user_help" }],
  ];
  if (msgId) return edit(token, chatId, msgId, text, kb);
  return send(token, chatId, text, kb);
}

async function showShop(token, chatId, env, msgId, asAdmin) {
  const data = await motherApi(env, "/api/shop/plans?enabled=1");
  const plans = data.plans || [];
  if (!plans.length) {
    const t = "فعلاً پلنی برای فروش فعال نیست.";
    const kb = [[{ text: "🔙 بازگشت", callback_data: asAdmin ? "adm_home" : "user_home" }]];
    return msgId ? edit(token, chatId, msgId, t, kb) : send(token, chatId, t, kb);
  }
  // group by category
  const cats = {};
  for (const p of plans) {
    const c = (p.category || "عمومی").trim() || "عمومی";
    if (!cats[c]) cats[c] = [];
    cats[c].push(p);
  }
  let text = `🛒 <b>فروشگاه</b>\nیک پلن انتخاب کنید:\n`;
  const kb = [];
  for (const [cat, list] of Object.entries(cats)) {
    text += `\n📁 <b>${esc(cat)}</b>\n`;
    for (const p of list) {
      const days = p.days > 0 ? fa(p.days) + " روز" : "نامحدود";
      const q = p.quota_gb > 0 ? fa(p.quota_gb) + " گیگ" : "نامحدود";
      const price = Number(p.price || 0).toLocaleString("fa-IR");
      kb.push([{
        text: `✨ ${p.name} · ${days} · ${q} · ${price} ت`,
        callback_data: `buy:${p.id}`,
      }]);
    }
  }
  kb.push([{ text: "🔙 بازگشت", callback_data: asAdmin ? "adm_home" : "user_home" }]);
  return msgId ? edit(token, chatId, msgId, text, kb) : send(token, chatId, text, kb);
}

async function showBuyInfo(token, chatId, env, planId, msgId, tgUser, username) {
  const data = await motherApi(env, "/api/shop/plans");
  const plan = (data.plans || []).find((p) => String(p.id) === String(planId));
  if (!plan) {
    return edit(token, chatId, msgId, "پلن پیدا نشد.", [[{ text: "🔙", callback_data: "user_shop" }]]);
  }
  const st = await motherApi(env, "/api/shop/settings");
  const card = st?.settings?.shop_card || st?.settings?.card_number || "";
  const days = plan.days > 0 ? fa(plan.days) + " روز" : "نامحدود";
  const q = plan.quota_gb > 0 ? fa(plan.quota_gb) + " گیگ" : "نامحدود";
  const price = Number(plan.price || 0).toLocaleString("fa-IR");
  let text =
    `💳 <b>خرید پلن</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `پلن: <b>${esc(plan.name)}</b>\n` +
    `مدت: <b>${days}</b>\n` +
    `حجم: <b>${q}</b>\n` +
    `IP: <b>${fa(plan.ip_limit || 1)}</b>\n` +
    `قیمت: <b>${price} تومان</b>\n\n`;
  if (card) {
    text += `شماره کارت:\n<code>${esc(card)}</code>\n\n`;
    text += `پس از پرداخت، روی «ثبت سفارش» بزنید و رسید را برای پشتیبانی بفرستید.`;
  } else {
    text += `پس از ثبت سفارش، ادمین آن را بررسی می‌کند.`;
  }
  const kb = [
    [{ text: "✅ ثبت سفارش", callback_data: `order:${plan.id}` }],
    [{ text: "🔙 فروشگاه", callback_data: "user_shop" }],
  ];
  return edit(token, chatId, msgId, text, kb);
}

async function createOrder(token, chatId, env, planId, tgUser, username, msgId) {
  const r = await motherApi(env, "/api/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      plan_id: planId,
      user_id: String(tgUser),
      username: username || "",
    }),
  });
  if (!r.ok) {
    return edit(token, chatId, msgId, "ثبت سفارش ناموفق: " + (r.err || ""), [
      [{ text: "🔙", callback_data: "user_shop" }],
    ]);
  }
  // notify admin
  const admin = await getAdminChatId(env);
  if (admin && String(admin) !== String(chatId)) {
    await send(
      token,
      admin,
      `🧾 <b>سفارش جدید</b>\n` +
        `از: @${esc(username || "-")} (<code>${tgUser}</code>)\n` +
        `پلن: ${esc(r.plan_name || planId)}\n` +
        `شناسه: <code>${r.id}</code>`,
      [[{ text: "📋 سفارش‌ها", callback_data: "adm_orders" }]]
    );
  }
  return edit(
    token,
    chatId,
    msgId,
    `✅ سفارش ثبت شد.\nشناسه: <code>${r.id}</code>\nپس از تأیید ادمین، سرویس فعال می‌شود.`,
    [[{ text: "🏠 منو", callback_data: "user_home" }]]
  );
}

async function showOrders(token, chatId, env, msgId) {
  const data = await motherApi(env, "/api/shop/orders?status=pending");
  const orders = data.orders || [];
  if (!orders.length) {
    return edit(token, chatId, msgId, "سفارش در انتظاری نیست.", [
      [{ text: "🔙", callback_data: "adm_home" }],
    ]);
  }
  let text = `🧾 <b>سفارش‌های در انتظار</b> (${fa(orders.length)})\n\n`;
  const kb = [];
  for (const o of orders.slice(0, 15)) {
    text +=
      `• <code>${o.id}</code> · ${esc(o.plan_name || o.plan_id)}\n` +
      `  @${esc(o.username || "-")} · ${fa(o.price || 0)} ت\n`;
    kb.push([
      { text: `✅ ${String(o.id).slice(-6)}`, callback_data: `approve:${o.id}` },
      { text: `❌`, callback_data: `reject:${o.id}` },
    ]);
  }
  kb.push([{ text: "🔙", callback_data: "adm_home" }]);
  return edit(token, chatId, msgId, text, kb);
}

async function showUserServices(token, chatId, env, tgUser, msgId) {
  const data = await motherApi(env, "/api/shop/orders?user_id=" + encodeURIComponent(tgUser));
  const orders = (data.orders || []).filter((o) => o.status === "approved");
  if (!orders.length) {
    return edit(token, chatId, msgId, "سرویسی ندارید. از فروشگاه خرید کنید.", [
      [{ text: "🛒 فروشگاه", callback_data: "user_shop" }],
      [{ text: "🔙", callback_data: "user_home" }],
    ]);
  }
  let text = `📂 <b>سرویس‌های شما</b>\n\n`;
  const kb = [];
  for (const o of orders.slice(0, 20)) {
    text += `• ${esc(o.plan_name || "پلن")} · <code>${o.panel_user_id || "—"}</code>\n`;
    if (o.panel_user_id) {
      kb.push([{ text: `🔑 ${o.plan_name || o.panel_user_id}`, callback_data: `svc:${o.panel_user_id}` }]);
    }
  }
  kb.push([{ text: "🔙", callback_data: "user_home" }]);
  return edit(token, chatId, msgId, text, kb);
}

async function showService(token, chatId, env, userId, msgId) {
  const data = await motherApi(env, "/api/users/" + encodeURIComponent(userId));
  const u = data.user || data;
  if (!data.ok && !u?.uuid) {
    return edit(token, chatId, msgId, "سرویس پیدا نشد.", [[{ text: "🔙", callback_data: "user_services" }]]);
  }
  const base = String(env.MOTHER_URL || "").replace(/\/$/, "");
  const sub = `${base}/pull?token=${u.uuid}`;
  const text =
    `🔑 <b>${esc(u.name || userId)}</b>\n` +
    `وضعیت: <b>${esc(u.status || "—")}</b>\n` +
    `UUID:\n<code>${u.uuid}</code>\n\n` +
    `🔗 ساب:\n<code>${sub}</code>`;
  const kb = [
    [{ text: "📋 کپی ساب (متن)", callback_data: `svc:${userId}` }],
    [{ text: "🔙", callback_data: "user_services" }],
  ];
  return edit(token, chatId, msgId, text, kb);
}

async function handleCallback(env, cq) {
  const token = env.BOT_TOKEN;
  const chatId = String(cq.message?.chat?.id || "");
  const msgId = cq.message?.message_id;
  const data = String(cq.data || "");
  const fromId = String(cq.from?.id || "");
  const username = cq.from?.username || "";
  const admin = await getAdminChatId(env);
  const adm = isAdmin(env, chatId, admin) || isAdmin(env, fromId, admin);

  await answer(token, cq.id, "");

  if (data === "adm_home" || data === "admin") return showAdminHome(token, chatId, env, msgId);
  if (data === "user_home") return showUserHome(token, chatId, env, msgId);
  if (data === "user_shop" || data === "adm_shop") return showShop(token, chatId, env, msgId, data === "adm_shop");
  if (data === "user_services") return showUserServices(token, chatId, env, fromId, msgId);
  if (data === "user_help") {
    return edit(
      token,
      chatId,
      msgId,
      `ℹ️ خرید از فروشگاه → پرداخت (در صورت اعلام کارت) → ثبت سفارش → تأیید ادمین → دریافت لینک ساب.`,
      [[{ text: "🔙", callback_data: "user_home" }]]
    );
  }
  if (data === "adm_orders") return showOrders(token, chatId, env, msgId);
  if (data === "adm_status") {
    const st = await motherApi(env, "/api/status");
    const text =
      `📊 <b>وضعیت</b>\n` +
      `کاربران: ${fa(st.users || 0)}\n` +
      `آنلاین: ${fa(st.onlineUsers || 0)}\n` +
      `نودها: ${fa(st.nodes || 0)}\n` +
      `نسخه: <code>${st.version || "—"}</code>`;
    return edit(token, chatId, msgId, text, [[{ text: "🔙", callback_data: "adm_home" }]]);
  }
  if (data === "adm_backup_now") {
    await answer(token, cq.id, "در حال ارسال…", false);
    const r = await motherApi(env, "/api/backup/send-telegram", { method: "POST", body: "{}" });
    const t = r.ok ? "✅ بکاپ به تلگرام ارسال شد." : "❌ " + (r.err || "ناموفق");
    return edit(token, chatId, msgId, t, [[{ text: "🔙", callback_data: "adm_home" }]]);
  }
  if (data.startsWith("buy:")) {
    const planId = data.slice(4);
    return showBuyInfo(token, chatId, env, planId, msgId, fromId, username);
  }
  if (data.startsWith("order:")) {
    const planId = data.slice(6);
    return createOrder(token, chatId, env, planId, fromId, username, msgId);
  }
  if (data.startsWith("approve:")) {
    const id = data.slice(8);
    const r = await motherApi(env, "/api/shop/orders/" + encodeURIComponent(id) + "/approve", {
      method: "POST",
      body: "{}",
    });
    const t = r.ok
      ? `✅ سفارش تأیید شد.` + (r.user_id ? `\nکاربر پنل: <code>${r.user_id}</code>` : "") +
        (r.sub ? `\nساب:\n<code>${r.sub}</code>` : "")
      : "❌ " + (r.err || "خطا");
    // notify buyer
    try {
      if (r.ok && r.tg_user_id) {
        await send(
          token,
          r.tg_user_id,
          `✅ سفارش شما تأیید شد.\n` +
            (r.sub ? `🔗 ساب:\n<code>${r.sub}</code>` : "از منوی سرویس‌های من ببینید.")
        );
      }
    } catch {}
    return edit(token, chatId, msgId, t, [[{ text: "📋 سفارش‌ها", callback_data: "adm_orders" }]]);
  }
  if (data.startsWith("reject:")) {
    const id = data.slice(7);
    const r = await motherApi(env, "/api/shop/orders/" + encodeURIComponent(id) + "/reject", {
      method: "POST",
      body: "{}",
    });
    return edit(token, chatId, msgId, r.ok ? "❌ سفارش رد شد." : "خطا", [
      [{ text: "📋 سفارش‌ها", callback_data: "adm_orders" }],
    ]);
  }
  if (data.startsWith("svc:")) {
    return showService(token, chatId, env, data.slice(4), msgId);
  }
}

async function handleMessage(env, msg) {
  const token = env.BOT_TOKEN;
  if (!token || !msg?.chat) return;
  const chatId = String(msg.chat.id);
  const text = String(msg.text || "").trim();
  const fromId = String(msg.from?.id || chatId);
  let admin = await getAdminChatId(env);

  if (text.startsWith("/start")) {
    if (!admin) {
      await setAdminChatId(env, chatId);
      admin = chatId;
      await send(
        token,
        chatId,
        `✅ شما به‌عنوان <b>ادمین</b> ثبت شدید.\nاز منوی زیر استفاده کنید.`
      );
      return showAdminHome(token, chatId, env, null);
    }
    if (isAdmin(env, chatId, admin) || isAdmin(env, fromId, admin)) {
      return showAdminHome(token, chatId, env, null);
    }
    return showUserHome(token, chatId, env, null);
  }

  if (text.startsWith("/admin") || text.startsWith("/menu")) {
    if (isAdmin(env, chatId, admin) || isAdmin(env, fromId, admin)) {
      return showAdminHome(token, chatId, env, null);
    }
    return showUserHome(token, chatId, env, null);
  }

  if (text.startsWith("/shop") || text.startsWith("/buy")) {
    return showShop(token, chatId, env, null, false);
  }

  // default
  if (isAdmin(env, chatId, admin) || isAdmin(env, fromId, admin)) {
    return showAdminHome(token, chatId, env, null);
  }
  return showUserHome(token, chatId, env, null);
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

    // push message from mother
    if (path === "/notify" && request.method === "POST") {
      const secret = request.headers.get("authorization") || "";
      if (env.MOTHER_SECRET && !secret.includes(env.MOTHER_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const chat = body.chat_id || (await getAdminChatId(env));
      if (!chat) return new Response(JSON.stringify({ ok: false, err: "no chat" }), { status: 400 });
      if (body.document_url || body.document_base64) {
        // document send via sendDocument with URL or multipart skip - use sendMessage link
        await send(env.BOT_TOKEN, chat, body.text || "بکاپ آماده است.");
      } else {
        await send(env.BOT_TOKEN, chat, body.text || "—");
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
