/**
 * The fetch-backed implementation of the data seam.
 *
 * This is where the real Rust API is translated into the domain shapes the UI consumes
 * (`lib/data/types.ts`). Every function here is a thin, typed wrapper over {@link apiRequest}: it
 * calls one endpoint and maps its DTO (snake_case, UUIDs, RFC 3339 timestamps, raw byte sizes) into
 * the front shape (camel/display fields). The mock seam (`lib/data/index.ts`) is being replaced by
 * these, screen by screen, so the mapping lives in one auditable place.
 *
 * It covers auth (sign-in, registration, email verification, password reset and the second-factor
 * step-up), the space and channel lifecycle, and the space bootstrap, member profiles, the message operations, files, search,
 * the notification feed and the realtime channel (`connectRealtime`). Message ids are UUID strings;
 * `ApiMessage` is the front `Message` with that string id.
 */
import type { Presence } from "@/components/ds";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut, apiRequest } from "./http";
import { currentLocale } from "@/lib/i18n/current";
import {
  createPasskeyCredential,
  getPasskeyAssertion,
  type PasskeyChallenge,
  type PasskeyCreationChallenge,
} from "@/lib/webauthn";
import type {
  BlankKind,
  Channel,
  ChannelType,
  ConversationNotify,
  NotifyLevel,
  CreatedInvitation,
  DirectMessage,
  FileEditor,
  ImportSource,
  InlineImage,
  Invitation,
  InvitationPreview,
  InvitationStatus,
  Message,
  MessageAttachment,
  MessageKind,
  OfficeCapabilities,
  OfficeMode,
  OfficeSession,
  PresenceChoice,
  Profile,
  Reaction,
  SpaceFile,
  SystemEvent,
  Workspace,
} from "./types";

// --- Raw API DTOs (mirror the Rust structs; snake_case, as sent on the wire) ---

/** The signed-in user, from `POST /auth/login`, `POST /auth/register` and `GET /auth/session`. */
type UserSummaryDto = {
  id: string;
  email: string;
  display_name: string;
  active: boolean;
  /** The caller's own availability choice; absent means automatic. Never sent for anyone else. */
  manual_presence?: string;
  /** Whether this account administers the instance. */
  is_instance_admin?: boolean;
  timezone?: string;
  locale?: string;
};

/** Alternative login outcome when a second factor is required (same 200 status as a success). */
type MfaRequiredDto = { mfa_required: true; methods: string[]; mfa_token: string };

type SpaceDto = {
  id: string;
  name: string;
  slug: string;
  role: string;
  members: number;
  unread: number;
  mentions: number;
  icon_url?: string;
  default_channel_id?: string;
  notify_level?: string;
};

type ChannelDto = {
  id: string;
  name: string;
  type: string;
  topic?: string;
  imported?: string;
  favorite: boolean;
  notify_level?: string;
  muted?: boolean;
  member: boolean;
  unread: number;
  allowed_roles?: string[];
};

type DirectMessageDto = {
  id: string;
  name: string;
  is_group: boolean;
  user_id?: string;
  bot: boolean;
  unread: number;
  notify_level?: string;
  muted?: boolean;
  last_message?: { excerpt: string; mine: boolean; created_at: string };
};

type PresenceDto = { user_id: string; presence: string };

type ReactionDto = { emoji: string; count: number; mine: boolean; users: string[] };

type AttachmentDto = {
  file_id: string;
  name: string;
  kind: string;
  size_bytes: number;
  mime_type?: string;
  version_id?: string;
  has_thumbnail: boolean;
  image_width?: number;
  image_height?: number;
  alt_text?: string;
  deleted?: boolean;
};

type MessageDto = {
  id: string;
  conversation_id: string;
  author_id: string | null;
  author_name: string | null;
  kind: string;
  body: string;
  system_event?: string;
  parent_message_id?: string;
  reply_count: number;
  /** The server's preview of the first link, once it has read the page. */
  link?: {
    url: string;
    domain: string;
    title?: string;
    description?: string;
    color?: string;
    image_url?: string;
    image_width?: number;
    image_height?: number;
  };
  /** Display names of the last repliers, most recent first. Absent when the thread is empty. */
  reply_authors?: string[];
  last_reply_at?: string;
  imported: boolean;
  edited: boolean;
  deleted: boolean;
  pinned: boolean;
  pinned_by?: string;
  saved: boolean;
  created_at: string;
  edited_at?: string;
  reactions: ReactionDto[];
  mentions: string[];
  attachments: AttachmentDto[];
};

type MessagePageDto = { messages: MessageDto[]; next_before?: string };

type UserProfileDto = {
  avatar_url?: string;
  id: string;
  display_name: string;
  email: string;
  title?: string;
  pronouns?: string;
  timezone?: string;
  bio?: string;
  locale?: string;
  is_bot: boolean;
  is_instance_admin?: boolean;
};

// --- Session / auth ---

/** The signed-in user in the shape the app shell holds it. */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  presenceChoice: PresenceChoice;
  /** Whether this account administers the instance, which is what opens the recovery screen. */
  isInstanceAdmin: boolean;
  /** The account's timezone; absent when it has never had one. */
  timezone?: string;
  /** The language the account is recorded as reading in; absent until the first sign-in writes it. */
  locale?: string;
};

/** Outcome of a login attempt: authenticated, or challenged for a second factor. */
export type LoginResult =
  | { kind: "authenticated"; user: SessionUser }
  | { kind: "mfa"; methods: MfaMethod[]; mfaToken: string };

function toSessionUser(dto: UserSummaryDto): SessionUser {
  return {
    id: dto.id,
    email: dto.email,
    name: dto.display_name,
    presenceChoice: toPresenceChoice(dto.manual_presence),
    isInstanceAdmin: dto.is_instance_admin === true,
    timezone: dto.timezone,
    locale: dto.locale,
  };
}

/**
 * Give an account the browser's timezone when it has none.
 *
 * The profile card shows a local time, and until now nothing could ever fill it: the column was
 * writable by nobody, so every profile said "Europe/Paris" (invented) or, once that was removed,
 * nothing at all. The browser knows where its reader is, and that is a fact rather than a guess, so
 * an account that has never had one is given it, once, silently. It stays editable, and a second
 * device does not overwrite the choice, since this only ever fires on an empty value.
 */
