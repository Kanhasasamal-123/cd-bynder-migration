/**
 * Date utility functions
 * Handles date range calculations for incremental syncing
 *
 * @module utils/dateUtils
 */

/**
 * Date range interface for API filters
 */
export interface DateRange {
  start: string;
  end: string;
}

/**
 * Calculate date range for asset sync based on interval
 * Returns start and end dates for filtering API results
 *
 * @param intervalMinutes - Number of minutes to look back from now
 * @returns Date range with start and end in YYYY-MM-DD format
 */
export function calculateDateRange(intervalMinutes: number = 60): DateRange {
  const now = new Date();
  const startTime = new Date(now.getTime() - intervalMinutes * 60 * 1000);

  return {
    start: formatDateForApi(startTime),
    end: formatDateForApi(now)
  };
}

/**
 * Format a Date object to YYYY-MM-DD format for API
 *
 * @param date - Date to format
 * @returns Formatted date string
 */
export function formatDateForApi(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse date range string from API filter format
 * Example: "2025-11-01, 2025-11-24" -> { start: "2025-11-01", end: "2025-11-24" }
 *
 * @param rangeString - Date range string with format "start, end"
 * @returns Parsed date range
 */
export function parseDateRangeString(rangeString: string): DateRange {
  const [start, end] = rangeString.split(',').map(s => s.trim());
  return { start, end };
}
