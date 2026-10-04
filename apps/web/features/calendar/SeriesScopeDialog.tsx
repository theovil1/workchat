"use client";

import { useState } from "react";
import { Button, Dialog, Radio } from "@/components/ds";
import type { EditScope } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";

/**
 * What a change or a deletion to an occurrence of a series touches: this one, this one and the
 * following ones, or the whole series. Asked only for an event that repeats.
 */
export function SeriesScopeDialog({
  title,
  action,
  onChoose,
  onCancel,
}: {
  title: string;
  action: "edit" | "delete";
  onChoose: (scope: EditScope) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<EditScope>("this");
  const options: { value: EditScope; label: string; hint: string }[] = [
    { value: "this", label: t("calendar.scopeThis"), hint: t("calendar.scopeThisHint") },
    { value: "following", label: t("calendar.scopeFollowing"), hint: t("calendar.scopeFollowingHint") },
    { value: "all", label: t("calendar.scopeAll"), hint: t("calendar.scopeAllHint") },
  ];
  return (
    <Dialog
      size="sm"
      title={t(action === "edit" ? "calendar.scopeEditTitle" : "calendar.scopeDeleteTitle", { title })}
      subtitle={t("calendar.scopeIntro")}
      onClose={onCancel}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant={action === "delete" ? "danger" : "primary"} onClick={() => onChoose(scope)}>
            {action === "delete" ? t("common.delete") : t("common.save")}
          </Button>
        </>
      }
    >
      <div role="radiogroup" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {options.map((o) => (
          <Radio key={o.value} name="scope" checked={scope === o.value} onChange={() => setScope(o.value)} label={o.label} description={o.hint} />
        ))}
      </div>
    </Dialog>
  );
}
