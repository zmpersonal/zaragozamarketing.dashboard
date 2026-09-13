/**
 * Service-account access token for the prove/ scripts.
 *
 * GOOGLE_SERVICE_ACCOUNT_FILE holds the PATH to the service-account key
 * (kept outside the repo). The key is read here and handed straight to the
 * same signer ingest uses (src/lib/google-auth.ts). Nothing from the file is
 * ever printed: failures name the variable and the path, never the contents.
 * Domain-wide delegation must allow this service account the gmail.readonly
 * scope; the mailbox is impersonated as the JWT subject.
 */
import { readFileSync, existsSync } from 'node:fs';
import { GMAIL_READONLY, parseServiceAccount, serviceAccountToken } from '../src/lib/google-auth.ts';

export async function gmailAccessToken(mailbox, fail) {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE === undefined && existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
  const path = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (!path) fail('Set GOOGLE_SERVICE_ACCOUNT_FILE to the path of the service-account key file.');

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`GOOGLE_SERVICE_ACCOUNT_FILE could not be read (${err.code ?? 'error'}): ${path}`);
  }

  let key;
  try {
    key = parseServiceAccount(raw);
  } catch (err) {
    fail(`GOOGLE_SERVICE_ACCOUNT_FILE is not a usable service-account key: ${err.message}`);
  }

  try {
    return await serviceAccountToken(key, mailbox, GMAIL_READONLY);
  } catch (err) {
    fail(`${err.message}\n  If this is unauthorized_client, check domain-wide delegation grants gmail.readonly to this service account.`);
  }
}
