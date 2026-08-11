/**
 * SAOW Telegram Bot Worker
 * Version: 1.0.1-tg
 *
 * Deploy on a SEPARATE Cloudflare account (not mother) to avoid blocks.
 * Mother pulls this file from GitHub and deploys it automatically.
 *
 * Bindings (plain_text):
 *   BOT_TOKEN       - Telegram bot token from BotFather
 *   MOTHER_URL      - https://your-mother.workers.dev
 *   MOTHER_SECRET   - mother API_SECRET
 *   ADMIN_CHAT_ID   - optional; if empty, first /start becomes admin
 *
 * Optional KV:
 *   ADMIN_KV        - stores admin_chat_id when auto-detected
 *
 * Routes:
 *   POST /webhook   - Telegram updates
 *   GET  /setup     - setWebhook (optional secret=MOTHER_SECRET)
 *   GET  /health    - health check
 */
const VERSION = "1.0.1-tg";

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({ ok: false }));
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
      text:
        chatId === String(admin)
          ? "سلام ادمین 👋\nربات SAOW آنلاین است.\n/status — وضعیت مادر"
          : "ربات SAOW — فقط ادمین پاسخ داده می‌شود.",
    });
    return;
  }

  if (admin && chatId !== String(admin)) return;

  if (text === "/status" || text === "/ping") {
    let mother = "—";
    try {
      const r = await motherApi(env, "/api/ping");
      mother = r && r.ok ? "ok v" + (r.v || r.version || "") : "fail";
    } catch {
      mother = "error";
    }
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: `SAOW Bot v${VERSION}\nMother: ${mother}\nChat: ${chatId}`,
    });
    return;
  }

  if (text === "/help") {
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: "دستورات:\n/start\n/status\n/help",
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
        console.log("tg update", e?.message || e);
      }
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      if (!env.BOT_TOKEN) return new Response("no BOT_TOKEN", { status: 400 });
      const secret = url.searchParams.get("secret") || "";
      if (env.MOTHER_SECRET && secret !== env.MOTHER_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const hook = url.origin + "/webhook";
      const r = await tg(env.BOT_TOKEN, "setWebhook", {
        url: hook,
        drop_pending_updates: true,
        allowed_updates: ["message"],
      });
      return Response.json({ ok: !!r.ok, hook, result: r, v: VERSION });
    }

    if (url.pathname === "/health" || url.pathname === "/ping") {
      return Response.json({ ok: true, v: VERSION });
    }

    return new Response(`SAOW Telegram Bot ${VERSION}`);
  },
};
