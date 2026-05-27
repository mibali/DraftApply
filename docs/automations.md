# Repository Automations

DraftApply uses private Codex automations for repository maintenance. The full
automation prompts, schedules, runtime paths, and scheduler configuration are
intentionally not tracked in this public repository.

The active automation policy is:

- Automation work must happen on branches created from `main`.
- Automation changes must be proposed through draft pull requests targeting
  `main`.
- Automation-created pull requests must not be merged by the automation.
- Human review is required before merge.
- Automation branches should be deleted after their pull requests are merged.
- Relevant tests should be run and reported in the pull request when code or
  data changes are made.
- Secrets, local machine paths, private tokens, CV data, and raw large datasets
  must not be committed.

Current private maintenance areas include:

- Recent-change bug scanning.
- Role-profile intelligence updates using official occupation sources.
- Salary benchmark refresh checks using official downloadable public datasets.

For data-oriented automation work, DraftApply prefers official, standardized
sources such as O*NET, ESCO, BLS, and ONS. Scraped datasets, paid/private APIs,
and unofficial salary aggregators should not be used for repository benchmark
data.

