# PostHog Self-driving setup report

## Summary

PostHog Self-driving has been configured for project 610214. Session Replay, Error Tracking, and Support were enabled; health, error-tracking, and support ticket signal sources were wired to the inbox. Findings from fresh scouts and Replay Vision monitors should begin appearing in the [Self-driving inbox](https://us.posthog.com/project/610214/inbox) within about 30 minutes once eligible data arrives.

No application source code was changed. The repository contains a backend `posthog-node` integration for Strapi article lifecycle events and exception capture; no browser `posthog-js` initialization was found.

## AI data processing

Approved.

## GitHub

The PostHog GitHub App was already connected before this setup. GitHub Issues was not selected in the connected-tools step, so no GitHub Issues responder was enabled.

## Products enabled

| Product | Result | Notes |
| --- | --- | --- |
| Session Replay | Enabled but inert | The server-side recording toggle is on, but this repository has no browser SDK initialization to record sessions. |
| Error Tracking | Enabled | The Strapi backend includes explicit exception capture and exception autocapture configuration. |
| Support | Enabled | An inbound email, inbox, or Slack channel is still required before tickets arrive. |

## Signal sources

| Source product | Source type | Action |
| --- | --- | --- |
| `signals_scout` | `cross_source_issue` | On by default; no opt-out row existed, so no row was created. |
| `health_checks` | `health_issue` | Enabled (source ID `01a0a41d-006e-71a7-94da-54749b60294c`). |
| `error_tracking` | `issue_created` | Enabled (source ID `01a0a41d-0017-71f9-bb6c-954369895655`). |
| `error_tracking` | `issue_reopened` | Enabled (source ID `01a0a41c-ffe0-7e26-91fd-e379220640c7`). |
| `error_tracking` | `issue_spiking` | Enabled (source ID `01a0a41d-0011-7506-922e-3fa0e9d35f32`). |
| `conversations` | `ticket` | Enabled (source ID `01a0a41d-006d-7a2f-8f89-988fb9caa48d`); remains idle until a support channel is connected. |
| `session_replay` | `session_analysis_cluster` | Deliberately skipped; this retired route is replaced by Replay Vision scanners below. |

## Connected tools

No external tool was selected (the connected-tools picker was cancelled), so no data warehouse sources or connected-tool responders were added. The GitHub integration remains connected, but its Issues responder was intentionally left off.

## Scout troop

**Enabled scouts**

| Scout | Why it is active |
| --- | --- |
| `signals-scout-general` | Cross-product correlations and surfaces not owned by a specialist. |
| `signals-scout-health-checks` | Actionable PostHog setup and instrumentation health issues. |

**Disabled scouts (25)**

| Scout or group | Why it remains disabled |
| --- | --- |
| `signals-scout-error-tracking` | Covered by the enabled native Error Tracking source. |
| `signals-scout-session-replay` | Covered by the Replay Vision monitors created below. |
| `signals-scout-ai-observability`, `signals-scout-apm`, `signals-scout-logs` | No AI traces, APM, or logs product usage was confirmed. |
| `signals-scout-conversations` | Support is newly enabled but has no inbound channel or ticket activity yet. |
| `signals-scout-csp-violations` | No CSP reporting signal was confirmed. |
| `signals-scout-customer-analytics`, `signals-scout-data-pipelines`, `signals-scout-data-warehouse` | No account analytics, pipeline, or warehouse activity was confirmed. |
| `signals-scout-experiments`, `signals-scout-feature-flags`, `signals-scout-insight-alerts` | No active experiments, flag usage, or insight-alert activity was confirmed. |
| `signals-scout-anomaly-detection`, `signals-scout-observability-gaps` | Project profile was unavailable, so there was no ranked, active analytics surface to justify another broad scout. |
| `signals-scout-inbox-validation` | Fresh inbox setup has no completed Self-driving fixes to validate yet. |
| `signals-scout-mcp-tool-calls`, `signals-scout-skills-store`, `signals-scout-tasks` | No project use of these product surfaces was confirmed. |
| `signals-scout-product-analytics` | No current product-event volume or saved-flow usage was available to rank it above health checks. |
| `signals-scout-replay-vision` | No pre-existing Replay Vision history existed; it can be enabled once the new monitors accumulate observations. |
| `signals-scout-revenue-analytics` | No payment or revenue data source was confirmed. |
| `signals-scout-surveys` | No surveys were found. |
| `signals-scout-web-analytics`, `signals-scout-web-vitals` | No browser analytics or web-vitals usage was confirmed in this repository. |

The enforced budget is **100 scout runs per day**; **0** had been used when checked, leaving **100**. The current banner says: “Scouts are in early access. Each project gets up to 100 scout runs a day. Contact team-self-driving@posthog.com if you need more.”

## Custom scouts

No custom scouts were created. A focused publishing-liveness check was proposed for CMS article creation/editing activity that continues while publishing falls away from its normal pattern; it was declined in favor of the built-in troop.

Mautic campaign, email, form, and integration surfaces were considered from `mautic-system/AGENTS.md`, but were ruled out because no matching event stream or warehouse source was confirmed in this PostHog project. The existing native error route and the Replay Vision route also cover backend exceptions and recording-visible failures without duplicating them in a custom scout.

If a future custom scout becomes noisy, set its config’s `emit` value to `false` in PostHog to retain dry-run observations without sending findings to the inbox.

## Replay Vision scanners

A scanner is an LLM that watches individual session recordings on a schedule and pushes high-confidence defects to the inbox. It is the only component in this setup that spends Replay Vision quota; each finding arrives at half weight and needs corroboration before promotion to a report.

| Brief | Result | What it watches | Query scope | Sampling | Estimate |
| --- | --- | --- | --- | --- | --- |
| Breakage monitor | Created: **CMS article publishing breakage** (`01a0a423-210d-7487-85b6-c5713807419f`) | Visible failures while editors manage and publish articles. | URLs containing `/admin/content-manager`, the CMS content-management flow associated with the article lifecycle instrumented in `strapi-system/src/index.ts`. | 0.5 | 0 matching sessions; 0 observations/month; 0 credits/month. |
| Frustration monitor | Created: **CMS editor frustration** (`01a0a423-2117-7466-bf25-c2eec248040b`) | Visible struggle while saving, publishing, creating, or editing articles. | `$rageclick` only, with no URL scope, to keep it distinct from the breakage monitor. | 1.0 | 0 matching sessions; 0 observations/month; 0 credits/month. |

Both monitors are enabled and signal-emitting. No existing scanners or recordings were found, so they are armed and will begin working when browser session recordings start arriving. The organization has 7,500 Replay Vision credits remaining this period and is not exhausted.

## Files modified or created

| Path | Change |
| --- | --- |
| `posthog-self-driving-report.md` | Created this setup report. |
| `.claude/skills/self-driving-setup/` | Refreshed the installed Self-driving workflow skill. |
| `.claude/skills/replay-vision-scanners-core/` | Installed the scanner mechanics skill. |
| `.claude/skills/replay-vision-scanner-broken-experiences/` | Installed the breakage-monitor brief. |
| `.claude/skills/replay-vision-scanner-user-frustration/` | Installed the frustration-monitor brief. |

## Follow-ups

- [ ] Connect an inbound Support channel (email, inbox, or Slack) in PostHog so enabled ticket findings can arrive.
- [ ] Add a browser PostHog SDK to the CMS/admin frontend if Session Replay is intended to capture editor sessions; Session Replay is otherwise enabled but has no client runtime in this repository.
- [ ] Confirm that editors use the `/admin/content-manager` URL scope; update the breakage scanner if the production CMS uses a custom administration route.
- [ ] After recordings and scanner observations arrive, review the two monitor outputs in Replay Vision and rate results to inform any proposed configuration improvements.
- [ ] Enable a relevant specialist scout later if the project begins using web analytics, product analytics, surveys, feature flags, revenue, or other currently unconfirmed surfaces.

## What happens next

The scout coordinator picks up fresh configurations within about 30 minutes. Scout runs draw from the 100-run daily budget, findings cluster into reports in the [Self-driving inbox](https://us.posthog.com/project/610214/inbox), and immediately actionable reports can start coding tasks.
