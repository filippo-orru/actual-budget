function segment(value: string) {
  return encodeURIComponent(value);
}

export const budgetRoutes = {
  spaces: () => '/spaces',
  budget: (budgetId: string) => `/spaces/${segment(budgetId)}/budget`,
  accounts: (budgetId: string) => `/spaces/${segment(budgetId)}/accounts`,
  account: (budgetId: string, accountId: string) =>
    `/spaces/${segment(budgetId)}/accounts/${segment(accountId)}`,
  category: (budgetId: string, categoryId: string) =>
    `/spaces/${segment(budgetId)}/categories/${segment(categoryId)}`,
  transaction: (budgetId: string, transactionId: string) =>
    `/spaces/${segment(budgetId)}/transactions/${segment(transactionId)}`,
  schedules: (budgetId: string, scheduleId?: string) =>
    `/spaces/${segment(budgetId)}/schedules${scheduleId ? `/${segment(scheduleId)}` : ''}`,
  rules: (budgetId: string, ruleId?: string) =>
    `/spaces/${segment(budgetId)}/rules${ruleId ? `/${segment(ruleId)}` : ''}`,
  reports: (budgetId: string, reportPath = '') =>
    `/spaces/${segment(budgetId)}/reports${reportPath ? `/${reportPath.replace(/^\/+/, '')}` : ''}`,
  settings: (budgetId: string) => `/spaces/${segment(budgetId)}/settings`,
  bankSync: (budgetId: string, path = '') =>
    `/spaces/${segment(budgetId)}/bank-sync${path ? `/${path.replace(/^\/+/, '')}` : ''}`,
  payees: (budgetId: string, payeeId?: string) =>
    `/spaces/${segment(budgetId)}/payees${payeeId ? `/${segment(payeeId)}` : ''}`,
  tags: (budgetId: string) => `/spaces/${segment(budgetId)}/tags`,
};

/** Maps the existing short in-app budget URLs to their canonical budget URL. */
export function canonicalizeLegacyBudgetPath(
  pathname: string,
  budgetId: string,
): string | null {
  const exact: Record<string, string> = {
    '/budget': budgetRoutes.budget(budgetId),
    '/accounts': budgetRoutes.accounts(budgetId),
    '/schedules': budgetRoutes.schedules(budgetId),
    '/rules': budgetRoutes.rules(budgetId),
    '/tags': budgetRoutes.tags(budgetId),
    '/payees': budgetRoutes.payees(budgetId),
    '/bank-sync': budgetRoutes.bankSync(budgetId),
  };
  if (exact[pathname]) return exact[pathname];

  const mappings: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [
      /^\/accounts\/([^/]+)$/,
      m => budgetRoutes.account(budgetId, decodeURIComponent(m[1])),
    ],
    [
      /^\/categories\/([^/]+)$/,
      m => budgetRoutes.category(budgetId, decodeURIComponent(m[1])),
    ],
    [
      /^\/transactions\/([^/]+)$/,
      m => budgetRoutes.transaction(budgetId, decodeURIComponent(m[1])),
    ],
    [
      /^\/schedules\/([^/]+)$/,
      m => budgetRoutes.schedules(budgetId, decodeURIComponent(m[1])),
    ],
    [
      /^\/rules\/([^/]+)$/,
      m => budgetRoutes.rules(budgetId, decodeURIComponent(m[1])),
    ],
    [
      /^\/payees\/([^/]+)$/,
      m => budgetRoutes.payees(budgetId, decodeURIComponent(m[1])),
    ],
    [/^\/reports(?:\/(.*))?$/, m => budgetRoutes.reports(budgetId, m[1] ?? '')],
    [
      /^\/bank-sync(?:\/(.*))?$/,
      m => budgetRoutes.bankSync(budgetId, m[1] ?? ''),
    ],
  ];
  for (const [pattern, build] of mappings) {
    const match = pathname.match(pattern);
    if (match) return build(match);
  }
  return null;
}
