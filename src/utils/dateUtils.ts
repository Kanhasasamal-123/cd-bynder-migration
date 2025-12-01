/**
 * Date utility functions stub
 * This file will be mocked in tests
 * The actual implementation should be in ./lib/utils/dateUtils.ts
 */

export interface DateRange {
  start: string;
  end: string;
}

export function calculateDateRange(intervalMinutes: number = 60): DateRange {
  throw new Error('calculateDateRange not implemented - should be mocked in tests');
}
