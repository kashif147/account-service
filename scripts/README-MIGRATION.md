# Money Standardization Migration Script

## Overview

This script migrates existing `GLTransaction` and `MaterializedBalance` data from euros (decimals) to cents (integers).

## Prerequisites

1. **Backup your database** - This is a destructive operation
2. Ensure you have the correct MongoDB connection string
3. Run on staging first to verify

## Usage

### Option 1: Using environment variable

```bash
cd account-service
MONGODB_URI="mongodb://your-connection-string" node scripts/migrate-money-to-cents.js
```

### Option 2: Using .env file

```bash
cd account-service
# Ensure .env or .env.staging has MONGODB_URI set
node scripts/migrate-money-to-cents.js
```

### Option 3: For staging environment

```bash
cd account-service
# Load staging environment variables
source .env.staging  # or use your preferred method
node scripts/migrate-money-to-cents.js
```

## What the Script Does

### GLTransaction Migration

1. Iterates through all GLTransaction documents
2. For each entry in `entries` array:
   - If amount has decimal places AND < 10000: Converts to cents (multiply by 100)
   - If amount is integer AND >= 100: Assumes already in cents (skips)
   - If amount is small integer (0 < amount < 100): Converts to cents (multiply by 100)
3. Updates documents in batches
4. Logs progress every 100 updates

### MaterializedBalance Migration

1. Iterates through all MaterializedBalance documents
2. For each balance:
   - If amount has decimal places AND < 10000: Converts to cents (multiply by 100)
   - If amount is small integer (0 < amount < 100): Converts to cents (multiply by 100)
   - Otherwise: Assumes already in cents (skips)
3. Updates documents
4. Logs progress every 100 updates

## Migration Strategy

The script uses heuristics to identify euros vs cents:

- **Euros**: Has decimal places (e.g., 326.00, 81.50) OR small integers (< 100)
- **Cents**: Large integers (>= 100) with no decimal places

### Edge Cases

- **Zero amounts**: Left as-is (0 cents = 0 euros)
- **Very small amounts**: < 100 integers are converted (could be 0.50 euros = 50 cents)
- **Large amounts**: >= 10000 are assumed to be cents (e.g., 32600 cents = €326.00)

## Verification

After migration, the script performs sample checks:

1. Samples a GLTransaction entry and logs:
   - Sample amount
   - Whether it's an integer
   - Whether it looks like cents (>= 100 or 0)

2. Samples a MaterializedBalance entry and logs:
   - Sample amount
   - Whether it's an integer
   - Whether it looks like cents (>= 100 or 0)

## Output

The script logs:
- Progress every 100 updates
- Final summary with counts:
  - `updated`: Number of documents converted
  - `skipped`: Number of documents already in cents
  - `errors`: Number of errors encountered

## Rollback

If you need to rollback:

1. **Restore from backup** (recommended)
2. Or run reverse migration:
   - Divide all amounts by 100
   - Convert integers back to decimals

**Note**: Rollback script not provided - use database backup instead.

## Testing

Before running on production:

1. **Test on staging**:
   ```bash
   MONGODB_URI="staging-connection-string" node scripts/migrate-money-to-cents.js
   ```

2. **Verify results**:
   - Check sample transactions in database
   - Verify amounts are integers
   - Verify calculations are correct
   - Test API endpoints

3. **Check logs**:
   - Review migration logs for errors
   - Verify update/skip counts make sense

## Safety Checks

The script includes:
- Error handling per document (continues on error)
- Progress logging
- Sample verification
- Non-destructive check before update (only updates if needed)

## Post-Migration

After migration:

1. ✅ Verify all amounts are integers
2. ✅ Test invoice creation
3. ✅ Test receipt creation
4. ✅ Test payment processing
5. ✅ Verify reports show correct amounts in euros
6. ✅ Check member balances

## Troubleshooting

### Error: "MONGODB_URI or MONGO_URI environment variable required"
- Set the connection string in environment variable or .env file

### High error count
- Check logs for specific error messages
- Verify database connection
- Check for data integrity issues

### Unexpected conversions
- Review the heuristics in the script
- Check sample entries manually
- Consider adjusting thresholds if needed

## Support

If you encounter issues:
1. Check the logs for detailed error messages
2. Verify database backup is available
3. Test on staging first
4. Review the migration strategy in `MONEY_STANDARDIZATION_MIGRATION.md`
