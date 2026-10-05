import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as asyncStorage from '#platform/server/asyncStorage';
import * as aql from '#server/aql';
import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { Action } from '#server/rules/action';

import {
  ensureFormulaPreferencesLoaded,
  resetFormulaPreferencesCache,
} from './bootstrap';
import { loadUserPreferencesForFormulas } from './customFunctionsPreferences';

function executeFormula(
  formula: string,
  formulaPreferences?: Awaited<
    ReturnType<typeof loadUserPreferencesForFormulas>
  >,
) {
  const action = new Action('set', 'notes', null, { formula });
  const transaction = { notes: '', _formulaPreferences: formulaPreferences };

  action.exec(transaction);

  return transaction.notes;
}

describe('formula preference bootstrap', () => {
  beforeEach(async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    await (global as any).emptyDatabase()();
    vi.clearAllMocks();
    resetFormulaPreferencesCache();
  });

  it('reloads cached user preferences after reset', async () => {
    await ensureFormulaPreferencesLoaded();
    expect(executeFormula('=FORMATNUMBER(1234.5, 2)')).toBe('1,234.50');

    await db.update('preferences', {
      id: 'numberFormat',
      value: 'dot-comma',
    });

    resetFormulaPreferencesCache();
    await ensureFormulaPreferencesLoaded();

    expect(executeFormula('=FORMATNUMBER(1234.5, 2)')).toBe('1.234,50');
  });

  it('keeps concurrent budget formula formatting isolated by currency', async () => {
    await db.update('preferences', {
      id: 'flags.currency',
      value: 'true',
    });
    await db.update('budgets', { id: 'default', currency_code: 'EUR' });
    await db.insertWithSchema('budgets', {
      id: 'yen-budget',
      name: 'JPY budget',
      currency_code: 'JPY',
      budget_type: 'envelope',
      sort_order: 1,
    });

    const [euroPreferences, yenPreferences] = await Promise.all([
      loadUserPreferencesForFormulas({ budgetId: 'default' }),
      loadUserPreferencesForFormulas({ budgetId: 'yen-budget' }),
    ]);
    const [euroResult, yenResult] = await Promise.all([
      Promise.resolve().then(() =>
        executeFormula('=FORMATCURRENCY(1234)', euroPreferences),
      ),
      Promise.resolve().then(() =>
        executeFormula('=FORMATCURRENCY(1234)', yenPreferences),
      ),
    ]);

    expect(euroResult).toContain('€');
    expect(yenResult).toContain('¥');
    expect(euroResult).not.toBe(yenResult);
  });

  it('does not use the legacy global default currency for formula formatting', async () => {
    await expect(
      runHandler(handlers['preferences/save'], {
        id: 'defaultCurrencyCode',
        value: 'EUR',
      } as never),
    ).rejects.toThrow('Preference is no longer supported: defaultCurrencyCode');

    await db.update('preferences', {
      id: 'defaultCurrencyCode',
      value: 'EUR',
    });
    await db.update('preferences', {
      id: 'flags.currency',
      value: 'true',
    });

    const preferences = await loadUserPreferencesForFormulas({
      budgetId: 'default',
    });

    expect(preferences.currency.code).toBe('');
  });

  it('infers number separators from locale formatting', async () => {
    const preferences = await loadUserPreferencesForFormulas({
      selectedLocale: 'de-DE',
    });

    expect(preferences.numberFormat).toBe('dot-comma');
    expect(preferences.decimalPlaces).toBe(2);
    expect(preferences.thousandsSeparator).toBe('.');
    expect(preferences.decimalSeparator).toBe(',');
  });

  it('loads hidden fraction preference for formula number formatting', async () => {
    await db.update('preferences', {
      id: 'hideFraction',
      value: 'true',
    });

    const preferences = await loadUserPreferencesForFormulas();

    expect(preferences.decimalPlaces).toBe(0);
  });

  it('loads formula preferences with one preferences query', async () => {
    const aqlQuerySpy = vi.spyOn(aql, 'aqlQuery');

    await loadUserPreferencesForFormulas();

    expect(aqlQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('reloads cached user preferences after relevant synced preferences change', async () => {
    await ensureFormulaPreferencesLoaded();
    expect(executeFormula('=FORMATNUMBER(1234.5)')).toBe('1,234.50');

    await runHandler(handlers['preferences/save'], {
      id: 'numberFormat',
      value: 'dot-comma',
    });
    await ensureFormulaPreferencesLoaded();

    expect(executeFormula('=FORMATNUMBER(1234.5)')).toBe('1.234,50');
  });

  it('reloads cached user preferences after hide fraction changes', async () => {
    await ensureFormulaPreferencesLoaded();
    expect(executeFormula('=FORMATNUMBER(1234.5)')).toBe('1,234.50');

    await runHandler(handlers['preferences/save'], {
      id: 'hideFraction',
      value: 'true',
    });
    await ensureFormulaPreferencesLoaded();

    expect(executeFormula('=FORMATNUMBER(1234.5)')).toBe('1,235');
  });

  it('keeps cached user preferences after unrelated synced preferences change', async () => {
    await ensureFormulaPreferencesLoaded();
    await db.update('preferences', {
      id: 'numberFormat',
      value: 'dot-comma',
    });

    await runHandler(handlers['preferences/save'], {
      id: 'dateFormat',
      value: 'dd/MM/yyyy',
    });
    await ensureFormulaPreferencesLoaded();

    expect(executeFormula('=FORMATNUMBER(1234.5, 2)')).toBe('1,234.50');
  });

  it('reloads cached user preferences after language changes', async () => {
    await ensureFormulaPreferencesLoaded();
    expect(executeFormula('=FORMATNUMBER(1234.5, 2)')).toBe('1,234.50');

    await runHandler(handlers['save-global-prefs'], {
      language: 'de-DE',
    });
    vi.mocked(asyncStorage.getItem).mockResolvedValue('de-DE');
    await ensureFormulaPreferencesLoaded();

    expect(vi.mocked(asyncStorage.setItem)).toHaveBeenCalledWith(
      'language',
      'de-DE',
    );
    expect(executeFormula('=FORMATNUMBER(1234.5, 2)')).toBe('1.234,50');
  });
});
