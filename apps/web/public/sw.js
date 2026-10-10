/**
 * Ruchoir service worker: system notifications while no Ruchoir page is open.
 *
 * Plain JavaScript served as is from `public/`, not bundled: a service worker is a separate script
 * the browser keeps and runs on its own, and it has to live at the root to cover the whole app.
 *
 * What it does, and nothing else:
 *
 * - **On a push, it asks the API what to show.** A push carries only a constant marker (see ADR 0001
 *   and `apps/api/src/notify/push.rs`), ignored here: the vendor's push service only ever relays
 *   "something happened".
 *   The worker then calls `GET /api/v1/push/pending` with the session cookie, like the app does, and
 *   draws what comes back, in the account's language, already filtered by its preferences.
 * - **On a click, it brings the app forward** on the conversation the notification is about: an open
 *   window is focused and told where to go, otherwise a new one is opened on that address.
 * - **When the browser rotates a subscription**, it registers the new one with the API.
 *
 * It caches no page and intercepts no request. An offline copy of the app is a separate decision,
 * and a worker that serves stale bundles is how a fix deployed on the server stays invisible.
 */

const STATE_CACHE = "ruchoir-sw-state-v1";
const LAST_SHOWN = "/__ruchoir/last-shown";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take the open pages at once, so the first click on a notification can reach them.
  event.waitUntil(self.clients.claim());
});

/** The newest notification this browser has drawn, so a second wake-up does not draw it again. */
async function lastShown() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const hit = await cache.match(LAST_SHOWN);
    return hit ? await hit.text() : null;
  } catch {
    return null;
  }
}

async function rememberShown(createdAt) {
  try {
    const cache = await caches.open(STATE_CACHE);
    await cache.put(LAST_SHOWN, new Response(createdAt));
  } catch {
    // Without the cache, the worst case is one notification drawn twice.
  }
}

/** Whether a Ruchoir window is the one the person is looking at: it has already told them. */
async function someoneIsWatching() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((client) => client.focused && client.visibilityState === "visible");
}

/**
 * Some browsers withdraw the permission of a site that receives pushes without drawing anything
 * (Safari after three). When there is nothing to say (read on another device in the meantime, the
 * session expired), a neutral notification is drawn and closed at once.
 */
async function acknowledgeQuietly() {
  await self.registration.showNotification("Ruchoir", { tag: "ruchoir-quiet", silent: true });
  const drawn = await self.registration.getNotifications({ tag: "ruchoir-quiet" });
  for (const notification of drawn) notification.close();
}

async function onPush() {
  let pending = null;
  try {
    const since = await lastShown();
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const response = await fetch(`/api/v1/push/pending${query}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.ok) pending = await response.json();
  } catch {
    // Offline for a moment, or the API restarting: fall through to the quiet acknowledgement.
  }

  const all = (pending && pending.items) || [];
  // A test from the preferences is drawn even over the open app: being seen is its whole point,
  // and it is the app itself that asked for it.
  const test = all.find((item) => item.kind === "test");
  const items = all.filter((item) => item.kind !== "test");
  if (test) {
    await self.registration.showNotification(test.title, {
      body: test.body,
      tag: "ruchoir-test",
      renotify: true,
      silent: Boolean(pending.silent),
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
    });
  }

  if (await someoneIsWatching()) {
    // The open window has shown them already; they are not to come back with the next push.
    if (items.length > 0) await rememberShown(items[0].created_at);
    return;
  }

  if (items.length === 0) {
    if (!test) await acknowledgeQuietly();
    return;
  }
  // Oldest first, so the newest ends up on top of the tray.
  for (const item of [...items].reverse()) {
    await self.registration.showNotification(item.title, {
      body: item.body,
      // One per conversation: ten messages from the same channel are one line to come back to. A
      // reminder is one per event.
      tag: item.conversation_id || item.event_id,
      renotify: true,
      silent: Boolean(pending.silent),
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      timestamp: Date.parse(item.created_at) || Date.now(),
      data: {
        id: item.id,
        spaceId: item.space_id,
        conversationId: item.conversation_id,
        messageId: item.message_id,
        eventId: item.event_id,
      },
    });
  }
  await rememberShown(items[0].created_at);
}

self.addEventListener("push", (event) => {
  event.waitUntil(onPush());
});

async function onClick(data) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (open) {
    await open.focus();
    if (data && (data.conversationId || data.eventId)) open.postMessage({ type: "ruchoir:open-notification", ...data });
    return;
  }
  const target =
    data && data.conversationId
      ? `/?open=${encodeURIComponent([data.spaceId, data.conversationId, data.messageId, data.id].join("."))}`
      : "/";
  await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(onClick(event.notification.data));
});

/** Base64url of an ArrayBuffer, the form the API stores subscription keys in. */
function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function onSubscriptionChange(event) {
  const options = event.oldSubscription ? event.oldSubscription.options : null;
  if (!options) return;
  const renewed = event.newSubscription || (await self.registration.pushManager.subscribe(options));
  await fetch("/api/v1/push/subscription", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: renewed.endpoint,
      keys: { p256dh: toBase64Url(renewed.getKey("p256dh")), auth: toBase64Url(renewed.getKey("auth")) },
    }),
  });
  if (event.oldSubscription) {
    await fetch("/api/v1/push/subscription", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }),
    });
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(onSubscriptionChange(event).catch(() => {}));
});
