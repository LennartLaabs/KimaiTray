import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { getCustomers } from "../../api/projectApi";
import type { KimaiCustomer } from "../../api/kimaiTypes";
import { useKimaiClient } from "../../hooks/useKimaiClient";
import { Segmented, TextInput, buttonClass } from "../../settings/Controls";
import {
  SettingsList,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../../settings/SettingsLayout";
import CustomerAvatar from "../logos/CustomerAvatar";
import { fileToLogoPngBase64, LogoFileError } from "../logos/encodeImage";
import type { HomepageLookup } from "../logos/customerHomepage";
import { clearManualLogo, setManualLogo, type LogoEntry } from "../logos/logoApi";
import { useCustomerHomepages } from "../logos/useCustomerHomepages";
import { useCustomerLogos } from "../logos/useCustomerLogos";
import type { CustomerIndicator } from "./adversumSettings";
import { useAdversumSettings } from "./useAdversumSettings";

const PREVIEW_SIZE = 28;

interface CustomerLogosSectionProps {
  /** Converts a chosen file into a base64 PNG; replaceable in tests. */
  encodeImage?: (file: File) => Promise<string>;
}

function sourceLabelKey(entry: LogoEntry | undefined): string {
  return `adversum.logos.source.${entry?.source ?? "pending"}`;
}

export default function CustomerLogosSection({
  encodeImage = fileToLogoPngBase64,
}: CustomerLogosSectionProps) {
  const { t } = useTranslation();
  const { client, isConfigured, activeConnectionId } = useKimaiClient();
  const { settings, update } = useAdversumSettings();
  const enabled = !!client && isConfigured;

  const customersQ = useQuery({
    queryKey: ["customers", client?.cacheScope],
    queryFn: () => getCustomers(client!),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
  const customers = useMemo(
    () => [...(customersQ.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [customersQ.data],
  );
  const customerIds = useMemo(() => customers.map((customer) => customer.id), [customers]);

  const homepages = useCustomerHomepages(client, enabled, customerIds);
  const { entries, reload, apply } = useCustomerLogos({
    client,
    connectionId: activeConnectionId,
    customerIds,
    logoDevToken: settings.logoDevToken,
    autoFetch: false,
    onHomepageLookup: homepages.remember,
  });

  const [tokenDraft, setTokenDraft] = useState(settings.logoDevToken);
  useEffect(() => setTokenDraft(settings.logoDevToken), [settings.logoDevToken]);
  const [busyIds, setBusyIds] = useState<readonly number[]>([]);
  const [reloadingAll, setReloadingAll] = useState(false);
  const [failures, setFailures] = useState<Readonly<Record<number, string>>>({});
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);

  const run = async (customerId: number, action: () => Promise<void>) => {
    const setFailure = (key: string | undefined) =>
      setFailures(({ [customerId]: _previous, ...others }) =>
        key ? { ...others, [customerId]: key } : others,
      );
    setFailure(undefined);
    setBusyIds((ids) => [...ids, customerId]);
    try {
      await action();
    } catch (error) {
      setFailure(
        error instanceof LogoFileError && error.reason === "tooLarge"
          ? "adversum.logos.tooLarge"
          : "adversum.logos.failed",
      );
    } finally {
      setBusyIds((ids) => ids.filter((id) => id !== customerId));
    }
  };

  const applyFile = (customerId: number, file: File | null | undefined) => {
    if (!file) return;
    void run(customerId, async () => {
      const entry = await setManualLogo(
        activeConnectionId,
        customerId,
        await encodeImage(file),
      );
      apply(customerId, entry);
    });
  };

  const resetLogo = (customerId: number) =>
    run(customerId, async () => {
      apply(customerId, await clearManualLogo(activeConnectionId, customerId));
    });

  const reloadAll = async () => {
    setReloadingAll(true);
    try {
      for (const customer of customers) {
        if (entries.get(customer.id)?.source === "manual") continue;
        await run(customer.id, () => reload(customer.id));
      }
    } finally {
      setReloadingAll(false);
    }
  };

  return (
    <SettingsPage
      title={t("adversum.logos.title")}
      description={t("adversum.logos.description")}
    >
      <SettingsList title={t("adversum.logos.display")}>
        <SettingsRow
          label={t("adversum.logos.indicator")}
          description={t("adversum.logos.indicatorDescription")}
        >
          <Segmented<CustomerIndicator>
            ariaLabel={t("adversum.logos.indicator")}
            value={settings.customerIndicator}
            onChange={(value) => void update("customerIndicator", value)}
            options={[
              { value: "logo", label: t("adversum.logos.indicatorLogo") },
              { value: "dots", label: t("adversum.logos.indicatorDots") },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          label={t("adversum.logos.logoDevKey")}
          description={t("adversum.logos.logoDevKeyDescription")}
        >
          <div className="w-[190px]">
            <TextInput
              mono
              value={tokenDraft}
              onChange={setTokenDraft}
              placeholder="pk_…"
            />
          </div>
          <button
            type="button"
            className={buttonClass()}
            disabled={tokenDraft.trim() === settings.logoDevToken}
            onClick={() => void update("logoDevToken", tokenDraft.trim())}
          >
            {t("common.save")}
          </button>
        </SettingsRow>
      </SettingsList>

      {!enabled ? (
        <SettingsNote>{t("adversum.logos.noConnection")}</SettingsNote>
      ) : customersQ.isLoading ? (
        <SettingsNote>{t("common.loading")}</SettingsNote>
      ) : customers.length === 0 ? (
        <SettingsNote>{t("adversum.logos.empty")}</SettingsNote>
      ) : (
        <SettingsList
          title={t("adversum.logos.customers")}
          description={t("adversum.logos.dropHint")}
        >
          <SettingsRow
            label={t("adversum.logos.reloadAll")}
            description={t("adversum.logos.reloadAllDescription")}
          >
            <button
              type="button"
              className={buttonClass()}
              disabled={reloadingAll}
              onClick={() => void reloadAll()}
            >
              {reloadingAll ? t("common.loading") : t("adversum.logos.reload")}
            </button>
          </SettingsRow>
          {customers.map((customer) => (
            <CustomerLogoRow
              key={customer.id}
              customer={customer}
              entry={entries.get(customer.id)}
              lookup={homepages.lookups?.get(customer.id)}
              busy={busyIds.includes(customer.id)}
              isDropTarget={dropTargetId === customer.id}
              failureKey={failures[customer.id] ?? null}
              onDropTarget={setDropTargetId}
              onFile={(file) => applyFile(customer.id, file)}
              onReload={() => void run(customer.id, () => reload(customer.id))}
              onReset={() => void resetLogo(customer.id)}
            />
          ))}
        </SettingsList>
      )}
    </SettingsPage>
  );
}

interface CustomerLogoRowProps {
  customer: KimaiCustomer;
  entry: LogoEntry | undefined;
  /** The customer's homepage as Kimai reports it right now. */
  lookup: HomepageLookup | undefined;
  busy: boolean;
  isDropTarget: boolean;
  failureKey: string | null;
  onDropTarget: (customerId: number | null) => void;
  onFile: (file: File | null | undefined) => void;
  onReload: () => void;
  onReset: () => void;
}

function CustomerLogoRow({
  customer,
  entry,
  lookup,
  busy,
  isDropTarget,
  failureKey,
  onDropTarget,
  onFile,
  onReload,
  onReset,
}: CustomerLogoRowProps) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);

  const homepage = lookup?.homepage ?? entry?.homepage ?? null;
  // Why there is no logo: an action that just failed, Kimai not answering,
  // or the reason the last lookup recorded.
  const problem = failureKey
    ? t(failureKey)
    : lookup?.failed
      ? t("adversum.logos.problem.lookupFailed")
      : entry?.source === "none" && entry.problem
        ? t(`adversum.logos.problem.${entry.problem}`, { detail: entry.detail ?? "" })
        : null;

  const allowDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    onDropTarget(customer.id);
  };

  return (
    <div
      data-settings-item
      data-testid={`customer-logo-${customer.id}`}
      onDragEnter={allowDrop}
      onDragOver={allowDrop}
      onDragLeave={() => onDropTarget(null)}
      onDrop={(event) => {
        event.preventDefault();
        onDropTarget(null);
        if (!busy) onFile(event.dataTransfer.files[0]);
      }}
      className={`flex min-h-[52px] items-center gap-3 px-4 py-2.5 transition-colors ${
        isDropTarget ? "bg-[var(--accent-soft)]" : ""
      }`}
    >
      <CustomerAvatar
        name={customer.name}
        color={customer.color || customer["color-safe"] || ""}
        logo={entry?.dataUrl}
        size={PREVIEW_SIZE}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-[var(--s-fg)]">
          {customer.name}
        </div>
        <div className="truncate text-[11.5px] text-[var(--s-fg-subtle)]" data-logo-source>
          {t(sourceLabelKey(entry))}
          {homepage && ` · ${homepage}`}
        </div>
        {problem && (
          <div
            data-logo-problem
            className={`text-[11.5px] ${
              failureKey
                ? "text-red-500 dark:text-red-400"
                : "text-amber-600 dark:text-amber-400"
            }`}
          >
            {problem}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          aria-label={t("adversum.logos.chooseFor", { customer: customer.name })}
          onChange={(event) => {
            onFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {t("adversum.logos.choose")}
        </button>
        {entry?.source === "manual" ? (
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            disabled={busy}
            onClick={onReset}
          >
            {t("adversum.logos.reset")}
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            disabled={busy}
            onClick={onReload}
          >
            {t("adversum.logos.reload")}
          </button>
        )}
      </div>
    </div>
  );
}
