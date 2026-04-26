# Canary

Churn-risk alerts for Customer Success teams, from product-usage data trapped in your internal database.

```
canary init        # scaffold config + owner CSV
canary check       # validate config, probe data source (read-only)
canary scan        # run rules, dispatch alerts, store snapshots
canary alerts      # list recent alerts
canary feedback <id> <acted|ignored|false_positive>
canary report      # pilot accuracy report
canary smoketest   # end-to-end with bundled mock data
```

See `WHITEPAPER.md` for what it is, how it works, and who it's for.
See `canary.example.yaml` for the rule format.
