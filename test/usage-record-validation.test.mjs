import test from 'node:test'
import assert from 'node:assert/strict'
import { safeUsageRecord } from '../src/usage-store.mjs'

const record = {
 timestamp: '2026-10-30T12:00:00.000Z',
 requestId: '12345678-1234-1234-1234-123456789abc',
 alias: 'account-1', endpoint: '/v1/responses', outcome: 'complete',
 usageStatus: 'unknown', provenance: 'none', attempt: 1, index: 1,
}

test('usage records require canonical valid UTC timestamps for range queries', () => {
 assert.equal(safeUsageRecord(record).timestamp, record.timestamp)
 for (const timestamp of [
  '2026-10-30Tprivate', '2026-02-30T12:00:00.000Z',
  '2026-10-30T12:00:00Z', '2026-10-30T14:00:00.000+02:00',
  '2026-10-30T24:00:00.000Z', null, 1793361600000,
 ]) assert.throws(() => safeUsageRecord({ ...record, timestamp }), /INVALID_RECORD/)
})
