import { useState } from "react";
import { Form } from "react-aria-components";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@actual-app/components/button";
import { FormError } from "@actual-app/components/form-error";
import { Input } from "@actual-app/components/input";
import { Paragraph } from "@actual-app/components/paragraph";
import { Select } from "@actual-app/components/select";
import { Text } from "@actual-app/components/text";
import { View } from "@actual-app/components/view";
import { send } from "@actual-app/core/platform/client/connection";
import { useQueryClient } from "@tanstack/react-query";

import { budgetSpaceQueries } from "#budget-spaces/queries";
import { Modal, ModalCloseButton, ModalHeader } from "#components/common/Modal";
import { useCurrencyOptions } from "#hooks/useCurrencyOptions";
import { useMetadataPref } from "#hooks/useMetadataPref";
import { useNavigate } from "#hooks/useNavigate";
import type { Modal as ModalType } from "#modals/modalsSlice";
import { budgetRoutes } from "#util/budget-routes";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type CreateProps = Extract<
  ModalType,
  { name: "budget-space-create" }
>["options"];

export function CreateBudgetSpaceModal({
  defaultCurrencyCode = "",
}: CreateProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fileId] = useMetadataPref("id");
  const { currencyOptions } = useCurrencyOptions({ includeNone: false });
  const [currencyCode, setCurrencyCode] = useState(defaultCurrencyCode);
  const [name, setName] = useState(defaultCurrencyCode);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const onCurrencyChange = (code: string) => {
    setCurrencyCode(code);
    setName(code);
  };

  return (
    <Modal name="budget-space-create" isLoading={isSaving}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t("Create budget space")}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <Form
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              const trimmedName = name.trim();
              if (!trimmedName || !currencyCode) {
                setError(t("Enter a budget space name and choose a currency."));
                return;
              }

              setIsSaving(true);
              try {
                const created = await send("budget-spaces/create", {
                  name: trimmedName,
                  currencyCode,
                });
                const spaces = await send("budget-spaces/get");
                queryClient.setQueryData(
                  budgetSpaceQueries.list(fileId).queryKey,
                  spaces
                );
                state.close();
                await navigate(budgetRoutes.budget(created.id));
              } catch (saveError) {
                setError(errorMessage(saveError));
              } finally {
                setIsSaving(false);
              }
            }}
          >
            <View style={{ gap: 16, maxWidth: 550 }}>
              <Paragraph style={{ marginBottom: 0 }}>
                <Trans>
                  Use a separate budget space to keep track of accounts in
                  another currency. Each budget space has its own categories and
                  dashboard.
                </Trans>
              </Paragraph>
              <label style={{ display: "grid", gap: 6 }}>
                <Text>
                  <Trans>Currency</Trans>
                </Text>
                <Select
                  aria-label={t("Currency")}
                  value={currencyCode}
                  onChange={onCurrencyChange}
                  options={currencyOptions}
                />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <Text>
                  <Trans>Budget space name</Trans>
                </Text>
                <Input
                  aria-label={t("Budget space name")}
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
              {error && <FormError>{error}</FormError>}
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "flex-end",
                  gap: 8,
                }}
              >
                <Button onPress={() => state.close()}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  isDisabled={isSaving || !name.trim() || !currencyCode}
                >
                  <Trans>Create</Trans>
                </Button>
              </View>
            </View>
          </Form>
        </>
      )}
    </Modal>
  );
}

type CurrencyRequiredProps = Extract<
  ModalType,
  { name: "budget-space-currency-required" }
>["options"];

export function BudgetSpaceCurrencyRequiredModal({
  budgetId,
  budgetName,
}: CurrencyRequiredProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Modal name="budget-space-currency-required">
      {({ state }) => (
        <>
          <ModalHeader
            title={t("Choose a currency first")}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ gap: 16 }}>
            <Paragraph>
              <Trans>
                Before you can create a new budget space, first set a currency
                for your budget space '{{ name: budgetName }}'.
              </Trans>
            </Paragraph>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <Button onPress={() => state.close()}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                variant="primary"
                onPress={() => {
                  state.close();
                  void navigate(budgetRoutes.settings(budgetId));
                }}
              >
                <Trans>Set currency</Trans>
              </Button>
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}
