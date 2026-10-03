# My profile, CPA quotas and extension UI — 2026-10-03

## Delivered source

The My profile page now presents CPA Grok/Gemini quota cards first, followed by capability/extension status and the existing Codex usage view. The cards show reported total/used/remaining amounts, remaining progress, quota windows, reset times, last successful update, last check and cache/stale state. Opening My resets the panel to the top. Mobile shows the two summaries together. The panel refreshes on opening, supports manual refresh and refreshes every minute while visible.

Extension UI covers current model execution status, the single Windows device acceptance step, device tool integration, and a reserved future customer/multiple-device stage. These are explicit pending states, not new customer/device provisioning or completed Windows functionality. Gemini execution remains paused; quota display does not enable that harness.

## Backend contract and data boundaries

Authenticated administrator GET /providers/cpa/quotas uses the CPA service configured by WITT_CPA_URL and its existing model API credential. Global CPA account quotas are administrator-only; nonadministrators receive 403. Raw credential objects, identities, account indices, project identifiers and upstream errors are never returned to the browser.

Quota management authentication is distinct from the model API key. Supply an operator-authorized local credential file through WITT_CPA_MANAGEMENT_KEY_FILE, or an existing server environment WITT_CPA_MANAGEMENT_KEY. No credential was created, transferred, logged or committed. A missing key gives management_auth_required with null quota values. Unknown account counts remain null, not zero.

The reader follows the existing CPA management HTML's request/response contract: credential metadata from /v0/management/credentials (404 fallback to auth-files), and fixed read-only quota requests through /v0/management/requests/api-call. Grok billing is queried with GET; the Google quota-summary RPC uses POST solely to retrieve quota metadata. No model ping, credential refresh, credential download, or account mutation is performed. Missing project metadata or unsupported response schemas remain explicit unknown/failed quota states.

Only complete absolute amounts sharing unit, window and reset time are summed. Different windows use the lowest reported remaining percentage, explicitly labeled as such; missing absolute totals are never inferred from percentages or token usage. At most six active accounts per family are queried concurrently in a bounded pool. Coverage and skipped/failed accounts are exposed, so subset data is not presented as a complete account total. Requests are bounded by time/body size; redirects are rejected. Results cache for 30 seconds and concurrent reads coalesce. Failed refreshes retain prior successful data with explicit stale status and the original quota timestamp.

## Validation and remaining blockers

- Backend regression: 146/146 PASS; final quota-specific checks: 7/7 PASS.
- Complete UI regression PASS in the working tree and in an isolated committed-source snapshot overlaid only with this group's staged changes, excluding device drafts.
- Added browser checks cover total/progress/unknown amounts, refresh failures, missing management authentication, authorization loss clearing previous quota values, panel close, light/dark and portrait/landscape overflow.
- Final unknown-account/unknown-quota touch checks PASS at 360x800, 390x844 and 844x390 in both themes.
- Light/dark screenshots visually inspected. Screenshot percentages and money values are fixture data, not production quotas; images are not committed.
- Actual CPA /v1/models: 4 Grok model IDs and 9 Gemini model IDs currently discoverable. Discovery is inventory, not the Witt selectable model policy.
- Actual CPA management usage request with the existing model key: HTTP 401. The production Witt service has no CPA management key/file setting. The new reader confirms management_auth_required and null quota amounts.
- Real Grok/Gemini account quota amounts and totals: NOT TESTED until an operator authorizes an existing local CPA management credential file or read-only quota endpoint. Gemini may report only remaining percentages; if no absolute total is supplied it will remain unavailable.

Production was not deployed or restarted. Existing incomplete device/integration modifications remain preserved. Backend/Web continue the same existing immutable release until the required clean-worktree deployment boundary is met.
