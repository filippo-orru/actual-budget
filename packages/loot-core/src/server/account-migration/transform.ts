import { convertAmount } from '#server/exchange-rates/convert';
import { getDecimalPlaces } from '#shared/currencies';
import type { TransactionEntity } from '#types/models';

export const RECONCILIATION_ADJUSTMENT_NOTE =
  'Reconciliation balance adjustment';

export type MigrationTransaction = TransactionEntity & {
  subtransactions?: TransactionEntity[];
};

export type MigrationTransformOptions = {
  sourceAccountId: string;
  destinationAccountId: string;
  inputCurrency: string;
  destinationCurrency: string;
  rates: Record<string, number>;
  idForSource: (sourceId: string) => string;
  adjustmentId: string;
  migrationDate: string;
  targetBalance?: number;
  adjustmentNote?: string;
};

export type MigrationTransformResult = {
  transactions: TransactionEntity[];
  excluded: Array<{ id: string; reason: 'reconciliation-adjustment' }>;
  partialSplitExclusions: Array<{ id: string; excludedChildIds: string[] }>;
  convertedTotal: number;
  adjustment: number;
  finalBalance: number;
  representativeTransactions: Array<{
    id: string;
    date: string;
    sourceAmount: number;
    destinationAmount: number;
  }>;
};

function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is not a safe integer`);
  }
  return value;
}

export function isReconciliationAdjustment(
  transaction: Pick<TransactionEntity, 'notes'>,
): boolean {
  return transaction.notes?.includes(RECONCILIATION_ADJUSTMENT_NOTE) ?? false;
}

export function getRetainedTransactions(
  rows: MigrationTransaction[],
): TransactionEntity[] {
  return rows.flatMap(row => {
    if (isReconciliationAdjustment(row)) return [];
    if (!row.is_parent) return [row];
    return (row.subtransactions ?? []).filter(
      child => !isReconciliationAdjustment(child),
    );
  });
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid transaction date: ${date}`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Invalid transaction date: ${date}`);
  }
}

function rateForDate(
  date: string,
  inputCurrency: string,
  destinationCurrency: string,
  rates: Record<string, number>,
): number {
  validateDate(date);
  if (inputCurrency === destinationCurrency) return 1;
  const rate = rates[date];
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Missing or invalid exchange rate for ${date}`);
  }
  return rate;
}

function scaleAmount(
  amount: number,
  date: string,
  options: MigrationTransformOptions,
): number {
  assertSafeInteger(amount, 'Transaction amount');
  const rate = rateForDate(
    date,
    options.inputCurrency,
    options.destinationCurrency,
    options.rates,
  );
  return assertSafeInteger(
    options.inputCurrency === options.destinationCurrency
      ? amount
      : convertAmount(
          amount,
          rate,
          getDecimalPlaces(options.inputCurrency),
          getDecimalPlaces(options.destinationCurrency),
        ),
    'Converted amount',
  );
}

function copyFields(
  source: TransactionEntity,
  id: string,
  account: string,
  amount: number,
  category: string | null,
  parentId?: string,
): TransactionEntity {
  return {
    id,
    account,
    amount,
    date: source.date,
    notes: source.notes,
    payee: source.transfer_id ? null : (source.payee ?? null),
    ...(category ? { category } : {}),
    cleared: source.cleared,
    reconciled: false,
    starting_balance_flag: source.starting_balance_flag,
    sort_order: source.sort_order,
    imported_id: source.imported_id,
    imported_payee: source.imported_payee,
    is_parent: source.is_parent,
    is_child: source.is_child,
    ...(parentId ? { parent_id: parentId } : {}),
    tombstone: false,
    error: null,
    raw_synced_data: undefined,
    _unmatched: undefined,
    _deleted: undefined,
    _ruleErrors: undefined,
  };
}

function distributeSplitResidual(
  sourceChildren: TransactionEntity[],
  convertedChildren: number[],
  targetTotal: number,
  options: MigrationTransformOptions,
): number[] {
  const residual =
    targetTotal - convertedChildren.reduce((sum, amount) => sum + amount, 0);
  assertSafeInteger(residual, 'Split rounding residual');
  if (residual === 0) return convertedChildren;

  const decimalsFrom = getDecimalPlaces(options.inputCurrency);
  const decimalsTo = getDecimalPlaces(options.destinationCurrency);
  const rate = rateForDate(
    sourceChildren[0].date,
    options.inputCurrency,
    options.destinationCurrency,
    options.rates,
  );
  const ranked = sourceChildren.map((child, index) => {
    const exact = (child.amount / 10 ** decimalsFrom) * rate * 10 ** decimalsTo;
    const rounded = convertedChildren[index];
    return {
      index,
      difference: exact - rounded,
      id: child.id,
    };
  });
  ranked.sort((a, b) => {
    const byFraction =
      residual > 0 ? b.difference - a.difference : a.difference - b.difference;
    return byFraction || a.id.localeCompare(b.id);
  });

  const result = [...convertedChildren];
  const direction = Math.sign(residual);
  for (let i = 0; i < Math.abs(residual); i++) {
    const index = ranked[i % ranked.length].index;
    result[index] = assertSafeInteger(
      result[index] + direction,
      'Split child amount',
    );
  }
  return result;
}

