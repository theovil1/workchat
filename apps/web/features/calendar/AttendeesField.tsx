"use client";

import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon, type IconName, Popover } from "@/components/ds";
import { searchInvitees, type AttendeeStatus, type Invitee } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";

/** Someone on the list while it is being written: a member or an address, with their answer once
 *  they gave one. */
export type DraftAttendee = { key: string; userId?: string; email?: string; name: string; status?: AttendeeStatus };

/** An address as the field accepts it: something, an at sign, a domain with a dot. */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

/** The icon and colour of an answer, for a chip and the details. */
export const STATUS_LOOK: Record<AttendeeStatus, { icon: IconName; color: string }> = {
  accepted: { icon: "check", color: "var(--lime)" },
  tentative: { icon: "info", color: "var(--sun)" },
  declined: { icon: "x", color: "var(--peach)" },
  needs_action: { icon: "clock", color: "var(--surface-sunken)" },
};

const STATUS_KEYS = {
  accepted: "calendar.status.accepted",
  tentative: "calendar.status.tentative",
  declined: "calendar.status.declined",
  needs_action: "calendar.status.needs_action",
} as const;

const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  maxWidth: "100%",
  padding: "2px 4px 2px 3px",
  borderRadius: 999,
  background: "var(--surface-sunken)",
  border: "1px solid var(--border-subtle)",
  fontSize: "var(--text-xs)",
  color: "var(--text-strong)",
};

/**
 * Who is invited: chips, each with its answer, and a field to add more, searching the people who
 * may be invited to this calendar's events as one types, or taking an address as it is. Enter adds
 * the first suggestion, or the address typed.
 */
export function AttendeesField({
  calendarId,
  value,
  onChange,
}: {
  calendarId: string;
  value: DraftAttendee[];
  onChange: (next: DraftAttendee[]) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [found, setFound] = useState<Invitee[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);

  // Suggestions follow what is typed, a moment after the last key.
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const wait = setTimeout(() => {
      searchInvitees(calendarId, text.trim(), abort.signal)
        .then((people) => {
          setFound(people.filter((p) => !value.some((v) => v.userId === p.userId)));
          setActive(0);
        })
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(wait);
      abort.abort();
    };
  }, [calendarId, text, open, value]);

  const add = (attendee: DraftAttendee) => {
    const same = (a: DraftAttendee) =>
      (attendee.userId && a.userId === attendee.userId) || (attendee.email && a.email?.toLowerCase() === attendee.email.toLowerCase());
    if (!value.some(same)) onChange([...value, attendee]);
    setText("");
    field.current?.focus();
  };
  const addTyped = () => {
    const typed = text.trim();
    if (found[active] && !looksLikeEmail(typed)) {
      const person = found[active];
      add({ key: person.userId, userId: person.userId, name: person.name });
    } else if (looksLikeEmail(typed)) {
      add({ key: typed.toLowerCase(), email: typed, name: typed });
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      if (!text.trim()) return;
      event.preventDefault();
      addTyped();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (found.length === 0 ? 0 : (i + step + found.length) % found.length));
    } else if (event.key === "Backspace" && !text && value.length > 0) {
      onChange(value.slice(0, -1));
    } else if (event.key === "Escape" && open) {
      event.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    }
  };

  const showList = open && (found.length > 0 || looksLikeEmail(text));

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", minWidth: 0, width: "100%" }}>
      {value.map((a) => {
        const look = a.status ? STATUS_LOOK[a.status] : null;
        return (
          <span key={a.key} style={chip} title={a.email ?? undefined}>
            {look ? (
              <span
                role="img"
                aria-label={t(STATUS_KEYS[a.status ?? "needs_action"])}
                style={{ width: 16, height: 16, borderRadius: "50%", background: look.color, color: "var(--on-pastel)", display: "grid", placeItems: "center", flex: "none" }}
              >
                <Icon name={look.icon} size={10} />
              </span>
            ) : (
              <Icon name={a.email ? "mail" : "user-plus"} size={12} style={{ marginLeft: 3, color: "var(--text-muted)" }} />
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
            <button
              type="button"
              aria-label={t("calendar.removeAttendee", { name: a.name })}
              onClick={() => onChange(value.filter((v) => v.key !== a.key))}
              style={{ border: "none", background: "none", padding: 0, display: "grid", placeItems: "center", cursor: "pointer", color: "var(--text-muted)" }}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        );
      })}
      <input
        ref={field}
        id="event-attendees"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        onBlur={() => {
          // An address left typed is kept, as a mail client does.
          if (looksLikeEmail(text)) addTyped();
        }}
        placeholder={value.length === 0 ? t("calendar.addAttendees") : undefined}
        role="combobox"
        aria-controls="event-attendees-list"
        aria-label={t("calendar.attendees")}
        aria-autocomplete="list"
        aria-expanded={showList}
        style={{
          flex: "1 1 140px",
          minWidth: 120,
          height: 30,
          border: "none",
          outline: "none",
          background: "transparent",
          font: "inherit",
          fontSize: "var(--text-sm)",
          color: "var(--text-strong)",
        }}
      />
      <Popover anchorRef={field} open={showList} onClose={() => setOpen(false)} placement="bottom">
        <div
          id="event-attendees-list"
          role="listbox"
          aria-label={t("calendar.attendees")}
          style={{
            width: 280,
            maxHeight: 260,
            overflowY: "auto",
            background: "var(--surface-card)",
            border: "1.5px solid var(--ink)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-popover)",
            padding: 6,
          }}
        >
          {found.map((person, i) => (
            <div
              key={person.userId}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                // Before the field's blur, which would close the list.
                e.preventDefault();
                add({ key: person.userId, userId: person.userId, name: person.name });
              }}
              style={{
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                fontSize: "var(--text-sm)",
                color: "var(--text-strong)",
                background: i === active ? "var(--surface-hover)" : undefined,
              }}
            >
              {person.name}
            </div>
          ))}
          {looksLikeEmail(text) ? (
            <div
              role="option"
              aria-selected={found.length === 0}
              onMouseDown={(e) => {
                e.preventDefault();
                addTyped();
              }}
              style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", cursor: "pointer", fontSize: "var(--text-sm)", color: "var(--text-strong)" }}
            >
              <Icon name="mail" size={14} />
              {t("calendar.inviteByEmail", { email: text.trim() })}
            </div>
          ) : null}
        </div>
      </Popover>
    </div>
  );
}
