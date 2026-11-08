# Know where usage data comes from

The quota item beside tracking shows the active provider. Click it to open **Settings**.

The dashboard starts with daily usage and supports weekly/monthly breakdowns by account, provider and model.

**API**, **Local** and **Estimate** labels distinguish native account/quota data, locally recorded token usage and API-equivalent cost estimates. Local totals do not include unseen activity on other machines. Unknown historical accounts stay separate from the current login.

Codex tokens are attributed to the account recorded for each response or turn. Switching accounts within a conversation keeps each account's usage separate. The conversation creator does not identify who paid for later turns. Codex writes the quota reset times it was served beside each response; a response whose reset times match exactly one account's saved quota readings is **Matched from quota changes**. Otherwise, Codex and Claude responses without account evidence are matched when exactly one account's quota rose around them. Claude responses use the session owner that recent Claude Code versions record in the transcript (**Inferred from session evidence**), ahead of quota-rise matches. Codex weeks AgentTandem never read quota for are **Inferred from session evidence** when every thread started in that week was created by the same known account. Other turns appear under **Unknown account**; you can assign a conversation or date range manually in the dashboard, which replaces a match. Refreshing usage also corrects cached history previously attributed to the creator.

Return to this guide anytime with **AgentTandem: Getting Started** or the chat's **… → Getting started** menu.

Historical account switches can be corrected for selected response IDs when the switch point is confirmed. These corrections appear as **User confirmed** with the number of selected responses and can be removed in the dashboard. They take priority over broad conversation/date assignments and do not capture future responses. Native account evidence always takes priority.
