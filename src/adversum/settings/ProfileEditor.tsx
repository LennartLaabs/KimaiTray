import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KimaiClient } from "../../api/kimaiClient";
import { buttonClass } from "../../settings/Controls";
import {
  loadEntity,
  readProfile,
  saveProfile,
  type ProfileKind,
  type SaveProblem,
} from "../profile/profileApi";
import { mergeProfiles, suggestProfile } from "../profile/profileSentence";
import {
  formatContact,
  isEmptyProfile,
  parseProfile,
  type Profile,
} from "../profile/profileText";
import { finishVoiceTest, startVoiceTest } from "../voice/voiceApi";

/**
 * The profile of one customer, project or activity as a form: aliases,
 * contacts (customers only) and topics. It can be filled by hand, from a
 * sentence that is typed or dictated, and for a customer nobody has
 * described yet from what Kimai knows. Nothing is written before "save",
 * and then only the profile lines of the description in Kimai.
 */

interface ProfileEditorProps {
  client: KimaiClient;
  kind: ProfileKind;
  entity: { id: number; name: string; comment: string | null };
  /** The profile is in Kimai now; lists should be read again. */
  onSaved: () => void;
}

interface Fields {
  aliases: string;
  contacts: string;
  topics: string;
}

function toFields(profile: Profile): Fields {
  return {
    aliases: profile.aliases.join(", "),
    contacts: profile.contacts.map(formatContact).join(", "),
    topics: profile.topics.join(", "),
  };
}

function toProfile(fields: Fields): Profile {
  return parseProfile(
    `Aliasse: ${fields.aliases}\nKontakte: ${fields.contacts}\nThemen: ${fields.topics}`,
  );
}

const FIELD =
  "h-[29px] w-full rounded-lg border border-[var(--s-line)] bg-[var(--s-card)] px-2.5 text-[12.5px] text-[var(--s-fg)] outline-none placeholder:text-[var(--s-fg-subtle)] focus:border-[var(--accent)]";

export default function ProfileEditor({ client, kind, entity, onSaved }: ProfileEditorProps) {
  const { t } = useTranslation();
  const [fields, setFields] = useState(() => toFields(parseProfile(entity.comment)));
  const [sentence, setSentence] = useState("");
  const [suggested, setSuggested] = useState(false);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<"saving" | "saved" | "voice" | SaveProblem | null>(null);
  const touched = useRef(false);

  // A customer without a profile starts with what Kimai itself knows.
  useEffect(() => {
    if (kind !== "customers" || !isEmptyProfile(parseProfile(entity.comment))) return;
    let current = true;
    loadEntity(client, kind, entity.id)
      .then((details) => {
        const proposal = suggestProfile(details);
        if (!current || touched.current || isEmptyProfile(proposal)) return;
        setFields(toFields(proposal));
        setSuggested(true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // Once per opened editor; the entity does not change underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (field: keyof Fields, value: string) => {
    touched.current = true;
    setStatus(null);
    setFields((current) => ({ ...current, [field]: value }));
  };

  const apply = async (text: string) => {
    if (text.trim() === "") return;
    const said = await readProfile(text);
    touched.current = true;
    setStatus(null);
    setFields((current) => toFields(mergeProfiles(toProfile(current), said)));
  };

  const dictate = async () => {
    setStatus(null);
    if (!recording) {
      try {
        await startVoiceTest();
        setRecording(true);
      } catch {
        setStatus("voice");
      }
      return;
    }
    setRecording(false);
    try {
      const heard = await finishVoiceTest();
      if (heard.outcome !== "ok") return setStatus("voice");
      setSentence(heard.text);
      await apply(heard.text);
    } catch {
      setStatus("voice");
    }
  };

  const save = async () => {
    setStatus("saving");
    try {
      await saveProfile(client, kind, entity.id, toProfile(fields));
      setSuggested(false);
      setStatus("saved");
      onSaved();
    } catch (problem) {
      setStatus(problem as SaveProblem);
    }
  };

  const shown: (keyof Fields)[] =
    kind === "customers" ? ["aliases", "contacts", "topics"] : ["aliases", "topics"];

  return (
    <div
      data-profile-editor={entity.id}
      className="space-y-2 border-b border-[var(--s-line-soft)] bg-[var(--s-hover)] px-4 py-3"
    >
      {suggested && (
        <p data-profile-suggested className="text-[11.5px] text-amber-600 dark:text-amber-400">
          {t("adversum.profile.suggested")}
        </p>
      )}
      {shown.map((field) => (
        <label key={field} className="flex items-center gap-3">
          <span className="w-[76px] shrink-0 text-[12px] text-[var(--s-fg-muted)]">
            {t(`adversum.profile.${field}`)}
          </span>
          <input
            type="text"
            spellCheck={false}
            value={fields[field]}
            placeholder={t(`adversum.profile.${field}Placeholder`)}
            onChange={(event) => change(field, event.target.value)}
            className={FIELD}
          />
        </label>
      ))}
      <div className="flex items-center gap-2">
        <input
          type="text"
          spellCheck={false}
          aria-label={t("adversum.profile.sentence")}
          value={sentence}
          placeholder={t("adversum.profile.sentencePlaceholder")}
          onChange={(event) => setSentence(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void apply(sentence);
          }}
          className={FIELD}
        />
        <button
          type="button"
          className={buttonClass("ghost", "sm")}
          disabled={sentence.trim() === ""}
          onClick={() => void apply(sentence)}
        >
          {t("adversum.profile.apply")}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-profile-dictate
          aria-pressed={recording}
          className={buttonClass(recording ? "primary" : "secondary", "sm")}
          onClick={() => void dictate()}
        >
          {t(recording ? "adversum.profile.stopDictating" : "adversum.profile.dictate")}
        </button>
        <span className="min-w-0 flex-1 text-[11.5px]" role="status" data-profile-status={status ?? ""}>
          {status === "saved" && (
            <span className="text-emerald-600 dark:text-emerald-400">
              {t("adversum.profile.saved")}
            </span>
          )}
          {(status === "forbidden" || status === "failed" || status === "voice") && (
            <span className="text-red-500 dark:text-red-400">
              {t(`adversum.profile.problem.${status}`)}
            </span>
          )}
        </span>
        <button
          type="button"
          className={buttonClass("primary", "sm")}
          disabled={status === "saving" || recording}
          onClick={() => void save()}
        >
          {t("adversum.profile.save")}
        </button>
      </div>
    </div>
  );
}
