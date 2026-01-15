## Custom Endpoints

Base URL: `{{baseUrl}}` (example: `http://localhost:3000/api`)
Auth: `Authorization: Bearer {{token}}`

### Stripe Payments
GET `{{baseUrl}}/journal/stripe-payments`

Query params:
- `status`: `PENDING` | `SETTLED` | `ALL` (default `PENDING`)
- `from`, `to`: ISO dates (optional)
- `skip`, `limit`: pagination (optional)

Examples:

```bash
curl -H "Authorization: Bearer {{token}}" \
  "{{baseUrl}}/journal/stripe-payments?status=ALL"
```

```bash
curl -H "Authorization: Bearer {{token}}" \
  "{{baseUrl}}/journal/stripe-payments?status=PENDING"
```

```bash
curl -H "Authorization: Bearer {{token}}" \
  "{{baseUrl}}/journal/stripe-payments?status=SETTLED&from=2026-01-01&to=2026-12-31"
```

Response (example):
```json
{
  "status": "success",
  "message": "Success",
  "data": {
    "total": 2,
    "skip": 0,
    "limit": 50,
    "items": [
      {
        "docType": "Receipt",
        "docNo": "RCPT-001",
        "settlement": { "provider": "Stripe", "status": "PENDING" }
      }
    ]
  },
  "timestamp": "2026-01-15T10:00:00.000Z"
}
```

### Member Net Balance
GET `{{baseUrl}}/reports/member/:memberId/net-balance`

Query params:
- `year`: YYYY (optional, default current year)

Example:
```bash
curl -H "Authorization: Bearer {{token}}" \
  "{{baseUrl}}/reports/member/MEMBER123/net-balance?year=2026"
```

Response (example):
```json
{
  "status": "success",
  "message": "Success",
  "data": {
    "memberId": "MEMBER123",
    "year": 2026,
    "net": 120.5,
    "accounts": [{ "accountCode": "1400", "amount": 150 }, { "accountCode": "2020", "amount": -29.5 }],
    "buckets": [{ "accountCode": "1400", "bucket": "current", "amount": 150 }]
  },
  "timestamp": "2026-01-15T10:00:00.000Z"
}
```

### Member Ledger
GET `{{baseUrl}}/reports/member/:memberId/ledger`

Query params:
- `accountCode`: filter by account code (optional)

Examples:
```bash
curl -H "Authorization: Bearer {{token}}" \
  "{{baseUrl}}/reports/member/MEMBER123/ledger"
```

```bash
curl -H "Authorization: Bearer {{token}}" \
  "{{baseUrl}}/reports/member/MEMBER123/ledger?accountCode=1400"
```

Response (example):
```json
{
  "status": "success",
  "message": "Success",
  "data": {
    "memberId": "MEMBER123",
    "items": [
      {
        "docType": "Invoice",
        "docNo": "INV-001",
        "date": "2026-01-01T00:00:00.000Z",
        "entries": [
          { "accountCode": "1400", "dc": "D", "amount": 200, "memberId": "MEMBER123" }
        ]
      }
    ]
  },
  "timestamp": "2026-01-15T10:00:00.000Z"
}
```