export async function adoptBrowserTimezone(current?: string): Promise<string | undefined> {
  if (current) return current;
  let detected: string | undefined;
  try {
    detected = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
  if (!detected) return undefined;
  try {
    await updateMyProfile({ timezone: detected });
    return detected;
  } catch {
    // Not worth surfacing: the interface is unaffected, and the next sign-in tries again.
    return undefined;
  }
}

/**
 * Keep the account's language in step with the one being read.
 *
 * `users.locale` holds **the language in force**, not the preference: someone on "follow the
 * browser" is reading in a language all the same, and a profile that says nothing about it is
 * simply wrong. Whether that language was chosen or detected is the browser's business, and stays
 * in the local preferences.
 *
 * So it is written on sign-in whenever it differs from what the account holds, which covers the
 * person who never opened the language menu as well as the one who changed it on another machine.
 * Same shape as the timezone, and for the same reason: the server keeps the last known fact, the
 * client keeps the preference.
 */
export async function syncAccountLocale(current: string | undefined, inForce: string): Promise<void> {
  if (current === inForce) return;
  try {
    await updateMyProfile({ locale: inForce });
  } catch {
    // Not worth surfacing: the interface is already in the right language, and the next sign-in
    // tries again.
  }
}

/** The stored override as the menu names it. Absent, empty or unknown all mean automatic. */
function toPresenceChoice(manual?: string): PresenceChoice {
  switch (manual) {
    case "dnd":
      return "busy";
    case "away":
      return "away";
    case "invisible":
      return "invisible";
    default:
      return "auto";
  }
}

/** `GET /auth/session`: the current user, or an {@link ApiError} 401 when no session is active. */
export async function getSession(signal?: AbortSignal): Promise<SessionUser> {
  return toSessionUser(await apiGet<UserSummaryDto>("/auth/session", signal));
}

/** `POST /auth/login`. Resolves to an authenticated user or an MFA challenge; throws on bad credentials. */
export async function login(email: string, password: string): Promise<LoginResult> {
  const body = await apiPost<UserSummaryDto | MfaRequiredDto>("/auth/login", { email, password });
  if ("mfa_required" in body && body.mfa_required) {
    // Drop anything this client cannot complete, so the challenge screen never offers a dead option.
    const methods = body.methods.filter((m): m is MfaMethod => MFA_METHODS.includes(m as MfaMethod));
    return { kind: "mfa", methods, mfaToken: body.mfa_token };
  }
  return { kind: "authenticated", user: toSessionUser(body as UserSummaryDto) };
}

/**
 * `POST /auth/logout/all`: end every session of this account, on every device.
 *
 * Including this one: the server drops them all and clears the cookie, which is what makes it the
 * answer to "someone else may be signed in as me". A "log out the others but keep me here" would
 * be a different, weaker thing, and is not what this route does.
 */
export async function logoutEverywhere(): Promise<void> {
  await apiPost<void>("/auth/logout/all");
}

/** `POST /auth/logout`: end the current session. */
export async function logout(): Promise<void> {
  await apiPost<void>("/auth/logout");
}

// --- Account security (second factors, password) ---

/** One registered passkey, as the account screen lists them. */
export type PasskeySummary = { id: string; label?: string; createdAt: string; lastUsedAt?: string };

/** What second factors the account actually holds, as the server knows it. */
export type MfaState = { totpEnabled: boolean; recoveryCodesRemaining: number; passkeys: PasskeySummary[] };

/**
 * `GET /auth/mfa`: the account's real second factors.
 *
 * The screen used to keep this in the browser's local storage, so it reported two-factor
 * authentication as enabled on accounts that had never enrolled. There is one source now.
 */
export async function getMfaState(signal?: AbortSignal): Promise<MfaState> {
  const dto = await apiGet<{
    totp_enabled: boolean;
    recovery_codes_remaining: number;
    passkeys: { id: string; label?: string; created_at: string; last_used_at?: string }[];
  }>("/auth/mfa", signal);
  return {
    totpEnabled: dto.totp_enabled,
    recoveryCodesRemaining: dto.recovery_codes_remaining,
    passkeys: dto.passkeys.map((p) => ({
      id: p.id,
      label: p.label,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at,
    })),
  };
}

/** `POST /auth/mfa/totp/enroll`: start enrolment, returning the provisioning URI and its QR code. */
export async function enrollTotp(): Promise<{ otpauthUrl: string; qrSvg: string }> {
  const dto = await apiPost<{ otpauth_url: string; qr_svg: string }>("/auth/mfa/totp/enroll");
  return { otpauthUrl: dto.otpauth_url, qrSvg: dto.qr_svg };
}

/** `POST /auth/mfa/totp/confirm`: finish enrolment with a code from the authenticator. */
export async function confirmTotp(code: string): Promise<void> {
  await apiPost<void>("/auth/mfa/totp/confirm", { code });
}

/**
 * `POST /auth/mfa/totp/disable`: turn it off.
 *
 * A body, so a POST: the password is required on purpose, since someone sitting at an unlocked
 * machine must not be able to strip the factor that protects the account from them.
 */
export async function disableTotp(password: string): Promise<void> {
  await apiPost<void>("/auth/mfa/totp/disable", { password });
}

/**
 * `POST /auth/mfa/recovery-codes/generate`: a fresh set, replacing any previous one.
 *
 * Returned in the clear exactly once; the server keeps only their hashes. Generating again voids
 * the old set, which is why the screen says so before offering it.
 */
export async function generateRecoveryCodes(): Promise<string[]> {
  const dto = await apiPost<{ codes: string[] }>("/auth/mfa/recovery-codes/generate");
  return dto.codes;
}

/** Register a passkey on this device: challenge, authenticator ceremony, then attestation. */
export async function registerPasskey(): Promise<void> {
  const challenge = await apiPost<PasskeyCreationChallenge>("/auth/mfa/passkey/register/start");
  const credential = await createPasskeyCredential(challenge);
  await apiPost<void>("/auth/mfa/passkey/register/finish", credential);
}

/** `DELETE /auth/mfa/passkey/{id}`: forget one registered key. */
export async function removePasskey(credentialId: string): Promise<void> {
  await apiDelete<void>(`/auth/mfa/passkey/${credentialId}`);
}

/**
 * `POST /auth/password`: change the password, knowing the current one.
 *
 * Every session ends, this one included: a password is changed because someone else may know it,
 * and leaving their session alive would defeat the change. The caller returns to sign-in.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiPost<void>("/auth/password", {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

// --- Registration, email verification and password reset ---

/**
 * `POST /auth/register`: create an account. No session is opened either way.
 *
 * Ordinarily the account starts unverified, the API emails a confirmation link, and signing in is
 * refused until the address is confirmed. Registering from an invitation **addressed to that same
 * address** skips all of that: the invitation was delivered to the mailbox, which is the same proof
 * the confirmation email would collect. `active` in the response says which of the two happened, so
 * the caller sends the person to sign in rather than to a mailbox they have no reason to open.
 */
export async function register(
  email: string,
  displayName: string,
  password: string,
  invitationToken?: string,
): Promise<{ user: SessionUser; active: boolean }> {
  const dto = await apiPost<UserSummaryDto>("/auth/register", {
    email,
    display_name: displayName,
    password,
    invitation_token: invitationToken,
    // The language of the page they are registering on: the confirmation email is the very next
    // thing that happens, and arriving in another language than the screen that sent it is the kind
    // of detail that makes a product feel translated rather than written.
    locale: currentLocale(),
  });
  return { user: toSessionUser(dto), active: dto.active };
}

/**
 * `POST /auth/verify-email/request`: send (or resend) the verification link. Always resolves, whether
 * or not the address has an account, so the response never reveals who is registered.
 */
export async function requestEmailVerification(email: string): Promise<void> {
  // In the language of this page: whoever reads it is who will read the message.
  await apiPost<void>("/auth/verify-email/request", { email, locale: currentLocale() });
}

/** `POST /auth/verify-email/confirm`: activate the account behind an emailed token (single use). */
export async function confirmEmailVerification(token: string): Promise<void> {
  await apiPost<void>("/auth/verify-email/confirm", { token });
}

/** `POST /auth/password-reset/request`: email a reset link. Always resolves (no account enumeration). */
export async function requestPasswordReset(email: string): Promise<void> {
  await apiPost<void>("/auth/password-reset/request", { email, locale: currentLocale() });
}

/**
 * `POST /auth/password-reset/confirm`: set a new password from an emailed token. The server drops
 * every existing session for that account, so the user signs in again with the new password.
 */
export async function confirmPasswordReset(token: string, password: string): Promise<void> {
  await apiPost<void>("/auth/password-reset/confirm", { token, password });
}

/**
 * `POST /auth/password-reset/recovery`: take the account back with a recovery code.
 *
 * The path for an instance that cannot send email, and for anyone whose mailbox is out of reach.
 * The code is spent whether or not it is ever used again, and every session of the account is
 * dropped, exactly as for an emailed reset.
 */
export async function resetPasswordWithRecoveryCode(email: string, code: string, password: string): Promise<void> {
  await apiPost<void>("/auth/password-reset/recovery", { email, code, password });
}

// --- What this instance can do ---

/** What the instance supports, as far as a client needs to know before signing in. */
export type InstanceCapabilities = {
  /** Whether a mail relay is configured. False means every emailed flow is a dead end. */
  emailDelivery: boolean;
  /** Live office editing, when the instance has it. */
  office: OfficeCapabilities;
  /** The largest file an upload accepts, in bytes (absent from an older server: no check). */
  uploadMaxBytes?: number;
  /** Days a removed file stays in the trash (0: until emptied; absent from an older server). */
  trashRetentionDays?: number;
  /** Whether files may be handed out by public link. */
  publicLinks: boolean;
};

/**
 * `GET /instance`: the instance's capabilities, without a session.
 *
 * Running with no mail relay is a supported configuration, so screens that would otherwise promise
 * a message ask this first and offer the other way in instead.
 */
export async function getInstanceCapabilities(signal?: AbortSignal): Promise<InstanceCapabilities> {
  const dto = await apiGet<{
    email_delivery: boolean;
    office?: { enabled: boolean; edit: string[]; view: string[]; convert: string[]; public_url?: string };
    upload_max_bytes?: number;
    trash_retention_days?: number;
    public_links?: boolean;
  }>("/instance", signal);
  return {
    emailDelivery: dto.email_delivery,
    uploadMaxBytes: dto.upload_max_bytes,
    trashRetentionDays: dto.trash_retention_days,
    publicLinks: dto.public_links === true,
    office: {
      enabled: dto.office?.enabled === true,
      edit: dto.office?.edit ?? [],
      view: dto.office?.view ?? [],
      convert: dto.office?.convert ?? [],
      publicUrl: dto.office?.public_url,
    },
  };
}

// --- Instance administration ---

/** An account as the recovery screen lists it. */
export type AdminUser = {
  id: string;
  email: string;
  name: string;
  /** `pending`, `active` or `locked`. */
  status: string;
  isInstanceAdmin: boolean;
};

/**
 * `GET /admin/users?query=`: find an account to act on. Instance administrators only; to anyone
 * else the route answers 404, so a caller who is not one sees no administration surface at all.
 */
export async function searchAccounts(query: string, signal?: AbortSignal): Promise<AdminUser[]> {
  const rows = await apiGet<
    { id: string; email: string; display_name: string; status: string; is_instance_admin: boolean }[]
  >(`/admin/users?query=${encodeURIComponent(query)}`, signal);
  return rows.map((dto) => ({
    id: dto.id,
    email: dto.email,
    name: dto.display_name,
    status: dto.status,
    isInstanceAdmin: dto.is_instance_admin,
  }));
}

/**
 * `POST /admin/users/{id}/password-reset`: issue a single-use reset link for someone locked out.
 *
 * The link is returned once and never retrievable again, and the account's current password keeps
 * working until its holder uses it.
 */
export async function issuePasswordResetLink(userId: string): Promise<{ url: string; expiresInSecs: number }> {
  const dto = await apiPost<{ url: string; expires_in_secs: number }>(`/admin/users/${userId}/password-reset`);
  return { url: dto.url, expiresInSecs: dto.expires_in_secs };
}

/** What an administrator has decided for the whole instance. */
export type InstanceSettings = {
  /** Whether the interface tells everyone who administers the instance. */
  showInstanceAdmins: boolean;
  /**
   * Whether the instance sends Web Push. Pushes go through the push service of each reader's
   * browser vendor, which the instance does not choose (ADR 0001), so an administrator may refuse it.
   */
  webPushEnabled: boolean;
};

type InstanceSettingsDto = { show_instance_admins: boolean; web_push_enabled: boolean };

function toInstanceSettings(dto: InstanceSettingsDto): InstanceSettings {
  return { showInstanceAdmins: dto.show_instance_admins, webPushEnabled: dto.web_push_enabled };
}

/** `GET /admin/settings`: the instance's settings. Instance administrators only. */
export async function getInstanceSettings(signal?: AbortSignal): Promise<InstanceSettings> {
  return toInstanceSettings(await apiGet<InstanceSettingsDto>("/admin/settings", signal));
}

/** `PATCH /admin/settings`: change them. Fields left out are left alone. */
export async function updateInstanceSettings(patch: Partial<InstanceSettings>): Promise<InstanceSettings> {
  const dto = await apiPatch<InstanceSettingsDto>("/admin/settings", {
    show_instance_admins: patch.showInstanceAdmins,
    web_push_enabled: patch.webPushEnabled,
  });
  return toInstanceSettings(dto);
}

// --- Second factor at sign-in ---

/**
 * The second factors an account can complete, as listed by an {@link LoginResult} MFA challenge.
 * Unknown values are ignored by the screen rather than rendered as an unusable option.
 */
export type MfaMethod = "totp" | "passkey" | "recovery";

/** The known {@link MfaMethod} values, in the order the challenge screen prefers them. */
const MFA_METHODS: MfaMethod[] = ["totp", "passkey", "recovery"];

/** `POST /auth/mfa/totp/verify`: answer the pending challenge with an authenticator code. */
export async function verifyTotp(mfaToken: string, code: string): Promise<SessionUser> {
  const dto = await apiPost<UserSummaryDto>("/auth/mfa/totp/verify", { mfa_token: mfaToken, code });
  return toSessionUser(dto);
}

/** `POST /auth/mfa/recovery/verify`: answer the pending challenge with a single-use recovery code. */
export async function verifyRecoveryCode(mfaToken: string, code: string): Promise<SessionUser> {
  const dto = await apiPost<UserSummaryDto>("/auth/mfa/recovery/verify", { mfa_token: mfaToken, code });
  return toSessionUser(dto);
}

/**
 * Answer the pending challenge with a passkey: fetch the WebAuthn challenge, have the authenticator
 * sign it, and post the assertion back (`/auth/mfa/passkey/authenticate/{start,finish}`). Resolves to
 * the signed-in user; the session cookie is set on the finish response like any other sign-in.
 */
export async function verifyPasskey(mfaToken: string): Promise<SessionUser> {
  const challenge = await apiPost<PasskeyChallenge>("/auth/mfa/passkey/authenticate/start", {
    mfa_token: mfaToken,
  });
  const credential = await getPasskeyAssertion(challenge);
  const dto = await apiPost<UserSummaryDto>("/auth/mfa/passkey/authenticate/finish", {
    mfa_token: mfaToken,
    credential,
  });
  return toSessionUser(dto);
}

// --- Space bootstrap (workspaces, channels, DMs, presence, profiles) ---

function toWorkspace(dto: SpaceDto): Workspace {
  return {
    id: dto.id,
    name: dto.name,
    members: dto.members,
    role: dto.role,
    slug: dto.slug,
    unread: dto.unread ?? 0,
    mentions: dto.mentions ?? 0,
    iconUrl: dto.icon_url,
    defaultChannelId: dto.default_channel_id,
    notifyLevel: toNotifyLevel(dto.notify_level),
  };
}

/** A level from the wire; anything unknown reads as `default`, which is the quiet answer. */
function toNotifyLevel(level: string | undefined): NotifyLevel {
  return level === "all" || level === "mentions" || level === "none" ? level : "default";
}

/** `PUT /spaces/{id}/notification-preference`: how much a whole space notifies the caller. */
export async function saveSpaceNotify(spaceId: string, level: NotifyLevel): Promise<void> {
  await apiPut<void>(`/spaces/${spaceId}/notification-preference`, { level });
}

/** `GET /me/spaces`: the workspaces the caller belongs to. The SPA's entry point. */
export async function getWorkspaces(signal?: AbortSignal): Promise<Workspace[]> {
  const spaces = await apiGet<SpaceDto[]>("/me/spaces", signal);
  return spaces.map(toWorkspace);
}

function toChannel(dto: ChannelDto): Channel {
  return {
    id: dto.id,
    name: dto.name,
    fav: dto.favorite,
    unread: dto.unread,
    type: (["public", "private", "archived"].includes(dto.type) ? dto.type : "public") as ChannelType,
    topic: dto.topic,
    imported: toImportSource(dto.imported),
    member: dto.member,
    allowedRoles: dto.allowed_roles,
    notify: toConversationNotify(dto.notify_level, dto.muted),
  };
}

/** A conversation's notification setting from the wire, with the defaults for anything unknown. */
function toConversationNotify(level: string | undefined, muted: boolean | undefined): ConversationNotify {
  return { level: toNotifyLevel(level), muted: muted === true };
}

/**
 * `POST /spaces`: create a space owned by the caller. It comes back with a starting channel, so the
 * caller lands on something rather than on an empty shell.
 */
export async function createSpace(name: string): Promise<Workspace> {
  return toWorkspace(await apiPost<SpaceDto>("/spaces", { name }));
}

/**
 * `PATCH /spaces/{id}`: rename a space; owner or admin only.
 *
 * The slug follows the name, so the response may carry a new one; the old one keeps resolving to
 * the same space (see {@link resolveSpaceSlug}), which is what lets the address stay honest without
 * breaking the links people already hold.
 */
export async function renameSpace(spaceId: string, name: string): Promise<SpaceIdentity> {
  const dto = await apiPatch<{ id: string; name: string; slug: string; icon_url: string | null; default_channel_id?: string }>(
    `/spaces/${spaceId}`,
    { name },
  );
  return { id: dto.id, name: dto.name, slug: dto.slug, iconUrl: dto.icon_url ?? undefined, defaultChannelId: dto.default_channel_id };
}

/**
 * `PUT /spaces/{id}/channel-order`: the space's channels, first to last, as the caller sees them.
 * Administrators only. A 409 means the list changed since it was loaded: re-read it.
 */
export async function setChannelOrder(spaceId: string, channelIds: string[]): Promise<void> {
  await apiPut<void>(`/spaces/${spaceId}/channel-order`, { channel_ids: channelIds });
}

/** Choose the public channel every newly invited person joins. Space administrators may change it. */
export async function setDefaultChannel(spaceId: string, channelId: string): Promise<SpaceIdentity> {
  const dto = await apiPut<{ id: string; name: string; slug: string; icon_url: string | null; default_channel_id?: string }>(
    `/spaces/${spaceId}/default-channel`,
    { channel_id: channelId },
  );
  return { id: dto.id, name: dto.name, slug: dto.slug, iconUrl: dto.icon_url ?? undefined, defaultChannelId: dto.default_channel_id };
}

/**
 * `PATCH /spaces/{id}/members/{userId}`: change what a member may do in the space.
 *
 * Returns every membership the call changed, which is one for an ordinary promotion or demotion and
 * **two** for a transfer of ownership: a space has a single owner, so the person handing it over
 * becomes an admin in the same write. Apply them all rather than assuming the one that was asked
 * for, or the former owner keeps being offered controls the server has just taken away.
 */
export async function setMemberRole(
  spaceId: string,
  userId: string,
  role: string,
): Promise<{ userId: string; role: string }[]> {
  const changes = await apiPatch<{ space_id: string; user_id: string; role: string }[]>(
    `/spaces/${spaceId}/members/${userId}`,
    { role },
  );
  return changes.map((c) => ({ userId: c.user_id, role: c.role }));
}

/**
 * `DELETE /spaces/{id}/membership`: leave a space, taking only the caller's own membership.
 *
 * What they wrote stays where it was written. Coming back needs a new invitation, so the caller is
 * expected to have confirmed first. Refused with a `409` for the space's last owner, who has to
 * make someone else an owner or delete the space.
 */
export async function leaveSpace(spaceId: string): Promise<void> {
  await apiDelete<void>(`/spaces/${spaceId}/membership`);
}

/**
 * `DELETE /spaces/{id}/members/{userId}`: take someone out of a space.
 *
 * The administrator's counterpart of leaving, under the same rank rule as a role change: only on
 * someone ranked below the caller. What they wrote stays where it was written.
 */
export async function removeMember(spaceId: string, userId: string): Promise<void> {
  await apiDelete<void>(`/spaces/${spaceId}/members/${userId}`);
}

/**
 * `DELETE /spaces/{id}`: delete a space and everything in it. Owner only, immediate, and final:
 * there is no grace period and nothing is kept back.
 */
export async function deleteSpace(spaceId: string): Promise<void> {
  await apiDelete<void>(`/spaces/${spaceId}`);
}

/**
 * `GET /spaces/by-slug/{slug}`: which space an address names, current slug or retired one.
 *
 * Only needed when a slug matches nothing the client holds, which means a link written before a
 * rename. `null` when the slug leads nowhere the caller may go: the API does not distinguish "no
 * such space" from "not yours", and neither does this.
 */
export async function resolveSpaceSlug(slug: string): Promise<{ id: string; slug: string } | null> {
  try {
    return await apiGet<{ id: string; slug: string }>(`/spaces/by-slug/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}

// --- Space invitations ---

type InvitationDto = {
  id: string;
  space_id: string;
  email?: string;
  role: string;
  invited_by?: string;
  uses: number;
  max_uses?: number;
  expires_at?: string;
  created_at: string;
  usable: boolean;
  status?: string;
};

type CreatedInvitationDto = InvitationDto & { url: string; emailed: boolean };

type InvitationPreviewDto = { space_name: string; invited_by?: string; email?: string; role: string };

function toInvitation(dto: InvitationDto): Invitation {
  return {
    id: dto.id,
    email: dto.email,
    role: dto.role,
    invitedBy: dto.invited_by,
    uses: dto.uses,
    maxUses: dto.max_uses,
    expiresAt: dto.expires_at,
    createdAt: dto.created_at,
    usable: dto.usable,
    status: toInvitationStatus(dto),
  };
}

/** Statuses the API sends, with a fallback for an API older than the field. */
function toInvitationStatus(dto: InvitationDto): InvitationStatus {
  switch (dto.status) {
    case "accepted":
    case "revoked":
    case "expired":
    case "active":
      return dto.status;
    default:
      return dto.usable ? "active" : "expired";
  }
}

/**
 * `POST /spaces/{id}/invitations`: issue an invitation, as an owner or admin of the space.
 *
 * Pass an address to have the API email it (single-use by default), or omit it for a shareable
 * link (unlimited by default). The returned `url` is the only time the link exists in readable
 * form: the API stores only its digest, so it cannot be fetched again.
 */
export async function createInvitation(
  spaceId: string,
  options: { email?: string; role?: string; expiresInHours?: number; maxUses?: number } = {},
): Promise<CreatedInvitation> {
  const dto = await apiPost<CreatedInvitationDto>(`/spaces/${spaceId}/invitations`, {
    email: options.email,
    role: options.role,
    expires_in_hours: options.expiresInHours,
    max_uses: options.maxUses,
  });
  return { invitation: toInvitation(dto), url: dto.url, emailed: dto.emailed };
}

/** `GET /spaces/{id}/invitations`: what is outstanding, newest first. Owner/admin only. */
export async function getInvitations(spaceId: string, signal?: AbortSignal): Promise<Invitation[]> {
  const rows = await apiGet<InvitationDto[]>(`/spaces/${spaceId}/invitations`, signal);
  return rows.map(toInvitation);
}

/** `DELETE /spaces/{id}/invitations/{id}`: stop accepting an invitation. Idempotent. */
export async function revokeInvitation(spaceId: string, invitationId: string): Promise<void> {
  await apiDelete<void>(`/spaces/${spaceId}/invitations/${invitationId}`);
}

/**
 * `GET /invitations/{token}`: what this invitation is, before signing in.
 *
 * Needs no session, which is the point: the invitee has to see which space they are joining to
 * decide whether to create an account. A 404 covers unknown, revoked, expired and exhausted alike.
 */
export async function previewInvitation(token: string, signal?: AbortSignal): Promise<InvitationPreview> {
  const dto = await apiGet<InvitationPreviewDto>(`/invitations/${encodeURIComponent(token)}`, signal);
  return { spaceName: dto.space_name, invitedBy: dto.invited_by, email: dto.email, role: dto.role };
}

/** `POST /invitations/{token}/accept`: join the space. Idempotent for an existing member. */
export async function acceptInvitation(token: string): Promise<Workspace> {
  return toWorkspace(await apiPost<SpaceDto>(`/invitations/${encodeURIComponent(token)}/accept`));
}

/**
 * `POST /conversations/{id}/attachments`: upload a file to attach to a message here.
 *
 * Through the conversation and not the space, because that is what decides the file's audience: an
 * attachment to a private channel or a direct message stays readable only by its participants, one
 * to a public channel joins the space's files.
 */
export async function uploadAttachment(conversationId: string, file: File): Promise<MessageAttachment> {
  const form = new FormData();
  form.append("file", file);
  // Multipart: let the browser set the boundary, so this call does not go through the JSON client.
  const res = await fetch(`/api/v1/conversations/${conversationId}/attachments`, {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, await res.text().catch(() => null));
  const dto = (await res.json()) as FileDto;
  // Returned in the shape the composer and the message row already speak, not as a `SpaceFile`: an
  // attachment is not a row of the files screen, and half of that shape would be invented here.
  return {
    fileId: dto.id,
    name: dto.name,
    sizeBytes: dto.size_bytes,
    kind: attachmentIcon(dto.kind),
    url: `/api/v1/files/${dto.id}/download`,
    previewUrl: `/api/v1/files/${dto.id}/preview`,
  };
}

/** `PUT /users/me/avatar`: replace the caller's own avatar; returns its new URL. */
export async function setMyAvatar(file: File): Promise<string> {
  return uploadImage("/api/v1/users/me/avatar", file);
}

/** `DELETE /users/me/avatar`: fall back to the generated avatar. */
export async function clearMyAvatar(): Promise<void> {
  await apiDelete<void>("/users/me/avatar");
}

/** `PUT /spaces/{id}/icon`: replace a space's icon; owner or admin only. Returns its new URL. */
export async function setSpaceIcon(spaceId: string, file: File): Promise<string> {
  return uploadImage(`/api/v1/spaces/${spaceId}/icon`, file);
}

/** `DELETE /spaces/{id}/icon`: fall back to the generated mark. */
export async function clearSpaceIcon(spaceId: string): Promise<void> {
  await apiDelete<void>(`/spaces/${spaceId}/icon`);
}

/**
 * Shared body of the two image uploads.
 *
 * The returned URL already carries a version derived from the stored object, so nothing is appended
 * here: an avatar is addressed by its owner's id, which never changes, and that version is what tells
 * the browser it is looking at a different picture.
 */
async function uploadImage(path: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(path, { method: "PUT", credentials: "same-origin", body: form });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, await res.text().catch(() => null));
  const body = (await res.json()) as { url: string };
  return body.url;
}

/** `GET /spaces/{id}/channels`: the channels the caller can see in a space. */
export async function getChannels(spaceId: string, signal?: AbortSignal): Promise<Channel[]> {
  const channels = await apiGet<ChannelDto[]>(`/spaces/${spaceId}/channels`, signal);
  return channels.map(toChannel);
}

/**
 * `POST /spaces/{id}/channels`: create a channel, owned by the caller. The server normalises the
 * name into a handle (lowercase, accents folded, dashes), so the channel comes back under the name
 * it will keep, which may differ from what was typed.
 */
export async function createChannel(
  spaceId: string,
  channel: { name: string; type: ChannelType; topic?: string; allowedRoles?: string[] },
): Promise<Channel> {
  const dto = await apiPost<ChannelDto>(`/spaces/${spaceId}/channels`, {
    name: channel.name,
    type: channel.type,
    topic: channel.topic,
    // Absent leaves the channel open to every role; an empty list says the same thing, which is what
    // an empty selection means on screen.
    allowed_roles: channel.allowedRoles,
  });
  return toChannel(dto);
}

/**
 * `PUT /channels/{id}/favorite`: pin a channel to the caller's own favourites, or unpin it.
 *
 * Per caller: a favourite is one person's shortcut and is invisible to everyone else.
 */
export async function setChannelFavorite(channelId: string, favorite: boolean): Promise<void> {
  await apiPut<void>(`/channels/${channelId}/favorite`, { favorite });
}

/**
 * `DELETE /channels/{id}`: delete a channel and everything said in it, for everyone. Space owners
 * and administrators only; a `409` means it is the space's default channel.
 */
export async function deleteChannel(channelId: string): Promise<void> {
  await apiDelete<void>(`/channels/${channelId}`);
}

/**
 * `PATCH /channels/{id}`: rename a channel, set its topic, or change its visibility. Archiving is
 * `type: "archived"`, which makes the channel read-only without deleting anything.
 */
export async function updateChannel(
  channelId: string,
  patch: { name?: string; type?: ChannelType; topic?: string; allowedRoles?: string[] },
): Promise<Channel> {
  const dto = await apiPatch<ChannelDto>(`/channels/${channelId}`, {
    name: patch.name,
    type: patch.type,
    topic: patch.topic,
    allowed_roles: patch.allowedRoles,
  });
  return toChannel(dto);
}

/** `PUT /channels/{id}/membership`: join a public channel. Idempotent. */
export async function joinChannel(channelId: string): Promise<void> {
  await apiPut<void>(`/channels/${channelId}/membership`);
}

/** `DELETE /channels/{id}/membership`: leave a channel. Only the caller's membership is removed. */
export async function leaveChannel(channelId: string): Promise<void> {
  await apiDelete<void>(`/channels/${channelId}/membership`);
}

function toDirectMessage(dto: DirectMessageDto): DirectMessage {
  // The DM list carries no presence (it is volatile); it is overlaid from `getSpacePresence` and
  // realtime events, keyed by the counterpart's user id. Default to offline until that arrives.
  return {
    id: dto.id,
    name: dto.name,
    presence: "offline",
    unread: dto.unread,
    bot: dto.bot || undefined,
    userId: dto.user_id,
    notify: toConversationNotify(dto.notify_level, dto.muted),
    lastMessage: dto.last_message
      ? { excerpt: dto.last_message.excerpt, mine: dto.last_message.mine, at: dto.last_message.created_at }
      : undefined,
  };
}

/** `GET /spaces/{id}/dms`: the caller's direct-message conversations in a space. */
export async function getDirectMessages(spaceId: string, signal?: AbortSignal): Promise<DirectMessage[]> {
  const dms = await apiGet<DirectMessageDto[]>(`/spaces/${spaceId}/dms`, signal);
  return dms.map(toDirectMessage);
}

/** `GET /spaces/{id}/presence`: the current presence of the space's members, keyed by user id. */
export async function getSpacePresence(spaceId: string, signal?: AbortSignal): Promise<Record<string, Presence>> {
  const rows = await apiGet<PresenceDto[]>(`/spaces/${spaceId}/presence`, signal);
  const out: Record<string, Presence> = {};
  for (const row of rows) out[row.user_id] = toPresence(row.presence);
  return out;
}

/**
 * `PUT /me/presence`: set the caller's availability, and return the presence that results.
 *
 * `auto` sends `null`, which is the API's way of saying "derive it from the connection". It is what
 * the menu's ordinary "En ligne" entry sends and the state a user is normally in, without any of
 * that being surfaced to them. Nothing ever sent it before: every entry wrote a fixed override, so
 * picking "online" once left a user green for good, with no way back through the interface. The response is the server's own answer and is what the caller should display,
 * rather than assuming the choice took effect as asked.
 */
export async function setMyPresence(choice: PresenceChoice): Promise<Presence> {
  const manual =
    choice === "auto" ? null : choice === "busy" ? "dnd" : choice === "away" ? "away" : "invisible";
  const dto = await apiPut<PresenceDto>("/me/presence", { manual_presence: manual });
  return toPresence(dto.presence);
}

/**
 * `GET /users/{id}`: a member's profile. Presence and local time are not carried by the endpoint:
 * presence is overlaid by the caller from the space presence map, and the local time is derived from
 * the timezone here so the profile card can render it.
 */
export async function getUserProfile(userId: string, signal?: AbortSignal): Promise<Profile> {
  const dto = await apiGet<UserProfileDto>(`/users/${userId}`, signal);
  return {
    name: dto.display_name,
    role: dto.title,
    presence: "offline",
    email: dto.email,
    // No invented default: a profile that has never set one said "Europe/Paris", which the card
    // rendered as this person's local time. Absent now means absent, and the card says nothing.
    timezone: dto.timezone,
    pronouns: dto.pronouns,
    bio: dto.bio,
    bot: dto.is_bot || undefined,
    locale: dto.locale,
    instanceAdmin: dto.is_instance_admin || undefined,
    avatarUrl: dto.avatar_url,
  };
}

type MemberDto = {
  user_id: string;
  display_name: string;
  title?: string;
  role: string;
  is_bot: boolean;
  avatar_url?: string;
};

/** A space member as the app holds it. Presence is overlaid separately (by user id). */
export type Member = {
  userId: string;
  name: string;
  role: string;
  title?: string;
  bot: boolean;
  /** Same-origin URL of the uploaded avatar; absent means the locally generated one. */
  avatarUrl?: string;
};

/** `GET /spaces/{id}/members`: the members of a space (member list, mentions, people search). */
export async function getSpaceMembers(spaceId: string, signal?: AbortSignal): Promise<Member[]> {
  const rows = await apiGet<MemberDto[]>(`/spaces/${spaceId}/members`, signal);
  return rows.map((m) => ({
    userId: m.user_id,
    name: m.display_name,
    role: m.role,
    title: m.title,
    bot: m.is_bot,
    avatarUrl: m.avatar_url,
  }));
}

/**
 * `GET /channels/{id}/members`: who is actually in a channel.
 *
 * Not the same set as the space's members, which is what the member panel and the add-people dialog
 * were both showing: a private channel holds a subset, and anyone can leave a public one.
 */
export async function listChannelMembers(channelId: string, signal?: AbortSignal): Promise<Member[]> {
  const rows = await apiGet<MemberDto[]>(`/channels/${channelId}/members`, signal);
  return rows.map((m) => ({
    userId: m.user_id,
    name: m.display_name,
    role: m.role,
    title: m.title,
    bot: m.is_bot,
    avatarUrl: m.avatar_url,
  }));
}

/**
 * `POST /channels/{id}/members`: bring other people into a channel.
 *
 * Resolves to whoever was actually added: anyone already in the channel is skipped rather than
 * refused, since the outcome asked for is already true of them.
 */
export async function addChannelMembers(channelId: string, userIds: string[]): Promise<string[]> {
  const dto = await apiPost<{ added: string[] }>(`/channels/${channelId}/members`, { user_ids: userIds });
  return dto.added;
}

/**
 * `PATCH /channels/{id}/members/{userId}`: say what someone may do inside a channel.
 *
 * The channel's own ladder (`member` < `admin` < `owner`), under the rule the space roles use: only
 * below your own rank, on someone below it. A space administrator counts as the channel's owner.
 */
export async function setChannelMemberRole(
  channelId: string,
  userId: string,
  role: string,
): Promise<string> {
  const dto = await apiPatch<{ role: string }>(`/channels/${channelId}/members/${userId}`, { role });
  return dto.role;
}

/** `DELETE /channels/{id}/members/{userId}`: take someone out of a channel. Same rank rule. */
export async function removeChannelMember(channelId: string, userId: string): Promise<void> {
  await apiDelete<void>(`/channels/${channelId}/members/${userId}`);
}

/** `POST /spaces/{id}/dm`: open (or fetch) a direct message with a set of users; returns its id. */
export async function createDm(spaceId: string, userIds: string[]): Promise<string> {
  const ref = await apiPost<{ id: string }>(`/spaces/${spaceId}/dm`, { user_ids: userIds });
  return ref.id;
}

/** `PATCH /users/me`: update the caller's own profile; absent fields are unchanged, blank clears. */
export async function updateMyProfile(patch: {
  displayName?: string;
  title?: string;
  pronouns?: string;
  bio?: string;
  /** IANA name, or "" to clear it. */
  timezone?: string;
  /** Interface language, so what the server writes arrives in the language being read. */
  locale?: string;
}): Promise<Profile> {
  const dto = await apiPatch<UserProfileDto>("/users/me", {
    display_name: patch.displayName,
    title: patch.title,
    pronouns: patch.pronouns,
    bio: patch.bio,
    timezone: patch.timezone,
    locale: patch.locale,
  });
  return {
    name: dto.display_name,
    role: dto.title,
    presence: "offline",
    email: dto.email,
    timezone: dto.timezone,
    pronouns: dto.pronouns,
    bio: dto.bio,
    bot: dto.is_bot || undefined,
    avatarUrl: dto.avatar_url,
  };
}

// --- Messages ---

/**
 * A message as this seam returns it: the front {@link Message} shape but with the real string id.
 * The UI's `Message.id` is still numeric (the mock seam); the AppRoot wiring slice flips it to
 * `string`, at which point `ApiMessage` and `Message` coincide and this alias can be dropped. Keeping
 * it as an `Omit`-based alias means it tracks every other change to `Message` in the meantime.
 */
export type ApiMessage = Omit<Message, "id"> & { id: string };

/** A page of a conversation's feed, oldest-last, with a cursor for the previous (older) page. */
export type MessagePage = { messages: ApiMessage[]; nextBefore?: string };

/** `GET /conversations/{id}/messages`: a page of a conversation's feed (newest last). */
export async function getChannelMessages(
  conversationId: string,
  opts: { before?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (opts.before) params.set("before", opts.before);
  if (opts.limit) params.set("limit", String(opts.limit));
  const query = params.toString();
  const page = await apiGet<MessagePageDto>(
    `/conversations/${conversationId}/messages${query ? `?${query}` : ""}`,
    signal,
  );
  return { messages: page.messages.map(toMessage), nextBefore: page.next_before };
}

/** What changed in a space since a cursor: see `getChanges`. */
export type SpaceChanges = {
  /** The next cursor. */
  now: string;
  /** Changed messages with the conversation each belongs to, oldest first. */
  changes: { conversationId: string; message: ApiMessage }[];
  /** Too much, or too long ago: reload the space rather than apply a list. */
  truncated: boolean;
};

/**
 * `GET /spaces/{id}/changes`: messages created, edited, deleted (tombstones) or reacted to since
 * `since`, in every conversation of the space the caller can see, thread replies included. Without
 * `since`, only the cursor, which is how a client starts counting.
 */
export async function getChanges(spaceId: string, since?: string, signal?: AbortSignal): Promise<SpaceChanges> {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  const dto = await apiGet<{ now: string; messages: MessageDto[]; truncated: boolean }>(
    `/spaces/${spaceId}/changes${query}`,
    signal,
  );
  return {
    now: dto.now,
    changes: dto.messages.map((m) => ({ conversationId: m.conversation_id, message: toMessage(m) })),
    truncated: dto.truncated,
  };
}

/** `POST /conversations/{id}/messages`: post a message (optionally a threaded reply). */
export async function sendMessage(
  conversationId: string,
  body: string,
  opts: { attachments?: string[]; parentMessageId?: string } = {},
): Promise<ApiMessage> {
  const dto = await apiPost<MessageDto>(`/conversations/${conversationId}/messages`, {
    body,
    attachments: opts.attachments ?? [],
    parent_message_id: opts.parentMessageId,
  });
  return toMessage(dto);
}

/** `PATCH /messages/{id}`: edit a message's body and optionally add uploaded files. */
export async function editMessage(messageId: string, body: string, attachments: string[] = []): Promise<ApiMessage> {
  return toMessage(await apiPatch<MessageDto>(`/messages/${messageId}`, { body, attachments }));
}

/** `DELETE /messages/{id}`: soft-delete a message, returning its tombstone. */
export async function deleteMessage(messageId: string): Promise<ApiMessage> {
  return toMessage(await apiDelete<MessageDto>(`/messages/${messageId}`));
}

/** `GET /messages/{id}/replies`: the messages in a thread, oldest first. */
export async function getReplies(messageId: string, signal?: AbortSignal): Promise<ApiMessage[]> {
  const replies = await apiGet<MessageDto[]>(`/messages/${messageId}/replies`, signal);
  return replies.map(toMessage);
}

/** `PUT /messages/{id}/reactions/{emoji}`: add the caller's reaction. */
export async function addReaction(messageId: string, emoji: string): Promise<void> {
  await apiPut<void>(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

/** `DELETE /messages/{id}/reactions/{emoji}`: remove the caller's reaction. */
export async function removeReaction(messageId: string, emoji: string): Promise<void> {
  await apiDelete<void>(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

/** `PUT /conversations/{id}/read`: advance the caller's read cursor to a message. */
export async function setReadCursor(conversationId: string, lastReadMessageId: string): Promise<void> {
  await apiPut<void>(`/conversations/${conversationId}/read`, { last_read_message_id: lastReadMessageId });
}

/** A bookmarked message with where it was said, since it often sits in a space not loaded here. */
export type SavedMessage = {
  message: ApiMessage;
  /** The conversation it was said in. The front `Message` does not carry it, and the label needs it. */
  conversationId: string;
  spaceId: string;
  spaceName: string;
  /** The channel's name; absent for a direct message, which is how the two are told apart. */
  channelName?: string;
};

/**
 * `GET /me/saved`: every message the caller has bookmarked, newest first.
 *
 * The whole account, not the space on screen. The view used to filter the messages held in memory,
 * which meant a bookmark kept its promise only until the conversation moved on or the reader
 * switched space, and surviving both is the point of a bookmark.
 */
export async function getSavedMessages(signal?: AbortSignal): Promise<SavedMessage[]> {
  const rows = await apiGet<(MessageDto & { space_id: string; space_name: string; channel_name?: string })[]>(
    "/me/saved",
    signal,
  );
  return rows.map((row) => ({
    message: toMessage(row),
    conversationId: row.conversation_id,
    spaceId: row.space_id,
    spaceName: row.space_name,
    channelName: row.channel_name,
  }));
}

/** `PUT|DELETE /messages/{id}/save`: bookmark or un-bookmark a message. */
export async function setMessageSaved(messageId: string, saved: boolean): Promise<void> {
  if (saved) await apiPut<void>(`/messages/${messageId}/save`);
  else await apiDelete<void>(`/messages/${messageId}/save`);
}

/**
 * `GET /channels/{id}/pins`: every pinned message of a channel, newest first.
 *
 * Asked for rather than filtered out of what is on screen: a pin is meant to survive the
 * conversation moving on, so the one that matters is usually older than the page in memory, and
 * deriving the panel from the loaded messages hid exactly the pins worth keeping.
 */
export async function getPinnedMessages(channelId: string, signal?: AbortSignal): Promise<ApiMessage[]> {
  const rows = await apiGet<MessageDto[]>(`/channels/${channelId}/pins`, signal);
  return rows.map(toMessage);
}

/** `PUT|DELETE /channels/{channelId}/pins/{messageId}`: pin or unpin a message in a channel. */
export async function setMessagePinned(channelId: string, messageId: string, pinned: boolean): Promise<void> {
  if (pinned) await apiPut<void>(`/channels/${channelId}/pins/${messageId}`);
  else await apiDelete<void>(`/channels/${channelId}/pins/${messageId}`);
}

// --- Mapping helpers ---

function toMessage(dto: MessageDto): ApiMessage {
  const { attachment, attachments, image, images } = splitAttachments(dto.attachments);
  return {
    id: dto.id,
    kind: (dto.kind === "system" ? "system" : "message") as MessageKind,
    author: dto.author_name ?? "",
    authorId: dto.author_id ?? undefined,
    createdAt: dto.created_at,
    body: dto.body,
    // A known event is rendered from its sentence, with the body as its one detail when it has one.
    // A system message with a body and no known event is older free text, shown as written.
    system:
      dto.kind === "system" && isSystemEvent(dto.system_event)
        ? { event: dto.system_event, actor: dto.author_name ?? "", detail: dto.body || undefined }
        : undefined,
    systemIcon: dto.kind === "system" ? iconForSystemEvent(dto.system_event) : undefined,
    attachment,
    attachments,
    image,
    images,
    reactions: dto.reactions.length > 0 ? dto.reactions.map(toReaction) : undefined,
    parentId: dto.parent_message_id,
    replies: dto.reply_count > 0 ? dto.reply_count : undefined,
    replyAuthors: dto.reply_authors?.length ? dto.reply_authors : undefined,
    lastReplyAt: dto.last_reply_at,
    imported: dto.imported || undefined,
    pinned: dto.pinned || undefined,
    pinnedBy: dto.pinned_by,
    edited: dto.edited || undefined,
    editedAt: dto.edited_at,
    deleted: dto.deleted || undefined,
    saved: dto.saved || undefined,
    link: dto.link
      ? {
          url: dto.link.url,
          domain: dto.link.domain,
          title: dto.link.title,
          description: dto.link.description,
          // Only a plain hex colour reaches a style attribute.
          color: dto.link.color && /^#[0-9a-f]{6}$/i.test(dto.link.color) ? dto.link.color : undefined,
          imageUrl: dto.link.image_url,
          imageWidth: dto.link.image_width,
          imageHeight: dto.link.image_height,
        }
      : undefined,
  };
}

function toReaction(dto: ReactionDto): Reaction {
  return { emoji: dto.emoji, count: dto.count, mine: dto.mine || undefined, users: dto.users };
}

/**
 * Keep attachment order while retaining the first-item aliases used by compact legacy views.
 */
function splitAttachments(attachments: AttachmentDto[]): {
  attachment?: MessageAttachment;
  attachments?: MessageAttachment[];
  image?: InlineImage;
  images?: InlineImage[];
} {
  const attachmentsOut: MessageAttachment[] = [];
  const imagesOut: InlineImage[] = [];
  for (const a of attachments) {
    // A file removed from the space keeps its place in the message, without a link: every URL to
    // its bytes answers 404, and an image whose source 404s is a broken frame rather than an
    // absence. What the message carried is still worth saying; what it carried is simply gone.
    if (a.deleted) {
      attachmentsOut.push({
        fileId: a.file_id,
        name: a.name,
        sizeBytes: a.size_bytes,
        kind: attachmentIcon(a.kind),
        deleted: true,
      });
      continue;
    }
    if (a.kind === "image" && a.image_width && a.image_height) {
      imagesOut.push({
        fileId: a.file_id,
        alt: a.alt_text ?? a.name,
        width: a.image_width,
        height: a.image_height,
        // Served by the API, never by the object store: the browser never talks to it directly.
        // `preview` is the original bytes, so opening it in a tab shows full quality.
        src: `/api/v1/files/${a.file_id}/preview`,
        downloadUrl: `/api/v1/files/${a.file_id}/download`,
      });
    } else {
      attachmentsOut.push({
        fileId: a.file_id,
        name: a.name,
        sizeBytes: a.size_bytes,
        kind: attachmentIcon(a.kind),
        url: `/api/v1/files/${a.file_id}/download`,
        previewUrl: `/api/v1/files/${a.file_id}/preview`,
      });
    }
  }
  return {
    attachment: attachmentsOut[0],
    attachments: attachmentsOut.length ? attachmentsOut : undefined,
    image: imagesOut[0],
    images: imagesOut.length ? imagesOut : undefined,
  };
}

/** Map an API import-source string (free text, e.g. "slack") to the front's capitalized enum. */
function toImportSource(source?: string): ImportSource | undefined {
  if (!source) return undefined;
  const known: Record<string, ImportSource> = {
    nextcloud: "Nextcloud",
    slack: "Slack",
    mattermost: "Mattermost",
    teams: "Teams",
    ruchoir: "Ruchoir",
  };
  return known[source.toLowerCase()];
}

/** Map the API presence vocabulary (`active|away|dnd|offline`) to the DS presence dot. */
function toPresence(presence: string): Presence {
  switch (presence) {
    case "active":
      return "online";
    case "dnd":
      return "busy";
    case "away":
      return "away";
    default:
      return "offline";
  }
}

/** Pick a DS icon name for a system message from its event discriminator. */
function iconForSystemEvent(event?: string): string {
  switch (event) {
    case "member_joined":
    case "channel_joined":
      return "user-plus";
    case "member_left":
    case "member_removed":
    case "channel_left":
    case "channel_removed":
      return "user-minus";
    case "channel_renamed":
    case "channel_topic_changed":
    case "channel_topic_cleared":
      return "square-pen";
    case "channel_made_private":
    case "channel_access_changed":
      return "lock";
    case "channel_made_public":
      return "hash";
    case "channel_archived":
    case "channel_unarchived":
      return "archive";
    default:
      return "info";
  }
}

const SYSTEM_EVENTS: SystemEvent[] = [
  "member_joined",
  "member_left",
  "member_removed",
  "channel_joined",
  "channel_left",
  "channel_removed",
  "channel_created",
  "channel_renamed",
  "channel_topic_changed",
  "channel_topic_cleared",
  "channel_made_private",
  "channel_made_public",
  "channel_archived",
  "channel_unarchived",
  "channel_access_changed",
];

/** Whether the API reported an event this client knows a sentence for. */
function isSystemEvent(value: string | undefined): value is SystemEvent {
  return !!value && (SYSTEM_EVENTS as string[]).includes(value);
}

/** Map an attachment kind to the DS file icon the UI expects. */
function attachmentIcon(kind: string): string {
  switch (kind) {
    case "file-text":
    case "file-spreadsheet":
    case "folder":
      return kind;
    default:
      return "file";
  }
}


// --- Notifications ---

type NotificationDto = {
  id: string;
  kind: string;
  /** Absent for a calendar reminder. */
  conversation_id?: string;
  /** Absent for a reminder from a personal calendar. */
  space_id?: string;
  /** The channel's name; absent for a direct message. */
  channel_name?: string;
  space_name: string;
  message_id?: string;
  event_id?: string;
  recurrence_id?: string;
  event_title?: string;
  event_start?: string;
  event_all_day?: boolean;
  event_location?: string;
  calendar_name?: string;
  event_changes?: string[];
  event_my_status?: "needs_action" | "accepted" | "tentative" | "declined";
  actor_id?: string;
  actor_name?: string;
  preview: string;
  created_at: string;
  read: boolean;
};

type NotificationPageDto = {
  notifications: NotificationDto[];
  next_before?: string;
  unread_count: number;
};

/**
 * A notification as this seam returns it.
 *
 * `channelName` and `spaceName` come from the server because a notification routinely arrives from
 * a space the client has not loaded, where it can name nothing on its own: the caller used to fall
 * back to the conversation's identifier, so a notification from anywhere but the space on screen
 * read as a UUID.
 */
/** What a calendar reminder is about: an occurrence of an event. */
export type ReminderInfo = {
  eventId: string;
  recurrenceId?: string;
  title: string;
  /** RFC 3339 in UTC, or `YYYY-MM-DD` for an all-day event. */
  start: string;
  allDay: boolean;
  location?: string;
  calendarName?: string;
  /** For a change: what changed (`time`, `location`). */
  changes?: string[];
  /** For an invitation kind: the reader's answer as it stands. */
  myStatus?: "needs_action" | "accepted" | "tentative" | "declined";
};

export type ApiNotification = {
  id: string;
  kind: "mention" | "broadcast" | "reply" | "dm" | "message" | "calendar_reminder" | "calendar_invitation" | "calendar_update" | "calendar_cancel" | "calendar_declined";
  conversationId: string;
  /** The space it happened in, so the inbox can be shown for the space on screen. */
  spaceId: string;
  /** The channel's name as the server knows it; absent for a direct message. */
  channelName?: string;
  /** The space's name, so a notification can say where it happened. */
  spaceName: string;
  messageId: string;
  actor: string;
  preview: string;
  /** When the triggering message was sent, RFC 3339. */
  createdAt: string;
  read: boolean;
  /** Set for a calendar reminder or an invitation kind, whose conversation, message and (for a
   *  personal calendar) space are empty strings. */
  reminder?: ReminderInfo;
};

/** A page of the notification inbox, newest first, with the caller's total unread count. */
export type NotificationFeed = { notifications: ApiNotification[]; nextBefore?: string; unreadCount: number };

function toApiNotification(dto: NotificationDto): ApiNotification {
  // `broadcast` belongs here: left out, an `@canal` arrived as an ordinary mention and the
  // preference that turns those off could never have been obeyed.
  const kind =
    dto.kind === "mention" ||
    dto.kind === "broadcast" ||
    dto.kind === "reply" ||
    dto.kind === "dm" ||
    dto.kind === "message" ||
    dto.kind.startsWith("calendar_")
      ? (dto.kind as ApiNotification["kind"])
      : "mention";
  return {
    id: dto.id,
    kind,
    conversationId: dto.conversation_id ?? "",
    spaceId: dto.space_id ?? "",
    channelName: dto.channel_name,
    spaceName: dto.space_name,
    messageId: dto.message_id ?? "",
    ...(dto.kind.startsWith("calendar_") && (dto.event_id || dto.event_title)
      ? {
          reminder: {
            // Empty for a cancellation that outlived its event.
            eventId: dto.event_id ?? "",
            recurrenceId: dto.recurrence_id,
            title: dto.event_title ?? "",
            start: dto.event_start ?? dto.created_at,
            allDay: dto.event_all_day === true,
            location: dto.event_location,
            calendarName: dto.calendar_name,
            changes: dto.event_changes,
            myStatus: dto.event_my_status,
          },
        }
      : {}),
    actor: dto.actor_name ?? "",
    preview: dto.preview,
    createdAt: dto.created_at,
    read: dto.read,
  };
}

/** One member's read cursor in a conversation. */
export type ReadCursor = { userId: string; lastReadMessageId?: string };

/**
 * `GET /conversations/{id}/read`: how far each member has read.
 *
 * One cursor per person, not a receipt per message: combined with the order of the messages it
 * answers the same question, which is who has seen a given one.
 */
export async function getReadCursors(conversationId: string, signal?: AbortSignal): Promise<ReadCursor[]> {
  const rows = await apiGet<{ user_id: string; last_read_message_id?: string }[]>(
    `/conversations/${conversationId}/read`,
    signal,
  );
  return rows.map((r) => ({ userId: r.user_id, lastReadMessageId: r.last_read_message_id }));
}

/** `GET /notifications`: the caller's in-app notification inbox. */
export async function getNotifications(
  opts: { unread?: boolean; before?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<NotificationFeed> {
  const params = new URLSearchParams();
  if (opts.unread) params.set("unread", "true");
  if (opts.before) params.set("before", opts.before);
  if (opts.limit) params.set("limit", String(opts.limit));
  const query = params.toString();
  const page = await apiGet<NotificationPageDto>(`/notifications${query ? `?${query}` : ""}`, signal);
  return {
    notifications: page.notifications.map(toApiNotification),
    nextBefore: page.next_before,
    unreadCount: page.unread_count,
  };
}

/** `PUT /notifications/{id}/read`: mark one notification read. */
export async function markNotificationRead(id: string): Promise<void> {
  await apiPut<void>(`/notifications/${id}/read`);
}

/** `PUT /notifications/read`: mark every notification read. */
export async function markAllNotificationsRead(): Promise<void> {
  await apiPut<void>("/notifications/read");
}

// --- Notification delivery (preferences, Web Push) ---

/**
 * The signed-in user's notification settings, as the server keeps them.
 *
 * Held server-side because the server acts on them: a push to a closed browser and the unread
 * digest by email both have to obey a muted channel or quiet hours set on another device.
 */
export type NotificationPreferences = {
  enabled: boolean;
  sound: boolean;
  /** Which kinds reach the person in the app and by push. */
  mentions: boolean;
  channelMentions: boolean;
  replies: boolean;
  directMessages: boolean;
  messages: boolean;
  quietHours: boolean;
  quietFrom: string;
  quietTo: string;
  /** Offset of this device's clock from UTC, in minutes: how the server reads the quiet hours. */
  utcOffsetMinutes: number;
  /** Email what is still unread after a while, when no Ruchoir page is open, and which kinds. */
  email: boolean;
  emailMentions: boolean;
  emailBroadcasts: boolean;
  emailReplies: boolean;
  emailDirectMessages: boolean;
  emailMessages: boolean;
  /** Calendar reminders, in the app and by push, and by mail. */
  calendarReminders: boolean;
  emailCalendarReminders: boolean;
  /** Calendar invitations and what follows them, in the app and by push, and by mail. */
  calendarInvitations: boolean;
  emailCalendarInvitations: boolean;
};

/** Each field and its name on the wire, so the two directions of the mapping cannot drift. */
const NOTIFICATION_FIELDS: [keyof NotificationPreferences, string][] = [
  ["enabled", "enabled"],
  ["sound", "sound"],
  ["mentions", "mentions"],
  ["channelMentions", "channel_mentions"],
  ["replies", "replies"],
  ["directMessages", "direct_messages"],
  ["messages", "messages"],
  ["quietHours", "quiet_hours"],
  ["quietFrom", "quiet_from"],
  ["quietTo", "quiet_to"],
  ["utcOffsetMinutes", "utc_offset_minutes"],
  ["email", "email"],
  ["emailMentions", "email_mentions"],
  ["emailBroadcasts", "email_broadcasts"],
  ["emailReplies", "email_replies"],
  ["emailDirectMessages", "email_direct_messages"],
  ["emailMessages", "email_messages"],
  ["calendarReminders", "calendar_reminders"],
  ["emailCalendarReminders", "email_calendar_reminders"],
  ["calendarInvitations", "calendar_invitations"],
  ["emailCalendarInvitations", "email_calendar_invitations"],
];

/** `GET /me/notification-preferences`. */
export async function getNotificationPreferences(signal?: AbortSignal): Promise<NotificationPreferences> {
  const dto = await apiGet<Record<string, unknown>>("/me/notification-preferences", signal);
  return Object.fromEntries(
    NOTIFICATION_FIELDS.map(([field, wire]) => [field, dto[wire]]),
  ) as NotificationPreferences;
}

/** `PUT /me/notification-preferences`: replace them whole. */
export async function saveNotificationPreferences(prefs: NotificationPreferences): Promise<void> {
  await apiPut<void>(
    "/me/notification-preferences",
    Object.fromEntries(NOTIFICATION_FIELDS.map(([field, wire]) => [wire, prefs[field]])),
  );
}

/** `PUT /conversations/{id}/notification-preference`: how much one channel or DM notifies the caller. */
export async function saveConversationNotify(conversationId: string, notify: ConversationNotify): Promise<void> {
  await apiPut<void>(`/conversations/${conversationId}/notification-preference`, notify);
}

/** Whether the instance sends Web Push, and the key a browser subscribes against. */
export type PushConfig = { available: boolean; publicKey?: string };

/** `GET /push/config`. */
export async function getPushConfig(signal?: AbortSignal): Promise<PushConfig> {
  const dto = await apiGet<{ available: boolean; public_key?: string }>("/push/config", signal);
  return { available: dto.available, publicKey: dto.public_key };
}

/** `PUT /push/subscription`: this browser's subscription, as `PushSubscription.toJSON()` gives it. */
export async function savePushSubscription(subscription: PushSubscriptionJSON): Promise<void> {
  await apiPut<void>("/push/subscription", {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys?.p256dh ?? "", auth: subscription.keys?.auth ?? "" },
  });
}

/**
 * `POST /push/test`: a real push to each of the caller's subscribed browsers, through the whole
 * chain (server, push service, service worker), so it proves what matters when the app is closed.
 */
export async function sendTestPush(): Promise<{ subscriptions: number; delivered: number }> {
  return apiPost<{ subscriptions: number; delivered: number }>("/push/test");
}

/** `DELETE /push/subscription`: forget this browser's subscription. */
export async function forgetPushSubscription(endpoint: string): Promise<void> {
  await apiRequest<void>("DELETE", "/push/subscription", { json: { endpoint } });
}

// --- Search ---

type FileHitDto = { id: string; name: string; kind: string };
type SearchResultsDto = { messages: MessageDto[]; files: FileHitDto[] };

/** A file matched by search: enough to render a result row and open it. */
export type FileHit = { id: string; name: string; kind: string };
/** A message matched by search, carrying its conversation id so a click can navigate to it. */
export type SearchMessage = ApiMessage & { conversationId: string };
/** Combined search results: matching messages and file names the caller can see. */
export type SearchHits = { messages: SearchMessage[]; files: FileHit[] };

/** `GET /search`: full-text search over the space's messages and file names. */
export async function search(spaceId: string, query: string, signal?: AbortSignal): Promise<SearchHits> {
  const params = new URLSearchParams({ q: query, space_id: spaceId, type: "all" });
  const results = await apiGet<SearchResultsDto>(`/search?${params.toString()}`, signal);
  return {
    messages: results.messages.map((m) => ({ ...toMessage(m), conversationId: m.conversation_id })),
    files: results.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
  };
}

// --- Files ---

type FileDto = {
  id: string;
  space_id: string;
  name: string;
  kind: string;
  is_folder: boolean;
  parent_folder_id?: string;
  size_bytes: number;
  owner_id?: string;
  owner_name?: string;
  mime_type?: string;
  version_id?: string;
  version_no?: number;
  has_thumbnail: boolean;
  image_width?: number;
  image_height?: number;
  imported: boolean;
  imported_source?: string;
  created_at: string;
  updated_at: string;
  modified_by_id?: string;
  modified_by_name?: string;
  child_count?: number;
  starred?: boolean;
  editors?: { id: string; name: string }[];
};

type FolderListingDto = {
  folder_id?: string;
  breadcrumb: { id: string; name: string }[];
  entries: FileDto[];
};

/** A resolved folder view: its id (absent at root), breadcrumb trail and entries as UI files. */
export type FolderListing = {
  folderId?: string;
  breadcrumb: { id: string; name: string }[];
  entries: SpaceFile[];
};

function toSpaceFileKind(kind: string, isFolder: boolean): SpaceFile["kind"] {
  if (isFolder || kind === "folder") return "folder";
  if (kind === "file-text" || kind === "file-spreadsheet" || kind === "image") return kind;
  return "file";
}

function toSpaceFile(dto: FileDto): SpaceFile {
  return {
    id: dto.id,
    name: dto.name,
    kind: toSpaceFileKind(dto.kind, dto.is_folder),
    sizeBytes: dto.is_folder ? 0 : dto.size_bytes,
    by: dto.owner_name ?? "",
    updatedAt: dto.updated_at,
    // The connector a migrated file came from; native files (and unknown connectors) read as Ruchoir.
    source: toImportSource(dto.imported_source) ?? "Ruchoir",
    version: dto.version_no != null ? `v${dto.version_no}` : "",
    imported: dto.imported,
    // Generated and stored server-side at upload; served by the API, never by the object store.
    thumbnailUrl: dto.has_thumbnail ? `/api/v1/files/${dto.id}/thumbnail` : undefined,
    parentFolderId: dto.parent_folder_id,
    editors: dto.editors ?? [],
    ownerId: dto.owner_id,
    modifiedBy: dto.modified_by_name,
    childCount: dto.child_count,
    createdAt: dto.created_at,
    mimeType: dto.mime_type,
    versionNo: dto.version_no,
    starred: dto.starred === true,
  };
}

/** `GET /spaces/{id}/files`: the entries of a folder (or the space root when `folderId` is absent). */
export async function getFolder(
  spaceId: string,
  folderId?: string,
  signal?: AbortSignal,
): Promise<FolderListing> {
  const query = folderId ? `?folder=${folderId}` : "";
  const listing = await apiGet<FolderListingDto>(`/spaces/${spaceId}/files${query}`, signal);
  return {
    folderId: listing.folder_id,
    breadcrumb: listing.breadcrumb,
    entries: listing.entries.map(toSpaceFile),
  };
}

/**
 * `GET /conversations/{id}/files`: what was shared in one conversation.
 *
 * Not the space tree: the channel's file panel asked "what was shared here" and was handed
 * everything anyone had uploaded anywhere in the space. A file is in this list because a message
 * here carries it. Newest use first.
 */
export async function getConversationFiles(conversationId: string, signal?: AbortSignal): Promise<SpaceFile[]> {
  const rows = await apiGet<FileDto[]>(`/conversations/${conversationId}/files`, signal);
  return rows.map(toSpaceFile);
}

/** `POST /spaces/{id}/folders`: create a folder (at the root, or inside `parentId`). */
export async function createFolder(spaceId: string, name: string, parentId?: string): Promise<SpaceFile> {
  const dto = await apiPost<FileDto>(`/spaces/${spaceId}/folders`, {
    name,
    parent_folder_id: parentId,
  });
  return toSpaceFile(dto);
}

/** `POST /spaces/{id}/files`: upload a file (multipart) into the root or a folder. */
export async function uploadFile(spaceId: string, file: File, parentId?: string): Promise<SpaceFile> {
  const form = new FormData();
  form.append("file", file);
  // `folder_id`, not `parent_folder_id`: the JSON endpoints use the latter, the multipart
  // upload uses the former, and sending the wrong one put every file in a folder at the root.
  if (parentId) form.append("folder_id", parentId);
  // Multipart: let the browser set the boundary, so this call does not go through the JSON client.
  const res = await fetch(`/api/v1/spaces/${spaceId}/files`, {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, await res.text().catch(() => null));
  return toSpaceFile((await res.json()) as FileDto);
}

/**
 * `POST /files/{id}/versions`: replace a file's contents, keeping its name, place and history.
 *
 * The version becomes the one served by download and preview, and the previous bytes stay stored.
 * Reading the history back needs a route that does not exist yet, so what this offers today is
 * "here is a newer copy of the same document" rather than a version browser.
 */
export async function uploadFileVersion(fileId: string, file: File): Promise<SpaceFile> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/v1/files/${fileId}/versions`, {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, await res.text().catch(() => null));
  return toSpaceFile((await res.json()) as FileDto);
}

// --- Trash and versions ---

type TrashEntryDto = {
  file: FileDto;
  deleted_at: string;
  deleted_by_id?: string;
  deleted_by_name?: string;
  original_folder_id?: string;
  original_folder_name?: string;
  original_folder_present: boolean;
  can_manage: boolean;
};

/** One entry of a space's trash: what was removed, when, by whom, and from where. */
export type TrashEntry = {
  file: SpaceFile;
  deletedAt: string;
  deletedBy?: string;
  /** The folder it was in (absent: the space root), and whether it is still there. */
  originalFolderId?: string;
  originalFolderName?: string;
  originalFolderPresent: boolean;
  /** Whether this person may restore it or erase it. */
  canManage: boolean;
};

/** `GET /spaces/{id}/trash`: the space's trash, latest removal first. */
export async function getTrash(spaceId: string, signal?: AbortSignal): Promise<TrashEntry[]> {
  const rows = await apiGet<TrashEntryDto[]>(`/spaces/${spaceId}/trash`, signal);
  return rows.map((r) => ({
    file: toSpaceFile(r.file),
    deletedAt: r.deleted_at,
    deletedBy: r.deleted_by_name,
    originalFolderId: r.original_folder_id,
    originalFolderName: r.original_folder_name,
    originalFolderPresent: r.original_folder_present,
    canManage: r.can_manage,
  }));
}

/** `POST /files/{id}/restore`: bring a trash entry back (at the root when its folder is gone). */
export async function restoreFile(fileId: string): Promise<{ file: SpaceFile; restoredToRoot: boolean }> {
  const dto = await apiPost<{ file: FileDto; restored_to_root: boolean }>(`/files/${fileId}/restore`, {});
  return { file: toSpaceFile(dto.file), restoredToRoot: dto.restored_to_root };
}

/** `DELETE /files/{id}/trash`: erase a trash entry for good. */
export async function eraseFile(fileId: string): Promise<void> {
  await apiDelete<void>(`/files/${fileId}/trash`);
}

/** `DELETE /spaces/{id}/trash`: erase every trash entry this person may manage; how many. */
export async function emptyTrash(spaceId: string): Promise<number> {
  const dto = await apiDelete<{ erased: number }>(`/spaces/${spaceId}/trash`);
  return dto?.erased ?? 0;
}

type VersionDto = {
  id: string;
  version_no: number;
  size_bytes: number;
  mime_type: string;
  created_at: string;
  created_by_id?: string;
  created_by_name?: string;
  current: boolean;
};

/** One version of a file. */
export type FileVersion = {
  id: string;
  number: number;
  sizeBytes: number;
  createdAt: string;
  createdBy?: string;
  /** The version the file serves now. */
  current: boolean;
};

/** `GET /files/{id}/versions`: a file's versions, newest first. */
export async function getVersions(fileId: string, signal?: AbortSignal): Promise<FileVersion[]> {
  const rows = await apiGet<VersionDto[]>(`/files/${fileId}/versions`, signal);
  return rows.map((v) => ({
    id: v.id,
    number: v.version_no,
    sizeBytes: v.size_bytes,
    createdAt: v.created_at,
    createdBy: v.created_by_name,
    current: v.current,
  }));
}

/** The same-origin URL that downloads one version's bytes. */
export function versionDownloadUrl(fileId: string, versionId: string): string {
  return `/api/v1/files/${fileId}/versions/${versionId}/download`;
}

/** `POST /files/{id}/versions/{vid}/restore`: an old version comes back as the newest. */
export async function restoreVersion(fileId: string, versionId: string): Promise<SpaceFile> {
  return toSpaceFile(await apiPost<FileDto>(`/files/${fileId}/versions/${versionId}/restore`, {}));
}

// --- Views beyond a folder ---

type ViewEntryDto = {
  file: FileDto;
  path: { id: string; name: string }[];
  shared_by_name?: string;
  shared_in_kind?: "channel" | "dm";
  shared_in_name?: string;
  shared_at?: string;
};

/** One entry of a view (recent, favourites, shared with me, search): the file and where it lives. */
export type ViewEntry = {
  file: SpaceFile;
  /** Its folders from the space root down (empty at the root). */
  path: { id: string; name: string }[];
  sharedBy?: string;
  sharedIn?: { kind: "channel" | "dm"; name?: string };
  sharedAt?: string;
};

function toViewEntry(dto: ViewEntryDto): ViewEntry {
  return {
    file: toSpaceFile(dto.file),
    path: dto.path ?? [],
    sharedBy: dto.shared_by_name,
    sharedIn: dto.shared_in_kind ? { kind: dto.shared_in_kind, name: dto.shared_in_name } : undefined,
    sharedAt: dto.shared_at,
  };
}

export type FilesView = "recent" | "starred" | "shared";

/** `GET /spaces/{id}/files/{recent|starred|shared}`. */
export async function getFilesView(spaceId: string, view: FilesView, signal?: AbortSignal): Promise<ViewEntry[]> {
  return (await apiGet<ViewEntryDto[]>(`/spaces/${spaceId}/files/${view}`, signal)).map(toViewEntry);
}

/** `GET /spaces/{id}/files/search?q=`: the whole space's files and folders whose name contains `q`. */
export async function searchFiles(spaceId: string, q: string, signal?: AbortSignal): Promise<ViewEntry[]> {
  return (await apiGet<ViewEntryDto[]>(`/spaces/${spaceId}/files/search?q=${encodeURIComponent(q)}`, signal)).map(toViewEntry);
}

/** `PUT|DELETE /files/{id}/star`: keep among one's favourites, or not. */
export async function setStarred(fileId: string, starred: boolean): Promise<void> {
  if (starred) await apiPut<void>(`/files/${fileId}/star`, {});
  else await apiDelete<void>(`/files/${fileId}/star`);
}

// --- Public links ---

type LinkDto = {
  id: string;
  token: string;
  created_at: string;
  created_by_name?: string;
  expires_at?: string;
  expired: boolean;
  has_password: boolean;
  download_count: number;
};

/** A file's public link, as those who manage the file see it. */
export type FileLink = {
  id: string;
  token: string;
  /** The address to hand out. */
  url: string;
  createdAt: string;
  createdBy?: string;
  expiresAt?: string;
  expired: boolean;
  hasPassword: boolean;
  downloads: number;
};

/** The public address of a link, on this instance. */
export function publicLinkUrl(token: string): string {
  return `${window.location.origin}/s/?t=${encodeURIComponent(token)}`;
}

function toLink(dto: LinkDto): FileLink {
  return {
    id: dto.id,
    token: dto.token,
    url: publicLinkUrl(dto.token),
    createdAt: dto.created_at,
    createdBy: dto.created_by_name,
    expiresAt: dto.expires_at,
    expired: dto.expired,
    hasPassword: dto.has_password,
    downloads: dto.download_count,
  };
}

/** `GET /files/{id}/links`: the file's live public links. */
export async function listLinks(fileId: string, signal?: AbortSignal): Promise<FileLink[]> {
  return (await apiGet<LinkDto[]>(`/files/${fileId}/links`, signal)).map(toLink);
}

/** `POST /files/{id}/links`: a new public link, ending at `expiresAt` and asking for `password` when given. */
export async function createLink(fileId: string, opts: { expiresAt?: string; password?: string }): Promise<FileLink> {
  return toLink(await apiPost<LinkDto>(`/files/${fileId}/links`, { expires_at: opts.expiresAt, password: opts.password }));
}

/** `DELETE /files/{id}/links/{linkId}`: revoke a public link. */
export async function revokeLink(fileId: string, linkId: string): Promise<void> {
  await apiDelete<void>(`/files/${fileId}/links/${linkId}`);
}

type PublicLinkDto = {
  needs_password: boolean;
  name?: string;
  size_bytes?: number;
  mime_type?: string;
  shared_by?: string;
  expires_at?: string;
  has_thumbnail?: boolean;
  preview?: PublicPreview;
};

/** How a shared file's page can show it. */
export type PublicPreview = "image" | "pdf" | "document" | "video" | "audio" | "text";

/** What a public link shows: only that it asks for a password, until it has been given. */
export type PublicLink =
  | { needsPassword: true }
  | {
      needsPassword: false;
      name: string;
      sizeBytes: number;
      mimeType?: string;
      sharedBy?: string;
      expiresAt?: string;
      hasThumbnail: boolean;
      preview?: PublicPreview;
    };

function toPublicLink(dto: PublicLinkDto): PublicLink {
  if (dto.needs_password) return { needsPassword: true };
  return {
    needsPassword: false,
    name: dto.name ?? "",
    sizeBytes: dto.size_bytes ?? 0,
    mimeType: dto.mime_type,
    sharedBy: dto.shared_by,
    expiresAt: dto.expires_at,
    hasThumbnail: dto.has_thumbnail === true,
    preview: dto.preview,
  };
}

/** `GET /public/links/{token}`: no session needed. A `404` means the link is no longer valid. */
export async function getPublicLink(token: string, grant?: string): Promise<PublicLink> {
  const query = grant ? `?grant=${encodeURIComponent(grant)}` : "";
  return toPublicLink(await apiGet<PublicLinkDto>(`/public/links/${encodeURIComponent(token)}${query}`));
}

/** `POST /public/links/{token}/unlock`: the password; the grant it earns, and the file. A `403` is the wrong password. */
export async function unlockLink(token: string, password: string): Promise<{ grant: string; link: PublicLink }> {
  const dto = await apiPost<{ grant: string; link: PublicLinkDto }>(`/public/links/${encodeURIComponent(token)}/unlock`, { password });
  return { grant: dto.grant, link: toPublicLink(dto.link) };
}

/** The address that downloads a shared file (with the grant a password earned, if any). */
export function publicDownloadUrl(token: string, grant?: string): string {
  return `/api/v1/public/links/${encodeURIComponent(token)}/download${grant ? `?grant=${encodeURIComponent(grant)}` : ""}`;
}

/** The address of a shared file's bytes, inline (an image, a PDF, a video, a sound, a text). */
export function publicPreviewUrl(token: string, grant?: string): string {
  return `/api/v1/public/links/${encodeURIComponent(token)}/preview${grant ? `?grant=${encodeURIComponent(grant)}` : ""}`;
}

/** The address of a shared office document as a PDF. */
export function publicDocumentUrl(token: string, grant?: string): string {
  return `/api/v1/public/links/${encodeURIComponent(token)}/document${grant ? `?grant=${encodeURIComponent(grant)}` : ""}`;
}

/** The address of a shared office document's first page, as a picture. */
export function publicPageUrl(token: string, grant?: string): string {
  return `/api/v1/public/links/${encodeURIComponent(token)}/page${grant ? `?grant=${encodeURIComponent(grant)}` : ""}`;
}

/** The address of a shared image's thumbnail. */
export function publicThumbnailUrl(token: string, grant?: string): string {
  return `/api/v1/public/links/${encodeURIComponent(token)}/thumbnail${grant ? `?grant=${encodeURIComponent(grant)}` : ""}`;
}

/** A sending in flight: its result, and the way to stop it. */
export type UploadRequest = { done: Promise<SpaceFile>; abort: () => void };

/**
 * Send a file with its progress reported, as a new file in a folder or as a new version of an
 * existing one (`replaceFileId`).
 *
 * Through `XMLHttpRequest` rather than `fetch`: only the former reports how much of a request body
 * has gone, which is what a progress bar is made of. Same-origin, so the session cookie goes along
 * as with every other call. A refusal rejects with an {@link ApiError} carrying its status (413 too
 * large, 403 not allowed); a dropped connection with status 0; an abort with an `AbortError`.
 */
export function sendFile(
  target: { spaceId: string; folderId?: string; name: string; replaceFileId?: string },
  file: File,
  onProgress: (loaded: number) => void,
): UploadRequest {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  form.append("file", file, target.name);
  let url: string;
  if (target.replaceFileId) {
    url = `/api/v1/files/${target.replaceFileId}/versions`;
  } else {
    url = `/api/v1/spaces/${target.spaceId}/files`;
    form.append("name", target.name);
    // `folder_id`, as `uploadFile` explains.
    if (target.folderId) form.append("folder_id", target.folderId);
  }
  const done = new Promise<SpaceFile>((resolve, reject) => {
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(toSpaceFile(JSON.parse(xhr.responseText) as FileDto));
        } catch {
          reject(new ApiError(xhr.status, "unreadable answer", null));
        }
      } else {
        reject(new ApiError(xhr.status, `HTTP ${xhr.status}`, xhr.responseText));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", null));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
  });
  xhr.open("POST", url);
  xhr.withCredentials = true;
  xhr.send(form);
  return { done, abort: () => xhr.abort() };
}

/**
 * `PATCH /files/{id}`: rename an entry, or move it into another folder.
 *
 * `parentFolderId` of `null` means the space's root, which the API takes as an explicit flag rather
 * than an absent field: leaving it out means "do not move", and the two have to be told apart.
 * Refusals are the server's to make (a folder cannot be moved into itself or into its own
 * descendant), so nothing is checked twice here.
 */
export async function updateFile(
  fileId: string,
  patch: { name?: string; parentFolderId?: string | null },
): Promise<SpaceFile> {
  const dto = await apiPatch<FileDto>(`/files/${fileId}`, {
    name: patch.name,
    parent_folder_id: patch.parentFolderId ?? undefined,
    move_to_root: patch.parentFolderId === null ? true : undefined,
  });
  return toSpaceFile(dto);
}

/**
 * `DELETE /files/{id}`: remove a file, or a folder and everything under it.
 *
 * The API has always answered this; nothing in the interface ever called it, so a file could be
 * put in a space and never taken out again. The removal is soft server-side, which is why it comes
 * back as a plain success and the caller simply reloads the folder.
 *
 * Allowed for whoever owns the file and for a space administrator, so an ordinary member can undo
 * their own upload. A 403 means neither, and is worth telling the user apart from a failure.
 */
export async function deleteFile(fileId: string): Promise<void> {
  await apiDelete<void>(`/files/${fileId}`);
}

/** The same-origin URL that streams a file's bytes (the API proxies the object store). */
export function fileDownloadUrl(fileId: string): string {
  return `/api/v1/files/${fileId}/download`;
}

/**
 * The same-origin URL of an office document converted to PDF. The version stamp is part of the
 * address so the browser's private copy is never taken for a newer version's.
 */
export function fileDocumentUrl(fileId: string, stamp: string): string {
  return `/api/v1/files/${fileId}/document?v=${encodeURIComponent(stamp)}`;
}

/** The same-origin URL for a file's inline preview bytes. */
export function filePreviewUrl(fileId: string): string {
  return `/api/v1/files/${fileId}/preview`;
}

// --- Live office editing ---

type OfficeSessionDto = {
  file: FileDto;
  url: string;
  access_token: string;
  access_token_ttl: number;
  mode: OfficeMode;
  config: string;
  member_name: string;
};

/**
 * `POST /files/{id}/office`: open a file in the office editor.
 *
 * The API decides the mode from the member's rights and the format: `edit`, `view`, or `convert`
 * when asked to turn a legacy format into an editable copy.
 */
export async function openOfficeSession(
  fileId: string,
  opts: { theme: "light" | "dark"; accent?: string; mode?: "convert"; mobile?: boolean },
): Promise<OfficeSession> {
  const dto = await apiPost<OfficeSessionDto>(`/files/${fileId}/office`, {
    locale: currentLocale(),
    theme: opts.theme,
    accent: opts.accent,
    mode: opts.mode,
    mobile: opts.mobile,
  });
  return {
    file: toSpaceFile(dto.file),
    spaceId: dto.file.space_id,
    url: dto.url,
    accessToken: dto.access_token,
    accessTokenTtl: dto.access_token_ttl,
    mode: dto.mode,
    config: dto.config,
    memberName: dto.member_name,
  };
}

/** `POST /files/office`: a blank document, in the interface's language. */
export async function createBlankDocument(
  spaceId: string,
  kind: BlankKind,
  name: string,
  folderId?: string,
): Promise<SpaceFile> {
  const dto = await apiPost<FileDto>("/files/office", {
    space_id: spaceId,
    folder_id: folderId,
    kind,
    name,
    locale: currentLocale(),
  });
  return toSpaceFile(dto);
}

/** `POST /files/{id}/office/heartbeat`: this tab is still editing the file. */
export async function officeHeartbeat(fileId: string, tab: string): Promise<void> {
  await apiPost<void>(`/files/${fileId}/office/heartbeat?tab=${encodeURIComponent(tab)}`);
}

/**
 * `DELETE /files/{id}/office/heartbeat`: this page stopped editing.
 *
 * `keepalive`, because it is sent as the page goes away (a closed tab) and must outlive it.
 */
export function endOfficeHeartbeat(fileId: string, tab: string): Promise<void> {
  return fetch(`/api/v1/files/${fileId}/office/heartbeat?tab=${encodeURIComponent(tab)}`, {
    method: "DELETE",
    credentials: "same-origin",
    keepalive: true,
  }).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * `GET /files/{id}/office/converted`: the copy this member's conversion of the file produced, or
 * `null` while the engine has not written it yet.
 */
export async function getConvertedCopy(fileId: string): Promise<SpaceFile | null> {
  const dto = await apiGet<FileDto | undefined>(`/files/${fileId}/office/converted`);
  return dto ? toSpaceFile(dto) : null;
}

/** What the editor can do with a file of this name on this instance. */
export function officeActionFor(
  name: string,
  caps: OfficeCapabilities | null,
): "edit" | "convert" | "view" | null {
  if (!caps?.enabled) return null;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (!ext) return null;
  if (caps.edit.includes(ext)) return "edit";
  if (caps.convert.includes(ext)) return "convert";
  if (caps.view.includes(ext)) return "view";
  return null;
}

// --- Realtime (WebSocket) ---

/** A decoded server-to-client realtime frame. `payload` shape depends on `type`. */
type RealtimeEnvelope = { v: number; type: string; conversation_id?: string; payload: unknown };

/** A reaction delta carried by a `reaction.added` / `reaction.removed` event. */
export type RealtimeReaction = { messageId: string; emoji: string; userId: string; added: boolean };

/**
 * A channel's shared facts as pushed by `channel.created` / `channel.updated`. It carries no
 * per-caller state (favourite, membership, unread): the receiving client keeps its own.
 */
export type RealtimeChannel = {
  id: string;
  spaceId: string;
  name: string;
  type: ChannelType;
  topic?: string;
};

/**
 * Someone who just joined a space, pushed live. Same shape as a {@link Member} plus the space it
 * happened in, so the app can ignore an arrival in a space it does not currently hold.
 */
export type RealtimeMember = Member & { spaceId: string };

/**
 * A member's identity after a profile change, pushed live. No space: a profile is the same in every
 * one of them, and no role either, since a profile edit cannot change it.
 */
export type MemberIdentity = Omit<Member, "role">;

/**
 * A space's shared identity after a change, pushed live. Carries no counters and no role: those are
 * per-caller and are never broadcast, so a recipient keeps the ones it already holds.
 */
export type SpaceIdentity = { id: string; name: string; slug: string; iconUrl?: string; defaultChannelId?: string };

/** Handlers the app wires to live events. All optional; unhandled event types are ignored. */
export type RealtimeHandlers = {
  /**
   * The connection came back after being lost. Whatever was pushed in between is gone for good (the
   * transport does not replay), so the caller re-reads what it has on screen.
   */
  onReconnect?: () => void;
  onMessageCreated?: (conversationId: string, message: ApiMessage) => void;
  onMessageUpdated?: (conversationId: string, message: ApiMessage) => void;
  onMessageDeleted?: (conversationId: string, message: ApiMessage) => void;
  onReaction?: (conversationId: string, reaction: RealtimeReaction) => void;
  onPinned?: (conversationId: string, messageId: string, pinned: boolean) => void;
  /** A channel was created in a space the user belongs to. */
  onChannelCreated?: (channel: RealtimeChannel) => void;
  /** A channel was renamed, re-topiced, archived, restored, or changed visibility. */
  onChannelUpdated?: (channel: RealtimeChannel) => void;
  /** Someone joined a space the user belongs to. */
  onMemberJoined?: (member: RealtimeMember) => void;
  /** Someone left a space the user belongs to: the roster on screen has to lose them. */
  onMemberLeft?: (spaceId: string, userId: string) => void;
  /**
   * A member's role in a space changed. Also fires for the recipient's own membership, which is how
   * a space they have just been handed (or stepped down from) gains or loses its controls.
   */
  onMemberRoleChanged?: (spaceId: string, userId: string, role: string) => void;
  /** Someone the user shares a space with changed their display name, title or avatar. */
  onMemberUpdated?: (member: MemberIdentity) => void;
  /** A space the user belongs to was renamed, or had its icon replaced or removed. */
  onSpaceUpdated?: (space: SpaceIdentity) => void;
  /** A space's administrators put its channels in a new order: re-read that space's list. */
  onChannelsReordered?: (spaceId: string) => void;
  /**
   * A space stopped being the user's. The reason is what the sentence is drawn from: `left` (from
   * here or another tab, so they already know), `deleted` (its owner ended it), `removed` (somebody
   * took them out of it, which they have to be told or a space vanishes from under them).
   */
  onSpaceRemoved?: (spaceId: string, reason: "left" | "deleted" | "removed") => void;
  /** A channel was deleted, with its history: it leaves the sidebar and the open conversation. */
  onChannelDeleted?: (spaceId: string, channelId: string) => void;
  onPresence?: (userId: string, presence: Presence) => void;
  onNotification?: (notification: ApiNotification) => void;
  onTyping?: (conversationId: string, userId: string) => void;
  /** Someone's read cursor moved in a conversation the recipient belongs to. */
  onReadCursor?: (conversationId: string, userId: string, lastReadMessageId: string) => void;
  /** Files were removed from a space: anything showing them has to stop offering them. */
  onFilesDeleted?: (spaceId: string, fileIds: string[]) => void;
  /** A file gained a version, or the server created one (a blank document, a converted copy). */
  onFilesUpdated?: (spaceId: string, file: SpaceFile, conversationId?: string) => void;
  /** Who is editing a file in the office editor changed. */
  onFilesEditing?: (spaceId: string, fileId: string, editors: FileEditor[]) => void;
  /** A calendar, its settings or its events changed: whatever shows it reloads. */
  onCalendarChanged?: (calendarId: string) => void;
};

/** A live realtime connection: close it on teardown, and signal typing over it. */
export type RealtimeConnection = { close: () => void; sendTyping: (conversationId: string) => void };

/** Every event the server names. Needed by name because `EventSource` only routes named events. */
const REALTIME_EVENTS = [
  "message.created",
  "message.updated",
  "message.deleted",
  "message.pinned",
  "message.unpinned",
  "message.saved",
  "message.unsaved",
  "reaction.added",
  "reaction.removed",
  "channel.created",
  "channel.updated",
  "channel.deleted",
  "member.joined",
  "member.left",
  "member.role_changed",
  "member.updated",
  "space.updated",
  "space.removed",
  "channels.reordered",
  "presence",
  "notification.created",
  "typing",
  "read.updated",
  "files.deleted",
  "files.updated",
  "files.editing",
  "calendar.changed",
] as const;

/** How many failed WebSocket attempts, none of which ever opened, before falling back to SSE. */
const WS_ATTEMPTS_BEFORE_SSE = 2;

/**
 * Open the realtime channel and dispatch decoded events to `handlers`.
 *
 * A WebSocket first: it carries both directions, so typing and the keep-alive travel on the same
 * connection. It authenticates from the same-origin session cookie on the upgrade (no token) and
 * reconnects with a capped backoff after an unexpected close.
 *
 * **Server-sent events when that never opens.** Some corporate proxies pass ordinary HTTP and drop
 * the upgrade, and Ruchoir is aimed squarely at organisations that sit behind such things: the
 * fallback exists in the API and was, until now, offered to nobody. It is one-way, so typing goes
 * over `POST /realtime/typing` instead, and presence is kept by a server-side timer rather than by
 * pings. The switch is made only after the socket has failed without ever opening: a connection
 * that opens and later drops is a network blip, and downgrading on one of those would leave a
 * client on the weaker transport for the rest of its session.
 *
 * All mutations still go through REST either way; this only receives.
 */
export function connectRealtime(handlers: RealtimeHandlers): RealtimeConnection {
  let socket: WebSocket | null = null;
  let events: EventSource | null = null;
  let closed = false;
  let reconnectDelay = 1000;
  /** Whether a connection has been up before, which makes the next one a reconnection. */
  let everOpened = false;
  const opened = () => {
    if (everOpened) handlers.onReconnect?.();
    everOpened = true;
  };
  let failedAttempts = 0;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const url = () => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}/api/v1/realtime/ws`;
  };

  const dispatch = (env: RealtimeEnvelope) => {
    const conv = env.conversation_id ?? "";
    const payload = env.payload as Record<string, unknown>;
    switch (env.type) {
      case "message.created":
        handlers.onMessageCreated?.(conv, toMessage(payload as unknown as MessageDto));
        break;
      case "message.updated":
        handlers.onMessageUpdated?.(conv, toMessage(payload as unknown as MessageDto));
        break;
      case "message.deleted":
        handlers.onMessageDeleted?.(conv, toMessage(payload as unknown as MessageDto));
        break;
      case "reaction.added":
      case "reaction.removed":
        handlers.onReaction?.(conv, {
          messageId: String(payload.message_id),
          emoji: String(payload.emoji),
          userId: String(payload.user_id),
          added: env.type === "reaction.added",
        });
        break;
      case "message.pinned":
      case "message.unpinned":
        handlers.onPinned?.(conv, String(payload.message_id), env.type === "message.pinned");
        break;
      case "channel.created":
      case "channel.updated": {
        const channel: RealtimeChannel = {
          id: String(payload.id),
          spaceId: String(payload.space_id),
          name: String(payload.name),
          type: (["public", "private", "archived"].includes(String(payload.type))
            ? String(payload.type)
            : "public") as ChannelType,
          topic: payload.topic === undefined ? undefined : String(payload.topic),
        };
        if (env.type === "channel.created") handlers.onChannelCreated?.(channel);
        else handlers.onChannelUpdated?.(channel);
        break;
      }
      case "member.joined": {
        const member = payload.member as MemberDto;
        handlers.onMemberJoined?.({
          spaceId: String(payload.space_id),
          userId: member.user_id,
          name: member.display_name,
          role: member.role,
          title: member.title,
          bot: member.is_bot,
          avatarUrl: member.avatar_url,
        });
        break;
      }
      case "member.left":
        handlers.onMemberLeft?.(String(payload.space_id), String(payload.user_id));
        break;
      case "channel.deleted":
        handlers.onChannelDeleted?.(String(payload.space_id), String(payload.channel_id));
        break;
      case "member.role_changed":
        handlers.onMemberRoleChanged?.(
          String(payload.space_id),
          String(payload.user_id),
          String(payload.role),
        );
        break;
      case "space.removed": {
        const reason = String(payload.reason);
        handlers.onSpaceRemoved?.(
          String(payload.space_id),
          reason === "deleted" || reason === "removed" ? reason : "left",
        );
        break;
      }
      case "channels.reordered":
        handlers.onChannelsReordered?.(String(payload.space_id));
        break;
      case "space.updated": {
        handlers.onSpaceUpdated?.({
          id: String(payload.id),
          name: String(payload.name),
          slug: String(payload.slug),
          iconUrl: (payload.icon_url as string | null) ?? undefined,
          defaultChannelId: (payload.default_channel_id as string | null) ?? undefined,
        });
        break;
      }
      case "member.updated": {
        // A replacement, not a patch: every field is serialised, so `null` means "cleared" and is
        // carried through as `undefined` rather than being read as "unchanged".
        handlers.onMemberUpdated?.({
          userId: String(payload.user_id),
          name: String(payload.display_name),
          title: (payload.title as string | null) ?? undefined,
          bot: Boolean(payload.is_bot),
          avatarUrl: (payload.avatar_url as string | null) ?? undefined,
        });
        break;
      }
      case "presence":
        handlers.onPresence?.(String(payload.user_id), toPresence(String(payload.presence)));
        break;
      case "notification.created":
        handlers.onNotification?.(toApiNotification(payload as unknown as NotificationDto));
        break;
      case "typing":
        handlers.onTyping?.(conv, String(payload.user_id));
        break;
      case "read.updated":
        handlers.onReadCursor?.(conv, String(payload.user_id), String(payload.last_read_message_id));
        break;
      case "files.deleted":
        handlers.onFilesDeleted?.(String(payload.space_id), (payload.file_ids as string[]) ?? []);
        break;
      case "calendar.changed":
        handlers.onCalendarChanged?.(String(payload.calendar_id));
        break;
      case "files.updated":
        handlers.onFilesUpdated?.(
          String(payload.space_id),
          toSpaceFile(payload.file as unknown as FileDto),
          payload.conversation_id ? String(payload.conversation_id) : undefined,
        );
        break;
      case "files.editing":
        handlers.onFilesEditing?.(
          String(payload.space_id),
          String(payload.file_id),
          ((payload.editors as { id: string; name: string }[]) ?? []).map((e) => ({ id: e.id, name: e.name })),
        );
        break;
      default:
        // Unhandled event types (saved) are ignored for now.
        break;
    }
  };

  const connect = () => {
    if (closed) return;
    // A way to reach the fallback on purpose. Without it the only way to see the SSE path is to be
    // behind a proxy that blocks the upgrade, which is exactly the situation nobody developing the
    // product is in, and is how a fallback rots unnoticed.
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("transport") === "sse") {
      startEvents();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      reconnectDelay = 1000;
      failedAttempts = 0;
      opened();
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 25000);
    };
    ws.onmessage = (event) => {
      try {
        dispatch(JSON.parse(event.data as string) as RealtimeEnvelope);
      } catch {
        // Ignore an unparseable frame rather than tearing the connection down.
      }
    };
    ws.onclose = (event) => {
      clearInterval(pingTimer);
      if (closed) return;
      // `wasClean` is false for a handshake a proxy refused, and true for a socket that lived and
      // then ended. Only the first kind counts towards giving up on WebSocket.
      if (!event.wasClean) failedAttempts += 1;
      if (failedAttempts >= WS_ATTEMPTS_BEFORE_SSE) {
        startEvents();
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      // The close handler drives reconnection; nothing extra to do here.
    };
  };

  /**
   * The one-way fallback. `EventSource` reconnects on its own, so there is no backoff to write
   * here; what it cannot do is tell us the response was a 401, which is why a closed connection
   * that never delivers is left to the session check on the next navigation.
   */
  const startEvents = () => {
    if (closed || events) return;
    socket = null;
    try {
      events = new EventSource("/api/v1/realtime/sse", { withCredentials: true });
    } catch {
      scheduleReconnect();
      return;
    }
    // `EventSource` reopens on its own after a drop, and says so with `open` each time.
    events.addEventListener("open", opened);
    for (const name of REALTIME_EVENTS) {
      events.addEventListener(name, (event) => {
        try {
          dispatch(JSON.parse((event as MessageEvent<string>).data) as RealtimeEnvelope);
        } catch {
          // Same as on the socket: an unparseable frame is dropped, not fatal.
        }
      });
    }
  };

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };

  connect();

  return {
    close: () => {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      socket?.close();
      events?.close();
      events = null;
    },
    sendTyping: (conversationId: string) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "typing", conversation_id: conversationId }));
        return;
      }
      // Nothing travels up an event stream, so on the fallback this is a request. Best-effort, as
      // it is on the socket: a typing signal nobody receives is not worth reporting.
      if (events) {
        void apiPost<void>("/realtime/typing", { conversation_id: conversationId }).catch(() => {});
      }
    },
  };
}

// --- Bringing a workspace over from another product ----------------------------------------------
//
// Only an instance administrator sees any of this: every route below answers 404 to everyone else,
// so a client that shows the screen to the wrong person shows them a screen full of errors.

/** What an import would do, from `POST /imports/plan`. Nothing is written to produce it. */
export type ImportPlan = {
  source: string;
  spaces: {
    name: string;
    outcome: "created" | "filled";
    channels: number;
    /** Channels of this space that are already here: they take the history rather than be created. */
    channelsFilled: number;
    directs: number;
  }[];
  accounts: {
    total: number;
    matched: number;
    invitable: number;
    withoutAddress: number;
    people: { sourceId: string; displayName: string; email: string; outcome: string }[];
  };
  messages: number;
  files: number;
  /** The producer's own words about what it left behind. Shown in full, never summarised. */
  limits: string[];
  warnings: string[];
  /** What replacing the instance would destroy, so both halves of the choice are visible at once. */
  replacingWouldDestroy: {
    spaces: number;
    accounts: number;
    messages: number;
    spaceNames: string[];
    lastBackup: string | null;
    replacementAllowed: boolean;
  };
};

/** An import, running or finished, from `GET /imports`. */
export type ImportJob = {
  id: string;
  source: string;
  status: "pending" | "analyzing" | "ready" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
  accountsDone: number;
  accountsTotal: number;
  channelsDone: number;
  channelsTotal: number;
  messagesDone: number;
  messagesTotal: number;
  filesDone: number;
  filesTotal: number;
  error: string | null;
  /** When it ended, RFC 3339, or null while it runs. */
  finishedAt: string | null;
};

type ImportJobDto = {
  id: string;
  source: string;
  status: ImportJob["status"];
  accounts_done: number;
  accounts_total: number;
  channels_done: number;
  channels_total: number;
  messages_done: number;
  messages_total: number;
  files_done: number;
  files_total: number;
  error: string | null;
  finished_at: string | null;
};

function toImportJob(dto: ImportJobDto): ImportJob {
  return {
    id: dto.id,
    source: dto.source,
    status: dto.status,
    accountsDone: dto.accounts_done,
    accountsTotal: dto.accounts_total,
    channelsDone: dto.channels_done,
    channelsTotal: dto.channels_total,
    messagesDone: dto.messages_done,
    messagesTotal: dto.messages_total,
    filesDone: dto.files_done,
    filesTotal: dto.files_total,
    error: dto.error,
    finishedAt: dto.finished_at,
  };
}

/** `POST /imports/plan`: what this archive would do. Writes nothing. */
export async function planImport(file: string, passphrase?: string): Promise<ImportPlan> {
  const dto = await apiPost<{
    source: string;
    spaces: {
      name: string;
      outcome: "created" | "filled";
      channels: number;
      channels_filled: number;
      directs: number;
    }[];
    accounts: {
      total: number;
      matched: number;
      invitable: number;
      without_address: number;
      people: { source_id: string; display_name: string; email: string; outcome: string }[];
    };
    messages: number;
    files: number;
    limits: string[];
    warnings: string[];
    replacing_would_destroy: {
      spaces: number;
      accounts: number;
      messages: number;
      space_names: string[];
      last_backup: string | null;
      replacement_allowed: boolean;
    };
  }>("/imports/plan", { file, passphrase });
  return {
    source: dto.source,
    spaces: dto.spaces.map((space) => ({
      name: space.name,
      outcome: space.outcome,
      channels: space.channels,
      channelsFilled: space.channels_filled,
      directs: space.directs,
    })),
    accounts: {
      total: dto.accounts.total,
      matched: dto.accounts.matched,
      invitable: dto.accounts.invitable,
      withoutAddress: dto.accounts.without_address,
      people: dto.accounts.people.map((person) => ({
        sourceId: person.source_id,
        displayName: person.display_name,
        email: person.email,
        outcome: person.outcome,
      })),
    },
    messages: dto.messages,
    files: dto.files,
    limits: dto.limits,
    warnings: dto.warnings,
    replacingWouldDestroy: {
      spaces: dto.replacing_would_destroy.spaces,
      accounts: dto.replacing_would_destroy.accounts,
      messages: dto.replacing_would_destroy.messages,
      spaceNames: dto.replacing_would_destroy.space_names,
      lastBackup: dto.replacing_would_destroy.last_backup,
      replacementAllowed: dto.replacing_would_destroy.replacement_allowed,
    },
  };
}

/**
 * `POST /imports`: start it.
 *
 * `replaceInstanceAddress`, when given, empties the instance first: every space and every account
 * except the one asking. The server checks the address, and refuses without a recent backup.
 */
/** What an administrator changed about one person after reading the plan. */
export type PersonChoice = {
  sourceId: string;
  /** An address given or corrected by hand. Absent means the archive's own. */
  email?: string;
  /** Leave this person out. Their messages still arrive, with no author. */
  skip?: boolean;
};

export async function startImport(
  file: string,
  passphrase?: string,
  replaceInstanceAddress?: string,
  people: PersonChoice[] = [],
): Promise<ImportJob> {
  const dto = await apiPost<ImportJobDto>("/imports", {
    file,
    passphrase,
    replace_everything: replaceInstanceAddress ? { instance_address: replaceInstanceAddress } : undefined,
    // Only the ones that changed: everyone else arrives as the archive spells them.
    people: people.map((p) => ({ source_id: p.sourceId, email: p.email, skip: p.skip })),
  });
  return toImportJob(dto);
}

/** What happened when the invitations went out. */
export type InviteOutcome = {
  sent: number;
  skipped: { sourceId: string; reason: string }[];
};

/**
 * `POST /imports/{id}/invitations`: write to the people this import brought over.
 *
 * Separate from the import itself, and never automatic: ten thousand accounts arriving is not ten
 * thousand emails leaving, and this is the moment somebody says who hears about it.
 */
export async function inviteImported(id: string, sourceIds: string[]): Promise<InviteOutcome> {
  const dto = await apiPost<{ sent: number; skipped: { source_id: string; reason: string }[] }>(
    `/imports/${id}/invitations`,
    { source_ids: sourceIds },
  );
  return {
    sent: dto.sent,
    skipped: dto.skipped.map((s) => ({ sourceId: s.source_id, reason: s.reason })),
  };
}

/** `GET /imports`: every import this instance has run, most recent first. */
export async function listImports(signal?: AbortSignal): Promise<ImportJob[]> {
  const dtos = await apiGet<ImportJobDto[]>("/imports", signal);
  return dtos.map(toImportJob);
}

/** `GET /imports/{id}`: where one has got to. */
export async function getImport(id: string, signal?: AbortSignal): Promise<ImportJob> {
  return toImportJob(await apiGet<ImportJobDto>(`/imports/${id}`, signal));
}

/** Somebody an import brought over, read back from the server rather than from a plan. */
export type ImportedPerson = {
  sourceId: string;
  displayName: string;
  /** Empty when nobody ever gave them one: they cannot be invited by mail. */
  email: string;
  /** Whether an invitation has already gone to that address. */
  invited: boolean;
};

/**
 * `GET /imports/{id}/people`: who an import brought over.
 *
 * What the plan said, but from the server and after the fact, so the invitations can still be sent
 * by a screen that was closed while the import ran and knows nothing of that plan.
 */
export async function listImportedPeople(id: string, signal?: AbortSignal): Promise<ImportedPerson[]> {
  const dtos = await apiGet<
    { source_id: string; display_name: string; email: string; invited: boolean }[]
  >(`/imports/${id}/people`, signal);
  return dtos.map((dto) => ({
    sourceId: dto.source_id,
    displayName: dto.display_name,
    email: dto.email,
    invited: dto.invited,
  }));
}

/** `POST /imports/{id}/cancel`: it stops at the next conversation and keeps what it wrote. */
export async function cancelImport(id: string): Promise<ImportJob> {
  return toImportJob(await apiPost<ImportJobDto>(`/imports/${id}/cancel`, {}));
}

/** A one-time credential a delivery command carries, with the instance address it delivers to. */
export type DropToken = {
  token: string;
  baseUrl: string;
  expiresInSecs: number;
};

/** `POST /imports/drop-tokens`: mint a one-time token for an auto-delivery command. */
export async function issueDropToken(): Promise<DropToken> {
  const dto = await apiPost<{ token: string; base_url: string; expires_in_secs: number }>(
    "/imports/drop-tokens",
    {},
  );
  return { token: dto.token, baseUrl: dto.base_url, expiresInSecs: dto.expires_in_secs };
}

/** An archive sitting in the server's import directory. */
export type ImportFile = {
  name: string;
  bytes: number;
  /** Last modified, RFC 3339, or null when the filesystem would not say. */
  modified: string | null;
};

/** `GET /imports/files`: the archives on the server, newest first - a delivery lands in this list. */
export async function listImportFiles(signal?: AbortSignal): Promise<ImportFile[]> {
  const dtos = await apiGet<{ name: string; bytes: number; modified: string | null }[]>(
    "/imports/files",
    signal,
  );
  return dtos.map((dto) => ({ name: dto.name, bytes: dto.bytes, modified: dto.modified }));
}

