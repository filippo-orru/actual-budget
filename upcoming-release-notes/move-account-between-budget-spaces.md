# Move an account to another budget space

Desktop account context menus now include **Move to budget space**. The assistant copies the account's retained transaction history into a new account in another budget space, optionally converting amounts with historical transaction-date exchange rates. It can also reconcile the copied ledger to a user-entered current balance.

The review identifies excluded reconciliation adjustments and linked transfers before the move. Before starting the move, users must confirm that they downloaded a backup using **Export data** in Settings. The assistant does not create a backup automatically. On confirmation, the app detaches transfers that remain in the original space, deletes the original account's transactions, and closes the original account. Historical budgets, reports, and budget availability in the source space change. Restoring the backup restores the entire file and may discard later edits.
