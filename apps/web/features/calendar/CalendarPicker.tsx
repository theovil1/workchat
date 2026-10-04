"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon, Input, Popover } from "@/components/ds";
import type { Calendar } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { colorVar } from "./OccurrenceChip";

/** Beyond this many calendars, the list gets a search field. */
const SEARCH_FROM = 8;

type Space = { id: string; name: string };

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/**
 * Which calendar an event goes in, as the calendar's column shows them: the viewer's own, then the
 * space the screen is on, then the other spaces in alphabetical order, each with its colour. A space
 * calendar named after its space is listed by that name alone. Searchable once the list is long, and
 * driven from the keyboard (arrows, Enter, Escape).
 */
export function CalendarPicker({
  id,
  calendars,
  spaces,
  value,
  currentSpaceId,
  disabled,
  onChange,
}: {
  id?: string;
  /** The calendars the viewer may write in. */
  calendars: Calendar[];
  spaces: Space[];
  value: string;
  /** The space the screen is on: its calendars come right after the viewer's own. */
  currentSpaceId?: string;
  disabled?: boolean;
  onChange: (calendarId: string) => void;
}) {
  const { t } = useTranslation();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // The list is at least as wide as its button, measured when it opens.
  const [width, setWidth] = useState(0);
  const listId = `${id ?? "calendar-picker"}-list`;
  const searchId = `${listId}-search`;
  const searchable = calendars.length > SEARCH_FROM;
  // Focus goes to the search field (or the list) once the popover is in place: it is measured hidden
  // first, and a hidden field cannot take it.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => document.getElementById(searchable ? searchId : listId)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, searchable, searchId, listId]);

  const spaceName = (spaceId?: string) => spaces.find((s) => s.id === spaceId)?.name;
  const label = (c: Calendar) => {
    const space = spaceName(c.spaceId);
    return { main: c.name, sub: space && space !== c.name ? space : undefined };
  };

  const ofSpace = (s: Space) => calendars.filter((c) => c.spaceId === s.id);
  const groups = (() => {
    const current = spaces.find((s) => s.id === currentSpaceId);
    const others = spaces
      .filter((s) => s.id !== current?.id)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const q = fold(query.trim());
    const keep = (c: Calendar) => !q || fold(c.name).includes(q) || fold(spaceName(c.spaceId) ?? "").includes(q);
    return [
      { key: "mine", title: t("calendar.mine"), items: calendars.filter((c) => !c.spaceId) },
      ...(current ? [{ key: current.id, title: current.name, items: ofSpace(current) }] : []),
      { key: "others", title: current ? t("calendar.otherSpaces") : t("calendar.mySpaces"), items: others.flatMap(ofSpace) },
    ]
      .map((g) => ({ ...g, items: g.items.filter(keep) }))
      .filter((g) => g.items.length > 0);
  })();
  const flat = groups.flatMap((g) => g.items);
  const position = new Map(flat.map((c, i) => [c.id, i]));
  const chosen = calendars.find((c) => c.id === value);

  const close = () => {
    setOpen(false);
    setQuery("");
    button.current?.focus();
  };
  const pick = (c: Calendar) => {
    onChange(c.id);
    close();
  };
  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, flat.findIndex((c) => c.id === value)));
    setWidth(button.current?.offsetWidth ?? 0);
    setOpen(true);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Only the list closes: the bubble or the window it sits in stays open.
      event.nativeEvent.stopImmediatePropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (flat.length === 0 ? 0 : (i + step + flat.length) % flat.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const c = flat[active];
      if (c) pick(c);
    }
  };

  const swatch = (color: Calendar["color"] | undefined) => (
    <span aria-hidden style={{ width: 12, height: 12, borderRadius: 4, flex: "none", background: colorVar(color) }} />
  );

  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className="wc-sel wc-sel--sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("calendar.title")}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openList();
          }
        }}
        style={{ gap: 8, padding: "0 10px", cursor: disabled ? "default" : "pointer", color: "var(--text-strong)", font: "inherit", fontSize: "var(--text-sm)", textAlign: "left" }}
      >
        {swatch(chosen?.color)}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {chosen ? label(chosen).main : ""}
          {chosen && label(chosen).sub ? <span style={{ color: "var(--text-muted)" }}> · {label(chosen).sub}</span> : null}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      <Popover anchorRef={button} open={open} onClose={close} placement="bottom">
        <div
          onKeyDown={onKey}
          style={{
            width: Math.max(280, width),
            maxWidth: "calc(100vw - 16px)",
            background: "var(--surface-card)",
            border: "1.5px solid var(--ink)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-popover)",
            padding: 6,
          }}
        >
          {searchable ? (
            <Input
              id={searchId}
              size="sm"
              icon="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder={t("calendar.searchCalendar")}
              aria-label={t("calendar.searchCalendar")}
              aria-controls={listId}
              style={{ width: "100%" }}
            />
          ) : null}
          <div
            id={listId}
            role="listbox"
            aria-label={t("calendar.title")}
            tabIndex={searchable ? -1 : 0}
            style={{ maxHeight: 320, overflowY: "auto", marginTop: searchable ? 6 : 0, outline: "none" }}
          >
            {groups.map((g) => (
              <div key={g.key} role="group" aria-label={g.title}>
                <div style={{ padding: "6px 8px 2px", fontSize: "var(--text-2xs)", fontWeight: 700, color: "var(--text-muted)" }}>{g.title}</div>
                {g.items.map((c) => {
                  const at = position.get(c.id) ?? -1;
                  const on = c.id === value;
                  const { main, sub } = label(c);
                  return (
                    <div
                      key={c.id}
                      role="option"
                      aria-selected={on}
                      ref={(el) => {
                        if (el && at === active) el.scrollIntoView({ block: "nearest" });
                      }}
                      onMouseEnter={() => setActive(at)}
                      onClick={() => pick(c)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minHeight: 32,
                        padding: "4px 8px",
                        borderRadius: "var(--radius-sm)",
                        cursor: "pointer",
                        background: at === active ? "var(--surface-hover)" : undefined,
                        fontSize: "var(--text-sm)",
                        color: "var(--text-strong)",
                        fontWeight: on ? 700 : 400,
                      }}
                    >
                      {swatch(c.color)}
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {main}
                        {sub ? <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> · {sub}</span> : null}
                      </span>
                      {on ? <Icon name="check" size={14} /> : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 ? <p style={{ margin: 8, color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("calendar.noCalendarFound")}</p> : null}
          </div>
        </div>
      </Popover>
    </>
  );
}
