import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@actual-app/components/button";
import { SvgAdd } from "@actual-app/components/icons/v1";
import { styles } from "@actual-app/components/styles";
import { Text } from "@actual-app/components/text";
import { theme } from "@actual-app/components/theme";
import { spacing } from "@actual-app/components/tokens";
import { Tooltip } from "@actual-app/components/tooltip";
import { View } from "@actual-app/components/view";
import * as monthUtils from "@actual-app/core/shared/months";
import type { BudgetSpaceEntity } from "@actual-app/core/types/models";
import { useQuery } from "@tanstack/react-query";

import {
  convertOverviewBalance,
  mapBudgetBalances,
} from "#budget-spaces/overview";
import { budgetSpaceQueries } from "#budget-spaces/queries";
import { useOpenCreateBudgetSpace } from "#budget-spaces/useOpenCreateBudgetSpace";
import { Link } from "#components/common/Link";
import { CurrencyProvider } from "#components/CurrencyProvider";
import { FinancialText } from "#components/FinancialText";
import { useBudgetOverview } from "#hooks/useBudgetOverview";
import { useBudgetSpace } from "#hooks/useBudgetSpace";
import { useContextMenu } from "#hooks/useContextMenu";
import { useCurrencyRates } from "#hooks/useExchangeRates";
import { useFeatureFlag } from "#hooks/useFeatureFlag";
import { useFormat } from "#hooks/useFormat";
import { useMetadataPref } from "#hooks/useMetadataPref";
import { useNavigate } from "#hooks/useNavigate";
import { usePrivacyMode } from "#hooks/usePrivacyMode";
import { budgetRoutes } from "#util/budget-routes";
import { isTouchDevice } from "#util/isTouchDevice";

function BudgetSpaceAmount({
  budget,
  amount,
  targetCurrency,
  isSelected,
  shouldConvert,
  rate,
  isOffline,
  isRateError,
  isOverviewError,
  today,
}: {
  budget: BudgetSpaceEntity;
  amount: number | null;
  targetCurrency: string;
  isSelected: boolean;
  shouldConvert: boolean;
  rate: number | null | undefined;
  isOffline: boolean;
  isRateError: boolean;
  isOverviewError: boolean;
  today: string;
}) {
  const { t } = useTranslation();
  const isPrivate = usePrivacyMode();
  const sourceCurrency = budget.currency_code ?? "";
  const worthConverting =
    shouldConvert &&
    !!sourceCurrency &&
    !!targetCurrency &&
    sourceCurrency !== targetCurrency;
  const canConvert = !isSelected && worthConverting;
  const converted =
    canConvert && amount != null
      ? convertOverviewBalance(amount, rate, sourceCurrency, targetCurrency)
      : null;

  if (isPrivate) {
    return (
      <Text style={{ color: theme.sidebarTextSubdued, fontSize: 12 }}>
        ••••••
      </Text>
    );
  }

  if (amount == null) {
    return (
      <Text style={{ color: theme.sidebarTextSubdued, fontSize: 12 }}>
        {isOverviewError ? "—" : <Trans>Loading…</Trans>}
      </Text>
    );
  }

  const nativeTotal = (
    <CurrencyProvider currencyCode={sourceCurrency}>
      <FormattedAmount amount={amount} />
    </CurrencyProvider>
  );
  const nativeLabel = (
    <Text>
      {sourceCurrency && `${sourceCurrency}: `}
      {nativeTotal}
      {sourceCurrency && ` ${sourceCurrency}`}
    </Text>
  );
  const nativeAmountLabel = (
    <>
      {nativeTotal}
      {sourceCurrency && worthConverting && ` ${sourceCurrency}`}
    </>
  );

  if (!canConvert) {
    return (
      <Text style={{ color: theme.sidebarTextSubdued, fontSize: 12 }}>
        {nativeAmountLabel}
      </Text>
    );
  }

  const nativeTooltip = (
    <View style={{ gap: spacing.xs }}>
      {nativeLabel}
      {converted == null && (rate !== undefined || isRateError) && (
        <Text>
          {t("Exchange rate {{from}}/{{to}} is unavailable for {{date}}.", {
            from: sourceCurrency,
            to: targetCurrency,
            date: today,
          })}
        </Text>
      )}
      {isOffline && (
        <Text>
          <Trans>
            The rate could not be refreshed while offline. A cached rate may be
            in use.
          </Trans>
        </Text>
      )}
    </View>
  );

  if (converted == null) {
    return (
      <Tooltip content={nativeTooltip}>
        <Text
          tabIndex={0}
          aria-label={t(
            "Converted balance unavailable. Native balance is available in the tooltip."
          )}
          style={{ color: theme.sidebarTextSubdued, fontSize: 12 }}
        >
          {rate === undefined && !isRateError ? t("Loading…") : "—"}
        </Text>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={nativeTooltip}>
      <Text
        tabIndex={0}
        aria-label={t(
          "Approximate converted balance. Native balance is available in the tooltip."
        )}
        style={{ color: theme.sidebarTextSubdued, fontSize: 12 }}
      >
        ≈{" "}
        <CurrencyProvider currencyCode={targetCurrency}>
          <FormattedAmount amount={converted} />
        </CurrencyProvider>
      </Text>
    </Tooltip>
  );
}

function BudgetSpaceRow({
  budget,
  selected,
  children,
}: {
  budget: BudgetSpaceEntity;
  selected: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLDivElement>(null);

  useContextMenu({
    triggerRef,
    enabled: !isTouchDevice(),
    items: [
      {
        name: "budget-space-settings",
        text: t("Settings"),
        onClick: () => void navigate(budgetRoutes.settings(budget.id)),
      },
    ],
  });

  return (
    <View
      innerRef={triggerRef}
      style={{ flexShrink: 0 }}
      data-testid={`sidebar-budget-${budget.id}`}
    >
      <Link
        variant="internal"
        to={
          selected
            ? budgetRoutes.settings(budget.id)
            : budgetRoutes.budget(budget.id)
        }
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          minWidth: 0,
          marginTop: -2,
          marginBottom: 2,
          paddingTop: 4,
          paddingBottom: 4,
          paddingRight: 15,
          paddingLeft: 10,
          borderLeft: `4px solid ${
            selected ? theme.sidebarItemAccentSelected : "transparent"
          }`,
          textDecoration: "none",
          color: selected
            ? theme.sidebarItemTextSelected
            : theme.sidebarItemText,
          ":hover": { backgroundColor: theme.sidebarItemBackgroundHover },
          ...styles.smallText,
        }}
        activeStyle={{ color: theme.sidebarItemTextSelected }}
      >
        <Text
          style={{
            flex: 1,
            minWidth: 0,
            ...styles.ellipsisText,
            fontWeight: selected ? 600 : "normal",
          }}
        >
          {budget.name}
        </Text>
        {children}
      </Link>
    </View>
  );
}

