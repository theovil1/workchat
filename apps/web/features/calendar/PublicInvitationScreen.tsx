"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button, Icon, Skeleton, SkeletonGroup } from "@/components/ds";
import { answerInvitation, readInvitation, type AttendeeStatus, type PublicInvitation } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { STATUS_LOOK } from "./AttendeesField";
import { clock, longDay } from "./format";
import { addDays, localDay } from "./model";

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "var(--ui-vh, 100vh)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    padding: "32px 16px calc(32px + env(safe-area-inset-bottom))",
    background: "var(--surface-canvas)",
  },
  card: {
    width: "100%",
    maxWidth: 460,
    padding: 24,
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-subtle)",
    background: "var(--surface-card)",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  title: { margin: 0, fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-strong)", overflowWrap: "anywhere" },
  line: { display: "flex", gap: 10, alignItems: "flex-start", margin: 0, fontSize: "var(--text-sm)", color: "var(--text-body)" },
  meta: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: "var(--leading-normal)" },
};

const ANSWERS = [
  { status: "accepted", key: "calendar.answer.accepted" },
  { status: "tentative", key: "calendar.answer.tentative" },
  { status: "declined", key: "calendar.answer.declined" },
] as const;

type State = { kind: "loading" } | { kind: "gone" } | { kind: "shown"; invitation: PublicInvitation; saved: boolean; failed: boolean };

/**
 * What someone invited by address sees: the event (when, read in its own zone and named when it is
 * not theirs; where; what for; whether it repeats), who invites them, and three buttons to answer,
 * the one they chose drawn as chosen. A dead link says so.
 */
export function PublicInvitationScreen() {
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get("t") ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address is read once, on the client
    setToken(found);
    if (!found) {
      setState({ kind: "gone" });
      return;
    }
    readInvitation(found)
      .then((invitation) => setState({ kind: "shown", invitation, saved: false, failed: false }))
      .catch(() => setState({ kind: "gone" }));
  }, []);

  const answer = (status: Exclude<AttendeeStatus, "needs_action">) => {
    if (state.kind !== "shown" || busy) return;
    setBusy(true);
    answerInvitation(token, status)
      .then((invitation) => setState({ kind: "shown", invitation, saved: true, failed: false }))
      .catch(() => setState({ ...state, failed: true }))
      .finally(() => setBusy(false));
  };

  const mark = (
    // eslint-disable-next-line @next/next/no-img-element -- the self-hosted brand mark
    <img src="/brand/ruchoir-mark.png" alt="Ruchoir" width={40} height={40} />
  );

  return (
    <main style={styles.page}>
      {mark}
      <div style={styles.card}>
        {state.kind === "loading" ? (
          <SkeletonGroup label={t("invitationPage.loading")}>
            <Skeleton width="70%" height={24} />
            <Skeleton width="100%" height={16} />
            <Skeleton width="50%" height={16} />
          </SkeletonGroup>
        ) : state.kind === "gone" ? (
          <>
            <h1 style={styles.title}>{t("invitationPage.goneTitle")}</h1>
            <p style={styles.meta}>{t("invitationPage.gone")}</p>
          </>
        ) : (
          <Shown invitation={state.invitation} saved={state.saved} failed={state.failed} busy={busy} onAnswer={answer} />
        )}
      </div>
      <p style={{ ...styles.meta, textAlign: "center" }}>{t("invitationPage.footer")}</p>
    </main>
  );
}

function Shown({
  invitation,
  saved,
  failed,
  busy,
  onAnswer,
}: {
  invitation: PublicInvitation;
  saved: boolean;
  failed: boolean;
  busy: boolean;
  onAnswer: (status: Exclude<AttendeeStatus, "needs_action">) => void;
}) {
  const { t } = useTranslation();
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = invitation.tzid ?? here;
  const when = (() => {
    if (invitation.allDay) {
      const last = addDays(invitation.end, -1);
      return last === invitation.start ? longDay(invitation.start) : `${longDay(invitation.start)} - ${longDay(last)}`;
    }
    const day = longDay(localDay(invitation.start, zone));
    const text = `${day}, ${clock(invitation.start, zone)} - ${clock(invitation.end, zone)}`;
    return zone === here ? text : `${text} (${zone})`;
  })();
  const chosen = invitation.status === "needs_action" ? null : invitation.status;
  return (
    <>
      <p style={styles.meta}>
        {invitation.organizer ? t("invitationPage.from", { organizer: invitation.organizer }) : t("invitationPage.title")}
      </p>
      <h1 style={styles.title}>{invitation.title}</h1>
      <p style={styles.line}>
        <Icon name="clock" size={16} />
        <span>{when}</span>
      </p>
      {invitation.recurring ? (
        <p style={styles.line}>
          <Icon name="repeat" size={16} />
          <span>{t("invitationPage.recurring")}</span>
        </p>
      ) : null}
      {invitation.location ? (
        <p style={styles.line}>
          <Icon name="map-pin" size={16} />
          <span>{invitation.location}</span>
        </p>
      ) : null}
      {invitation.description ? <p style={{ ...styles.line, whiteSpace: "pre-wrap" }}>{invitation.description}</p> : null}
      <div role="group" aria-label={t("calendar.yourAnswer")} style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid var(--border-subtle)" }}>
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-strong)" }}>
          {invitation.name ? t("invitationPage.question", { name: invitation.name }) : t("calendar.yourAnswer")}
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ANSWERS.map(({ status, key }) => (
            <Button
              key={status}
              variant={chosen === status ? "primary" : "secondary"}
              iconLeft={STATUS_LOOK[status].icon}
              aria-pressed={chosen === status}
              disabled={busy}
              onClick={() => onAnswer(status)}
            >
              {t(key)}
            </Button>
          ))}
        </div>
        {saved ? (
          <p role="status" style={{ ...styles.meta, color: "var(--text-strong)" }}>
            {t("invitationPage.saved")}
          </p>
        ) : null}
        {failed ? (
          <p role="alert" style={{ ...styles.meta, color: "var(--action-danger-bg)" }}>
            {t("invitationPage.failed")}
          </p>
        ) : null}
      </div>
    </>
  );
}
