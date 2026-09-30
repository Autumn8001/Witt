# Upstream sync

Original Witt remains the upstream. This private repository is the product
source. Do not push product branches, secrets, Actions credentials, or
deployment config back to the original repository.

## Repositories

| Role | Remote | URL |
| --- | --- | --- |
| Upstream | `upstream` | https://github.com/LeoWilson-Ben/witt.git |
| Product source | `origin` | https://github.com/Autumn8001/Witt (PRIVATE) |

## Baseline

- Baseline upstream SHA: `69b91aad1c5621199d5dc0ec486a5299c906ad37`
- Baseline date: `2026-09-30T08:42:55Z`
- Baseline subject: `feat: add standalone browser workspace`
- Private `main` at bootstrap equals that SHA.
- Product development lives on `platform/personal-ai-ops` and feature branches under it.

## Branch roles

- `main` stays close to upstream Witt. Do not develop product features directly on it.
- `platform/personal-ai-ops` is the long-lived product branch.
- Feature work uses branches such as `feat/harness-runtime`, then merges into `platform/personal-ai-ops`.

## Standard sync

```sh
git fetch upstream
git checkout -b sync/upstream-YYYYMMDD main
git merge upstream/main
# resolve conflicts, run the regression suite
git checkout main
git merge --ff-only sync/upstream-YYYYMMDD
git push origin main
git checkout platform/personal-ai-ops
git merge main
# resolve product conflicts, run the regression suite again
git push origin platform/personal-ai-ops
```

Do not pull `upstream/main` directly into `platform/personal-ai-ops`.
Do not force-overwrite the product branch with upstream history.

## License

Witt is MIT licensed. Keep `LICENSE` and `THIRD_PARTY_NOTICES.md`.
Product documentation may be added, but the original Witt source must not
be described as original work of this private repository.