function FormattedAmount({ amount }: { amount: number }) {
  const format = useFormat();
  return <FinancialText>{format(amount, "financial")}</FinancialText>;
}

export function BudgetSpacesSection() {
  const { t } = useTranslation();
  const selectedBudget = useBudgetSpace();
  const [fileId] = useMetadataPref("id");
  const { data: budgetSpaces = [], isLoading: isBudgetListLoading } = useQuery(
    budgetSpaceQueries.list(fileId)
  );
  const activeBudgets = budgetSpaces.filter((budget) => !budget.tombstone);
  const {
    rows,
    isLoading: isOverviewLoading,
    error: overviewError,
  } = useBudgetOverview();
  const balances = rows == null ? null : mapBudgetBalances(activeBudgets, rows);
  const multiBudgetEnabled = useFeatureFlag("multiCurrency");
  const currencyEnabled = useFeatureFlag("currency");
  const shouldConvert = multiBudgetEnabled && currencyEnabled;
  const today = useTodayWithRollover();
  const sourceCurrencies = useMemo(
    () =>
      [
        ...new Set(
          activeBudgets
            .filter((budget) => {
              const balance = balances?.[budget.id];
              return (
                budget.id !== selectedBudget.id &&
                !!budget.currency_code &&
                budget.currency_code !== selectedBudget.currency_code &&
                balance != null &&
                balance !== 0
              );
            })
            .map((budget) => budget.currency_code)
            .filter((code): code is string => Boolean(code))
        ),
      ].sort(),
    [activeBudgets, balances, selectedBudget.currency_code, selectedBudget.id]
  );
  const { rates, offlineCurrencies, failedCurrencies } = useCurrencyRates(
    sourceCurrencies,
    selectedBudget.currency_code ?? "",
    today,
    { enabled: shouldConvert }
  );
  const openCreate = useOpenCreateBudgetSpace();

  return (
    <View
      style={{
        flexShrink: 0,
        paddingBottom: 15,
        borderBottom: `1px solid ${theme.sidebarBorder}`,
        marginBottom: 15,
      }}
      data-testid="sidebar-budget-spaces"
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.xs,
          padding: `${spacing.xs}px ${spacing.md}px`,
          marginBottom: spacing.xs,
        }}
      >
        <Text
          style={{
            flex: 1,
            color: theme.sidebarHeaderText,
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          <Trans>Budget Spaces</Trans>
        </Text>
        {multiBudgetEnabled && (
          <Button
            variant="bare"
            aria-label={t("Create budget space")}
            onPress={() => void openCreate()}
            style={{ padding: 3, color: theme.sidebarTextSubdued }}
          >
            <SvgAdd width={14} height={14} />
          </Button>
        )}
      </View>
      {isBudgetListLoading ? (
        <Text
          style={{
            padding: `${spacing.xs}px ${spacing.md}px`,
            color: theme.sidebarTextSubdued,
          }}
        >
          <Trans>Loading…</Trans>
        </Text>
      ) : (
        activeBudgets.map((budget) => {
          const selected = budget.id === selectedBudget.id;
          const balance =
            isOverviewLoading || overviewError
              ? null
              : balances?.[budget.id] ?? 0;
          const sourceCode = budget.currency_code ?? "";
          const quote = sourceCurrencies.includes(sourceCode)
            ? rates[sourceCode]
            : sourceCode === selectedBudget.currency_code
            ? 1
            : undefined;

          return (
            <BudgetSpaceRow key={budget.id} budget={budget} selected={selected}>
              <BudgetSpaceAmount
                budget={budget}
                amount={balance}
                targetCurrency={selectedBudget.currency_code ?? ""}
                isSelected={selected}
                shouldConvert={shouldConvert}
                rate={quote}
                isOffline={offlineCurrencies.includes(sourceCode)}
                isRateError={failedCurrencies.includes(sourceCode)}
                isOverviewError={overviewError != null}
                today={today}
              />
            </BudgetSpaceRow>
          );
        })
      )}
    </View>
  );
}

function useTodayWithRollover() {
  const [today, setToday] = useState(() => monthUtils.currentDay());

  useEffect(() => {
    const updateToday = () => setToday(monthUtils.currentDay());
    const timer = window.setInterval(updateToday, 60_000);
    window.addEventListener("focus", updateToday);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", updateToday);
    };
  }, []);

  return today;
}
