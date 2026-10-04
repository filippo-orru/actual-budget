import { describe, expect, it } from 'vitest';

import { budgetSpaceModel } from './models';

describe('budgetSpaceModel', () => {
  it('maps the synced tombstone flag to a boolean and validates budget type', () => {
    expect(
      budgetSpaceModel.fromDb({
        id: 'default',
        name: 'Main',
        currency_code: '',
        budget_type: 'envelope',
        sort_order: 0,
        tombstone: 0,
      }),
    ).toEqual({
      id: 'default',
      name: 'Main',
      currency_code: '',
      budget_type: 'envelope',
      sort_order: 0,
      tombstone: false,
    });

    expect(() =>
      budgetSpaceModel.fromDb({
        id: 'invalid',
        name: 'Invalid',
        currency_code: '',
        budget_type: 'invalid',
        sort_order: 0,
        tombstone: 0,
      }),
    ).toThrow('Unknown budget type');
  });
});
