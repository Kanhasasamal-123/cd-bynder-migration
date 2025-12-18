#!/usr/bin/env python3
"""
Bynder Asset Deletion Script

Reads asset IDs from a CSV file and deletes them from Bynder.
Includes rate limiting, retry logic, and detailed logging.

Environment variables required:
  BYNDER_CLIENT_ID        - OAuth client ID
  BYNDER_CLIENT_SECRET    - OAuth client secret
  BYNDER_ACCESS_TOKEN_URL - OAuth token endpoint (e.g., https://yourdomain.bynder.com/v6/authentication/oauth2/token)
  BYNDER_API_BASE_URL     - API base URL (e.g., https://yourdomain.bynder.com)

Usage:
  python delete-bynder-assets.py <csv_file> [--column COLUMN_NAME] [--dry-run] [--delay SECONDS]

Examples:
  python delete-bynder-assets.py assets_to_delete.csv
  python delete-bynder-assets.py assets.csv --column bynder_id --dry-run
  python delete-bynder-assets.py assets.csv --delay 0.5
"""

import argparse
import csv
import os
import sys
import time
from datetime import datetime
from typing import Optional

import requests


class BynderClient:
    """Simple Bynder API client for asset deletion."""

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        access_token_url: str,
        api_base_url: str,
    ):
        self.client_id = client_id
        self.client_secret = client_secret
        self.access_token_url = access_token_url
        self.api_base_url = api_base_url.rstrip("/")
        self.access_token: Optional[str] = None
        self.token_expires_at: float = 0

    def get_access_token(self) -> str:
        """Get OAuth access token, refreshing if expired."""
        if self.access_token and time.time() < self.token_expires_at - 60:
            return self.access_token

        response = requests.post(
            self.access_token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()

        token_data = response.json()
        self.access_token = token_data["access_token"]
        self.token_expires_at = time.time() + token_data.get("expires_in", 3600)

        return self.access_token

    def delete_asset(self, asset_id: str) -> tuple[bool, str]:
        """
        Delete an asset from Bynder.

        Returns:
            tuple: (success: bool, message: str)
        """
        token = self.get_access_token()
        headers = {"Authorization": f"Bearer {token}"}

        url = f"{self.api_base_url}/api/v4/media/{asset_id}/"

        try:
            response = requests.delete(url, headers=headers)

            if response.status_code == 204 or response.status_code == 200:
                return True, "Deleted successfully"
            elif response.status_code == 404:
                return False, "Asset not found (already deleted?)"
            elif response.status_code == 403:
                return False, "Access denied (check permissions)"
            elif response.status_code == 429:
                return False, "Rate limited (retry later)"
            else:
                return False, f"HTTP {response.status_code}: {response.text[:200]}"

        except requests.exceptions.RequestException as e:
            return False, f"Request error: {str(e)}"


def load_asset_ids_from_csv(filepath: str, column_name: str) -> list[str]:
    """Load asset IDs from a CSV file."""
    asset_ids = []

    with open(filepath, "r", newline="", encoding="utf-8-sig") as f:
        # Try to detect if file has headers
        sample = f.read(4096)
        f.seek(0)
        
        sniffer = csv.Sniffer()
        has_header = sniffer.has_header(sample)
        
        if has_header:
            reader = csv.DictReader(f)
            
            # Check if specified column exists
            if column_name not in reader.fieldnames:
                # Try case-insensitive match
                column_map = {name.lower(): name for name in reader.fieldnames}
                if column_name.lower() in column_map:
                    column_name = column_map[column_name.lower()]
                else:
                    available = ", ".join(reader.fieldnames)
                    raise ValueError(
                        f"Column '{column_name}' not found. Available columns: {available}"
                    )
            
            for row in reader:
                asset_id = row[column_name].strip()
                if asset_id:
                    asset_ids.append(asset_id)
        else:
            # No header - assume first column contains asset IDs
            reader = csv.reader(f)
            for row in reader:
                if row:
                    asset_id = row[0].strip()
                    if asset_id:
                        asset_ids.append(asset_id)

    return asset_ids


def main():
    parser = argparse.ArgumentParser(
        description="Delete assets from Bynder using asset IDs from a CSV file",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("csv_file", help="Path to CSV file containing asset IDs")
    parser.add_argument(
        "--column",
        "-c",
        default="AssetId",
        help="Column name containing asset IDs (default: AssetId)",
    )
    parser.add_argument(
        "--dry-run",
        "-n",
        action="store_true",
        help="Show what would be deleted without actually deleting",
    )
    parser.add_argument(
        "--delay",
        "-d",
        type=float,
        default=0.2,
        help="Delay between deletions in seconds (default: 0.2)",
    )
    parser.add_argument(
        "--retry",
        "-r",
        type=int,
        default=3,
        help="Number of retries for failed deletions (default: 3)",
    )
    parser.add_argument(
        "--log-file",
        "-l",
        help="Path to log file for results (default: deletion_log_TIMESTAMP.csv)",
    )

    args = parser.parse_args()

    # Load environment variables
    client_id = os.environ.get("BYNDER_CLIENT_ID")
    client_secret = os.environ.get("BYNDER_CLIENT_SECRET")
    access_token_url = os.environ.get("BYNDER_ACCESS_TOKEN_URL")
    api_base_url = os.environ.get("BYNDER_API_BASE_URL")

    if not all([client_id, client_secret, access_token_url, api_base_url]):
        print("Error: Missing required environment variables.", file=sys.stderr)
        print("Please set the following:", file=sys.stderr)
        print("  BYNDER_CLIENT_ID", file=sys.stderr)
        print("  BYNDER_CLIENT_SECRET", file=sys.stderr)
        print("  BYNDER_ACCESS_TOKEN_URL", file=sys.stderr)
        print("  BYNDER_API_BASE_URL", file=sys.stderr)
        sys.exit(1)

    # Check CSV file exists
    if not os.path.exists(args.csv_file):
        print(f"Error: File not found: {args.csv_file}", file=sys.stderr)
        sys.exit(1)

    # Load asset IDs
    print(f"Loading asset IDs from: {args.csv_file}")
    try:
        asset_ids = load_asset_ids_from_csv(args.csv_file, args.column)
    except Exception as e:
        print(f"Error reading CSV file: {e}", file=sys.stderr)
        sys.exit(1)

    if not asset_ids:
        print("No asset IDs found in file.")
        sys.exit(0)

    print(f"Found {len(asset_ids)} asset(s) to delete")

    if args.dry_run:
        print("\n=== DRY RUN MODE - No assets will be deleted ===\n")
        for i, asset_id in enumerate(asset_ids, 1):
            print(f"  [{i:4}/{len(asset_ids)}] Would delete: {asset_id}")
        print(f"\nDry run complete. {len(asset_ids)} asset(s) would be deleted.")
        sys.exit(0)

    # Confirm before proceeding
    print(f"\n⚠️  WARNING: This will permanently delete {len(asset_ids)} asset(s) from Bynder!")
    confirm = input("Type 'DELETE' to confirm: ")
    if confirm != "DELETE":
        print("Aborted.")
        sys.exit(0)

    # Initialize client
    client = BynderClient(client_id, client_secret, access_token_url, api_base_url)

    # Setup logging
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = args.log_file or f"deletion_log_{timestamp}.csv"

    # Process deletions
    success_count = 0
    failed_count = 0
    results = []

    print(f"\nStarting deletion (logging to: {log_file})...")
    print("-" * 60)

    start_time = time.time()

    for i, asset_id in enumerate(asset_ids, 1):
        success = False
        message = ""

        # Retry logic
        for attempt in range(args.retry):
            success, message = client.delete_asset(asset_id)

            if success:
                break
            elif "Rate limited" in message:
                # Back off on rate limiting
                wait_time = (attempt + 1) * 5
                print(f"  Rate limited, waiting {wait_time}s...")
                time.sleep(wait_time)
            elif "not found" in message.lower():
                # Don't retry if asset doesn't exist
                break
            else:
                time.sleep(1)  # Brief pause before retry

        # Log result
        status = "SUCCESS" if success else "FAILED"
        results.append({"asset_id": asset_id, "status": status, "message": message})

        if success:
            success_count += 1
            print(f"  [{i:4}/{len(asset_ids)}] ✓ {asset_id}")
        else:
            failed_count += 1
            print(f"  [{i:4}/{len(asset_ids)}] ✗ {asset_id} - {message}")

        # Rate limiting delay
        if i < len(asset_ids):
            time.sleep(args.delay)

    elapsed = time.time() - start_time

    # Write log file
    with open(log_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["asset_id", "status", "message"])
        writer.writeheader()
        writer.writerows(results)

    # Summary
    print("-" * 60)
    print(f"\nDeletion complete!")
    print(f"  Total:    {len(asset_ids)}")
    print(f"  Success:  {success_count}")
    print(f"  Failed:   {failed_count}")
    print(f"  Duration: {elapsed:.1f}s")
    print(f"\nResults logged to: {log_file}")

    if failed_count > 0:
        print(f"\n⚠️  {failed_count} deletion(s) failed. Check the log file for details.")
        sys.exit(1)


if __name__ == "__main__":
    main()

