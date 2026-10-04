"use client";

import { forgetPushSubscription, getPushConfig, savePushSubscription } from "@/lib/data/api";

/**
 * Web Push: notifications that reach this device while no Ruchoir page is open.
 *
 * The browser's own `Notification` (`desktopNotifications.ts`) needs a tab to exist somewhere.
 * This is the other half: a service worker (`public/sw.js`) that the browser wakes when the API
 * pushes, and that draws the notification itself. The push carries nothing: the worker asks the API
 * what to show (see ADR 0001 for why the push service of the browser's vendor is involved at all,
 * and why that is acceptable here).
 *
 * The subscription is per browser, and opt-in: it is created from a control in the preferences,
 * never on load, for the same reason the permission prompt is never shown on load.
 */

/**
 * What this browser can do.
 *
 * `needs-install` is Safari on iPhone and iPad, which only offers Web Push to an app added to the
 * home screen: the page can say so, and nothing else.
 */
export type PushSupport = "unsupported" | "needs-install" | "available";

function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; its touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Whether the app is running as an installed app rather than in a browser tab. */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || window.matchMedia("(display-mode: standalone)").matches;
}

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "available";
  if (isAppleMobile() && !isInstalledApp()) return "needs-install";
  return "unsupported";
}

/**
 * Register the service worker. Harmless when push is never used: the worker intercepts no request,
 * and having one is part of what makes the app installable.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    // A browser in a private mode may refuse; the app works the same without it.
  });
}

// --- Whether this browser is subscribed, for `useSyncExternalStore` ---

let active = false;
const listeners = new Set<() => void>();

function setActive(next: boolean) {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
}

export function subscribeToPushState(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Whether this browser currently receives Web Push for the signed-in account. */
export function pushActive(): boolean {
  return active;
}

export function serverPushActive(): boolean {
  return false;
}

/** The base64url public key, as the bytes `applicationServerKey` wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether an existing subscription was made against `publicKey`. */
function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const expected = keyBytes(publicKey);
  const got = new Uint8Array(current);
  return got.length === expected.length && got.every((byte, i) => byte === expected[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  registerServiceWorker();
  return navigator.serviceWorker.ready;
}

/** Why turning push on did not work, for the screen to say so. */
export type EnableOutcome = "enabled" | "denied" | "unavailable" | "failed";

/**
 * Turn Web Push on for this browser, from a user gesture: ask for the permission, subscribe against
 * the instance's key and hand the subscription to the API.
 */
export async function enablePush(): Promise<EnableOutcome> {
  if (pushSupport() !== "available") return "unavailable";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return "denied";
    const config = await getPushConfig();
    if (!config.available || !config.publicKey) return "unavailable";
    const reg = await registration();
    const existing = await reg.pushManager.getSubscription();
    if (existing && !sameKey(existing, config.publicKey)) await existing.unsubscribe();
    const subscription =
      existing && sameKey(existing, config.publicKey)
        ? existing
        : await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
    await savePushSubscription(subscription.toJSON());
    setActive(true);
    return "enabled";
  } catch {
    return "failed";
  }
}

/** Turn Web Push off for this browser: forget it on the server, then drop the subscription. */
export async function disablePush(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
    const subscription = await reg?.pushManager.getSubscription();
    if (subscription) {
      await forgetPushSubscription(subscription.endpoint).catch(() => {});
      await subscription.unsubscribe().catch(() => false);
    }
  } finally {
    setActive(false);
  }
}

/**
 * Bring this browser's subscription in line with the server, once per session.
 *
 * Re-sends an existing subscription (the account signed in may not be the one that created it, and
 * the server may have dropped it), replaces one made against a key the instance no longer uses, and
 * drops it when an administrator has turned Web Push off.
 */
export async function syncPush(): Promise<void> {
  if (pushSupport() !== "available") return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const subscription = await reg?.pushManager.getSubscription();
    if (!reg || !subscription) {
      setActive(false);
      return;
    }
    const config = await getPushConfig();
    if (!config.available || !config.publicKey || Notification.permission !== "granted") {
      await subscription.unsubscribe().catch(() => false);
      setActive(false);
      return;
    }
    let current = subscription;
    if (!sameKey(subscription, config.publicKey)) {
      await subscription.unsubscribe().catch(() => false);
      current = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(config.publicKey),
      });
    }
    await savePushSubscription(current.toJSON());
    setActive(true);
  } catch {
    // Offline, or the API is down: the next load tries again.
  }
}

/** A notification the worker asks the app to open, after a click on it. */
export type PushTarget = { spaceId: string; conversationId: string; messageId: string; id: string; eventId?: string };

/** Listen for the worker's "open this" messages (a click while a window was already open). */
export function onPushOpen(handler: (target: PushTarget) => void): () => void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as Partial<PushTarget> & { type?: string };
    // A message notification names its conversation; a calendar reminder, its event.
    if (data?.type !== "ruchoir:open-notification" || !(data.conversationId || data.eventId)) return;
    handler({
      spaceId: data.spaceId ?? "",
      conversationId: data.conversationId ?? "",
      messageId: data.messageId ?? "",
      id: data.id ?? "",
      eventId: data.eventId,
    });
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

/**
 * The notification a new window was opened for (`/?open=space.conversation.message.notification`),
 * taken off the address so a reload does not open it again.
 */
export function takePushLink(): PushTarget | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("open");
  if (!raw) return null;
  url.searchParams.delete("open");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const [spaceId = "", conversationId = "", messageId = "", id = ""] = raw.split(".");
  return conversationId ? { spaceId, conversationId, messageId, id } : null;
}
