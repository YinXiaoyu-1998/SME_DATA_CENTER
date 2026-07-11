# Operations SOP

The [Operations Portal](https://example.invalid/ops) stores the current checklist.

## Opening Checklist

- Check fridge temperatures
- Confirm cash drawer
  - Record variance notes

| Metric          | Owner      |
| --------------- | ---------- |
| Temperature log | Shift lead |
| Cash count      | Cashier    |

```bash
npm run worker:once
```

## Closing Checklist

Archive the daily notes after reconciliation.
