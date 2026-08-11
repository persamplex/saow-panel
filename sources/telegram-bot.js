/**
 * SAOW Telegram Bot Worker
 * Deploy on a SEPARATE Cloudflare account/token from the mother node
 * to avoid mother IP/account blocks.
 *
 * Bindings (env):
 *   BOT_TOKEN          - Telegram bot token
 *   MOTHER_URL         - https://your-mother.workers.dev
 *   MOTHER_SECRET      - API_SECRET of mother (or panel session not needed — use API secret)
 *   ADMIN_CHAT_ID      - optional; if empty, first /start becomes admin (stored in KV)
 *   ADMIN_KV           - optional KV namespace for admin chat id
 */
const VERSION = "1.0.0-tg";

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function motherApi(env, path, opts = {}) {
  const base = String(env.MOTHER_URL || "").replace(/\/$/, "");
  const secret = env.MOTHER_SECRET || "";
  const res = await fetch(base + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return res.json().catch(() => ({}));
}

async function getAdminChatId(env) {
  if (env.ADMIN_CHAT_ID) return String(env.ADMIN_CHAT_ID);
  try {
    if (env.ADMIN_KV) {
      const v = await env.ADMIN_KV.get("admin_chat_id");
      if (v) return v;
    }
  } catch {}
  return null;
}

async function setAdminChatId(env, id) {
  try {
    if (env.ADMIN_KV) await env.ADMIN_KV.put("admin_chat_id", String(id));
  } catch {}
}

async function handleUpdate(env, update) {
  const token = env.BOT_TOKEN;
  if (!token) return;
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const text = String(msg.text || "").trim();

  let admin = await getAdminChatId(env);

  if (text.startsWith("/start")) {
    if (!admin) {
      await setAdminChatId(env, chatId);
      admin = chatId;
      // mirror to mother if possible
      try {
        await motherApi(env, "/api/telegram/config", {
          method: "POST",
          body: JSON.stringify({ chat_id: chatId }),
        });
      } catch {}
      await tg(token, "sendMessage", {
        chat_id: chatId,
        text: "✅ شما به‌عنوان ادمین SAOW ثبت شدید.\nChat ID: `" + chatId + "`",
        parse_mode: "Markdown",
      });
      return;
    }
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: chatId === admin
        ? "سلام ادمین 👋 ربات SAOW آنلاین است."
        : "ربات SAOW — فقط ادمین پاسخ داده می‌شود.",
    });
    return;
  }

  if (admin && chatId !== admin) return;

  if (text === "/status" || text === "/ping") {
    let mother = "—";
    try {
      const r = await motherApi(env, "/api/ping");
      mother = r && r.ok ? ("ok v" + (r.v || "")) : "fail";
    } catch { mother = "error"; }
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: `SAOW Bot v${VERSION}\nMother: ${mother}\nChat: ${chatId}`,
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/webhook")) {
      try {
        const update = await request.json();
        await handleUpdate(env, update);
      } catch (e) {
        console.log("tg update", e?.message);
      }
      return new Response("ok");
    }
    if (url.pathname === "/setup") {
      // setWebhook helper: GET /setup?secret=MOTHER_SECRET
      const secret = url.searchParams.get("secret") || "";
      if (!env.BOT_TOKEN) return new Response("no token", { status: 400 });
      if (secret !== (env.MOTHER_SECRET || "")) return new Response("forbidden", { status: 403 });
      const hook = url.origin + "/webhook";
      const r = await tg(env.BOT_TOKEN, "setWebhook", { url: hook, drop_pending_updates: true });
      return Response.json({ ok: !!r.ok, hook, result: r });
    }
    return new Response(`SAOW Telegram Bot ${VERSION}`);
  },
};
