import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KimaiClient } from "../../api/kimaiClient";
import { logger } from "../../utils/logger";
import type { QuickAction } from "../quickEntry/actions";
import type { QuickCatalog } from "../quickEntry/catalog";
import type { QuickHistory } from "../quickEntry/history";
import { buildDraft, type MultiReading } from "./draft";
import { extractWithModel } from "./extract";
import MultiReview from "./MultiReview";
import type { MultiDraft } from "./types";
import { useDayEntries } from "./useDayEntries";

interface MultiStageProps {
  sentence: string;
  /** What the rules made of the sentence. */
  reading: MultiReading;
  catalog: QuickCatalog;
  history: QuickHistory;
  client: KimaiClient | null;
  /** A language model may be asked where the rules are unsure. */
  useModel: boolean;
  onSubmit: (action: QuickAction) => void;
  onClose: () => void;
  /** The sentence is one entry after all; show the usual card. */
  onSingle: () => void;
}

/**
 * Several entries from one sentence: loads what the day already holds, asks
 * a language model where the rules were unsure, and shows the review.
 */
export default function MultiStage({
  sentence,
  reading,
  catalog,
  history,
  client,
  useModel,
  onSubmit,
  onClose,
  onSingle,
}: MultiStageProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MultiDraft | null>(reading.draft);
  const unsure = reading.suspect || !!reading.draft?.uncertain;
  const [refining, setRefining] = useState(useModel && unsure);
  const entries = useDayEntries(client, draft?.day ?? new Date());

  useEffect(() => {
    if (!(useModel && unsure)) return;
    let current = true;
    const now = new Date();
    extractWithModel(sentence, now)
      .then((answer) => {
        if (!current || !answer) return;
        const better = buildDraft(answer.extraction, catalog, history, now, answer.source);
        if (better) setDraft(better);
      })
      .catch((error: unknown) => logger.warn(`Language model for several entries: ${String(error)}`))
      .finally(() => {
        if (current) setRefining(false);
      });
    return () => {
      current = false;
    };
    // The sentence is read once; a catalog that reloads meanwhile changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentence]);

  // Neither the rules nor a model found several entries.
  useEffect(() => {
    if (!draft && !refining) onSingle();
  }, [draft, refining, onSingle]);

  if (!draft || !entries.ready) {
    return (
      <p role="status" className="px-4 py-3.5 text-[13px] text-gray-500 dark:text-gray-400">
        {t(draft ? "adversum.multi.loading" : "adversum.multi.refining")}
      </p>
    );
  }
  return (
    <MultiReview
      // A new reading starts the review afresh.
      key={draft.source}
      draft={draft}
      catalog={catalog}
      history={history}
      busy={entries.busy}
      running={entries.running}
      refining={refining}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
