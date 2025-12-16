import boto3
import pandas as pd

# Configuration
TABLE_NAME = 'dam-migration-tracker-prod'
REGION = 'us-east-1'
OUTPUT_FILE = 'dynamodb_export.csv'

def export_dynamodb_to_csv():
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(TABLE_NAME)
    
    items = []
    
    # Initial scan
    response = table.scan()
    items.extend(response['Items'])
    
    # Pagination (keep scanning until no more keys)
    while 'LastEvaluatedKey' in response:
        print(f"Scanned {len(items)} records so far...")
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(response['Items'])
        
    print(f"Total records scanned: {len(items)}")
    
    # Convert to DataFrame and save to CSV
    # Pandas automatically handles varying schema (missing columns become empty)
    df = pd.DataFrame(items)
    df.to_csv(OUTPUT_FILE, index=False)
    print(f"Exported to {OUTPUT_FILE}")

if __name__ == '__main__':
    export_dynamodb_to_csv()