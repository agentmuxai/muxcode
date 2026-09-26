# REPORT: repo setup parity — reviews, CI, branch protection and notifications

**Date:** 2026-09-26
**Status:** living — update as the admin items are done
**Author:** Agent3
**Trigger:** Repo owner: *"verify review system/CI is setup like on agentmux .. there may need to be a webhook using
the github router so it also gets to discord. verify that all, report it to file"*, and *"also match the branch
protection and review requirements. see a5af/reagent, a5af/dev-tools, and a5af/shared-infrastructure for
reference"*.
**Compared against:** agentmuxai/agentmux, a5af/reagent, a5af/dev-tools, a5af/shared-infrastructure.

## 0. Summary

- **Notifications already work.** The agentmuxai org webhook delivers muxcode events to github-router, which posts
  them to the AgentMuxAI Discord `#github-firehose` and to muxbus (agents get ReAgent review notifications). No
  webhook needs adding; a repo-level one would double-deliver.
- **ReAgent reviews muxcode**, but three of its checks fail on every PR because the default branch isn't `main`.
- **muxcode has no branch protection**, no required checks and no review requirement; agentmux requires the
  `check` and `CI required` checks and one approval, and dismisses stale approvals.
- The in-repo gaps are fixed by the PR that adds this report (§3). The rest needs a repo admin (§4): the agent App
  that did this work has no administration permission, so it can neither read nor change branch protection,
  webhooks, secrets or repo settings.

## 1. How this was checked