export function transformAccountTransactions(
  sourceRows: MigrationTransaction[],
  options: MigrationTransformOptions,
): MigrationTransformResult {
  if (!options.inputCurrency || !options.destinationCurrency) {
    throw new Error('A known input and destination currency is required');
  }
  validateDate(options.migrationDate);

  const transactions: TransactionEntity[] = [];
  const excluded: MigrationTransformResult['excluded'] = [];
  const partialSplitExclusions: MigrationTransformResult['partialSplitExclusions'] =
    [];
  let convertedTotal = 0;
  const representativeTransactions: MigrationTransformResult['representativeTransactions'] =
    [];

  for (const source of sourceRows) {
    if (source.account !== options.sourceAccountId || source.is_child) {
      throw new Error(`Unexpected top-level transaction row: ${source.id}`);
    }
    if (isReconciliationAdjustment(source)) {
      excluded.push({ id: source.id, reason: 'reconciliation-adjustment' });
      for (const child of source.subtransactions ?? []) {
        excluded.push({ id: child.id, reason: 'reconciliation-adjustment' });
      }
      continue;
    }

    if (source.is_parent) {
      const children = source.subtransactions ?? [];
      if (children.length === 0) {
        throw new Error(`Malformed split transaction family: ${source.id}`);
      }
      if (
        children.some(
          child =>
            !child.is_child ||
            child.parent_id !== source.id ||
            child.account !== source.account ||
            child.date !== source.date,
        )
      ) {
        throw new Error(`Malformed split transaction family: ${source.id}`);
      }
      const retained = children.filter(child => {
        if (!isReconciliationAdjustment(child)) return true;
        excluded.push({ id: child.id, reason: 'reconciliation-adjustment' });
        return false;
      });
      if (retained.length !== children.length) {
        partialSplitExclusions.push({
          id: source.id,
          excludedChildIds: children
            .filter(isReconciliationAdjustment)
            .map(child => child.id),
        });
      }
      if (retained.length === 0) {
        excluded.push({ id: source.id, reason: 'reconciliation-adjustment' });
        continue;
      }

      const sourceTotal = assertSafeInteger(
        retained.reduce(
          (sum, child) => sum + assertSafeInteger(child.amount, 'Split amount'),
          0,
        ),
        'Split source total',
      );
      const destinationTotal = scaleAmount(sourceTotal, source.date, options);
      const convertedChildren = retained.map(child =>
        scaleAmount(child.amount, child.date, options),
      );
      const distributed = distributeSplitResidual(
        retained,
        convertedChildren,
        destinationTotal,
        options,
      );
      const parentId = options.idForSource(source.id);
      transactions.push(
        copyFields(
          source,
          parentId,
          options.destinationAccountId,
          destinationTotal,
          null,
        ),
      );
      retained.forEach((child, index) => {
        transactions.push(
          copyFields(
            child,
            options.idForSource(child.id),
            options.destinationAccountId,
            distributed[index],
            child.category ?? null,
            parentId,
          ),
        );
      });
      convertedTotal = assertSafeInteger(
        convertedTotal + destinationTotal,
        'Account total',
      );
      if (representativeTransactions.length < 5) {
        representativeTransactions.push({
          id: source.id,
          date: source.date,
          sourceAmount: sourceTotal,
          destinationAmount: destinationTotal,
        });
      }
      continue;
    }

    const amount = scaleAmount(source.amount, source.date, options);
    if (representativeTransactions.length < 5) {
      representativeTransactions.push({
        id: source.id,
        date: source.date,
        sourceAmount: source.amount,
        destinationAmount: amount,
      });
    }
    transactions.push(
      copyFields(
        source,
        options.idForSource(source.id),
        options.destinationAccountId,
        amount,
        source.category ?? null,
      ),
    );
    convertedTotal = assertSafeInteger(
      convertedTotal + amount,
      'Account total',
    );
  }

  const targetBalance = options.targetBalance;
  if (targetBalance !== undefined) {
    assertSafeInteger(targetBalance, 'Target balance');
  }
  const adjustment =
    targetBalance === undefined
      ? 0
      : assertSafeInteger(targetBalance - convertedTotal, 'Balance adjustment');
  if (adjustment !== 0) {
    transactions.push({
      id: options.adjustmentId,
      account: options.destinationAccountId,
      amount: adjustment,
      date: options.migrationDate,
      notes: options.adjustmentNote ?? 'Migration balance adjustment',
      payee: null,
      cleared: true,
      reconciled: false,
      tombstone: false,
    });
  }

  return {
    transactions,
    excluded,
    partialSplitExclusions,
    convertedTotal,
    adjustment,
    finalBalance: assertSafeInteger(
      convertedTotal + adjustment,
      'Final balance',
    ),
    representativeTransactions,
  };
}
