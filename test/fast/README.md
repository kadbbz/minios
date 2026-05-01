# Fast Smoke Tests

Run:

```bash
python3 test/fast/run_smoke.py
```

Output:

- `.tmp/test-{ts}/summary.json`
- `.tmp/test-{ts}/report.txt`

These tests are intentionally lightweight and only validate the current repository baseline. They are meant to be expanded as MiniOS runtime code lands.