Read-only. `gh-agent` (the agent's GitHub App) returned *Resource not accessible by integration* for branch
protection, webhooks, Actions permissions and secrets on every repo, and for org rulesets and hooks. What was
readable: `GET repos/<r>` (settings), `GET repos/<r>/branches/<b>` (protected, required checks, enforcement),
rulesets, workflow files, PR histories, and AWS CloudWatch logs for github-router and the muxbus consumer. Review
requirements are **inferred** from PR behaviour and marked as such.

## 2. Comparison

| | muxcode (before) | agentmux | reagent | dev-tools | shared-infrastructure |
|---|---|---|---|---|---|
| Default branch | `agent3/initial-implementation` | `main` | `main` | `main` | `main` |
| Default branch protected | **no** (`main` isn't either) | yes | yes | yes | yes |
| Required checks | none | **`check`, `CI required`** (GitHub Actions, app 15368; admins exempt) | none | none | none |
| One approval required (inferred) | no — #1 merged with changes requested | **yes**, high confidence (#3854 shows REVIEW_REQUIRED with only a comment; 20/20 sampled merges approved) | yes, high (#251, #262) | no (#388, #386 merged with changes requested) | no (#507, #506 merged on comment reviews) |
| Stale approvals dismissed on push (inferred) | — | **yes** (#3849, #3833) | yes (#257, #240) | not seen | not seen |
| Rulesets | none | none | none | none | "Copilot Auto-Review", disabled |
| Who approves | ReAgent | ReAgent | ReAgent | ReAgent | ReAgent |
| CI | `build` | `ci-pr.yml` with an aggregate **`CI required`**, doc gates, release checks | Test | CI | per-component tests |
| No-Co-Authored-By check | **missing** | yes (inline copy; job `check` is required) | reusable workflow | reusable workflow | hosts the reusable workflow |
| `.githooks/commit-msg` + `prepare` | **missing** | yes | yes | yes | yes |
| Squash commit title / message | **commit-or-PR title / commit messages** | PR title / blank | PR title / blank | PR title / blank | PR title / blank |
| Auto-merge | off | **on** | off | off | off |
| LICENSE / SECURITY.md | **no / no** (package.json said MIT) | Apache-2.0 / yes | — | — | — |
| CLAUDE.md | no | no (removed on purpose for a public repo, agentmux#3403) | yes | yes | yes |
| Codex review | manual `@codex review` | ReAgent triggers it; `codex-review-gate.yml` status (not required) | manual | manual | manual |

## 3. Fixed by the PR that adds this report

- `.github/workflows/no-coauthor-trailers.yml` — an exact copy of agentmux's (job `check`). It has to be a copy: a
  public agentmuxai repo can't call the reusable workflow in private `a5af/shared-infrastructure`.
- `.github/workflows/ci.yml` — an aggregate **`CI required`** job (`needs: build`, `if: always()`), the single
  check branch protection requires, as on agentmux. `npm test` already runs (added in #35).
- `.githooks/commit-msg` (strips Co-Authored-By trailers; identical across the reference repos) and the same
  `prepare` script as a5af/reagent, which points `core.hooksPath` at it in a clone and does nothing when the
  package is installed from npm.
- `LICENSE` (MIT, as `package.json` already declared), `SECURITY.md` (security@agentmux.ai, scoped to Mux Code),
  `.github/dependabot.yml` (npm and GitHub Actions, weekly).

## 4. Needs a repo admin

Do these in order; 3 depends on 1 and on the PR in §3 having run once.

1. **Make `main` the default branch.** `main` (b8fbf26) is 37 commits behind `agent3/initial-implementation` and
   one squash commit ahead (its tree equals 0d2c554, which is in the default branch's history). Simplest: Settings →
   Branches → rename `main` to `main-old`, then rename `agent3/initial-implementation` to `main` (GitHub retargets
   open PRs), then delete `main-old`.
   *Why it matters now:* ReAgent clones with `--depth 50` (default branch only) and its version, release-consistency
   and merge-regression checks diff against `origin/main`; on muxcode#3 its log shows
   `fatal: bad revision 'origin/main'`, so those checks silently skip on every PR.
2. **Squash settings:** Settings → General → Pull Requests → "Default commit message" for squash merges: **Pull
   request title**, message **blank** (API: `squash_merge_commit_title=PR_TITLE`,
   `squash_merge_commit_message=BLANK`). This was step 0 of shared-infrastructure's
   `SPEC_COAUTHOR_TRAILER_SERVER_SIDE_CHECK_2026_09_20.md`, and muxcode was missed: its merges #2, #3, #34 and #35
   carry `Co-authored-by:` trailers, and #34's commit lost its `Agent3@narko:` title prefix.
3. **Branch protection on `main`, matching agentmux** (`PUT repos/agentmuxai/muxcode/branches/main/protection`):
   ```json
   {
     "required_status_checks": {
       "strict": false,
       "checks": [
         { "context": "CI required", "app_id": 15368 },
         { "context": "check", "app_id": 15368 }
       ]
     },
     "enforce_admins": false,
     "required_pull_request_reviews": {
       "required_approving_review_count": 1,
       "dismiss_stale_reviews": true,
       "require_code_owner_reviews": false,
       "require_last_push_approval": false
     },
     "restrictions": null
   }
   ```
   Approval count and stale-review dismissal are inferred from agentmux's PRs (high confidence); whether agentmux
   uses `strict` couldn't be read.
4. **Enable auto-merge** (`allow_auto_merge: true`, as agentmux). Optional: turn off the wiki, as agentmux.
5. **`NPM_TOKEN` secret** for `publish.yml` (secrets aren't readable to the App, so this is unverified), and the
   `agentmuxai` npm org — see #32.
6. Optional: Dependabot alerts and security updates (Settings → Code security).

## 5. Elsewhere

- **ReAgent config** — add an `agentmuxai/muxcode` entry to `a5af/reagent` `config/repos.json` mirroring agentmux's
  `codex: {enabled: true}` and `comment_reply` blocks (merge-regression analysis once `main` exists). muxcode runs on
  ReAgent's defaults today.
- **Notifications (no change needed):** agentmuxai has one org webhook to `https://github-router.asaf.cc/webhook`
  (shared-infrastructure `SPEC_DISCORD_GITHUB_FIREHOSE_2026_09_23.md` §3). The router publishes every event to SNS
  (ReAgent and the muxbus github-consumer subscribe) and posts public agentmuxai repos to
  `discord-webhook-firehose-agentmuxai`. Confirmed in `/aws/lambda/infrastructure-github-router-function`: muxcode
  `pull_request`, `pull_request_review` and `issues` events posted to that sink; the review on muxcode#3 reached
  `/aws/lambda/muxbus-github-consumer` at 06:23:30Z. The muxbus consumer's dedup notes (`handler.ts`) say
  repo-level hooks on muxcode, cef and agentmux-mobile caused double notifications and were removed — **don't add
  one back.**
- **Org-wide gap (not muxcode-specific):** the org hook delivers no `push`, `workflow_run` or `release` events for
  any agentmuxai repo (none in three days of router logs), so Discord's CI-failed, push and release messages never
  fire for agentmuxai.
- **Release policy:** muxcode has no changesets, so ReAgent asks for a `package.json` bump on every code PR (as on
  #35). That's being followed; adopting `.changesets/` like agentmux would move bumps into release PRs.

## 6. Side findings in the reference repos

- agentmux's `codex-review-gate.yml` says `Codex review` should be a required check; it isn't.
- The `check / check` co-author workflow isn't a required check on reagent, dev-tools or shared-infrastructure, and
  shared-infrastructure doesn't run it on its own PRs.
