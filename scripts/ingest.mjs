#!/usr/bin/env node
/**
 * Hourly ingest on GitHub Actions (.github/workflows/ingest.yml).
 * Gmail and Quo into D1 over the REST API; see scripts/_ingest-run.mjs.
 *
 * Needs, from the environment (Actions secrets): CLOUDFLARE_API_TOKEN (D1 edit
 * only), CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID,
 * GOOGLE_SERVICE_ACCOUNT_JSON, QUO_API_KEY.
 *
 * It writes to the production database. Running it by hand is a human step.
 */
import { runIngest } from './_ingest-run.mjs';

process.exitCode = await runIngest(process.env);
