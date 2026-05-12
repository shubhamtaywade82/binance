/**
 * @deprecated The dashboard WebSocket is served by the main bot process when `DASHBOARD_ENABLED=true`.
 * Use: `DASHBOARD_ENABLED=true npm run dev` (or `npm start` after build).
 * The old standalone server opened a **second** Binance multiplex connection; that path was removed
 * so market data stays a single source of truth.
 */
process.stderr.write(
  [
    '[dashboard] This entry point is removed.',
    'Run the bot with the dashboard enabled, e.g.:',
    '  DASHBOARD_ENABLED=true npm run dev',
    'Then in another terminal (optional UI): npm run ui:dev',
    '',
  ].join('\n'),
);
process.exit(1);
